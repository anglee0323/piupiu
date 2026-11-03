#!/usr/bin/env node
// 桌面版冒烟（CI 用，也能在本机跑）：用「已安装的 App 自带的 Node」启动它内置的 Gateway，模拟一台新电脑：
//   临时用户目录、只报价不下单、PATH 里没有 baw。检查：
//   1. /api/ping 能通（Gateway 在 App 自带的 Node 下能跑）
//   2. 自动安装币安钱包命令行（App 自带的 npm + 锁定文件）、下载并核对 Four 报价脚本
//   3. 用 App 自带的 Node + 垫片 + 多钱包钩子 + 凭证文件跑一次 baw wallet status：应该是「未登录」，不能是 unknown command / 报错
// 用法：node desktop/ci-smoke.mjs <App 可执行文件> <resources 目录>
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [exe, res] = process.argv.slice(2).map((p) => p && resolve(p));
if (!exe || !res || !existsSync(exe) || !existsSync(join(res, 'gateway', 'server.js'))) { console.error('用法：node desktop/ci-smoke.mjs <App 可执行文件> <resources 目录>'); process.exit(2); }
const home = mkdtempSync(join(tmpdir(), 'piupiu-smoke-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const env = {
  ...process.env, ELECTRON_RUN_AS_NODE: '1', PIUPIU_APP: '1', PIUPIU_HOME: home, PIUPIU_NPM_CLI: join(res, 'npm', 'bin', 'npm-cli.js'),
  PORT: String(port), HOST: '127.0.0.1', LIVE_TRADE: '0',
  PATH: process.platform === 'win32' ? `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}` : '/usr/bin:/bin',   // 模拟没装 Node / baw
};
const gw = spawn(exe, [join(res, 'gateway', 'server.js')], { cwd: join(res, 'gateway'), env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; gw.stdout.on('data', (d) => { out += d; }); gw.stderr.on('data', (d) => { out += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return r.json(); };
const fail = (m) => { console.error(`✗ ${m}\n---- Gateway 输出 ----\n${out.slice(-4000)}`); gw.kill(); process.exit(1); };
const ok = (m) => console.log(`✓ ${m}`);

try {
  let up = false;
  for (let i = 0; i < 90 && !up; i++) { await sleep(1000); try { up = (await get('/api/ping')).ok; } catch { /* 还没起来 */ } }
  if (!up) fail('Gateway 90 秒内没有起来');
  ok('Gateway 在 App 自带的 Node 下启动');
  let st = null;
  for (let i = 0; i < 120; i++) {
    st = await get('/api/setup?refresh=1');
    const s = Object.fromEntries(st.steps.map((x) => [x.key, x]));
    if (s.baw.ok === false || s.four?.ok === false) fail(`组件安装失败：baw=${s.baw.detail} four=${s.four?.detail}`);
    if (s.baw.ok && s.four?.ok) break;
    await sleep(2000);
  }
  const s = Object.fromEntries(st.steps.map((x) => [x.key, x]));
  if (!s.baw.ok) fail(`baw 没装好：${s.baw.detail}`);
  ok(`币安钱包命令行：${s.baw.detail}`);
  if (!s.four?.ok) fail(`Four 报价脚本没就绪：${s.four?.detail}`);
  ok('Four 报价脚本已下载并核对指纹');
  const token = readFileSync(join(home, 'data', 'api-token'), 'utf8').trim();
  const a = await (await fetch(`http://127.0.0.1:${port}/api/auth/check`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tmtn-token': token }, body: '{}' })).json();
  if (a.state !== 'logged_out' || /unknown command|Error/i.test(a.message || '')) fail(`baw wallet status 结果不对：${JSON.stringify(a).slice(0, 300)}`);
  ok(`baw 在 App 自带的 Node 下能跑（钩子 + 凭证文件），登录状态：${a.message || a.state}`);
  // 4. 扫码登录的起点：baw 要生成 secp256k1 密钥，Electron（BoringSSL）原本没有这条曲线（见 engine/live/baw-profile/ecdh-shim.mjs）。
  //    只请求二维码、随后取消，不扫码、不登录。网络不通（币安接口不可达）不算失败，只有加密相关的报错才算。
  const lr = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tmtn-token': token }, body: '{}' });
  const lt = await lr.text();
  await fetch(`http://127.0.0.1:${port}/api/auth/login-cancel`, { method: 'POST', headers: { 'x-tmtn-token': token } }).catch(() => {});
  if (/named curve|UNKNOWN_ERROR|unknown command|ERR_UNSUPPORTED|MODULE_NOT_FOUND/i.test(lt)) fail(`扫码登录起点报错：${lt.slice(0, 300)}`);
  ok(lr.ok ? '扫码登录起点正常（已生成密钥并取到二维码，随后取消）' : `扫码登录起点没有加密类报错（接口返回：${lt.slice(0, 120)}）`);
  console.log('桌面版冒烟全部通过');
} finally { gw.kill(); await sleep(1500); try { rmSync(home, { recursive: true, force: true }); } catch { /* Windows 上可能还占着 */ } }
