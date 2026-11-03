// NFT 批量转出（Gateway）的单测：用假的预检 / 提交（不碰币安钱包、不发交易）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNftBatch, MAX_PER_BATCH } from './nftBatch.js';

const fakePart = ({ failPreview = null, failSubmit = null } = {}) => {
  const submitted = [];
  return {
    submitted,
    async transferPreview({ slot, tokenId }) {
      if (tokenId === failPreview) throw new Error('模拟没通过');
      return { previewId: `p${tokenId}`, expiresAt: 1_000 + 60_000, tokenId, to: '0xDEST', risks: tokenId === '2' ? ['新地址'] : [], needAppConfirm: false, slot };
    },
    async transferSubmit({ previewId }) {
      if (previewId === `p${failSubmit}`) throw new Error('币安钱包拒绝');
      submitted.push(previewId); return { ok: true };
    },
  };
};
const mk = (o, dest = '0xDEST') => { let t = 1_000; const part = fakePart(o); return { part, nb: createNftBatch({ part, getDest: () => dest, now: () => t }), at: (v) => { t = v; } }; };
const items = (n) => Array.from({ length: n }, (_, i) => ({ slot: 1, tokenId: String(i + 1) }));

test('预检：汇总成批次，previewId 不外露，风险提示合并', async () => {
  const { nb } = mk();
  const pv = await nb.preview({ address: '0xNFT', items: items(3) });
  assert.match(pv.batchId, /^b[0-9a-f]+$/);
  assert.deepEqual(pv.rows.map((r) => r.tokenId), ['1', '2', '3']);
  assert.ok(pv.rows.every((r) => !('previewId' in r)));
  assert.deepEqual(pv.risks, ['新地址']);
  assert.equal(pv.skipped, 0);
});

test('预检：一次最多 10 个，其余计入 skipped；任何一个不过整批不过；没设地址直接报错', async () => {
  const { nb } = mk();
  const pv = await nb.preview({ address: '0xNFT', items: items(13) });
  assert.equal(pv.rows.length, MAX_PER_BATCH); assert.equal(pv.skipped, 3);
  await assert.rejects(mk({ failPreview: '2' }).nb.preview({ address: '0xNFT', items: items(3) }), /模拟没通过/);
  await assert.rejects(mk({}, '').nb.preview({ address: '0xNFT', items: items(1) }), /还没有设置 NFT 转出地址/);
  await assert.rejects(mk().nb.preview({ address: '0xNFT', items: [{ slot: 1, tokenId: 'abc' }] }), /没有要转出的 NFT/);
});

test('提交：逐个提交，遇到失败就停；批次只能提交一次；过期拒绝', async () => {
  const a = mk({ failSubmit: '2' });
  const pv = await a.nb.preview({ address: '0xNFT', items: items(3) });
  const r = await a.nb.submit({ batchId: pv.batchId });
  assert.equal(r.sent, 1); assert.equal(r.failed.tokenId, '2'); assert.deepEqual(a.part.submitted, ['p1'], '第 3 个不再发');
  await assert.rejects(a.nb.submit({ batchId: pv.batchId }), /预检已失效/);
  const b = mk();
  const pv2 = await b.nb.preview({ address: '0xNFT', items: items(1) });
  b.at(1_000 + 61_000);
  await assert.rejects(b.nb.submit({ batchId: pv2.batchId }), /过期/);
  assert.deepEqual(b.part.submitted, []);
});

test('NFT 转出被币安风控拦截时，换成说清原因的提示', async () => {
  const { nftRiskBlocked, NFT_BLOCKED_MSG } = await import('./participate.js');
  assert.equal(nftRiskBlocked(Object.assign(new Error('SERVICE_ERROR: Transaction risk is too high and has been rejected: blocked'), { baw: { error: { code: 351803 } } })), true);
  assert.equal(nftRiskBlocked(new Error('模拟没通过')), false);
  assert.match(NFT_BLOCKED_MSG, /与收款地址无关/);
});
