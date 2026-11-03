// 一键直铸的服务端闸：开关、免费、无风险提示、每天上限；不满足时预检不作废（页面可退回普通确认）。
// 测试环境是演示模式：所有校验通过后会停在「演示模式不会真实参与」，说明没被拦；绝不会发出真实交易。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'quickmint-'));   // 不读 / 不写真实的 data/radar/mints.jsonl
process.env.LIVE_TRADE = '0';                                       // 强制演示模式（.env 里是 1）；另外 baw.js 在测试进程里本来就拒绝一切调用
const { Participate } = await import('./participate.js');

const A = '0x' + 'aa'.repeat(20);
const mk = (settings) => { const p = new Participate({ trader: null, provider: {}, getAnalysis: () => null, settings: () => settings, emit() {}, log() {} }); p.send = async () => { throw new Error('测试里不应该走到真正的发送'); }; return p; };
const preview = (p, rows, id = 'p1') => { p.previews.set(id, { id, address: A, qty: 1, at: Date.now(), rows, fn: 'mint', symbol: 'T' }); return id; };
const row = (o = {}) => ({ slot: 1, address: '0x' + '11'.repeat(20), ok: true, valueWei: '0', risks: [], ...o });

test('开关没开：quick 被拒绝，预检保留', async () => {
  const p = mk({ quickMint: false, quickMintMax: 30 }); const id = preview(p, [row()]);
  await assert.rejects(p.submit({ previewId: id, quick: true }), /未开启一键直铸/);
  assert.ok(p.previews.has(id));
});
test('要付费的：quick 被拒绝，预检保留', async () => {
  const p = mk({ quickMint: true, quickMintMax: 30 }); const id = preview(p, [row({ valueWei: '1000' })]);
  await assert.rejects(p.submit({ previewId: id, quick: true }), /免费/);
  assert.ok(p.previews.has(id));
});
test('币安钱包有风险提示：quick 被拒绝', async () => {
  const p = mk({ quickMint: true, quickMintMax: 30 }); const id = preview(p, [row({ risks: ['可疑合约'] })]);
  await assert.rejects(p.submit({ previewId: id, quick: true }), /风险提示/);
});
test('超过每天上限：quick 被拒绝', async () => {
  const p = mk({ quickMint: true, quickMintMax: 2 });
  p.byId.set('m1', { id: 'm1', quick: true, ts: Date.now() }); p.byId.set('m2', { id: 'm2', quick: true, ts: Date.now() });
  const id = preview(p, [row()]);
  await assert.rejects(p.submit({ previewId: id, quick: true }), /上限 2 次/);
});
test('昨天的和普通铸造不算今天的一键直铸次数', async () => {
  const p = mk({ quickMint: true, quickMintMax: 1 });
  p.byId.set('m1', { id: 'm1', quick: true, ts: Date.now() - 36 * 3600_000 }); p.byId.set('m2', { id: 'm2', ts: Date.now() });
  assert.equal(p.quickToday(), 0);
  const id = preview(p, [row()]);
  await assert.rejects(p.submit({ previewId: id, quick: true }), /演示模式/);   // 校验全过，停在演示模式这道闸
});
test('不带 quick 的普通提交不受开关影响（页面已经让用户确认过）', async () => {
  const p = mk({ quickMint: false }); const id = preview(p, [row({ valueWei: '1000' })]);
  await assert.rejects(p.submit({ previewId: id }), /演示模式/);
});

// ---------- 自动铸造（auto）：同样的服务端闸，另加开关、自己的每日上限、需要币安 App 确认的不提交 ----------
test('自动铸造：开关没开、要付费、有风险提示、需要 App 确认、超过每日上限都拒绝', async () => {
  const on = { autoMint: true, autoMintMax: 10 };
  let p = mk({ autoMint: false }); await assert.rejects(p.submit({ previewId: preview(p, [row()]), auto: true }), /未开启自动铸造/);
  p = mk(on); await assert.rejects(p.submit({ previewId: preview(p, [row({ valueWei: '5' })]), auto: true }), /仅适用于免费/);
  p = mk(on); await assert.rejects(p.submit({ previewId: preview(p, [row({ risks: ['可疑'] })]), auto: true }), /风险提示/);
  p = mk(on); await assert.rejects(p.submit({ previewId: preview(p, [row({ needAppConfirm: true })]), auto: true }), /币安 App 中确认/);
  p = mk({ autoMint: true, autoMintMax: 1 }); p.byId.set('m1', { id: 'm1', auto: true, ts: Date.now() });
  await assert.rejects(p.submit({ previewId: preview(p, [row()]), auto: true }), /上限 1 次/);
  assert.equal(p.quickToday(), 0, '自动铸造不占一键直铸的次数');
});
test('自动铸造：全部校验通过后停在演示模式（测试里不会真实发送）', async () => {
  const p = mk({ autoMint: true, autoMintMax: 10 });
  await assert.rejects(p.submit({ previewId: preview(p, [row()]), auto: true }), /演示模式/);
});
