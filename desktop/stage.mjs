#!/usr/bin/env node
// 打包前整理：把 Gateway 运行需要的文件按白名单拷到 desktop/build/gateway，按锁定文件装生产依赖；
// App 自带的 npm（首次启动装币安钱包命令行用）拷到 desktop/build/npm。
// 白名单而不是黑名单：项目根目录里有作者自己的 .env（私有 Key）、data/（钱包记录、订单、设置）、.agents/（第三方技能）、
// backups/ 等，任何一个混进安装包都是事故。最后再扫一遍，发现敏感文件直接失败。
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(HERE, 'build');
const GW = join(OUT, 'gateway');

// 要的东西（相对项目根目录）
const INCLUDE = ['server.js', 'package.json', 'package-lock.json', 'engine', 'shared', 'public', 'web/dist', 'LICENSE', 'NOTICE', 'README.md'];
// 白名单目录里也不要的
const SKIP = (rel) => /\.test\.(js|mjs)$/.test(rel) || /(^|[\\/])\.DS_Store$/.test(rel);
// 最后的安全扫描：命中任何一条就失败
const FORBIDDEN = [
  { re: /(^|[\\/])\.env(\.|$)(?!example)/, why: '.env（私有 Key）' },
  { re: /(^|[\\/])data([\\/]|$)/, why: 'data/（钱包记录、订单、设置）' },
  { re: /(^|[\\/])data-[^\\/]+([\\/]|$)/, why: 'data-*/（其他实例的数据）' },
  { re: /(^|[\\/])backups?([\\/]|$)|-backups([\\/]|$)/, why: '备份' },
  { re: /(^|[\\/])\.agents([\\/]|$)|(^|[\\/])\.claude([\\/]|$)/, why: '本机 AI 技能目录' },
  { re: /(^|[\\/])wallets([\\/]|$)/, why: '额外钱包的登录配置' },
  { re: /api-token$|testnet-wallet\.json$|OPEN_SOURCE_CHECKLIST\.md$/, why: '令牌 / 私钥 / 私人清单' },
];

function main() {
  if (!existsSync(join(ROOT, 'web', 'dist', 'index.html'))) throw new Error('先构建网页：npm --prefix web run build');
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(GW, { recursive: true });
  for (const rel of INCLUDE) {
    const src = join(ROOT, rel);
    if (!existsSync(src)) { if (rel === 'LICENSE') continue; throw new Error(`缺少 ${rel}`); }
    cpSync(src, join(GW, rel), { recursive: true, filter: (s) => !SKIP(relative(ROOT, s)) });
  }
  // 生产依赖：按根目录锁定文件装（ethers / express / ws），不执行安装脚本
  // 用 desktop 依赖里的 npm（和 App 自带的是同一个）经 node 调用：Windows 上的 npm 是 .cmd 垫片，execFile 不能直接拉起
  const npmCli = join(HERE, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(npmCli)) throw new Error('desktop/node_modules/npm 不存在：先在 desktop/ 里 npm install');
  execFileSync(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: GW, stdio: 'inherit' });
  // 安装版标记写进 package.json，方便排查；启动器另外用环境变量 PIUPIU_APP=1
  const pkg = JSON.parse(readFileSync(join(GW, 'package.json'), 'utf8'));
  delete pkg.devDependencies; pkg.piupiuApp = true;
  writeFileSync(join(GW, 'package.json'), JSON.stringify(pkg, null, 1));
  // App 自带的 npm（MIT）：首次启动用它从官方源安装币安钱包命令行（engine/live/runtime.js）
  const npmSrc = join(HERE, 'node_modules', 'npm');
  cpSync(npmSrc, join(OUT, 'npm'), { recursive: true });
  scan(OUT);
  console.log(`整理完成：${relative(ROOT, OUT)}（Gateway ${size(GW)}，npm ${size(join(OUT, 'npm'))}）`);
}

function* walk(dir) { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) { yield p + sep; yield* walk(p); } else yield p; } }
export function scan(dir) {
  const bad = [];
  for (const p of walk(dir)) {
    const rel = relative(dir, p);
    if (rel.includes(`node_modules${sep}`) && !/api-token|\.env/.test(rel)) continue;   // 依赖包内部的目录名（如某些包自带 data/）不算
    for (const f of FORBIDDEN) if (f.re.test(rel)) bad.push(`${rel}（${f.why}）`);
  }
  if (bad.length) { if (dir === OUT) rmSync(OUT, { recursive: true, force: true }); throw new Error(`安装包里混进了不该有的文件，已中止：\n  ${bad.slice(0, 20).join('\n  ')}`); }
}
function size(dir) { let n = 0; for (const p of walk(dir)) if (!p.endsWith(sep)) n += statSync(p).size; return `${(n / 1048576).toFixed(1)} MB`; }

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) { try { main(); } catch (e) { console.error(`整理失败：${e.message}`); process.exit(1); } }
