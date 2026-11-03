import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanName } from './liveMarket.js';
test('代币名字：去掉网页标签和控制字符，清完为空用备用文字', () => {
  assert.equal(cleanName('<img src=x onerror=alert(1)>', '0xabcd'), '0xabcd');
  assert.equal(cleanName('PEPE <b>2</b>'), 'PEPE 2');
  assert.equal(cleanName('帕鲁.ai'), '帕鲁.ai');
  assert.equal(cleanName('A\u202eB\n C'), 'AB C');
  assert.equal(cleanName(null, '?'), '?');
});
