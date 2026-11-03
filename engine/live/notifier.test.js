// 提醒判断（Gateway）的单测：战壕新币 / 雷达新推荐 / 钱包追踪，规则与挪出来之前网页里的一致
import test from 'node:test';
import assert from 'node:assert/strict';
import { Notifier, RULES } from './notifier.js';

const mk = (prefs = {}, start = 0) => {
  let t = start;
  const n = new Notifier({ getPrefs: () => prefs, now: () => t });
  const out = []; n.on('alert', (a) => out.push(a));
  return { n, out, at: (v) => { t = v; } };
};
const T0 = RULES.trench.quietAfterStart + 1000;
const tok = (addr, o = {}) => ({ address: addr, symbol: addr, name: addr, platform: 'flap', stage: 'curve', progress: 5, createdAt: T0, ...o });
const soundCols = (k, extra = {}) => ({ cols: { new: { sound: k === 'new', soundKind: 'Coins', ...extra }, soon: { sound: k === 'soon' }, dex: { sound: k === 'dex' } } });

test('战壕：第一次只记下；之后真正新创建的才提醒；声音用列设置', () => {
  const { n, out, at } = mk(soundCols('new'));
  at(T0); n.onTokens([tok('a')], 600);
  assert.equal(out.length, 0, '第一次是基线');
  n.onTokens([tok('a'), tok('b')], 600);
  assert.equal(out.length, 1); assert.equal(out[0].source, 'trench'); assert.equal(out[0].col, 'new'); assert.equal(out[0].sound, 'Coins');
  assert.deepEqual(out[0].tokens.map((x) => x.address), ['b']);
  n.onTokens([tok('a'), tok('b')], 600);
  assert.equal(out.length, 1, '同一个币不重复提醒');
});

test('战壕：老币补进列表不算新；启动 60 秒内不提醒；列声音关掉不提醒', () => {
  const a = mk(soundCols('new'));
  a.at(T0); a.n.onTokens([], 600);
  a.n.onTokens([tok('old', { createdAt: T0 - 10 * 60_000 })], 600);
  assert.equal(a.out.length, 0, '10 分钟前创建的不算新');
  const b = mk(soundCols('new'));
  b.at(1000); b.n.onTokens([], 600); b.n.onTokens([tok('x', { createdAt: 1000 })], 600);
  assert.equal(b.out.length, 0, '启动 60 秒内只记下');
  const c = mk({});   // 默认各列声音关
  c.at(T0); c.n.onTokens([], 600); c.n.onTokens([tok('y')], 600);
  assert.equal(c.out.length, 0);
});

test('战壕：已开盘按开盘时间判断「刚出现」，即将打满新进入就算', () => {
  const d = mk(soundCols('dex'));
  d.at(T0); d.n.onTokens([], 600);
  d.n.onTokens([tok('m', { stage: 'dex', createdAt: 0, migratedAt: T0 - 1000 })], 600);
  assert.equal(d.out.length, 1);
  const s = mk(soundCols('soon'));
  s.at(T0); s.n.onTokens([tok('p', { progress: 0, createdAt: 0 })], 600);
  s.n.onTokens([tok('p', { progress: 3, createdAt: 0 })], 600);
  assert.equal(s.out.length, 1, '进度从 0 变成 >0，新进入即将打满');
});

const rec = (id, o = {}) => ({ id, address: id, title: id, rec: true, firstSeen: 0, priority: { score: 80 }, free: true, canDo: true, aiCallers: 5, ...o });

test('雷达：第一次只记下；新推荐按筛选命中；30 秒内只响一次', () => {
  const { n, out, at } = mk({});
  at(1000); n.onRadarView({ items: [rec('a')] });
  assert.equal(out.length, 0);
  n.onRadarView({ items: [rec('a'), rec('b'), rec('c', { free: false })] });
  assert.equal(out.length, 1); assert.deepEqual(out[0].ids, ['b'], '默认推荐筛选：付费的不弹'); assert.equal(out[0].sound, 'Bell');
  at(5000); n.onRadarView({ items: [rec('a'), rec('b'), rec('d')] });
  assert.equal(out.length, 2); assert.equal(out[1].sound, null, '30 秒内不重复响，但卡片照弹');
  at(40_000); n.onRadarView({ items: [rec('e')] });
  assert.equal(out[2].sound, 'Bell');
});

test('雷达：已铸过 / 冷却 / 隐藏的不弹；总开关关掉不弹', () => {
  const { n, out, at } = mk({});
  at(1000); n.onRadarView({ items: [] });
  n.onRadarView({ items: [rec('a', { mintTx: 1 }), rec('b', { state: 'cool' }), rec('c', { blocked: true }), rec('d', { mineExhausted: true })] });
  assert.equal(out.length, 0);
  const off = mk({ radarAlert: false });
  off.at(1000); off.n.onRadarView({ items: [] }); off.n.onRadarView({ items: [rec('z')] });
  assert.equal(off.out.length, 0);
});

test('钱包追踪：每笔实时成交都提醒；回补不提醒；单独关掉 / 单独指定声音', () => {
  const { n, out } = mk({ trackSound: { on: true, kind: 'Kaching' } });
  const targets = [{ address: 'w1' }, { address: 'w2', sound: false }, { address: 'w3', sound: 'Coins' }];
  n.onTrackEvent({ id: 1, target: 'w1' }, targets);
  n.onTrackEvent({ id: 2, target: 'w1', backfill: true }, targets);
  n.onTrackEvent({ id: 3, target: 'w2' }, targets);
  n.onTrackEvent({ id: 4, target: 'w3' }, targets);
  assert.deepEqual(out.map((a) => [a.id, a.sound]), [[1, 'Kaching'], [4, 'Coins']]);
  const off = mk({ trackSound: { on: false, kind: 'Kaching' } });
  off.n.onTrackEvent({ id: 1, target: 'w1' }, targets);
  assert.equal(off.out.length, 0);
});

test('雷达即将打满：第一次只记下；之后新达到门槛的提醒一次（不在推荐里的也算）；关掉不弹', () => {
  const { n, out, at } = mk({ radarSoon: { minPct: 70, maxAgeH: 0, free: true, oneClick: false, alert: true } });
  const it = (id, pct, extra = {}) => ({ id, address: id, title: id, rec: false, firstSeen: 0, aiCallers: 3, free: true, canDo: true, state: 'hot', supply: { pct }, ...extra });
  at(1000); n.onRadarView({ items: [it('x', 80)] });
  assert.equal(out.length, 0, '启动时已经达标的不弹');
  n.onRadarView({ items: [it('x', 85), it('y', 50)] });
  assert.equal(out.length, 0, '没到门槛');
  n.onRadarView({ items: [it('x', 90), it('y', 72)] });
  assert.equal(out.length, 1); assert.deepEqual(out[0].ids, ['y']);
  n.onRadarView({ items: [it('x', 95), it('y', 80)] });
  assert.equal(out.length, 1, '同一个项目只提醒一次');
  n.onRadarView({ items: [it('z', 75, { free: false })] });
  assert.equal(out.length, 1, '默认仅免费');
  const off = mk({ radarSoon: { minPct: 70, alert: false } });
  off.at(1000); off.n.onRadarView({ items: [] }); off.n.onRadarView({ items: [it('w', 80)] });
  assert.equal(off.out.length, 0);
  // 雷达提醒总开关关掉：即将打满自己的开关开着也不弹、不响（用户关了提醒还在弹、还在响）
  const master = mk({ radarAlert: false, radarAlertSound: true, radarSoon: { minPct: 70, maxAgeH: 0, free: true, oneClick: false, alert: true } });
  master.at(1000); master.n.onRadarView({ items: [] }); master.n.onRadarView({ items: [it('v', 80), rec('r')] });
  assert.equal(master.out.length, 0);
});

test('雷达自动铸造开着：命中的交给自动铸造（radarMatch），不弹卡片；提醒开关关着也照样命中', () => {
  let t = 0; const prefs = { radarAlert: false, radarSoon: { minPct: 70, maxAgeH: 0, free: true, oneClick: false, alert: false } };
  const n = new Notifier({ getPrefs: () => prefs, now: () => t, autoMintOn: () => true });
  const alerts = [], matches = []; n.on('alert', (a) => alerts.push(a)); n.on('radarMatch', (m) => matches.push(m.map((x) => x.id)));
  const soon = (id, pct) => ({ id, address: id, title: id, rec: false, firstSeen: 0, aiCallers: 3, free: true, canDo: true, state: 'hot', supply: { pct } });
  t = 1000; n.onRadarView({ items: [rec('a')] });
  n.onRadarView({ items: [rec('a'), rec('b'), soon('s', 80)] });
  assert.equal(alerts.length, 0);
  assert.deepEqual(matches, [['b', 's']]);
});
