import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

// 隔离：walletSlots 把注册表写在 dataFile('wallets.json')（由 DATA_DIR 决定）。
// 这里换一个临时 DATA_DIR 再动态 import，测完恢复
const dir = mkdtempSync(join(tmpdir(), 'piupiu-slots-'));
process.env.DATA_DIR = dir;
const slots = await import('./walletSlots.js');
slots._reset?.();

test('首次自动创建 W1，slot 1 不带 profile（走 baw 默认位置）', () => {
  const l = slots.list();
  assert.equal(l.length, 1);
  assert.equal(l[0].slot, 1);
  assert.equal(slots.profileOf(1), null);
  assert.equal(slots.primary(), 1);
  assert.equal(Object.keys(slots.bawEnvOf(1)).length, 0, 'W1 不加环境变量');
});

test('添加槽位：slot 号递增不复用，profile / 会话目录按槽位分', () => {
  const w2 = slots.add();
  assert.equal(w2.slot, 2);
  assert.equal(slots.profileOf(2), 'w2');
  const env = slots.bawEnvOf(2);
  assert.equal(env.PIUPIU_BAW_PROFILE, 'w2');
  assert.ok(env.BINANCE_BAW_DIR && env.BINANCE_BAW_DIR.includes(join('.piupiu', 'wallets', 'w2')));
  assert.equal(env.BINANCE_INSTANCE_ID, 'piupiu-w2');
  const w3 = slots.add();
  assert.equal(w3.slot, 3);
  slots.remove(3);
  assert.equal(slots.add().slot, 4, '移除后槽位号不复用（历史订单里的 W 号不换人）');
});

test('pin / byAddress / 主钱包 / 备注', () => {
  const A = '0x' + 'aa'.repeat(20);
  slots.pin(2, A);
  assert.equal(slots.byAddress(A).slot, 2);
  slots.update(2, { label: '小号' });
  assert.equal(slots.get(2).label, '小号');
  slots.update(2, { primary: true });
  assert.equal(slots.primary(), 2);
  slots.update(1, { primary: true });
  assert.equal(slots.primary(), 1);
});

test('移除最后一个槽位被拒绝', () => {
  slots.remove(2);
  slots.remove(4);
  assert.equal(slots.list().length, 1);
  assert.throws(() => slots.remove(1));
});

rmSync(dir, { recursive: true, force: true });
