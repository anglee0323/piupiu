#!/usr/bin/env node
// PiupiuPass（Agent ID 持有者的免费通行证）：部署 / BscScan 验证 / 退回剩余 BNB。只在换合约时手动跑，用一次性钱包。
//
//   node scripts/deploy-pass.mjs --new-wallet                生成一次性部署钱包（私钥写入 ~/.piupiu-release/deploy-key.json，不进仓库），打印地址
//   node scripts/deploy-pass.mjs                             预演：编译、估算、确认余额
//   node scripts/deploy-pass.mjs --send                      部署，并做链上自检，结果写入 ~/.piupiu-release/deployed-pass.json
//   node scripts/deploy-pass.mjs --verify <地址>              到 BscScan 提交源码验证（要 ~/.agents/secrets/bscscan.api_key）
//   SWEEP_TO=<地址> node scripts/deploy-pass.mjs --sweep --send   把部署钱包剩余 BNB 退回
//
// 合约没有构造参数、没有 owner，部署者不获得任何权限。
import { ethers } from 'ethers';
import solc from 'solc';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEY_FILE = join(homedir(), '.piupiu-release', 'deploy-key.json');
const OUT_FILE = join(homedir(), '.piupiu-release', 'deployed-pass.json');
const API_KEY_FILE = join(homedir(), '.agents', 'secrets', 'bscscan.api_key');
const RPC = process.env.BSC_RPC || 'https://bsc-dataseed.bnbchain.org';
const AGENT_ID = '0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F';
const SRC_NAME = 'contracts/PiupiuPass.sol';
const COMPILER = 'v0.8.24+commit.e11b9ed9';
const args = process.argv.slice(2);
const SEND = args.includes('--send'), SWEEP = args.includes('--sweep'), VERIFY = args.includes('--verify'), NEWW = args.includes('--new-wallet');
const provider = new ethers.JsonRpcProvider(RPC, 56, { staticNetwork: true });
const SRC = readFileSync(join(ROOT, SRC_NAME), 'utf8');
const SETTINGS = { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris' };

function compile() {
  const input = { language: 'Solidity', sources: { [SRC_NAME]: { content: SRC } }, settings: { ...SETTINGS, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  const c = out.contracts[SRC_NAME].PiupiuPass;
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}
const loadWallet = () => {
  if (!existsSync(KEY_FILE)) throw new Error(`没有部署私钥：${KEY_FILE}`);
  return new ethers.Wallet(JSON.parse(readFileSync(KEY_FILE, 'utf8')).privateKey, provider);
};

async function verify(address) {
  const key = readFileSync(API_KEY_FILE, 'utf8').trim();
  const stdInput = { language: 'Solidity', sources: { [SRC_NAME]: { content: SRC } }, settings: SETTINGS };
  const body = new URLSearchParams({
    module: 'contract', action: 'verifysourcecode', apikey: key, contractaddress: address,
    sourceCode: JSON.stringify(stdInput), codeformat: 'solidity-standard-json-input',
    contractname: `${SRC_NAME}:PiupiuPass`, compilerversion: COMPILER,
    optimizationUsed: '1', runs: '200', constructorArguements: '', evmversion: 'paris', licenseType: '3',
  });
  const j = await (await fetch('https://api.etherscan.io/v2/api?chainid=56', { method: 'POST', body })).json();
  console.log('提交:', j.message, j.status === '1' ? '' : j.result);
  if (j.status !== '1') throw new Error('提交失败');
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    const s = await (await fetch(`https://api.etherscan.io/v2/api?chainid=56&module=contract&action=checkverifystatus&guid=${j.result}&apikey=${key}`)).json();
    console.log(`[${i}]`, s.result);
    if (!/Pending/i.test(String(s.result))) return /Pass/i.test(String(s.result));
  }
  return false;
}

const main = async () => {
  if (NEWW) {
    if (existsSync(KEY_FILE)) throw new Error(`已经有部署钱包：${KEY_FILE}（不覆盖）`);
    const w = ethers.Wallet.createRandom();
    writeFileSync(KEY_FILE, JSON.stringify({ address: w.address, privateKey: w.privateKey, createdAt: new Date().toISOString(), note: '一次性部署钱包，部署完退回余额后删除' }), { mode: 0o600 });
    console.log('已生成一次性部署钱包:', w.address, '（私钥在', KEY_FILE, '）'); return;
  }
  if (VERIFY) {
    const addr = args[args.indexOf('--verify') + 1];
    if (!ethers.isAddress(addr || '')) throw new Error('用法：--verify <合约地址>');
    if (!(await verify(addr))) throw new Error('验证未通过');
    console.log('BscScan 验证通过'); return;
  }
  const wallet = loadWallet();
  const bal = await provider.getBalance(wallet.address);
  console.log('部署钱包:', wallet.address, '| 余额', ethers.formatEther(bal), 'BNB');
  if (SWEEP) {
    const to = process.env.SWEEP_TO;
    if (!ethers.isAddress(String(to || ''))) throw new Error('用 SWEEP_TO=<地址> 指定转回目标');
    const fee = await provider.getFeeData();
    const value = bal - 21000n * (fee.gasPrice || 0n) * 2n;
    if (value <= 0n) { console.log('余额不足，无需转出'); return; }
    console.log(`转出 ${ethers.formatEther(value)} BNB → ${to}`);
    if (!SEND) { console.log('（预演，加 --send 才真的转）'); return; }
    const tx = await wallet.sendTransaction({ to, value }); console.log('交易:', tx.hash); await tx.wait();
    console.log('已转出，剩余', ethers.formatEther(await provider.getBalance(wallet.address)), 'BNB'); return;
  }
  const { abi, bytecode } = compile();
  const deployTx = await new ethers.ContractFactory(abi, bytecode, wallet).getDeployTransaction();
  const gas = await provider.estimateGas({ from: wallet.address, data: deployTx.data });
  const fee = await provider.getFeeData();
  const cost = gas * (fee.gasPrice || 0n);
  console.log('预估 gas', gas.toString(), '≈', ethers.formatEther(cost), 'BNB');
  if (bal < cost * 2n) throw new Error(`余额不够：至少要 ${ethers.formatEther(cost * 2n)} BNB（含一倍余量）`);
  if (!SEND) { console.log('（预演结束，加 --send 才真的部署）'); return; }
  const c = await new ethers.ContractFactory(abi, bytecode, wallet).deploy();
  const tx = c.deploymentTransaction(); console.log('部署交易:', tx.hash);
  await c.waitForDeployment();
  const addr = await c.getAddress(); const rc = await provider.getTransactionReceipt(tx.hash);
  console.log('合约地址:', addr, '| 区块', rc.blockNumber, '| 实际费用', ethers.formatEther(rc.gasUsed * (rc.gasPrice || 0n)), 'BNB');
  // 自检：常量、treasury、无 owner 入口、真实持有者放行
  const r = new ethers.Contract(addr, abi, provider);
  const code = await provider.getCode(addr);
  const checks = {
    'AGENT_ID 常量': (await r.AGENT_ID()).toLowerCase() === AGENT_ID.toLowerCase(),
    'name = Piupiu Pass': (await r.name()) === 'Piupiu Pass',
    'totalSupply = 0': (await r.totalSupply()) === 0n,
    '无 owner() / upgradeTo 选择器': !code.includes('8da5cb5b') && !code.includes('3659cfe6'),
    '真实 .ai 持有者 holdsAgentId=true': await r.holdsAgentId('0x9d4b139cf21f95aa079798f424b99dc8fcc067a9'),
    '部署钱包 holdsAgentId=false': !(await r.holdsAgentId(wallet.address)),
  };
  for (const [k, v] of Object.entries(checks)) console.log(v ? '✓' : '✗', k);
  writeFileSync(OUT_FILE, JSON.stringify({ address: addr, tx: tx.hash, block: rc.blockNumber, gasUsed: rc.gasUsed.toString(), compiler: COMPILER, deployedAt: new Date().toISOString() }, null, 1), { mode: 0o600 });
  console.log('已写入', OUT_FILE);
  if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
};
main().catch((e) => { console.error('\n失败:', e.shortMessage || e.message); process.exitCode = 1; });
