// 历史恢复的单测：坏行、重复更新、日志顺序异常、NFT 数量与笔数、转出与失败分开统计
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMintHistory, summarize, nftCount } from './mintHistory.js';

const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20);
const line = (o) => JSON.stringify(o) + '\n';

test('同一个 id 保留最后一次状态；坏行和不完整记录不影响其他记录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mints-'));
  const f = join(dir, 'mints.jsonl');
  writeFileSync(f, [
    line({ id: 'm1', ts: 1000, address: A, symbol: 'AAA', status: 'sending' }),
    line({ id: 'm1', ts: 1000, address: A, symbol: 'AAA', status: 'broadcast', tx: '0x1' }),
    line({ id: 'm1', ts: 1000, address: A, symbol: 'AAA', status: 'done', tx: '0x1', got: [{ std: '721', id: '5' }] }),
    line({ id: 'm2', ts: 2000, address: B, symbol: 'BBB', status: 'done', got: [{ std: '1155', amount: '3' }] }),
    '{坏行\n',
    line({ id: 'm3', address: 'not-an-address', status: 'done' }),
    line({ id: 'm4', ts: 3000, address: A, symbol: 'AAA', status: 'failed', reason: 'reverted' }),
  ].join(''));
  const list = readMintHistory(f);
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((r) => r.id), ['m4', 'm2', 'm1']);
  assert.equal(list.find((r) => r.id === 'm1').status, 'done');
  assert.equal(list.find((r) => r.id === 'm1').tx, '0x1');
});

test('日志顺序异常：成功记录不会被后面的「发送中」顶掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mints-'));
  const f = join(dir, 'mints.jsonl');
  writeFileSync(f, line({ id: 'm1', ts: 1000, address: A, status: 'done', got: [{ std: '721', id: '1' }] }) + line({ id: 'm1', ts: 1000, address: A, status: 'sending' }));
  assert.equal(readMintHistory(f)[0].status, 'done');
});

test('没有文件时返回空数组，不抛错', () => {
  assert.deepEqual(readMintHistory('/tmp/definitely-missing-' + Date.now() + '.jsonl'), []);
});

test('NFT 数量：721 每个 1，1155 按数量，代币不算；只有成功的铸造记录算', () => {
  assert.equal(nftCount({ status: 'done', got: [{ std: '721', id: '1' }] }), 1);
  assert.equal(nftCount({ status: 'done', got: [{ std: '1155', amount: '5' }, { std: '1155', amount: '2' }] }), 7);
  assert.equal(nftCount({ status: 'done', kind: 'transfer' }), 0);
  assert.equal(nftCount({ status: 'failed', got: [{ std: '721' }] }), 0);
  assert.equal(nftCount({ status: 'done', got: [{ std: '20', amount: '1000' }] }), 0);
});

test('按地址汇总：铸造笔数 / NFT 个数 / 转出 / 失败分开，最近时间取最大', () => {
  const s = summarize([
    { address: A, ts: 1, status: 'done', got: [{ std: '1155', amount: '3' }] },
    { address: A, ts: 2, status: 'done', got: [{ std: '721', id: '9' }] },
    { address: A, ts: 3, status: 'failed' },
    { address: A, ts: 4, kind: 'transfer', status: 'transferred', tokenId: '9' },
    { address: B, ts: 5, status: 'failed' },
  ]).get(A);
  assert.equal(s.mintTx, 2);
  assert.equal(s.nft, 4);
  assert.equal(s.failed, 1);
  assert.equal(s.transfers, 1);
  assert.equal(s.lastAt, 4);
  assert.equal(summarize([{ address: B, ts: 5, status: 'failed' }]).get(B).mintTx, 0, '失败不算铸造');
});
