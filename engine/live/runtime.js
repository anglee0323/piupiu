// 安装版的运行时依赖（engine/live/runtime/manifest.json）：币安钱包命令行（baw）和 Four 专属内盘报价脚本。
// 两者许可证都不允许随安装包分发，所以在用户电脑上首次启动时从官方源获取，等于用户自己安装：
//   baw：一律用 App 自己的一份——App 自带的 npm + 锁定文件（runtime/baw/package-lock.json）装到 <用户目录>/runtime/baw。
//        不用用户电脑上全局装的 baw（版本、升级节奏、登录目录都可能和我们不一致），也不动它；用户没装 Node / npm 也不影响。
//        npm ci 逐个核对 integrity，先官方源、连不上再国内镜像，两种情况装进来的文件都和官方一字不差；
//        --ignore-scripts：钥匙串模块自带全平台预编译文件，不执行任何第三方安装脚本、也不需要编译工具。
//        登录存在 <用户目录>/wallets/w<N>/baw 下的凭证文件，和用户电脑上别的 baw 完全隔离（见 baw-profile/）。
//   报价脚本：锁定上游提交 + sha256，GitHub 不通就走 jsDelivr，指纹不对不用。
// 升级：改 manifest（和 baw 的锁定文件）发新版；这里发现已装的版本 / 指纹和 manifest 不一致，会在后台换新，新的装好前旧的照常用。
// 只有安装版（PIUPIU_APP=1）会自动安装；开发时仍用本机 PATH 里的 baw 和 .agents/ 里的脚本。
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_MODE, APP_HOME } from './config.js';

export const MANIFEST = JSON.parse(readFileSync(new URL('./runtime/manifest.json', import.meta.url), 'utf8'));
const LOCK_DIR = fileURLToPath(new URL('./runtime/baw/', import.meta.url));
export const RUNTIME_DIR = APP_MODE ? join(APP_HOME, 'runtime') : null;
export const MANAGED_BAW = RUNTIME_DIR ? join(RUNTIME_DIR, 'baw') : null;
export const FOUR_SCRIPT = RUNTIME_DIR ? join(RUNTIME_DIR, 'binance-skills', `agent-id-exclusive-token-launches.${MANIFEST.fourScript.commit.slice(0, 10)}.mjs`) : null;

/** 状态（使用前检查里显示）：source = managed 我们装在用户目录里的 */
export const state = {
  baw: { source: null, cli: null, version: null, installing: false, error: null },
  four: { ok: false, path: null, downloading: false, error: null },
};

const cliIn = (root) => join(root, 'node_modules', '@binance', 'agentic-wallet', 'dist', 'index.js');
export function bawVersionOf(cli) { try { return JSON.parse(readFileSync(join(dirname(cli), '..', 'package.json'), 'utf8')).version; } catch { return null; } }

/**
 * 安装版用哪个 baw：只看我们装在用户目录里的（版本在 manifest 核对过的范围内）→ 否则 null（需要安装）。
 * 结果缓存在 state.baw；安装 / 换新后会刷新。
 */
export function resolveManagedBaw({ refresh = false } = {}) {
  if (!APP_MODE) return null;
  if (state.baw.cli && !refresh) return state.baw.cli;
  const m = cliIn(MANAGED_BAW), mv = existsSync(m) ? bawVersionOf(m) : null;
  if (mv && MANIFEST.baw.supported.includes(mv)) return set('managed', m, mv);   // 旧版但核对过：先用着，ensureRuntime 会换新
  return set(null, null, null);
  function set(source, cli, version) { Object.assign(state.baw, { source, cli, version }); return cli; }
}

const run = (cmd, args, opts) => new Promise((resolve, reject) => {
  execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr: String(stderr || '').slice(-800) })) : resolve(stdout)));
});

/** 用 App 自带的 npm 按锁定文件装 baw 到 <用户目录>/runtime/baw（先装到临时目录，核对版本后再换上） */
export async function installBaw({ npmCli = process.env.PIUPIU_NPM_CLI, log = () => {} } = {}) {
  if (!APP_MODE) throw new Error('只有安装版会自动安装币安钱包组件');
  if (!npmCli || !existsSync(npmCli)) throw new Error('安装组件缺失（App 自带的 npm 找不到），请重新安装 Piupiu');
  const tmp = `${MANAGED_BAW}.tmp-${Date.now()}`;
  mkdirSync(tmp, { recursive: true });
  cpSync(join(LOCK_DIR, 'package.json'), join(tmp, 'package.json'));
  cpSync(join(LOCK_DIR, 'package-lock.json'), join(tmp, 'package-lock.json'));
  let lastErr = null;
  for (const registry of MANIFEST.baw.registries) {
    try {
      log(`[组件] 安装币安钱包命令行 ${MANIFEST.baw.version}（${registry}）`);
      await run(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--registry', registry],
        { cwd: tmp, timeout: 5 * 60_000, env: { ...process.env, npm_config_cache: join(RUNTIME_DIR, 'npm-cache'), npm_config_update_notifier: 'false' } });
      lastErr = null; break;
    } catch (e) { lastErr = e; log(`[组件] ${registry} 安装失败：${(e.stderr || e.message).split('\n').filter(Boolean).slice(-2).join(' ')}`); }
  }
  if (lastErr) { rmSync(tmp, { recursive: true, force: true }); throw new Error('币安钱包组件下载失败，请检查网络后重试'); }
  const v = bawVersionOf(cliIn(tmp));
  if (v !== MANIFEST.baw.version) { rmSync(tmp, { recursive: true, force: true }); throw new Error(`装好的版本不对（${v}）`); }
  const old = `${MANAGED_BAW}.old-${Date.now()}`;
  if (existsSync(MANAGED_BAW)) renameSync(MANAGED_BAW, old);
  renameSync(tmp, MANAGED_BAW);
  rmSync(old, { recursive: true, force: true });
  log(`[组件] 币安钱包命令行 ${v} 已就绪`);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const fourUrls = () => MANIFEST.fourScript.urls.map((u) => u.replace('{repo}', MANIFEST.fourScript.repo).replace('{commit}', MANIFEST.fourScript.commit).replace('{path}', MANIFEST.fourScript.path));

/** 报价脚本：本地有且指纹对就用；否则按顺序从各源下载，指纹对上才写入 */
export async function ensureFourScript({ fetchImpl = fetch, log = () => {} } = {}) {
  if (!APP_MODE) return null;
  const want = MANIFEST.fourScript.sha256;
  try { if (sha256(readFileSync(FOUR_SCRIPT)) === want) { Object.assign(state.four, { ok: true, path: FOUR_SCRIPT, error: null }); return FOUR_SCRIPT; } } catch { /* 没有 */ }
  state.four.downloading = true;
  try {
    for (const url of fourUrls()) {
      try {
        const r = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (sha256(buf) !== want) throw new Error('文件指纹不对，已丢弃');
        mkdirSync(dirname(FOUR_SCRIPT), { recursive: true });
        writeFileSync(`${FOUR_SCRIPT}.tmp`, buf); renameSync(`${FOUR_SCRIPT}.tmp`, FOUR_SCRIPT);
        log(`[组件] Four 报价脚本已就绪（${new URL(url).host}）`);
        Object.assign(state.four, { ok: true, path: FOUR_SCRIPT, error: null });
        return FOUR_SCRIPT;
      } catch (e) { log(`[组件] Four 报价脚本 ${new URL(url).host} 获取失败：${e.message}`); }
    }
    Object.assign(state.four, { ok: false, error: 'Four 报价脚本下载失败（GitHub 和 jsDelivr 都连不上），Four 专属内盘暂时不能交易' });
    return null;
  } finally { state.four.downloading = false; }
}

/** Gateway 启动时调用（只在安装版）：缺 baw 就装、版本落后就换新；报价脚本同理。失败不影响其他功能，使用前检查里会显示 */
let running = null;   // 同一时间只跑一次（「重新检查」可能在安装中再触发）
export function ensureRuntime(opts = {}) { return (running ||= doEnsure(opts).finally(() => { running = null; })); }
async function doEnsure({ log = () => {}, onChange = () => {} } = {}) {
  if (!APP_MODE) return;
  mkdirSync(RUNTIME_DIR, { recursive: true });
  resolveManagedBaw({ refresh: true });
  const managedStale = state.baw.source === 'managed' && state.baw.version !== MANIFEST.baw.version;
  if (!state.baw.cli || managedStale) {
    state.baw.installing = true; state.baw.error = null; onChange();
    try { await installBaw({ log }); resolveManagedBaw({ refresh: true }); }
    catch (e) { state.baw.error = e.message; log(`[组件] ${e.message}`); }
    finally { state.baw.installing = false; onChange(); }
  }
  await ensureFourScript({ log }); onChange();
}
