// 实盘行情适配器：把 Flap Agent Curve Reader + fsi、four.meme Agentic Wallet 专属内盘（链上事件）+ shrine 统一成和模拟盘一样的接口（list / get / detail / 事件）。
import { EventEmitter } from 'node:events';
import { ethers } from 'ethers';
import { RPC_URL, RPC_LIST, NODEREAL_SCOPE, BNB_PRICE_URL, dataFile } from './config.js';
import { FailoverProvider, nodeName, PUBLIC_RPC } from './rpc.js';
import { AgentCurve } from './agentCurve.js';
import { FourMeme, AGENT_ID_TEMPLATE } from './fourMeme.js';
import { MetaFetcher, ipfsUrl } from './meta.js';
import { GangFun } from './gangFun.js';
import { GangChain, QUOTE_DEC } from './gangChain.js';
import { FlapChain } from './flapChain.js';
import { FlapNft } from './flapNft.js';
import { GangPadChain } from './gangPadChain.js';
import { GangV2 } from './gangV2Pads.js';
import { V3_TRADE } from './gangV3.js';
import { DexFeed, dexBars, compactCandles } from './dexFeed.js';
import { NameCache } from './names.js';
import { ShrineFeeds, tokenInfo } from './shrine.js';
import * as fsi from './fsi.js';
import { GangBonds } from './gangBond.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { EP } from './endpoints.js';
const FOUR_REG = dataFile('fourTokens.json');
const FLAP_REG = dataFile('flapCreated.json');
const BOOT = Date.now();

const MAX = 1000;                      // Flap Agent 曲线市场、持有中 / 收藏的币不参与淘汰，超出时淘汰最老的盘
const num = (v) => { if (v == null || v === '') return null; if (typeof v === 'number') return v; const m = String(v).replace(/[$,\s]/g, '').match(/^(-?[\d.]+)([KMB])?$/i); if (!m) return Number(v) || null; return Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1); };
const sec2ms = (v) => { const x = Number(v); return !x ? Date.now() : x < 1e12 ? x * 1000 : x; };
const isAgentish = (l) => l.agentExclusive === true || l.agent === true || l.isAgent === true || (Array.isArray(l.tags) && l.tags.some((t) => /agent/i.test(t)));

// 代币名字 / 符号是任何人都能随便写的（有人故意写成 <img src=… onerror=…> 这类网页代码）。界面按纯文本显示不会执行，
// 但满屏都是代码很难看：去掉像标签的部分和控制字符，限制长度；清完是空的就用备用文字
export function cleanName(v, fallback = '') {
  const s = String(v ?? '').replace(/<[^>]*>?/g, '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return s || fallback;
}

export class LiveMarket extends EventEmitter {
  quoteUsd(t) { const q = String(t?.quote || 'BNB').toUpperCase(); if (q === 'BNB' || q === 'WBNB') return this.bnbUsd; if (['USDT','USDC','USD1'].includes(q)) return 1; return this.qUsd[String(t.quoteAddress || '').toLowerCase()] || 0; }
  constructor() {
    super();
    // 两套节点：行情 / 持仓 / 监控这类不赶时间的读取走公共节点优先（省 NodeReal 额度）；下单、确认、卖前余额这条交易链路走 NodeReal 优先
    this.provider = new FailoverProvider([...new Set([PUBLIC_RPC, ...EP.rpcPublic.slice(0, 1), ...RPC_LIST.filter((u) => NODEREAL_SCOPE === 'all' || !/nodereal/i.test(u))])].filter(Boolean), '行情读取');   // 默认完全不用 NodeReal（额度只给下单）；NODEREAL_SCOPE=all 时公共节点都不行才兜底到它
    this.tradeProvider = new FailoverProvider(RPC_LIST, '交易');
    this.curve = new AgentCurve(this.provider);
    this.four = new FourMeme();
    this.gang = new GangFun();
    this.bonds = new GangBonds();   // gang.fun Agent 押金承诺（开发者承诺持有，卖了押金被罚没回购销毁）
    this.dexFeed = new DexFeed(new ethers.JsonRpcProvider(PUBLIC_RPC, 56, { staticNetwork: true }));   // 已发射币的外盘成交（PancakeSwap V2 池子的 Swap 事件）
    this.gangChain = new GangChain(this.provider);   // 链上创建事件，比接口轮询快
    this.gangChain.on('token', (it) => this.onGangChainToken(it));
    this.flapChain = new FlapChain(this.provider);   // Flap 成交 / 新市场：链上订阅（代替 shrine 推送）
    this.flapChain.on('trade', (tr) => this.onFlapChainTrade(tr));
    this.gangPads = new GangPadChain(this.provider);   // Gang V2 全部成交（链上），以前只有最活跃的几个盘有成交（接口轮询）
    this.gangPads.on('trade', (tr) => this.onGangTrade(tr, true));
    // Flap 普通 Portal 的 Agent ID 门槛盘（NFT-gated）：只有这类 Portal 盘会进列表（普通 Flap Portal 盘本终端不跟踪）
    this.flapNft = new FlapNft(this.provider);
    this.flapNft.on('gated', (g, o) => (o?.restore ? this.restoreFlapNft(g) : this.upsertFlapNft(g, o).catch(() => {})));
    this.flapNft.on('ungated', (g) => { const t = this.get(g.token); if (t?.nftGate) { t.nftGate = { ...t.nftGate, removed: true }; this.emit('detail', t.address); } });
    this.flapNft.on('trade', (tr) => this.onFlapNftTrade(tr));
    this.flapNft.on('dex', (g) => { const t = this.get(g.token); if (t && t.stage === 'curve') { t.stage = 'dex'; t.progress = 100; this.emit('migrate', this.summary(t)); } });
    this.flapChain.on('created', () => { try { this.curve.tick?.(); } catch { /* 下一轮 Reader 轮询也会扫到 */ } });
    this.meta = new MetaFetcher();
    this.names = new NameCache();
    this.feeds = new ShrineFeeds();
    this.tokens = new Map();
    this.flow = [];
    this.bnbUsd = 0; this.qUsd = {}; this.block = 0; this.rpcMs = 0; this.rpcError = null;
  }

  start() {
    this.curve.on('market', (item, { isNew }) => this.upsertCurve(item, isNew));
    this.four.on('token', (it, { isNew }) => this.upsertFour(it, isNew));
    this.four.on('trade', (tr) => this.onFourTrade(tr));
    this.gang.on('token', (it, { isNew }) => this.upsertGang(it, isNew));
    this.gang.on('trade', (tr, { live }) => this.onGangTrade(tr, live));
    this.feeds.on('launch', (l) => this.upsertShrine(l));
    this.feeds.on('trade', (m) => this.onStreamTrade(m));
    this.feeds.on('graduated', (m) => { const t = this.get(m.token); if (t) { t.stage = 'dex'; this.emit('migrate', this.summary(t)); } });
    this.curve.start();
    this.four.start();
    // 首批行情到齐（Gang 第一轮列表 + Four 盘恢复，最多等 12 秒）：界面据此结束「正在同步行情」，不再固定等 12 秒
    this.warmReady = false;
    Promise.race([Promise.all([this.fourRestore(), new Promise((r) => this.gang.once('listReady', r))]), new Promise((r) => setTimeout(r, 12_000))]).then(() => { this.warmReady = true; });
    setTimeout(() => this.fourDexCheck(), 20_000); this.fourDexTimer = setInterval(() => this.fourDexCheck(), 60_000);
    this.gang.start(); this.bonds.start(); this.gangChain.start(); this.flapChain.start(); this.gangPads.start(); this.flapNft.start();
    this.feeds.start();
    const blk = async () => { const t0 = Date.now(); try { this.block = await this.provider.getBlockNumber(); this.rpcMs = Date.now() - t0; this.rpcError = null; } catch (e) { this.rpcError = e.shortMessage || e.message; } };
    const px = async () => { try { const j = await (await fetch(BNB_PRICE_URL)).json(); if (+j.price) this.bnbUsd = +j.price; } catch { /* 保留上次 */ } };
    const qpx = async () => { const qs = new Set(); for (const t of this.tokens.values()) if (t.quoteAddress && t.quote && !['BNB','WBNB','USDT','USDC','USD1'].includes(String(t.quote).toUpperCase())) qs.add(String(t.quoteAddress).toLowerCase());
      for (const a of qs) { try { const j = await (await fetch(`${EP.dexscreener}/latest/dex/tokens/` + a)).json(); const ps = (j.pairs || []).filter((x) => x.chainId === 'bsc' && x.baseToken?.address?.toLowerCase() === a && +x.priceUsd).sort((x, y) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0)); if (ps[0]) this.qUsd[a] = +ps[0].priceUsd; } catch { /* 保留上次 */ } } };
    this.qpx = qpx; blk(); px(); setTimeout(qpx, 3000);
    setTimeout(() => this.dexBatch(), 12_000);
    this.timers = [setInterval(() => this.dexBatch(), 30_000), setInterval(blk, 3000), setInterval(px, 30_000), setInterval(qpx, 60_000), setInterval(() => this.warm(), 8000), setInterval(() => this.flapHolders(), 90_000), setInterval(() => this.flapNftTick(), 6000)];
    setTimeout(() => this.flapHolders(), 15_000);
  }

  stop() { this.timers?.forEach(clearInterval); }

  key(a) { return String(a || '').toLowerCase(); }
  get(a) { return a ? this.tokens.get(this.key(a)) : null; }

  base(address) {
    const k = this.key(address);
    if (!this.tokens.has(k)) {
      this.tokens.set(k, { address: k, symbol: '?', name: '', platform: 'flap', quote: 'BNB', createdAt: Date.now(), stage: 'curve', price: 0, mcapUsd: 0, raised: 0, target: 0, progress: 0,
        remaining: 0, holders: null, buys: 0, sells: 0,   // holders：null = 还不知道，页面显示「—」
 volume: 0, buyTax: 0, sellTax: 0, feeBps: null, trades: [], candles: [], creator: '', market: null });
      if (this.tokens.size > MAX && !this.pruneT) { this.pruneT = setTimeout(() => { this.pruneT = null; this.prune(); }, 1000); this.pruneT.unref?.(); }
    }
    return this.tokens.get(k);
  }

  // 淘汰：攒 2 秒一起做（以前每加一个新币就把全部币扫一遍、排序挑一个淘汰，启动时几千个币进来是平方级的计算，主线程卡 1 秒多）
  prune() {
    const keep = this.keepSet?.() || new Set();   // 持有中、收藏的币（server.js 设置），永远不淘汰
    // 淘汰顺序：最久没人交易的内盘死盘先走；已开盘且有流动性 / 市值的不淘汰（以前按创建时间淘汰，GANG 这种早就毕业的大币反而先被踢掉）
    const alive = (t) => t.stage === 'dex' && ((t.dexLiqUsd || 0) >= 3000 || (t.dexMcapUsd || t.mcapUsd || 0) >= 20000);
    // 上限只数可以淘汰的币：Flap 门槛盘、Agent 曲线市场、Four Agent 专属盘不淘汰（Four 数量少、是核心功能；以前刚恢复的盘没有近期成交，马上被 Gang 的老盘挤掉）
    const cand = [...this.tokens.values()].filter((t) => !t.pinned && !keep.has(t.address) && t.source !== 'agent-curve' && t.source !== 'flap-nft' && t.source !== 'four-agent' && !alive(t));
    if (cand.length <= MAX) return;
    // 按最近动静（成交或创建时间）从旧到新淘汰；刚发射的新盘创建时间最近，不会被选中
    const old = cand.sort((a, b) => Math.max(a.lastTradeAt || 0, a.createdAt) - Math.max(b.lastTradeAt || 0, b.createdAt));
    // 记下被淘汰的（地址 → 淘汰时间）：Gang 列表每轮都会把它们原样带回来，没有新成交就不再加回（不然每轮几百个币进来又被淘汰，推送反复抖动）
    this.evicted ||= new Map();
    for (const t of old.slice(0, cand.length - MAX)) { this.tokens.delete(t.address); this.evicted.set(t.address, Date.now()); }
    if (this.evicted.size > 20_000) this.evicted = new Map([...this.evicted].slice(-10_000));
  }

  upsertCurve(it, isNew) {
    const existed = this.tokens.has(this.key(it.token));
    const t = this.base(it.token);
    Object.assign(t, {
      source: 'agent-curve', platform: 'flap', agentExclusive: true, market: it.market, symbol: it.symbol, name: it.name, quote: it.quote, quoteAddress: it.quoteAddress,
      stage: it.phase === 'graduated' ? 'dex' : 'curve', progress: it.progress, raised: it.pool, target: it.cap, buys: it.buys, sells: it.sells,
      buyTax: it.buyTaxBps != null ? it.buyTaxBps / 100 : t.buyTax, sellTax: it.sellTaxBps != null ? it.sellTaxBps / 100 : t.sellTax, realToken: it.realToken,
    });
    if (!existed) {
      // 真实创建时间：先查 data/flapCreated.json；没有就先给个「启动前 1 天以上」的旧值（真新盘才用 now），再后台用 fsi 第一笔买入时间补（Reader 的 launchedAt 是迁移时间，曲线阶段为 0）
      this.flapReg ||= (() => { try { return JSON.parse(readFileSync(FLAP_REG, 'utf8')); } catch { return {}; } })();
      const known = this.flapReg[this.key(it.market)];
      t.createdAt = known || (isNew ? Date.now() : BOOT - 86400_000 - (this.curve.status.total - it.index) * 60_000);
      if (!known) this.flapQueue(t);
    }
    this.loadMeta(t, ipfsUrl(it.meta));
    if (isNew) this.emit('launch', { ...this.summary(t), detectMs: this.curve.status.lastPollMs });
  }

  flapQueue(t) {
    (this.flapQ ||= []).push(t);
    if (this.flapQRun) return; this.flapQRun = true;
    (async () => {
      while (this.flapQ.length) {
        const x = this.flapQ.shift();
        try { const ms = await fsi.firstTradeAt(x.market); if (ms > 0) { x.createdAt = ms; this.flapReg[this.key(x.market)] = ms; this.flapDirty = true; } } catch { /* 下次重启再补 */ }
        await new Promise((ok) => setTimeout(ok, 250));
        if (this.flapDirty && (!this.flapQ.length || this.flapQ.length % 20 === 0)) { try { writeFileSync(FLAP_REG, JSON.stringify(this.flapReg)); this.flapDirty = false; } catch { /* ignore */ } }
      }
      this.flapQRun = false;
    })();
  }

  // four.meme Agentic Wallet 专属内盘：新盘
  upsertFour(it, isNew) {
    const existed = this.tokens.has(this.key(it.token));
    const t = this.base(it.token);
    Object.assign(t, {
      source: 'four-agent', platform: 'four', agentExclusive: it.agentOnly !== false, presetId: it.agentOnly === false ? '' : String(AGENT_ID_TEMPLATE), symbol: it.symbol, name: it.name,
      quote: it.quote, quoteAddress: it.quoteAddress, creator: it.creator, target: it.raiseAmount, maxSupply: it.maxSupply, saleAmount: it.saleAmount,
      antiSniper: it.antiSniper, paused: it.paused,
    });
    if (!existed) {
      t.createdAt = it.createdAt; t.remaining = it.saleAmount;
      // 链上扫到创建事件的盘，之后的每笔成交都能看到（内盘期间代币不能转账），持有人可以直接按成交算；搜索地址补进来的看不到全部成交，不算
      t.holdersKnown = false; t.bal = new Map(); t.holders = null;
    }
    // 扫到了它的创建事件（不是搜索 / 重启补回来的）：之后的成交都在扫描范围内，从这里开始按成交算持有人
    if (it.agentOnly === undefined && !t.holdersKnown) { t.holdersKnown = true; t.bal = new Map(); t.holders = 0; }
    this.loadMeta(t, it.metaUri);
    if (!existed) this.fourSave();
    if (isNew) this.emit('launch', { ...this.summary(t), detectMs: Math.max(0, Date.now() - it.createdAt) });
  }

  // Four 盘登记表：链上 getLogs 只能回看约 2 万块（publicnode 不给归档），所以见过的盘都存到 data/fourTokens.json，重启后用 Core.tokens() 逐个补回
  fourSave() { clearTimeout(this.fourSaveT); this.fourSaveT = setTimeout(() => { try { const o = {}; for (const t of this.tokens.values()) if (t.source === 'four-agent') o[t.address] = { createdAt: t.createdAt, metaUri: t.metaUrl || null, stage: t.stage }; const old = this.fourReg || {}; mkdirSync(new URL('.', FOUR_REG), { recursive: true }); writeFileSync(FOUR_REG, JSON.stringify({ ...old, ...o })); this.fourReg = { ...old, ...o }; } catch { /* ignore */ } }, 3000); }
  async fourRestore() {
    try { this.fourReg = JSON.parse(readFileSync(FOUR_REG, 'utf8')); } catch { this.fourReg = {}; return; }
    // 还在内盘的、最新的先恢复（战壕先有内容），4 个一起查（以前一个一个查、每个之间再等 0.4 秒，92 个盘要一分半钟）
    const list = Object.entries(this.fourReg).filter(([a]) => !this.tokens.has(a))
      .sort(([, x], [, y]) => (x.stage === 'dex') - (y.stage === 'dex') || (y.createdAt || 0) - (x.createdAt || 0));
    let i = 0;
    const worker = async () => {
      while (i < list.length) {
        const [a, r] = list[i++];
        if (this.tokens.has(a)) continue;
        try { const it = await this.four.lookup(a); const t = this.get(a); if (it && t) { if (r.createdAt) t.createdAt = r.createdAt; if (r.stage === 'dex') t.stage = 'dex'; this.loadMeta(t, r.metaUri); } } catch { /* ignore */ }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  }
  // 迁移判定 + 外盘价格：DexScreener 批量查（每批 30 个，不占 RPC）；有 PancakeSwap 池子就算已迁移
  async fourDexCheck() {
    const list = [...this.tokens.values()].filter((t) => t.source === 'four-agent');
    for (let i = 0; i < list.length; i += 30) {
      const chunk = list.slice(i, i + 30);
      try {
        const r = await (await fetch(`${EP.dexscreener}/tokens/v1/bsc/` + chunk.map((t) => t.address).join(','))).json();
        const best = {};
        for (const p of Array.isArray(r) ? r : []) { const a = String(p.baseToken?.address || '').toLowerCase(); if (!/pancake/i.test(p.dexId || '') || !+p.priceUsd) continue; if (!best[a] || (p.liquidity?.usd || 0) > (best[a].liquidity?.usd || 0)) best[a] = p; }
        for (const t of chunk) {
          const p = best[t.address]; if (!p) continue;
          const was = t.stage; const q = this.quoteUsd(t);
          Object.assign(t, { stage: 'dex', progress: 100, pair: p.pairAddress, dexLiqUsd: p.liquidity?.usd || 0, dexMcapUsd: +p.marketCap || +p.fdv || 0 });
          if (q) t.price = +p.priceUsd / q;
          if (was !== 'dex') { this.emit('migrate', this.summary(t)); this.fourSave(); }
        }
      } catch { /* 下次再查 */ }
      await new Promise((ok) => setTimeout(ok, 1200));
    }
  }

  // Flap Portal 门槛盘：名字 / 代号 / 图标（metaURI 是 IPFS CID）+ 门槛 NFT 信息 + 内盘状态
  async upsertFlapNft(g, { restore } = {}) {
    const k = g.token, existed = this.tokens.has(k);
    if (existed && this.get(k).source !== 'flap-nft') return;
    // 先同步登记进列表（门槛 + 来源），名字 / 状态 / NFT 信息随后补上：搜索、钱包 2 收到订单时不用等这些读取
    const t = this.base(k);
    Object.assign(t, { source: 'flap-nft', platform: 'flap', agentExclusive: g.nft === '0x60b9262456de011f7d15a54cdd8c48baaa8b022f', quote: t.quote || 'BNB', createdAt: g.at || g.seenAt, maxSupply: 1e9,
      nftGate: { capPct: 2, ...t.nftGate, nft: g.nft, removed: !!g.removed, known: g.nft === '0x60b9262456de011f7d15a54cdd8c48baaa8b022f' } });
    {
      const [st, info] = await Promise.all([this.flapNftMeta(t).catch(() => {}), this.flapNft.state(k).catch(() => null), this.flapNft.nftInfo(g.nft).catch(() => null)]).then((r) => r.slice(1));
      if (!g.at && g.block) { try { g.at = (await this.provider.getBlock(g.block)).timestamp * 1000; this.flapNft.save(); } catch { /* 用发现时间 */ } }
      Object.assign(t, { createdAt: g.at || g.seenAt });
      if (info) Object.assign(t.nftGate, { name: info.name, symbol: info.symbol, image: info.image, known: info.known });
      if (st) await this.applyFlapNftState(t, st);
      if (!t.creator) this.flapNft.creatorOf(k, g.tx).then((c) => { if (c && !t.creator) { t.creator = c; this.emit('detail', t.address); } }).catch(() => {});   // 开发者地址：异步补，不挡住列表
      this.flapNftHistory(t).then(() => { if (t.stage === 'dex') return this.dexRefresh(t).then(() => this.emit('detail', t.address)); }).catch(() => {});   // 内盘成交从创建起补齐；已迁移的顺便读一次外盘价，列表里市值不再是「—」
      await this.flapNftTax(t).catch(() => {});
      this.flapSnap(t);
      if (!existed && !restore && t.stage === 'curve') this.emit('launch', { ...this.summary(t), detectMs: Math.max(0, Date.now() - (t.createdAt || Date.now())) });
    }
  }
  // 门槛盘快照（存在 flapNft 登记表的 g.snap）：重启时直接用，不再逐个读链。以前重启要把一千多个门槛盘每个重读约 10 次
  // （名字 / 代号 / 元数据 / 状态 / 税率 / 成交），启动第一分钟一万多次请求把公共节点打到限流，战壕要等很久、底栏延迟到好几秒。
  // 快照之后由 flapNftTick 在 10 分钟内分散地补最新状态；正在看的币照常实时刷新
  flapSnap(t) {
    const g = this.flapNft.get(t.address); if (!g) return;
    const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o[k] != null).map((k) => [k, o[k]]));
    g.snap = { at: Date.now(), metaUrl: t.metaUrl || null, nativeSwap: t.flapNativeSwap,
      ...pick(t, ['symbol', 'name', 'quote', 'quoteAddress', 'stage', 'progress', 'raised', 'target', 'remaining', 'price', 'mcapUsd', 'buys', 'sells', 'volume', 'holders', 'lastTradeAt', 'creator', 'flapTax', 'nftGate', 'image', 'description', 'website', 'twitter', 'telegram']) };
    this.flapNft.saveSoon();
  }
  restoreFlapNft(g) {
    const s = g.snap, k = g.token;
    if (this.tokens.has(k) && this.get(k).source !== 'flap-nft') return;
    if (!s) { (this.flapRestoreQ ||= []).push(g); this.pumpFlapRestore(); return; }
    const t = this.base(k);
    const { at, metaUrl, nativeSwap, flapTax, nftGate, ...rest } = s;
    Object.assign(t, rest, { source: 'flap-nft', platform: 'flap', agentExclusive: g.nft === '0x60b9262456de011f7d15a54cdd8c48baaa8b022f', quote: s.quote || 'BNB', createdAt: g.at || g.seenAt, maxSupply: 1e9,
      flapNativeSwap: nativeSwap, holdersKnown: false, nftGate: { capPct: 2, ...nftGate, nft: g.nft, removed: !!g.removed, known: g.nft === '0x60b9262456de011f7d15a54cdd8c48baaa8b022f' } });
    if (metaUrl) t.metaUrl = metaUrl;
    if (flapTax) this.applyFlapTax(t, flapTax);
    t.nftStateAt = Date.now() - Math.random() * 600_000;   // 10 分钟内陆续刷新，不一起涌上来
    if (Date.now() - Math.max(s.lastTradeAt || 0, t.createdAt || 0) < 24 * 3600_000) this.flapNftHistory(t).catch(() => {});   // 一天内有动静的才补成交；其余等打开时再补
  }
  // 没有快照的（第一次升级到这个版本、刚搜到的）：同时最多 3 个，新创建的先来
  pumpFlapRestore() {
    if (this.flapRestoreT) return;
    this.flapRestoreT = setTimeout(async () => {
      const q = (this.flapRestoreQ || []).sort((a, b) => (b.at || b.seenAt || 0) - (a.at || a.seenAt || 0)); this.flapRestoreQ = [];
      let i = 0;
      const w = async () => { while (i < q.length) { const g = q[i++]; await this.upsertFlapNft(g, { restore: true }).catch(() => {}); } };
      await Promise.all([w(), w(), w()]);
      this.flapRestoreT = null;
      if (this.flapRestoreQ.length) this.pumpFlapRestore();
    }, 0);
  }

  // 名字 / 代号 / 图标：读失败（节点限流等）时为空，代号留着「?」；flapNftTick 每 30 秒重试一次，直到读到为止
  async flapNftMeta(t) {
    t.metaTryAt = Date.now();
    const i = new ethers.Interface(['function name() view returns (string)', 'function symbol() view returns (string)', 'function metaURI() view returns (string)']);
    const rd = (fn) => this.provider.call({ to: t.address, data: i.encodeFunctionData(fn) }).then((r) => i.decodeFunctionResult(fn, r)[0]).catch(() => '');
    const [name, symbol, meta] = await Promise.all([rd('name'), rd('symbol'), rd('metaURI')]);
    Object.assign(t, { symbol: symbol || t.symbol, name: name || t.name });
    this.loadMeta(t, ipfsUrl(meta));
  }
  async applyFlapNftState(t, st) {
    if (st.quote !== ethers.ZeroAddress && t.quoteAddress?.toLowerCase() !== st.quote.toLowerCase()) {
      t.quoteAddress = st.quote; t.quote = await this.provider.call({ to: st.quote, data: '0x95d89b41' }).then((r) => ethers.AbiCoder.defaultAbiCoder().decode(['string'], r)[0]).catch(() => '?');
      t.flapNativeSwap = st.nativeSwap;
    }
    const price = Number(ethers.formatEther(st.price));
    t.raised = Number(ethers.formatEther(st.reserve)); t.progress = st.status === 4 ? 100 : Math.min(100, st.progress);
    t.target = t.progress > 0 && t.progress < 100 ? t.raised / (t.progress / 100) : t.target;
    t.remaining = Math.max(0, Number(ethers.formatEther(st.dexThresh)) - Number(ethers.formatEther(st.circulating)));
    // 有链上成交以后 K 线只按成交画（成交时间、成交后价格）；还没补到成交时才用轮询价格兜底。已迁移的内盘价格读出来是 0，不覆盖
    if (price > 0 && price !== t.price) { t.price = price; if (!t.nftHistAt && !t.nftKeys?.size) this.pushCandle(t, Date.now(), price, 0); }
    if (st.status !== 4 && t.price > 0) t.mcapUsd = t.price * 1e9 * this.quoteUsd(t);
    if (st.status === 4 && t.stage === 'curve') { t.stage = 'dex'; t.progress = 100; this.emit('migrate', this.summary(t)); }
    else if (st.status === 1 && !t.migrated) t.stage = 'curve';
  }
  // 税率 / 受益人 / 分红：读链上（flapNft.taxInfo），5 分钟刷新一次（累计分红、营销金额会变）
  async flapNftTax(t, force = false, ttl = 300_000) {
    if (!force && t.flapTax && Date.now() - t.flapTax.at < ttl) return;
    this.applyFlapTax(t, await this.flapNft.taxInfo(t.address));
  }
  applyFlapTax(t, v) {
    t.flapTax = v;
    t.buyTax = v.buyBps / 100; t.sellTax = v.sellBps / 100;
    const q = v.divSym === 'BNB' ? this.bnbUsd : 0;
    t.gangDiv = { flap: true, taxed: v.divBps > 0, taxBps: Math.round(Math.max(v.buyBps, v.sellBps) * v.divBps / 10000), vault: v.divContract || null,
      stats: v.divBps > 0 ? { quoteSymbol: v.divSym || '?', total: v.sentDiv, totalUsd: q ? v.sentDiv * q : null } : null };
  }
  // 门槛盘（内盘阶段）读 Portal 状态（价格 / 进度 / 是否迁移）。以前假设「数量很少（每天几个）」就每 6 秒把所有币都读一遍，现在内盘里累计有几百个（大多早已无人交易），
  // 结果是每秒 30+ 次 eth_call、全天无休，把公共节点打到限流，溢出的请求全流进 NodeReal（4 小时烧光一个月额度）。
  // 现在分级：最近 15 分钟内有成交 / 刚创建的 → 每 6 秒；持有 / 收藏的 → 30 秒；2 小时内有过成交 → 1 分钟；再沉寂的 → 10 分钟。
  // 成交事件（WebSocket）一来就升级成「活跃」，迁移也有独立事件，所以降频不会漏掉行情变化。正在看的币由 refresh() 每 3 秒照常刷新
  nftEvery(t, keep, now) {
    const last = Math.max(t.lastTradeAt || 0, t.nftHotAt || 0, t.createdAt || 0), idle = now - last;
    if (idle < 15 * 60_000) return 0;
    if (keep.has(t.address)) return 30_000;
    if (idle < 2 * 3600_000) return 60_000;
    return 600_000;
  }
  async flapNftTick() {
    if (this.nftBusy) return; this.nftBusy = true;
    try {
      const now = Date.now(), keep = this.keepSet?.() || new Set();
      for (const t of [...this.tokens.values()].filter((x) => x.source === 'flap-nft' && x.stage === 'curve')) {
        const every = this.nftEvery(t, keep, now);
        if (every && now - (t.nftStateAt || 0) < every) continue;
        t.nftStateAt = now;
        try { await this.applyFlapNftState(t, await this.flapNft.state(t.address)); await this.flapNftTax(t, false, every >= 600_000 ? 6 * 3600_000 : 300_000); this.flapSnap(t); } catch { /* 下一轮 */ }   // 沉寂币的税率 / 分红信息 6 小时才重读（每次 7 次调用）
        if ((!t.name || t.symbol === '?' || !t.metaUrl) && Date.now() - (t.metaTryAt || 0) > 30_000) await this.flapNftMeta(t).catch(() => {});
      }
    } finally { this.nftBusy = false; }
  }

  // 图标 / 简介 / 社交链接，异步补上；列表每 0.5 秒推送一次，到了就显示
  loadMeta(t, url) {
    if (!url || t.metaUrl === url) return;
    t.metaUrl = url;
    this.meta.get(url, (m) => { Object.assign(t, m); this.emit('detail', t.address); });
  }

  // 搜索粘贴地址：已在列表直接返回；否则查 Four 链上，查到就加进列表
  async lookup(address) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
    let t = this.get(address);
    if (!t && await this.four.lookup(address)) t = this.get(address);
    if (!t) t = await this.lookupGangV2(address).catch(() => null);
    if (!t && await this.flapNft.check(address).catch(() => null)) t = this.get(address);
    if (!t) return null;
    t.pinned = true;               // 手动打开的盘不被自动淘汰
    return this.summary(t);
  }

  // Gang V2 新盘：本后端的订阅还没看到、但主后端已经发来狙击订单时（钱包 2 等），直接读链上曲线把它加进列表
  async lookupGangV2(address) {
    this._gv2 ||= new GangV2(this.provider, null);
    const { c } = await this._gv2.curve(address);
    const erc = new ethers.Contract(address, ['function name() view returns (string)', 'function symbol() view returns (string)'], this.provider);
    const [name, symbol] = await Promise.all([erc.name().catch(() => ''), erc.symbol().catch(() => '?')]);
    const q = String(c.quote).toLowerCase(), quoteSymbol = q === '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' || c.quote === ethers.ZeroAddress ? 'BNB' : await this.gangChain.symbolOf(q);
    if (this.get(address)) return this.get(address);   // 读链期间订阅已经收录
    this.upsertGang({ address: address.toLowerCase(), name, symbol, creator: String(c.creator).toLowerCase(), createdAt: Math.floor(Date.now() / 1000), graduated: !!c.graduated, raisedQuote: 0, progressPct: 0, quoteSymbol, quoteAddress: q, track: c.v3 ? 'v3' : 'v2', taxed: !!c.taxed }, false);
    return this.get(address);
  }

  // gang.fun：接口给的列表（已筹 / 进度 / 价格 / FDV / 持有人）；毕业门槛按 已筹 ÷ 进度 推算
  upsertGang(it, isNew) {
    const existed = this.tokens.has(this.key(it.address));
    const ev = !existed && this.evicted?.get(this.key(it.address));
    if (ev && !isNew && !((it.lastTradeAt || 0) * 1000 > ev)) return;   // 淘汰后没有新成交的，不再加回
    const t = this.base(it.address);
    const qa = String(it.quoteAddress || '').toLowerCase();
    if (t._qDec == null && qa && QUOTE_DEC[qa]) t._qDec = QUOTE_DEC[qa];   // 已知的非 18 位报价币（XAUt 6 位、BEM 8 位）马上用，不等链上曲线
    else if (t._qDec == null && qa && (it.track === 'v2' || it.track === 'v3') && qa !== '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c') { this._gv2 ||= new GangV2(this.provider, null); this._gv2.decimals(qa).then((d) => { t._qDec ??= d; }).catch(() => {}); }
    const raised = Number(it.raisedQuote ?? it.raisedBnb) || 0, pct = Number(it.progressPct) || 0;
    Object.assign(t, {
      source: 'gang', platform: 'gang', agentExclusive: true, symbol: it.symbol, name: it.name, quote: it.quoteSymbol || 'BNB', quoteAddress: it.quoteAddress || null, creator: it.creator,
      creatorName: it.creatorHandle || null, feeBps: 100, sellFeeBps: 100, stage: it.graduated ? 'dex' : 'curve', migratedAt: it.graduatedAt ? it.graduatedAt * 1000 : t.migratedAt, raised: t._qDec && t._qDec !== 18 ? t.raised : raised, progress: pct, target: t._qDec && t._qDec !== 18 ? t.target : it.gradAmtQuote || (pct > 0 ? Math.round((raised / (pct / 100)) * 10) / 10 : (t.target || 15)),   /* 非 18 位报价币（XAUt）接口按 18 位给，数会小 1e12 倍，用链上读的 */ gangTrack: /^v3/.test(t.gangTrack || '') ? t.gangTrack : it.track || 'v1' /* 链上认出的 V3 不被接口的 v2 覆盖 */, remaining: t._v2Rem ?? null,   // 剩余可售：V2 从合约读，读到之前 / 老盘未知 = null（页面显示「—」）
     
      // mcapUsd：币股等报价币盘接口常不给 fdvUsd，别把成交算出的市值覆盖成 0（注释单独成行：以前写在行中间，把后面的 volume / pair / tradeCount 注释掉了）
      price: (t._qDec && t._qDec !== 18 ? 0 : Number(it.priceQuote ?? it.priceBnb)) || t.price, mcapUsd: (t._qDec && t._qDec !== 18 ? 0 : Number(it.fdvUsd)) || t.mcapUsd || 0, holders: it.holders ?? null, volume: Number(it.volume24hBnb) || 0, pair: it.pair || null, tradeCount: it.trades || 0,
    });
    if (!existed) t.createdAt = it.createdAt * 1000;
    if (it.lastTradeAt) t.lastTradeAt = Math.max(t.lastTradeAt || 0, it.lastTradeAt * 1000);
    if (it.creatorHandle) this.names.set(it.creator, it.creatorHandle);
    if (it.logo) t.image = it.logo;
    // V3：买卖税 / 分红比例来自列表接口（和链上 curves() 一致）；内盘只收 1% 平台费，税在毕业后的 Pancake 池里收
    // 打新：开盘后买卖各收 1% 税，一半分给认购者；认购时另收认购费、退出时收退出费（页面按 gangFair 显示）
    if (it.fair) { t.gangFair = it.fair; t.gangDiv = { taxed: true, taxBps: 100, divBps: 5000, vault: null, stats: null }; }
    // 铸币飞轮：开盘后买入税 1%、卖出税 1–2%；第一个 1% 一半分给铸造过的持有人，卖出税超过 1% 的部分全部给持有人（页面按 gangFly 显示铸造卡片）
    if (it.fly) { t.gangFly = it.fly; t.gangDiv = { taxed: true, taxBps: Math.round(it.fly.sellTaxPct * 100), divBps: 5000, vault: null, stats: null }; if (it.website && !t.website) t.website = it.website; if (it.twitter && !t.twitter) t.twitter = it.twitter; }
    if (it.v3) { const v = it.v3; t.gangV3 = { ...v, trade: V3_TRADE }; t.gangDiv = { taxed: v.dividendBps > 0 && (v.buyTaxBps > 0 || v.sellTaxBps > 0), taxBps: Math.max(v.buyTaxBps, v.sellTaxBps), divBps: v.dividendBps, vault: t.gangDiv?.vault || null, stats: t.gangDiv?.stats || null }; }
    if (it.taxed != null) t.gangDiv = { taxed: !!it.taxed, taxBps: it.taxBps ?? (it.taxed ? 100 : 0), vault: it.dividendVault || t.gangDiv?.vault || null, stats: it.dividends || t.gangDiv?.stats || null };   // 分红币 / 不分红（见 gangFun.fromV2）
    // V2 报价币（GANG / ZEC / 币股…）的美元价用 gang.fun 给的，quoteUsd() 换美元要用
    if (it.quoteAddress && it.quoteUsd && !(this.qUsd[it.quoteAddress.toLowerCase()] > 0)) this.qUsd[it.quoteAddress.toLowerCase()] = it.quoteUsd;
    if (isNew && !existed) this.emit('launch', { ...this.summary(t), detectMs: Math.max(0, Date.now() - t.createdAt) });   // 链上已经先发现过的，接口再看到时不重复提示
    // 最近有成交的几个 + 当前选中的，定时拉成交。一轮列表上千个币：攒到这一轮处理完再算一次（以前每个币都把全部币扫一遍再排序，启动时主线程卡 1 秒多）
    if (!this.hotT) this.hotT = setTimeout(() => {
      this.hotT = null;
      const hot = [...this.tokens.values()].filter((x) => x.source === 'gang' && x.gangTrack !== 'v3fair' && x.lastTradeAt).sort((a, b) => b.lastTradeAt - a.lastTradeAt).slice(0, 5).map((x) => x.address);
      this.gang.setHot(hot);
    }, 300);
  }

  // 链上发现的 Gang 新盘：先上列表（名称、符号、创建者、计价币都来自事件），市值 / 头像等等接口轮询补上
  onGangChainToken(it) {
    // 链上订阅先推送、后补区块时间（it.timeP）：延迟统计和日志等真实区块时间到了再记，币的创建时间也随之改正
    const apiFirst = this.tokens.has(this.key(it.address));
    Promise.resolve(it.timeP).then((ts) => {
      if (ts != null) { it.createdAt = ts; const t = this.get(it.address); if (t && it.fromChain && !apiFirst) t.createdAt = ts * 1000; }
      const lat = it.seenAt - it.createdAt * 1000;
      (this.gangLat ||= []).unshift({ symbol: it.symbol, address: it.address, block: it.block, createdAt: it.createdAt * 1000, seenAt: it.seenAt, latencyMs: lat, viaApiFirst: apiFirst }); this.gangLat.length = Math.min(this.gangLat.length, 20);
      console.log(`[Gang 链上] 新盘 ${it.symbol}（${it.track === 'v3' ? 'V3 · ' + it.quoteSymbol : it.track === 'v3fair' ? 'V3 打新 · ' + it.quoteSymbol : it.track === 'v2' ? 'V2 · ' + it.quoteSymbol : '老盘 · BNB'}）区块 ${it.block}，出块后 ${lat}ms 发现${apiFirst ? '（接口已先收录）' : ''}`);
    });
    if (this.tokens.has(this.key(it.address))) return;
    this.gang.seen.set(it.address, -1);
    this.upsertGang(it, true);
    const t = this.get(it.address);
    if (t && (it.track === 'v2' || it.track === 'v3')) this.gangV2Curve(t).then(() => { if (!(t.price > 0) && t.launchPrice > 0) { t.price = t.launchPrice; const q = this.quoteUsd(t); if (q && !(t.mcapUsd > 0)) t.mcapUsd = t.price * 1e9 * q; } }).catch(() => {});
  }

  // 链上 Flap 成交（virtualBuyFill / virtualSellFill）：金额是报价币单位，和其他平台一致；按 tx + 方向去重（shrine 若也推了同一笔不会重复）
  onFlapChainTrade(tr) {
    const t = this.get(tr.token); if (!t || t.source !== 'agent-curve') return;
    if (t.trades.some((x) => x.tx === tr.tx && x.side === tr.side)) return;
    const trade = { ts: tr.ts || Date.now(), side: tr.side, bnb: tr.bnb, tokens: tr.tokens, price: tr.price, trader: tr.trader, tx: tr.tx };
    this.addTrade(t, trade);
    const q = this.quoteUsd(t); if (q && tr.price > 0) t.mcapUsd = tr.price * (t.maxSupply || 1e9) * q;
    this.emit('trade', { address: t.address, symbol: t.symbol, ...trade, usd: tr.bnb * q, mcapUsd: t.mcapUsd });
  }

  // Flap Portal 门槛盘成交（flapNft.js 读 TokenBought / TokenSold）：金额是报价币单位，价格 = 成交后价格；按 tx:logIndex 去重
  ingestFlapNft(t, tr) {
    const key = `${tr.tx}:${tr.idx}`; t.nftKeys ||= new Set(); if (t.nftKeys.has(key)) return null; t.nftKeys.add(key);
    if (tr.side === 'buy') t.buys++; else t.sells++;
    t.volume += tr.bnb;
    if (t.holdersKnown && tr.trader) {
      const v = (t.bal.get(tr.trader) || 0) + (tr.side === 'buy' ? tr.tokens : -tr.tokens);
      if (v > 1e-6) t.bal.set(tr.trader, v); else t.bal.delete(tr.trader);
      t.holders = t.bal.size;
    }
    return { ts: tr.ts, side: tr.side, bnb: tr.bnb, tokens: tr.tokens, price: tr.price, trader: tr.trader, tx: tr.tx };
  }
  onFlapNftTrade(tr) {
    const t = this.get(tr.token); if (!t || t.source !== 'flap-nft') return;
    const trade = this.ingestFlapNft(t, tr); if (!trade) return;
    t.nftHotAt = Date.now();   // 有成交：升级成「活跃」，状态轮询回到 6 秒一次
    if (t.stage === 'curve' && tr.ts >= (t.lastTradeAt || 0)) { const q = this.quoteUsd(t); if (q && tr.price > 0) t.mcapUsd = tr.price * 1e9 * q; }
    this.addTrade(t, trade);
    if (Date.now() - tr.ts < 60_000) this.emit('trade', { address: t.address, symbol: t.symbol, ...trade, usd: tr.bnb * this.quoteUsd(t), mcapUsd: t.mcapUsd });
  }
  // 从创建起的全部内盘成交重建：买卖笔数、成交量、持有人（净买入 > 0 的地址）、K 线（换掉轮询价格画的点，外盘部分留着）、最近 100 笔
  async flapNftHistory(t, prio = false) {
    if (t.nftHistAt && Date.now() - t.nftHistAt < 30_000) return;
    const list = await this.flapNft.history(t.address, prio);   // prio：用户正在看的币插队，不等后台补数队列
    Object.assign(t, { nftKeys: new Set(), buys: 0, sells: 0, volume: 0, holdersKnown: true, bal: new Map(), holders: 0, nftHistAt: Date.now() });
    t.candles = (t.candles || []).filter((c) => c.dex); t.trades = (t.trades || []).filter((x) => x.dex);
    const q = this.quoteUsd(t), keep = [];
    for (const tr of list) { const x = this.ingestFlapNft(t, tr); if (!x) continue; this.noteFirstBuy(t, x); if (x.price) this.pushCandle(t, x.ts, x.price, x.bnb); keep.push(x); }
    for (const x of keep.slice(-100)) { x.usd = x.bnb * q; x.mcapUsd = x.price * 1e9 * q; x.name = this.names.peek(x.trader); }
    t.trades = [...keep.slice(-100), ...t.trades].sort((a, b) => b.ts - a.ts).slice(0, 100);
    const last = keep.at(-1);
    if (last) { t.lastTradeAt = Math.max(t.lastTradeAt || 0, last.ts); if (t.stage === 'curve') { t.price = last.price; if (q) t.mcapUsd = last.price * 1e9 * q; } else if (!(t.price > 0)) { t.price = last.price; if (q) t.mcapUsd = last.price * 1e9 * q; } }
    if (t.stage === 'dex') Object.assign(t, { holdersKnown: false, holders: null });   // 迁移以后外盘转账不经过 Portal，内盘算出来的持有人不准，不显示
    t._chgAt = 0;
  }

  onGangTrade(tr, live) {
    const t = this.get(tr.token); if (!t || t.source !== 'gang') return;
    // 去重要看所有见过的成交，不能只看留着的最近 100 笔：选中时一次拉 200 笔，更早的那些以前会被当成新成交重复加，
    // 把价格改回旧成交的价、买卖笔数越加越多
    const id = `${tr.tx}:${tr.side}:${tr.tokens}`; t.seenTx ||= new Set();
    if (tr.tx && (t.seenTx.has(id) || t.trades.some((x) => x.tx === tr.tx && x.side === tr.side))) return;
    if (tr.tx) { t.seenTx.add(id); if (t.seenTx.size > 5000) t.seenTx = new Set([...t.seenTx].slice(-2500)); }
    if (tr.name) this.names.set(tr.trader, tr.name);
    if (tr.side === 'buy') t.buys++; else t.sells++;
    // 链上事件和 gang.fun 接口都把报价币金额按 18 位小数给；BEM（8 位）、XAUt（6 位）这类要乘回 10^(18-dec)
    const k = this.qScale(t);
    const trade = { ts: tr.ts, side: tr.side, bnb: tr.bnb * k, tokens: tr.tokens, price: tr.price * k, trader: tr.trader, tx: tr.tx, name: tr.name };
    this.addTrade(t, trade);
    if (k !== 1 && trade.price > 0 && trade.ts >= (t.lastTradeAt || 0) - 1) { const u = this.quoteUsd(t); if (u) t.mcapUsd = t.price * 1e9 * u; }   // 接口的 fdvUsd 也按 18 位算错了，用成交价重算
    if (live) this.emit('trade', { address: t.address, symbol: t.symbol, ...trade, usd: trade.bnb * this.quoteUsd(t), mcapUsd: t.mcapUsd });   // Gang V2 的金额是报价币（GANG / BNCB…），按报价币价格换美元
  }

  // 报价币不是 18 位小数时，18 位口径的金额 / 价格要乘的倍数（BEM 8 位 = 1e10）
  qScale(t) { return t._qDec && t._qDec !== 18 ? 10 ** (18 - t._qDec) : 1; }

  // four.meme 成交：更新已筹、进度、价格、K 线和成交列表
  onFourTrade(tr) {
    const t = this.get(tr.token); if (!t || t.source !== 'four-agent') return;
    if (tr.tx && t.trades.some((x) => x.tx === tr.tx && x.side === tr.side)) return;
    // 同一模板的盘开盘价都一样：记下「几乎没筹到钱时」的最低成交价，当作还没成交的新盘的开盘价，用来估市值
    if (tr.price > 0 && tr.raised < 0.05) this.fourP0 = Math.min(this.fourP0 || Infinity, tr.price);
    Object.assign(t, { raised: tr.raised, remaining: tr.remaining, progress: t.target ? Math.min(100, (tr.raised / t.target) * 100) : 0, stage: tr.remaining <= 0 ? 'dex' : 'curve' });
    if (tr.side === 'buy') t.buys++; else t.sells++;
    t.volume += tr.bnb;
    // 持有人 = 净买入数量 > 0 的地址数
    if (t.holdersKnown && tr.trader) {
      const k = tr.trader.toLowerCase(); const v = (t.bal.get(k) || 0) + (tr.side === 'buy' ? tr.tokens : -tr.tokens);
      if (v > 1e-6) t.bal.set(k, v); else t.bal.delete(k);
      t.holders = t.bal.size;
    }
    // 费率按最近一笔真实成交倒推：买入 =（付出 − 进曲线）/ 付出；卖出 =（曲线给出 − 到手）/ 曲线给出。含代币税 + 平台费 + 开发者费 + 防狙击税
    if (tr.curveBnb > 0) {
      if (tr.side === 'buy' && tr.bnb > 0) { t.feeBps = Math.max(0, Math.round(((tr.bnb - tr.curveBnb) / tr.bnb) * 10000)); t.buyTax = (tr.taxFee / tr.curveBnb) * 100; t.antiSniperPct = (tr.antiSniperFee / tr.curveBnb) * 100; t.feeAt = tr.ts; }
      if (tr.side === 'sell') { t.sellFeeBps = Math.max(0, Math.round(((tr.curveBnb - tr.bnb) / tr.curveBnb) * 10000)); t.sellTax = (tr.taxFee / tr.curveBnb) * 100; }
    }
    t.price = tr.price; t.mcapUsd = tr.price * (t.maxSupply || 1e9) * this.quoteUsd(t);
    const trade = { ts: tr.ts, side: tr.side, bnb: tr.bnb, tokens: tr.tokens, price: tr.price, trader: tr.trader, tx: tr.tx };
    this.addTrade(t, trade);
    if (Date.now() - tr.ts < 60_000) this.emit('trade', { address: t.address, symbol: t.symbol, ...trade, usd: tr.bnb * this.quoteUsd(t), mcapUsd: t.mcapUsd });
  }

  upsertShrine(l) {
    if (!l.token) return;
    // 列表只来自链上：Flap 用 Agent Curve Reader，Four 用 Agentic Wallet 专属模板事件；shrine 只给已有的盘补充信息
    if (!this.tokens.has(this.key(l.token))) return;
    const isNew = !this.tokens.has(this.key(l.token));
    const t = this.base(l.token);
    const created = sec2ms(l.timestamp || l.createdAt);
    Object.assign(t, {
      source: t.source === 'agent-curve' ? 'agent-curve' : 'shrine', platform: l.protocol === 'FOURMEME' ? 'four' : 'flap',
      agentExclusive: t.agentExclusive || isAgentish(l), symbol: l.symbol || t.symbol, name: l.name || t.name,
      quote: String(l.quoteAsset?.symbol || (String(l.quoteToken || '').startsWith('0x') ? 'BNB' : l.quoteToken) || 'BNB').toUpperCase(),
      quoteAddress: l.quoteAddress || t.quoteAddress, creator: l.creator || t.creator, market: l.market || t.market,
      antiSniper: l.antiSniper ?? t.antiSniper, createdAt: isNew ? Math.min(Date.now(), created) : t.createdAt,
    });
    if (num(l.marketCap)) t.mcapUsd = num(l.marketCap);
    if (isNew) this.emit('launch', { ...this.summary(t), detectMs: Math.max(0, Date.now() - created) });
  }

  onStreamTrade(m) {
    const t = this.get(m.token); if (!t) return;
    const price = num(m.priceFormatted) ?? (num(m.price) ? num(m.price) / 1e18 : null);
    const bnb = num(m.quoteAmountFormatted) || 0;
    const trade = { ts: sec2ms(m.timestamp), side: m.type, bnb, tokens: num(m.tokenAmountFormatted) || 0, price: price || t.price, trader: m.trader, tx: m.txHash };
    this.addTrade(t, trade);
    if (num(m.marketCap)) t.mcapUsd = num(m.marketCap);
    this.emit('trade', { address: t.address, symbol: t.symbol, ...trade, usd: bnb * this.quoteUsd(t), mcapUsd: t.mcapUsd });
  }

  // 记下这个币最早的一笔买入（trades 只留 100 条，所以单独存）
  noteFirstBuy(t, tr) { if (tr?.side === 'buy' && tr.trader && (!t.firstBuy || tr.ts < t.firstBuy.ts)) t.firstBuy = { ts: tr.ts, trader: tr.trader }; }

  addTrade(t, tr) {
    if (tr.tx && t.trades.some((x) => x.tx === tr.tx && x.side === tr.side)) return;
    this.noteFirstBuy(t, tr);
    tr.usd = tr.bnb * this.quoteUsd(t); tr.mcapUsd = t.mcapUsd; tr.name = this.names.peek(tr.trader);
    t.trades.unshift(tr); t.trades.sort((a, b) => b.ts - a.ts); if (t.trades.length > 100) t.trades.length = 100;
    if (tr.price) { if (tr.ts >= (t.lastTradeAt || 0)) t.price = tr.price; this.pushCandle(t, tr.ts, tr.price, tr.bnb); }   // 补进来的旧成交只画 K 线，不改现价
    t.lastTradeAt = Math.max(t.lastTradeAt || 0, tr.ts);
    this.flow.unshift({ ...tr, address: t.address, symbol: t.symbol, platform: t.platform }); if (this.flow.length > 150) this.flow.length = 150;
  }

  pushCandle(t, ts, price, vol) {
    const b = Math.floor(ts / 1000);
    let i = t.candles.length - 1; while (i >= 0 && t.candles[i].t > b) i--;
    const c = t.candles[i];
    if (c && c.t === b) { c.h = Math.max(c.h, price); c.l = Math.min(c.l, price); c.c = price; c.v += vol; }
    else { const o = c ? c.c : price; t.candles.splice(i + 1, 0, { t: b, o, h: Math.max(o, price), l: Math.min(o, price), c: price, v: vol }); if (t.candles.length > 4000) t.candles.shift(); }
  }

  // 已迁移（dex）的币：读 PancakeSwap V2 池子的 Swap 事件（dexFeed.js），接在内盘 K 线后面，并补成交列表、24 小时外盘成交量、底池、现价。
  // 第一次最多等 2.5 秒，补不完的历史在后台接着补，补到了再推一次详情。找不到池子（或链上读不到）时退回 GeckoTerminal 分钟 K 线
  async dexRefresh(t) {
    const run = this.dexFeed.sync(t).then((n) => { if (n) { this.applyDex(t); this.emit('detail', t.address); } }).catch(() => {});
    const has = () => t.dexSwaps?.length || t.dexHist?.length;
    if (!has()) await Promise.race([run, new Promise((r) => setTimeout(r, 2500))]);
    if (has()) this.applyDex(t); else await this.dexCandles(t);
  }
  applyDex(t) {
    const s = t.dexSwaps || [], bars = dexBars(s, t.dexHist || []); if (!bars.length) return;
    const q = this.quoteUsd(t); this.joinDex(t, bars);
    const last = s[s.length - 1]; t.price = last ? last.price : bars[bars.length - 1].c; if (last) t.lastTradeAt = Math.max(t.lastTradeAt || 0, last.ts);
    if (q) { t.mcapUsd = t.dexMcapUsd = t.price * (t.maxSupply || 1e9) * q; if (t.dexQuoteRes) t.dexLiqUsd = t.dexQuoteRes * 2 * q; }
    const day = Date.now() - 86_400_000; let v = 0, nb = 0, ns = 0;
    for (let k = s.length - 1; k >= 0 && s[k].ts >= day; k--) { v += s[k].bnb; if (s[k].side === 'buy') nb++; else ns++; }
    const from = s.length ? s[0].ts / 1000 : Infinity; for (const c of t.dexHist || []) if (c.t * 1000 >= day && c.t < Math.floor(from / 60) * 60) v += c.v;   // 链上读不到的更早部分用 GeckoTerminal 分钟线的成交量
    Object.assign(t, { dexVol24: v, dexBuys24: nb, dexSells24: ns, dexCountMin: s.length ? Math.max(1, Math.round((Date.now() - Math.max(day, s[0].ts)) / 60_000)) : 0 });   // 买卖笔数只有链上读到的这段（约 1 小时）
    const recent = s.slice(-100).reverse().map((x) => ({ ...x, usd: x.bnb * q, mcapUsd: x.price * (t.maxSupply || 1e9) * q, name: x.trader ? this.names.peek(x.trader) : null }));
    t.trades = [...recent, ...t.trades.filter((x) => !x.dex)].sort((a, b) => b.ts - a.ts).slice(0, 100);
  }
  // 已开盘的币：DexScreener 批量接口（一次 30 个地址）每 30 秒刷一遍市值 / 底池 / 24h 成交额 / 涨跌 / 买卖笔数。
  // 以前只有点进详情页的币才读外盘，列表里大多数已开盘的币市值是空的、停在毕业那一刻
  async dexBatch() {
    if (this.dexBatchBusy) return; this.dexBatchBusy = true;
    try {
      const list = [...this.tokens.values()].filter((t) => t.stage === 'dex').map((t) => t.address);
      for (let i = 0; i < list.length; i += 30) {
        const chunk = list.slice(i, i + 30);
        const r = await fetch(`${EP.dexscreener}/tokens/v1/bsc/` + chunk.join(','), { signal: AbortSignal.timeout(12_000) }).then((x) => (x.ok ? x.json() : [])).catch(() => []);
        const best = new Map();
        for (const p of Array.isArray(r) ? r : []) {
          const a = String(p.baseToken?.address || '').toLowerCase(); if (!chunk.includes(a) || !(+p.priceUsd)) continue;
          const cur = best.get(a); if (!cur || (p.liquidity?.usd || 0) > (cur.liquidity?.usd || 0)) best.set(a, p);
        }
        for (const [a, p] of best) {
          const t = this.get(a); if (!t) continue;
          Object.assign(t, { pair: t.pair || p.pairAddress, dexPool: t.dexPool || p.pairAddress, dexLiqUsd: p.liquidity?.usd || t.dexLiqUsd || 0, dexMcapUsd: +p.marketCap || +p.fdv || t.dexMcapUsd || 0, dexPriceUsd: +p.priceUsd,
            dsVolUsd24: +p.volume?.h24 || 0, dsTx24: { buys: p.txns?.h24?.buys || 0, sells: p.txns?.h24?.sells || 0 }, dsChg: { m5: p.priceChange?.m5 ?? null, h1: p.priceChange?.h1 ?? null, h24: p.priceChange?.h24 ?? null }, dsAt: Date.now() });
          const q = this.quoteUsd(t); if (q && !(t.dexSwaps?.length)) t.price = +p.priceUsd / q;   // 没读过链上成交的用 DexScreener 现价
          if (!t.image && p.info?.imageUrl) t.image = p.info.imageUrl;
          for (const so of p.info?.socials || []) { if (so.type === 'twitter' && !t.twitter) t.twitter = so.url; if (so.type === 'telegram' && !t.telegram) t.telegram = so.url; }
          if (p.info?.websites?.[0] && !t.website) t.website = p.info.websites[0].url;
        }
        await new Promise((ok) => setTimeout(ok, 400));
      }
    } finally { this.dexBatchBusy = false; }
  }

  // 内盘 K 线 + 外盘 K 线接成一条：内盘的全部保留（只换掉上次接上的外盘部分）
  joinDex(t, bars) {
    const curve = (t.candles || []).filter((c) => !c.dex), end = curve.length ? curve[curve.length - 1].t : -Infinity;
    // 外盘第一根分钟线的起点（如 06:40:00）常早于内盘最后一笔（06:40:43）：以前把这一分钟里的内盘成交整段删掉，K 线在毕业处断开一截。
    // 现在内盘全部保留，落在内盘结束之前的外盘线并成一根，放在内盘最后一笔之后
    const head = bars.filter((c) => c.t <= end), tail = bars.filter((c) => c.t > end);
    if (head.length) tail.unshift({ t: end + 1, o: head[0].o, h: Math.max(...head.map((c) => c.h)), l: Math.min(...head.map((c) => c.l)), c: head[head.length - 1].c, v: head.reduce((x, c) => x + c.v, 0), dex: 1 });
    if (tail[0] && tail[1] && tail[0].t >= tail[1].t) tail.splice(0, 2, { ...tail[1], o: tail[0].o, h: Math.max(tail[0].h, tail[1].h), l: Math.min(tail[0].l, tail[1].l), v: tail[0].v + tail[1].v });
    if (tail[0] && curve.length) { const o = curve[curve.length - 1].c; tail[0] = { ...tail[0], o, h: Math.max(tail[0].h, o), l: Math.min(tail[0].l, o) }; }   // 外盘第一根从内盘收盘价开，两段接上
    t.candles = curve.concat(tail);
  }

  // 已迁移（dex）的币：曲线 ticks 停在毕业那一刻，外盘价格要从 PancakeSwap 池子拿。
  // DexScreener 找流动性最大的池子 → GeckoTerminal 分钟 OHLCV（USD）÷ 计价币 USD = 计价币单价，与内盘 K 线同一单位。选中时每 20 秒刷新。
  async dexCandles(t) {
    const merge = () => { if (!t.dexBars?.length) return false; this.joinDex(t, t.dexBars); if (t.candles.length > 4000) t.candles.splice(0, t.candles.length - 4000); t.price = t.dexBars[t.dexBars.length - 1].c; const q = this.quoteUsd(t); if (q) t.mcapUsd = t.price * (t.maxSupply || 1e9) * q; return true; };
    if (t.dexAt && Date.now() - t.dexAt < 20_000) { merge(); return; } t.dexAt = Date.now();
    try {
      {
        const r = await (await fetch(`${EP.dexscreener}/tokens/v1/bsc/` + t.address)).json();
        const ps = (Array.isArray(r) ? r : []).filter((p) => String(p.baseToken?.address).toLowerCase() === t.address && +p.priceUsd).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
        if (!ps[0]) return; t.dexPool = ps[0].pairAddress; t.dexPoolAt = Date.now();
        Object.assign(t, { pair: ps[0].pairAddress, dexLiqUsd: ps[0].liquidity?.usd || 0, dexMcapUsd: +ps[0].marketCap || +ps[0].fdv || 0, dexPriceUsd: +ps[0].priceUsd });
      }
      const q = this.quoteUsd(t); if (!q) return;
      const j = await (await fetch(`${EP.geckoterminal}/api/v2/networks/bsc/pools/${t.dexPool}/ohlcv/minute?aggregate=1&limit=1000&currency=usd&token=${t.address}`, { headers: { accept: 'application/json' } })).json();
      const list = (j?.data?.attributes?.ohlcv_list || []).slice().sort((a, b) => a[0] - b[0]);
      if (!list.length) {   // GeckoTerminal 没收录这个池子：用 DexScreener 实时价按分钟攒 K 线
        const p = t.dexPriceUsd / q, m = Math.floor(Date.now() / 60_000) * 60; t.dexBars = t.dexBars || []; const l = t.dexBars[t.dexBars.length - 1];
        if (l && l.t === m) { l.h = Math.max(l.h, p); l.l = Math.min(l.l, p); l.c = p; } else t.dexBars.push({ t: m, o: l ? l.c : p, h: Math.max(p, l ? l.c : p), l: Math.min(p, l ? l.c : p), c: p, v: 0, dex: 1 });
        merge(); this.emit('detail', t.address); return;
      }
      t.dexBars = list.map(([ts, o, h, l, c, v]) => ({ t: ts, o: o / q, h: h / q, l: l / q, c: c / q, v: v / q, dex: 1 }));   // 内盘时期的 K 线保留在前面
      merge();
      this.emit('detail', t.address);
    } catch { /* 下次再试 */ }
  }

  // 选中代币时拉详情：Agent 曲线走 Reader + fsi，其它走 shrine
  async refresh(address) {
    const t = this.get(address); if (!t) return;
    if (t.source === 'gang' && (t.gangTrack === 'v2' || t.gangTrack === 'v3')) await this.gangV2Curve(t).catch(() => {});
    try {
      if (t.market && t.source === 'agent-curve') {
        const [d, trades, ticks] = await Promise.all([this.curve.detail(t.market), fsi.fetchTrades(t.market, 100).catch(() => []), fsi.fetchTicks(t.market, 200).catch(() => [])]);
        Object.assign(t, { creator: d.creator, holders: d.holders, buys: d.buys, sells: d.sells, volume: d.volume, raised: d.pool, target: d.cap, progress: d.progress,
          remaining: d.remaining, totalShares: d.totalShares, maxWalletShares: d.maxWalletShares, buyTax: d.buyTaxBps / 100, sellTax: d.sellTaxBps / 100,
          feeBps: d.buyTaxBps + d.flapBuyFeeBps, stage: d.phase === 'graduated' ? 'dex' : 'curve' });   // launchedAt 是迁移时间，不是创建时间
        if (ticks.length) { t.candles = []; for (const k of ticks) this.pushCandle(t, k.ts, k.price, 0); t.price = ticks[ticks.length - 1].price; }
        for (const tr of [...trades].reverse()) { this.noteFirstBuy(t, tr); if (!t.trades.some((x) => x.tx === tr.tx && x.side === tr.side)) { tr.usd = tr.bnb * this.quoteUsd(t); t.trades.push(tr); } if (!ticks.length && tr.price) this.pushCandle(t, tr.ts, tr.price, tr.bnb); }
        for (const tr of trades) { const c = t.candles.find((x) => x.t === Math.floor(tr.ts / 1000)); if (c && ticks.length) c.v += tr.bnb; }
        t.trades.sort((a, b) => b.ts - a.ts); if (t.trades.length > 100) t.trades.length = 100;
        t.lastTradeAt = t.trades[0]?.ts || t.lastTradeAt;
        if (t.price) t.mcapUsd = t.price * (t.maxSupply || 1e9) * this.quoteUsd(t);
        if (t.stage === 'dex') await this.dexRefresh(t);
      } else if (t.source === 'flap-nft') {
        await this.flapNftTax(t).catch(() => {});
        await Promise.race([this.flapNftHistory(t, true).then(() => this.emit('detail', t.address)), new Promise((r) => setTimeout(r, 3000))]).catch(() => {});   // 第一次补历史最多等 3 秒，补完再推一次详情
        if (t.stage === 'curve') await this.applyFlapNftState(t, await this.flapNft.state(t.address));
        else await this.dexRefresh(t);
      } else if (t.source === 'gang') {
        // 选中时拉一次较长的成交记录画 K 线（5 秒内不重复请求）
        // 已发射的不再拉：内盘不会有新成交，成交列表换成外盘的之后重拉会把同一批内盘成交重复记进 K 线成交量
        const fair = t.gangTrack === 'v3fair';   // 打新币的成交不在 gang 的曲线成交接口里：认购阶段没有价格变化，开盘后读外盘池子
        if (!fair && t.stage !== 'dex' && (!t.gangAt || Date.now() - t.gangAt > 5000)) { t.gangAt = Date.now(); await this.gang.trades(t.address, 200, (t.gangTrack === 'v3' ? 'v3' : t.gangTrack === 'v2' ? 'v2' : t.gangTrack === 'fly' ? 'fly' : null)).catch((e) => { t.gangErr = e.message; }); }   // 单个数据源失败不能让后面的 K 线 / 外盘刷新整个跳过
        // 第一次选中：拉全部成交，从开盘起重建 K 线（也清掉改单位之前按 BNB 记的旧 K 线，全部是报价币单位）；10 分钟重建一次
        if (!fair && (!t.gangFullAt || Date.now() - t.gangFullAt > 600_000)) {
          t.gangFullAt = Date.now();
          const rows = await this.gang.history(t.address, 4000, (t.gangTrack === 'v3' ? 'v3' : t.gangTrack === 'v2' ? 'v2' : t.gangTrack === 'fly' ? 'fly' : null)).catch(() => null);
          if (rows?.length) { const k = this.qScale(t); t.candles = []; for (const r of rows) if (r.price > 0) this.pushCandle(t, r.ts, r.price * k, r.bnb * k); t._chgAt = 0; }
        }
        if (t.stage === 'dex') await this.dexRefresh(t);   // 已发射：接上外盘池子的成交
      } else if (t.source === 'four-agent') {
        // 已由链上事件实时更新，不再请求 shrine（经常 429）
        if (t.stage === 'dex') await this.dexRefresh(t);
      } else {
        const b = await tokenInfo(t.address);
        if (!b.error) {
          Object.assign(t, { symbol: b.symbol || t.symbol, name: b.name || t.name, creator: b.creator || t.creator, antiSniper: b.antiSniper ?? t.antiSniper });
          if (num(b.progressPct) != null) t.progress = num(b.progressPct);
          if (num(b.marketCapFormatted)) t.mcapUsd = num(b.marketCapFormatted);
          if (b.buyTaxBps != null) t.buyTax = b.buyTaxBps / 100;
          const fee = b.currentBuyFeeBps ?? b.curveFeeBps; if (fee != null) t.feeBps = Number(fee);
          if (b.status) t.stage = /grad|dex|launched|migrat/i.test(b.status) ? 'dex' : 'curve';
        }
      }
      this.emit('detail', t.address);
    } catch (e) { t.lastError = e.message; }
  }

  // Flap Agent 曲线：每 90 秒用 Reader.marketDetail 补一遍持有人 / 买卖笔数（4 个并发），不然只有选中过的盘才有持有人数
  async flapHolders() {
    if (this.fhBusy) return; this.fhBusy = true;
    try {
      const list = [...this.tokens.values()].filter((t) => t.source === 'agent-curve' && t.market);
      for (let i = 0; i < list.length; i += 4) {
        await Promise.all(list.slice(i, i + 4).map(async (t) => { try { const d = await this.curve.detail(t.market); t.creator = t.creator || d.creator; t.holders = d.holders; t.buys = d.buys; t.sells = d.sells; t.buyTax = d.buyTaxBps / 100; t.sellTax = d.sellTaxBps / 100; t.feeBps = d.buyTaxBps + d.flapBuyFeeBps; t.sellFeeBps = d.sellTaxBps + d.flapSellFeeBps; } catch { /* 下轮再试 */ } }));
      }
    } finally { this.fhBusy = false; }
  }

  // 后台给最新的几个 Agent 曲线市场补价格/市值，左栏 MC 才不是空的
  async warm() {
    const list = [...this.tokens.values()].filter((t) => t.source === 'agent-curve' && t.stage === 'curve').sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);
    for (const t of list) await this.refresh(t.address);
  }

  // 实时买入总费率（%）：Four 用 shrine currentBuyFeeBps（含防狙击税），Agent 曲线用 Reader 的税 + Flap 手续费
  async fetchBuyFeePct(address) {
    const t = this.get(address); if (!t) return null;
    if (t.source === 'agent-curve' && t.market) {
      if (t.feeBps == null) { try { const d = await this.curve.detail(t.market); t.feeBps = d.buyTaxBps + d.flapBuyFeeBps; } catch { /* */ } }
      return t.feeBps != null ? t.feeBps / 100 : null;
    }
    if (t.source === 'four-agent') return t.feeBps != null ? t.feeBps / 100 : null;
    const b = await tokenInfo(t.address).catch(() => ({ error: 1 }));
    if (b.error) return null;
    t.antiSniper = b.antiSniper; t.feeBps = Number(b.currentBuyFeeBps ?? b.curveFeeBps ?? 0);
    return t.feeBps / 100;
  }
  buyFeePct(t) { return t.feeBps != null ? t.feeBps / 100 : t.buyTax || 0; }
  sellFeePct(t) { return t.sellFeeBps != null ? t.sellFeeBps / 100 : t.source === 'four-agent' ? null : t.sellTax || 0; }
  costFor() { return Infinity; }

  summary(t) {
    const priceUsd = t.price * this.quoteUsd(t); const liqUsd = t.dexLiqUsd || (t.raised || 0) * this.quoteUsd(t);
    return {
      address: t.address, symbol: cleanName(t.symbol, t.address.slice(0, 6)), name: cleanName(t.name, ''), platform: t.platform, source: t.source, agentExclusive: !!t.agentExclusive, market: t.market,
      preset: t.source === 'gang' ? 'Gang（Agent 专属）' : t.source === 'agent-curve' ? 'Flap Agent Curve' : t.source === 'flap-nft' ? (t.nftGate?.known ? 'Flap · Agent ID 门槛' : 'Flap · NFT 门槛') : t.platform === 'four' ? (t.agentExclusive ? 'Binance Agent ID Exclusive' : 'Four.meme') : 'Flap',
      presetId: t.presetId || '', quote: t.quote, quoteAddress: t.quoteAddress, creator: t.creator, firstBuyer: t.firstBuy?.trader || '', firstBuyerName: t.firstBuy ? this.names.peek(t.firstBuy.trader) : null, vault: t.market || '', createdAt: t.createdAt, officialTest: false,
      stage: t.stage, price: t.price, priceUsd, mcapUsd: t.dexMcapUsd ? t.dexMcapUsd : t.source === 'four-agent' ? (t.price || this.fourP0 || 0) * (t.maxSupply || 1e9) * this.quoteUsd(t) : t.mcapUsd || (priceUsd > 0 ? priceUsd * (t.maxSupply || 1e9) : 0),   /* 没有市值但有价格（报价币价格后到）：按现价 × 总量补上 */ mcapEst: t.source === 'four-agent' && !t.price && !!this.fourP0, liqUsd, quoteUsd: this.quoteUsd(t), raised: t.raised, target: t.target, progress: t.progress || 0,
      remaining: t.remaining, holders: t.holders, buys: t.buys, sells: t.sells, volume: t.volume, dexVol24: t.dexVol24 ?? null, dexBuys24: t.dexBuys24 ?? null, dexSells24: t.dexSells24 ?? null, dexCountMin: t.dexCountMin || 0, dexVolUsd24: t.dsVolUsd24 ?? null, dexTx24: t.dsTx24 || null, dexChg: t.dsChg || null, migratedAt: t.migratedAt || null, buyTax: t.buyTax, sellTax: t.sellTax,
      buyFeePct: t.source === 'four-agent' && t.feeBps == null ? null : this.buyFeePct(t), sellFeePct: this.sellFeePct(t), antiSniperPct: t.antiSniperPct || 0, antiSniper: !!t.antiSniper, lastTradeAt: t.lastTradeAt || 0, realToken: t.realToken !== false,
      chg: this.change(t),
      // creatorName：Flap / Four 的创建者地址没有官方 handle，用域名缓存反查（查到的进 data/names.json，页面轮询拿到后自动变成 .ai 名）
// 注意：注释只能单独成行。10-28 这条注释被插在同一行中间，把后面的 gangDiv / gangV3 / gangFair / flapTax / nftGate / 简介 / 官网 / 推特 / 电报全注释掉了，页面一直拿不到
      image: t.image || null, creatorName: t.creatorName || (t.creator ? this.names.peek(t.creator) : null), gangTrack: t.gangTrack || null, gangDiv: t.gangDiv || null, gangV3: t.gangV3 || null, gangFair: t.gangFair || null, gangFly: t.gangFly || null, gangBond: t.source === 'gang' ? this.bonds.get(t.address) : null, flapTax: t.flapTax ? { ...t.flapTax, beneficiaryName: t.flapTax.beneficiary ? this.names.peek(t.flapTax.beneficiary) : null } : null, nftGate: t.source === 'flap-nft' && t.stage === 'curve' && t.nftGate && !t.nftGate.removed ? t.nftGate : null, description: t.description || '', website: t.website || '', twitter: t.twitter || '', telegram: t.telegram || '',
    };
  }

  // 涨幅（%）：现价对比 开盘 / 5 分钟 / 1 小时 / 24 小时前的价格，按 K 线历史算；历史够不到那个时间点、又不是那之后才开盘的，给 null
  // Gang V2 曲线状态（pad 合约 curves()）：开盘价 = virtualQuote / VT；剩余可售 = 毕业时卖出量 − 已卖出量。单位：报价币 / 个。20 秒缓存
  async gangV2Curve(t) {
    if (t._v2At && Date.now() - t._v2At < 20_000) return;
    this._gv2 ||= new GangV2(this.provider, null);
    const { c } = await this._gv2.curve(t.address);
    const VT = 1066666666666666666666666667n, vq = BigInt(c.virtualQuote), grad = BigInt(c.gradAmt), sold = BigInt(c.sold);
    const soldAtGrad = VT - (vq * VT + vq + grad - 1n) / (vq + grad);
    // 报价币不一定是 18 位（XAUt 是 6 位）：开盘价、已筹、目标都按报价币自己的小数位换算
    const dec = t._qDec ??= await this._gv2.decimals(c.quote).catch(() => 18), real = BigInt(c.realQuote || 0);
    t.launchPrice = Number(ethers.formatUnits(vq, dec)) / Number(ethers.formatEther(VT));
    if (dec !== 18) { t.raised = Number(ethers.formatUnits(real, dec)); t.target = Number(ethers.formatUnits(grad, dec)); }
    // 恒定乘积：现价 = 报价币储备 / 代币储备。非 18 位报价币每次都用链上价；18 位的只在还没有成交价时补
    const q = vq + real, tokRes = (vq * VT) / q;
    if (!c.graduated && tokRes > 0n && (dec !== 18 || !(t.price > 0))) { t.price = Number(ethers.formatUnits(q, dec)) / Number(ethers.formatEther(tokRes)); const u = this.quoteUsd(t); if (u) t.mcapUsd = t.price * 1e9 * u; }
    if (c.v3) { t.gangV3 = { ...c.v3, trade: V3_TRADE }; t.gangDiv = { taxed: c.taxed && c.v3.dividendBps > 0, taxBps: Math.max(c.v3.buyTaxBps, c.v3.sellTaxBps), vault: null, stats: t.gangDiv?.stats || null }; }   // V3：毕业后外盘收税，分红比例 > 0 才分红
    else if (t.gangDiv?.taxed == null) t.gangDiv = { taxed: !!c.taxed, taxBps: c.taxed ? 100 : 0, vault: null, stats: null };   // 新盘接口还没收录时，按合约 curves().taxed 先判断分红
    t._v2Rem = c.graduated ? 0 : Math.max(0, Number(ethers.formatEther(soldAtGrad > sold ? soldAtGrad - sold : 0n)));
    t.remaining = t._v2Rem; t._v2At = Date.now(); t._chgAt = 0;
  }

  // 某个币从开盘到现在的全部成交（新→旧），给「实时成交」往下翻页和交易者抽屉用。来源：Gang = gang.fun 全部成交；
  // Four = 链上 TradeExecuted（从创建区块起）；Flap 曲线 = fsi 成交记录（最多 5000 笔）。每个币缓存 60 秒，最多缓存 20 个币、每个最多 20000 笔
  async allTrades(t) {
    this._all ||= new Map(); const c = this._all.get(t.address);
    if (c && Date.now() - c.at < 60_000) return c;
    let list = [], complete = true;
    if (t.source === 'gang' && t.gangTrack === 'v3fair') list = [];   // 打新币没有曲线成交；开盘后的成交走外盘
    else if (t.source === 'gang') { const k = this.qScale(t); list = (await this.gang.history(t.address, 20000, (t.gangTrack === 'v3' ? 'v3' : t.gangTrack === 'v2' ? 'v2' : t.gangTrack === 'fly' ? 'fly' : null)).catch(() => { complete = false; return []; })).map((x) => (k === 1 ? x : { ...x, price: x.price * k, bnb: x.bnb * k })); }
    else if (t.source === 'four-agent') list = await this.four.tokenTrades(t.address);
    // 门槛盘的链上历史扫描在后台排队补（几十个币一个个来），这里最多等 4 秒，等不到就先用实时收到的成交、标记不完整，补完后下次再拿全量
    else if (t.source === 'flap-nft') list = (await Promise.race([this.flapNft.history(t.address, true), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]).catch(() => { complete = false; return []; })).map((x) => ({ ts: x.ts, side: x.side, bnb: x.bnb, tokens: x.tokens, price: x.price, trader: x.trader, tx: x.tx }));   // 门槛盘：Portal 内盘成交（从创建起）
    else if (t.market) { list = await fsi.fetchTrades(t.market, 5000).catch(() => { complete = false; return []; }); complete = complete && list.length < 9000; }
    // 合并内存里实时收到的成交（链上事件 / WS 推送）：外部历史源还没收录新币、返回空或出错时，活动列表也不会空着
    list = list.concat((t.trades || []).map((x) => ({ ts: x.ts, side: x.side, bnb: x.bnb, tokens: x.tokens, price: x.price, trader: x.trader, name: x.name, tx: x.tx })));
    list = [...new Map(list.map((x) => [`${String(x.tx).toLowerCase()}:${x.side}:${Number(x.tokens || 0).toPrecision(8)}`, x])).values()].sort((a, b) => b.ts - a.ts).slice(0, 20000);   // 数量按 8 位有效数字比：接口和链上事件的精度不同
    for (const x of list) { x.name ||= this.names.peek(x.trader); x.usd = (x.bnb || 0) * this.quoteUsd(t); }
    const v = { at: complete ? Date.now() : Date.now() - 52_000, list, complete };   // 不完整的只缓存 8 秒
    this._all.set(t.address, v); if (this._all.size > 20) this._all.delete(this._all.keys().next().value);
    return v;
  }
  async tradesPage(address, before, limit = 100) {
    const t = this.get(address); if (!t) return null;
    const { list, complete } = await this.allTrades(t);
    const i = before ? list.findIndex((x) => x.ts < before) : 0;
    const items = i < 0 ? [] : list.slice(i, i + limit);
    return { items, end: i < 0 || i + limit >= list.length, complete, total: list.length };
  }

  // 某个地址在这个币上的盈亏（详情页点成交里的地址 → 右侧抽屉）。成交来源：Gang 用 gang.fun 全部成交，Four 用链上 TradeExecuted，
  // Flap 曲线用 fsi 成交记录（最多各 1000 笔）。金额是报价币单位，另给换算成美元 / BNB 的系数。60 秒缓存
  async traderStats(address, trader) {
    const t = this.get(address); if (!t || !/^0x[0-9a-fA-F]{40}$/.test(trader || '')) return null;
    const key = `${t.address}:${trader.toLowerCase()}`; this._ts ||= new Map(); const c = this._ts.get(key); if (c && Date.now() - c.at < 60_000) return c.v;
    const me = trader.toLowerCase(); let list = [];
    try {
      if (t.source === 'four-agent') list = await this.four.traderTrades(t.address, trader);
      else list = (await this.allTrades(t)).list.filter((x) => String(x.trader).toLowerCase() === me);
    } catch (e) { list = []; }
    if (!list.length) list = t.trades.filter((x) => String(x.trader).toLowerCase() === me);
    list = [...new Map(list.map((x) => [`${x.tx}:${x.side}:${x.tokens}`, x])).values()].sort((a, b) => a.ts - b.ts);
    const buys = list.filter((x) => x.side === 'buy'), sells = list.filter((x) => x.side === 'sell');
    const sum = (a, k) => a.reduce((s2, x) => s2 + (Number(x[k]) || 0), 0);
    const bT = sum(buys, 'tokens'), bQ = sum(buys, 'bnb'), sT = sum(sells, 'tokens'), sQ = sum(sells, 'bnb');
    let hold = Math.max(0, bT - sT), holdSrc = 'trades';
    if (t.source !== 'agent-curve') { try { const i = new ethers.Interface(['function balanceOf(address) view returns (uint256)']); hold = Number(ethers.formatEther(i.decodeFunctionResult('balanceOf', await this.provider.call({ to: t.address, data: i.encodeFunctionData('balanceOf', [trader]) }))[0])); holdSrc = 'chain'; } catch { /* 读不到就用买卖差 */ } }
    const avgBuy = bT ? bQ / bT : null, avgSell = sT ? sQ / sT : null;
    const realized = avgBuy != null ? sQ - avgBuy * Math.min(sT, bT) : sQ, holdQ = hold * (t.price || 0), unreal = avgBuy != null ? holdQ - avgBuy * hold : holdQ;
    const qUsd = this.quoteUsd(t), v = { address: t.address, symbol: t.symbol, quote: t.quote || 'BNB', trader, name: this.names.peek(trader) || list.find((x) => x.name)?.name || null,
      qUsd, qBnb: this.bnbUsd ? qUsd / this.bnbUsd : 0, buys: buys.length, sells: sells.length, boughtTokens: bT, boughtQ: bQ, soldTokens: sT, soldQ: sQ, avgBuy, avgSell, hold, holdSrc, holdQ,
      realized, unrealized: unreal, total: realized + unreal, pct: bQ ? ((realized + unreal) / bQ) * 100 : null, firstBuy: buys[0]?.ts || null, price: t.price,
      trades: list.slice(-200).reverse(), complete: t.source !== 'agent-curve' || (this._all?.get(t.address)?.complete ?? true) };
    if (qUsd > 0) this._ts.set(key, { at: Date.now(), v }); return v;   // 报价币价格还没拿到时不缓存，免得美元一直显示 0
  }

  change(t) {
    const now = Date.now();
    if (t._chg && now - t._chgAt < 5000 && t._chgP === t.price) return t._chg;
    const cs = t.candles || [], p = t.price;
    const out = { launch: null, m5: null, h1: null, h24: null, base: {} };
    if (cs.length && p > 0) {
      const first = cs[0], createdSec = (t.createdAt || 0) / 1000;
      const fromLaunch = createdSec && first.t - createdSec < 300;          // K 线从开盘附近开始，才算「开盘以来」
      const pct = (base) => (base > 0 ? ((p - base) / base) * 100 : null);
      if (fromLaunch) { out.launch = pct(first.o); out.base.launch = { p: first.o, t: first.t }; }
      else if (t.launchPrice > 0) { out.launch = pct(t.launchPrice); out.base.launch = { p: t.launchPrice, t: Math.floor(createdSec) }; }   // K 线够不到开盘（Gang 只给最近成交）：用合约算的开盘价
      const at = (sec, key) => {                                             // 那个时间点的价格：之前最后一根 K 线的收盘价
        const tgt = now / 1000 - sec;
        if (createdSec && createdSec > tgt) return null;                     // 币龄比窗口短：不重复显示开盘以来的数
        if (tgt < first.t) return null;                                      // K 线历史够不到
        let lo = 0, hi = cs.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (cs[m].t <= tgt) lo = m; else hi = m - 1; }
        out.base[key] = { p: cs[lo].c, t: cs[lo].t }; return cs[lo].c;
      };
      out.m5 = pct(at(300, 'm5')); out.h1 = pct(at(3600, 'h1')); out.h24 = pct(at(86400, 'h24'));
    }
    t._chg = out; t._chgAt = now; t._chgP = p; return out;
  }

  list() { return [...this.tokens.values()].map((t) => this.summary(t)); }
  // 成交记录带上钱包域名（只读缓存，没有就是 null）
  named(rows) { return rows.map((r) => ({ ...r, name: r.name || this.names.peek(r.trader) })); }
  detail(a) { const t = this.get(a); if (!t) return null; return { ...this.summary(t), candles: compactCandles(t.candles, 1800), trades: this.named(t.trades.slice(0, 60)) }; }

  netStatus() {
    const l = this.feeds.status.launch;
    // 顶栏「链上订阅」：Flap / Four / Gang 三个 WebSocket 订阅都正常 = ok；部分正常 = partial；都断 = down。shrine 只是补充来源，不影响这个状态
    const subs = [this.flapChain.status, this.four.ws || {}, this.gangChain.status], upN = subs.filter((x) => x.connected).length;
    const wssState = upN === subs.length ? 'ok' : upN ? 'partial' : 'down';
    const chainSubs = { flap: { wss: this.flapChain.status.wss, connected: this.flapChain.status.connected, lastLogAt: this.flapChain.status.lastLogAt, trades: this.flapChain.status.trades },
      four: { wss: this.four.ws?.wss, connected: !!this.four.ws?.connected, lastLogAt: this.four.ws?.lastLogAt }, gang: { wss: this.gangChain.status.wss, connected: this.gangChain.status.connected, lastLogAt: this.gangChain.status.lastLogAt } };
    return { wss: null, wssState, chainSubs, rpc: this.rpcError ? null : this.rpcMs, rpcError: this.rpcError, rpcNode: { ...this.tradeProvider.info, read: nodeName(this.provider.lastUrl || this.provider.urls[0]), gangWs: this.gangChain.status.wss || null, fourWs: this.four.ws?.wss || null, four: nodeName(this.four.status?.rpcActive || this.four.status?.rpc), curve: nodeName(this.curve.status?.rpc) }, shrine: this.feeds.status, curve: this.curve.status, four: this.four.status, gang: this.gang.status, gangChain: { ...this.gangChain.status, recent: (this.gangLat || []).slice(0, 8) } };
  }
}
