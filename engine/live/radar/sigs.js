// 4 字节选择器 → 函数名（mint(uint256) 之类）。顺序：已验证源码的 ABI → 内置常见表 → 本地缓存 → openchain / 4byte 公共库。
// 公共库查到多个同名候选时取第一个（openchain 按「有已验证合约」排序）。查不到的显示选择器本身。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { ethers } from 'ethers';
import { dataFile } from '../config.js';
import { EP } from '../endpoints.js';

const COMMON = [
  'mint()', 'mint(uint256)', 'mint(uint8)', 'mint(address)', 'mint(address,uint256)', 'publicMint()', 'publicMint(uint256)', 'freeMint()', 'freeMint(uint256)',
  'agentMint()', 'agentMint(uint256)', 'claim()', 'claim(uint256)', 'claim(address)', 'claimTokens()', 'airdrop()', 'checkIn()', 'checkin()', 'register()', 'join()',
  'buy()', 'buy(uint256)', 'buy(address)', 'buy(address,uint256)', 'sell(uint256)', 'sell(uint256,uint256)', 'swap()', 'deposit()', 'withdraw()', 'withdraw(uint256)',
  'stake(uint256)', 'unstake(uint256)', 'create(string,string)', 'createToken(string,string)', 'launch(string,string)', 'vote(uint256)', 'play()', 'roll()', 'open()',
  'transfer(address,uint256)', 'approve(address,uint256)', 'setApprovalForAll(address,bool)', 'safeTransferFrom(address,address,uint256)',
];
const ERRORS = ['Error(string)', 'NotAgent()', 'NotAgentHolder()', 'OnlyAgent()', 'NoAgentId()', 'AlreadyMinted()', 'MaxSupplyReached()', 'SoldOut()', 'MintNotStarted()', 'MintClosed()', 'Paused()', 'EnforcedPause()', 'InsufficientPayment()', 'WrongPrice()', 'ExceedsMaxPerWallet()', 'MaxPerWalletExceeded()', 'NotEligible()', 'InvalidSignature()', 'OwnableUnauthorizedAccount(address)'];

const lcSel = (s) => String(s || '').toLowerCase().slice(0, 10);
const table = new Map([...COMMON, ...ERRORS].map((sig) => [ethers.id(sig).slice(0, 10), sig]));
const FILE = dataFile('radar/sigs.json');
let cache = {};
try { cache = JSON.parse(readFileSync(FILE, 'utf8')) || {}; } catch { /* 第一次 */ }
let saveT = null;
const save = () => { clearTimeout(saveT); saveT = setTimeout(() => { try { mkdirSync(new URL('.', FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(cache)); } catch { /* ignore */ } }, 2000); };

const fetchJson = async (url, ms = 6000) => {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } }); return r.ok ? await r.json() : null; } catch { return null; } finally { clearTimeout(t); }
};

/** abi：已验证源码的 ABI（有就最准） */
export async function nameOf(selector, abi = null) {
  const s = lcSel(selector); if (!/^0x[0-9a-f]{8}$/.test(s)) return null;
  if (abi) { try { const f = new ethers.Interface(abi).getFunction(s) || null; if (f) return f.format('sighash'); } catch { /* ABI 里没有 */ } try { const e = new ethers.Interface(abi).getError(s); if (e) return e.format('sighash'); } catch { /* 不是 error */ } }
  if (table.has(s)) return table.get(s);
  if (s in cache) return cache[s];
  let name = null;
  const j = await fetchJson(`${EP.openchain}/signature-database/v1/lookup?function=${s}&filter=true`);
  name = j?.result?.function?.[s]?.[0]?.name || null;
  if (!name) { const k = await fetchJson(`${EP.fourbyte}/api/v1/signatures/?hex_signature=${s}`); const r = k?.results || []; name = r.length ? r[r.length - 1].text_signature : null; }   // 4byte 最早登记的那个更可能是真名
  cache[s] = name; save();
  return name;
}

/** 回滚原因：Error(string) 直接解码；自定义错误按选择器查名字 */
export async function revertText(data, abi = null) {
  const d = String(data || '');
  if (!d || d === '0x') return null;
  if (d.startsWith('0x08c379a0')) { try { return ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + d.slice(10))[0]; } catch { return '合约拒绝'; } }
  if (d.startsWith('0x4e487b71')) return '合约内部错误（Panic）';
  const n = await nameOf(d.slice(0, 10), abi);
  return n ? n.replace(/\(.*\)$/, '') : `错误码 ${d.slice(0, 10)}`;
}
