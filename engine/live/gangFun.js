// gang.fun（BNB Chain 上只对 Binance Agentic Wallet + .ai Agent ID 开放的发射平台）行情：只读它的公开接口。
// 代币列表 /api/tokens（老的 BNB 盘）和 /api/stocks/tokens（V2 盘，报价币可以是 BNB / GANG / 币股，带 logoUrl）每 20 秒拉一次；
// 最近有成交的几个盘每 10 秒拉一次成交，进成交流和 K 线。V2 盘的价格和金额按报价币美元价换算成 BNB。
// 下单在 gangTrade.js：老盘（0x315B…23A7，BNB 计价）支持内盘买卖；V2 报价币盘只看行情。
import { EventEmitter } from 'node:events';
import { EP } from './endpoints.js';

const API = EP.gang;
const LIST_MS = 5_000, LIST_SLOW_MS = 20_000, TRADES_MS = 10_000, HOT = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 限流自动降速：连续 3 次限流 → 退回旧间隔 20000ms，冷却 10 分钟后再试快速
const RL_RE = /429|rate.?limit|too many requests|-32005|limit exceeded|限流/i;
function rlNote(st, err) {
  const now = Date.now();
  if (err && RL_RE.test(String(err.shortMessage || err.message || err) + ' ' + (err.code ?? '') + ' ' + (err.error?.code ?? ''))) {
    st.rlHits = (st.rlHits || 0) + 1;
    if (st.rlHits >= 3 && !(st.backoffUntil > now)) { st.backoffUntil = now + 10 * 60_000; st.backoffCount = (st.backoffCount || 0) + 1; console.log(`[Gang] 连续限流 ${st.rlHits} 次，轮询退回 20000ms，10 分钟后再试 5000ms`); }
  } else if (!err) st.rlHits = 0;
  if (st.backoffUntil && st.backoffUntil <= now) { st.backoffUntil = 0; st.rlHits = 0; console.log('[Gang] 限流冷却结束，恢复 5000ms 轮询'); }
  st.intervalMs = st.backoffUntil > now ? 20000 : 5000;
  return st.intervalMs;
}


export class GangFun extends EventEmitter {
  constructor() {
    super();
    this.seen = new Map();          // address → 上次看到的成交笔数，有变化才去拉成交
    this.lastTx = new Map();        // address → 已处理的最新成交时间
    this.v2 = new Map();            // V2 盘：address → { quoteUsd }，成交接口和换算要用
    this.v3 = new Set();            // V3 盘（GangLaunchpad）：成交在 /v3/tokens/:a/trades，字段和 V2 同一套
    this.fly = new Set();           // 铸币飞轮（GangFlywheelPad）：成交（铸造 / 卖回 / 开盘后的池子买卖）在 /fly/tokens/:a/trades，字段同 V3
    this.pathOf = new Map();        // address → 成交接口前缀（'' 老盘 / '/stocks' V2 / '/v3' V3），探测过的记住
    this.bnbUsd = 0;
    this.status = { connected: false, total: 0, lastError: null, lastPollMs: 0, pausedUntil: 0 };
  }

  start() { this.loopList(); this.loopTrades(); }

  async get(path) {
    const wait = this.status.pausedUntil - Date.now(); if (wait > 0) await sleep(wait);
    const res = await fetch(API + path, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 429) { this.status.pausedUntil = Date.now() + 60_000; throw new Error('gang.fun 限流（429），暂停 1 分钟'); }
    if (!res.ok) throw new Error(`gang.fun HTTP ${res.status}`);
    return res.json();
  }

  async loopList() {
    let first = true;
    for (;;) {
      const t0 = Date.now();
      try {
        const items = [];
        for (let off = 0; off < 1000;) { const j = await this.get(`/tokens?sort=new&limit=200&offset=${off}`); items.push(...(j.items || [])); if (!j.hasMore) break; off = j.nextOffset; }
        this.bnbUsd = Number(items[0]?.bnbUsd) || this.bnbUsd;
        for (let off = 0; off < 1000;) {
          const j = await this.get(`/stocks/tokens?limit=100&offset=${off}`);
          for (const x of j.items || []) items.push(this.fromV2(x));
          if (!j.hasMore) break; off = j.nextOffset;
        }
        // V3（10-27 合并后的新发射）：链上事件只能看到服务启动之后的新盘，之前发的、已毕业的靠这个列表补全
        for (let off = 0; off < 1000;) {
          const j = await this.get(`/v3/tokens?status=all&limit=100&offset=${off}`).catch(() => null);
          if (!j) break;
          for (const x of j.items || []) items.push(this.fromV3(x));
          if (!j.hasMore || !j.nextOffset) break; off = j.nextOffset;
        }
        // 打新（固定价认购）：和 V3 曲线币同一个合约、不同的列表（/fair/sales）；认购中的显示在新创建 / 即将打满，认购满开盘后进已开盘
        for (let off = 0; off < 1000;) {
          const j = await this.get(`/fair/sales?status=all&limit=100&offset=${off}`).catch(() => null);
          if (!j) break;
          for (const x of j.items || []) items.push(this.fromFair(x));
          if (!j.hasMore || !j.nextOffset) break; off = j.nextOffset;
        }
        // 铸币飞轮：开盘前按份铸造（显示在新创建 / 即将打满，进度 = 已铸份数 / 10000），开盘后进已开盘
        for (let off = 0; off < 1000;) {
          const j = await this.get(`/fly/tokens?status=all&limit=100&offset=${off}`).catch(() => null);
          if (!j) break;
          for (const x of j.items || []) items.push(this.fromFly(x));
          if (!j.hasMore || !j.nextOffset) break; off = j.nextOffset;
        }
        for (const it of items) {
          const isNew = !first && !this.seen.has(it.address);
          this.emit('token', it, { isNew });
          if (!this.seen.has(it.address)) this.seen.set(it.address, -1);
        }
        this.status.total = items.length; this.status.connected = true; this.status.lastError = null; first = false; rlNote(this.status, null);
      } catch (e) { this.status.connected = false; this.status.lastError = e.message; rlNote(this.status, e); }
      this.status.lastPollMs = Date.now() - t0;
      await sleep(this.status.intervalMs || LIST_MS);
    }
  }

  // V2 盘统一成和老盘一样的字段；已筹 / 门槛保留报价币单位，价格换成 BNB
  // 分红：taxed=true 是税币（TaxLaunchToken）：内盘 + 外盘买卖 1% 税，一半按持仓分给持有 ≥1 万枚的地址（报价币发放，经分红金库），另一半 80% 回购销毁 GANG / 20% 进金库；
  // taxed=false 是普通币（LaunchToken）：内盘 1% 平台费（80% 回购销毁 GANG / 20% 金库），毕业后 0 税、不分红。dividends 里有累计 / 近 7 天 / 每万枚 / 年化
  fromV2(x) {
    const qUsd = Number(x.quoteUsd) || 0, bUsd = this.bnbUsd || 1;
    this.v2.set(x.address, { quoteUsd: qUsd });
    return { address: x.address, name: x.name, symbol: x.symbol, creator: x.creator, creatorHandle: x.creatorHandle, createdAt: x.createdAt, graduated: x.graduated, graduatedAt: x.graduatedAt || null, pair: x.pair,
      raisedQuote: Number(x.raisedQuote) || 0, gradAmtQuote: Number(x.gradAmtQuote) || 0, quoteSymbol: x.quoteSymbol || 'BNB', quoteAddress: x.quoteAddress,
      progressPct: x.progressPct, priceBnb: (Number(x.priceUsd) || 0) / bUsd, priceQuote: Number(x.priceQuote) || null, quoteUsd: qUsd, fdvUsd: x.fdvUsd, holders: x.holders, trades: x.trades, lastTradeAt: x.lastTradeAt,
      volume24hBnb: (Number(x.volume24hUsd) || 0) / bUsd, logo: x.logoUrl ? new URL(x.logoUrl, 'https://gang.fun').href : null, track: 'v2',
      taxed: x.taxed ?? null, taxBps: x.taxBps ?? null, dividends: x.dividends || null, dividendVault: x.dividends?.vault || x.v2DividendVault || null };   // logoThumbUrl 是相对路径且实际返回网页，不能用
  }

  // V3 盘：金额是报价币最小单位（quoteDecimals 位），价格 priceQuote 已是报价币单位；买卖税 / 分红比例直接带上
  fromV3(x) {
    this.v3.add(String(x.address).toLowerCase());
    const dec = Number(x.quoteDecimals) || 18, u = (v) => (v == null ? 0 : Number(v) / 10 ** dec);
    const wbnb = String(x.quoteAddress || '').toLowerCase() === '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
    return { address: String(x.address).toLowerCase(), name: x.name, symbol: x.symbol, creator: x.creator, creatorHandle: x.creatorHandle, createdAt: x.createdAt, graduated: !!x.graduated, graduatedAt: x.graduatedAt || null, pair: x.pair,
      raisedQuote: u(x.realQuote), gradAmtQuote: u(x.gradAmt), quoteSymbol: wbnb ? 'BNB' : x.quoteSymbol || 'BNB', quoteAddress: x.quoteAddress, progressPct: x.progressPct,
      priceQuote: Number(x.priceQuote) || null, trades: x.trades, lastTradeAt: x.lastActivityAt, volume24hBnb: wbnb ? Number(x.volume24hQuote) / 1e18 || 0 : 0,
      logo: x.logoUrl ? new URL(x.logoUrl, 'https://gang.fun').href : null, track: 'v3',
      v3: { buyTaxBps: Number(x.buyTaxBps) || 0, sellTaxBps: Number(x.sellTaxBps) || 0, dividendBps: Number(x.dividendBps) || 0, recipient: x.recipient || null, recipientLabel: x.recipientLabel || null } };
  }

  // 打新：10000 份固定价认购（一半供应量），认购满自动开盘，开盘价 = 认购价。没有曲线，价格全程不变。
  // 金额都是计价币单位（18 位）；progressPct = 已售份数 / 10000
  fromFair(x) {
    const q = (v) => (v == null ? 0 : Number(v) / 1e18);
    const wbnb = String(x.quoteAddress || '').toLowerCase() === '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
    const total = Number(x.totalShares) || 10000, sold = Number(x.sold) || 0, launched = x.status === 'launched';
    return { address: String(x.address).toLowerCase(), name: x.name, symbol: x.symbol, creator: x.creator, creatorHandle: x.creatorHandle, createdAt: x.createdAt, graduated: launched, graduatedAt: x.launchedAt || null, pair: x.pair || null,
      raisedQuote: sold * q(x.sharePrice), gradAmtQuote: q(x.raiseQuote), quoteSymbol: wbnb ? 'BNB' : x.quoteSymbol || 'BNB', quoteAddress: x.quoteAddress, progressPct: (sold / total) * 100,
      priceQuote: Number(x.priceQuote) || null, trades: x.trades24h, lastTradeAt: x.lastActivityAt, volume24hBnb: Number(x.volume24hQuote) || 0, holders: launched ? null : Number(x.participants) || 0,
      logo: x.logoUrl ? new URL(x.logoUrl, 'https://gang.fun').href : null, track: 'v3fair',
      fair: { status: x.status, sold, totalShares: total, participants: Number(x.participants) || 0, capShares: Number(x.capShares) || 0, minParticipants: Number(x.minParticipants) || 0, sharesLeft: Number(x.sharesLeft) || 0, minWalletsLeft: Number(x.minWalletsLeft) || 0,
        sharePrice: q(x.sharePrice), raiseQuote: q(x.raiseQuote), holdPct: (Number(x.holdBps) || 0) / 100, mintFeePct: (Number(x.mintFeeBps) || 0) / 100, exitFeePct: (Number(x.exitFeeBps) || 0) / 100, exitFeeNowPct: (Number(x.exitFeeNowBps) || 0) / 100,
        stale: !!x.stale, exitFeeFreeAt: x.exitFeeFreeAt ? x.exitFeeFreeAt * 1000 : null, lastMintAt: x.lastMintAt ? x.lastMintAt * 1000 : null } };
  }

  // 铸币飞轮：金额是计价币最小单位（目前都是 WBNB，18 位）；份额价格、每份币数、额度、费率、开盘后规则一起带上（页面的飞轮卡片和下单用）
  fromFly(x) {
    const a = String(x.address).toLowerCase(); this.fly.add(a);
    const dec = Number(x.quoteDecimals) || 18, q = (v) => (v == null ? 0 : Number(v) / 10 ** dec), bps = (v) => (Number(v) || 0) / 100;
    const wbnb = String(x.quoteAddress || '').toLowerCase() === '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
    const total = Number(x.totalShares) || 10000, sold = Number(x.sold) || 0, launched = x.status === 'launched';
    return { address: a, name: x.name, symbol: x.symbol, creator: x.creator, creatorHandle: x.creatorHandle, createdAt: x.createdAt, graduated: launched, graduatedAt: x.launchedAt || null, pair: x.pair || null,
      raisedQuote: sold * q(x.sharePrice), gradAmtQuote: q(x.raiseQuote), quoteSymbol: wbnb ? 'BNB' : x.quoteSymbol || 'BNB', quoteAddress: x.quoteAddress, progressPct: launched ? 100 : (sold / total) * 100,
      priceQuote: Number(x.priceQuote) || null, trades: x.trades, lastTradeAt: x.lastActivityAt, volume24hBnb: wbnb ? Number(x.volume24hQuote) || 0 : 0, holders: launched ? null : Number(x.participants) || 0,
      website: x.website || null, twitter: x.twitter || null,
      logo: x.logoUrl ? new URL(x.logoUrl, 'https://gang.fun').href : null, track: 'fly',
      fly: { status: x.status, pad: x.pad || null, padVersion: Number(x.padVersion) || null, gated: !!x.gated, wbnb,
        sharePriceWei: String(x.sharePrice || '0'), sharePrice: q(x.sharePrice), basePrice: q(x.basePrice), tokensPerShare: Number(x.tokensPerShare || 0) / 1e18,
        totalShares: total, sold, sharesLeft: Number(x.sharesLeft) || 0, mintedShares: Number(x.mintedShares) || 0, postMints: Number(x.postMints) || 0, participants: Number(x.participants) || 0, minWalletsLeft: Number(x.minWalletsLeft) || 0,
        baseQuota: Number(x.baseQuota) || 0, inviteBonus: Number(x.inviteBonus) || 0, maxPerTx: Number(x.maxPerTx) || 10, holdPct: bps(x.holdBps),
        mintFeePct: bps(x.mintFeeBps), exitFeePct: bps(x.exitFeeBps), exitFeeNowPct: bps(x.exitFeeNowBps), exitFeeFreeAt: x.exitFeeFreeAt ? x.exitFeeFreeAt * 1000 : null,
        devCutPct: bps(x.devCutBps), buyPct: bps(x.buyBps), buyTaxPct: bps(x.buyTaxBps ?? 100), sellTaxPct: bps(x.sellTaxBps),
        launchDelay: Number(x.launchDelay) || 0, windowSec: Number(x.window) || 0, windowCapMul: Number(x.windowCapMul) || 1,
        postMint: !!x.postMint, tierMode: Number(x.tierMode) || 0, supplyCapMul: Number(x.supplyCapMul) || 0, guardPct: bps(x.guardBps), twapMin: Math.round((Number(x.twapWindow) || 0) / 60),
        sellBackOpen: !!x.sellBackOpen, withdrawable: !!x.withdrawable, refundOnly: !!x.refundOnly, stale: !!x.stale, mintPaused: x.mintPaused ?? null,
        filledAt: x.filledAt ? x.filledAt * 1000 : null, filledEarly: x.filledEarly ?? null, launchAt: x.launchAt ? x.launchAt * 1000 : null, launchedAt: x.launchedAt ? x.launchedAt * 1000 : null,
        lastMintAt: x.lastMintAt ? x.lastMintAt * 1000 : null } };
  }

  // 成交：只拉最近有新成交的几个盘，避免频繁请求
  async loopTrades() {
    await sleep(3000);
    for (;;) {
      try {
        const hot = [...this.hotList()].slice(0, HOT);
        for (const a of hot) { await this.trades(a, 40); await sleep(300); }
      } catch (e) { this.status.lastError = e.message; }
      await sleep(TRADES_MS);
    }
  }

  hotList() { return this.hot || []; }
  setHot(list) { this.hot = list; }

  // 成交金额（报价币）：买入按「实际付出」= 接口里的净额 + 平台费（V2 是 quoteIn + taxPlat + taxDiv，老盘是 bnb + fee）；
  // 卖出接口给的已经是扣完费到手的数。以前买入用的是净额，成本少算了约 1%
  static amt(x, v2) {
    const n = (k) => Number(x[k] || 0);
    if (v2) return x.side === 'buy' ? n('quoteIn') + n('taxPlat') + n('taxDiv') : n('quoteIn') || n('quoteOut');
    return x.side === 'buy' ? n('bnb') + n('fee') : n('bnb');
  }

  // 成交接口前缀：已知版本直接用；不知道的（链上刚发现、列表还没收录）依次试 V3 / 老盘 / V2，第一个不 404 的记住
  async tradesPath(address, track = null) {
    const a = String(address).toLowerCase();
    if (track === 'fly' || this.fly.has(a)) return '/fly';
    if (track === 'v3' || this.v3.has(a)) return '/v3';
    if (track === 'v2' || this.v2.has(address) || this.v2.has(a)) return '/stocks';
    if (track === 'v1') return '';
    if (this.pathOf.has(a)) return this.pathOf.get(a);
    for (const pre of ['/v3', '', '/stocks']) {
      try { await this.get(`${pre}/tokens/${address}/trades?limit=1&offset=0&sort=ts_desc`); this.pathOf.set(a, pre); if (pre === '/v3') this.v3.add(a); return pre; }
      catch (e) { if (!/HTTP 404/.test(e.message)) throw e; }
    }
    throw new Error('gang.fun 上没有这个币的成交记录（可能刚发射还没收录）');
  }

  // 全部成交历史（翻页，最多 max 条），只用来从开盘起重建 K 线，不当作新成交推送。返回按时间升序的 { ts, price, bnb }
  async history(address, max = 4000, track = null) {
    const pre = await this.tradesPath(address, track); const v2 = pre !== ''; const out = [];
    for (let off = 0; off < max;) {
      const j = await this.get(`${pre}/tokens/${address}/trades?limit=200&offset=${off}&sort=ts_desc`);
      for (const x of j.items || []) out.push({ ts: x.ts * 1000, price: Number(x.price), bnb: GangFun.amt(x, v2), tx: x.tx, side: x.side, trader: x.trader, name: x.traderHandle || null, tokens: Number(x.tokens) });
      if (!j.hasMore || !j.nextOffset) break; off = j.nextOffset; await sleep(250);
    }
    return out.reverse();
  }

  // 拉一个盘的成交（选中代币时也会调用，limit 大一些用来画 K 线）
  async trades(address, limit = 200, track = null) {
    const pre = await this.tradesPath(address, track); const v2 = pre !== '';
    const j = await this.get(`${pre}/tokens/${address}/trades?limit=${limit}&offset=0&sort=ts_desc`);
    const last = this.lastTx.get(address) || 0;
    const k = 1;   // 和全站约定一致：价格 / 金额都用报价币单位，换美元时再乘 quoteUsd
    const rows = (j.items || []).map((x) => ({ token: address, side: x.side, trader: x.trader, name: x.traderHandle || null,
      bnb: GangFun.amt(x, v2) * k, tokens: Number(x.tokens),
      price: Number(x.price) * k, ts: x.ts * 1000, tx: x.tx })).reverse();
    // 第一次拉这个币（last=0）时：15 分钟内的成交也算新（能推给追踪）；更早的只是补历史，不推
    for (const r of rows) this.emit('trade', r, { live: last > 0 ? r.ts > last : Date.now() - r.ts < 15 * 60_000 });
    if (rows.length) this.lastTx.set(address, Math.max(last, rows.at(-1).ts));
    return rows;
  }
}
