// RPC：有 NODEREAL_RPC 就用它当主节点，出错或被限流时自动换公共节点（bsc-dataseed / publicnode），30 秒后再试主节点。
// 地址里含 key，显示到页面 / 日志时一律用 maskRpc() 隐藏
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { EP } from './endpoints.js';

export const maskRpc = (u) => String(u || '').replace(/(nodereal\.io\/(?:ws\/)?v1\/)[A-Za-z0-9]+/ig, '$1***').replace(/([?&](api[-_]?key|key|token)=)[^&\s"']+/ig, '$1***');
// 任意文本（日志、错误信息、记录文件）里的 RPC key 一律打码：NodeReal 地址 + .env 里 NODEREAL_KEYS 的 key 原文（用到时再读，.env 在 config.js 里才加载）
export const redactSecrets = (s) => { let t = maskRpc(s); for (const k of (process.env.NODEREAL_KEYS || '').split(',').map((x) => x.trim()).filter((x) => x.length >= 16)) t = t.split(k).join('***'); return t; };

// 页面上显示的节点名（不含 key）
// 多个 NodeReal key：页面上只显示「NodeReal #1 / #2」，不显示 key
const NR_SLOTS = [];
export const setNodeRealSlots = (urls) => { NR_SLOTS.length = 0; for (const u of urls) NR_SLOTS.push(String(u).replace(/^wss:/, 'https:').replace('/ws/v1/', '/v1/')); };
const nrName = (h) => { const i = NR_SLOTS.indexOf(String(h).replace(/^wss:/, 'https:').replace('/ws/v1/', '/v1/')); return NR_SLOTS.length > 1 && i >= 0 ? `NodeReal #${i + 1}` : 'NodeReal'; };
export const nodeName = (u) => { const h = String(u || ''); return /nodereal/i.test(h) ? nrName(h) : /publicnode/i.test(h) ? 'PublicNode' : /dataseed|bnbchain/i.test(h) ? 'BNB Chain' : /48\.club/i.test(h) ? '48 Club' : h ? (h.match(/\/\/([^/:]+)/)?.[1] || '自定义') : '—'; };

// 用量统计：每个节点、每个用途（label）、每个方法各请求了多少次（NodeReal 有额度，要盯着）
export const RPC_USAGE = new Map();

// ---------- NodeReal 月度用量保险（每个 key 各记各的）----------
// 免费版每个账号每月 1000 万 CU，用完所有请求都会被拒绝（-32005）。这里按和 NodeReal 一样的口径（UTC 月、每个方法的 CU、WebSocket 每字节 0.04）
// 给每个 key 自己记账：某个 key 本月累计到上限就只停用这一个、改用其他 key 或公共节点，下个月 1 号自动恢复。
// 启动时从 rpc-usage.jsonl 把本月每个 key 已用的算回来（重启不清零）。注意：同一个账号下的多个 key 共用一份额度，要用不同账号的 key 才有意义
const BUDGET = { limit: 0, used: [], month: '', tripped: [] };   // limit：每个 key 的上限；used / tripped 按 key 序号（NR_SLOTS 的下标）
const monthKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);
const normUrl = (u) => String(u).replace(/^wss:/, 'https:').replace('/ws/v1/', '/v1/');
const nrIdx = (url) => { const i = NR_SLOTS.indexOf(normUrl(url)); return i; };   // 不是 NodeReal 地址返回 -1
const nrCount = () => Math.max(1, NR_SLOTS.length);
function resetUsed() { BUDGET.used = Array(nrCount()).fill(0); BUDGET.tripped = Array(nrCount()).fill(false); }
export function initNodeRealBudget({ limit, historyFile }) {
  BUDGET.limit = Number(limit) || 0; BUDGET.month = monthKey(); resetUsed();
  if (!BUDGET.limit) return;
  try {
    for (const line of readFileSync(historyFile, 'utf8').split('\n')) {
      if (!line) continue; let r; try { r = JSON.parse(line); } catch { continue; }
      if (monthKey(r.ts) !== BUDGET.month) continue;
      // 每分钟一行里的 perKey：{ 'NodeReal': {...} }（当时只有一个 key，归到第 1 个）或 { 'NodeReal #1': {...}, 'NodeReal #2': {...} }
      for (const [name, o] of Object.entries(r.perKey || {})) {
        const m = /^NodeReal(?: #(\d+))?$/.exec(name); if (!m) continue;
        const i = Math.min(nrCount() - 1, (m[1] ? Number(m[1]) : 1) - 1); BUDGET.used[i] += Number(o?.cu) || 0;
      }
    }
  } catch { /* 没有历史文件：从 0 开始 */ }
  BUDGET.used.forEach((u, i) => { if (u >= BUDGET.limit) { BUDGET.tripped[i] = true; console.warn(`[RPC] 本月 NodeReal key #${i + 1} 已用约 ${Math.round(u / 1e4)} 万 CU，达到上限 ${Math.round(BUDGET.limit / 1e4)} 万：这个 key 本月不再使用（下月 1 号自动恢复）`); } });
}
function nrRoll() { const m = monthKey(); if (m !== BUDGET.month) { BUDGET.month = m; resetUsed(); console.log('[RPC] 进入新的一个月，NodeReal 用量重新计算'); } }
// url 给了：这个 key 是否已停用；不给：所有 key 是否都已停用（没有可用的 NodeReal 了）
export function nrExhausted(url) {
  nrRoll(); if (!(BUDGET.limit > 0)) return false;
  if (url != null) { const i = nrIdx(url); return i >= 0 && !!BUDGET.tripped[i]; }
  return BUDGET.tripped.slice(0, nrCount()).every(Boolean);
}
export const nodeRealBudget = () => {
  nrRoll(); const n = nrCount(), lim = BUDGET.limit;
  const keys = Array.from({ length: n }, (_, i) => ({ name: n > 1 ? `NodeReal #${i + 1}` : 'NodeReal', used: Math.round(BUDGET.used[i] || 0), left: lim ? Math.max(0, Math.round(lim - (BUDGET.used[i] || 0))) : null, exhausted: !!BUDGET.tripped[i] }));
  return { limit: lim * n, perKeyLimit: lim, used: keys.reduce((a, k) => a + k.used, 0), left: lim ? keys.reduce((a, k) => a + k.left, 0) : null, exhausted: nrExhausted(), keys, month: BUDGET.month };
};
function nrSpend(i, cu) {
  if (!BUDGET.limit || i < 0) return; nrRoll(); BUDGET.used[i] = (BUDGET.used[i] || 0) + cu;
  if (!BUDGET.tripped[i] && BUDGET.used[i] >= BUDGET.limit) { BUDGET.tripped[i] = true; console.warn(`[RPC] 本月 NodeReal key #${i + 1} 用量已达上限（约 ${Math.round(BUDGET.used[i] / 1e4)} 万 CU），这个 key 停用，下月 1 号自动恢复`); }
}
export const bumpUsage = (label, url, payload) => { const node = nodeName(url), i = nrIdx(url); for (const x of Array.isArray(payload) ? payload : [payload]) { const k = `${node}|${label}|${x?.method || '?'}`; RPC_USAGE.set(k, (RPC_USAGE.get(k) || 0) + 1); if (i >= 0) nrSpend(i, CU[x?.method] ?? 20); } };
// NodeReal（BSC）每个方法的 CU（docs.nodereal.io/docs/compute-units-cus）；WebSocket 推送按字节 0.04 CU；没列出的按 20 估
export const CU = { eth_blockNumber: 5, eth_chainId: 5, eth_call: 20, eth_getLogs: 50, eth_getBalance: 15, eth_getTransactionReceipt: 15, eth_getBlockByNumber: 15, eth_subscribe: 10, eth_estimateGas: 75, eth_gasPrice: 15, eth_getCode: 15, eth_getTransactionCount: 25, eth_sendRawTransaction: 150, logs: 0 };
export const cuOf = (method, n) => (method === 'ws_bytes' ? n * 0.04 : n * (CU[method] ?? 20));
// 诊断：RPC_TRACE=1 时按「是谁发起的调用」（调用栈里第一个项目内的函数）统计 eth_call 次数，用来找出哪个循环在刷请求
const TRACE = process.env.RPC_TRACE === '1' ? new Map() : null;
export const takeTrace = () => { if (!TRACE) return null; const o = [...TRACE].sort((a, b) => b[1] - a[1]).slice(0, 10); TRACE.clear(); return o; };
function traceCall(label) {
  if (!TRACE) return;
  const fr = (new Error().stack || '').split('\n').slice(2).map((l) => l.trim()).filter((l) => (l.includes('/engine/') || l.includes('/server.js')) && !l.includes('/rpc.js')).slice(0, 2).map((l) => l.replace(/^at (async )?/, '').replace(/\(?file:\/\/[^)]*\/(engine\/live\/|)/, '(')).join(' < ') || '(未知）';
  const k = `[${label}] ${fr}`; TRACE.set(k, (TRACE.get(k) || 0) + 1);
}
export function takeUsage() { const out = {}; for (const [k, n] of RPC_USAGE) out[k] = n; RPC_USAGE.clear(); return out; }
export const PUBLIC_RPC = EP.rpcLogs, PUBLIC_WSS = EP.wssPublic;

// ethers 的 WebSocketProvider：eth_subscribe 被节点拒绝（限流 -32005 等）时，它内部的 promise 没人接，
// 变成 unhandledRejection，而且订阅就此静默失效（连接还开着，状态显示「已连接」，却再也收不到事件）。
// 这里截住订阅请求：失败时交给 onFail（重连），并返回一个永不结束的 promise，让 ethers 内部不再抛出
export function guardSubscribe(ws, onFail) {
  const orig = ws.send.bind(ws);
  ws.send = (method, params) => {
    const p = orig(method, params);
    if (method !== 'eth_subscribe') return p;
    return p.catch((e) => { try { onFail(e); } catch { /* ignore */ } return new Promise(() => {}); });
  };
  return ws;
}

// 订阅链上事件（WebSocket）：按顺序用 urls（一般是 NodeReal → publicnode）。断线 / 被拒（如 429）5 秒后换下一个；
// 用的不是第一个时，10 分钟后再试回第一个。status.connected 表示订阅正常
export class WsLogs {
  constructor({ label, urls, filters, onLog, status }) { Object.assign(this, { label, urls: urls.filter(Boolean), filters, onLog, status }); this.ws = null; }
  start() { this.connect(0); return this; }
  get live() { return !!this.ws && !!this.status.connected; }
  stop() { this.stopped = true; clearTimeout(this.backT); clearTimeout(this.pending); this.pending = null; this.drop(this.ws); this.status.connected = false; }   // 订阅条件变了：停掉旧的，再 new 一个
  connect(i) {
    // 额度用完（或停用）时跳过 NodeReal 地址，直接用下一个公共节点
    for (let n = 0; n < this.urls.length && nrExhausted(this.urls[i]); n++) i = (i + 1) % this.urls.length;
    const url = this.urls[i]; if (!url || this.stopped) return;
    let ws; try { ws = new ethers.WebSocketProvider(url, 56); } catch (e) { return this.retry(i, e); }
    guardSubscribe(ws, (e) => this.retry(i, new Error(`订阅被拒绝：${String(e?.error?.message || e?.shortMessage || e?.message || e).slice(0, 80)}`), ws));
    this.ws = ws; this.idx = i; this.status.wss = nodeName(url); this.status.connected = false;
    const sock = ws.websocket;
    sock?.addEventListener?.('open', () => { if (this.ws === ws) { this.status.connected = true; this.status.connectedAt = Date.now(); this.status.lastError = null; } });
    sock?.addEventListener?.('close', () => this.retry(i, new Error('连接断开'), ws));
    sock?.addEventListener?.('error', (e) => this.retry(i, e?.error || new Error('连接出错'), ws));
    for (const f of this.filters) ws.on(f, (log) => { this.status.connected = true; this.status.lastLogAt = Date.now(); bumpUsage(this.label + '-ws推送', url, { method: 'logs' }); const k = `${nodeName(url)}|${this.label}-ws推送|ws_bytes`; const bytes = JSON.stringify(log).length + 200; RPC_USAGE.set(k, (RPC_USAGE.get(k) || 0) + bytes); const ki = nrIdx(url); if (ki >= 0) { nrSpend(ki, bytes * 0.04); if (nrExhausted(url) && this.ws === ws) this.retry(i, new Error('NodeReal \u672c\u6708\u989d\u5ea6\u5df2\u7528\u5b8c\uff0c\u6362\u4e0b\u4e00\u4e2a\u8282\u70b9'), ws); }   /* WS 按字节计费，估算每条推送的大小 */ try { this.onLog(log); } catch { /* 单条解析失败不影响订阅 */ } });
    bumpUsage(this.label, url, this.filters.map(() => ({ method: 'eth_subscribe' })));
    clearTimeout(this.backT);
    if (i > 0) this.backT = setTimeout(() => { if (this.ws === ws) { this.drop(ws); this.connect(0); } }, 10 * 60_000);
  }
  retry(i, e, ws) {
    if (ws && this.ws !== ws) return;
    this.drop(ws || this.ws); this.status.connected = false; this.status.lastError = String(e?.shortMessage || e?.message || e).slice(0, 160);
    if (this.pending) return; this.pending = setTimeout(() => { this.pending = null; this.connect((i + 1) % this.urls.length); }, 5_000);
  }
  drop(ws) { if (!ws) return; if (this.ws === ws) this.ws = null; try { ws.destroy(); } catch { /* ignore */ } }
}

export class FailoverProvider extends ethers.JsonRpcProvider {
  // urls 按优先顺序；其中多个 NodeReal key 轮流用（round-robin）。某个节点被限流 / 额度用完（429 等）就冷却 5 分钟，
  // 其他错误冷却 30 秒，期间用下一个；全都在冷却时仍按顺序硬试一遍。不让 ethers 自己退避重试（会卡很久）
  constructor(urls, label = 'rpc') {
    const list = urls.filter((u, i, a) => u && a.indexOf(u) === i);
    // 一个节点都没配置（开源版没填 RPC_URL）：照样能构造，调用时报「未配置节点」，不去连本机 8545
    super(FailoverProvider.req(list[0] || 'http://127.0.0.1:9/'), 56, { staticNetwork: true, batchMaxCount: 1 });
    this.urls = list; this.label = label; this.rr = 0;
    this.nodes = list.map((u) => ({ url: u, name: nodeName(u), nr: /nodereal/i.test(u), cool: 0, err: null, p: new ethers.JsonRpcProvider(FailoverProvider.req(u), 56, { staticNetwork: true, batchMaxCount: 1 }) }));
    this.lastUsed = maskRpc(list[0]); this.primaryErr = null; this.coolUntil = 0;
  }
  // 诊断用：在 call() 入口抓调用方（进入 ethers 内部的异步队列后调用栈就断了）
  call(tx) { traceCall(this.label); return super.call(tx); }
  static req(u) { const r = new ethers.FetchRequest(u); r.setThrottleParams({ maxAttempts: 1 }); r.timeout = 8_000; return r; }
  get info() {
    const now = Date.now(), first = this.nodes[0];
    const act = nodeName(this.lastUrl || this.urls[0]);
    return { active: act, primary: first?.name, fallback: act !== first?.name && !(first?.nr && /^NodeReal/.test(act)),
      coolUntil: this.coolUntil, primaryErr: this.primaryErr, keys: this.nodes.filter((n) => n.nr).map((n) => ({ name: n.name, cooling: n.cool > now, err: n.cool > now ? n.err : null })) };
  }
  order() {
    const now = Date.now(), pool = this.nodes.filter((n) => !(n.nr && nrExhausted(n.url)));   // 本月额度用完：NodeReal 整个排除（全是 NodeReal 的 provider 才硬试）
    const ok = (pool.length ? pool : this.nodes).filter((n) => n.cool <= now);
    const nr = ok.filter((n) => n.nr);
    if (nr.length > 1) { this.rr = (this.rr + 1) % nr.length; const rot = nr.slice(this.rr).concat(nr.slice(0, this.rr)); let k = 0; for (let i = 0; i < ok.length; i++) if (ok[i].nr) ok[i] = rot[k++]; }
    return ok.length ? ok : pool.length ? pool : this.nodes;
  }
  async _send(payload) {
    if (!this.nodes.length) throw new Error('未配置 BSC 节点：请在 .env 中设置 RPC_URL');
    let last; const list = this.order();
    for (let i = 0; i < list.length; i++) {
      const n = list[i]; bumpUsage(this.label, n.url, payload);
      try {
        const r = await n.p._send(payload);
        const errs = (Array.isArray(r) ? r : [r]).filter((x) => x?.error).map((x) => String(x.error.message || ''));
        // 限流 / 额度：冷却这个节点换下一个；节点不支持（如 bsc-dataseed 的 getLogs「limit exceeded」）：换下一个；合约 revert 之类的正常错误直接返回
        const rl = errs.find((m) => /429|rate|too many|quota|exceed|limit/i.test(m));
        if (rl && i < list.length - 1) { n.cool = Date.now() + (n.nr ? 300_000 : 30_000); n.err = rl.slice(0, 120); if (n.nr) { this.primaryErr = n.err; this.coolUntil = n.cool; } last = new Error(rl); continue; }
        this.lastUsed = maskRpc(n.url); this.lastUrl = n.url; return r;
      } catch (e) {
        const m = String(e.shortMessage || e.message || e).slice(0, 160); last = e;
        n.cool = Date.now() + (/429|limit|quota|exceed|retry/i.test(m) ? 300_000 : 30_000); n.err = m;
        if (n.nr) { this.primaryErr = m; this.coolUntil = n.cool; }
      }
    }
    throw last;
  }
}
