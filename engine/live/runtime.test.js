// 安装版运行时依赖（engine/live/runtime.js）的单测：清单与锁定文件、报价脚本校验、baw 查找顺序。
// 涉及安装版常量的用例在干净环境的子进程里跑（PIUPIU_APP=1 + 临时用户目录），全部用假文件，不联网、不碰币安钱包。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNTIME = fileURLToPath(new URL('./runtime.js', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('./runtime/manifest.json', import.meta.url), 'utf8'));

test('清单：baw 白名单和多钱包钩子一致；锁定文件全部来自官方源且带校验值', () => {
  const hook = readFileSync(new URL('./baw-profile/hook.mjs', import.meta.url), 'utf8');
  const known = JSON.parse(/new Set\((\[[^\]]*\])\)/.exec(hook)[1].replace(/'/g, '"'));
  assert.deepEqual([...known].sort(), [...manifest.baw.supported].sort(), 'hook.mjs 的 KNOWN 要和 manifest.baw.supported 一致');
  assert.ok(manifest.baw.supported.includes(manifest.baw.version));
  const lock = JSON.parse(readFileSync(new URL('./runtime/baw/package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.packages['node_modules/@binance/agentic-wallet'].version, manifest.baw.version, '锁定文件的 baw 版本要和 manifest 一致（升级时重新生成）');
  for (const [k, v] of Object.entries(lock.packages)) {
    if (!k) continue;
    assert.ok(v.integrity, `${k} 缺校验值`);
    assert.match(v.resolved, /^https:\/\/registry\.npmjs\.org\//, `${k} 不是官方源`);
  }
  assert.match(manifest.fourScript.commit, /^[0-9a-f]{40}$/); assert.match(manifest.fourScript.sha256, /^[0-9a-f]{64}$/);
});

const child = (home, code, extraEnv = {}) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], {
  env: { PATH: extraEnv.PATH ?? '/nonexistent', HOME: process.env.HOME, PIUPIU_APP: '1', PIUPIU_HOME: home, ...extraEnv }, encoding: 'utf8',
}).trim().split('\n').pop());
const fakeBaw = (root, version) => {   // root/.../@binance/agentic-wallet/{package.json, dist/index.js}
  const pkg = join(root, 'node_modules', '@binance', 'agentic-wallet');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(pkg, 'dist', 'index.js'), '#!/usr/bin/env node\n');
  return join(pkg, 'dist', 'index.js');
};

test('Four 报价脚本：指纹不对的源丢弃，换下一个；指纹对上才写入', () => {
  const home = mkdtempSync(join(tmpdir(), 'piupiu-rt-'));
  try {
    const r = child(home, `
      const rt = await import(${JSON.stringify('file://' + RUNTIME)});
      const { createHash } = await import('node:crypto');
      const good = 'console.log(1)\\n';
      rt.MANIFEST.fourScript.sha256 = createHash('sha256').update(good).digest('hex');
      const seen = [];
      const fetchImpl = async (u) => { seen.push(new URL(u).host); const body = seen.length === 1 ? 'tampered' : good; return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(body).buffer } };
      const p = await rt.ensureFourScript({ fetchImpl });
      const fs = await import('node:fs');
      console.log(JSON.stringify({ seen, ok: rt.state.four.ok, saved: p && fs.readFileSync(p, 'utf8') === good }));`);
    assert.deepEqual(r.seen, ['raw.githubusercontent.com', 'cdn.jsdelivr.net']);
    assert.equal(r.ok, true); assert.equal(r.saved, true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('baw 查找：只用我们装在用户目录里的；用户全局装的（哪怕版本核对过）也不用；都没有返回空', () => {
  const home = mkdtempSync(join(tmpdir(), 'piupiu-rt-')), gdir = mkdtempSync(join(tmpdir(), 'piupiu-g-'));
  try {
    const code = `const rt = await import(${JSON.stringify('file://' + RUNTIME)}); const c = rt.resolveManagedBaw({ refresh: true }); console.log(JSON.stringify({ source: rt.state.baw.source, version: rt.state.baw.version, cli: c }))`;
    const bin = join(gdir, 'bin'); mkdirSync(bin);
    const g = fakeBaw(join(gdir, 'lib'), manifest.baw.supported[0]);
    if (process.platform !== 'win32') symlinkSync(g, join(bin, 'baw'));
    assert.equal(child(home, code, { PATH: bin }).source, null, '只有用户全局装的：不用它，需要自己装');
    fakeBaw(join(home, 'runtime', 'baw'), manifest.baw.version);
    const r = child(home, code, { PATH: bin });
    assert.equal(r.source, 'managed'); assert.ok(r.cli.startsWith(home), '用的是用户目录里自己装的那份');
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(gdir, { recursive: true, force: true }); }
});
