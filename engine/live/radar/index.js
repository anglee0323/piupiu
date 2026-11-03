// 机会雷达（docs/PLAN-RADAR.md R0–R5）：主动发现「被一群 .ai 钱包围着的陌生合约」，并把它讲清楚、能一键参与。
//   发现（L1 扫链）→ 自动分析（类型 / 机制 / Agent 专属对比模拟 / 源码与说明 / 你的钱包能不能参与）→ 人话结论
//   → 一键参与（预检 → 确认 → 签名 → 到账核验）
// 另外：「链上动态」= 最近 30 分钟已知 .ai 钱包都在做什么（含已接入平台）；同一套代码部署的多个合约归成一个「系列」；
// 平台变化（R2）：新系列出现 / 系列扩张、币安钱包 CLI 出新版本。
// 节点：独立连接、只用公共节点（NodeReal 按字节计费，不碰）。
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { dataFile } from '../config.js';
import { FailoverProvider } from '../rpc.js';
import { Known } from './known.js';
import { AiSet } from './aiSet.js';
import { BlockScan, judge } from './blockScan.js';
import { Chain } from './chain.js';
import { analyze, ANALYSIS_VER } from './analyze.js';
import { nameOf } from './sigs.js';
import { Participate } from './participate.js';
import { KIND_LABEL } from './classify.js';
import { priority, recommendation } from './score.js';
import { supplyOf } from './review.js';
import { summarize } from './mintHistory.js';
import { socialStats, setSocialDailyCap } from './social.js';
import { EP } from '../endpoints.js';

const lc = (a) => String(a || '').toLowerCase();
const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(lc(a));
// 列表里的图片：data: 内嵌图片单独走 /api/radar/img/<地址>，不放进每 1.5 秒推一次的列表（以前一帧约 600KB，其中一半是图片）
const imgUrl = (address, img) => (!img ? null : img.startsWith('data:') ? (img.length < 400_000 ? `/api/radar/img/${address}` : null) : img);
// quickMint：一键直铸（默认关）——开了以后，「一键铸造」预检通过就直接提交，不再弹确认；只限免费、预检无风险提示的，每天最多 quickMintMax 次（服务端强制）
// autoMint：自动铸造（默认关）——符合「新推荐提醒」或「即将打满」条件的项目不再弹卡片，直接预检并提交；只限免费、预检无风险提示、不需要币安 App 确认，每天最多 autoMintMax 次（服务端强制）
const DEF_SETTINGS = { scan: true, minAi: 5, aiRatioPct: 60, hotMult: 1.5, hotMin: 15, coolMin: 120, maxValueBnb: 0.02, quickMint: false, quickMintMax: 30, autoMint: false, autoMintMax: 10, xDailyMax: 300 };
const dayStart = (t = Date.now()) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const nameIface = new ethers.Interface(['function name() view returns (string)', 'function symbol() view returns (string)']);
const PLATFORM = { flap: 'Flap', four: 'Four', gang: 'Gang' };
const LEVEL_RANK = { go: 4, easy: 3, watch: 2, careful: 1, skip: 0 };

export class Radar {
  constructor({ market, trader = null, log = () => {}, broadcast = () => {} }) {
    this.market = market; this.trader = trader; this.log = log; this.broadcast = broadcast;
    this.candFile = dataFile('radar/candidates.json');
    this.sigFile = dataFile('radar/signals.jsonl');
    this.setFile = dataFile('radar/settings.json');
    this.settings = { ...DEF_SETTINGS };
    try { this.settings = { ...DEF_SETTINGS, ...JSON.parse(readFileSync(this.setFile, 'utf8')) }; } catch { /* 默认 */ }
    this.cands = new Map();
    try { for (const c of JSON.parse(readFileSync(this.candFile, 'utf8')) || []) if (isAddr(c?.address)) this.cands.set(lc(c.address), c); } catch { /* 第一次 */ }   // 不是合约地址的条目（以前详情接口会为任意字符串建快照）直接丢掉
    // 「已关注」独立于候选快照：候选被冷却 / 归档 / 清理后，关注的项目仍然能在列表里找到
    this.followFile = dataFile('radar/follows.json');
    this.follows = new Map();
    try { for (const f of JSON.parse(readFileSync(this.followFile, 'utf8')) || []) if (f?.address) this.follows.set(lc(f.address), f); } catch { /* 第一次 */ }
    for (const f of this.follows.values()) { const c = this.cands.get(f.address); if (c) c.followed = true; }
    setSocialDailyCap(this.settings.xDailyMax ?? 300);
    this.status = { scanning: false, cursor: 0, behind: 0, gaps: 0, node: '—', lastHeadAt: 0, lastError: null, platform: [] };
    this.aiKnown = 0;
    // 分析用一组公共节点轮换（被限流的冷却换下一个），和扫块的连接分开，互不抢额度；不含 NodeReal
    this.provider = new FailoverProvider(EP.rpcPublic, '雷达分析');
    this.chain = new Chain(this.provider);
    // 动态排除 + 中文名：行情里已有的代币 / 内盘市场（战壕看得见的不重复报，但「链上动态」里要知道 .ai 钱包在交易它们）
    this.known = new Known(() => {
      const out = [];
      for (const t of this.market.list?.() || []) {
        const label = `${PLATFORM[t.platform] || '内盘'} 代币交易`;
        if (t.address) out.push({ address: t.address, label }); if (t.market) out.push({ address: t.market, label });
      }
      return out;
    });
    this.ai = new AiSet({ provider: this.provider, names: market.names, log });
    this.scan = null; this.timer = null; this.saveT = null; this.pushT = null; this.namesProbed = new Set();
    this.queue = []; this.queued = new Set(); this.running = 0; this.topSet = new Set();   // topSet：排在前面的几个，后台也去查推特
    this.activity = new Map();   // key → { label, address, who: Map(from → t) }
    this.part = new Participate({
      trader, provider: this.provider, txProvider: market.tradeProvider || this.provider,
      getAnalysis: (a) => this.cands.get(lc(a))?.an || null, settings: () => this.settings,
      emit: (rec) => {
        this.broadcast({ type: 'radarMint', data: rec });
        if (/^(done|transferred)$/.test(rec.status)) setTimeout(() => this.nftPortfolio({ force: true }).catch(() => {}), 8000);   // 铸到 / 转走后更新「我的 NFT」
      }, log,
    });
    this.userLinks = new Map();   // 地址 → 用户补充的链接
    for (const c of this.cands.values()) if (c.links?.length) this.userLinks.set(c.address, c.links);
  }

  start() {
    if (this.scan) return;
    this.settings.scan = true;
    this.scan = new BlockScan({
      known: this.known, aiSet: this.ai, status: this.status, log: this.log,
      onStats: (to, st) => this.onStats(to, st),
      onActivity: (label, to, from, t) => this.onActivity(label, to, from, t),
      labelOf: (to) => (this.cands.has(to) ? '__cand' : null),
    }).start();
    this.status.scanning = true;
    this.timer = setInterval(() => this.sweep(), 5000); this.timer.unref?.();
    this.platT = setInterval(() => this.platformCheck(), 3600_000); this.platT.unref?.(); setTimeout(() => this.platformCheck(), 30_000);
    this.supT = setInterval(() => this.refreshSupply().catch(() => {}), 60_000); this.supT.unref?.();
    // 我持有的 NFT：启动 20 秒后读一次，之后每 10 分钟
    if (this.trader) { setTimeout(() => this.nftPortfolio().catch(() => {}), 20_000); this.nftT = setInterval(() => this.nftPortfolio({ force: true }).catch(() => {}), 10 * 60_000); this.nftT.unref?.(); }
    this.aiKnown = this.ai.count();
    for (const c of [...this.cands.values()].filter((x) => !x.blocked && !x.archived && x.state !== 'cool' && (!x.an || x.an.v !== ANALYSIS_VER)).sort((a, b) => (b.stats?.aiCallers || 0) - (a.stats?.aiCallers || 0))) this.enqueue(c.address);
    // 升级前的旧数据没有 recAt：已经在推荐里的按首次发现时间补上，避免这次上线把它们全部当成「新推荐」响一遍
    for (const c of this.cands.values()) if (!c.recAt && recommendation(c.an, c.stats || {}, c.state).rec) c.recAt = c.firstSeen || Date.now();
    this.saveSettings(); this.log(`[雷达] 开始扫描（已知 .ai 钱包 ${this.aiKnown}）`); this.push();
    // 上次关机时「已广播 / 没等到结果」的记录：只按原哈希查回执，不重新构造、不重发
    this.part.reconcile().catch((e) => this.log(`[雷达] 重启核对失败：${e.message}`));
  }
  stop(scanOff = true) {
    this.scan?.stop(); this.scan = null; clearInterval(this.timer); clearInterval(this.platT); clearInterval(this.supT); this.timer = null;
    if (scanOff) this.settings.scan = false;
    this.status.scanning = false; this.saveSettings(); this.push();
    this.log('[雷达] 扫描已停止');
  }

  // ---------- 链上动态：最近 30 分钟已知 .ai 钱包在做什么 ----------
  onActivity(label, to, from, t) {
    let key, name, address = null;
    if (label === '__cand' || (!label && this.cands.has(to))) { const c = this.cands.get(to); const fam = this.famOf(c); key = 'c:' + (fam?.key || to); name = fam?.title || c?.symbol || c?.name || short(to); address = fam?.lead || to; }
    else if (label) { key = 'l:' + label; name = label; }
    else { key = 'other'; name = '其他合约'; }
    let a = this.activity.get(key); if (!a) { a = { label: name, address, who: new Map(), cand: key.startsWith('c:') }; this.activity.set(key, a); }
    a.label = name; if (address) a.address = address;
    a.who.set(from, t);
  }
  activityView(now = Date.now()) {
    const all = new Set(); const rows = [];
    for (const [k, a] of this.activity) {
      for (const [f, t] of a.who) if (now - t > 30 * 60_000) a.who.delete(f);
      if (!a.who.size) { this.activity.delete(k); continue; }
      for (const f of a.who.keys()) all.add(f);
      rows.push({ key: k, label: a.label, address: a.address, cand: a.cand, ai: a.who.size });
    }
    rows.sort((x, y) => y.ai - x.ai);
    return { active: all.size, rows: rows.filter((r) => r.key !== 'other').slice(0, 10), other: this.activity.get('other')?.who.size || 0 };
  }

  // ---------- 候选 ----------
  onStats(to, st) {
    const j = judge(st, this.settings);
    const now = Date.now();
    let c = this.cands.get(to);
    if (!j.listed) {
      if (c) { c.stats = pick(st); c.updatedAt = now; c.lastAiAt = st.lastAiAt || c.lastAiAt; this.throttleSave(); }
      return;
    }
    if (!c) {
      c = { address: to, firstSeen: now, state: 'new', followed: false, blocked: false, archived: false, name: null, symbol: null, stats: null, updatedAt: now, alertedAt: 0, firstHotAt: null, lastAiAt: st.lastAiAt || now, an: null };
      this.cands.set(to, c); this.probeName(c);
      this.signal({ kind: 'listed', address: to, ai: st.aiCallers, callers: st.callers, ratio: st.ratio });
      this.log(`[雷达] 新候选 ${to}：.ai ${st.aiCallers}/${st.callers}（${Math.round(st.ratio * 100)}%）`);
      this.enqueue(to, true);
    }
    c.stats = pick(st); c.updatedAt = now; c.lastAiAt = st.lastAiAt || c.lastAiAt;
    if (c.historyOnly && (st.aiCallers > 0 || st.callers >= 5)) delete c.historyOnly;   // 又有真实活动：回到正常候选
    const was = c.state;
    if (was === 'cool' || was === 'new') c.state = j.hot ? 'hot' : 'new';
    if (c.state === 'hot' && c.firstHotAt == null) c.firstHotAt = now;
    if (was !== c.state) {
      this.signal({ kind: c.state, address: to, ai: st.aiCallers });
      if (c.state === 'hot') this.maybeAlert(c, 'hot');
      else if (c.followed) this.maybeAlert(c, 'follow');
    }
    this.markRec(c);
    if (c.state !== 'cool' && (!c.an || c.an.v !== ANALYSIS_VER || now - c.an.at > 10 * 60_000)) this.enqueue(to);   // 活跃期间每 10 分钟重新分析（供应、热度、你的钱包能不能参与都会变）
    this.throttleSave(); this.throttlePush();
  }

  // ---------- 分析队列（并发 2） ----------
  /** 「即将打满」要看的已铸数量：分析是 10 分钟一次，接近铸完时太慢。已铸 ≥ 30% 且没铸完、还活跃的项目，每分钟只读一次 totalSupply（公共节点，最多 30 个） */
  async refreshSupply() {
    const list = [...this.cands.values()].filter((c) => {
      if (c.blocked || c.archived || c.state === 'cool' || !c.an?.profile || c.an.profile.totalSupply == null) return false;
      const s = supplyOf(c.an.profile); return s.pct != null && s.pct >= 30 && s.pct < 100;
    }).sort((a, b) => supplyOf(b.an.profile).pct - supplyOf(a.an.profile).pct).slice(0, 30);
    let changed = false;
    for (const c of list) {
      const r = await this.chain.read(c.address, 'function totalSupply() view returns (uint256)').catch(() => null);
      if (r?.v == null) continue;
      const v = String(r.v);
      if (v !== String(c.an.profile.totalSupply)) { c.an.profile.totalSupply = v; changed = true; }
    }
    if (changed) { this.throttleSave(); this.throttlePush(); }
  }

  /** 自动铸造：notifier 判断出符合条件的项目后调用（items 来自 view()）。逐个预检、通过就提交；每个项目 24 小时内只试一次。
   *  用交易钱包（右上角选择的）；结果和手动铸造一样记进铸造记录并推送 radarMint */
  async autoMint(items) {
    if (!this.settings.autoMint || !this.trader) return;
    this.autoTried ||= new Map();
    const slots = this.trader.tradeSlots?.() || [];
    for (const it of items) {
      const a = String(it.address).toLowerCase();
      if (Date.now() - (this.autoTried.get(a) || 0) < 24 * 3600_000) continue;
      this.autoTried.set(a, Date.now());
      const name = it.title || short(a);
      try {
        const pv = await this.part.preview({ address: a, slots });
        const ok = pv.rows.filter((r) => r.ok);
        if (!ok.length) { this.log(`[雷达] 自动铸造 ${name}：预检未通过（${pv.rows.map((r) => r.reason).filter(Boolean).join('；').slice(0, 120)}）`); continue; }
        await this.part.submit({ previewId: pv.previewId, slots: ok.map((r) => r.slot), auto: true });
        this.log(`[雷达] 自动铸造 ${name}：已提交 ${ok.map((r) => 'W' + r.slot).join('、')}`);
      } catch (e) { this.log(`[雷达] 自动铸造 ${name}：未提交（${e.message}）`); }
    }
  }

  enqueue(a, front = false, deep = false) {
    a = lc(a); const c = this.cands.get(a); if (!c || c.blocked) return;
    if (deep) c.wantDeep = true;
    if (this.queued.has(a)) { if (front) { this.queue = [a, ...this.queue.filter((x) => x !== a)]; } return; }
    this.queued.add(a); if (front) this.queue.unshift(a); else this.queue.push(a);
    this.kick();
  }
  kick() {
    while (this.running < 3 && this.queue.length) {
      const a = this.queue.shift(); this.queued.delete(a); this.running++;
      this.runAnalysis(a).catch((e) => this.log(`[雷达] 分析 ${short(a)} 出错：${e.message}`)).finally(() => { this.running--; this.kick(); });
    }
  }
  async runAnalysis(a) {
    const c = this.cands.get(a); if (!c) return;
    const deep = !!c.wantDeep; c.wantDeep = false;
    const wallets = (this.trader?.wallets || []).filter((w) => this.trader.slotAuth?.get(w.slot)?.state === 'ok').map((w) => ({ slot: w.slot, address: lc(w.address) }));
    const fam = this.famOf(c);
    const an = await analyze(a, { chain: this.chain, provider: this.provider, scan: this.scan, aiSet: this.ai, wallets, stats: c.stats, family: fam ? { count: fam.members.length } : null, prev: c.an, deep, userLinks: this.userLinks.get(a) || [], social: deep || this.topSet.has(a), historyNft: this.part.summary(a).nft,
      nameOf: (x) => this.market.names?.peek?.(x) || null,
      creatorOthers: (dep, self) => [...this.cands.values()].filter((o) => o.address !== self && o.an?.src?.deployer === dep).map((o) => ({ address: o.address, symbol: o.symbol, name: o.name })) });
    const before = c.an?.review?.verdict?.level;
    c.an = an; c.family = an.profile.family; c.name ||= an.name; c.symbol ||= an.symbol;
    // 合约部署时间（开源合约才有部署区块）：读一次区块头，列表按「上线多久」筛选用；没有就用雷达首次发现时间
    if (an.src?.deployBlock && !c.deployedAt) this.provider.getBlock(an.src.deployBlock).then((b) => { if (b?.timestamp) { c.deployedAt = b.timestamp * 1000; this.throttleSave(); this.throttlePush(); } }).catch(() => {});
    this.markRec(c);
    const lvl = an.review.verdict.level;
    if (lvl === 'go' && before !== 'go') { this.signal({ kind: 'ready', address: a, why: an.review.verdict.why }); this.maybeAlert(c, 'ready', true); }
    this.familyWatch(c);
    this.throttleSave(); this.throttlePush();
    this.broadcast({ type: 'radarDetail', data: { address: a } });
  }

  // ---------- 系列（同一套代码的多个合约）----------
  families() {
    const m = new Map();
    for (const c of this.cands.values()) {
      if (c.blocked || c.archived) continue;
      const k = c.family || 'one:' + c.address;
      if (!m.has(k)) m.set(k, []); m.get(k).push(c);
    }
    const out = new Map();
    for (const [k, list] of m) {
      list.sort((x, y) => (y.stats?.aiCallers || 0) - (x.stats?.aiCallers || 0));
      const syms = [...new Set(list.map((c) => c.symbol || c.name).filter(Boolean))];
      const title = list.length > 1 ? (syms.length === 1 ? `${syms[0]} 系列` : `${syms[0] || short(list[0].address)} 等 ${list.length} 个合约`) : (list[0].symbol || list[0].name || null);
      const titleK = list.length > 1 ? (syms.length === 1 ? { k: 'rd.series', p: { s: syms[0] } } : { k: 'rd.seriesN', p: { s: syms[0] || short(list[0].address), n: list.length } }) : null;   // 英文界面用
      out.set(k, { key: k, members: list.map((c) => c.address), lead: list[0].address, title, titleK, list });
    }
    return out;
  }
  famOf(c) { if (!c) return null; const k = c.family || 'one:' + c.address; return this.families().get(k) || null; }
  // R2 平台变化：同一套代码在 1 小时内部署了 3 个以上合约 → 「新系列 / 新平台」；已关注的系列又出新合约 → 提醒
  familyWatch(c) {
    const fam = this.famOf(c); if (!fam || fam.list.length < 2) return;
    const recent = fam.list.filter((x) => Date.now() - x.firstSeen < 3600_000).length;
    c.familySeen ||= 0;
    if (fam.list.length >= 3 && recent >= 3 && !fam.list.some((x) => x.familyAlerted)) {
      fam.list.forEach((x) => { x.familyAlerted = true; });
      this.signal({ kind: 'family', key: fam.key, count: fam.list.length, title: fam.title });
      this.log(`[雷达] 新系列 ${fam.title}：1 小时内同一套代码部署了 ${recent} 个合约`);
    }
  }
  // 币安钱包 CLI 新版本（多钱包依赖它存凭证的方式，升级前要核对）：只查版本号，不下载
  async platformCheck() {
    const out = [];
    try {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 8000);
      const r = await fetch('https://registry.npmjs.org/@binance%2fagentic-wallet/latest', { signal: ac.signal }).finally(() => clearTimeout(t));
      const j = await r.json(); const latest = j?.version;
      const { profileSupport } = await import('../baw.js');
      const cur = profileSupport?.()?.version || null;
      if (latest && cur && latest !== cur) out.push({ kind: 'baw', text: `币安钱包 CLI 有新版本 ${latest}（本机 ${cur}）。升级前请确认多钱包兼容性` });
    } catch { /* 查不到就算了 */ }
    this.status.platform = out; this.push();
  }

  sweep() {
    const now = Date.now();
    this.aiKnown = this.ai.count();
    const coolMs = this.settings.coolMin * 60_000;
    let dirty = false;
    for (const c of this.cands.values()) {
      if (c.blocked || c.state === 'cool') { if (c.state === 'cool' && now - (c.updatedAt || 0) > 24 * 3600_000 && !c.followed) { c.archived = true; dirty = true; } continue; }
      if (c.lastAiAt && now - c.lastAiAt > coolMs) {
        c.state = 'cool'; dirty = true;
        this.signal({ kind: 'cool', address: c.address });
        if (c.followed) this.maybeAlert(c, 'follow');
      }
    }
    if (dirty) this.throttleSave();
    this.push();
  }

  maybeAlert(c, kind, force = false) {
    const now = Date.now();
    if (c.blocked || (!force && now - (c.alertedAt || 0) < 30 * 60_000)) return;
    if (force && now - (c.readyAlertAt || 0) < 30 * 60_000) return;
    if (force) c.readyAlertAt = now; else c.alertedAt = now;
    const st = c.stats || {}, r = c.an?.review;
    const line = kind === 'ready' ? `${r?.verdict?.label || '可参与'}：${r?.oneLine || ''}` : `${st.aiCallers ?? 0} 个 .ai 钱包 · 近 10 分钟 +${st.last10 ?? 0}${r?.oneLine ? ' · ' + r.oneLine : ''}`;
    this.signal({ kind: 'alert:' + kind, address: c.address, line });   // 不再弹窗（用户不关心）：页面自己按「新的优先项目」决定要不要响一声
  }

  async probeName(c) {
    if (this.namesProbed.has(c.address)) return;
    this.namesProbed.add(c.address);
    const read = async (fn) => { try { const r = await this.provider.call({ to: c.address, data: nameIface.encodeFunctionData(fn) }); return ethers.AbiCoder.defaultAbiCoder().decode(['string'], r)[0] || null; } catch { return null; } };
    const [name, symbol] = await Promise.all([read('name'), read('symbol')]);
    if (name || symbol) { c.name = name; c.symbol = symbol; this.throttleSave(); this.throttlePush(); }
  }

  // ---------- 用户操作 ----------
  mark(address, { follow, block } = {}) {
    const a = lc(address);
    if (!isAddr(a)) throw new Error('不是有效的合约地址');
    let c = this.cands.get(a);
    if (!c) {
      if (follow === false && block !== true) throw new Error('雷达中没有该合约');
      c = this.ensureCand(a);   // 历史 / 关注里出现过、候选被清理过的合约：也能关注 / 取消隐藏
    }
    if (follow != null) {
      c.followed = !!follow;
      if (follow) this.follows.set(a, { address: a, at: Date.now(), title: this.titleOf(c), symbol: c.symbol || null, name: c.name || null });
      else this.follows.delete(a);
      this.saveFollows();
    }
    if (block != null) { c.blocked = !!block; if (block) this.signal({ kind: 'blocked', address: a }); }
    this.save(); this.push();
    return { address: a, followed: !!c.followed, blocked: !!c.blocked };
  }
  titleOf(c) {
    if (!c) return null;
    const fam = this.famOf(c);
    return fam?.title || c.symbol || c.name || short(c.address);
  }
  /** 历史 / 关注里出现过、但候选被清理或隐藏过的合约：建一个最小快照，历史仍可查看、分析仍可按需触发 */
  ensureCand(a) {
    a = lc(a);
    const s = this.part.summary(a), f = this.follows.get(a);
    const c = { address: a, firstSeen: s.lastAt || Date.now(), state: 'cool', followed: !!f, blocked: false, archived: false,
      historyOnly: true, name: f?.name || null, symbol: s.symbol || f?.symbol || null, stats: null, updatedAt: Date.now(),
      alertedAt: 0, firstHotAt: null, lastAiAt: 0, an: null, recAt: null, links: [] };
    this.cands.set(a, c); this.throttleSave();
    return c;
  }
  /** 第一次进入「推荐」时记时间（之后掉档再回来不重复响；68 分只是档位，不改这条） */
  markRec(c) {
    if (!c) return false;
    const { rec } = recommendation(c.an, c.stats || {}, c.state);
    if (rec && !c.recAt) { c.recAt = Date.now(); this.signal({ kind: 'rec', address: c.address }); }
    return rec;
  }
  saveFollows() {
    try { mkdirSync(new URL('.', this.followFile), { recursive: true }); writeFileSync(this.followFile, JSON.stringify([...this.follows.values()])); } catch { /* ignore */ }
  }
  hidden() { return [...this.cands.values()].filter((c) => c.blocked).map((c) => ({ address: c.address, title: this.titleOf(c) || short(c.address), at: c.updatedAt || c.firstSeen || 0 })); }
  history(opts = {}) { return this.part.history(opts); }
  /** 我持有的 NFT（资产页 / 顶部持仓条用）：铸造历史里的合约 + 分析时读到「你的钱包持有」的合约；
   *  每个合约读一次当前持仓（编号）。持仓 5 分钟缓存。不估值：OKX 对这些合集没有挂单价，也没有可用的 NFT 接口 */
  async nftPortfolio({ force = false } = {}) {
    if (!force && this.nftSnap && Date.now() - this.nftSnap.at < 5 * 60_000) return this.nftSnap;
    if (this.nftBusy) return this.nftBusy;
    this.nftBusy = (async () => {
      const sums = summarize(this.part.records);
      const addrs = new Set([...sums.values()].filter((s) => s.nft > 0 || s.mintTx > 0).map((s) => s.address));
      for (const c of this.cands.values()) if (c.an?.mine?.some((m) => m.minted > 0) && (c.an.profile?.erc721 || c.an.profile?.erc1155 || c.an.cls?.kind === 'nft-mint')) addrs.add(c.address);
      const rows = [];
      for (const a of addrs) {
        const c = this.cands.get(a), an = c?.an || null;
        let h; try { h = await this.part.holdings(a, an); } catch { continue; }
        if (h.std === '20') continue;
        // 公共节点偶尔读失败（balance 为 null）：重试一次，还不行就沿用上次的结果，不要把 NFT 显示成没了
        if (h.rows.some((r) => r.balance == null)) { try { h = await this.part.holdings(a, an); } catch { /* 用上次 */ } }
        const prev = this.nftSnap?.rows.find((r) => r.address === a);
        if (h.rows.some((r) => r.balance == null) && prev) { rows.push(prev); continue; }
        const held = h.rows.filter((r) => (r.balance || 0) > 0);
        const count = held.reduce((s, r) => s + (r.balance || 0), 0);
        const ids = held.flatMap((r) => r.ids.map((x) => ({ slot: r.slot, id: x.id, amount: x.amount || null })));
        const s = sums.get(a);
        const title = this.titleOf(c) || s?.symbol || short(a);
        rows.push({
          address: a, title, name: an?.project?.name || c?.name || null, std: h.std, image: imgUrl(a, an?.project?.image),
          count, ids: ids.slice(0, 50), perSlot: held.map((r) => ({ slot: r.slot, count: r.balance || 0 })),
          minted: { tx: s?.mintTx || 0, nft: s?.nft || 0, transfers: s?.transfers || 0, lastAt: s?.lastAt || null },
        });
      }
      rows.sort((x, y) => y.count - x.count || (y.minted.lastAt || 0) - (x.minted.lastAt || 0));
      this.nftSnap = { at: Date.now(), rows, total: rows.reduce((s2, r) => s2 + r.count, 0) };
      this.broadcast({ type: 'nft', data: this.nftSnap });
      return this.nftSnap;
    })().finally(() => { this.nftBusy = null; });
    return this.nftBusy;
  }
  /** 列表缩略图（data: 内嵌图片解码后返回） */
  image(address) {
    const img = this.cands.get(lc(address))?.an?.project?.image || '';
    const m = /^data:([\w/+.-]+)(;base64)?,(.*)$/s.exec(img);
    if (!m) return null;
    return { type: m[1], body: m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3])) };
  }
  /** 补充资料：用户贴链接（官网 / 文档）→ 重新深度分析 */
  addLinks(address, links) {
    const a = lc(address); const c = this.cands.get(a); if (!c) throw new Error('雷达中没有该合约');
    const list = [...new Set([...(this.userLinks.get(a) || []), ...(links || []).map((u) => String(u).trim()).filter((u) => /^https:\/\//i.test(u))])].slice(0, 8);
    this.userLinks.set(a, list); c.links = list; this.save();
    this.enqueue(a, true, true);
    return list;
  }
  setSettings(patch) {
    const cur = this.settings;
    const num = (v, def, min, max) => { const x = Number(v); return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : def; };
    const next = {
      scan: patch.scan != null ? !!patch.scan : cur.scan,
      minAi: Math.round(num(patch.minAi, cur.minAi, 2, 200)),
      aiRatioPct: Math.round(num(patch.aiRatioPct, cur.aiRatioPct, 10, 100)),
      hotMult: num(patch.hotMult, cur.hotMult, 1.1, 10),
      hotMin: Math.round(num(patch.hotMin, cur.hotMin, 2, 500)),
      coolMin: Math.round(num(patch.coolMin, cur.coolMin, 10, 1440)),
      maxValueBnb: num(patch.maxValueBnb, cur.maxValueBnb, 0, 1),
      quickMint: patch.quickMint != null ? patch.quickMint === true : !!cur.quickMint,
      quickMintMax: Math.round(num(patch.quickMintMax, cur.quickMintMax ?? 30, 1, 200)),
      autoMint: patch.autoMint != null ? patch.autoMint === true : !!cur.autoMint,
      autoMintMax: Math.round(num(patch.autoMintMax, cur.autoMintMax ?? 10, 1, 100)),
      xDailyMax: Math.round(num(patch.xDailyMax, cur.xDailyMax ?? 300, 20, 5000)),
    };
    setSocialDailyCap(next.xDailyMax);
    const was = cur.scan;
    this.settings = next;
    if (next.scan && !was && !this.scan) this.start();
    else if (!next.scan && was && this.scan) this.stop(false);
    else { this.saveSettings(); this.push(); }
    return this.settings;
  }
  saveSettings() { try { mkdirSync(new URL('.', this.setFile), { recursive: true }); writeFileSync(this.setFile, JSON.stringify(this.settings, null, 1)); } catch { /* ignore */ } }

  signal(o) { try { mkdirSync(new URL('.', this.sigFile), { recursive: true }); appendFileSync(this.sigFile, JSON.stringify({ ts: Date.now(), ...o }) + '\n'); } catch { /* ignore */ } }
  save() {
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => {
      try { mkdirSync(new URL('.', this.candFile), { recursive: true }); writeFileSync(this.candFile, JSON.stringify([...this.cands.values()].sort((a, b) => b.firstSeen - a.firstSeen).slice(0, 600))); } catch { /* ignore */ }
    }, 2000);
  }
  throttleSave = () => this.save();
  throttlePush() { if (this.pushT) return; this.pushT = setTimeout(() => { this.pushT = null; this.push(); }, 1500); }
  push() { this.broadcast({ type: 'radar', data: this.view() }); }

  // ---------- 视图 ----------
  /** 列表：按系列合并，一行一个机会。推荐资格、历史、关注都从这里出，前端不用自己再判断 */
  view() {
    const now = Date.now();
    const items = [];
    const seen = new Set();
    const sums = summarize(this.part.records);

    const base = (c) => {
      const an = c?.an, p = recommendation(an, c?.stats || {}, c?.state || 'new');
      return { an, r: an?.review, P: p.priority, rec: p.rec };
    };

    for (const fam of this.families().values()) {
      const list = fam.list, lead = list[0];
      for (const c of list) seen.add(c.address);
      const scored = list.map((c) => ({ c, ...base(c) })).sort((x, y) => (y.P?.score ?? -1) - (x.P?.score ?? -1));
      const best = scored[0], leadBest = best.c, an = leadBest.an, P = best.P;
      const live = list.filter((c) => c.state !== 'cool');
      const bars = (lead.stats?.bars || []).map((b, i) => ({ t: b.t, n: list.reduce((s2, c) => s2 + (c.stats?.bars?.[i]?.n || 0), 0) }));
      const recMembers = scored.filter((x) => x.rec);
      const recAt = recMembers.length ? Math.max(...recMembers.map(({ c }) => c.recAt || c.firstSeen || now)) : 0;
      const lan = leadBest.an, sup = lan ? supplyOf(lan.profile || {}) : null;
      const pos = P ? P.parts.filter((x) => x.pts > 0 && !HIDE_WHY.has(x.k)).slice(0, 2) : [], neg = P ? P.parts.filter((x) => x.pts < 0).slice(0, 1) : [];
      const mintTx = fam.members.reduce((s2, a) => s2 + (sums.get(a)?.mintTx || 0), 0);
      const nft = fam.members.reduce((s2, a) => s2 + (sums.get(a)?.nft || 0), 0);
      items.push({
        id: fam.key, address: leadBest.address, members: fam.members.length, keys: fam.members, title: fam.title || short(lead.address), titleK: fam.titleK || null,
        kind: an?.cls?.kind || null, kindLabel: KIND_LABEL[an?.cls?.kind] || null,
        oneLine: leadBest.an?.review?.oneLine || null, verdict: leadBest.an?.review?.verdict || null, canDo: list.some((c) => c.an?.review?.canDo),
        aiOnly: an?.aiOnly?.state || null, analyzed: !!an, analyzing: list.some((c) => this.queued.has(c.address)) || (!an && this.running > 0),
        state: live.some((c) => c.state === 'hot') ? 'hot' : live.length ? 'new' : 'cool',
        followed: list.some((c) => c.followed), joined: mintTx > 0, mine: nft, mintTx, nft,
        firstSeen: Math.min(...list.map((c) => c.firstSeen)), lastAiAt: Math.max(...list.map((c) => c.lastAiAt || 0)),
        aiCallers: list.reduce((s2, c) => s2 + (c.stats?.aiCallers || 0), 0), last10: list.reduce((s2, c) => s2 + (c.stats?.last10 || 0), 0), bars,
        score: P ? P.score * 10 + (live.length ? 5 : 0) : 0,
        note: leadBest.an?.review?.verdict?.why || null, creator: leadBest.an?.creator?.name || null,
        priority: P ? { score: P.score, level: P.level, label: P.label, top: P.parts.filter((x) => x.pts > 0).slice(0, 3).map((x) => x.why), minus: P.parts.filter((x) => x.pts < 0).slice(0, 2).map((x) => x.why) } : null,
        image: imgUrl(leadBest.address, lan?.project?.image),
        bornAt: leadBest.deployedAt || leadBest.firstSeen, bornBy: leadBest.deployedAt ? 'deploy' : 'seen',   // 上线时间：合约部署时间，未开源的用雷达首次发现时间
        tagline: tagline(lan), taglineEn: taglineEn(lan),
        why: pos.map((x) => shortWhy(x.why)), whyNot: neg.map((x) => shortWhy(x.why)),
        whyK: pos.map(({ k, p }) => ({ k, p })), whyNotK: neg.map(({ k, p }) => ({ k, p })),   // 英文界面按文案键显示
        name: lan?.project?.name || leadBest.name || null,
        utility: lan?.utility?.summary || null,
        free: lan ? (lan.review?.needWei != null ? lan.review.needWei === '0' : lan.cls?.valueWei === '0') : null,
        price: lan?.review?.needWei ?? lan?.cls?.valueWei ?? null,
        supply: sup ? { minted: sup.minted, max: sup.max, pct: sup.pct } : null,
        social: lan?.social ? { count: lan.social.count || 0, official: lan.social.official?.url || null } : null,
        hasSite: !!lan?.project?.links?.some((u) => !/x\.com|twitter\.com|t\.me|discord/i.test(u)),
        queuePos: !lan ? Math.max(1, this.queue.indexOf(leadBest.address) + 1) : null,
        rec: recMembers.length > 0, recAt, mineExhausted: !!lan?.mineExhausted,
      });
    }

    // 历史里出现、但已经不在当前推荐里的项目（冷却 / 被隐藏 / 候选被清理 / 列表截断）：仍要能在「已铸造」找到
    for (const s2 of sums.values()) {
      if (seen.has(s2.address)) continue;
      const c = this.cands.get(s2.address), f = this.follows.get(s2.address);
      const an = c?.an || null, p2 = recommendation(an, c?.stats || {}, c?.state || 'cool');
      const sup = an ? supplyOf(an.profile || {}) : null;
      items.push({
        id: 'h:' + s2.address, address: s2.address, members: 1, keys: [s2.address], title: c?.symbol || s2.symbol || f?.title || short(s2.address),
        kind: an?.cls?.kind || null, kindLabel: KIND_LABEL[an?.cls?.kind] || null, oneLine: null, verdict: an?.review?.verdict || null,
        canDo: !!an?.review?.canDo, aiOnly: an?.aiOnly?.state || null, analyzed: !!an, analyzing: false, state: c?.state || 'cool',
        followed: !!(c?.followed || f), joined: true, mine: s2.nft, mintTx: s2.mintTx, nft: s2.nft, blocked: !!c?.blocked,
        firstSeen: s2.lastAt, lastAiAt: c?.lastAiAt || s2.lastAt, aiCallers: c?.stats?.aiCallers || 0, last10: c?.stats?.last10 || 0, bars: c?.stats?.bars || [],
        score: p2.priority ? p2.priority.score * 10 : 0,
        priority: p2.priority ? { score: p2.priority.score, level: p2.priority.level, label: p2.priority.label, top: [], minus: [] } : null,
        image: imgUrl(s2.address, an?.project?.image), bornAt: c?.deployedAt || c?.firstSeen || s2.lastAt, bornBy: c?.deployedAt ? 'deploy' : 'seen', tagline: tagline(an), taglineEn: taglineEn(an), why: [], whyNot: [], name: an?.project?.name || null,
        utility: an?.utility?.summary || null, free: an ? an.review?.needWei === '0' : null, price: an?.review?.needWei ?? null,
        supply: sup ? { minted: sup.minted, max: sup.max, pct: sup.pct } : null,
        social: null, hasSite: !!an?.project?.links?.some((u) => !/x\.com|twitter\.com|t\.me|discord/i.test(u)), queuePos: null,
        rec: p2.rec, recAt: p2.rec ? (c?.recAt || s2.lastAt) : 0, historyOnly: true, note: null, creator: null, mineExhausted: !!an?.mineExhausted,
      });
      seen.add(s2.address);
    }

    // 已关注、但候选已经不在列表里的
    for (const f of this.follows.values()) {
      if (seen.has(f.address)) continue;
      const c = this.cands.get(f.address), an = c?.an || null, p3 = recommendation(an, c?.stats || {}, c?.state || 'cool');
      items.push({
        id: 'f:' + f.address, address: f.address, members: 1, keys: [f.address], title: f.title || f.symbol || short(f.address),
        kind: null, kindLabel: null, oneLine: null, verdict: an?.review?.verdict || null, canDo: false, aiOnly: null, analyzed: !!an, analyzing: false,
        state: c?.state || 'cool', followed: true, joined: false, mine: 0, mintTx: 0, nft: 0, firstSeen: f.at, bornAt: c?.deployedAt || c?.firstSeen || f.at, bornBy: c?.deployedAt ? 'deploy' : 'seen', lastAiAt: 0, aiCallers: 0, last10: 0, bars: [],
        score: 0, priority: null, image: null, tagline: tagline(an), taglineEn: taglineEn(an), why: [], whyNot: [], name: null, utility: null, free: null, price: null, supply: null, social: null,
        hasSite: false, queuePos: null, rec: p3.rec, recAt: p3.rec ? c?.recAt || f.at : 0, followOnly: true, note: null, creator: null,
      });
      seen.add(f.address);
    }

    items.sort((a, b) => (b.rec ? 1 : 0) - (a.rec ? 1 : 0) || b.score - a.score || b.lastAiAt - a.lastAiAt);
    this.topSet = new Set(items.filter((x) => x.rec && x.analyzed).slice(0, 10).map((x) => x.address));   // 前 10 个后台查推特

    const trend = new Map();
    for (const c of this.cands.values()) {
      if (c.blocked || c.archived || c.state === 'cool' || !c.an) continue;
      const k = c.an.cls?.kind || 'unknown'; const gate = c.an.aiOnly?.state === 'verified' || c.an.aiOnly?.state === 'likely';
      const free = c.an.review?.needWei === '0' || (c.an.review?.needWei == null && c.an.cls?.valueWei === '0');
      const kk = k === 'buy' || k === 'sell' ? 'trade' : k;
      const key = `${kk}|${gate ? 1 : 0}|${free ? 1 : 0}`;
      const G = gate ? ' Agent 专属' : '';
      const label = { 'nft-mint': `${free ? '免费' : '付费'}铸${G} NFT`, 'token-mint': `${free ? '免费' : ''}铸${G}代币`, claim: `领取${G}奖励 / 空投`, trade: `买卖${G}代币`, launch: '在新发射台发币', interact: `${G}合约交互（认购 / 签到等）`.trim() }[kk] || KIND_LABEL[k] || k;
      const t = trend.get(key) || { kind: kk, label, gate, free, count: 0, ai: 0, creators: new Set(), lead: c.address };
      t.count++; t.ai += c.stats?.aiCallers || 0; if (c.an.src?.deployer) t.creators.add(c.an.src.deployer); trend.set(key, t);
    }

    return {
      items: items.slice(0, 400),
      recCount: items.filter((x) => x.rec).length,
      activity: this.activityView(now),
      trend: [...trend.values()].filter((t) => t.kind !== 'unknown').sort((a, b) => b.ai - a.ai).slice(0, 4).map((t) => ({ kind: t.kind, label: t.label, gate: t.gate, free: t.free, count: t.count, ai: t.ai, creators: t.creators.size, lead: t.lead })),
      status: { ...this.status, sample: undefined, aiKnown: this.aiKnown, todayNew: [...this.cands.values()].filter((c) => (c.firstSeen || 0) >= dayStart() && !c.blocked).length, queue: this.queue.length + this.running, social: socialStats() },
      hidden: this.hidden(),
      settings: this.settings,
      canTrade: !!this.trader,
    };
  }

  /** 详情：一个合约的完整分析 + 同系列的其他合约 + 大家最近在做什么 + 你的参与记录。
   *  历史 / 关注里出现过、但候选被清理过的合约也能打开（建一个最小快照，不要求现在还在推荐里） */
  async detail(address) {
    const a = lc(address);
    if (!isAddr(a)) throw new Error('不是有效的合约地址');
    // 只有铸造历史 / 关注里出现过的合约才补建快照；其他地址不在雷达里（以前任意地址都会被建成一条列表项）
    let c = this.cands.get(a);
    if (!c) { if (!this.part.summary(a).records && !this.follows.has(a)) throw new Error('雷达中没有该合约'); c = this.ensureCand(a); }
    if (!c.an || c.an.v !== ANALYSIS_VER || Date.now() - c.an.at > 2 * 60_000 || (!c.an.site && !c.deepAt)) { c.deepAt = Date.now(); this.enqueue(a, true, true); }   // 打开详情：过期 / 旧版本的分析插队重跑
    const fam = this.famOf(c);
    const names = this.market.names;
    const calls = (this.scan?.recent(a, 25) || []);
    const sels = [...new Set(calls.map((e) => e.sel).filter(Boolean))];
    const fnBy = Object.fromEntries(await Promise.all(sels.map(async (s2) => [s2, await nameOf(s2).catch(() => null)])));
    const sum = this.part.summary(a);
    const rec = recommendation(c.an, c.stats || {}, c.state);
    return {
      address: a, name: c.name, symbol: c.symbol, state: c.state, followed: !!c.followed, blocked: !!c.blocked, historyOnly: !!c.historyOnly,
      firstSeen: c.firstSeen, lastAiAt: c.lastAiAt, stats: c.stats,
      analysis: c.an, analyzing: this.queued.has(a), links: this.userLinks.get(a) || [],
      family: fam && fam.list.length > 1 ? fam.list.map((x) => ({ address: x.address, symbol: x.symbol, name: x.name, state: x.state, aiCallers: x.stats?.aiCallers || 0, verdict: x.an?.review?.verdict || null, canDo: !!x.an?.review?.canDo, oneLine: x.an?.review?.oneLine || null })) : [],
      creatorOthers: c.an?.src?.deployer ? [...this.cands.values()].filter((o) => o.address !== a && o.an?.src?.deployer === c.an.src.deployer).map((o) => ({ address: o.address, symbol: o.symbol, name: o.name, verdict: o.an?.review?.verdict || null })) : [],
      calls: calls.length ? calls.map((e) => ({ t: e.t, from: e.from, name: names?.peek?.(e.from) || null, ai: this.ai.peek(e.from) === true, fn: fnBy[e.sel] || e.sel, value: e.value ? ethers.formatEther(BigInt(e.value)) : '0', hash: e.hash, got: (c.an?.calls || []).find((x) => x.hash === e.hash)?.got || null }))
        : (c.an?.calls || []).map((x) => ({ ...x, name: names?.peek?.(x.from) || null, ai: this.ai.peek(x.from) === true })),
      mints: this.part.forAddress(a),
      mintTx: sum.mintTx, nft: sum.nft, transfers: sum.transfers,
      priority: rec.priority, queuePos: !c.an ? Math.max(1, this.queue.indexOf(a) + 1) : null,
      rec: rec.rec, recAt: c.recAt || null,
      sendTo: this.trader?.settings?.sendTo || null,
      maxValueBnb: this.settings.maxValueBnb,
    };
  }
}

// 一句话介绍：项目自己的描述（中文）取第一句；没有就用用途 / 类型
function tagline(an) {
  if (!an) return null;
  const d = an.project?.descriptionZh || an.project?.description || an.noticeZh || '';
  const first = String(d).split(/(?<=[。！？!?])|\n|(?<=\.)\s/)[0].trim().replace(/^[-•*\s]+/, '');
  if (first && first.length >= 6) return first.length > 46 ? first.slice(0, 45) + '…' : first;
  return an.utility?.summary && !/没看到|未发现其他用途/.test(an.utility.summary) ? an.utility.summary : null;
}
// 英文界面用：项目自己的原文描述 / 合约说明取第一句（不用中文译文）；没有就留空，网页退回类型名
function taglineEn(an) {
  if (!an) return null;
  const d = an.project?.description || an.notice || '';
  const first = String(d).split(/(?<=[。！？!?])|\n|(?<=\.)\s/)[0].trim().replace(/^[-•*\s]+/, '');
  return first && first.length >= 6 ? (first.length > 90 ? first.slice(0, 89) + '…' : first) : null;
}
// 列表条目上不重复显示的加分项（这些已经在「免费 / .ai 参与」那一行里）
const HIDE_WHY = new Set(['rs.oneClick', 'rs.aiOnly', 'rs.aiLikely', 'rs.free', 'rs.heat']);
const shortWhy = (w) => String(w).replace(/^具备用途：/, '').replace(/，仍有余量$/, '').replace(/^管理员/, '').slice(0, 14);

const pick = (st) => ({ aiCallers: st.aiCallers, callers: st.callers, ratio: st.ratio, last10: st.last10, prev10: st.prev10, bars: st.bars, lastAiAt: st.lastAiAt, lastSeen: st.lastSeen });
