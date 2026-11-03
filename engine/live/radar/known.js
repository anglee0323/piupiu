// 排除表（方案 docs/PLAN-RADAR.md L1）：雷达只看「陌生合约被很多 .ai 钱包调用」，路由 / 主流代币 / 已接入平台的合约
// 全部跳过——它们要么和 Agent 门槛无关，要么已经在战壕里了。地址一律小写比较。
import { V3_PADS } from '../gangV3.js';
import { AGENT_ID_NFT } from '../flapNft.js';

export const AGENT_ID = AGENT_ID_NFT;   // Binance Agent ID NFT（所有平台 Agent 专属门槛的落点）

// 静态排除：PancakeSwap 路由、常见代币、平台合约。路由的调用者又多又杂，不排除会白白烧 .ai 判断的 RPC
const STATIC = [
  // 路由 / 交易相关的公共设施
  '0x10ed43c718714eb63d5aa57b78b54704e256024e',   // PancakeSwap V2 Router
  '0x13f4ea83d0bd40e75c8222255bc855a974568dd4',   // PancakeSwap V3 Smart Router
  '0x1b81d678ffb9c0263b24a97847620c99d213eb14',   // PancakeSwap Universal Router
  '0x05ff2b0db69458a0750badebc4f9e13add608c7f',   // PancakeSwap V3 SwapRouter（旧）
  '0x1a81b078f0f874f7f7124cbcc708396d5d817a39',   // PancakeSwap UniversalRouter（新）
  '0x0000000000001ff3684f28c67538d4d072c22734',   // 0x ExchangeProxy
  // 常见代币
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',   // WBNB
  '0x55d398326f99059ff775485246999027b3197955',   // USDT
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',   // USDC
  '0xe9e7cea3dedca5984780bafc599bd69add087d56',   // BUSD
  '0x2170ed0880ac9a755fd29b2688956bd959f933f8',   // ETH
  '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c',   // BTCB
  '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82',   // CAKE
  '0x5169d88790bff9e8ad5f45193bfe0e0025c59098',   // GANG（Gang 平台币，常见计价币）
  // 已接入平台（战壕里已经看得见，不需要雷达再报一遍）
  '0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3',   // Four（OpenFourCore）
  '0x1b8f3f69dfa0a7f63d308c7eb0fd38d8b099966e',   // Gang V2 pad 1
  '0xf81c4e51c48466c6025b0165b1ea0f6978c712cb',   // Gang V2 pad 2
  '0x60aee38576035e757ded30ff8db8a8da476430c1',   // Gang V2 pad 3
  ...V3_PADS,                                      // Gang V3 pads（含动态发现的，data/gang-v3-pads.json）
  AGENT_ID,                                        // Agent ID NFT 本身（.ai 钱包天天在转）
];

// 这些选择器是纯转账 / 授权（对着代币合约调 transfer 和对着路由调 swap 的区别）：不值得当「活动」计数
const SKIP_SEL = new Set([
  '0xa9059cbb',   // transfer(address,uint256)
  '0x23b872dd',   // transferFrom(address,address,uint256)
  '0x095ea7b3',   // approve(address,uint256)
  '0x39509351',   // increaseAllowance(address,uint256)
  '0xa457c2d7',   // decreaseAllowance(address,uint256)
  '0xd505accf',   // permit(...)
  '0x2e17de78',   // deposit() 之外常见的 WBNB 类包装（保险起见连着跳）
]);

const lc = (a) => String(a || '').toLowerCase();

// 已知合约的中文名（「链上动态」里告诉用户 .ai 钱包在这些地方做什么）
const LABELS = new Map([
  ...['0x10ed43c718714eb63d5aa57b78b54704e256024e', '0x13f4ea83d0bd40e75c8222255bc855a974568dd4', '0x1b81d678ffb9c0263b24a97847620c99d213eb14', '0x05ff2b0db69458a0750badebc4f9e13add608c7f', '0x1a81b078f0f874f7f7124cbcc708396d5d817a39'].map((a) => [a, 'PancakeSwap 交易']),
  ['0x0000000000001ff3684f28c67538d4d072c22734', '聚合器交易'],
  ['0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', 'WBNB 包装 / 解包'],
  ['0xebe7b6c1089d9f72ad07f34e36d898e44e5e27f3', 'Four 内盘交易'],
  ...['0x1b8f3f69dfa0a7f63d308c7eb0fd38d8b099966e', '0xf81c4e51c48466c6025b0165b1ea0f6978c712cb', '0x60aee38576035e757ded30ff8db8a8da476430c1'].map((a) => [a, 'Gang 内盘交易']),
  [AGENT_ID, 'Agent ID 注册 / 转移'],
]);
for (const a of V3_PADS) LABELS.set(lc(a), 'Gang 内盘交易');

/** 排除表：静态名单 + 动态刷新（行情里已有的代币 / 内盘市场也算「已知」，每分钟从 liveMarket 同步一次）。
 *  dynamic() 返回 [address] 或 [{ address, label }] */
export class Known {
  constructor(dynamicAddrs = () => []) { this.dynamic = dynamicAddrs; this.set = new Set(STATIC.map(lc)); this.labels = new Map(LABELS); this.builtAt = 0; }
  refresh(now = Date.now()) {
    if (now - this.builtAt < 60_000) return;
    this.builtAt = now;
    const s = new Set(STATIC.map(lc)), labels = new Map(LABELS);
    for (const a of V3_PADS) { s.add(lc(a)); labels.set(lc(a), 'Gang 内盘交易'); }   // V3 pad 是运行中动态发现的
    for (const x of this.dynamic() || []) {
      const a = lc(typeof x === 'string' ? x : x?.address); if (!a) continue;
      s.add(a); if (x?.label && !labels.has(a)) labels.set(a, x.label);
    }
    this.set = s; this.labels = labels;
  }
  has(addr) { return this.set.has(lc(addr)); }
  label(addr) { return this.labels.get(lc(addr)) || null; }
  get size() { return this.set.size; }
}

/** 区块里的这笔交易值不值得记：to 要存在（排除建合约）、data 要带选择器（排除普通转账）、选择器不是转账/授权、to 不在排除表 */
export function worthRecording(tx, known, minWei = 0n) {
  if (!tx || !tx.to) return false;
  const d = String(tx.data ?? tx.input ?? '');   // 完整区块里交易对象的字段叫 input（data 是老叫法，两种都接）
  if (d.length < 10) return false;                     // '0x' 或比选择器还短：纯 BNB 转账 / deposit()，不算活动
  if (SKIP_SEL.has(d.slice(0, 10))) return false;
  if (tx.value != null && minWei > 0n && BigInt(tx.value) < minWei) return false;
  known.refresh();
  return !known.has(tx.to);
}
