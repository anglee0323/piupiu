// 桌面版自动更新的核心逻辑（纯函数 + 少量文件操作，不依赖 Electron，便于单测）。
// 两层：
//   内核（Gateway + 界面，Mac / Windows 共用一个包）：core.json + core.json.sig → core-<版本>.tgz，
//     下载后核对 sha256，解压到 <用户目录>/core/<版本>，用户点「重启更新」（或下次启动）生效；新版起不来自动退回。
//   外壳（Electron + 启动器）：shell.json + shell.json.sig → 各平台安装包；Windows 静默安装，Mac 打开下载页（未签名不能自动替换）。
// 安全：清单用发布者私钥（ed25519，只在发布者电脑上）签名，App 内置公钥（update-pubkey.pem）验签；
//   安装包 / 内核包的完整性由已签名清单里的 sha256 保证，所以就算更新服务器被入侵，没有私钥也推不了代码。
//   只接受版本号更高的清单（防止拿旧的签名清单把用户降级到有漏洞的旧版）。
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** 版本比较：'3.1.10' > '3.1.9'；只比较数字段 */
function cmpVer(a, b) {
  const pa = String(a).split(/[.+-]/).map((x) => parseInt(x, 10) || 0), pb = String(b).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

/** 验签并解析清单：bytes = 清单原文（Buffer），sig = base64 签名；签名不对 / 格式不对抛错 */
function verifyManifest(bytes, sigB64, publicKeyPem, kind) {
  const ok = crypto.verify(null, Buffer.from(bytes), crypto.createPublicKey(publicKeyPem), Buffer.from(String(sigB64).trim(), 'base64'));
  if (!ok) throw new Error('更新清单签名不对，已忽略');
  const m = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (m.kind !== kind) throw new Error(`清单类型不对（${m.kind}）`);
  if (!/^\d+\.\d+\.\d+$/.test(String(m.version))) throw new Error('清单版本号格式不对');
  if (kind === 'core' && !(/^[0-9a-f]{64}$/.test(m.sha256) && /^core-[\d.]+\.tgz$/.test(m.file) && m.size > 0)) throw new Error('内核清单缺字段');
  return m;
}

function sign(bytes, privateKeyPem) { return crypto.sign(null, Buffer.from(bytes), crypto.createPrivateKey(privateKeyPem)).toString('base64'); }
const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// ---------- 内核选择 ----------
// state.json：{ current: 已激活的版本, pending: 已下载待生效的版本, good: [跑起来过的版本], bad: [跑不起来的版本] }
const readState = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch { return {}; } };
const writeState = (dir, s) => { fs.mkdirSync(dir, { recursive: true }); const t = path.join(dir, `state.json.tmp-${process.pid}`); fs.writeFileSync(t, JSON.stringify(s)); fs.renameSync(t, path.join(dir, 'state.json')); };
const coreOk = (dir, v) => !!v && fs.existsSync(path.join(dir, v, 'server.js')) && fs.existsSync(path.join(dir, v, 'package.json'));

/**
 * 这次启动用哪个内核：{ dir, version, ota }。
 * pending（用户点了重启更新 / 上次下载好的）优先激活；已激活且没被标坏、且比安装包自带的新 → 用它；否则用安装包自带的。
 */
function pickCore({ coreDir, bundledDir, bundledVersion }) {
  const s = readState(coreDir);
  const bad = new Set(s.bad || []);
  if (s.pending && bad.has(s.pending)) { delete s.pending; writeState(coreDir, s); }   // 标坏的版本不再激活
  if (s.pending && !bad.has(s.pending) && coreOk(coreDir, s.pending) && cmpVer(s.pending, bundledVersion) > 0) { s.current = s.pending; delete s.pending; writeState(coreDir, s); }
  if (s.current && !bad.has(s.current) && coreOk(coreDir, s.current) && cmpVer(s.current, bundledVersion) > 0) return { dir: path.join(coreDir, s.current), version: s.current, ota: true };
  return { dir: bundledDir, version: bundledVersion, ota: false };
}

/** 新内核起不来：标坏，退回上一个跑起来过的版本（没有就用安装包自带的） */
function markBad(coreDir, version) {
  const s = readState(coreDir);
  s.bad = [...new Set([...(s.bad || []), version])];
  const prev = (s.good || []).filter((v) => v !== version && !s.bad.includes(v)).sort(cmpVer).pop();
  s.current = prev || null;
  if (s.pending === version) delete s.pending;
  writeState(coreDir, s);
}
function markGood(coreDir, version) {
  const s = readState(coreDir);
  s.good = [...new Set([...(s.good || []), version])].sort(cmpVer).slice(-3);
  writeState(coreDir, s);
}
/** 只留当前、待生效和最近一个能用的版本，其余目录删掉 */
function cleanup(coreDir) {
  const s = readState(coreDir);
  const bad = new Set(s.bad || []);
  if (s.pending && bad.has(s.pending)) { delete s.pending; writeState(coreDir, s); }
  const keep = new Set([s.current, s.pending, ...(s.good || []).slice(-2)].filter((v) => v && !bad.has(v)));
  for (const n of fs.existsSync(coreDir) ? fs.readdirSync(coreDir) : []) {
    if (n === 'state.json' || keep.has(n)) continue;
    try { fs.rmSync(path.join(coreDir, n), { recursive: true, force: true }); } catch { /* 下次再删 */ }
  }
}

// 下载到 dest：边下边写 dest.part，断了用 Range 从断点续传（服务器不支持就从头下），最多 retries 次；
// 不限总时长，idleMs 内没收到数据才算断（网速慢也能下完）。下完核对大小和 sha256，不对就丢弃并报错
async function downloadFile(url, dest, { sha256, size, onProgress, log = () => {}, idleMs = 60_000, retries = 5, wait = (n) => n * 3000 } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  for (let attempt = 1; ; attempt++) {
    let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    if (size && have > size) { fs.rmSync(part, { force: true }); have = 0; }
    if (!size || have < size) {
      const ac = new AbortController(); let idle = null;
      const kick = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(new Error('长时间没有收到数据')), idleMs); };
      try {
        kick();
        const r = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: ac.signal });
        if (have && r.status === 200) have = 0;
        else if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
        let got = have; onProgress?.(got);
        try {
          for await (const chunk of r.body) {
            if (!out.write(chunk)) await new Promise((ok) => out.once('drain', ok));
            got += chunk.length; kick(); onProgress?.(got);
          }
        } finally { await new Promise((ok) => out.end(ok)); }
      } catch (e) {
        if (attempt >= retries) throw new Error(`下载中断：${e.message}`);
        log(`下载中断（第 ${attempt} 次：${e.message}），稍后续传`);
        await new Promise((ok) => setTimeout(ok, wait(attempt)));
        continue;
      } finally { clearTimeout(idle); }
    }
    if (size && fs.statSync(part).size !== size) { if (attempt >= retries) throw new Error('下载的文件大小不对'); continue; }
    if (sha256File(part) !== sha256) { fs.rmSync(part, { force: true }); throw new Error('下载的文件校验值不对，已丢弃'); }
    fs.renameSync(part, dest);
    return dest;
  }
}

module.exports = { downloadFile, cmpVer, verifyManifest, sign, sha256File, pickCore, markBad, markGood, cleanup, readState, writeState };
