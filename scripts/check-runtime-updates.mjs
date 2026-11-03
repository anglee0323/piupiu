#!/usr/bin/env node
// 检查安装版运行时依赖（engine/live/runtime/manifest.json）上游有没有新版：
//   node scripts/check-runtime-updates.mjs              只检查、打印结论
//   node scripts/check-runtime-updates.mjs --write-four 把 Four 报价脚本的锁定提交 / 指纹更新到上游最新
//   node scripts/check-runtime-updates.mjs --write-baw  把 baw 锁定版本更新到 npm 最新（存储方式核对通过才写），并重新生成锁定文件
// 改完清单后：npm test（runtime.test.js 会核对清单 / 锁定文件 / 多钱包钩子白名单是否一致），发新版 App。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MF = fileURLToPath(new URL('../engine/live/runtime/manifest.json', import.meta.url));
const HOOK = fileURLToPath(new URL('../engine/live/baw-profile/hook.mjs', import.meta.url));
const LOCK_DIR = fileURLToPath(new URL('../engine/live/runtime/baw/', import.meta.url));
const m = JSON.parse(readFileSync(MF, 'utf8'));
const args = new Set(process.argv.slice(2));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const npm = (a, opts = {}) => execFileSync('npm', a, { encoding: 'utf8', ...opts }).trim();
let changed = false;

// ---------- Four 报价脚本 ----------
{
  const f = m.fourScript;
  const r = await fetch(`https://api.github.com/repos/${f.repo}/commits?path=${encodeURIComponent(f.path)}&per_page=1`, { headers: { 'user-agent': 'piupiu' } });
  const latest = (await r.json())[0]?.sha;
  if (!latest) console.log('Four 报价脚本：查不到上游提交（GitHub 接口限流？稍后再试）');
  else if (latest === f.commit) console.log(`Four 报价脚本：已是最新（${f.commit.slice(0, 10)}）`);
  else {
    const body = Buffer.from(await (await fetch(`https://raw.githubusercontent.com/${f.repo}/${latest}/${f.path}`)).arrayBuffer());
    console.log(`Four 报价脚本：上游有新提交 ${latest.slice(0, 10)}（当前锁定 ${f.commit.slice(0, 10)}），新指纹 ${sha256(body).slice(0, 16)}…`);
    console.log(`  看改动：https://github.com/${f.repo}/compare/${f.commit}...${latest}`);
    if (args.has('--write-four')) { Object.assign(f, { commit: latest, sha256: sha256(body) }); changed = true; console.log('  已写入清单'); }
    else console.log('  确认改动无误后加 --write-four 写入清单');
  }
}

// ---------- baw ----------
{
  const b = m.baw;
  const latest = npm(['view', b.package, 'version', '--registry', b.registries[0]]);
  if (latest === b.version) console.log(`baw：已是最新（${b.version}）`);
  else {
    console.log(`baw：npm 上有新版 ${latest}（当前锁定 ${b.version}）`);
    // 核对登录凭证的存法：多钱包隔离依赖「keytar('baw','agentSessionId') + BINANCE_BAW_DIR」，变了的话钩子不能直接放行
    const tmp = mkdtempSync(join(tmpdir(), 'baw-check-'));
    let storageOk = false;
    try {
      const tgz = npm(['pack', `${b.package}@${latest}`, '--registry', b.registries[0], '--silent'], { cwd: tmp }).split('\n').pop();
      execFileSync('tar', ['-xzf', tgz], { cwd: tmp });
      const src = readFileSync(join(tmp, 'package', 'dist', 'index.js'), 'utf8');
      storageOk = /agentSessionId/.test(src) && /BINANCE_BAW_DIR/.test(src) && /@github\/keytar/.test(src);
      console.log(`  登录凭证存法（keytar「agentSessionId」+ BINANCE_BAW_DIR）：${storageOk ? '没变' : '变了或找不到，需要人工核对多钱包钩子'}`);
    } catch (e) { console.log(`  下载 / 解包核对失败：${e.message}`); }
    finally { rmSync(tmp, { recursive: true, force: true }); }
    if (args.has('--write-baw')) {
      if (!storageOk) { console.log('  存法没核对通过，不写入'); process.exitCode = 1; }
      else {
        b.version = latest; if (!b.supported.includes(latest)) b.supported.push(latest);
        const pkgFile = join(LOCK_DIR, 'package.json'), pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
        pkg.dependencies[b.package] = latest; writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
        npm(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--registry', b.registries[0]], { cwd: LOCK_DIR });
        const hook = readFileSync(HOOK, 'utf8').replace(/const KNOWN = new Set\(\[[^\]]*\]\);/, `const KNOWN = new Set([${b.supported.map((v) => `'${v}'`).join(', ')}]);`);
        writeFileSync(HOOK, hook);
        changed = true;
        console.log(`  已写入清单、锁定文件，并把 ${latest} 加进多钱包钩子白名单`);
      }
    } else console.log('  加 --write-baw 自动核对并写入');
  }
}

if (changed) { writeFileSync(MF, JSON.stringify(m, null, 2) + '\n'); console.log('\n清单已更新：跑 npm test，然后发新版 App'); }
