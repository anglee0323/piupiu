// Electron 的 Node 用 BoringSSL，没有 secp256k1 曲线：baw 扫码登录时 createECDH('secp256k1') 会报
// 「UNKNOWN_ERROR: Failed to create key using named curve」。普通 Node（OpenSSL）没这个问题。
// baw 只用它生成一对临时密钥（把公钥发给币安，私钥之后不再使用），所以这里用纯 JS 的 @noble/curves 补上这一条曲线，
// 接口只实现 baw 和常见用法要的：generateKeys / setPrivateKey / getPrivateKey / getPublicKey / computeSecret。
// 其他曲线、以及本来就支持这条曲线的环境，一律走原来的实现。
import { createRequire, syncBuiltinESMExports } from 'node:module';

export async function installSecp256k1Shim({ force = false } = {}) {
  const require = createRequire(import.meta.url);
  const crypto = require('node:crypto');
  const orig = crypto.createECDH;
  if (!force) { try { orig('secp256k1'); return false; } catch { /* 不支持，往下补 */ } }
  const { secp256k1 } = await import('@noble/curves/secp256k1');
  const pick = (buf, enc) => (enc ? Buffer.from(buf).toString(enc) : Buffer.from(buf));
  const toBuf = (v, enc) => (typeof v === 'string' ? Buffer.from(v, enc || 'utf8') : Buffer.from(v));
  class Secp256k1ECDH {
    #priv = null;
    generateKeys(enc, format) { this.#priv = secp256k1.utils.randomPrivateKey(); return this.getPublicKey(enc, format); }
    setPrivateKey(v, enc) { const b = toBuf(v, enc); if (b.length !== 32) throw new RangeError('私钥必须是 32 字节'); this.#priv = new Uint8Array(b); }
    getPrivateKey(enc) { if (!this.#priv) throw new Error('ECDH 还没有生成密钥'); return pick(this.#priv, enc); }
    getPublicKey(enc, format) {
      if (!this.#priv) throw new Error('ECDH 还没有生成密钥');
      return pick(secp256k1.getPublicKey(this.#priv, format === 'compressed'), enc);
    }
    computeSecret(other, inEnc, outEnc) {
      if (!this.#priv) throw new Error('ECDH 还没有生成密钥');
      return pick(secp256k1.getSharedSecret(this.#priv, toBuf(other, inEnc), true).slice(1), outEnc);
    }
  }
  crypto.createECDH = function createECDH(curve) { return curve === 'secp256k1' ? new Secp256k1ECDH() : orig.apply(this, arguments); };
  syncBuiltinESMExports();   // 让 baw 里 import { createECDH } from 'node:crypto' 拿到补过的版本
  return true;
}
