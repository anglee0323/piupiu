import express from 'express';
import { WebSocketServer } from 'ws';
import { ethers } from 'ethers';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
const { randomBytes } = crypto;
import { fileURLToPath } from 'node:url';
import { Market, SNIPE_FEE_CURVE } from './engine/market.js';
import { SimTrader, GAS_PRESETS } from './engine/trader.js';
import { Agent } from './engine/agent.js';
import { Blocklist } from './engine/blocklist.js';
import { Favorites } from './engine/favorites.js';
import { DATA_DIR as DATA_DIR_UI, APP_MODE, APP_HOME } from './engine/live/config.js';
import { MODE, LIVE_TRADE, WALLET_LABEL } from './engine/live/config.js';
import { translate } from './shared/i18n/index.js';   // 中英文字典（网关返回给用户的文案）
import * as latency from './engine/live/latency.js';
import { redactSecrets } from './engine/live/rpc.js';
import { dataFile } from './engine/live/config.js';
import { startBackups } from './engine/backup.js';
import { tokenAudit } from './engine/live/audit.js';
import { Notifier } from './engine/live/notifier.js';
import { EP } from './engine/live/endpoints.js';

// 日志脱敏：控制台 / live.log 里出现的 RPC 地址（含 NodeReal key）一律打码
for (const k of ['log', 'info', 'warn', 'error']) { const f = console[k].bind(console); console[k] = (...a) => f(...a.map((x) => (typeof x === 'string' ? redactSecrets(x) : x instanceof Error ? redactSecrets(x.stack || x.message) : x))); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);

// MODE=live：真实行情（shrine + Flap Agent Curve Reader + fsi）+ baw 报价/预演；再加 LIVE_TRADE=1 才会把手动订单真实上链
const LIVE = MODE === 'live';
let market, trader;
if (LIVE) {
  const { LiveMarket } = await import('./engine/live/liveMarket.js');
  const { LiveTrader } = await import('./engine/live/liveTrader.js');
  market = new LiveMarket();
  trader = new LiveTrader(market);
  await trader.init();
  // 按币的「发射后转出」监控（data/transferWatch.json，与 AUTO_TRANSFER_FOUR 无关）
  const { startTransferWatch } = await import('./engine/live/transferWatch.js');
  startTransferWatch(trader, market.provider, { intervalMs: 3000, dryRun: !LIVE_TRADE });
} else {
  market = new Market();
  trader = new SimTrader(market);
}
const agent = new Agent(market, trader, { live: LIVE });
const favorites = new Favorites();
// RPC 用量：每分钟汇总一次（按节点 / 用途 / 方法），打印到控制台并追加到 data/rpc-usage.jsonl；/api/rpc-usage 看最近 60 分钟
const rpcUsageLog = [];
if (LIVE) {
  const { takeUsage, cuOf, nodeRealBudget, takeTrace } = await import('./engine/live/rpc.js');
  const { appendFileSync, mkdirSync } = await import('node:fs');
  setInterval(() => {
    const u = takeUsage(), nr = Object.entries(u).filter(([k]) => k.startsWith('NodeReal'));
    const total = nr.filter(([k]) => !k.endsWith('|ws_bytes')).reduce((a, [, n]) => a + n, 0);
    const perKey = {}; for (const [k, n] of nr) { const [node, , m] = k.split('|'); const o = (perKey[node] ||= { req: 0, cu: 0 }); if (m !== 'ws_bytes') o.req += n; o.cu += cuOf(m, n); }
    for (const o of Object.values(perKey)) o.cu = Math.round(o.cu);
    const row = { ts: Date.now(), nodereal: total, cu: Object.values(perKey).reduce((a, o) => a + o.cu, 0), perKey, all: Object.values(u).reduce((a, n) => a + n, 0), detail: u };
    rpcUsageLog.push(row); if (rpcUsageLog.length > 60) rpcUsageLog.shift();
    const top = nr.filter(([k]) => !k.endsWith('|ws_bytes')).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k}×${n}`).join('，');
    const tr = takeTrace(); if (tr?.length) console.log(`[RPC-TRACE] eth_call 来源（最近 1 分钟）：\n  ` + tr.map(([k, n]) => `${String(n).padStart(5)}  ${k}`).join('\n  '));
    const bd = nodeRealBudget(); if (bd.limit && (total || bd.exhausted)) console.log(`[RPC] NodeReal 本月已用 ${(bd.used / 1e4).toFixed(0)} 万 / ${(bd.limit / 1e4).toFixed(0)} 万 CU（${bd.keys.map((k) => `${k.name} ${(k.used / 1e4).toFixed(0)}万${k.exhausted ? ' 已停用' : ''}`).join('，')}）${bd.exhausted ? '，全部停用，下月 1 号恢复' : ''}`);
    console.log(`[RPC] 最近 1 分钟 NodeReal ${total} 次 / ${row.cu} CU（${Object.entries(perKey).map(([k, o]) => `${k} ${o.req} 次 ${o.cu} CU`).join('，')}）${top ? '：' + top : ''}`);
    try { mkdirSync(DATA_DIR_UI, { recursive: true }); appendFileSync(path.join(DATA_DIR_UI, 'rpc-usage.jsonl'), JSON.stringify(row) + '\n'); } catch { /* 写不了就算了 */ }
  }, 60_000);
}
// 行情列表满了会淘汰最老的币：持有中（本程序记录 + 持仓快照）和收藏的币不能被淘汰，否则持仓页会少掉它们
market.keepSet = () => new Set([
  ...[...(trader.positions?.values?.() || [])].filter((p) => p.amount > 0).map((p) => String(p.token).toLowerCase()),
  ...(() => { try { return holdSnap?.rows || []; } catch { return []; } })().filter((r) => r.amount > 0).map((r) => String(r.token).toLowerCase()),   // 启动早期 holdSnap 还没定义
  ...Object.keys(favorites.items || {}).map((a) => a.toLowerCase()),
]);
const blocklist = new Blocklist(); agent.isBlocked = (s) => blocklist.has(s);   // 屏蔽的币不自动买
// 实盘的 ⚡ 快捷买入金额存进 data/live-settings.json，重启后沿用（以前每次重启都回到默认 0.1）
if (LIVE) { const q = Number(trader.loadSaved?.().quickBuy); if (q > 0) agent.setConfig({ quickBuy: q }); }
// 持仓页：链上数量 + baw 钱包历史算成本（只在实盘模式）
const holdings = LIVE ? new (await import('./engine/live/holdings.js')).Holdings(market, trader) : null;
market.start();

const net = { wss: 302, rpc: 102, detect: 146, detectAt: Date.now() };
setInterval(() => {
  if (LIVE) Object.assign(net, market.netStatus());
  else { net.wss = Math.round(260 + Math.random() * 90); net.rpc = Math.round(80 + Math.random() * 50); }
}, LIVE ? 1000 : 3000);
agent.on('detect', (ms) => { net.detect = ms; net.detectAt = Date.now(); });
const modeInfo = () => ({ mode: LIVE ? 'live' : 'sim', baw: LIVE ? { ...trader.status, login: trader.loginView?.(1) } : null, slots: LIVE ? trader.slotsView() : null });

const app = express();
// ---------- 本地 API 防护 ----------
// 1) Host 只认本机名（防 DNS rebinding：别的网站把域名解析到 127.0.0.1 再来调接口）
// 2) 改动类请求（POST 等）和 WebSocket：浏览器发来的必须是本页面同源（Origin = http://localhost:端口），别的网页（含本机其他端口）一律拒绝
// 3) 没有 Origin 的请求（其他钱包后端、脚本）必须带访问令牌 x-tmtn-token：TMTN_API_TOKEN，没配就用 data/api-token（首次启动随机生成）
// 额外允许的主机名 / 来源用 ALLOWED_HOSTS / ALLOWED_ORIGINS（逗号分隔）
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', ...String(process.env.ALLOWED_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)]);
const EXTRA_ORIGINS = new Set(String(process.env.ALLOWED_ORIGINS || '').split(',').map((x) => x.trim().replace(/\/$/, '').toLowerCase()).filter(Boolean));
const API_TOKEN = (() => {
  if (process.env.TMTN_API_TOKEN) return process.env.TMTN_API_TOKEN;
  const f = dataFile('api-token');
  try { const t = fs.readFileSync(f, 'utf8').trim(); if (t.length >= 32) return t; } catch { /* 第一次启动 */ }
  const t = crypto.randomBytes(32).toString('hex'); fs.mkdirSync(new URL('.', f), { recursive: true }); fs.writeFileSync(f, t + '\n', { mode: 0o600 }); return t;
})();
const hostOk = (h) => LOCAL_HOSTS.has(String(h || '').toLowerCase().replace(/:\d+$/, ''));
const originOk = (o) => { try { const u = new URL(o); return EXTRA_ORIGINS.has(u.origin.toLowerCase()) || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname.toLowerCase()) && Number(u.port || 80) === PORT); } catch { return false; } };
const tokenOk = (t) => { const a = Buffer.from(String(t || '')), b = Buffer.from(API_TOKEN); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const guard = (req, write) => {
  if (!hostOk(req.headers.host)) return '请求来源不是本机，已拒绝';
  if (!write) return null;
  const o = req.headers.origin;
  if (o) return originOk(o) ? null : `来源 ${String(o).slice(0, 80)} 不是本应用页面，已拒绝`;
  return tokenOk(req.headers['x-tmtn-token']) ? null : '缺少访问令牌（x-tmtn-token），已拒绝';
};
app.use((req, res, next) => {
  const e = guard(req, !['GET', 'HEAD', 'OPTIONS'].includes(req.method));
  if (e) { console.warn(`[security] ${req.method} ${req.path}：${e}`); return res.status(403).json({ error: e }); }
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" });   // 页面不许被别的网站嵌进 iframe（防点击劫持）
  next();
});
app.use(express.json());
// 强制登录：实盘模式下币安钱包未登录时，所有动用资金的接口一律拒绝（买卖、兑换、换回 BNB、领取、撤销授权、单币转出规则）
const AUTH_GATED = new Set(['/api/order', '/api/swap', '/api/quote-to-bnb', '/api/claim', '/api/approvals/revoke', '/api/token-rules', '/api/gang/fly/claim']);
// 强制登录：实盘模式下没有已登录的钱包时，所有动用资金的接口一律拒绝（买卖、兑换、换回 BNB、领取、撤销授权、单币转出规则）；
// /api/order 按钱包分别处理（未登录的钱包跳过），只要有一个钱包在线就放行
const anyAuthOk = () => !LIVE || (trader.wallets?.length > 0);
app.use((req, res, next) => {
  if (LIVE && req.method === 'POST' && AUTH_GATED.has(req.path) && !(req.path === '/api/order' && anyAuthOk()) && trader.status?.auth?.state !== 'ok') return res.status(401).json({ error: '币安钱包未登录', auth: trader.status?.auth?.state });
  next();
});
// 新界面（web/ 打包输出 web/dist，React）挂在 /；旧界面（public/）挂在 /legacy/，狙击、跟单等还没迁移的功能在那里。
// 没有打包过新界面时，/ 仍然是旧界面。
const WEB_DIST = path.join(__dirname, 'web', 'dist');
const HAS_WEB = fs.existsSync(path.join(WEB_DIST, 'index.html'));
const LEGACY = HAS_WEB ? '/legacy' : '';
if (HAS_WEB) app.get('/legacy', (req, res, next) => (req.originalUrl.split('?')[0] === '/legacy' ? res.redirect(301, '/legacy/') : next()));   // Express 5 不区分末尾斜杠：只有不带斜杠时才跳转，否则死循环
// 旧界面首页：把 app.js / style.css 的版本号换成文件修改时间（每次改动都是新地址，浏览器不会用旧缓存），首页本身不缓存
app.get([`${LEGACY}/`, `${LEGACY}/index.html`], (req, res) => {
  try {
    const pub = path.join(__dirname, 'public'), v = (f) => Math.round(fs.statSync(path.join(pub, f)).mtimeMs);
    const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8').replace(/(app\.js|style\.css|gmgn\.css)\?v=[^"']*/g, (m, f) => `${f}?v=${v(f)}`);
    res.setHeader('Cache-Control', 'no-store'); res.type('html').send(html);
  } catch (e) { res.status(500).send(e.message); }
});
app.use(LEGACY || '/', express.static(path.join(__dirname, 'public'), { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));   // 每次都向服务器确认有没有更新（没变就 304），避免浏览器一直用旧的 app.js / style.css
if (HAS_WEB) {
  // 打包产物文件名带哈希，可以长缓存；index.html 不缓存
  app.use(express.static(WEB_DIST, { index: false, setHeaders: (res, p) => res.setHeader('Cache-Control', /[\\/]assets[\\/]/.test(p) ? 'public, max-age=31536000, immutable' : 'no-cache') }));
  // 前端路由（/token/0x…、/portfolio、/follow）都回到 index.html；/api、/ws、/legacy 不管
  // 首屏就带上用户选的主题和语言（data-theme / lang），界面加载前不会先闪一下默认主题
  const INDEX = path.join(WEB_DIST, 'index.html');
  app.get(/^\/(?!api\/|api$|ws$|legacy\/).*/, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const theme = uiPrefs?.theme === 'light' ? 'light' : 'dark', lang = uiPrefs?.lang === 'en' ? 'en' : 'zh-CN';   // 没保存过设置时默认黑暗
    try { res.type('html').send(fs.readFileSync(INDEX, 'utf8').replace(/<html[^>]*>/, `<html lang="${lang}" data-theme="${theme}">`)); }
    catch { res.sendFile(INDEX); }
  });
}

const state = () => ({
  ...modeInfo(), block: market.block, bnbUsd: market.bnbUsd, net,
  wallets: trader.walletsView(), settings: trader.settings, gasPresets: GAS_PRESETS, config: agent.config, usage: agent.usageView(),
  tokens: market.list(), positions: trader.positionsView(), snipeCurve: SNIPE_FEE_CURVE, claimable: LIVE ? trader.claimable : [],
  feeRate: trader.fees?.enabled ? 0.005 : 0,   // 交易手续费率（engine/live/fees.js FEE_RATE）；0 = 不收
});

// 铸币飞轮：钱包在某个飞轮里的额度 / 可卖回份数 / 可领奖励 / 开盘后铸造价（只读）；领取持有人奖励（真实交易，只接受页面手动点击）
app.get('/api/gang/fly/:addr', async (req, res) => {
  if (!LIVE) return res.json({ wallet: null });
  try { res.json(await trader.flyInfo(String(req.params.addr), Number(req.query.slot) || null)); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/gang/fly/claim', async (req, res) => {
  if (!LIVE) return res.status(400).json({ error: '仅实盘模式支持领取' });
  try { res.json(await trader.flyClaim(String(req.body?.token || ''), Number(req.body?.slot) || null, '手动')); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/claim', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '仅实盘模式支持领取' }); res.json(await trader.claimOne(req.body.market, '手动领取')); });
app.post('/api/auth/login', async (req, res) => { try { res.json(LIVE ? loginView(await trader.startLogin()) : null); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/auth/login-cancel', (req, res) => { res.json(LIVE ? loginView(trader.cancelLogin()) : null); });
app.post('/api/auth/check', async (req, res) => res.json(LIVE ? await trader.checkAuth() : null));
setTimeout(() => { for (const o of [...trader.orders].reverse()) latency.record(o); }, 5000);   // 启动时把内存里已有订单补记一次（按 id/tx 去重）
app.get('/api/latency-stats', (req, res) => res.json(latency.stats(Math.max(0.01, Number(req.query.days) || 1))));
// ---------- 桌面版：版本与自动更新（desktop/main.cjs 写 <用户目录>/update/status.json；重启 / 安装由启动器按退出码执行）----------
const APP_PKG_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
app.get('/api/app', (req, res) => {
  let st = null;
  if (APP_MODE) { try { st = JSON.parse(fs.readFileSync(path.join(APP_HOME, 'update', 'status.json'), 'utf8')); } catch { /* 还没检查过 */ } }
  res.json({ app: APP_MODE, platform: process.platform, coreVersion: APP_PKG_VERSION, shellVersion: process.env.PIUPIU_SHELL_VERSION || null, update: st });
});
// 退出码 75 = 重启后台服务（换上已下载的新内核）；76 = 安装已下载的新版客户端（Windows）。只有桌面版能用
app.post('/api/app/restart', (req, res) => { if (!APP_MODE) return res.status(400).json({ error: '仅桌面版支持重启更新' }); res.json({ ok: true }); setTimeout(() => process.exit(75), 300); });
app.post('/api/app/install-shell', (req, res) => { if (!APP_MODE || process.platform !== 'win32') return res.status(400).json({ error: '仅 Windows 桌面版支持自动安装' }); res.json({ ok: true }); setTimeout(() => process.exit(76), 300); });
app.get('/api/ping', (req, res) => res.json({ ok: true, app: APP_MODE, mode: MODE }));   // 健康检查（桌面版启动器等 Gateway 就绪用）
app.get('/api/state', (req, res) => res.json({ ...state(), holdings: holdSnap, orders: trader.orders.slice(0, 100), logs: agent.logs.slice(0, 150), records: agent.records, flow: market.named ? market.named(market.flow.slice(0, 80)) : market.flow.slice(0, 80) }));
// 持仓快照：后台每 5 秒算一次（下单 / 领取 / 转账结束后立刻再算），含所有钱包，通过 WebSocket 推给页面、也放进 /api/state；
// 页面打开详情时直接用快照，不再每次现算（现算要读钱包历史和链上报价，慢）
let holdSnap = null, holdBusy = false, holdAgain = false;
// ---------- 多钱包（同时下单）：一个后端进程里管理 N 个钱包槽位（docs/PLAN-MULTI-WALLET.md）----------
// 每个槽位 = 一个 baw 登录空间（钱包 1 用默认位置，其余用钥匙串命名空间 baw.piupiu.w<N> + 独立会话目录）。
// 页面上的一笔订单按「交易钱包」选择同时发给选中的几个钱包；买入 = 每个钱包各买 amount BNB；卖出 = 每个钱包卖自己持仓的同一比例
// 给页面看的登录进度（不含 qrCodeId 等内部字段）
const loginView = (l) => (l ? { id: l.id, slot: l.slot, state: l.state, urlForWeb: l.urlForWeb, pairingCode: l.pairingCode, expireAt: l.expireAt, message: l.message, address: l.address || null } : null);
// Agent ID 门槛盘：每个钱包持有几个门槛 NFT（地址列表 60 秒缓存）
let walletAddrs = { at: 0, list: [] };
async function nftHolders(nft) {
  if (Date.now() - walletAddrs.at > 60_000) walletAddrs = { at: Date.now(), list: trader.wallets.map((w) => ({ slot: w.slot, label: w.label, address: w.address })) };
  return Promise.all(walletAddrs.list.map(async (w) => ({ ...w, n: await trader.flapNft.holds(nft, w.address).catch(() => null) })));
}

async function refreshHoldSnap() {
  if (!holdings) return; if (holdBusy) { holdAgain = true; return; } holdBusy = true;
  try { holdSnap = await holdings.view(); broadcast({ type: 'holdings', data: holdSnap }); } catch { /* 下次再算 */ }
  holdBusy = false; if (holdAgain) { holdAgain = false; setTimeout(refreshHoldSnap, 200); }
}
if (holdings) { setTimeout(refreshHoldSnap, 3000); setInterval(refreshHoldSnap, 5000); }
app.get('/api/holdings', async (req, res) => {
  if (!holdings) return res.json({ rows: [], totals: {}, bnb: 0 });
  if (req.query.refresh) { trader.syncAt = 0; await trader.refreshBalance?.().catch(() => {}); await trader.syncHoldings?.().catch(() => {}); await holdings.loadHistory(true).catch(() => {}); holdSnap = await holdings.view(); broadcast({ type: 'holdings', data: holdSnap }); return res.json(holdSnap); }
  res.json(holdSnap || await holdings.view());
});
// 计价币余额与一键换回 BNB（只在点击后执行；先 preview 给确认框看报价）
app.get('/api/quote-balances', async (req, res) => { if (!LIVE || !trader.wallets?.length) return res.json([]); try { res.json(await trader.quoteBalances()); } catch (e) { if (/NOT_LOGGED_IN|SESSION_EXPIRED/.test(e.message)) return res.json([]); res.status(500).json({ error: e.message }); } });   // 未登录时没有可查的余额：返回空列表，不算错误
app.post('/api/quote-to-bnb/preview', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '仅实盘模式可用' }); try { res.json(await trader.quoteToBnbPreview(String(req.body.token || ''), Number(req.body.slippage) || 1)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/quote-to-bnb', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '仅实盘模式可用' }); res.json(await trader.quoteToBnb({ token: String(req.body.token || ''), slippage: Number(req.body.slippage) || 1 })); });
app.get('/api/trades/:token', async (req, res) => { try { const v = LIVE ? await market.tradesPage(req.params.token, Number(req.query.before) || 0, Math.min(500, Number(req.query.limit) || 100)) : null; v ? res.json(v) : res.status(404).json({ error: '没有数据' }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/trader/:token/:addr', async (req, res) => { try { const v = LIVE ? await market.traderStats(req.params.token, req.params.addr) : null; v ? res.json(v) : res.status(404).json({ error: '没有数据' }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/rpc-usage', (req, res) => res.json(rpcUsageLog));
app.get('/api/rpc-budget', async (req, res) => res.json(LIVE ? (await import('./engine/live/rpc.js')).nodeRealBudget() : null));   // NodeReal 本月用量 / 上限
// 界面设置整份（浏览器里的 terminal-prefs：交易预设、战壕筛选、声音、雷达筛选、提醒开关…）存后端 data/prefs.json：
// 换浏览器、清缓存、做成 Electron（另一个存储空间）都不丢。浏览器 localStorage 只当缓存；后端有就以后端为准。
// 写之前把旧的留一份 prefs.prev.json（写错了能回滚）；每天的备份也会带上它（engine/backup.js）
const PREFS_FILE = path.join(DATA_DIR_UI, 'prefs.json');
app.get('/api/prefs', (req, res) => { try { res.set('cache-control', 'no-store').json({ value: fs.readFileSync(PREFS_FILE, 'utf8') }); } catch { res.json({ value: null }); } });
app.put('/api/prefs', (req, res) => {
  const v = req.body?.value;
  if (typeof v !== 'string' || v.length > 90_000) return res.status(400).json({ error: '设置内容无效或过大' });
  try { const j = JSON.parse(v); if (!j || typeof j !== 'object' || typeof j.state !== 'object' || !Number.isFinite(Number(j.version))) throw new Error('bad'); } catch { return res.status(400).json({ error: '设置格式无效' }); }
  try {
    fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
    try { if (fs.readFileSync(PREFS_FILE, 'utf8') !== v) fs.copyFileSync(PREFS_FILE, PREFS_FILE.replace(/\.json$/, '.prev.json')); } catch { /* 第一次 */ }
    const tmp = PREFS_FILE + '.tmp'; fs.writeFileSync(tmp, v, { mode: 0o600 }); fs.renameSync(tmp, PREFS_FILE);
    uiPrefs = JSON.parse(v).state;   // 提醒判断（notifier）马上按新设置走
    res.json({ ok: true, at: Date.now() });
  } catch (e) { res.status(500).json({ error: '保存失败：' + e.message }); }
});
// 界面设置在内存里留一份给提醒判断用（战壕列筛选 / 声音、追踪声音、雷达筛选 / 提醒开关）；PUT 时更新
let uiPrefs = null;
try { uiPrefs = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')).state; } catch { /* 还没保存过：用默认值 */ }
// 提醒判断：战壕新币 / 钱包追踪 / 雷达新推荐 要不要提醒、响什么，都在 Gateway 决定，网页和以后的其他入口只负责呈现（engine/live/notifier.js）
const notifier = new Notifier({ getPrefs: () => uiPrefs, isBlocked: (t) => blocklist.has(t), autoMintOn: () => !!(LIVE && LIVE_TRADE && radar?.settings?.autoMint && radar.part.autoToday() < (radar.settings.autoMintMax ?? 10)) });   // 演示模式或今天已到上限：恢复为弹出提醒
notifier.on('radarMatch', (items) => { radar?.autoMint(items).catch((e) => console.error('autoMint:', e.message)); });   // 雷达自动铸造（engine/live/radar/index.js）
// 安装版：币安钱包命令行、Four 报价脚本首次启动时从官方源获取（engine/live/runtime.js）；装好后重新检查登录
const runtimeMod = await import('./engine/live/runtime.js');
const bawMod = await import('./engine/live/baw.js');
const startRuntime = () => runtimeMod.ensureRuntime({
  log: (m) => console.log(m),
  onChange: () => { bawMod.resetProfileSupport(); if (LIVE && runtimeMod.state.baw.cli && !runtimeMod.state.baw.installing) trader.checkAuth?.().catch(() => {}); },
}).catch((e) => console.error('[组件]', e.message));
if (APP_MODE) startRuntime();
// 页面布局偏好（左侧钱包追踪栏开 / 关、宽度）：服务器也存一份，浏览器数据丢了或换了地址也能恢复
const UI_PREFS = path.join(DATA_DIR_UI, 'ui-prefs.json');
app.get('/api/ui-prefs', (req, res) => { try { res.json(JSON.parse(fs.readFileSync(UI_PREFS, 'utf8'))); } catch { res.json({}); } });
app.post('/api/ui-prefs', (req, res) => {
  const b = req.body || {}, cur = (() => { try { return JSON.parse(fs.readFileSync(UI_PREFS, 'utf8')); } catch { return {}; } })();
  if (typeof b.trkPanel === 'boolean') cur.trkPanel = b.trkPanel; if (Number(b.trkPanelW) > 0) cur.trkPanelW = Math.min(640, Math.max(260, Number(b.trkPanelW)));
  try { fs.mkdirSync(path.dirname(UI_PREFS), { recursive: true }); fs.writeFileSync(UI_PREFS, JSON.stringify(cur)); } catch { /* ignore */ }
  res.json(cur);
});
// ---------- 追踪 + 跟单（只在实盘主后端；单进程多钱包后永远在这里）----------
let tracker = null;
if (LIVE) {
  const { Tracker } = await import('./engine/live/tracker.js');
  tracker = new Tracker({ market, provider: market.provider, placeOrder, log: (m) => console.log(m) });
  market.on('trade', (t) => tracker.onTrade(t).catch(() => {}));
  tracker.on('event', (e) => { broadcast({ type: 'track', data: e }); notifier.onTrackEvent(e, tracker.targets); });
  tracker.on('targets', (v) => broadcast({ type: 'trackTargets', data: v }));
  tracker.on('tasks', (v) => broadcast({ type: 'copyTasks', data: v }));
  tracker.on('log', (r) => broadcast({ type: 'copyLog', data: r }));
  tracker.on('reload', () => broadcast({ type: 'trackReload' }));   // 历史回补完成：页面重新拉追踪数据
  if (LIVE) {   // 已开盘（PancakeSwap）币的追踪：订阅追踪地址的 ERC-20 转账，从同一笔交易的池子 Swap 事件还原买卖
    const { DexTrackWatch } = await import('./engine/live/trackDex.js');
    tracker.dexWatch = new DexTrackWatch({ provider: market.provider, market, getTargets: () => tracker.targets.map((t) => t.address), onTrade: (tr) => tracker.onTrade(tr).catch(() => {}), log: (m) => console.log(m) });
    tracker.dexWatch.start(); tracker.on('targets', () => tracker.dexWatch.resub());
  }
  // 添加地址 = 从此刻起实时追踪；历史回补只按需手动触发（POST /api/track/backfill）
}
// ---------- Gang 新盘狙击（只在实盘主后端；默认关闭 + 模拟，本人在顶栏「狙击」模块里打开）----------
let sniper = null;
if (LIVE) {
  const { Sniper } = await import('./engine/live/sniper.js');
  const { wbnbTopUp } = await import('./engine/live/sniper.js');
  // 预备 WBNB：每个参与狙击的钱包各自补到目标
  const floatFn = (target, slots) => Promise.all(slots.map((slot) => trader.wallets.some((w) => w.slot === slot) ? wbnbTopUp(trader, target, LIVE_TRADE, slot).catch((e) => ({ wallet: `W${slot}`, error: e.message })) : { wallet: `W${slot}`, skip: '钱包不存在' }));
  sniper = new Sniper({ market, trader, placeOrder, floatFn, isBlocked: (t) => blocklist.has(t), log: (m) => console.log(m) });
  sniper.on('state', (v) => broadcast({ type: 'snipeState', data: v }));
  sniper.on('log', (r) => { broadcast({ type: 'snipeLog', data: r }); if (r.kind !== 'skip') console.log(`[狙击] ${r.symbol} ${r.kind}：${r.reason}`); });
}
// 交易节点保持热连接（每个钱包后端都做）：冷连接第一次读链要 0.7～1.8 秒，狙击时钱包 2 的后端也要马上能读曲线、模拟
if (LIVE) setInterval(() => { if (!sniper?.enabled && Date.now() - (globalThis.__warmAt || 0) < 300_000) return; globalThis.__warmAt = Date.now(); trader.gangV2?.provider?.getBlockNumber?.().catch(() => {}); }, 10_000);   // 狙击开着才每 10 秒保温；平时 5 分钟一次（以前常开，占交易节点额度）
// 每个钱包后端都有：把自己钱包的 WBNB 补到 target（主后端的狙击调用；只在 LIVE_TRADE=1 时真的包装）
app.post('/api/snipe/float', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '仅实盘模式可用' }); try { const { wbnbTopUp } = await import('./engine/live/sniper.js'); res.json(await wbnbTopUp(trader, Math.min(2, Math.max(0, Number(req.body?.target) || 0)), LIVE_TRADE)); } catch (e) { res.status(400).json({ error: e.message }); } });
let radar = null;   // 实例在 broadcast 定义之后创建（启动就推一帧，那时 broadcast 必须已存在）
const needSniper = (res) => { if (!sniper) { res.status(400).json({ error: '仅实盘模式支持狙击' }); return false; } return true; };
app.get('/api/snipe', (req, res) => { if (!needSniper(res)) return; res.json({ ...sniper.view(), log: sniper.log.slice(0, 300) }); });
app.post('/api/snipe', (req, res) => {   // { params } 改参数；{ enabled: true/false } 开 / 关（急停 = enabled:false）
  if (!needSniper(res)) return; const b = req.body || {};
  try { if (b.params) sniper.update(b.params); if (b.forget) sniper.forget(b.forget); if (b.enabled !== undefined) sniper.setEnabled(b.enabled === true); res.json(sniper.view()); } catch (e) { res.status(400).json({ error: e.message }); }
});
const needTracker = (res) => { if (!tracker) { res.status(400).json({ error: '仅实盘模式支持追踪和跟单' }); return false; } return true; };
app.get('/api/track', (req, res) => { if (!needTracker(res)) return; res.json({ ...tracker.targetsView(), feed: tracker.feed.slice(0, 300) }); });
app.get('/api/track/resolve', async (req, res) => {   // .ai / .bnb 域名 → 地址
  if (!LIVE) return res.status(400).json({ error: '仅实盘模式可用' });
  const name = String(req.query.name || '').trim().toLowerCase();
  if (/^0x[0-9a-f]{40}$/.test(name)) return res.json({ address: name, name: market.names?.peek?.(name) || null });
  if (!/^[a-z0-9-_.]+\.[a-z]+$/.test(name)) return res.status(400).json({ error: '请输入 .ai / .bnb 域名或 0x 开头的地址' });
  try { const { resolveDomain } = await import('./engine/live/baw.js'); const d = await resolveDomain(name); if (!d?.address) throw new Error('未解析到地址'); res.json({ address: String(d.address).toLowerCase(), name }); }
  catch (e) { res.status(400).json({ error: `解析失败：${e.message}` }); }
});
app.get('/api/track/feed', (req, res) => { if (!needTracker(res)) return; res.json(tracker.feedPage({ before: Number(req.query.before) || undefined, limit: Math.min(300, Number(req.query.limit) || 100) })); });   // 追踪历史往回翻
app.post('/api/track/targets', (req, res) => {
  if (!needTracker(res)) return; const b = req.body || {};
  try { if (b.remove) tracker.removeTarget(b.address); else tracker.addTarget(b); res.json(tracker.targetsView()); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/track/backfill', async (req, res) => {   // 手动补某个地址最近 24 小时（只写历史、不响提示音、不触发跟单）
  if (!needTracker(res)) return;
  const a = String(req.body?.address || '').toLowerCase();
  if (!tracker.target(a)) return res.status(404).json({ error: '追踪地址不存在' });
  try { res.json(await tracker.backfill([a])); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/copy', (req, res) => { if (!needTracker(res)) return; res.json({ ...tracker.tasksView(), log: tracker.log.slice(0, 300) }); });
app.post('/api/copy/tasks', (req, res) => {   // 新建：一律暂停 + 模拟；改参数 / 启动 / 暂停 / 关闭
  if (!needTracker(res)) return; const b = req.body || {};
  try { res.json(b.id && b.delete ? tracker.deleteTask(b.id) : b.id ? tracker.updateTask(b.id, b) : tracker.createTask(b)); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/copy/pause-all', (req, res) => { if (!needTracker(res)) return; tracker.setAllPaused(req.body?.paused !== false); res.json(tracker.tasksView()); });
app.get('/api/wallet-info', (req, res) => res.json(LIVE ? { slot: 1, label: trader.primaryWallet?.()?.label || WALLET_LABEL, address: trader.primaryWallet?.()?.address || null, auth: trader.status?.auth?.state || 'checking' } : null));
// 钱包安全设置（只读，baw wallet settings）：开发者模式、异常交易处理、可交易范围、今日额度、登录到期。按钱包读（?slot=N，默认主钱包），60 秒缓存
const walletSettingsCache = new Map();
app.get('/api/wallet-settings', async (req, res) => {
  if (!LIVE) return res.json(null);
  const slot = Number(req.query.slot) || trader.primaryWallet?.()?.slot || 1;
  if (trader.slotAuth?.get?.(slot)?.state !== 'ok') return res.status(401).json({ error: '该钱包未登录' });
  const key = String(slot);
  const c = walletSettingsCache.get(key);
  try { res.json(await readWalletSettings(slot, !!req.query.refresh)); } catch (e) { res.status(400).json({ error: e.message }); }
});
async function readWalletSettings(slot, refresh = false) {
  const c = walletSettingsCache.get(String(slot));
  if (c && Date.now() - c.at < 60_000 && !refresh) return c.v;
  const { runBaw } = await import('./engine/live/baw.js');
  const v = (await runBaw(['wallet', 'settings'], { timeoutMs: 20_000, slot })).data || {};
  walletSettingsCache.set(String(slot), { at: Date.now(), v });
  return v;
}
// ---------- 首次使用检查（web/src/components/SetupGuide.tsx）----------
// 交易前要满足的条件逐项检查：装了币安钱包命令行（baw）→ 扫码登录 → 领了 Agent ID → 开了开发者模式 → 可交易代币选「全部」。
// 只读：Agent ID / 开发者模式 / 交易范围只能在币安 App 里改，这里只告诉用户去哪里改。「稍后再说」记在 data/setup.json
const SETUP_FILE = path.join(DATA_DIR_UI, 'setup.json');
const setupState = () => { try { return JSON.parse(fs.readFileSync(SETUP_FILE, 'utf8')); } catch { return {}; } };
app.get('/api/setup', async (req, res) => {
  const T = (k, p) => translate(req.query.lang || uiPrefs?.lang, k, p);
  const out = { appMode: APP_MODE, platform: process.platform, home: APP_MODE ? APP_HOME : null, live: LIVE, liveTrade: LIVE_TRADE, dismissedAt: setupState().dismissedAt || null, steps: [] };
  if (!LIVE) return res.json({ ...out, done: true });
  const { profileSupport, resetProfileSupport } = bawMod;
  if (req.query.refresh) resetProfileSupport();
  const prof = profileSupport();
  const rt = runtimeMod.state;
  const slot = trader.primaryWallet?.()?.slot || 1;
  const auth = trader.slotAuth?.get?.(slot) || trader.status?.auth || {};
  const loggedIn = auth.state === 'ok';
  let ws = null, wsErr = null;
  if (loggedIn) { try { ws = await readWalletSettings(slot, !!req.query.refresh); } catch (e) { wsErr = e.message; } }
  const dev = ws?.devMode || {};
  out.wallet = loggedIn ? { slot, address: auth.address || trader.primaryWallet?.()?.address || null, agentId: auth.agentId || null } : null;
  out.steps = [
    APP_MODE
      ? { key: 'baw', ok: rt.baw.installing ? null : !!rt.baw.cli, installing: rt.baw.installing, retry: !!rt.baw.error,
        detail: rt.baw.installing ? T('sd.installing') : rt.baw.cli ? T('sd.ready', { v: rt.baw.version }) : rt.baw.error || T('sd.notInstalled') }
      : { key: 'baw', ok: !!prof.version, detail: prof.version ? T('sd.installed', { v: prof.version }) : T('sd.noBaw') },
    { key: 'login', ok: loggedIn, detail: loggedIn ? (auth.agentId || auth.address || T('sd.loggedIn')) : auth.state === 'checking' ? T('sd.checking') : T('sd.notLoggedIn') },
    { key: 'agentId', ok: loggedIn ? !!auth.agentId : null, detail: !loggedIn ? T('sd.afterLogin') : auth.agentId ? auth.agentId : T('sd.noAgentId') },
    { key: 'devMode', ok: ws ? !!dev.enabled : null, detail: !ws ? (wsErr ? T('sd.readFailed', { err: wsErr }) : T('sd.afterLogin')) : dev.enabled ? T('sd.devOn') + (dev.expiresAt ? T('sd.devExpires', { date: new Date((typeof dev.expiresAt === 'number' ? dev.expiresAt * 1000 : Date.parse(dev.expiresAt))).toLocaleDateString((req.query.lang || uiPrefs?.lang) === 'en' ? 'en-US' : 'zh-CN') }) : '') + (dev.dailyLimit != null ? T('sd.devLimit', { n: dev.dailyLimit }) : '') : T('sd.devOff') },
    { key: 'abnormal', ok: ws ? ws.abnormalTxnHandling === 'NeedConfirmation' : null, detail: !ws ? (wsErr ? T('sd.readFailed', { err: wsErr }) : T('sd.afterLogin')) : ws.abnormalTxnHandling === 'NeedConfirmation' ? T('sd.needConfirm') : T('sd.autoReject') },
    { key: 'tradeAll', ok: ws ? !!ws.tradeAllTokens : null, detail: !ws ? (wsErr ? T('sd.readFailed', { err: wsErr }) : T('sd.afterLogin')) : ws.tradeAllTokens ? T('sd.allTokens') : T('sd.whitelist') },
    ...(APP_MODE ? [{ key: 'four', ok: rt.four.downloading || (rt.baw.installing && !rt.four.ok) ? null : rt.four.ok, retry: !!rt.four.error, detail: rt.four.ok ? T('sd.fourReady') : rt.four.downloading ? T('sd.downloading') : rt.four.error || T('sd.waiting') }] : []),
  ];
  out.done = out.steps.filter((x) => x.key !== 'abnormal').every((x) => x.ok === true);   // 异常交易处理只是建议，不算没准备好
  res.json(out);
});
app.post('/api/setup', (req, res) => {
  if (req.body?.retry) { if (APP_MODE) startRuntime(); return res.json({ ok: true }); }   // 组件安装失败后「重试」
  try { const v = { ...setupState(), dismissedAt: req.body?.dismiss ? Date.now() : null }; fs.mkdirSync(path.dirname(SETUP_FILE), { recursive: true }); fs.writeFileSync(SETUP_FILE, JSON.stringify(v)); res.json(v); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// ---------- 钱包槽位接口（多钱包方案 §4.5）----------
const slotsOK = (res) => { if (!LIVE) { res.status(400).json({ error: '仅实盘模式支持' }); return false; } return true; };
const pushWallets = (res, v) => { broadcast({ type: 'wallets', data: v }); res.json(v); };
app.get('/api/wallets', (req, res) => { if (!slotsOK(res)) return; res.json(trader.slotsView()); });
app.post('/api/wallets/add', async (req, res) => {   // 添加钱包 = 分配新槽位并开始扫码登录
  if (!slotsOK(res)) return;
  try {
    const { add, list } = await import('./engine/live/walletSlots.js');
    const sup = (await import('./engine/live/baw.js')).profileSupport();
    if (!sup.ok) return res.status(400).json({ error: `baw ${sup.version || '?'} 尚未完成多钱包兼容性验证，暂不支持添加钱包（主钱包不受影响）` });
    // 先复用之前扫码没完成的空槽位（从没绑定过地址、也没登录），避免每取消一次就多占一个 W 号
    const reuse = list().find((x) => x.slot > 1 && !x.pinned && trader.slotAuth?.get?.(x.slot)?.state !== 'ok');
    if (!reuse && list().length >= 8) return res.status(400).json({ error: '最多 8 个钱包' });
    const s = reuse || add();
    const login = await trader.startLogin(s.slot);
    pushWallets(res, { ...trader.slotsView(), added: s.slot, login: loginView(login) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/wallets/:slot/login', async (req, res) => {   // 已有槽位重新扫码；{ cancel: true } 取消
  if (!slotsOK(res)) return;
  try { pushWallets(res, { ...trader.slotsView(), login: loginView(req.body?.cancel ? trader.cancelLogin(Number(req.params.slot)) : await trader.startLogin(Number(req.params.slot))) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/wallets/:slot/logout', async (req, res) => { if (!slotsOK(res)) return; try { await trader.logoutWallet(Number(req.params.slot)); pushWallets(res, trader.slotsView()); } catch (e) { res.status(400).json({ error: e.message }); } });
app.delete('/api/wallets/:slot', async (req, res) => {   // 移除槽位（危险，二次确认在页面上做）
  if (!slotsOK(res)) return;
  try {
    const slot = Number(req.params.slot);
    // 把它从跟单 / 狙击的「下单钱包」里去掉，任务只剩这个钱包时暂停并提示
    if (tracker) for (const t of tracker.tasksView().tasks || []) if ((t.wallets || []).includes(slot)) {
      const left = t.wallets.filter((x) => x !== slot);
      if (!left.length) { tracker.updateTask(t.id, { paused: true, wallets: [1] }); console.log(`[钱包] 跟单任务「${t.name}」只剩被移除的 W${slot}，已暂停`); }
      else tracker.updateTask(t.id, { wallets: left });
    }
    if (sniper) { const ws = (sniper.view().params?.wallets || []).filter((x) => x !== slot); sniper.update({ wallets: ws.length ? ws : [1] }); }
    await trader.removeWallet(slot);
    pushWallets(res, trader.slotsView());
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/wallets/:slot', async (req, res) => {   // 改备注 / 设为主钱包
  if (!slotsOK(res)) return;
  try {
    const { update } = await import('./engine/live/walletSlots.js');
    update(Number(req.params.slot), { label: req.body?.label, primary: req.body?.primary === true });
    pushWallets(res, trader.slotsView());
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/wallets/trade-slots', (req, res) => {   // 全局「交易钱包」选择（一键买卖共用）
  if (!slotsOK(res)) return;
  try { const v = trader.setTradeSlots(Array.isArray(req.body?.slots) ? req.body.slots : []); pushWallets(res, trader.slotsView()); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// 旧接口兼容：按 slot 发起 / 取消登录
app.post('/api/wallets/login', async (req, res) => {
  if (!slotsOK(res)) return;
  const slot = Number(req.body?.slot) || 1, cancel = !!req.body?.cancel;
  try { pushWallets(res, { ...trader.slotsView(), login: loginView(cancel ? trader.cancelLogin(slot) : await trader.startLogin(slot)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
trader.on?.('wallets', () => { if (LIVE) broadcast({ type: 'wallets', data: trader.slotsView() }); });
app.get('/api/lookup/:a', async (req, res) => {
  // 搜索：最多等 1.5 秒（链上查 Four 盘）；查不到 = 不是本终端跟踪的内盘（外盘 / 已毕业 / 其他平台），页面改为打开 GMGN
  const t = LIVE ? await Promise.race([market.lookup(req.params.a).catch(() => null), new Promise((r) => setTimeout(() => r(null), 1500))]) : (market.get(req.params.a) ? market.summary(market.get(req.params.a)) : null);
  t ? res.json(t) : res.status(404).json({ error: '未找到该代币', external: true });
});
app.get('/api/token/:a', async (req, res) => {
  if (LIVE) await market.refresh(req.params.a);
  const d = market.detail(req.params.a); if (!d) return res.status(404).json({ error: '代币不存在' });
  if (LIVE && d.nftGate) d.nftGate = { ...d.nftGate, wallets: await nftHolders(d.nftGate.nft).catch(() => []) };
  res.json(d);
});
// 地址 → 域名本地映射（前端定时拉取，ver 不变就返回空）
// 代币头像代理缓存：/api/img?u=<url> → data/img/<sha1>.<ext>，命中直接读盘，浏览器端 immutable 长缓存
const IMG_DIR = path.join(DATA_DIR_UI, 'img');   // 跟着数据目录走（安装版在用户目录里）
fs.mkdirSync(IMG_DIR, { recursive: true });
// 缓存上限（默认 400MB，IMG_CACHE_MAX_MB 可改）：超过就按「最久没用」删到 80%。命中时顺手刷新修改时间当作最近使用
const IMG_MAX = Math.max(50, Number(process.env.IMG_CACHE_MAX_MB) || 400) * 1048576;
function pruneImg() {
  try {
    const rows = [];
    for (const f of fs.readdirSync(IMG_DIR)) { if (f.endsWith('.json')) continue; try { const st = fs.statSync(path.join(IMG_DIR, f)); rows.push({ f, size: st.size, t: st.mtimeMs }); } catch { /* 刚被删 */ } }
    let total = rows.reduce((s, r) => s + r.size, 0);
    if (total <= IMG_MAX) return;
    rows.sort((a, b) => a.t - b.t);
    let n = 0;
    for (const r of rows) { if (total <= IMG_MAX * 0.8) break; const key = r.f.replace(/\.[a-z]+$/, ''); for (const x of [r.f, key + '.json']) { try { fs.unlinkSync(path.join(IMG_DIR, x)); } catch { /* ignore */ } } total -= r.size; n++; }
    console.log(`[图片缓存] 超过 ${(IMG_MAX / 1048576).toFixed(0)}MB，已清掉最久没用的 ${n} 张`);
  } catch (e) { console.warn(`[图片缓存] 清理失败：${e.message}`); }
}
setTimeout(pruneImg, 20_000); setInterval(pruneImg, 6 * 3600_000).unref?.();
const imgInflight = new Map(), imgFail = new Map();
const IPFS_GW = EP.ipfs;
// 只代理这些图床（含子域名），只走 https；别的地址一律拒绝（防止被当成访问内网 / 任意网站的跳板）。IMG_HOSTS 可追加（逗号分隔）
const IMG_HOSTS = ['four.meme', 'space.id', 'mypinata.cloud', 'gang.fun', 'gangfun-ipfs.tos-ap-southeast-1.bytepluses.com', 'shrine.trade', 'ipfs.io', 'dweb.link', 'cloudflare-ipfs.com', 'pbs.twimg.com', 'dd.dexscreener.com', 'cdn.dexscreener.com', ...IPFS_GW.map((u) => { try { return new URL(u).hostname; } catch { return ''; } }).filter(Boolean), ...String(process.env.IMG_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)];
const imgHostOk = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && !x.username && !x.password && (!x.port || x.port === '443') && IMG_HOSTS.some((h) => x.hostname === h || x.hostname.endsWith('.' + h)); } catch { return false; } };
// 只收位图：按文件头判断真实格式（不信对方的 Content-Type），SVG（可以带脚本）一律不收
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' };
const sniffImg = (b) => {
  const s = (i, j) => b.subarray(i, j).toString('latin1');
  if (b[0] === 0x89 && s(1, 4) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (s(0, 4) === 'GIF8') return 'image/gif';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'image/webp';
  if (s(4, 8) === 'ftyp' && /^avi[fs]$/.test(s(8, 12))) return 'image/avif';
  return null;
};
async function imgFetchOne(u) {
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 8000);
  try {
    let r;
    for (let hop = 0; ; hop++) {   // 跳转自己跟，每一跳都要在白名单里
      if (!imgHostOk(u)) throw new Error('host not allowed');
      r = await fetch(u, { signal: ac.signal, redirect: 'manual', headers: { accept: 'image/*' } });
      if (r.status < 300 || r.status >= 400) break;
      if (hop >= 3 || !r.headers.get('location')) throw new Error('redirect');
      u = new URL(r.headers.get('location'), u).href;
    }
    if (!r.ok) throw new Error('http ' + r.status);
    if (Number(r.headers.get('content-length') || 0) > 2e6) throw new Error('too big');
    const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > 2e6 || !buf.length) throw new Error('size');
    const ct = sniffImg(buf); if (!ct) throw new Error('not raster image');
    return { ct, buf };
  } finally { clearTimeout(tm); }
}
async function imgFetch(u) {
  const m = u.match(/\/ipfs\/(.+)$/); const urls = [u, ...(m ? IPFS_GW.map((g) => g + m[1]).filter((x) => x !== u) : [])];
  let err; for (const x of urls) { try { return await imgFetchOne(x); } catch (e) { err = e; } } throw err;
}
app.get('/api/img', async (req, res) => {
  const u = String(req.query.u || '');
  if (u.length > 2000 || !imgHostOk(u)) return res.status(403).set('Cache-Control', 'public, max-age=600').end();
  const key = crypto.createHash('sha1').update(u).digest('hex'); const meta = path.join(IMG_DIR, key + '.json');
  // nosniff + 沙箱 CSP：就算文件内容有问题，浏览器也不会把它当网页 / 脚本执行
  const send = (m) => { res.set({ 'Content-Type': m.ct, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Img-Cache': m.hit ? 'HIT' : 'MISS', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': `inline; filename="${m.file}"` }); res.sendFile(path.join(IMG_DIR, m.file)); };
  try { const m = JSON.parse(fs.readFileSync(meta, 'utf8')); if (EXT[m.ct] && /^[0-9a-f]{40}\.[a-z]+$/.test(m.file) && fs.existsSync(path.join(IMG_DIR, m.file))) { const ip = path.join(IMG_DIR, m.file); try { if (Date.now() - fs.statSync(ip).mtimeMs > 3600_000) { const now = new Date(); fs.utimes(ip, now, now, () => {}); } } catch { /* ignore */ } return send({ ...m, hit: true }); } } catch { /* 未缓存 */ }   // 旧缓存里的 SVG 等非位图不再返回
  if ((imgFail.get(key) || 0) > Date.now()) return res.status(404).set('Cache-Control', 'public, max-age=600').end();
  try {
    let p = imgInflight.get(key);
    if (!p) { p = imgFetch(u).then(({ ct, buf }) => { const file = key + '.' + (EXT[ct] || 'img'); fs.writeFileSync(path.join(IMG_DIR, file), buf); const m = { ct, file, url: u }; fs.writeFileSync(meta, JSON.stringify(m)); return m; }).finally(() => imgInflight.delete(key)); imgInflight.set(key, p); }
    send(await p);
  } catch { imgFail.set(key, Date.now() + 600_000); res.status(404).set('Cache-Control', 'public, max-age=600').end(); }
});
// 推文预览（战壕卡片上悬浮推特图标时显示）：经 fxtwitter 公开接口读推文 / 账号资料，10 分钟缓存。只接受 x.com / twitter.com 链接
const tweetCache = new Map();
app.get('/api/tweet', async (req, res) => {
  let u; try { u = new URL(String(req.query.u || '')); } catch { return res.status(400).json({ error: 'bad_url' }); }
  if (!/^(www\.|mobile\.)?(x|twitter)\.com$/i.test(u.hostname)) return res.status(400).json({ error: 'not_x' });
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] === 'i' && parts[1] === 'communities') return res.json({ kind: 'community', url: u.href, id: parts[2] || null });
  const user = parts[0] && /^[A-Za-z0-9_]{1,15}$/.test(parts[0]) ? parts[0] : null;
  const sid = parts[1] === 'status' && /^\d+$/.test(parts[2] || '') ? parts[2] : null;
  if (!user) return res.json({ kind: 'other', url: u.href });
  const key = sid || '@' + user.toLowerCase(); const hit = tweetCache.get(key);
  if (hit && Date.now() - hit.at < 600_000) return res.json(hit.v);
  const au = (a) => a && ({ name: a.name, handle: a.screen_name, avatar: a.avatar_url || null, followers: a.followers ?? null, following: a.following ?? null, joined: a.joined || null, bio: a.description || '' });
  try {
    const j = await fetch(`${EP.fxtwitter}/${user}${sid ? '/status/' + sid : ''}`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
    let v;
    if (sid && j.tweet) {
      const tw = j.tweet, img = (x) => (x?.media?.photos?.[0]?.url || x?.media?.videos?.[0]?.thumbnail_url || null);
      v = { kind: 'status', url: u.href, author: au(tw.author), text: tw.text || '', createdAt: tw.created_timestamp ? tw.created_timestamp * 1000 : null, likes: tw.likes ?? 0, retweets: tw.retweets ?? 0, replies: tw.replies ?? 0, image: img(tw),
        quote: tw.quote ? { author: au(tw.quote.author), text: tw.quote.text || '', createdAt: tw.quote.created_timestamp ? tw.quote.created_timestamp * 1000 : null } : null };
    } else if (!sid && j.user) v = { kind: 'user', url: u.href, author: au(j.user) };
    else v = { kind: 'gone', url: u.href };   // 推文删了 / 账号没了
    tweetCache.set(key, { at: Date.now(), v }); if (tweetCache.size > 2000) tweetCache.delete(tweetCache.keys().next().value);
    res.json(v);
  } catch (e) { res.status(502).json({ error: 'fetch_failed', message: e.message }); }
});

app.get('/api/names', (req, res) => {
  const n = market.names; if (!n) return res.json({ ver: 0, names: {} });
  if (Number(req.query.ver) === n.ver) return res.json({ ver: n.ver });
  res.json({ ver: n.ver, names: n.all() });
});

app.get('/api/preview', async (req, res) => {
  const q = req.query;
  res.json(await trader.preview({ walletId: q.wallet, token: q.token, side: q.side, amount: Number(q.amount), slippage: Number(q.slippage || 35) }));
});

// 按代币总量百分比买入：反推需要多少 BNB（多轮报价逼近）
// 买「总量的 X%」需要多少 BNB（按这个钱包自己的持仓上限 / 余额 / 单笔上限压好）。多钱包时每个钱包各自算
async function costForPct(q) {
  q = q || {}; let pct = Math.min(100, Number(q.pct) || 0);
  if (!(pct > 0)) return ({ bnb: 0 });
  // Four Agent 专属币每个钱包最多持有总量 1%，超过的部分买不到，按 1% 算，避免反推出离谱的 BNB
  const tk = market.get?.(q.token); let capped = false; const asked = pct; const notes = [];
  // Four / Gang 都是单钱包最多持有总量 1%
  if ((tk?.platform === 'four' || tk?.platform === 'gang') && pct > 1) { pct = 1; capped = true; }
  let target = 1_000_000_000 * pct / 100;
  // Four 单钱包最多 1%：扣掉当前持仓，只买剩下的部分
  if (tk?.platform === 'four') {
    try {
      const w = trader.wallet?.(q.wallet); const mine = w ? await trader.tokenBal(w, tk.address) : 0;
      const room = (1e7 - (mine || 0)) * 0.99;
      if (room <= 1e7 * 0.001) return ({ bnb: 0, capReached: true, error: '已达单钱包上限 1%' });
      if (target > room) { target = room; capped = true; pct = +(room / 1e7).toFixed(3); }
    } catch { /* 读不到持仓就按 1% */ }
  }
  // Gang 老盘：合约 walletRoom 直接给出这个钱包还能买多少
  if (tk?.source === 'gang' && (trader.useGang?.(tk) || trader.useGangV2?.(tk))) {
    try {
      const w = trader.wallet?.(q.wallet);
      const room = !w ? 1e7 : (trader.useGangV2(tk) ? Number(await trader.gangV2.room(tk.address, w.address)) / 1e18 : await trader.gangTrade.walletRoom(tk.address, w.address)) * 0.99;
      if (room <= 1e7 * 0.001) return ({ bnb: 0, capReached: true, error: '已达单钱包上限 1%' });
      if (target > room) { target = room; capped = true; pct = +(room / 1e7).toFixed(3); }
    } catch { /* 读不到额度就按 1% */ }
  }
  // Flap Agent 曲线有单钱包持仓上限 maxSharesPerWallet：目标不超过「上限 - 已持有」再留 1% 余量
  if (tk?.market && tk.source === 'agent-curve' && trader.portal?.provider) {
    try {
      const { ethers } = await import('ethers');
      const w = trader.wallet?.(q.wallet);
      const c = new ethers.Contract(tk.market, ['function maxSharesPerWallet() view returns (uint256)', 'function sharesOf(address) view returns (uint256)'], trader.portal.provider);
      const [cap, mine] = await Promise.all([c.maxSharesPerWallet().catch(() => 0n), w ? c.sharesOf(w.address).catch(() => 0n) : 0n]);
      if (cap > 0n) {
        const room = Number(ethers.formatEther(cap - (mine > cap ? cap : mine))) * 0.99;
        if (room <= 0) return ({ bnb: 0, capReached: true, error: '已达单钱包持仓上限' });
        if (target > room) { target = room; capped = true; pct = +(room / 1e7).toFixed(3); }
      }
    } catch { /* 读不到上限就按原目标 */ }
  }
  try {
    let a = 0.01, ok = false, lastErr = null;
    for (let i = 0; i < 6; i++) {
      const p = await trader.preview({ walletId: q.wallet, token: q.token, side: 'buy', amount: a, slippage: Number(q.slippage || 35) });
      if (!(p?.out > 0)) { lastErr = p?.error || null; break; }
      ok = true;
      const next = a * target / p.out;
      if (Math.abs(next - a) / a < 0.002) { a = next; break; }
      a = next;
    }
    if (!ok) return ({ bnb: 0, error: `无法获取报价${lastErr ? '：' + lastErr : ''}` });
    // 下单前一次性把金额压到能成交的范围：持仓上限 → 单笔上限 → 余额（留 0.002 BNB 付 gas），不让后端先失败再重试
    if (capped) notes.push(asked > 1 && pct >= 0.98 ? `${asked}% 超过单钱包上限 1%，已按 1% 买入` : `${asked}% 超过单钱包剩余额度，已按剩余额度（约 ${pct}%）买入`);
    const maxTrade = LIVE ? Number(trader.status?.maxTradeBnb) || 0 : 0;
    if (maxTrade > 0 && a > maxTrade) { a = maxTrade; notes.push(`超过单笔上限 ${maxTrade} BNB，已按 ${maxTrade} BNB 买入`); }
    const w = trader.wallet?.(q.wallet); const bal = Number(w?.bnb) || 0;
    if (LIVE && bal > 0 && a > bal - 0.002) { a = Math.max(0, bal - 0.002); notes.push(`BNB 余额不足，已按余额 ${a.toFixed(4)} BNB 买入`); }
    if (!(a > 0)) return ({ bnb: 0, error: 'BNB 余额不足' });
    return ({ bnb: +a.toFixed(6), tokens: target, pct, capped, note: notes.join('；') || null });
  } catch (e) { return { bnb: 0, error: e.message }; }
}
app.get('/api/cost-for-pct', async (req, res) => res.json(await costForPct(req.query)));

// 下单（页面、跟单都走这里）。slots：指定哪几个钱包下单（跟单任务用）；不填 = 所有开了「参与下单」的钱包
// 下单（页面、跟单、狙击、条件单都走这里）。slots：指定哪几个钱包槽位下单（跟单 / 狙击任务用）；
// 不填 = 全局「交易钱包」选择（trader.tradeSlots()）。买入 = 每个钱包各买 amount BNB（或按 pctSupply 各自报价）；
// 卖出 = 每个钱包卖自己持仓的同一比例。未登录 / 不存在的槽位跳过（生成一条 skipped 订单说明原因），其他照常；
// 一次多钱包下单共用一个 batchId（页面把同一批的提示合成一个）
async function placeOrder({ token, side, amount, slippage, via, clientTs, pctSupply, slots = null, source = '手动', symbol = null, mev = null, gas = null }) {
  if (LIVE && token && !market.get(token)) await market.lookup(token).catch(() => null);
  if (!LIVE) return [await trader.execute({ walletId: 'baw', token, side, amount, slippage, source: String(source || '手动').slice(0, 40), via: via === 'quick' ? 'quick' : null, clientTs: Number(clientTs) || null, symbol: symbol ? String(symbol).slice(0, 32) : null, mev: typeof mev === 'boolean' ? mev : null, gas })];
  const t = market.get(token), sym = (t?.symbol && t.symbol !== '?' ? t.symbol : symbol) || '';
  const want = [...new Set((slots || trader.tradeSlots()).map(Number))];
  const active = want.filter((s) => trader.wallets.some((x) => x.slot === s));
  const batchId = active.length >= 2 ? randomBytes(4).toString('hex') : null;   // 只有一个钱包时和单钱包体验完全一样（不进批量提示）
  const skip = (slot, label, reason) => { const o = { id: `w${slot}-skip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ts: Date.now(), batchId, wallet: label, walletSlot: slot, token, symbol: sym, side, amount, status: 'failed', skipped: true, reason: `${reason}，已跳过` }; trader.orders.unshift(o); if (trader.orders.length > 300) trader.orders.length = 300; broadcast({ type: 'order', data: o }); return o; };
  const jobs = [];
  for (const slot of want) {
    const w = trader.wallets.find((x) => x.slot === slot);
    if (!w) continue;   // 槽位不存在（比如狙击默认带 W2 但还没添加）：跟旧版一样静默忽略
    if (trader.slotAuth.get(slot)?.state !== 'ok') { jobs.push(Promise.resolve([skip(slot, w.label, `W${slot} 未登录`)])); continue; }
    jobs.push((async () => {
      let amt = amount;
      if (side === 'buy' && Number(pctSupply) > 0) {   // 每个钱包自己报价：买到总量的 X% 要多少 BNB（含各自的持仓上限 / 余额 / 单笔上限）
        const c = await costForPct({ wallet: w.id, token, pct: Number(pctSupply), slippage });
        if (!(c.bnb > 0)) return [skip(slot, w.label, c.capReached ? `已达单钱包上限：${c.error}` : `买 ${pctSupply}% 报价失败：${c.error || '无法获取报价'}`)];
        amt = c.bnb;
      }
      return [await trader.execute({ walletId: w.id, token, side, amount: amt, slippage, source: String(source || '手动').slice(0, 40), via: via === 'quick' ? 'quick' : null, clientTs: Number(clientTs) || null, symbol: symbol ? String(symbol).slice(0, 32) : null, batchId, mev: typeof mev === 'boolean' ? mev : null, gas })];
    })().catch((e) => [skip(slot, w.label, e.message)]));
  }
  const out = (await Promise.all(jobs)).flat();
  if (!out.length) throw new Error('没有可用的钱包（未登录或钱包不存在）');
  return out;
}
app.post('/api/order', async (req, res) => {
  const b = req.body || {};
  try { res.json(await placeOrder({ token: b.token, side: b.side, amount: b.amount, slippage: b.slippage, via: b.via, clientTs: b.clientTs, pctSupply: b.pctSupply, slots: Array.isArray(b.slots) ? b.slots : null, source: b.source || '手动', symbol: b.symbol || null, mev: typeof b.mev === 'boolean' ? b.mev : null, gas: typeof b.gas === 'string' ? b.gas : null })); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// 多钱包下单前的预览：按钱包给预计获得 / 跳过原因（确认框分行显示用）。只报价，不发交易
app.post('/api/order/preview', async (req, res) => {
  const b = req.body || {};
  if (!LIVE) return res.json({ rows: [] });
  try {
    if (b.token && !market.get(b.token)) await market.lookup(b.token).catch(() => null);
    const want = [...new Set((Array.isArray(b.slots) ? b.slots : trader.tradeSlots()).map(Number))];
    const rows = [];
    for (const slot of want) {
      const w = trader.wallets.find((x) => x.slot === slot);
      if (!w) continue;
      if (trader.slotAuth.get(slot)?.state !== 'ok') { rows.push({ slot, label: w.label, skip: '未登录，本次不参与' }); continue; }
      let amt = Number(b.amount) || 0;
      if (b.side === 'buy' && Number(b.pctSupply) > 0) { const c = await costForPct({ wallet: w.id, token: b.token, pct: Number(b.pctSupply), slippage: b.slippage }); if (!(c.bnb > 0)) { rows.push({ slot, label: w.label, skip: c.capReached ? `已达单钱包上限：${c.error}` : `报价失败：${c.error || '无法获取报价'}` }); continue; } amt = c.bnb; }
      else if (b.side === 'buy' && !(amt > 0)) { rows.push({ slot, label: w.label, skip: '金额无效' }); continue; }
      const p = await trader.preview({ walletId: w.id, token: b.token, side: b.side, amount: b.side === 'sell' ? Number(b.amount) : amt, slippage: b.slippage });
      const noBal = b.side === 'sell' && /没有可卖出的余额/.test(String(p?.note || ''));
      rows.push({ slot, label: w.label, amountIn: p?.amountIn ?? (b.side === 'buy' ? amt : Number(b.amount)), out: p?.out ?? null, minOut: p?.minOut ?? null, note: p?.note || null, error: p?.error || null, skip: p?.error ? p.error : (noBal ? '无持仓，本次不参与' : null) });
    }
    res.json({ rows });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// 单币规则（发射后领取 / 转出）。转账要本人在页面上点「确认」才会变成 armed
app.get('/api/token-rules', (req, res) => res.json(LIVE ? trader.rulesView() : {}));
// 页面只能改「是否领取」和「转出确认状态」；转出地址、自动标记、执行状态都只由服务器写（地址固定为 AUTO_TRANSFER_TO）
app.post('/api/token-rules', (req, res) => {
  if (!LIVE) return res.status(400).json({ error: '仅实盘模式可用' });
  try {
    if (req.body.remove) return res.json(trader.setRule(req.body.token, null));
    const p = req.body.patch || {}, patch = {};
    if (p.transfer !== undefined) { if (!['armed', 'confirm', 'off'].includes(p.transfer)) throw new Error('转出方式参数无效'); patch.transfer = p.transfer; }
    if (p.claim !== undefined) patch.claim = p.claim === true;
    if (patch.transfer === 'armed') { const r = trader.rules()[String(req.body.token || '').toLowerCase()]; if (!r?.to) throw new Error('这个币没有服务器生成的转出规则，不能确认转出'); console.log(`[tokenRule] 页面确认转出 ${r.symbol} → ${r.to}`); }
    res.json(trader.setRule(req.body.token, patch));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/favorites', (req, res) => res.json(favorites.view()));
app.post('/api/favorites', (req, res) => { try { const v = favorites.op(req.body || {}); broadcast({ type: 'favorites', data: v }); res.json(v); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/approvals', async (req, res) => { if (!LIVE) return res.json([]); try { res.json(await trader.allowancesView()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/approvals/revoke', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '仅实盘模式可用' }); try { res.json(await trader.revokeApproval(String(req.body.token || ''), String(req.body.spender || ''))); } catch (e) { res.status(400).json({ error: e.message }); } });
// 币安公开安全审计（只读，模拟盘 / 实盘都能查；结果缓存 10 分钟）
app.get('/api/audit/:a', async (req, res) => { try { res.json(await tokenAudit(req.params.a)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.get('/api/token-info/:a', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '仅实盘模式可用' }); try { res.json(await trader.tokenInfo(req.params.a)); } catch (e) { res.status(400).json({ error: e.shortMessage || e.message }); } });
app.post('/api/swap/quote', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '仅实盘模式可用' }); try { const { from, to, amount, slippage } = req.body; res.json(await trader.swapQuote({ from, to, amount, slippage: Number(slippage) || 1 })); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/swap', async (req, res) => { if (!LIVE) return res.status(400).json({ error: '仅实盘模式可用' }); const { from, to, amount, pct, slippage, clientTs } = req.body; res.json(await trader.swapManual({ from, to, amount, pct: pct != null ? Number(pct) : null, slippage: Number(slippage) || 1, clientTs: Number(clientTs) || null })); });
// 条件单：限价 / 止盈 / 止损 / DCA（页面下单面板「限价」「DCA」「自动」）。后端盯价格，满足条件时下市价单
const { CondOrders } = await import('./engine/live/condOrders.js');
const cond = new CondOrders({ market, placeOrder: (o) => placeOrder(o), defaultSlots: () => trader.tradeSlots(), file: dataFile('cond-orders.json'), log: (m) => console.log(m) });
cond.on('change', (v) => broadcast({ type: 'cond', data: v }));
app.get('/api/cond', (req, res) => res.json(cond.view()));
app.post('/api/cond', (req, res) => { try { res.json(cond.create(req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/cond/cancel', (req, res) => { try { res.json(cond.cancel(String(req.body?.id || ''))); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/cond/remove', (req, res) => { cond.remove(String(req.body?.id || '')); res.json(cond.view()); });
app.get('/api/blocklist', (req, res) => res.json(blocklist.view()));
app.post('/api/blocklist', (req, res) => { try { const v = blocklist.set(req.body.kind, req.body.address, !!req.body.on, req.body.label); broadcast({ type: 'blocklist', data: v }); res.json(v); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/config', (req, res) => { agent.setConfig(req.body); if (LIVE && Number(req.body?.quickBuy) > 0) trader.saveSetting('quickBuy', Number(req.body.quickBuy)); res.json(agent.config); });
app.post('/api/settings', async (req, res) => {
  const { maxTradeBnb, sendTo, nftSendTo, ...rest } = req.body;
  if (maxTradeBnb !== undefined) { if (!LIVE) return res.status(400).json({ error: '仅实盘模式支持单笔上限' }); try { trader.setMaxTrade(maxTradeBnb); } catch (e) { return res.status(400).json({ error: e.message }); } }
  // 转出地址：页面里填（保存前页面会让本人确认）。清空 = 关掉所有自动转出
  if (LIVE && sendTo !== undefined) {
    const v = String(sendTo || '').trim();
    if (v && !ethers.isAddress(v)) return res.status(400).json({ error: '地址格式错误' });
    trader.settings.sendTo = v ? ethers.getAddress(v) : ''; trader.saveSetting('sendTo', trader.settings.sendTo);
    if (v) trader.resumeAutoSend?.();   // 重新保存地址 = 用户处理过了，之前失败停下的自动转出再试一次
    if (!v) for (const k of ['autoSendAfterClaim', 'autoSendFourMigrated', 'autoSendGangMigrated']) { trader.settings[k] = false; trader.saveSetting(k, false); }
    console.log(`[settings] 转出地址 → ${trader.settings.sendTo || '（清空）'}`);
  }
  // NFT 转出地址：页面里填（保存前页面会让本人确认）。只收普通钱包地址：合约地址、币安钱包自己、零地址都拒绝
  if (LIVE && nftSendTo !== undefined) {
    const v = String(nftSendTo || '').trim();
    if (v) {
      if (!ethers.isAddress(v)) return res.status(400).json({ error: '地址格式错误' });
      const a = ethers.getAddress(v);
      if (/^0x0{40}$/i.test(a)) return res.status(400).json({ error: '不能是零地址' });
      if ((trader.wallets || []).some((w) => String(w.address || '').toLowerCase() === a.toLowerCase())) return res.status(400).json({ error: '该地址是当前币安钱包本身，请填写接收用的其他钱包（如 OKX 钱包）' });
      const code = await market.provider.getCode(a).catch(() => '0x');
      if (code && code !== '0x') return res.status(400).json({ error: '该地址是合约地址，不是钱包地址（转入的 NFT 可能无法取出）' });
      trader.settings.nftSendTo = a;
    } else trader.settings.nftSendTo = '';
    trader.saveSetting('nftSendTo', trader.settings.nftSendTo);
    console.log(`[settings] NFT 转出地址 → ${trader.settings.nftSendTo || '（清空）'}`);
  }
  if (LIVE && !trader.settings.sendTo && [rest.autoSendAfterClaim, rest.autoSendFourMigrated, rest.autoSendGangMigrated].includes(true)) return res.status(400).json({ error: '请先填写转出地址' });
  // 只接受已知的设置项，并且先校验再写入（以前先 Object.assign 再校验：格式错的预设会留在内存里直到重启，任意键也能写进 settings）
  if (rest.qbPresets !== undefined) { const q = rest.qbPresets; const ok = q && ['buy', 'sell'].every((k) => Array.isArray(q[k]) && q[k].length === 3 && q[k].every((a) => Array.isArray(a) && a.length === 8 && a.every((v) => Number(v) > 0 && Number(v) <= (k === 'sell' ? 100 : 1000))));
    if (!ok) return res.status(400).json({ error: '预设格式无效' }); }
  if (rest.gas !== undefined) { if (!GAS_PRESETS[rest.gas]) return res.status(400).json({ error: 'Gas 档位无效' }); trader.settings.gas = rest.gas; }
  if (rest.execPath !== undefined) trader.settings.execPath = rest.execPath === 'ai' ? 'ai' : 'direct';
  if (rest.multiRpc !== undefined) trader.settings.multiRpc = rest.multiRpc === true;
  if (rest.autoClaim !== undefined) trader.settings.autoClaim = !!rest.autoClaim;
  if (LIVE && [rest.autoSendAfterClaim, rest.autoSendFourMigrated, rest.autoSendGangMigrated].includes(true)) trader.resumeAutoSend?.();   // 重新打开开关 = 再试一次之前失败停下的转出
  if (LIVE && rest.autoSendAfterClaim !== undefined) { trader.settings.autoSendAfterClaim = rest.autoSendAfterClaim === true; trader.saveSetting('autoSendAfterClaim', trader.settings.autoSendAfterClaim); console.log(`[settings] 领取后自动转出 ${trader.settings.autoSendAfterClaim ? '打开' : '关闭'} → ${trader.settings.sendTo}`); }
  if (LIVE && rest.autoSendFourMigrated !== undefined) { trader.settings.autoSendFourMigrated = rest.autoSendFourMigrated === true; trader.saveSetting('autoSendFourMigrated', trader.settings.autoSendFourMigrated); console.log(`[settings] Four 发射后自动转出 ${trader.settings.autoSendFourMigrated ? '打开' : '关闭'} → ${trader.settings.sendTo}`); }
  if (LIVE && rest.autoSendGangMigrated !== undefined) { trader.settings.autoSendGangMigrated = rest.autoSendGangMigrated === true; trader.saveSetting('autoSendGangMigrated', trader.settings.autoSendGangMigrated); console.log(`[settings] Gang 发射后自动转出 ${trader.settings.autoSendGangMigrated ? '打开' : '关闭'} → ${trader.settings.sendTo}`); }
  if (rest.qbPresets !== undefined) { trader.settings.qbPresets = rest.qbPresets; if (LIVE) trader.saveSetting('qbPresets', rest.qbPresets); }
  if (rest.sellToBnb !== undefined) { trader.settings.sellToBnb = rest.sellToBnb !== false; if (LIVE) trader.saveSetting('sellToBnb', trader.settings.sellToBnb); }
  if (rest.preApproveCap !== undefined) { trader.settings.preApproveCap = rest.preApproveCap !== false; if (LIVE) trader.saveSetting('preApproveCap', trader.settings.preApproveCap); }
  if (LIVE && rest.autoClaim !== undefined) { trader.saveSetting('autoClaim', !!rest.autoClaim); if (rest.autoClaim) trader.scanClaims(); } broadcast({ type: 'settings', data: trader.settings }); res.json(trader.settings); });
app.post('/api/wallet/:id', (req, res) => {
  if (LIVE) return res.status(400).json({ error: '实盘模式下不能修改模拟钱包' });
  const w = trader.wallet(req.params.id);
  const { whitelisted, agentId, faucet } = req.body;
  if (whitelisted != null) w.whitelisted = !!whitelisted;
  if (agentId != null) w.agentId = !!agentId;
  if (faucet) w.bnb += Number(faucet);
  res.json(trader.walletsView());
});
app.post('/api/launch', (req, res) => LIVE ? res.status(400).json({ error: '实盘模式下不能模拟发射' }) : res.json(market.summary(market.launch(req.body || {}))));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', verifyClient: ({ req }) => { const e = guard(req, true); if (e) console.warn(`[security] WebSocket：${e}`); return !e; } });   // WebSocket 同样要同源 / 令牌
// 序列化失败只跳过这一帧，不让整个服务崩溃
let badFrameLogged = false;
const broadcast = (msg) => {
  let s;
  try { s = JSON.stringify(msg); } catch (e) { if (!badFrameLogged) { badFrameLogged = true; console.error(`推送 ${msg?.type} 序列化失败，已跳过：${e.message}`); } return; }
  for (const c of wss.clients) if (c.readyState === 1) c.send(s);
};
notifier.on('alert', (a) => broadcast({ type: 'alert', data: a }));   // 提醒结果推给网页（以后其他入口也订阅它）
// ---------- 机会雷达（docs/PLAN-RADAR.md）：L1 扫链发现「被 .ai 钱包围的陌生合约」，R0 只发现 + 提醒 ----------
{
  const { Radar } = await import('./engine/live/radar/index.js');
  radar = new Radar({ market, trader: LIVE ? trader : null, log: (m) => console.log(m), broadcast: (m) => { broadcast(m); if (m.type === 'radar') notifier.onRadarView(m.data); } });
  if (radar.settings.scan) radar.start();
}
// 底栏「自动化」汇总：现在有哪些功能开着、可能在不经你点击的情况下动用资金（狙击 / 跟单 / 条件单 / 自动领取 / 自动转出）；
// 一键直铸每次仍要你点击，列出来只是提醒它开着。只读，各功能的开关仍在各自页面
// 交易手续费：费率、累计已付、未付、最近记录（engine/live/fees.js）
app.get('/api/fees', (req, res) => res.json(trader.fees ? trader.fees.summary() : { enabled: false }));

app.get('/api/automation', (req, res) => {
  // 全部会自动执行交易或转账的功能，开没开都列出来（底栏「自动化」弹层），让用户看清范围。新增这类功能要加在这里
  const items = [];
  const T = (k, p) => translate(req.query.lang || uiPrefs?.lang, k, p);   // 按界面语言：请求带的 ?lang 优先，否则用已保存的界面设置
  const slots = (a) => (Array.isArray(a) && a.length ? a.map((w) => `W${w}`).join(', ') : T('auto.primaryWallet'));
  try {
    const sim = (dry) => (dry ? T('auto.simRun') : '');
    const sn = sniper?.enabled;
    items.push({ key: 'snipe', label: T('auto.snipe'), to: '/snipe', on: !!sn, about: T('auto.snipe.about'), detail: sn ? T('auto.snipe.detail', { pct: sniper.params.pct, max: sniper.params.maxBnbPerBuy, wallets: slots(sniper.params.wallets) }) + sim(sniper.params.dryRun) : '' });
    const run = (tracker?.tasks || []).filter((t) => t.status === 'running' && !tracker.allPaused);
    const real = run.filter((t) => !t.params?.dryRun);
    items.push({ key: 'copy', label: T('auto.copy'), to: '/copy', on: run.length > 0, about: T('auto.copy.about'), detail: run.length ? T('auto.copy.detail', { n: run.length }) + (real.length < run.length ? T('auto.copy.sim', { n: run.length - real.length }) : '') : '' });
    const open = cond.view().filter((o) => o.status === 'open' || o.status === 'running');
    items.push({ key: 'cond', label: T('auto.cond'), to: '/portfolio', on: open.length > 0, about: T('auto.cond.about'), detail: open.length ? T('auto.cond.detail', { n: open.length }) : '' });
    if (LIVE) {
      const st = trader.settings || {};
      items.push({ key: 'claim', label: T('auto.claim'), to: null, on: !!st.autoClaim, about: T('auto.claim.about'), detail: '' });
      const send = [st.autoSendAfterClaim && 'Flap', st.autoSendFourMigrated && 'Four', st.autoSendGangMigrated && 'Gang'].filter(Boolean);
      const sendOn = send.length > 0 && !!st.sendTo;
      items.push({ key: 'send', label: T('auto.send'), to: null, on: sendOn, about: T('auto.send.about'), detail: sendOn ? `${send.join(' / ')} → ${st.sendTo.slice(0, 6)}…${st.sendTo.slice(-4)}` : '' });
      const am = !!radar?.settings?.autoMint;
      items.push({ key: 'automint', label: T('auto.automint'), to: '/radar', on: am, about: T('auto.automint.about'), detail: am ? T('auto.automint.detail', { n: radar.settings.autoMintMax }) : '' });
      const qm = !!radar?.settings?.quickMint;
      items.push({ key: 'quickmint', label: T('auto.quickmint'), to: '/radar', on: qm, about: T('auto.quickmint.about'), detail: qm ? T('auto.quickmint.detail', { n: radar.settings.quickMintMax }) : '' });
    }
  } catch (e) { return res.status(500).json({ error: e.message }); }
  res.json({ items });
});
(await import('./engine/routes/radar.js')).radarRoutes(app, { getRadar: () => radar, LIVE });   // 雷达 / NFT 接口在 engine/routes/radar.js（路由顺序见该文件）

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e?.stack || e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e?.stack || e));

// ---------- tick 增量推送 ----------
// 以前每 500ms 推完整的 1000 个币（单条约 1.9MB，约 4MB/s），页面一直在解析 JSON、重建列表，所有页面都被拖卡。
// 现在：新连接先收一帧全量（full），之后每帧只带「变化的币」和「消失的币」；seq 连续递增，客户端发现断档就重连拿全量。
let tickSeq = 0;
const sentTok = new Map();   // 地址 → 上次推出去的币对象（用来对比 + 给新连接做全量）
const sentStr = new Map();   // 地址 → 上次推出去的 JSON（对比用，避免逐字段比较）
const STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);   // 界面据此在后台刚启动的头几秒显示「正在同步行情」，不让列表一条一条往外蹦
const tickBase = () => ({ startedAt: STARTED_AT, ...modeInfo(), block: market.block, bnbUsd: market.bnbUsd, net, wallets: trader.walletsView(), usage: agent.usageView(), positions: trader.positionsView(), claimable: LIVE ? trader.claimable : [] });
function tokenDelta() {
  const up = [], seen = new Set();
  for (const t of market.list()) {
    const k = String(t.address).toLowerCase(); seen.add(k);
    const s = JSON.stringify(t);
    if (sentStr.get(k) !== s) { sentStr.set(k, s); sentTok.set(k, t); up.push(t); }
  }
  const del = [];
  for (const k of sentStr.keys()) if (!seen.has(k)) { sentStr.delete(k); sentTok.delete(k); del.push(k); }
  return { up, del };
}

wss.on('connection', (ws) => {
  ws.sub = null;
  // 全量：和最近一次广播的状态一致（seq 相同），之后的增量接着它往下走
  try { ws.send(JSON.stringify({ type: 'tick', full: true, seq: tickSeq, data: { ...tickBase(), tokens: [...sentTok.values()] } })); } catch { /* 下一帧再说 */ }
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw);
      if (m.type === 'sub') {
        ws.sub = m.token;
        const send = () => { const d = market.detail(m.token); if (d && ws.sub === m.token) ws.send(JSON.stringify({ type: 'detail', full: true, data: d })); };
        send();
        if (LIVE) market.refresh(m.token).then(send);
      }
    } catch { /* ignore */ }
  });
});

market.on('trade', (t) => broadcast({ type: 'trade', data: t }));
market.on('launch', (s) => broadcast({ type: 'launch', data: s }));
// 实盘行情：选中的代币每 3 秒刷新一次详情
if (LIVE) setInterval(() => new Set([...wss.clients].map((c) => c.sub).filter(Boolean)).forEach((a) => market.refresh(a)), 3000);
market.on('detail', (a) => { for (const c of wss.clients) if (c.readyState === 1 && c.sub === a) c.send(JSON.stringify({ type: 'detail', full: true, data: market.detail(a) })); });
// 订单结束（成交或失败）后马上重读链上余额，3 / 5 / 20 秒后再读一次，等区块和 baw 索引跟上
const resync = async () => { trader.syncAt = 0; if (holdings) holdings.histAt = 0; await trader.refreshBalance?.().catch(() => {}); await trader.syncHoldings?.().catch(() => {}); };
trader.on('order', (o) => { broadcast({ type: 'order', data: o }); if (LIVE && ['filled', 'failed', 'unknown'].includes(o.status)) { for (const ms of [3000, 5000, 20000]) setTimeout(() => resync(), ms); for (const ms of [1500, 6000, 15000]) setTimeout(refreshHoldSnap, ms); } });
trader.on('autoTransfer', (o) => broadcast({ type: 'autoTransfer', data: o }));
trader.on('rules', (r) => broadcast({ type: 'rules', data: r }));
trader.on('settings', (st) => broadcast({ type: 'settings', data: st }));
market.on('migrate', (s) => { if (LIVE && s?.platform === 'four') { trader.syncAt = 0; trader.refreshBalance?.(); } });
agent.on('log', (l) => broadcast({ type: 'log', data: l }));
agent.on('record', (r) => broadcast({ type: 'record', data: r }));
agent.on('config', (c) => broadcast({ type: 'config', data: c }));

setInterval(() => {
  const { up, del } = tokenDelta();
  broadcast({ type: 'tick', seq: ++tickSeq, data: { ...tickBase(), tokens: up, tokensDel: del } });
  if (up.length || del.length) { try { notifier.onTokens(market.list(), market.bnbUsd); } catch (e) { console.error('[提醒] 战壕判断出错', e.message); } }
  for (const c of wss.clients) {
    if (c.readyState !== 1 || !c.sub) continue;
    const d = market.detail(c.sub);
    if (d) c.send(JSON.stringify({ type: 'detail', full: false, data: { ...d, candles: d.candles.slice(-5) } }));
  }
}, 500);

// 每日备份 data/ 到 backups/（保留 14 天；指定了 DATA_DIR 的实例放在它旁边的 <DATA_DIR>-backups/，不会和主实例撞名）
startBackups({ dataDir: DATA_DIR_UI, outDir: process.env.BACKUP_DIR || (APP_MODE && !process.env.DATA_DIR ? path.join(APP_HOME, 'backups') : process.env.DATA_DIR ? `${path.resolve(DATA_DIR_UI)}-backups` : path.join(path.dirname(fileURLToPath(import.meta.url)), 'backups')), keep: 14, log: (m) => console.log(m) });

// 默认只监听本机。HOST 只给 Docker 容器用（容器里要监听 0.0.0.0，端口再只映射到宿主机的 127.0.0.1）
server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`\n  Piupiu（${!LIVE ? '模拟盘' : LIVE_TRADE ? `实盘 · 手动订单真实下单 · 单笔上限 ${trader.status.maxTradeBnb || '不限'} BNB` : '实盘行情 · 只报价不下单'}）`);
  if (LIVE) console.log(`  钱包：${trader.wallets.map((w) => `W${w.slot} ${w.label} ${w.address.slice(0, 6)}…${w.address.slice(-4)}`).join(' · ') || '未登录'}${trader.slotAuth ? `（槽位状态 ${JSON.stringify(Object.fromEntries([...trader.slotAuth].map(([k, v]) => [`W${k}`, v.state])))}）` : ''}`);
  console.log(`  ➜  http://localhost:${PORT}\n`);
});
