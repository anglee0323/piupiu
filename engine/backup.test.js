// 每日备份：只含该备份的文件、排除缓存和访问令牌、同一天只生成一份、只保留最近 N 份
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupOnce, listBackups } from './backup.js';

const mk = () => {
  const root = mkdtempSync(join(tmpdir(), 'piupiu-backup-test-')), data = join(root, 'data'), out = join(root, 'backups');
  mkdirSync(join(data, 'img'), { recursive: true }); mkdirSync(join(data, 'radar', 'social'), { recursive: true });
  writeFileSync(join(data, 'orders.jsonl'), '{"a":1}\n'); writeFileSync(join(data, 'prefs.json'), '{}'); writeFileSync(join(data, 'radar', 'mints.jsonl'), '{"id":"m"}\n');
  writeFileSync(join(data, 'api-token'), 'secret'); writeFileSync(join(data, 'img', 'a.png'), 'x'); writeFileSync(join(data, 'radar', 'social', '0x1.json'), '{}'); writeFileSync(join(data, 'rpc-usage.jsonl'), '{}\n');
  return { data, out };
};

test('备份内容：重要文件在，缓存 / 令牌 / 日志不在', async () => {
  const { data, out } = mk();
  const f = await backupOnce({ dataDir: data, outDir: out, now: new Date(2026, 9, 29) });
  assert.ok(f && existsSync(f));
  const list = execFileSync('tar', ['-tzf', f]).toString();
  for (const keep of ['orders.jsonl', 'prefs.json', 'radar/mints.jsonl']) assert.match(list, new RegExp(keep.replace('/', '\\/')));
  for (const skip of ['api-token', 'img/', 'radar/social', 'rpc-usage']) assert.doesNotMatch(list, new RegExp(skip));
});
test('同一天只生成一份；只保留最近 N 份', async () => {
  const { data, out } = mk();
  assert.ok(await backupOnce({ dataDir: data, outDir: out, keep: 2, now: new Date(2026, 9, 27) }));
  assert.equal(await backupOnce({ dataDir: data, outDir: out, keep: 2, now: new Date(2026, 9, 27) }), null);   // 同一天
  await backupOnce({ dataDir: data, outDir: out, keep: 2, now: new Date(2026, 9, 28) });
  await backupOnce({ dataDir: data, outDir: out, keep: 2, now: new Date(2026, 9, 29) });
  assert.deepEqual(listBackups(out), ['piupiu-data-2026-10-29.tar.gz', 'piupiu-data-2026-10-28.tar.gz']);
});
