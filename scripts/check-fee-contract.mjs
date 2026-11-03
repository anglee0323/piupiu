// 核对部署好的 PiupiuFee：链上字节码（去掉末尾编译元数据）与本地编译（0.8.24、优化 200、paris、treasury 写死为收款钱包）一致，
// 且 treasury() 是收款钱包。用法：node scripts/check-fee-contract.mjs <合约地址>
import { ethers } from 'ethers';
import { FEE_TREASURY } from '../engine/live/fees.js';

const EXPECT = '0xeda5bb3da7b2e9ee863fd782227928fca2a67353181029254418b39e5aa0f512';   // 运行时字节码（不含元数据）的 keccak256
const addr = process.argv[2];
if (!ethers.isAddress(addr)) { console.error('用法：node scripts/check-fee-contract.mjs <合约地址>'); process.exit(2); }
const p = new ethers.JsonRpcProvider('https://bsc-dataseed.bnbchain.org', 56, { staticNetwork: true });
const b = ethers.getBytes(await p.getCode(addr));
if (!b.length) { console.error('该地址没有合约代码'); process.exit(1); }
const n = (b[b.length - 2] << 8) | b[b.length - 1];
const same = ethers.keccak256(ethers.hexlify(b.slice(0, b.length - 2 - n))) === EXPECT;
const tre = await new ethers.Contract(addr, ['function treasury() view returns (address)'], p).treasury();
console.log(`字节码与本地编译一致：${same ? '是' : '否'}`);
console.log(`treasury：${tre}（${tre.toLowerCase() === FEE_TREASURY.toLowerCase() ? '正确' : '不是收款钱包！'}）`);
process.exit(same && tre.toLowerCase() === FEE_TREASURY.toLowerCase() ? 0 : 1);
