// 区块扫描（方案 L1）：新区块 → 完整交易 → 过滤（known.js）→ 按 to 滑动窗口计数。
// 纯逻辑（窗口统计、上榜判断）拆成可单测的纯函数 / 纯类，链上部分只有「拿区块」这一层。
//
// 计数口径：交易进了区块就算一次调用（BSC 没法从区块里看出执行成败，逐笔查 receipt 的成本不值得）。
// 窗口：最近 30 分钟的「不同调用者」；.ai 与否由 AiSet 懒判断——某个 to 凑够 8 个不同调用者才查，不查就当未知（不算 .ai 也不算非 .ai）。
import { ethers } from 'ethers';
import { PUBLIC_WSS, PUBLIC_RPC, nodeName, bumpUsage, guardSubscribe } from '../rpc.js';
import { Known, worthRecording } from './known.js';

const lc = (a) => String(a || '').toLowerCase();
export const WINDOW_MS = 30 * 60_000;      // 上榜看的窗口
export const KEEP_MS = 75 * 60_000;        // 事件保留时长（升温判断要看 20 分钟，多留一些余量）
export const LAZY_CALLERS = 8;             // to 的不同调用者达到这个数才触发 .ai 懒判断
const MAX_TRACKED = 4000;                  // 内存闸：最多同时记多少个 to（按最近活跃淘汰）

/** 一个 to 的调用窗口（纯内存，可单测）。事件 [{t, from}] 只保留 KEEP_MS */
export class Win {
  constructor() { this.ev = []; this.lastSeen = 0; this.lastAiAt = 0; this.aiCheckedAt = 0; }
  add(t, from, x = {}) {
    const e = { t, from: lc(from), hash: x.hash || null, sel: x.sel || null, value: x.value || '0x0' };   // 只存哈希 / 选择器 / 金额：完整参数分析时再按哈希取
    this.ev.push(e); this.lastSeen = t;
    if (this.ev.length > 600) this.ev.splice(0, this.ev.length - 600);
  }
  prune(now, keepMs = KEEP_MS) {
    while (this.ev.length && this.ev[0].t < now - keepMs) this.ev.shift();
  }
  idle(now) { return now - this.lastSeen > 2 * 3600_000; }
  /** 窗口统计：callers = 30 分钟不同调用者；aiKnown 是 (addr → boolean) 的查询函数 */
  stats(now, aiOf, { windowMs = WINDOW_MS } = {}) {
    const from = now - windowMs;
    const all = new Set(); const recent = [];   // recent：窗口内每笔（算 .ai 用）
    for (const e of this.ev) if (e.t >= from) { all.add(e.from); recent.push(e); }
    const known = new Map(); let ai = 0, checked = 0;
    for (const f of all) { const v = aiOf(f); if (v === true) { ai++; known.set(f, true); } else if (v === false) { known.set(f, false); checked++; } }
    // 5 分钟一桶的 .ai 调用数（桶内出现过的 .ai 地址数，和「调用次数」相比更抗刷）；lastAiAt = 最近一次 .ai 调用的时间（冷却判断用）
    const buckets = new Map();
    const b0 = Math.floor(now / 300_000) * 300_000;
    for (let i = 11; i >= 0; i--) buckets.set(b0 - i * 300_000, new Set());
    let lastAiAt = 0;
    for (const e of this.ev) if (known.get(e.from)) { if (e.t > lastAiAt) lastAiAt = e.t; if (e.t >= from) { const b = Math.floor(e.t / 300_000) * 300_000; const s = buckets.get(b); if (s) s.add(e.from); } }
    const bars = [...buckets.entries()].map(([t, s]) => ({ t, n: s.size }));
    // 最近 10 分钟 / 再前 10 分钟的不同 .ai 调用者（升温判断）
    const inRange = (a, b) => { const s = new Set(); for (const e of this.ev) if (e.t >= a && e.t < b && known.get(e.from)) s.add(e.from); return s.size; };
    return {
      callers: all.size, aiCallers: ai, aiKnown: known.size, aiUnchecked: all.size - known.size,
      ratio: all.size ? ai / all.size : 0,
      bars, last10: inRange(now - 600_000, now), prev10: inRange(now - 1200_000, now - 600_000),
      lastAiAt, lastSeen: this.lastSeen, events: recent.length,
    };
  }
}
/** 上榜 / 升温判断（纯函数）：settings = { minAi, aiRatioPct, hotMult, hotMin } */
export function judge(st, settings) {
  const listed = st.aiCallers >= Math.max(1, settings.minAi) && st.ratio >= settings.aiRatioPct / 100;
  if (!listed) return { listed: false, hot: false };
  const accelerating = st.prev10 > 0 ? st.last10 >= st.prev10 * settings.hotMult : st.last10 >= settings.hotMin;   // 前一段没有基数时：最近 10 分钟足够多就算升温
  const hot = accelerating && st.aiCallers >= settings.hotMin;
  return { listed: true, hot };
}

/** 区块扫描器：订阅 newHeads（推送，不轮询），每个新块取完整区块、过滤、喂给窗口 */
export class BlockScan {
  constructor({ httpUrl = PUBLIC_RPC, wsUrl = PUBLIC_WSS, known, aiSet, onStats, onActivity = null, labelOf = null, status, log = () => {} }) {
    this.http = new ethers.JsonRpcProvider(httpUrl, 56, { staticNetwork: true, batchMaxCount: 1 });
    this.httpUrl = httpUrl; this.wsUrl = wsUrl;
    this.known = known; this.aiSet = aiSet; this.onStats = onStats; this.status = status; this.log = log;
    this.onActivity = onActivity; this.labelOf = labelOf;   // 「链上动态」：已知 .ai 钱包每一笔调用记到「在做什么」里（只看已有结论，不为它去查 .ai）
    this.wins = new Map(); this.head = 0; this.cursor = 0; this.gaps = 0; this.lastBlockAt = 0;
    this.fetching = 0; this.ws = null; this.stopped = true; this.reT = null;
  }
  start() {
    this.stopped = false; this.connect(); this.sweep = setInterval(() => this.tick(), 3000); this.sweep.unref?.();
    // 兜底：订阅 10 秒没推新块（被限流 / 断线没察觉）就用 HTTP 问最新块号，保证扫描不停
    this.poll = setInterval(async () => {
      if (this.stopped || Date.now() - (this.status.lastHeadAt || 0) < 10_000) return;
      try { const n = await this.http.getBlockNumber(); bumpUsage('雷达', this.httpUrl, { method: 'eth_blockNumber' }); if (n > this.head) { this.head = n; this.status.lastHeadAt = Date.now(); this.status.via = 'HTTP 轮询'; this.tick(); } } catch { /* 下次再问 */ }
    }, 2000); this.poll.unref?.();
    return this;
  }
  stop() { this.stopped = true; clearTimeout(this.reT); clearInterval(this.sweep); clearInterval(this.poll); this.dropWs(); }
  connect() {
    let ws; try { ws = new ethers.WebSocketProvider(this.wsUrl, 56, { staticNetwork: true }); } catch (e) { return this.retry(e); }
    guardSubscribe(ws, (e) => this.retry(e, ws));
    this.ws = ws; this.status.node = nodeName(this.wsUrl); this.status.via = '订阅';
    // 订阅本身可能被限流拒绝（-32005）：接住错误换成重连，不让它变成未处理的异常
    Promise.resolve(ws.on('block', (n) => { this.status.lastHeadAt = Date.now(); this.status.lastError = null; if (n > this.head) this.head = n; this.tick(); })).catch((e) => this.retry(e, ws));
    // ethers 的 WebSocketProvider 在 v6 里没有稳定的断线事件：靠 lastHeadAt 超时兜底重连
    ws.websocket?.addEventListener?.('close', () => this.retry(new Error('订阅断开'), ws));
    ws.websocket?.addEventListener?.('error', (e) => this.retry(e?.error || new Error('订阅出错'), ws));
  }
  retry(e, ws) {
    if (this.stopped || (ws && this.ws !== ws)) return;
    this.dropWs(); this.status.lastError = String(e?.message || e).slice(0, 120);
    clearTimeout(this.reT); this.reT = setTimeout(() => !this.stopped && this.connect(), 5000);
  }
  dropWs() { const w = this.ws; this.ws = null; try { w?.destroy(); } catch { /* ignore */ } }

  async tick() {
    if (this.stopped || this.fetching >= 2) return;   // 并发 2：串行取一块 400–600ms，出块 0.45 秒一个，跟不上
    const behind = this.head - this.cursor;
    this.status.behind = Math.max(0, behind);
    if (behind > 200) {   // 落后太多：跳到最新（追不上，还拖垮节点），记一个缺口
      this.gaps++; this.status.gaps = this.gaps; this.cursor = this.head - 1; this.log(`雷达落后 ${behind} 块，跳到最新（缺口 +1）`);
    }
    if (!this.head || this.cursor >= this.head) return;
    this.fetching++;
    try {
      const n = this.cursor + 1;
      bumpUsage('雷达', this.httpUrl, { method: 'eth_getBlockByNumber' });
      const b = await this.http.send('eth_getBlockByNumber', ['0x' + n.toString(16), true]);
      if (!b) { this.cursor = n; return; }   // 还没出来 / 被剪：跳过这一块
      this.cursor = n; this.status.cursor = n; this.lastBlockAt = Date.now(); this.status.tracked = this.wins.size;
      const t = (Number(b.timestamp) || 0) * 1000 || Date.now();
      this.ingest(t, b.transactions || []);
    } catch (e) { this.status.lastError = String(e?.shortMessage || e.message || e).slice(0, 120); }
    finally { this.fetching--; if (this.head > this.cursor) setImmediate(() => this.tick()); }
  }

  /** 一个区块的交易进窗口（拆出来便于单测：不碰链） */
  ingest(t, txs) {
    const touched = new Set();
    for (const tx of txs) {
      if (this.onActivity && tx?.to && tx.from && this.aiSet.peek(tx.from) === true) {
        const d = String(tx.input ?? tx.data ?? '');
        const label = this.known.label(tx.to) || this.labelOf?.(lc(tx.to)) || (d.length < 10 ? '转账' : null);
        this.onActivity(label, lc(tx.to), lc(tx.from), t);
      }
      if (!worthRecording(tx, this.known)) continue;
      const to = lc(tx.to);
      let w = this.wins.get(to); if (!w) { w = new Win(); this.wins.set(to, w); }
      const d = String(tx.input ?? tx.data ?? '');
      w.add(t, tx.from, { hash: tx.hash, sel: d.slice(0, 10), value: tx.value }); touched.add(to);
    }
    // 内存闸：跟踪的 to 太多时，把最久没动静的扔掉
    if (this.wins.size > MAX_TRACKED) {
      const arr = [...this.wins.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      for (let i = 0; i < arr.length - MAX_TRACKED; i++) this.wins.delete(arr[i][0]);
    }
    for (const to of touched) {
      const w = this.wins.get(to); if (!w) continue;
      w.prune(t);
      const st = w.stats(t, (a) => this.aiSet.peek(a));
      // 懒判断：调用者够多才查他们的 .ai（每个地址 30 分钟最多触发一次）
      if (st.callers >= LAZY_CALLERS && t - w.aiCheckedAt > WINDOW_MS) { w.aiCheckedAt = t; this.aiSet.want([...new Set(w.ev.map((e) => e.from))]); }
      if (st.callers >= LAZY_CALLERS || st.aiCallers > 0) { try { this.onStats(to, st); } catch (e) { this.log(`onStats 出错：${e.message}`); } }
    }
  }

  /** 最近的调用（新的在前），给分析和详情页「大家在做什么」用；onlyAi = 只要已知 .ai 钱包的 */
  recent(to, n = 40, onlyAi = false) {
    const w = this.wins.get(lc(to)); if (!w) return [];
    const out = [];
    for (let i = w.ev.length - 1; i >= 0 && out.length < n; i--) { const e = w.ev[i]; if (!onlyAi || this.aiSet.peek(e.from) === true) out.push(e); }
    return out;
  }

  /** 观测用：窗口里最忙的几个 to（调用了多少个地址、其中多少 .ai） */
  sample(aiOf, top = 6) {
    const now = Date.now();
    return [...this.wins.entries()].map(([to, w]) => ({ to, ...w.stats(now, aiOf) }))
      .filter((x) => x.callers >= 4).sort((a, b) => b.callers - a.callers).slice(0, top)
      .map(({ to, callers, aiCallers, ratio, aiUnchecked }) => ({ to, callers, aiCallers, unchecked: aiUnchecked, ratio: Math.round(ratio * 100) }));
  }
}
