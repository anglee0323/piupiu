// 交易手续费：只用临时账本和桩掉的发送函数，不碰 baw / 真实数据
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { Fees, feeFor, FEE_MIN_WEI } from './fees.js';

const C = '0x' + '12'.repeat(20), A = '0x' + '34'.repeat(20);
const mk = (o = {}) => {
  const file = join(mkdtempSync(join(tmpdir(), 'fees-')), 'fees.jsonl');
  const sent = [];
  const f = new Fees({ enabled: true, contract: C, file, send: async (x) => { sent.push(x); return '0xtx' + sent.length; }, wallet: () => ({ address: A, bnb: 1 }), ...o });
  return { f, sent, file };
};
const due = (f, id, bnb, side = 'buy') => f.accrue({ id, slot: 1, address: A, side, symbol: 'X', baseBnb: bnb, feeWei: feeFor(bnb) });

test('费率 0.5%；手续费不足 0.00002 BNB 不收', () => {
  assert.equal(feeFor(0.1), ethers.parseEther('0.0005'));
  assert.equal(feeFor(0.004), FEE_MIN_WEI, '0.004 BNB 正好到门槛');
  assert.equal(feeFor(0.0039), 0n, '更小的不收');
  assert.equal(feeFor(0), 0n);
  assert.equal(feeFor(NaN), 0n);
});

test('没配置收款合约 / 没开启 = 不收', () => {
  assert.equal(new Fees({ enabled: true, contract: '', file: '/nonexistent/x' }).enabled, false);
  const { f } = mk({ enabled: false });
  assert.equal(f.buyFee(1), 0n);
  assert.equal(due(f, 'a', 1), 0n);
});

test('应付按订单去重；空闲时合并成一笔 pay(ref) 付掉；账本只追加', async () => {
  const { f, sent, file } = mk();
  assert.equal(due(f, 'o1', 0.1), ethers.parseEther('0.0005'));
  assert.equal(due(f, 'o1', 0.1), 0n, '同一订单不重复记');
  due(f, 'o2', 0.2, 'sell');
  const tx = await f.pay(1);
  assert.equal(tx, '0xtx1');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, C);
  assert.equal(sent[0].valueWei, ethers.parseEther('0.0015').toString(), '两笔合并');
  const [ref] = new ethers.Interface(['function pay(bytes32)']).decodeFunctionData('pay', sent[0].inputData);
  assert.equal(ref, ethers.id('o1,o2'));
  assert.equal(await f.pay(1), null, '付清后不再付');
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.t), ['due', 'due', 'paid']);
  const s = f.summary();
  assert.equal(s.paidBnb, 0.0015); assert.equal(s.owedBnb, 0); assert.equal(s.recent.length, 2); assert.ok(s.recent.every((r) => r.paid));
});

test('钱包在下单 / 余额不够时不付，等以后再付', async () => {
  let busy = true;
  const { f, sent } = mk({ busy: () => busy, wallet: () => ({ address: A, bnb: 0.0001 }) });
  due(f, 'o1', 0.1);
  assert.equal(await f.pay(1), null); assert.equal(sent.length, 0, '下单中不付');
  busy = false;
  assert.equal(await f.pay(1), null); assert.equal(sent.length, 0, '余额不够付手续费 + 网络费时不付');
  assert.equal(f.summary().owedBnb, 0.0005);
});

test('付款失败：记 fail，下次重试；重启后从账本恢复未付', async () => {
  let fail = true;
  const { f, file } = mk({ send: async () => { if (fail) throw Object.assign(new Error('需要在币安 App 里确认'), { code: 'APP_CONFIRM' }); return '0xok'; } });
  const notices = []; f.onNotice = (n) => notices.push(n);
  due(f, 'o1', 1);
  assert.equal(await f.pay(1), null);
  assert.equal(notices.length, 1);
  const f2 = new Fees({ enabled: true, contract: C, file, send: async () => '0xok', wallet: () => ({ address: A, bnb: 1 }) });
  assert.equal(f2.summary().owedBnb, 0.005, '重启后未付的还在');
  fail = false;
  assert.equal(await f2.pay(1), '0xok');
  assert.equal(f2.summary().owedBnb, 0);
  for (const t of [...f.timers.values(), ...f2.timers.values()]) clearTimeout(t);
});

test('LiveTrader.chargeFee：买入用下单前扣出的数，卖出按换回的 BNB；只记一次', async () => {
  const { LiveTrader } = await import('./liveTrader.js');
  const { f } = mk();
  const ctx = { fees: f, wallets: [{ slot: 1, address: A }] };
  const buy = { id: 'b1', side: 'buy', walletSlot: 1, symbol: 'X', amount: 0.1, amountIn: 0.1, feeWei: ethers.parseEther('0.0005').toString(), feeable: true, status: 'filled' };
  LiveTrader.prototype.chargeFee.call(ctx, buy);
  assert.equal(buy.feeBnb, 0.0005);
  LiveTrader.prototype.chargeFee.call(ctx, buy);
  const sell = { id: 's1', side: 'sell', walletSlot: 1, symbol: 'X', amount: 100, out: 0.2, feeable: true, status: 'filled' };
  LiveTrader.prototype.chargeFee.call(ctx, sell);
  assert.equal(sell.feeBnb, 0.001);
  const tiny = { id: 's2', side: 'sell', walletSlot: 1, symbol: 'X', amount: 100, out: 0.001, feeable: true, status: 'filled' };
  LiveTrader.prototype.chargeFee.call(ctx, tiny);
  assert.equal(tiny.feeBnb, undefined, '小额卖出不收');
  const quote = { id: 's3', side: 'sell', walletSlot: 1, symbol: 'X', amount: 100, out: null, feeBaseBnb: 0.4, feeable: true, status: 'filled' };
  LiveTrader.prototype.chargeFee.call(ctx, quote);
  assert.equal(quote.feeBnb, 0.002, '所得留在计价代币里：按折算的 BNB 收');
  assert.equal(f.summary().owedBnb, 0.0035);
  for (const t of f.timers.values()) clearTimeout(t);
});
