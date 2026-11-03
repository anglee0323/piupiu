#!/usr/bin/env node
// 发版（只在发布者电脑上跑，签名私钥在 ~/.piupiu-release/release-key.pem，不进仓库）：
//   node scripts/release.mjs build                                  打安装包（Mac arm64 / x64 + Windows x64），输出到 ~/.piupiu-build/dist
//   node scripts/release.mjs core  [--notes "改了什么"] [--force]   内核（Gateway + 界面）：整理 → 打包 → 清单 → 签名
//   node scripts/release.mjs shell [--notes "改了什么"]             外壳：收集 desktop/dist 里的安装包 → 清单 → 签名 → 下载页
//   node scripts/release.mjs remanifest                             给已有清单补 moveTo（迁到 R2 下载地址）并重新签名，不重新打包
//   上传到更新服务器：在私有仓库 piupiu-cloud 里运行 node scripts/publish-release.mjs（服务器地址等只放在私有仓库）
// 版本号：内核 = 根目录 package.json，外壳 = desktop/package.json；发版前自己改（新版本号必须比服务器上的高）。
// 产物在 ~/.piupiu-build/release/：update/（core.json、core-*.tgz、shell.json，各带 .sig）、download/（安装包）、index.html（下载页）。
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DESK = join(ROOT, 'desktop');
const OUT = process.env.PIUPIU_RELEASE_OUT || join(homedir(), '.piupiu-build', 'release');   // 不放项目里：项目在 iCloud 同步的桌面上，几百 MB 的安装包会被同步
// 安装包输出目录放在不被 iCloud 同步的地方：项目在「桌面」时 iCloud 会给新文件打标记，codesign 会拒绝签名
const BUILD_OUT = process.env.PIUPIU_BUILD_OUT || join(homedir(), '.piupiu-build', 'dist');
const KEY = process.env.PIUPIU_RELEASE_KEY || join(homedir(), '.piupiu-release', 'release-key.pem');
const PUB = readFileSync(join(DESK, 'update-pubkey.pem'), 'utf8');
const deskPkg = JSON.parse(readFileSync(join(DESK, 'package.json'), 'utf8'));
const BASE = String(deskPkg.piupiu?.updateBase || '').replace(/\/?$/, '/');
// 签名清单里的 moveTo：客户端读到后把更新 / 下载地址迁到这里（Cloudflare R2，全球边缘分发，比单台服务器快得多）
const MOVE = String(deskPkg.piupiu?.moveTo || '').replace(/\/?$/, '/');
const SITE = String(deskPkg.piupiu?.site || BASE);   // 官网（下载页就在官网）；客户端的「去下载」打开它
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const sha256 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const cmpVer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1; return 0; };

function signFile(file) {
  if (!existsSync(KEY)) throw new Error(`没有签名私钥：${KEY}`);
  const bytes = readFileSync(file);
  const sig = sign(null, bytes, createPrivateKey(readFileSync(KEY, 'utf8'))).toString('base64');
  if (!verify(null, bytes, createPublicKey(PUB), Buffer.from(sig, 'base64'))) throw new Error('签名和 App 内置的公钥对不上（私钥换过？）');
  writeFileSync(`${file}.sig`, sig + '\n');
}
async function published(name) {
  try { const r = await fetch(`${BASE}update/${name}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) }); return r.ok ? await r.json() : null; } catch { return null; }
}

async function core() {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const cur = await published('core.json');
  if (cur && cmpVer(version, cur.version) <= 0 && !flag('--force')) throw new Error(`内核版本 ${version} 不比服务器上的 ${cur.version} 高：先改根目录 package.json 的 version`);
  execFileSync('npm', ['--prefix', 'web', 'run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  execFileSync(process.execPath, [join(DESK, 'stage.mjs')], { cwd: DESK, stdio: 'inherit' });
  mkdirSync(join(OUT, 'update'), { recursive: true });
  const file = `core-${version}.tgz`, tgz = join(OUT, 'update', file);
  execFileSync('tar', ['-czf', tgz, '-C', join(DESK, 'build'), 'gateway']);
  const m = { kind: 'core', version, file, sha256: sha256(tgz), size: statSync(tgz).size, minShell: opt('--min-shell') || '0.1.0', notes: opt('--notes') || '', publishedAt: new Date().toISOString(), ...(MOVE.length > 1 ? { moveTo: MOVE } : {}) };
  const mf = join(OUT, 'update', 'core.json');
  writeFileSync(mf, JSON.stringify(m, null, 1));
  signFile(mf);
  console.log(`内核 ${version}：${file}（${(m.size / 1048576).toFixed(1)} MB）已签名`);
}

function shell() {
  const version = deskPkg.version;
  const dist = BUILD_OUT;
  const files = existsSync(dist) ? readdirSync(dist) : [];
  const pick = (re) => files.find((f) => re.test(f) && f.includes(version));
  const assets = {
    mac: { arm64: pick(/-arm64\.dmg$/), x64: pick(/^Piupiu-[\d.]+\.dmg$/) },
    win: { x64: pick(/Setup-[\d.]+\.exe$/) },
  };
  mkdirSync(join(OUT, 'download'), { recursive: true }); mkdirSync(join(OUT, 'update'), { recursive: true });
  const m = { kind: 'shell', version, page: SITE, notes: opt('--notes') || '', publishedAt: new Date().toISOString(), ...(MOVE.length > 1 ? { moveTo: MOVE } : {}) };
  for (const [plat, arches] of Object.entries(assets)) for (const [arch, f] of Object.entries(arches)) {
    if (!f) { console.log(`  （没有 ${plat} ${arch} 安装包，跳过）`); continue; }
    copyFileSync(join(dist, f), join(OUT, 'download', f));
    (m[plat] ||= {})[arch] = { file: f, sha256: sha256(join(dist, f)), size: statSync(join(dist, f)).size };
  }
  if (!m.mac && !m.win) throw new Error(`${dist} 里没有 ${version} 的安装包：先 node scripts/release.mjs build`);
  const mf = join(OUT, 'update', 'shell.json');
  writeFileSync(mf, JSON.stringify(m, null, 1));
  signFile(mf);
  writeFileSync(join(OUT, 'index.html'), page(m));
  console.log(`外壳 ${version}：${Object.entries(m).filter(([k]) => k === 'mac' || k === 'win').map(([k, v]) => `${k} ${Object.keys(v).join('/')}`).join('，')} 已签名，下载页已生成`);
}

function page(m) {
  // 下载链接指向 moveTo（R2），页面本身仍可放在旧服务器上
  const a = (plat, arch) => m[plat]?.[arch] ? `${m.moveTo || ''}download/${m[plat][arch].file}` : null;
  const btn = (href, label, sub) => href ? `<a class="btn" href="${href}">${label}<span>${sub}</span></a>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Piupiu 下载</title>
<style>body{margin:0;background:#121212;color:#f5f5f5;font:15px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}main{max-width:720px;margin:0 auto;padding:56px 24px}
h1{font-size:30px;margin:0 0 4px}.ver{color:#808080}.btns{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:28px 0}
.btn{display:block;padding:16px 18px;border-radius:10px;background:#1f1f1f;color:#f5f5f5;text-decoration:none;font-weight:600}.btn:hover{background:#2a2a2a}.btn span{display:block;font-weight:400;font-size:13px;color:#808080}
h2{font-size:17px;margin:32px 0 6px}li{color:#ccc}code{background:#1f1f1f;padding:1px 6px;border-radius:4px}.note{color:#808080;font-size:13px}</style></head><body><main>
<h1>Piupiu</h1><div class="ver">客户端 ${m.version}${m.notes ? ` · ${m.notes.replace(/</g, '&lt;')}` : ''}</div>
<div class="btns">${btn(a('mac', 'arm64'), 'macOS（Apple 芯片）', 'M1 / M2 / M3 / M4')}${btn(a('mac', 'x64'), 'macOS（Intel 芯片）', '2020 年及以前的大部分 Mac')}${btn(a('win', 'x64'), 'Windows', 'Windows 10 / 11，64 位')}</div>
<h2>第一次打开</h2><ul>
<li><b>macOS</b>：把 Piupiu 拖进「应用程序」。第一次打开如果提示「无法验证开发者」，在「系统设置 → 隐私与安全性」底部点「仍要打开」，或者在「应用程序」里右键 Piupiu 选「打开」。</li>
<li><b>Windows</b>：如果出现「Windows 已保护你的电脑」，点「更多信息」→「仍要运行」。</li>
<li>打开后按「使用前检查」的提示，用币安 App 扫码登录你的 Agentic 钱包。</li></ul>
<h2>更新</h2><ul><li>交易功能和界面的更新会自动下载，底栏出现「重启更新」时点一下即可。</li><li>客户端本身的更新：Windows 自动安装；macOS 底栏会提示，回到这个页面下载新版覆盖安装。</li></ul>
<p class="note">钱包登录只保存在你自己的电脑上，交易由币安钱包签名；Piupiu 拿不到你的私钥。所有更新都经过发布者签名校验。</p>
</main></body></html>`;
}


// 不重新打包，只给已有的清单补上 moveTo 并重新签名（内核包 / 安装包的校验值不变），同时重生成下载页
function remanifest() {
  if (MOVE.length <= 1) throw new Error('desktop/package.json 的 piupiu.moveTo 没有配置');
  for (const name of ['core.json', 'shell.json']) {
    const f = join(OUT, 'update', name);
    if (!existsSync(f)) continue;
    const m = JSON.parse(readFileSync(f, 'utf8')); m.moveTo = MOVE;
    writeFileSync(f, JSON.stringify(m, null, 1)); signFile(f);
    if (name === 'shell.json') writeFileSync(join(OUT, 'index.html'), page(m));
    console.log(`${name}：版本 ${m.version}，更新与下载地址迁到 ${MOVE}，已重新签名`);
  }
}

function build() {
  execFileSync('npm', ['--prefix', 'web', 'run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  execFileSync(process.execPath, [join(DESK, 'stage.mjs')], { cwd: DESK, stdio: 'inherit' });
  execFileSync(join(DESK, 'node_modules', '.bin', 'electron-builder'), ['--mac', '--win', '--publish', 'never', `-c.directories.output=${BUILD_OUT}`], { cwd: DESK, stdio: 'inherit' });
  // 冒烟：用打好的 Mac 安装包（在项目目录外，借不到项目的 node_modules）跑一遍 desktop/ci-smoke.mjs
  const app = join(BUILD_OUT, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Piupiu.app', 'Contents');
  if (process.platform === 'darwin') execFileSync(process.execPath, [join(DESK, 'ci-smoke.mjs'), join(app, 'MacOS', 'Piupiu'), join(app, 'Resources')], { stdio: 'inherit' });
  console.log(`安装包在 ${BUILD_OUT}`);
}

const cmd = args[0];
try {
  if (cmd === 'build') build();
  else if (cmd === 'core') await core();
  else if (cmd === 'shell') shell();
  else if (cmd === 'remanifest') remanifest();
  else if (cmd === 'publish') { console.log('上传已移到私有仓库：cd ../piupiu-cloud && node scripts/publish-release.mjs'); process.exit(1); }
  else { console.log('用法：node scripts/release.mjs build|core|shell [--notes "…"] [--force]'); process.exit(1); }
} catch (e) { console.error(`发版失败：${e.message}`); process.exit(1); }
