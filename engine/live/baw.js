// 币安 Agentic Wallet CLI（baw）封装：钱包地址、余额、报价、合约调用预演；LIVE_TRADE=1 时才会用到 swap / contract-call execute。本程序不接触私钥。
// execFile 不经过 shell，参数逐个传入，地址都先校验。
import { execFile } from 'node:child_process';
import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { join as pathJoin, dirname as pathDirname, delimiter as pathDelimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { BAW_BIN, BINANCE_CHAIN_ID, BAW_SLIPPAGE_UNIT, DRY_RUN, AUTO_TRANSFER_TO } from './config.js';
import { assertLiquid, isQuoteToken } from './quoteRoutes.js';

export function assertAddress(a, name = 'address') {
  if (!a || !ethers.isAddress(String(a))) throw new Error(`invalid_${name}`);
  return ethers.getAddress(String(a));
}

const slip = (pct) => (BAW_SLIPPAGE_UNIT === 'fraction' ? String(Number(pct) / 100) : String(pct));

// ---------- 多钱包上下文 ----------
// 调用链里自动携带槽位：liveTrader 用 withSlot(槽位, fn) 包住每个钱包的操作，
// portal / gangV2 等模块内部的 baw 调用不用逐个传参也能拿到正确槽位。
// 签名类调用（contract-call / swap / send）还有第二道闸：按 from 地址精确匹配；
// 多钱包开着时解析不出槽位就报错拒绝，绝不用错钱包发交易
import { AsyncLocalStorage } from 'node:async_hooks';
const slotALS = new AsyncLocalStorage();
// 防夹（MEV 保护）：一笔订单里所有 market-order（包括计价币换回 BNB）都按这笔订单的设置；不在订单里调用时默认关
const mevALS = new AsyncLocalStorage();
export const withMev = (on, fn) => mevALS.run(!!on, fn);
// Gas 档位：页面预设的 普通 / 快速 / 极速 → baw 的 LOW / MEDIUM / HIGH；同样按订单传给这笔订单里所有 market-order（不在订单里调用时用 HIGH）
const GAS_LEVEL = { normal: 'LOW', high: 'MEDIUM', turbo: 'HIGH' };
const gasALS = new AsyncLocalStorage();
export const withGas = (gas, fn) => gasALS.run(GAS_LEVEL[gas] || null, fn);
export const withSlot = (slot, fn) => slotALS.run(Number(slot), fn);
let addrSlots = new Map();   // 地址(小写) → 槽位
export const setAddressSlots = (pairs) => { addrSlots = new Map(pairs); };
const slotOfAddr = (a) => addrSlots.get(String(a || '').toLowerCase());
const multiOn = () => addrSlots.size > 1;
// 解析本次调用用哪个槽位：显式传的 > from 地址匹配 > 调用链上下文；都没有 = 钱包 1 / 本进程默认
function resolveSlot(opts = {}, from) {
  if (opts.slot != null) return Number(opts.slot);
  const byAddr = from != null ? slotOfAddr(from) : undefined;
  if (byAddr != null) return byAddr;
  const ctx = slotALS.getStore();
  if (ctx != null) return ctx;
  return null;
}
// 会花钱的调用：多钱包开着时必须能解析出槽位
function mustSlot(opts = {}, from) {
  const s = resolveSlot(opts, from);
  if (s == null && multiOn()) throw new Error('多钱包模式下这笔操作没有指明用哪个钱包，已拒绝执行（保护机制，请反馈）');
  return s;
}

const RISK_BLOCKED = /risk is too high|has been rejected: blocked/i;
const NET_ERR = /REQUEST_TIMEOUT|Connect Timeout|UND_ERR_CONNECT_TIMEOUT|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|ECONNRESET/i;
function formatErr(parsed, fallback) {
  const e = parsed?.error;
  return e ? `${e.name || e.code || 'baw_error'}: ${e.message || ''}`.trim() : fallback;
}

// 多钱包（不用 Docker）：槽位 ≥ 2 的钱包通过命名空间钩子调 baw，登录凭证存到钥匙串的
// baw.piupiu.w<N>，不会覆盖钱包 1 的默认位置。钩子只认核对过存凭证方式的 baw 版本（engine/live/baw-profile/hook.mjs）。
// 传法：runBaw(args, { slot: 2 })，各封装函数的参数对象里同样接受 slot（省略 = 钱包 1 / 本进程默认）
import * as walletSlots from './walletSlots.js';
import { APP_MODE } from './config.js';
import * as runtime from './runtime.js';
import { withProxyEnv } from './sysProxy.js';
const PROFILE = process.env.PIUPIU_BAW_PROFILE || '';
// 安装版且没有手动指定 BAW_BIN：用 runtime.js 找到的 baw（用户全局装的核对过的版本，或我们装在用户目录里的），
// 一律用本进程的 Node（安装版里就是 App 自带的）跑它的 dist/index.js——用户电脑上不需要装 Node
const APP_BAW = APP_MODE && !process.env.BAW_BIN;
function appCli() {
  const c = runtime.resolveManagedBaw();
  if (c) return c;
  const s = runtime.state.baw;
  throw new Error(s.installing ? '币安钱包组件正在安装，稍等片刻' : `币安钱包组件还没装好${s.error ? `：${s.error}` : '（打开「使用前检查」查看）'}`);
}
// --import 要传 file:// 网址：Windows 上直接传 C:\… 路径，Node 会把盘符当成网址协议（ERR_UNSUPPORTED_ESM_URL_SCHEME）
const HOOK = new URL('./baw-profile/hook.mjs', import.meta.url).href;
// 桌面版用 Electron 自带的 Node 跑 baw 时要先加载这个垫片，否则 commander 会把脚本路径当成命令（baw-profile/electron-argv.mjs）
const NODE_PRE = process.versions.electron ? ['--import', new URL('./baw-profile/electron-argv.mjs', import.meta.url).href] : [];
const IS_WIN = process.platform === 'win32';

// 槽位 ≥ 2 的调用是否可用：只认核对过存凭证方式的 baw 版本（和 hook.mjs 里的 KNOWN 一致）。
// 不在白名单时「添加钱包」要禁用（钱包 1 不受影响）
let profCheck = null;
export const resetProfileSupport = () => { profCheck = null; winBawCli = null; bawCmdCache = null; runtime.resolveManagedBaw({ refresh: true }); };   // 用户刚装好 baw 时重新检查
export function profileSupport() {
  if (profCheck) return profCheck;
  try {
    const cli = IS_WIN ? resolveWinBaw() : resolveBawCli();
    const version = JSON.parse(readFileSync(pathJoin(pathDirname(cli), '..', 'package.json'), 'utf8')).version;
    profCheck = { ok: ['1.11.0', '1.12.0'].includes(version) || process.env.PIUPIU_BAW_ALLOW_ANY === '1', version };
  } catch (e) { profCheck = { ok: false, version: null, error: e.message }; }
  return profCheck;
}
let bawCmdCache = null;
// 裸命令名（baw）→ 沿 PATH 找到真实文件 → realpath；已是路径就直接 realpath
function resolveBawCli() {
  if (APP_BAW) return appCli();
  const p = String(BAW_BIN || 'baw');
  const hit = /[\\/]/.test(p) ? p : String(process.env.PATH || '').split(pathDelimiter).map((d) => d && pathJoin(d, p)).find((x) => x && existsSync(x));
  if (!hit) throw new Error('PATH 里没有找到');
  return realpathSync(hit);
}
// Windows：npm 全局安装的 baw 是 .cmd 垫片，execFile 直接拉会报 EINVAL（Node 对 .cmd/.bat 的安全限制），
// 改成用 node 跑包里的 dist/index.js。找不到时可在 .env 里把 BAW_BIN 指到该文件的完整路径
let winBawCli = null;
function resolveWinBaw() {
  if (APP_BAW) return appCli();
  if (winBawCli) return winBawCli;
  const cands = [];
  const b = String(BAW_BIN || '');
  if (/\.m?js$/i.test(b)) cands.push(b);
  if (process.env.APPDATA) cands.push(pathJoin(process.env.APPDATA, 'npm', 'node_modules', '@binance', 'agentic-wallet', 'dist', 'index.js'));
  const hit = cands.find((x) => x && existsSync(x));
  if (!hit) throw new Error('Windows 上没有找到 baw 的入口文件（npm 全局安装的 @binance/agentic-wallet/dist/index.js）。确认已 npm i -g @binance/agentic-wallet，或在 .env 里把 BAW_BIN 指到该文件的完整路径');
  return (winBawCli = hit);
}
// 槽位 ≥ 2：一律用 node --import 钩子跑 dist/index.js（钩子里会核对 baw 版本），并带上这个钱包自己的环境变量
function profileInvocation(args, slot) {
  let cmd, argv;
  if (IS_WIN || APP_BAW) { cmd = process.execPath; argv = [...NODE_PRE, '--import', HOOK, IS_WIN ? resolveWinBaw() : resolveBawCli(), ...args]; }
  else {
    if (!bawCmdCache) {
      let c = BAW_BIN; try { c = resolveBawCli(); } catch (e) { throw new Error(`多钱包模式找不到可用的 baw（${BAW_BIN}）：${e.message}`); }
      if (!/[\\/]dist[\\/]index\.js$/.test(c)) throw new Error(`多钱包模式需要 npm 安装的 baw（dist/index.js），当前 BAW_BIN=${BAW_BIN}；可在 .env 里把 BAW_BIN 指向它`);
      bawCmdCache = [process.execPath, [...NODE_PRE, '--import', HOOK, c]];
    }
    [cmd, argv] = [bawCmdCache[0], [...bawCmdCache[1], ...args]];
  }
  const env = { ...process.env, ...walletSlots.bawEnvOf(slot) };
  if (!env.BINANCE_BAW_DIR) throw new Error('多钱包会话目录缺失');
  return { cmd, argv, env };
}
function bawInvocation(args, slot) {
  if (Number(slot) >= 2) return profileInvocation(args, Number(slot));
  if (walletSlots.profileOf(slot ?? 1)) return profileInvocation(args, Number(slot ?? 1));   // 安装版：W1 也走钩子（凭证存文件，见 walletSlots.profileOf）
  if (APP_BAW) return { cmd: process.execPath, argv: [...NODE_PRE, ...(PROFILE ? ['--import', HOOK] : []), appCli(), ...args], env: process.env };
  if (IS_WIN) {
    const cli = resolveWinBaw();
    return { cmd: process.execPath, argv: [...NODE_PRE, ...(PROFILE ? ['--import', HOOK] : []), cli, ...args], env: process.env };
  }
  if (!PROFILE) return { cmd: BAW_BIN, argv: args, env: process.env };
  if (!bawCmdCache) {
    let cli = BAW_BIN; try { cli = resolveBawCli(); } catch (e) { throw new Error(`多钱包模式找不到可用的 baw（${BAW_BIN}）：${e.message}`); }
    if (!/[\\/]dist[\\/]index\.js$/.test(cli)) throw new Error(`多钱包模式需要 npm 安装的 baw（dist/index.js），当前 BAW_BIN=${BAW_BIN}；可在 .env 里把 BAW_BIN 指向它`);
    bawCmdCache = [process.execPath, [...NODE_PRE, '--import', HOOK, cli]];
  }
  return { cmd: bawCmdCache[0], argv: [...bawCmdCache[1], ...args], env: process.env };
}

// 不同版本的 baw 支持的参数不一样（比如 1.11.0 的 wallet balance 没有 --hideLowValue，1.12.0 才有）。
// baw 报「unknown option '--X'」时去掉这个参数（连同它的值）重试一次，并记住，之后不再传。参数解析失败时 baw 什么都没做，重试是安全的。
const unsupportedFlags = new Set();
const stripFlags = (args) => {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (unsupportedFlags.has(args[i])) { if (i + 1 < args.length && !String(args[i + 1]).startsWith('--')) i++; continue; }
    out.push(args[i]);
  }
  return out;
};

export async function runBaw(args, opts = {}) {
  try { return await runBawOnce(stripFlags(args), opts); }
  catch (e) {
    const flag = /unknown option '(--[A-Za-z][\w-]*)'/.exec(e.message)?.[1];
    if (!flag || unsupportedFlags.has(flag) || !args.includes(flag)) throw e;
    unsupportedFlags.add(flag);
    console.warn(`[baw] 当前 baw 不支持 ${flag}，已去掉这个参数重试`);
    return runBawOnce(stripFlags(args), opts);
  }
}

// 单元测试进程（node --test 会设 NODE_TEST_CONTEXT）里一律不许调用真实的币安钱包：测试绝不能碰签名通道。
// 确实要在测试里验证 baw 调用的，设 BAW_ALLOW_IN_TEST=1（目前没有这样的测试）
const NO_BAW_IN_TEST = !!process.env.NODE_TEST_CONTEXT && process.env.BAW_ALLOW_IN_TEST !== '1';
function runBawOnce(args, { timeoutMs = 90_000, onChild, slot } = {}) {
  if (NO_BAW_IN_TEST) return Promise.reject(Object.assign(new Error('测试进程里不允许调用币安钱包（baw）'), { code: 'BAW_BLOCKED_IN_TEST' }));
  const s = slot != null ? Number(slot) : slotALS.getStore() ?? null;   // 调用链上下文自动带上槽位（显式传的优先）
  const inv = bawInvocation(['--json', ...args], s);
  return new Promise((resolve, reject) => {
    const child = execFile(inv.cmd, inv.argv, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: withProxyEnv(inv.env) }, (err, stdout, stderr) => {
      const text = String(stdout || '').trim();
      let parsed = null;
      if (text) { try { parsed = JSON.parse(text); } catch { /* 非 JSON */ } }
      if (err) {
        const raw = err.code === 'ENOENT' ? '' : formatErr(parsed, String(stderr || err.message).slice(0, 400));
        // 连不上币安（直连被拦、代理没生效）：给出能照着做的提示，原始报错留在日志里
        if (NET_ERR.test(raw)) { console.warn(`[baw] 网络错误：${raw.slice(0, 200)}`); return reject(Object.assign(new Error('无法连接币安服务器。请检查网络；使用代理软件时，请确认代理已开启并能访问币安。'), { baw: parsed, network: true })); }
        // 币安风控把这笔交易判为高风险、钱包设为「自动拒绝」时直接拒绝：说清原因和怎么改（原始报错进日志）
        if (RISK_BLOCKED.test(raw)) { console.warn(`[baw] 风控拒绝：${raw.slice(0, 200)}`); return reject(Object.assign(new Error('币安钱包风控拒绝了这笔交易：币安把这个代币标为高风险，而你的钱包「异常交易处理」设为「自动拒绝」。请在币安 App 中改为「App 内确认」，再重试并在 App 中确认。'), { baw: parsed, code: 'RISK_BLOCKED' })); }
        const msg = err.code === 'ENOENT' ? `找不到 baw 命令（npm i -g @binance/agentic-wallet）` : raw;
        return reject(Object.assign(new Error(msg), { baw: parsed }));
      }
      if (!parsed) return reject(new Error(`baw_bad_json: ${text.slice(0, 200) || stderr || 'empty'}`));
      if (parsed.success === false) return reject(Object.assign(new Error(formatErr(parsed, 'baw_failed')), { baw: parsed }));
      resolve(parsed);
    });
    child.on('error', reject);
    onChild?.(child);   // 调用方可以拿到子进程（比如取消登录时结束 auth verify）
  });
}

// 域名 → 地址（.ai Agent ID、.bnb SPACE ID 等，由币安后端解析；只读）
export async function resolveDomain(name, opts) { return (await runBaw(['wallet', 'resolve-domain', '--name', String(name), '--binanceChainId', '56'], { timeoutMs: 20_000, ...opts })).data || {}; }
export async function walletStatus(opts) { return (await runBaw(['wallet', 'status'], { timeoutMs: 20_000, ...opts })).data?.status || 'UNKNOWN'; }
export async function agentId(opts) { return (await runBaw(['wallet', 'agent-id'], { timeoutMs: 20_000, ...opts })).data || {}; }

// 登录：signin 返回 urlForWeb + pairingCode（已登录时 status=ALREADY_CONNECTED）；verify 会阻塞到 App 里确认或 5 分钟超时
export async function authSignin(opts) { return (await runBaw(['auth', 'signin'], { timeoutMs: 30_000, ...opts })).data || {}; }
export async function authVerify(qrCodeId, onChild, opts) { return (await runBaw(['auth', 'verify', '--qrCodeId', String(qrCodeId)], { timeoutMs: 330_000, onChild, ...opts })).data || {}; }
// 登出当前登录目录的会话（只在登录了错误账号时用，清掉这个错的会话）
export async function authSignout(opts) { return (await runBaw(['auth', 'signout'], { timeoutMs: 20_000, ...opts })).data || {}; }

// 钱包是否被锁：有一笔交易在等币安 App 确认时是 LOCKED，这时任何新交易都会被拒
export async function walletLock(opts) { return (await runBaw(['wallet', 'tx-lock', '--binanceChainId', String(BINANCE_CHAIN_ID)], { timeoutMs: 20_000, ...opts })).data?.status || 'UNKNOWN'; }

export async function walletAddresses(opts) { return (await runBaw(['wallet', 'address'], { timeoutMs: 20_000, ...opts })).data?.addresses || []; }

export async function walletBalance({ tokenAddress, slot } = {}) {
  const args = ['wallet', 'balance', '--binanceChainId', String(BINANCE_CHAIN_ID), '--hideLowValue', 'false'];
  if (tokenAddress) args.push('--tokenAddress', assertAddress(tokenAddress, 'tokenAddress'));
  const res = await runBaw(args, { timeoutMs: 30_000, slot });
  return Array.isArray(res.data) ? res.data : [];
}

export async function marketQuote({ fromTokenQty, fromToken, toToken, slippage, slot }) {
  // 报价时就把「池子太小」的原因告诉页面，不等到下单。只检查计价币：普通代币（比如发射后在外盘卖出的持仓）不检查，池子再小也要能卖
  for (const tk of [fromToken, toToken]) if (!DEEP.has(String(tk).toLowerCase()) && isQuoteToken(tk)) await assertLiquid(tk);
  const args = ['market-order', 'quote', '--fromTokenQty', String(fromTokenQty), '--fromToken', assertAddress(fromToken, 'fromToken'),
    '--toToken', assertAddress(toToken, 'toToken'), '--binanceChainId', String(BINANCE_CHAIN_ID)];
  if (slippage != null) args.push('--slippage', slip(slippage));
  return (await runBaw(args, { timeoutMs: 45_000, slot })).data;
}

// contract-call 预演（模拟 + 风控检查），不执行。需要先在 baw wallet settings 打开 devMode。
export async function contractPreview({ from, to, valueWei = '0', inputData, slot } = {}) {
  const s = mustSlot({ slot }, from);
  const pre = (await runBaw(['contract-call', 'preview', '--binanceChainId', String(BINANCE_CHAIN_ID), '--from', assertAddress(from, 'from'),
    '--to', assertAddress(to, 'to'), '--value', String(valueWei), '--inputData', String(inputData)], { timeoutMs: 45_000, slot: s })).data || {};
  const riskDetails = pre.risks?.riskDetails || [];
  return { dryRun: true, requestId: pre.requestId, simulation: pre.simulationResult?.simulationCode, risks: riskDetails.length,
    riskTitles: riskDetails.map((r) => r.title).filter(Boolean), requireConfirmation: !!pre.requireConfirmation };
}

// 真实执行：先 preview，再用 requestId execute。返回 BROADCASTED（带 txHash）或 PENDING_CONFIRMATION（需在币安 App 里确认）。
export async function contractCall({ from, to, valueWei = '0', inputData, slot } = {}) {
  const s = mustSlot({ slot }, from);
  const pre = await contractPreview({ from, to, valueWei, inputData, slot: s });
  if (!pre.requestId) throw new Error('baw 预演没有返回 requestId（可能被风控拦截）');
  // execute 之后结果不确定（超时 / 断网）时不能当失败：交易可能已经发出去了
  let ex;
  try { ex = (await runBaw(['contract-call', 'execute', '--requestId', String(pre.requestId)], { timeoutMs: 150_000, slot: s })).data || {}; }
  catch (e) { if (/timeout|timed out|ETIMEDOUT|killed|SIGTERM|ECONNRESET|fetch failed|network/i.test(e.message)) throw Object.assign(new Error('已提交执行，但没等到结果（可能已经上链）'), { code: 'UNKNOWN_SUBMIT' }); throw e; }
  return { ...pre, dryRun: false, orderId: ex.orderId, status: ex.status, txHash: ex.txHash || null, message: ex.message || null };
}

const DEEP = new Set(['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', '0x55d398326f99059ff775485246999027b3197955', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d']);   // BNB、WBNB、USDT、USDC、USD1
export async function marketSwap({ fromTokenQty, fromToken, toToken, slippage, mev = mevALS.getStore() ?? false, gasLevel = gasALS.getStore() || 'HIGH', slot } = {}) {
  // 计价币兑换前检查流动性：最深的池子太小（低于 QUOTE_MIN_LIQ_USD，默认 $20,000）就拒绝，避免在小池子里吃大滑点。BNB / WBNB / 主流稳定币不查；
  // 普通代币（发射后在外盘买卖的持仓）也不查——以前对所有代币都查，外盘池子小于 2 万美元、或 DexScreener 还没收录的币会被拒绝卖出
  for (const tk of [fromToken, toToken]) if (!DEEP.has(String(tk).toLowerCase()) && isQuoteToken(tk)) await assertLiquid(tk);
  const s = mustSlot({ slot });
  const args = ['market-order', 'swap', '--fromTokenQty', String(fromTokenQty), '--fromToken', assertAddress(fromToken, 'fromToken'),
    '--toToken', assertAddress(toToken, 'toToken'), '--binanceChainId', String(BINANCE_CHAIN_ID), '--mev', mev ? 'true' : 'false', '--gasLevel', gasLevel];
  if (slippage != null) args.push('--slippage', slip(slippage));
  return (await runBaw(args, { timeoutMs: 90_000, slot: s })).data || {};
}

export async function marketOrder(orderId, opts) {
  return (await runBaw(['market-order', 'list', '--orderId', String(orderId)], { timeoutMs: 30_000, ...opts })).data?.list?.[0] || null;
}

// orderId 只表示已提交，必须轮询到 FINISHED / FAILED 才算有结果
export async function pollOrder(orderId, { maxMs = 60_000, intervalMs = 250, slot } = {}) {
  const t0 = Date.now(); let last = null;
  while (Date.now() - t0 < maxMs) {
    last = await marketOrder(orderId, { slot }).catch(() => last);
    if (last?.status === 'FINISHED' || last?.status === 'FAILED') return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}

// 代币转账：baw wallet send --max（转出全部余额）
export async function sendMax({ tokenAddress, recipient, gasLevel = 'MEDIUM', slot } = {}) {
  // 最后一道闸：只报价模式（LIVE_TRADE=0）一律不转；收款地址只能是服务器配置的 AUTO_TRANSFER_TO
  if (DRY_RUN) throw new Error('当前是演示模式，不会转出');
  if (String(recipient || '').toLowerCase() !== String(AUTO_TRANSFER_TO || '').toLowerCase()) throw new Error('收款地址和设置里的转出地址不一致，已拒绝转出');
  const s = mustSlot({ slot });
  const args = ['wallet', 'send', '--binanceChainId', String(BINANCE_CHAIN_ID), '--max', '--tokenAddress', assertAddress(tokenAddress, 'tokenAddress'), '--recipient', assertAddress(recipient, 'recipient'), '--gasLevel', gasLevel];
  try { return (await runBaw(args, { timeoutMs: 90_000, slot: s })).data || {}; }
  catch (e) { throw notInAddressBook(e) ? Object.assign(new Error(addressBookMsg(recipient)), { code: 'ADDRESS_BOOK', baw: e.baw }) : e; }
}
// 转账收款地址必须先加入币安 App 的地址簿（错误码 351703；2026-10-31 实测）
export const notInAddressBook = (e) => e?.baw?.error?.code === 351703 || /not in your address book/i.test(String(e?.message || ''));
export const addressBookMsg = (to) => `收款地址 ${String(to).slice(0, 6)}…${String(to).slice(-4)} 不在币安 App 的地址簿中，转出被拒绝，资产未发生变动。请在币安 App →「钱包」→「设置」→「地址簿」中添加该地址。`;
