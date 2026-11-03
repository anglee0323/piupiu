// 共用筛选（Gateway 提醒判断和网页列表用同一份）的单测：行为要和挪出来之前网页里的写法一致
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchColumn, sortColumn, matchRadar, matchRadarSoon, inPlatforms, launchpadOf, volUsd, emptyFilter, recommendedRadarFilter } from './filters.js';

const NOW = 1_800_000_000_000;
const ALL = ['flap', 'four', 'gang-v1', 'gang-v2', 'gang-v3', 'gang-fair'];
const tok = (o = {}) => ({ address: '0xAa', symbol: 'DOG', name: 'Doge', platform: 'flap', stage: 'curve', progress: 10, createdAt: NOW - 60_000, volume: 1, ...o });
const ctx = (o = {}) => ({ platforms: ALL, bnbUsd: 600, now: NOW, isBlocked: () => false, ...o });

test('发射台归属：Gang 四个版本各算一个', () => {
  assert.equal(launchpadOf({ platform: 'gang', gangTrack: 'v3fair' }), 'gang-fair');
  assert.equal(launchpadOf({ platform: 'gang', gangTrack: 'v3curve' }), 'gang-v3');
  assert.equal(launchpadOf({ platform: 'gang', gangTrack: 'v2' }), 'gang-v2');
  assert.equal(launchpadOf({ platform: 'gang' }), 'gang-v1');
  assert.equal(inPlatforms({ platform: 'four' }, ['flap']), false);
});

test('战壕列：阶段、平台、屏蔽', () => {
  assert.equal(matchColumn(tok(), 'new', null, ctx()), true);
  assert.equal(matchColumn(tok({ stage: 'dex' }), 'new', null, ctx()), false);
  assert.equal(matchColumn(tok({ progress: 0 }), 'soon', null, ctx()), false, '即将打满要求进度 > 0');
  assert.equal(matchColumn(tok({ stage: 'dex' }), 'dex', null, ctx()), true);
  assert.equal(matchColumn(tok(), 'new', null, ctx({ platforms: ['four'] })), false);
  assert.equal(matchColumn(tok(), 'new', null, ctx({ isBlocked: () => true })), false);
});

test('战壕列：关键词 / 排除 / 开发者 / 社交 / 押金', () => {
  assert.equal(matchColumn(tok(), 'new', { keywords: 'doge, cat' }, ctx()), true);
  assert.equal(matchColumn(tok(), 'new', { keywords: 'cat' }, ctx()), false);
  assert.equal(matchColumn(tok(), 'new', { exclude: 'dog' }, ctx()), false);
  assert.equal(matchColumn(tok({ creatorName: 'alice.ai' }), 'new', { dev: 'alice' }, ctx()), true);
  assert.equal(matchColumn(tok(), 'new', { social: true }, ctx()), false);
  assert.equal(matchColumn(tok({ twitter: 'x' }), 'new', { social: true }, ctx()), true);
  assert.equal(matchColumn(tok({ gangBond: { state: 'active', violated: false } }), 'new', { bond: true }, ctx()), true);
  assert.equal(matchColumn(tok({ gangBond: { state: 'active', violated: true } }), 'new', { bond: true }, ctx()), false);
  assert.equal(matchColumn(tok({ gangBond: { state: 'slashed' } }), 'new', { bond: true }, ctx()), false);
});

test('战壕列：区间（市值 / 池子 / 成交额单位千美元，年龄单位分钟，已开盘按开盘时间算）', () => {
  assert.equal(matchColumn(tok({ mcapUsd: 5_000 }), 'new', { minMc: '4' }, ctx()), true);
  assert.equal(matchColumn(tok({ mcapUsd: 3_000 }), 'new', { minMc: '4' }, ctx()), false);
  assert.equal(matchColumn(tok({ volume: 10 }), 'new', { minVol: '5' }, ctx()), true, '10 BNB × 600 = 6K');
  assert.equal(matchColumn(tok({ createdAt: NOW - 10 * 60_000 }), 'new', { maxAge: '5' }, ctx()), false);
  assert.equal(matchColumn(tok({ stage: 'dex', createdAt: NOW - 600 * 60_000, migratedAt: NOW - 60_000 }), 'dex', { maxAge: '5' }, ctx()), true);
  assert.equal(matchColumn(tok({ buyFeePct: 1, sellFeePct: 6 }), 'new', { maxTax: '5' }, ctx()), false);
  assert.deepEqual(Object.keys(emptyFilter()).length, 19);
});

test('成交额：开盘后优先 DEX 24h 美元成交额', () => {
  assert.equal(volUsd({ stage: 'dex', dexVolUsd24: 123 }, 600), 123);
  assert.equal(volUsd({ stage: 'dex', dexVol24: 2, quoteUsd: 10 }, 600), 20);
  assert.equal(volUsd({ stage: 'curve', volume: 2 }, 600), 1200);
});

test('列排序', () => {
  const a = tok({ address: '0x1', progress: 50, mcapUsd: 1, createdAt: 1 }), b = tok({ address: '0x2', progress: 10, mcapUsd: 9, createdAt: 2 });
  assert.deepEqual(sortColumn([b, a], 'soon', 'progress').map((t) => t.address), ['0x1', '0x2']);
  assert.deepEqual(sortColumn([a, b], 'soon', 'mc').map((t) => t.address), ['0x2', '0x1']);
  assert.deepEqual(sortColumn([a, b], 'new').map((t) => t.address), ['0x2', '0x1']);
});

test('雷达筛选：推荐筛选（免费 + 一键铸造，不限分数）', () => {
  const it = { address: '0xb', title: 'X', firstSeen: NOW - 1000, priority: { score: 70 }, free: true, canDo: true, mineExhausted: false, aiCallers: 5 };
  const f = recommendedRadarFilter();
  assert.equal(matchRadar(it, f, NOW), true);
  assert.equal(matchRadar({ ...it, priority: { score: 52 } }, f, NOW), true, '推荐项目（≥50 分）不再被 68 分门槛挡住');
  assert.equal(matchRadar({ ...it, priority: { score: 52 } }, { minScore: '68' }, NOW), false);
  assert.equal(matchRadar({ ...it, free: false }, f, NOW), false);
  assert.equal(matchRadar({ ...it, mineExhausted: true }, f, NOW), false);
  assert.equal(matchRadar(it, { price: 'max', maxBnb: '0.01' }, NOW), true, '免费的不受费用上限影响');
  assert.equal(matchRadar({ ...it, free: false, price: String(2e16) }, { price: 'max', maxBnb: '0.01' }, NOW), false);
  assert.equal(matchRadar({ ...it, bornAt: NOW - 3 * 3600_000 }, { maxAgeH: '2' }, NOW), false);
  assert.equal(matchRadar(it, { exclude: 'x' }, NOW), false);
});

test('雷达筛选：已铸比例不低于（读不到总量的不算）', () => {
  const base = { address: '0x1', title: 'A', firstSeen: Date.now(), aiCallers: 5 };
  assert.equal(matchRadar({ ...base, supply: { pct: 72 } }, { minPct: '70' }), true);
  assert.equal(matchRadar({ ...base, supply: { pct: 40 } }, { minPct: '70' }), false);
  assert.equal(matchRadar({ ...base, supply: null }, { minPct: '70' }), false);
  assert.equal(matchRadar({ ...base, supply: null }, {}), true, '不设门槛时不受影响');
});

test('雷达「即将打满」：门槛、未铸完、上线时间、仅免费 / 仅一键、排除已铸过和冷却', () => {
  const now = Date.now(), h = 3600_000;
  const it = { address: '0x1', title: 'A', firstSeen: now - 10 * h, bornAt: now - 10 * h, aiCallers: 5, supply: { pct: 75 }, free: true, canDo: true, state: 'hot' };
  assert.equal(matchRadarSoon(it, { minPct: 70, maxAgeH: 24 }, now), true);
  assert.equal(matchRadarSoon(it, { minPct: 80 }, now), false, '没到门槛');
  assert.equal(matchRadarSoon({ ...it, supply: { pct: 100 } }, {}, now), false, '已铸完');
  assert.equal(matchRadarSoon({ ...it, supply: null }, {}, now), false, '读不到总量');
  assert.equal(matchRadarSoon({ ...it, bornAt: now - 30 * h }, { maxAgeH: 24 }, now), false, '超过上线时间');
  assert.equal(matchRadarSoon({ ...it, bornAt: now - 300 * h }, { maxAgeH: 0 }, now), true, '0 = 不限');
  assert.equal(matchRadarSoon({ ...it, free: false }, { free: true }, now), false);
  assert.equal(matchRadarSoon({ ...it, canDo: false }, { oneClick: true }, now), false);
  assert.equal(matchRadarSoon({ ...it, mintTx: 1 }, {}, now), false, '已铸过');
  assert.equal(matchRadarSoon({ ...it, state: 'cool' }, {}, now), false, '冷却');
});
