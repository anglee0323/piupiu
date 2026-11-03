// gang.fun「Agent 押金承诺」（GangBond，2026-10-29 上线，合约 0xe92d…14E4，开源：gangfun/gang-launchpad）：
// 创建者押一笔报价币，承诺「创建地址至少持有 X 个币，直到上 PancakeSwap 后 N 天（7–90）」。期间少于 X（卖出 / 转走）
// 任何人都能举报：押金 1% 给举报人，其余从交易对分块买回这个币打进 0xdead。到期且一直持有 → 押金退回。
// 这里只读 gang.fun 的公开接口 /api/bonds（官方 indexer，从部署区块开始索引），每分钟拉一次，挂到代币上给页面显示 / 筛选。
// 覆盖率 = 押金 ÷ 现在把 X 卖进池子能拿到多少；≥100% 表示开发者砸盘会亏钱。gang.fun 的颜色规则：报价币在白名单、
// X 至少是设定时创建者持仓的一半才上色（≥100% 绿「押金全覆盖」，50–100% 黄「押金」），否则灰色「押金」。
import { EventEmitter } from 'node:events';
import { EP } from './endpoints.js';

const API = EP.gang ? `${EP.gang}/bonds` : '';
const POLL_MS = 60_000;
const lc = (a) => String(a || '').toLowerCase();
const SUPPLY = 1e27;   // GangLaunchpad 代币总量 10 亿（18 位小数）

/** 接口一条 → 页面用的精简结构 */
export function bondView(x) {
  const cov = x.coverageBps == null ? null : Number(x.coverageBps);
  const qualified = !!x.quoteTrusted && Number(x.holdOfBalanceBps || 0) >= 5000;
  const tier = x.state !== 'active' ? null : x.phase !== 'running' || cov == null || !qualified ? 'gray' : cov >= 10_000 ? 'full' : cov >= 5_000 ? 'bond' : 'gray';
  return {
    state: x.state,                       // active / slashed / settled / refunded
    phase: x.phase || null,               // pending（还没上池子，倒计时没开始）/ running / due / settle-requested …
    round: Number(x.round) || 1,
    creator: lc(x.creator), creatorHandle: x.creatorHandle || null,
    quote: lc(x.quote),
    amount: String(x.amount || '0'),      // 押金（报价币最小单位）
    valueBnb: x.postedValueBnb != null ? Number(x.postedValueBnb) / 1e18 : null,   // 押下时折合多少 BNB
    holdPct: x.holdAmount != null ? (Number(x.holdAmount) / SUPPLY) * 100 : null, // 承诺持有量占总量
    holdOfBalancePct: x.holdOfBalanceBps != null ? Number(x.holdOfBalanceBps) / 100 : null,
    days: x.durationSec ? Math.round(Number(x.durationSec) / 86400) : null,
    deadline: x.deadline ? Number(x.deadline) * 1000 : null,
    postedAt: x.postedAt ? Number(x.postedAt) * 1000 : null,
    coveragePct: cov == null ? null : Math.min(cov, 1_000_000) / 100,
    tier, qualified,
    violated: !!x.violated,
    live: !!x.live,
    burnLeft: String(x.burnLeft || '0'), tokensBurned: String(x.tokensBurned || '0'),
    tx: x.postedTx || null,
    checkedAt: x.checkedAt ? Number(x.checkedAt) * 1000 : null,
  };
}

export class GangBonds extends EventEmitter {
  constructor() {
    super();
    this.map = new Map();
    this.status = { ok: false, total: 0, lastError: null, at: 0, enabled: null };
  }
  get(token) { return this.map.get(lc(token)) || null; }
  start() { this.loop(); }
  async page(offset) {
    const r = await fetch(`${API}?limit=100&offset=${offset}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`gang.fun /api/bonds HTTP ${r.status}`);
    return r.json();
  }
  async poll() {
    const next = new Map();
    for (let off = 0, n = 0; n < 20; n++) {   // 最多 2000 条
      const j = await this.page(off);
      // 同一个币可能押过多轮：接口按时间倒序，保留最新一轮
      for (const x of j.items || []) if (x?.token && !next.has(lc(x.token))) next.set(lc(x.token), bondView(x));
      if (!j.hasMore) break; off = j.nextOffset ?? off + (j.items || []).length;
    }
    const changed = [];
    for (const [k, v] of next) { const o = this.map.get(k); if (!o || o.state !== v.state || o.phase !== v.phase || o.violated !== v.violated || o.tier !== v.tier || o.amount !== v.amount) changed.push(k); }
    for (const k of this.map.keys()) if (!next.has(k)) changed.push(k);
    this.map = next;
    Object.assign(this.status, { ok: true, total: next.size, lastError: null, at: Date.now() });
    if (changed.length) this.emit('change', changed);
  }
  async loop() {
    for (;;) {
      try { await this.poll(); } catch (e) { this.status.ok = false; this.status.lastError = e.message; }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }
}
