// 雷达 R0 的纯逻辑单测：窗口统计、上榜 / 升温判断、排除表、懒判断的 .ai 集合
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Win, judge, WINDOW_MS } from './blockScan.js';
import { Known, worthRecording } from './known.js';
import { AiSet } from './aiSet.js';

const lc = (a) => a.toLowerCase();
const A = (i) => lc('0x' + String(i).padStart(40, 'a'));   // 第 i 个测试地址
const C = '0x' + 'c1'.repeat(20);                            // 被调用的合约

test('Win：30 分钟窗口内不同调用者、.ai 占比、5 分钟桶、最近 .ai 时间', () => {
  const w = new Win();
  const now = Date.now();
  // 10 个调用者，其中 8 个是 .ai；一半发生在 25 分钟前，一半刚刚
  for (let i = 0; i < 10; i++) w.add(i < 8 ? now - 25 * 60_000 : now - 25 * 60_000, A(i));
  for (let i = 0; i < 10; i++) w.add(now, A(i));
  const aiOf = (a) => { const d = Number(a.slice(-1)); return d <= 7 ? true : d === 8 ? false : undefined; }   // 0..7 是 .ai，8 不是，9 未知
  const st = w.stats(now, aiOf);
  assert.equal(st.callers, 10);
  assert.equal(st.aiCallers, 8);
  assert.ok(Math.abs(st.ratio - 0.8) < 1e-9);
  assert.equal(st.bars.length, 12);
  assert.equal(st.lastAiAt, now, '最后一次 .ai 调用是刚刚');
  // 窗口外的要被剪掉
  w.prune(now + WINDOW_MS, 1);   // 时间过去一个窗口：全部事件都过期
  assert.equal(w.ev.length, 0);
  assert.equal(w.stats(now, aiOf).callers, 0);
});

test('judge：上榜要 .ai 人数和占比都够；升温要加速度', () => {
  const s = { minAi: 5, aiRatioPct: 60, hotMult: 1.5, hotMin: 15 };
  assert.deepEqual(judge({ aiCallers: 4, ratio: 0.9, last10: 9, prev10: 1 }, s), { listed: false, hot: false }, '人数不够');
  assert.deepEqual(judge({ aiCallers: 6, ratio: 0.5, last10: 9, prev10: 1 }, s), { listed: false, hot: false }, '占比不够');
  assert.deepEqual(judge({ aiCallers: 6, ratio: 0.75, last10: 3, prev10: 2 }, s), { listed: true, hot: false }, '够上榜但不升温');
  assert.deepEqual(judge({ aiCallers: 16, ratio: 0.8, last10: 9, prev10: 2 }, s), { listed: true, hot: true }, '4.5 倍加速 + 人数够 → 升温');
  assert.deepEqual(judge({ aiCallers: 16, ratio: 0.8, last10: 10, prev10: 10 }, s), { listed: true, hot: false }, '只有 1 倍，不算升温');
  assert.deepEqual(judge({ aiCallers: 20, ratio: 0.9, last10: 18, prev10: 0 }, s), { listed: true, hot: true }, '前 10 分钟没有基数时，最近 10 分钟够多就算升温');
});

test('worthRecording：建合约 / 纯转账 / 转账授权选择器 / 排除表都跳过', () => {
  const known = new Known(() => []);
  known.refresh(0);
  assert.equal(worthRecording({ to: null, data: '0x12345678' }, known), false, '建合约');
  assert.equal(worthRecording({ to: C, data: '0x' }, known), false, '空 data（普通转账 / deposit）');
  assert.equal(worthRecording({ to: C, data: '0xa9059cbb0000' }, known), false, 'transfer');
  assert.equal(worthRecording({ to: C, data: '0x095ea7b30000' }, known), false, 'approve');
  assert.equal(worthRecording({ to: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', data: '0x12345678' }, known), false, 'WBNB 在排除表');
  assert.equal(worthRecording({ to: C, data: '0x12345678' }, known), true, '正常调用要记');
  assert.equal(worthRecording({ to: C, input: '0x12345678' }, known), true, '字段叫 input 也要记（完整区块的真实返回）');
  assert.equal(worthRecording({ to: C, input: '0x' }, known), false, 'input 为空 = 纯转账');
});

test('AiSet：种子直接算已知；懒判断查链并缓存；每分钟有预算', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-ai-'));
  const file = pathToFileURL(join(dir, 'ai-cache.json'));
  const calls = [];
  const provider = { call: async (tx) => { calls.push(tx.data); return '0x' + '0'.repeat(63) + '1'; } };   // 全都持有
  const NAMED = '0x' + 'ab'.repeat(20), DOTBNB = '0x' + 'cd'.repeat(20);
  const names = { all: () => ({ [NAMED]: 'abc.ai', [DOTBNB]: 'x.bnb' }), peek: () => {} };
  const seedF = join(dir, 'seed.txt'), SEEDED = '0x' + 'ef'.repeat(20);
  writeFileSync(seedF, 'ef'.repeat(20) + '\nnot-an-address\n');
  let ai = new AiSet({ provider, file, names, seed: seedF, budgetPerMin: 2, concurrency: 1 });
  assert.equal(ai.peek(SEEDED), true, '自带名单里的地址直接算 .ai，且不过期');
  assert.equal(ai.count(), 2);
  assert.equal(ai.peek(NAMED), true, 'names 里的 .ai 是种子');
  assert.equal(ai.peek(DOTBNB), undefined, '.bnb 不算');
  const a1 = '0x' + '11'.repeat(20), a2 = '0x' + '22'.repeat(20), a3 = '0x' + '33'.repeat(20);
  ai.want([a1, a2, a3]);
  assert.equal(calls.length, 1, '并发 1：先只发第一个');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 2, '预算 2：第一个完成后查第二个，第三个不发');
  assert.equal(ai.peek(a1), true);
  assert.equal(ai.peek(a2), true);
  assert.equal(ai.peek(a3), undefined, '第三个还在预算外');
  // 持有的会写进缓存文件，重启后不用再查
  await new Promise((r) => setTimeout(r, 3300));
  ai = new AiSet({ provider: { call: async () => { throw new Error('不该再查'); } }, file, names });
  assert.equal(ai.peek(a1), true, '缓存文件里的结论直接用');
});

test('BlockScan.ingest：一个区块喂进去，to 的窗口有了、排除的没了', async () => {
  const BlockScanMod = await import('./blockScan.js');
  const scan = new BlockScanMod.BlockScan({ known: new Known(() => []), aiSet: { peek: () => true, want: () => {} }, status: {}, onStats: () => {} });
  const now = Date.now();
  const seen = [];
  scan.onStats = (to, st) => seen.push([to, st]);
  scan.ingest(now, [
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ to: C, from: A(i), data: '0x12345678' })),
    { to: C, from: A(0), data: '0xa9059cbb0000' },                       // transfer 不计
    { to: null, from: A(9), data: '0xdeadbeef' },                        // 建合约不计
    { to: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', from: A(9), data: '0x12345678' },   // WBNB 不计
  ]);
  assert.equal(seen.length, 1);
  const [to, st] = seen[0];
  assert.equal(to, C);
  assert.equal(st.callers, 8, 'transfer 那笔不计，8 个不同调用者');
  assert.equal(st.aiCallers, 8, 'peek 全返回 true');
  assert.equal(scan.wins.size, 1);
});
