#!/usr/bin/env node
// 雷达回放（docs/PLAN-RADAR.md R5）：把一段历史区块按顺序喂给和线上同一套扫描 / 判断逻辑，看哪些合约会上榜、什么时候上榜。
// 用来调阈值、验证漏报误报。只读：取完整区块 + 查 .ai（结果写进 data/radar/ai-cache.json，和线上共用）。
//   node scripts/radar-replay.mjs <起始块> <结束块> [--minAi 5] [--ratio 60]
//   node scripts/radar-replay.mjs last 600        # 最近 600 块（约 4.5 分钟）
// 公共节点能取到任意历史区块（取块不需要归档节点）；.ai 判断按现在的持有情况，和当时可能略有出入。
import { ethers } from 'ethers';
import { PUBLIC_RPC } from '../engine/live/rpc.js';
import { BlockScan, judge } from '../engine/live/radar/blockScan.js';
import { Known } from '../engine/live/radar/known.js';
import { AiSet } from '../engine/live/radar/aiSet.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? Number(args[i + 1]) : d; };
const p = new ethers.JsonRpcProvider(PUBLIC_RPC, 56, { staticNetwork: true, batchMaxCount: 1 });
let from, to;
if (args[0] === 'last') { to = await p.getBlockNumber(); from = to - Number(args[1] || 600); }
else { from = Number(args[0]); to = Number(args[1]); }
if (!(from > 0 && to >= from)) { console.log('用法：node scripts/radar-replay.mjs <起始块> <结束块> | last <块数>'); process.exit(1); }
const settings = { minAi: opt('minAi', 5), aiRatioPct: opt('ratio', 60), hotMult: 1.5, hotMin: 15 };
const ai = new AiSet({ provider: p, budgetPerMin: 400, concurrency: 6 });
const listed = new Map();
const scan = new BlockScan({ known: new Known(() => []), aiSet: ai, status: {}, onStats: (addr, st) => {
  const j = judge(st, settings);
  if (j.listed && !listed.has(addr)) listed.set(addr, { block: cur, ai: st.aiCallers, callers: st.callers, ratio: st.ratio });
  if (j.listed) Object.assign(listed.get(addr), { lastAi: st.aiCallers, hot: listed.get(addr).hot || j.hot });
} });
let cur = from;
console.log(`回放 ${from} → ${to}（${to - from + 1} 块），阈值：.ai ≥ ${settings.minAi}、占比 ≥ ${settings.aiRatioPct}%`);
const t0 = Date.now();
for (cur = from; cur <= to; cur++) {
  let b = null;
  for (let k = 0; k < 3 && !b; k++) { try { b = await p.send('eth_getBlockByNumber', ['0x' + cur.toString(16), true]); } catch { await new Promise((r) => setTimeout(r, 800)); } }
  if (!b) { console.log(`  块 ${cur} 取不到，跳过`); continue; }
  scan.ingest((Number(b.timestamp) || 0) * 1000, b.transactions || []);
  if ((cur - from) % 100 === 99) { await new Promise((r) => setTimeout(r, 1500)); process.stdout.write(`  …${cur}（上榜 ${listed.size}）\n`); }   // 等懒判断的 .ai 结果回来
}
await new Promise((r) => setTimeout(r, 3000));
console.log(`\n用时 ${Math.round((Date.now() - t0) / 1000)} 秒，上榜 ${listed.size} 个：`);
const nameI = new ethers.Interface(['function symbol() view returns (string)']);
for (const [a, x] of [...listed.entries()].sort((m, n) => n[1].lastAi - m[1].lastAi)) {
  let sym = ''; try { sym = nameI.decodeFunctionResult('symbol', await p.call({ to: a, data: nameI.encodeFunctionData('symbol') }))[0]; } catch { /* 没有 symbol */ }
  console.log(`  ${a}  ${String(sym).padEnd(12)}  首次上榜块 ${x.block}（+${x.block - from}）  .ai ${x.lastAi}  占比 ${Math.round(x.ratio * 100)}%${x.hot ? '  升温' : ''}`);
}
process.exit(0);
