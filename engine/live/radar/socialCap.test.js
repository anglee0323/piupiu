// X 查询每日上限：到了就不再发请求，返回明确的提示；网络整个桩掉，不会动真实额度
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.CRAWLERHUB_API_KEY = 'test-key-not-real';
let calls = 0;
globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ tweets: [] }) }; };
const { socialInfo, setSocialDailyCap, socialStats } = await import('./social.js');

test('达到每日上限后不再发请求', async () => {
  setSocialDailyCap(20);
  const addr = (i) => '0x' + String(i).padStart(40, '0');
  for (let i = 1; i <= 12; i++) await socialInfo(addr(i), ['Some Project Name'], { force: true });   // 每个项目 2 次请求（地址 + 名字）
  assert.ok(calls <= 20, `请求数 ${calls} 不应超过上限 20`);
  const before = calls;
  const r = await socialInfo(addr(99), ['Another Project Name'], { force: true });
  assert.equal(calls, before);
  assert.match(String(r.error), /已达上限/);
  const st = socialStats();
  assert.equal(st.max, 20); assert.equal(st.capped, true);
});
