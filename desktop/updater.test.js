// 自动更新核心逻辑（updater.cjs）的单测：验签、防降级的版本比较、选哪个内核、坏版本退回
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const up = createRequire(import.meta.url)('./updater.cjs');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PRIV = privateKey.export({ type: 'pkcs8', format: 'pem' }), PUB = publicKey.export({ type: 'spki', format: 'pem' });
const coreManifest = (o = {}) => Buffer.from(JSON.stringify({ kind: 'core', version: '3.1.1', file: 'core-3.1.1.tgz', sha256: 'a'.repeat(64), size: 10, ...o }));

test('版本比较', () => {
  assert.equal(up.cmpVer('3.1.10', '3.1.9'), 1);
  assert.equal(up.cmpVer('3.1.0', '3.1.0'), 0);
  assert.equal(up.cmpVer('0.1.0', '0.2.0'), -1);
});

test('清单验签：签名对才收；被改过、类型不对、缺字段都拒绝', () => {
  const b = coreManifest(), sig = up.sign(b, PRIV);
  assert.equal(up.verifyManifest(b, sig, PUB, 'core').version, '3.1.1');
  assert.throws(() => up.verifyManifest(coreManifest({ version: '9.9.9' }), sig, PUB, 'core'), /签名不对/);
  const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.throws(() => up.verifyManifest(b, up.sign(b, other), PUB, 'core'), /签名不对/, '别人的私钥签的不收');
  assert.throws(() => up.verifyManifest(b, sig, PUB, 'shell'), /类型不对/);
  const bad = coreManifest({ sha256: 'xyz' });
  assert.throws(() => up.verifyManifest(bad, up.sign(bad, PRIV), PUB, 'core'), /缺字段/);
});

const fakeCore = (dir, v) => { mkdirSync(join(dir, v), { recursive: true }); writeFileSync(join(dir, v, 'server.js'), ''); writeFileSync(join(dir, v, 'package.json'), JSON.stringify({ version: v })); };

test('选内核：待生效的新版先激活；比安装包自带的新才用；标坏的不用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'core-'));
  const pick = () => up.pickCore({ coreDir: dir, bundledDir: '/bundled', bundledVersion: '3.1.0' });
  try {
    assert.deepEqual(pick(), { dir: '/bundled', version: '3.1.0', ota: false }, '什么都没有：用自带的');
    fakeCore(dir, '3.1.1'); up.writeState(dir, { pending: '3.1.1' });
    assert.equal(pick().version, '3.1.1'); assert.equal(up.readState(dir).current, '3.1.1'); assert.equal(up.readState(dir).pending, undefined);
    up.writeState(dir, { current: '3.1.1' });
    assert.equal(up.pickCore({ coreDir: dir, bundledDir: '/b', bundledVersion: '3.2.0' }).ota, false, '新装的安装包自带更新的版本：用自带的');
    up.markGood(dir, '3.1.1'); fakeCore(dir, '3.1.2'); up.writeState(dir, { ...up.readState(dir), current: '3.1.2' });
    up.markBad(dir, '3.1.2');
    assert.equal(up.readState(dir).current, '3.1.1', '坏版本退回上一个跑起来过的');
    assert.equal(pick().version, '3.1.1');
    up.writeState(dir, { ...up.readState(dir), pending: '3.1.2' });
    assert.equal(pick().version, '3.1.1', '标坏的版本不会再被激活');
    up.cleanup(dir);
    assert.equal(existsSync(join(dir, '3.1.2')), false, '清理掉不用的版本');
    assert.equal(existsSync(join(dir, '3.1.1')), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- 下载：断点续传 ----------
const http = createRequire(import.meta.url)('node:http');
const crypto = createRequire(import.meta.url)('node:crypto');
const fs = createRequire(import.meta.url)('node:fs');
const path = createRequire(import.meta.url)('node:path');
const os = createRequire(import.meta.url)('node:os');
test('下载中途断开后从断点续传，进度连续，校验通过', async () => {
  const body = crypto.randomBytes(300_000), sha = crypto.createHash('sha256').update(body).digest('hex');
  let first = true; const ranges = [];
  const srv = http.createServer((req, res) => {
    const m = /bytes=(\d+)-/.exec(req.headers.range || ''); const from = m ? Number(m[1]) : 0; ranges.push(from);
    res.writeHead(m ? 206 : 200, { 'Content-Length': body.length - from, ...(m ? { 'Content-Range': `bytes ${from}-${body.length - 1}/${body.length}` } : {}) });
    if (first) { first = false; res.write(body.subarray(from, from + 100_000)); setTimeout(() => res.destroy(), 50); return; }   // 第一次只给三分之一就断开
    res.end(body.subarray(from));
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dl-')), dest = path.join(dir, 'f.bin');
  const seen = [];
  try {
    await up.downloadFile(`http://127.0.0.1:${srv.address().port}/f`, dest, { sha256: sha, size: body.length, onProgress: (g) => seen.push(g), wait: () => 10 });
    assert.ok(fs.readFileSync(dest).equals(body));
    assert.equal(ranges[0], 0); assert.ok(ranges[1] >= 100_000, `续传起点 ${ranges[1]}`);
    assert.ok(seen.every((g, i) => i === 0 || g >= seen[i - 1]), '进度不倒退');
    assert.ok(!fs.existsSync(`${dest}.part`));
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('校验值不对：丢弃并报错，不留下文件', async () => {
  const body = Buffer.from('hello');
  const srv = http.createServer((req, res) => res.end(body));
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dl-')), dest = path.join(dir, 'f.bin');
  try {
    await assert.rejects(up.downloadFile(`http://127.0.0.1:${srv.address().port}/f`, dest, { sha256: '0'.repeat(64), size: body.length, wait: () => 10 }), /校验值不对/);
    assert.ok(!fs.existsSync(dest) && !fs.existsSync(`${dest}.part`));
  } finally { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
