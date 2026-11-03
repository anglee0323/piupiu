// 打包整理的安全扫描必须拦住作者的私有文件（.env、data/、令牌、备份、本机技能目录）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scan } from './stage.mjs';

const mk = (files) => { const d = mkdtempSync(join(tmpdir(), 'stage-')); for (const f of files) { mkdirSync(join(d, f, '..'), { recursive: true }); writeFileSync(join(d, f), 'x'); } return d; };

test('干净的整理目录通过', () => {
  const d = mk(['gateway/server.js', 'gateway/engine/live/config.js', 'gateway/.env.example', 'gateway/node_modules/x/data/a.json']);
  try { scan(d); } finally { rmSync(d, { recursive: true, force: true }); }
});

for (const bad of ['gateway/.env', 'gateway/.env.local', 'gateway/data/prefs.json', 'gateway/data-test/x', 'gateway/backups/a.tgz', 'gateway/.agents/skills/x.mjs', 'gateway/engine/api-token', 'gateway/wallets/w2/baw/s.json']) {
  test(`拦住：${bad}`, () => {
    const d = mk(['gateway/server.js', bad]);
    try { assert.throws(() => scan(d), /不该有的文件/); } finally { rmSync(d, { recursive: true, force: true }); }
  });
}
