// baw 看到的 @github/keytar：只允许读写 service "baw" / account "agentSessionId" 这一项。
// 两种存法：
//   钥匙串（开发 / 自己用，多钱包 W2…）：映射到 baw.piupiu.<PIUPIU_BAW_PROFILE>，不碰钱包 1 的默认位置，也不返回任何其他钥匙串条目。
//   文件（安装版，设了 PIUPIU_KEYSTORE_FILE）：存成只有当前系统用户能读写的文件（目录 0700、文件 0600），完全不加载钥匙串模块。
//     原因：macOS 的钥匙串条目只认创建它的程序，未签名 / 临时签名的 App 每次更新都算新程序，
//     而且对每个 baw 进程单独弹授权框（2026-10-30 实测 1 分半弹了 27 次）。
//     代价：同一系统用户下运行的其他程序能读到这个文件（钥匙串至少会弹窗拦一下）；登录本身有币安的额度和有效期兜底。
import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const FILE = process.env.PIUPIU_KEYSTORE_FILE || '';
const SERVICE = `baw.piupiu.${process.env.PIUPIU_BAW_PROFILE}`;
const ACCOUNT = 'agentSessionId';
const check = (service, account) => {
  if (service !== 'baw') throw new Error('Unexpected keychain service');
  if (account !== undefined && account !== ACCOUNT) throw new Error('Unexpected keychain account');
};

const fileStore = {
  get() { try { const v = JSON.parse(readFileSync(FILE, 'utf8'))[ACCOUNT]; return typeof v === 'string' ? v : null; } catch { return null; } },
  set(p) {
    const dir = dirname(FILE);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* Windows：权限由用户目录继承 */ }
    const tmp = `${FILE}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ [ACCOUNT]: String(p) }), { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* 同上 */ }
    renameSync(tmp, FILE);
  },
  del() { try { readFileSync(FILE); } catch { return false; } rmSync(FILE, { force: true }); return true; },
};

let real = null;   // 只在钥匙串模式下才加载原生模块
const kc = () => (real ||= createRequire(import.meta.url)(process.env.PIUPIU_REAL_KEYTAR));

const ns = FILE ? {
  getPassword: async (s, a) => { check(s, a); return fileStore.get(); },
  setPassword: async (s, a, p) => { check(s, a); fileStore.set(p); },
  deletePassword: async (s, a) => { check(s, a); return fileStore.del(); },
  findPassword: async (s) => { check(s); return fileStore.get(); },
  findCredentials: async (s) => { check(s); const p = fileStore.get(); return p == null ? [] : [{ account: ACCOUNT, password: p }]; },
} : {
  getPassword: async (s, a) => { check(s, a); return kc().getPassword(SERVICE, ACCOUNT); },
  setPassword: async (s, a, p) => { check(s, a); return kc().setPassword(SERVICE, ACCOUNT, p); },
  deletePassword: async (s, a) => { check(s, a); return kc().deletePassword(SERVICE, ACCOUNT); },
  findPassword: async (s) => { check(s); return kc().getPassword(SERVICE, ACCOUNT); },
  findCredentials: async (s) => { check(s); const p = await kc().getPassword(SERVICE, ACCOUNT); return p == null ? [] : [{ account: ACCOUNT, password: p }]; },
};
export default Object.freeze(ns);
export const { getPassword, setPassword, deletePassword, findPassword, findCredentials } = ns;
