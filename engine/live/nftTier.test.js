import { test } from 'node:test';
import assert from 'node:assert/strict';

// nftEvery 是纯函数式的分级规则（只读 t 和 keep），不需要起整个 LiveMarket：直接从原型里取
process.env.MODE = 'sim';
const { LiveMarket } = await import('./liveMarket.js');
const nftEvery = LiveMarket.prototype.nftEvery;

const now = 1_800_000_000_000, MIN = 60_000;
const tok = (o) => ({ address: '0xabc', createdAt: now - 10 * 3600_000, lastTradeAt: 0, nftHotAt: 0, ...o });

test('刚创建 / 15 分钟内有成交：每轮都读（0 = 不跳过）', () => {
  assert.equal(nftEvery(tok({ createdAt: now - 5 * MIN }), new Set(), now), 0);
  assert.equal(nftEvery(tok({ lastTradeAt: now - 10 * MIN }), new Set(), now), 0);
  assert.equal(nftEvery(tok({ nftHotAt: now - 1 * MIN }), new Set(), now), 0, '实时成交事件到了就升级');
});

test('持有 / 收藏的沉寂币 30 秒；2 小时内有过成交 1 分钟；再沉寂 10 分钟', () => {
  assert.equal(nftEvery(tok({ lastTradeAt: now - 3 * 3600_000 }), new Set(['0xabc']), now), 30_000);
  assert.equal(nftEvery(tok({ lastTradeAt: now - 60 * MIN }), new Set(), now), 60_000);
  assert.equal(nftEvery(tok({ lastTradeAt: now - 5 * 3600_000 }), new Set(), now), 600_000);
});

test('300 个币里只有少数活跃时，每秒请求数从 ~50 降到个位数', () => {
  const toks = [];
  for (let i = 0; i < 12; i++) toks.push(tok({ lastTradeAt: now - 3 * MIN }));          // 活跃
  for (let i = 0; i < 40; i++) toks.push(tok({ lastTradeAt: now - 60 * MIN }));         // 1 小时前
  for (let i = 0; i < 245; i++) toks.push(tok({ lastTradeAt: now - 20 * 3600_000 }));   // 死盘
  const perSec = toks.reduce((a, t) => { const e = nftEvery(t, new Set(), now); return a + 1000 / (e || 6000); }, 0);
  assert.ok(perSec < 5, `期望 < 5 次/秒，实际 ${perSec.toFixed(2)}`);
  const before = toks.length / 6;   // 旧逻辑：每 6 秒全读
  assert.ok(before > 40);
});
