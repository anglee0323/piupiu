import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOrderHistory } from './orderHistory.js';

test('恢复四笔成交，按时间倒序，并兼容旧日志的 at 和步骤格式', () => {
  const dir = mkdtempSync(join(tmpdir(), 'piupiu-orders-'));
  try {
    const file = join(dir, 'orders.jsonl');
    const rows = [1, 2, 3, 4].map((n) => ({ id: String(n), token: '0xtoken', status: 'filled', side: n % 2 ? 'buy' : 'sell', at: new Date(n * 1000).toISOString(), steps: ['成交'] }));
    writeFileSync(file, rows.map(JSON.stringify).join('\n'));
    const orders = readOrderHistory(file);
    assert.deepEqual(orders.map((o) => o.id), ['4', '3', '2', '1']);
    assert.equal(orders[0].ts, 4000);
    assert.deepEqual(orders[0].steps, [{ name: '成交' }]);
    assert.equal(readOrderHistory(file, 2).length, 2);
  } finally { rmSync(dir, { recursive: true }); }
});

test('重复更新只保留最终状态，坏行和不完整记录不影响有效订单', () => {
  const dir = mkdtempSync(join(tmpdir(), 'piupiu-orders-'));
  try {
    const file = join(dir, 'orders.jsonl');
    const order = { id: 'a', token: '0xtoken', ts: 1000, status: 'unknown' };
    writeFileSync(file, [JSON.stringify(order), '{bad', '{}', JSON.stringify({ ...order, status: 'filled' })].join('\n'));
    assert.deepEqual(readOrderHistory(file).map((o) => o.status), ['filled']);
    assert.deepEqual(readOrderHistory(join(dir, 'missing')), []);
    assert.throws(() => readOrderHistory(dir));
  } finally { rmSync(dir, { recursive: true }); }
});
