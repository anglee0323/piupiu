// Electron 里没有 secp256k1 曲线（baw 扫码登录会失败），用纯 JS 补上。这里强制安装补丁，和 Node 原生实现对照。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installSecp256k1Shim } from './ecdh-shim.mjs';

const crypto = createRequire(import.meta.url)('node:crypto');
const native = crypto.createECDH;
const nativeOk = (() => { try { native('secp256k1'); return true; } catch { return false; } })();

test('补丁版 secp256k1：公钥格式和 baw 的用法一致，且和 Node 原生结果相同', { skip: !nativeOk && '本环境没有原生 secp256k1，无法对照' }, async () => {
  await installSecp256k1Shim({ force: true });
  try {
    assert.notEqual(crypto.createECDH, native);
    const e = crypto.createECDH('secp256k1');
    assert.throws(() => e.getPublicKey('hex', 'compressed'));
    e.generateKeys();
    const pub = e.getPublicKey('hex', 'compressed');
    assert.match(pub, /^0[23][0-9a-f]{64}$/);
    assert.equal(e.getPrivateKey().length, 32);
    assert.equal(e.getPublicKey().length, 65);
    const o = native('secp256k1');
    o.setPrivateKey(e.getPrivateKey());
    assert.equal(o.getPublicKey('hex', 'compressed'), pub);
    assert.equal(o.getPublicKey('hex'), e.getPublicKey('hex'));
    const a = crypto.createECDH('secp256k1'), b = crypto.createECDH('secp256k1');
    a.generateKeys(); b.generateKeys();
    assert.equal(a.computeSecret(b.getPublicKey()).toString('hex'), b.computeSecret(a.getPublicKey()).toString('hex'));
    const p = crypto.createECDH('prime256v1'); p.generateKeys();
    assert.equal(p.getPublicKey().length, 65);
  } finally { crypto.createECDH = native; }
});

test('原生已支持时不打补丁', { skip: !nativeOk && '本环境没有原生 secp256k1' }, async () => {
  assert.equal(await installSecp256k1Shim(), false);
  assert.equal(crypto.createECDH, native);
});
