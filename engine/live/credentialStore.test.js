// 安装版登录凭证存文件（baw-profile/keytar-ns.mjs）+ W1 也走独立目录（walletSlots）+ 登录检查退避（authBackoff）的单测。
// 子进程里跑、全用临时目录；文件模式下绝不能加载钥匙串原生模块（PIUPIU_REAL_KEYTAR 指向不存在的路径，加载就会报错）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authBackoffMs, AUTH_MAX_MS } from './authBackoff.js';

const KEYTAR_NS = fileURLToPath(new URL('./baw-profile/keytar-ns.mjs', import.meta.url));
const SLOTS = fileURLToPath(new URL('./walletSlots.js', import.meta.url));
const run = (code, env) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: 'utf8' }).trim().split('\n').pop());

test('凭证文件：读写删都只动这一项，不加载钥匙串模块；文件 0600、目录 0700', () => {
  const d = mkdtempSync(join(tmpdir(), 'cred-'));
  const file = join(d, 'w1', 'baw', 'piupiu-credential.json');
  try {
    const r = run(`
      const k = (await import(${JSON.stringify('file://' + KEYTAR_NS)})).default;
      const out = { before: await k.getPassword('baw', 'agentSessionId') };
      await k.setPassword('baw', 'agentSessionId', 'sess-123');
      out.after = await k.getPassword('baw', 'agentSessionId');
      out.find = await k.findCredentials('baw');
      try { await k.getPassword('other', 'x'); out.otherOk = true } catch { out.otherOk = false }
      out.del = await k.deletePassword('baw', 'agentSessionId');
      out.gone = await k.getPassword('baw', 'agentSessionId');
      await k.setPassword('baw', 'agentSessionId', 'sess-456');
      console.log(JSON.stringify(out));`, { PIUPIU_KEYSTORE_FILE: file, PIUPIU_BAW_PROFILE: 'w1', PIUPIU_REAL_KEYTAR: '/nonexistent/keytar' });
    assert.equal(r.before, null); assert.equal(r.after, 'sess-123');
    assert.deepEqual(r.find, [{ account: 'agentSessionId', password: 'sess-123' }]);
    assert.equal(r.otherOk, false, '只允许 baw / agentSessionId');
    assert.equal(r.del, true); assert.equal(r.gone, null);
    if (process.platform !== 'win32') {
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(join(file, '..')).mode & 0o777, 0o700);
    }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('安装版：W1 也有独立的会话目录和凭证文件（在 App 用户目录里）；开发模式 W1 仍走默认位置', () => {
  const home = mkdtempSync(join(tmpdir(), 'slots-'));
  const code = `const s = await import(${JSON.stringify('file://' + SLOTS)}); console.log(JSON.stringify({ p1: s.profileOf(1), p2: s.profileOf(2), env1: s.bawEnvOf(1) }))`;
  try {
    const app = run(code, { PIUPIU_APP: '1', PIUPIU_HOME: home });
    assert.equal(app.p1, 'w1'); assert.equal(app.p2, 'w2');
    assert.ok(app.env1.BINANCE_BAW_DIR.startsWith(join(home, 'wallets', 'w1')), app.env1.BINANCE_BAW_DIR);
    assert.ok(app.env1.PIUPIU_KEYSTORE_FILE.startsWith(app.env1.BINANCE_BAW_DIR));
    const dev = run(code, { DATA_DIR: home });
    assert.equal(dev.p1, null); assert.deepEqual(dev.env1, {});
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('登录检查退避：偶发一次照常；连续失败翻倍，最长 5 分钟', () => {
  assert.equal(authBackoffMs(0), 0); assert.equal(authBackoffMs(1), 0);
  assert.equal(authBackoffMs(2), 20_000); assert.equal(authBackoffMs(3), 40_000);
  assert.equal(authBackoffMs(20), AUTH_MAX_MS);
});
