// gang.fun 押金承诺：接口字段 → 页面结构，颜色档位和 gang.fun 一致
import test from 'node:test';
import assert from 'node:assert/strict';
import { bondView } from './gangBond.js';

const base = { token: '0xT', creator: '0xC', quote: '0xbb4c', state: 'active', phase: 'running', amount: '1000000000000000000', holdAmount: '10000000000000000000000000', durationSec: 604800, quoteTrusted: true, holdOfBalanceBps: 10000, postedValueBnb: '1000000000000000000', live: true, violated: false };

test('覆盖率 ≥100% 且合格：绿色全覆盖；持有量换算成总量百分比', () => {
  const b = bondView({ ...base, coverageBps: 22193 });
  assert.equal(b.tier, 'full'); assert.equal(b.holdPct, 1); assert.equal(b.days, 7); assert.equal(b.valueBnb, 1); assert.equal(b.coveragePct, 221.93);
});
test('50–100%：黄色；低于 50%：灰色', () => {
  assert.equal(bondView({ ...base, coverageBps: 6000 }).tier, 'bond');
  assert.equal(bondView({ ...base, coverageBps: 4000 }).tier, 'gray');
});
test('开盘前（pending）没有覆盖率：灰色；报价币不在白名单或 X 少于持仓一半：灰色', () => {
  assert.equal(bondView({ ...base, phase: 'pending', coverageBps: null }).tier, 'gray');
  assert.equal(bondView({ ...base, coverageBps: 20000, quoteTrusted: false }).tier, 'gray');
  assert.equal(bondView({ ...base, coverageBps: 20000, holdOfBalanceBps: 4000 }).tier, 'gray');
});
test('罚没 / 结清后不再有档位', () => { assert.equal(bondView({ ...base, state: 'slashed', coverageBps: 20000 }).tier, null); });
