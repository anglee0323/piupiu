// Piupiu Pass：只测校验和状态读取（桩掉合约读取，不碰 baw / 链）
import test from 'node:test';
import assert from 'node:assert/strict';
import { Pass } from './pass.js';

const C = '0x' + '12'.repeat(20), A = '0x' + '34'.repeat(20), B = '0x' + '56'.repeat(20);
const mk = (o = {}, reads = {}) => {
  const trader = { wallets: [{ slot: 1, label: 'W1', address: A }, { slot: 2, label: 'W2', address: B }], slotAuth: new Map([[1, { state: 'ok', agentId: 'bob.ai' }], [2, { state: 'logged_out' }]]) };
  const p = new Pass({ trader, provider: {}, contract: C, ...o });
  p.read = () => ({
    totalSupply: async () => 7n,
    passOf: async (a) => BigInt(reads.pass?.[a.toLowerCase()] ?? 0),
    holdsAgentId: async (a) => reads.agent?.[a.toLowerCase()] ?? false,
  });
  return p;
};

test('没配置合约 / 没有节点 = 功能关闭，view 返回 available:false', async () => {
  assert.equal(new Pass({ trader: {}, provider: {}, contract: '' }).available, false);
  assert.equal(new Pass({ trader: {}, provider: null, contract: C }).available, false);
  assert.deepEqual(await new Pass({ trader: {}, provider: {}, contract: '' }).view(), { available: false });
  await assert.rejects(new Pass({ trader: {}, provider: {}, contract: '' }).preview({ slot: 1 }), /暂未开放/);
});

test('view：每个钱包的领取状态；读不到时留空而不是当成没领', async () => {
  const p = mk({}, { pass: { [A]: 3 }, agent: { [A]: true, [B]: false } });
  const v = await p.view();
  assert.equal(v.total, 7);
  const w1 = v.wallets.find((w) => w.slot === 1), w2 = v.wallets.find((w) => w.slot === 2);
  assert.deepEqual([w1.claimed, w1.passId, w1.holdsAgentId, w1.loggedIn, w1.agentName], [true, 3, true, true, 'bob.ai']);
  assert.deepEqual([w2.claimed, w2.holdsAgentId, w2.loggedIn], [false, false, false]);
  const bad = mk(); bad.read = () => ({ totalSupply: async () => { throw new Error('rpc'); }, passOf: async () => { throw new Error('rpc'); }, holdsAgentId: async () => true });
  const v2 = await bad.view();
  assert.equal(v2.total, null); assert.equal(v2.wallets[0].claimed, null, '读失败 = 未知，不是「没领」');
});

test('预检的各种拒绝：没这个钱包 / 未登录 / 已领取 / 没有 Agent ID', async () => {
  await assert.rejects(mk().preview({ slot: 9 }), /找不到这个钱包/);
  await assert.rejects(mk().preview({ slot: 2 }), /未登录/);
  await assert.rejects(mk({}, { pass: { [A]: 1 } }).preview({ slot: 1 }), /已经领过/);
  await assert.rejects(mk({}, { agent: { [A]: false } }).preview({ slot: 1 }), /没有 Agent ID/);
});

test('提交：预检失效 / 超时 / 演示模式都不会发出交易', async () => {
  const p = mk();
  await assert.rejects(p.submit({ previewId: 'nope' }), /预检已失效/);
  p.previews.set('old', { id: 'old', slot: 1, at: Date.now() - 61_000, data: '0x' });
  await assert.rejects(p.submit({ previewId: 'old' }), /超过 60 秒/);
  assert.equal(p.previews.has('old'), false, '过期的预检被清掉');
  p.previews.set('ok', { id: 'ok', slot: 1, at: Date.now(), data: '0x' });
  await assert.rejects(p.submit({ previewId: 'ok' }), /演示模式/);
  assert.equal(p.jobs.size, 0, '演示模式下不留领取任务');
});
