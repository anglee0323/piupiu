// 币摘要（推给页面的每个币）字段契约：page 依赖的字段必须都带上。
// 2026-10-28 一行中间的注释把 gangDiv / gangV3 / gangFair / flapTax / nftGate / description / website / twitter / telegram 都注释掉了，
// 页面上的分红 / 税率 / 门槛标签和社交链接全没了，一天后才被发现。
import test from 'node:test';
import assert from 'node:assert/strict';
const { LiveMarket } = await import('./liveMarket.js');

// 只借用 summary()，其余依赖用最小桩（不创建真实的行情连接）
const fake = Object.assign(Object.create(LiveMarket.prototype), {
  quoteUsd: () => 600, buyFeePct: () => 1, sellFeePct: () => 1, change: () => ({ m5: 1, h1: 2, h24: 3 }),
  names: { peek: () => 'dev.ai' }, bonds: { get: (a) => (a === '0xt' ? { state: 'active', tier: 'full' } : null) }, fourP0: 0,
});
const token = {
  address: '0xT', symbol: 'TT', name: 'Test', platform: 'gang', source: 'gang', stage: 'curve', price: 0.001, raised: 1, target: 10, progress: 10,
  creator: '0xc', createdAt: Date.now(), maxSupply: 1e9,
  gangDiv: { taxed: true, taxBps: 100, divBps: 5000 }, gangV3: { buyTaxBps: 100, sellTaxBps: 100, dividendBps: 5000 }, gangFair: { sold: 1, totalShares: 10 },
  flapTax: { buyBps: 100, sellBps: 100, divBps: 3000 }, nftGate: { known: true, name: 'Agent ID' },
  description: 'd', website: 'https://w', twitter: 'https://x.com/t', telegram: 'https://t.me/t',
  volume: 5, pair: '0xp', tradeCount: 3, logo: 'l',
};

test('页面依赖的字段都在摘要里', () => {
  const s = fake.summary({ ...token, source: 'flap-nft', stage: 'curve' });
  for (const k of ['address', 'symbol', 'name', 'platform', 'stage', 'price', 'priceUsd', 'mcapUsd', 'creator', 'creatorName', 'createdAt', 'buyFeePct', 'sellFeePct', 'chg',
    'gangDiv', 'gangV3', 'gangFair', 'gangBond', 'flapTax', 'nftGate', 'description', 'website', 'twitter', 'telegram']) assert.ok(k in s, `摘要缺少字段 ${k}`);
});
test('带了数据的字段不能是空的', () => {
  const s = fake.summary({ ...token, source: 'flap-nft' });
  assert.equal(s.website, 'https://w'); assert.equal(s.twitter, 'https://x.com/t'); assert.equal(s.telegram, 'https://t.me/t'); assert.equal(s.description, 'd');
  assert.deepEqual(s.gangV3, token.gangV3); assert.deepEqual(s.gangFair, token.gangFair); assert.deepEqual(s.gangDiv, token.gangDiv);
  assert.equal(s.flapTax.divBps, 3000); assert.ok(s.nftGate);
});
test('Gang 币带上押金承诺；其他平台没有', () => {
  assert.deepEqual(fake.summary({ ...token, address: '0xt', source: 'gang' }).gangBond, { state: 'active', tier: 'full' });
  assert.equal(fake.summary({ ...token, address: '0xt', source: 'flap-nft' }).gangBond, null);
});
