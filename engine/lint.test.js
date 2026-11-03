// 防回归：一行里「代码 + // 注释」，注释后面还跟着像对象字段的内容（key: 值 || / ?? / 调用 / 逗号）——
// 这说明有人把注释插在了对象字面量的中间，后面的字段会被一起注释掉。
// 2026-10-28 这样丢过代币摘要里的 gangDiv / gangV3 / gangFair / flapTax / nftGate / 简介 / 官网 / 推特 / 电报，一天没人发现。
// 注释请单独写一行。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));   // 不能用 .pathname：Windows 上会变成 /D:/… 再被拼成 D:\D:\…
const SKIP = new Set(['node_modules', 'dist', 'data', 'backups', '.git', '.agents', '.claude', 'docs']);
const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    if (SKIP.has(f) || f.startsWith('data-') || f.endsWith('-backups')) continue;
    const p = join(d, f), st = statSync(p);
    if (st.isDirectory()) walk(p); else if (/\.(js|mjs|ts|tsx)$/.test(f) && !/\.test\.js$/.test(f)) files.push(p);
  }
};
walk(ROOT);

export const suspicious = (line) => {
  const m = /^(.*[,{(\[][ \t]*)(\/\/.*)$/.exec(line);
  if (!m) return false;
  const code = m[1].trimEnd(), comment = m[2];
  if (!code.trim() || /(https?|wss?):$/.test(code) || !/[,{]$/.test(code) || !/\b\w+:\s/.test(code)) return false;
  return /\b[A-Za-z_]\w*:\s+[\w.]+(\(|\s*\|\||\s*\?\?|,)/.test(comment);
};

test('规则本身：能抓到当初的写法，不误伤普通注释', () => {
  assert.ok(suspicious("  a: 1, gangTrack: t.gangTrack || null,   // 反查 gangDiv: t.gangDiv || null, gangV3: t.gangV3 || null,"));
  assert.ok(!suspicious("  descriptor: '0x30',          // ITagDescriptor: (bytes8 tagId, string tag)"));
  assert.ok(!suspicious("  amount: f(d[6]), // buy: quote paid incl. fees; sell: quote received after fees"));
  assert.ok(!suspicious("  const url = 'https://x.y'; // 注释"));
});

test('源码里没有「对象字面量中间插注释」', () => {
  const hits = [];
  for (const f of files) readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (suspicious(l)) hits.push(`${f.replace(ROOT, '')}:${i + 1}: ${l.trim().slice(0, 140)}`); });
  assert.deepEqual(hits, [], `发现可疑的行中注释（注释要单独写一行）：\n${hits.join('\n')}`);
});
