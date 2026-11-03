// 条件单（对应 GMGN 下单面板的「限价 / DCA / 自动（止盈止损）」）。在本机后端里盯价格，条件满足时用 placeOrder 下市价单。
// - limit：市值到达目标时买入 / 卖出（买入：MC ≤ 目标；卖出：MC ≥ 目标）
// - tp / sl：止盈（MC ≥ 目标卖出持仓的 X%）/ 止损（MC ≤ 目标卖出 X%）
// - dca：把一笔金额（或卖出比例）分成 N 份，每隔 T 秒执行一份；可选价格保护（买入时 MC 高于上限就跳过这一份，卖出时低于下限跳过）
// 内盘币和已开盘的币都能用（行情里有市值就行）；只在后端开着的时候生效。每单只触发一次，结果写回记录。
// 下单来源记为「条件单 …」，和手动、跟单一样按 LIVE_TRADE 决定是否真实上链。
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const lc = (a) => String(a || '').toLowerCase();
const KINDS = new Set(['limit', 'tp', 'sl', 'dca']);

export class CondOrders extends EventEmitter {
  constructor({ market, placeOrder, file, log = () => {}, defaultSlots = null }) {
    super();
    this.market = market; this.placeOrder = placeOrder; this.file = file; this.log = log; this.defaultSlots = defaultSlots;   // 多钱包：创建时记下当时的「交易钱包」选择，触发时只用这些钱包（掉线的会被跳过）
    try { this.orders = JSON.parse(readFileSync(file, 'utf8')).orders || []; } catch { this.orders = []; }
    for (const o of this.orders) if (o.status === 'running') o.status = 'open';   // 重启时执行到一半的：回到等待
    this.busy = new Set();
    this.timer = setInterval(() => this.tick(), 1000);
  }
  // 行情快照：实盘的 get() 已经带市值；模拟盘要经 summary() 换算
  snap(a) { const t = this.market.get?.(a); return t && t.mcapUsd == null && this.market.summary ? this.market.summary(t) : t; }
  save() { try { mkdirSync(new URL('.', this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify({ orders: this.orders.slice(-500) }, null, 1)); } catch { /* 下次再存 */ } this.emit('change', this.view()); }
  view() { return this.orders.slice().sort((a, b) => b.createdAt - a.createdAt); }

  create(b) {
    const kind = String(b.kind || ''); if (!KINDS.has(kind)) throw new Error('条件单类型无效');
    const token = lc(b.token); if (!/^0x[0-9a-f]{40}$/.test(token)) throw new Error('代币地址无效');
    const t = this.snap(token) || this.snap(b.token); if (!t) throw new Error('行情中没有该代币');
    const side = kind === 'tp' || kind === 'sl' ? 'sell' : b.side === 'sell' ? 'sell' : 'buy';
    const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : NaN; };
    const slots = (Array.isArray(b.slots) && b.slots.length ? b.slots : (this.defaultSlots ? this.defaultSlots() : null) || []).map(Number).filter((x) => x > 0).filter((x, i, a) => a.indexOf(x) === i);   // 不传 = 创建那一刻的全局交易钱包
    const o = { id: 'k' + randomBytes(4).toString('hex'), kind, side, token, address: t.address, symbol: t.symbol, platform: t.platform, createdAt: Date.now(), status: 'open', slots: slots.length ? slots : undefined,
      slippage: Math.min(50, Math.max(1, num(b.slippage) || 20)), createdMc: t.mcapUsd || null, expireAt: num(b.expireAt) > Date.now() ? num(b.expireAt) : null, results: [], note: String(b.note || '').slice(0, 60) };
    if (side === 'buy') { o.amount = num(b.amount); if (!(o.amount > 0)) throw new Error('买入金额须大于 0'); }
    else { o.pct = Math.min(100, num(b.pct)); if (!(o.pct > 0)) throw new Error('卖出比例须大于 0'); }
    if (kind === 'dca') {
      o.parts = Math.round(num(b.parts)); o.intervalSec = Math.round(num(b.intervalSec));
      if (!(o.parts >= 2 && o.parts <= 100)) throw new Error('DCA 份数须在 2–100 之间');
      if (!(o.intervalSec >= 5)) throw new Error('DCA 间隔不少于 5 秒');
      o.done = 0; o.nextAt = Date.now();
      o.guardMc = num(b.guardMc) > 0 ? num(b.guardMc) : null;   // 买入：MC 高于它就跳过这一份；卖出：MC 低于它跳过
    } else {
      o.triggerMc = num(b.triggerMc); if (!(o.triggerMc > 0)) throw new Error('目标市值须大于 0');
      o.cmp = kind === 'sl' || (kind === 'limit' && side === 'buy') ? 'lte' : 'gte';
    }
    this.orders.push(o); this.save();
    this.log(`[条件单] 新建 ${o.id} ${kind} ${side} ${o.symbol} ${o.triggerMc ? '@MC ' + Math.round(o.triggerMc) : ''}`);
    return o;
  }
  cancel(id) {
    const o = this.orders.find((x) => x.id === id); if (!o) throw new Error('条件单不存在');
    if (o.status === 'open') { o.status = 'cancelled'; o.endedAt = Date.now(); this.save(); }
    return o;
  }
  remove(id) { this.orders = this.orders.filter((x) => x.id !== id || x.status === 'open'); this.save(); }

  async fire(o, amount, label) {
    this.busy.add(o.id);
    try {
      const r = [].concat(await this.placeOrder({ token: o.address || o.token, side: o.side, amount, slippage: o.slippage, slots: o.slots, source: `条件单 ${label}`, symbol: o.symbol }) || []);   // 没记 slots 的旧单：走当时的全局选择
      const ok = r.length && r.some((x) => x?.status !== 'failed');
      o.results.push({ ts: Date.now(), mc: this.snap(o.address || o.token)?.mcapUsd || null, amount, ok: !!ok, reason: r.map((x) => x?.reason).filter(Boolean).join('；').slice(0, 300) || null, tx: r.find((x) => x?.tx)?.tx || null, dryRun: r.some((x) => x?.dryRun) });
      return ok;
    } catch (e) { o.results.push({ ts: Date.now(), amount, ok: false, reason: e.message }); return false; }
    finally { this.busy.delete(o.id); }
  }

  async tick() {
    const now = Date.now();
    for (const o of this.orders) {
      if (o.status !== 'open' || this.busy.has(o.id)) continue;
      if (o.expireAt && now > o.expireAt) { o.status = 'expired'; o.endedAt = now; this.save(); continue; }
      const t = this.snap(o.address || o.token); const mc = t?.mcapUsd;   // 模拟盘的行情按原始大小写存 if (!(mc > 0)) continue;
      if (o.kind === 'dca') {
        if (now < o.nextAt) continue;
        o.nextAt = now + o.intervalSec * 1000;
        const skip = o.guardMc && (o.side === 'buy' ? mc > o.guardMc : mc < o.guardMc);
        if (skip) { o.results.push({ ts: now, mc, ok: false, skipped: true, reason: `市值 $${Math.round(mc)} 超出保护价，跳过本份` }); }
        else {
          // 卖出：每份卖「当前持仓」的 1/剩余份数，最后一份卖完
          const amount = o.side === 'buy' ? +(o.amount / o.parts).toFixed(6) : Math.min(100, +((o.pct / 100) * 100 / (o.parts - o.done)).toFixed(2));
          await this.fire(o, amount, `DCA ${o.done + 1}/${o.parts}`);
        }
        o.done++;
        if (o.done >= o.parts) { o.status = 'done'; o.endedAt = Date.now(); }
        this.save(); continue;
      }
      const hit = o.cmp === 'lte' ? mc <= o.triggerMc : mc >= o.triggerMc;
      if (!hit) continue;
      o.status = 'running'; o.triggeredAt = now; o.triggerSeenMc = mc; this.save();
      const label = o.kind === 'limit' ? `限价${o.side === 'buy' ? '买' : '卖'}` : o.kind === 'tp' ? '止盈' : '止损';
      const ok = await this.fire(o, o.side === 'buy' ? o.amount : o.pct, label);
      o.status = ok ? 'done' : 'failed'; o.endedAt = Date.now(); this.save();
      this.log(`[条件单] ${o.id} ${label} ${o.symbol} 触发（MC $${Math.round(mc)}）→ ${o.status}`);
    }
  }
}
