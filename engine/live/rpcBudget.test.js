import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initNodeRealBudget, nodeRealBudget, nrExhausted, bumpUsage, FailoverProvider, RPC_USAGE, setNodeRealSlots } from './rpc.js';

const dir = mkdtempSync(join(tmpdir(), 'piupiu-budget-'));
const NR = 'https://bsc-mainnet.nodereal.io/v1/abcdefabcdefabcdefabcdef';
const PUB = 'https://bsc-rpc.publicnode.com';
setNodeRealSlots([NR]);

test('启动时从历史里把本月已用的算回来；上个月的不算', () => {
  const f = join(dir, 'h.jsonl');
  const now = Date.now(), lastMonth = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 15);
  writeFileSync(f, [{ ts: lastMonth, perKey: { NodeReal: { cu: 99_000_000 } } }, { ts: now - 1000, perKey: { NodeReal: { cu: 3_000_000 } } }, { ts: now, perKey: { NodeReal: { cu: 2_000_000 } } }].map((r) => JSON.stringify(r)).join('\n') + '\n');
  initNodeRealBudget({ limit: 9_000_000, historyFile: f });
  const b = nodeRealBudget();
  assert.equal(b.used, 5_000_000);
  assert.equal(b.left, 4_000_000);
  assert.equal(nrExhausted(), false);
});

test('已用超过上限：启动就是停用状态（重启不会清零）', () => {
  const f = join(dir, 'h2.jsonl');
  writeFileSync(f, JSON.stringify({ ts: Date.now(), perKey: { NodeReal: { cu: 10_100_000 } } }) + '\n');
  initNodeRealBudget({ limit: 9_000_000, historyFile: f });
  assert.equal(nrExhausted(), true);
  assert.equal(nodeRealBudget().left, 0);
});

test('运行中累计到上限就停用；只有 NodeReal 的调用计 CU，公共节点不计', () => {
  initNodeRealBudget({ limit: 1000, historyFile: join(dir, 'none.jsonl') });
  bumpUsage('x', PUB, { method: 'eth_call' });
  assert.equal(nodeRealBudget().used, 0, '公共节点不占额度');
  for (let i = 0; i < 49; i++) bumpUsage('x', NR, { method: 'eth_call' });   // 49 × 20 = 980
  assert.equal(nrExhausted(), false);
  bumpUsage('x', NR, { method: 'eth_call' });   // 1000
  assert.equal(nrExhausted(), true);
  RPC_USAGE.clear();
});

test('额度用完后 HTTP 候选里不再有 NodeReal；没用完时 NodeReal 仍排在前面', () => {
  initNodeRealBudget({ limit: 0, historyFile: join(dir, 'none.jsonl') });   // 不限制
  const p1 = new FailoverProvider([NR, PUB], 't');
  assert.equal(p1.order()[0].nr, true);
  initNodeRealBudget({ limit: 100, historyFile: join(dir, 'none.jsonl') });
  for (let i = 0; i < 5; i++) bumpUsage('x', NR, { method: 'eth_call' });
  assert.equal(nrExhausted(), true);
  const p2 = new FailoverProvider([NR, PUB], 't');
  assert.deepEqual(p2.order().map((n) => n.nr), [false]);
  const only = new FailoverProvider([NR], 't');
  assert.equal(only.order().length, 1, '全是 NodeReal 的 provider 没得选时才硬试');
  RPC_USAGE.clear();
});

test('多个 key 各记各的：旧 key 用满只停它，新 key 照常用，下单仍走 NodeReal', () => {
  const NR2 = 'https://bsc-mainnet.nodereal.io/v1/123456123456123456123456';
  setNodeRealSlots([NR, NR2]);
  const f = join(dir, 'h3.jsonl');
  // 历史里只有「NodeReal」（当时单 key）→ 归到第 1 个 key
  writeFileSync(f, JSON.stringify({ ts: Date.now(), perKey: { NodeReal: { cu: 10_100_000 } } }) + '\n');
  initNodeRealBudget({ limit: 9_000_000, historyFile: f });
  assert.equal(nrExhausted(NR), true, '第 1 个 key 已用满');
  assert.equal(nrExhausted(NR2), false, '第 2 个 key 还有额度');
  assert.equal(nrExhausted(), false, '还有可用的 key，整体不算用完');
  const b = nodeRealBudget();
  assert.deepEqual(b.keys.map((k) => k.exhausted), [true, false]);
  assert.equal(b.left, 9_000_000, '剩余 = 新 key 的 900 万');
  // HTTP：候选里只剩新 key + 公共节点
  const p = new FailoverProvider([NR, NR2, PUB], 't');
  assert.deepEqual(p.order().map((n) => n.url), [NR2, PUB]);
  // 新 key 的用量只计在新 key 上
  bumpUsage('x', NR2, { method: 'eth_call' });
  assert.equal(nodeRealBudget().keys[1].used, 20);
  assert.equal(nodeRealBudget().keys[0].used, 10_100_000);
  // 两个 key 都用满才算整体用完
  initNodeRealBudget({ limit: 100, historyFile: join(dir, 'none.jsonl') });
  for (let i = 0; i < 5; i++) { bumpUsage('x', NR, { method: 'eth_call' }); bumpUsage('x', NR2, { method: 'eth_call' }); }
  assert.equal(nrExhausted(), true);
  RPC_USAGE.clear(); setNodeRealSlots([NR]);
});

process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
