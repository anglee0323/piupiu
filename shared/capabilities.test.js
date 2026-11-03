// 受限功能开关 + 转出被拒的识别：界面和网关都按这里判断
import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPS } from './capabilities.js';
import { notInAddressBook, addressBookMsg } from '../engine/live/baw.js';

test('NFT 转出暂不可用时有给用户看的说明', () => {
  assert.equal(typeof CAPS.nftTransfer.available, 'boolean');
  if (!CAPS.nftTransfer.available) assert.match(CAPS.nftTransfer.note, /NFT/);
  assert.throws(() => { CAPS.nftTransfer.available = true; }, '开关不能在运行时被改掉');
});

test('收款地址不在地址簿：按错误码和英文原文都能认出，提示里带缩写地址和处理方法', () => {
  assert.equal(notInAddressBook({ baw: { error: { code: 351703 } } }), true);
  assert.equal(notInAddressBook(new Error('This transfer was blocked because the recipient address is not in your address book.')), true);
  assert.equal(notInAddressBook({ baw: { error: { code: 351803 } }, message: 'risk is too high' }), false);
  const m = addressBookMsg('0x213395d8e034d719Ec362d25B9D8C8DE970560c1');
  assert.match(m, /0x2133…60c1/); assert.match(m, /地址簿/); assert.match(m, /资产未发生变动/);
});
