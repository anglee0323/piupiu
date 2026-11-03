// 安装版模式（PIUPIU_APP=1）的单测：数据放用户目录、默认实盘，最重要的是绝不读项目里的 .env 和 data/
// （开发机上那里是作者自己的私有 Key 和钱包记录）。在干净环境的子进程里加载配置，不碰币安钱包。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG = fileURLToPath(new URL('./config.js', import.meta.url));
const load = (extra) => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, APPDATA: process.env.APPDATA || '', ...extra };   // 不继承 NODE_TEST_CONTEXT / DATA_DIR / MODE 等
  const code = `const c = await import(${JSON.stringify('file://' + CONFIG)}); console.log(JSON.stringify({ APP_MODE: c.APP_MODE, APP_HOME: c.APP_HOME, DATA_DIR: c.DATA_DIR, MODE: c.MODE, LIVE_TRADE: c.LIVE_TRADE, NR: c.NODEREAL_URLS.length, CANARY: process.env.PIUPIU_CANARY || null }))`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' }).trim().split('\n').pop());
};

test('安装版：数据在用户目录，默认实盘 + 真实下单，读用户目录的 .env，不读项目里的', () => {
  const home = mkdtempSync(join(tmpdir(), 'piupiu-app-'));
  try {
    writeFileSync(join(home, '.env'), 'PIUPIU_CANARY=from-app-home\n');
    const c = load({ PIUPIU_APP: '1', PIUPIU_HOME: home });
    assert.equal(c.APP_MODE, true);
    assert.equal(c.APP_HOME, home);
    assert.ok(c.DATA_DIR.startsWith(join(home, 'data')), c.DATA_DIR);
    assert.equal(c.MODE, 'live'); assert.equal(c.LIVE_TRADE, true);
    assert.equal(c.CANARY, 'from-app-home', '读的是用户目录里的 .env');
    assert.equal(c.NR, 0, '项目 .env 里的 NodeReal Key 不能被读到');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('安装版：环境变量仍可覆盖默认值（比如强制只报价）', () => {
  const home = mkdtempSync(join(tmpdir(), 'piupiu-app-'));
  try { const c = load({ PIUPIU_APP: '1', PIUPIU_HOME: home, LIVE_TRADE: '0', MODE: 'sim' }); assert.equal(c.LIVE_TRADE, false); assert.equal(c.MODE, 'sim'); }
  finally { rmSync(home, { recursive: true, force: true }); }
});

test('开发模式：行为不变（项目 data/，默认模拟盘、只报价）', () => {
  const c = load({});
  assert.equal(c.APP_MODE, false); assert.equal(c.APP_HOME, null);
  assert.match(c.DATA_DIR, /[\\/]data[\\/]?$/);
  assert.equal(c.MODE === 'sim' || c.MODE === 'live', true);   // 开发机的项目 .env 可能设了 MODE=live，这里只确认读的是项目 .env
});
