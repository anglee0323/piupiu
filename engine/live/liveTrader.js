// 实盘执行层：读币安 Agentic Wallet（baw）的地址和余额，用链上 Portal.quoteBuy / baw 报价和预演算出能成交多少。
// 默认不提交真实交易（订单状态 dry_run）。LIVE_TRADE=1 时，页面上手动点击的订单、以及本人启动的「真实下单」跟单任务（source 形如「跟单 任务名」）和 Gang 新盘狙击（狙击 Gang）才会真实上链；自动买/自动卖始终只报价。
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { PREAPPROVE, QUOTE_TOKENS, dataFile, EXPECT_WALLET, APP_MODE } from './config.js';
import { authBackoffMs } from './authBackoff.js';
import { setApprovalCtx, capFor, capLabel, sendApproval, listApprovals } from './approvals.js';
import { DRY_RUN, AUTH_SIMULATE_LOGGED_OUT, MAX_TRADE_BNB, LIVE_SETTINGS_FILE, BNB_NATIVE, BINANCE_CHAIN_ID, WALLET_LABEL, AUTO_TRANSFER_TO, AUTO_TRANSFER_FOUR } from './config.js';
const AT_FILE = dataFile('autoTransfer.json');
const RULE_FILE = dataFile('tokenRules.json');
import * as baw from './baw.js';
import { ethers } from 'ethers';
const POS_FILE = dataFile('positions.json');
import { readOrderHistory } from './orderHistory.js';
import * as walletSlots from './walletSlots.js';
import { Portal } from './portal.js';
import * as openFour from './openFour.js';
import { GangTrade } from './gangTrade.js';
import { GangV2 } from './gangV2Pads.js';
import { V3_TRADE } from './gangV3.js';
import { GangFly } from './gangFly.js';
import { FlapNft } from './flapNft.js';
import { Fees, feeFor, feeBnb } from './fees.js';
import { DexDirect } from './dexDirect.js';   // 本会话实现（3 个 pad）；gangV2.js 是另一个会话的版本，这里没用
import * as latency from './latency.js';
import { setQuoteLookup, USDT, ONDO_RE, viaUsdt, markViaUsdt } from './quoteRoutes.js';
import { translate } from '../../shared/i18n/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEND_TO0 = (() => { const v = loadSaved().sendTo; return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : AUTO_TRANSFER_TO; })();

// 钱包事件日志（data/wallet-events.log，追加，重启不丢）：登录 / 登出 / 掉线每一步都记时间，用来查「登录为什么失效」。不记任何凭据，只记槽位号 / 状态 / 地址缩写
const walletLog = (msg) => { const line = `${new Date().toISOString()} ${msg}`; console.log(`[钱包] ${msg}`); try { appendFileSync(dataFile('wallet-events.log'), line + '\n'); } catch { /* 写不了就只打控制台 */ } };
const sh0 = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : '-');

// baw wallet status 返回的连接状态 → 给用户看的中文（别把英文原始状态直接抛给用户）
const BAW_STATE_KEY = { UNCONNECTED: 'auth.unconnected', UNCONFIGURED: 'auth.unconfigured' };   // 登录状态说明的文案键（中文原文也从字典取）

export class LiveTrader extends EventEmitter {
  constructor(market) {
    super();
    this.market = market;
    // 订单日志：每笔订单到达结果（成交 / 失败 / 未知）时追加一行到 data/orders.jsonl（含每一步，比如「收到报价币…接着换回 BNB」），
    // 同时在控制台（live.log）打一行；启动时从日志恢复页面订单记录
    this.logged = new Map();
    this.on('order', (o) => {
      if (o.dryRun || !['filled', 'failed', 'unknown'].includes(o.status)) return;   // 只记真实订单
      if (o.status === 'filled' && o.feeable) this.chargeFee(o);   // 交易手续费（engine/live/fees.js）：成交才记应付，失败不收
      const key = `${o.status}|${o.reason || ''}`; if (this.logged.get(o.id) === key) return; this.logged.set(o.id, key);
      if (this.logged.size > 2000) this.logged = new Map([...this.logged].slice(-1000));
      const row = { at: new Date().toISOString(), id: o.id, ts: o.ts, amountIn: o.amountIn, wallet: o.wallet, symbol: o.symbol, token: o.token, side: o.side, amount: o.amount, source: o.source, status: o.status, route: o.route, venue: o.venue, out: o.out, tx: o.tx, txs: o.txs, reason: o.reason, feeBnb: o.feeBnb, steps: (o.steps || []).map((x) => x.name) };
      try { appendFileSync(dataFile('orders.jsonl'), JSON.stringify(row) + '\n'); } catch { /* 写不了就只打控制台 */ }
      console.log(`[订单] ${o.wallet || ''} ${o.side === 'buy' ? '买' : '卖'} ${o.symbol} ${o.status}${o.out != null ? ` 得 ${o.out}` : ''}${o.reason ? ' · ' + String(o.reason).slice(0, 160) : ''}`);
    });
    this.portal = new Portal(market.tradeProvider || market.provider, market.provider);   // 交易走 NodeReal 优先；领取前的模拟（定时扫描）走公共节点
    setApprovalCtx({ trader: this, market });
    setQuoteLookup((a) => this.quoteSet().has(String(a).toLowerCase()));   // 计价币兑换前的流动性检查只针对计价币（见 quoteRoutes.js）
    this.gangTrade = new GangTrade(market.tradeProvider || market.provider, (o) => this.portal.send(o));
    this.gangV2 = new GangV2(market.tradeProvider || market.provider, (o) => this.portal.send(o));
    this.gangFly = new GangFly(market.tradeProvider || market.provider, (o) => this.portal.send(o));   // 铸币飞轮：铸造 / 卖回 / 开盘后铸造 / 领奖励
    this.flapNft = new FlapNft(market.tradeProvider || market.provider, (o) => this.portal.send(o));   // Flap Portal Agent ID 门槛盘（登记表和行情共用 market.flapNft）
    this.flapNft.reg = market.flapNft?.reg || this.flapNft.reg;
    this.dex = new DexDirect(market.tradeProvider || market.provider, (o) => this.portal.send(o), this.gangV2);   // 刚发射、币安聚合还没收录新池子时直连 PancakeSwap V2
    this.wallets = [];
    // 多钱包（docs/PLAN-MULTI-WALLET.md）：一个后端进程里管理 N 个钱包槽位。
    // this.wallets 里是已登录的钱包（带 slot / profile）；positions 键仍是 `${钱包id}:${代币}`，
    // 钱包 1 的 id 沿用 'baw'（positions.json 老数据不用迁移），钱包 N 用 'w<N>'
    this.slotAuth = new Map(); this.slotLogin = new Map(); this.slotLock = new Map(); this.slotTimer = new Map();
    this.positions = new Map();
    this.orders = readOrderHistory(dataFile('orders.jsonl'));
    for (const o of this.orders) this.logged.set(o.id, `${o.status}|${o.reason || ''}`);
    this.quoteCache = new Map();
    this.settings = { gas: 'high', execPath: 'direct', multiRpc: false, autoClaim: loadSaved().autoClaim ?? true,
      // 领取后自动全部转到 AUTO_TRANSFER_TO：默认关，只能由本人在页面「设置」里打开（一次性同意），存 data/live-settings.json
      // 转出地址：页面「设置」里填的优先（存 data/live-settings.json），没有再用 .env 的 AUTO_TRANSFER_TO
      autoSendAfterClaim: !!SEND_TO0 && loadSaved().autoSendAfterClaim === true, sendTo: SEND_TO0,
      // NFT 转出地址（比如你自己的 OKX 钱包）：和上面的「自动转出代币」地址分开存，填一次保存在 data/live-settings.json，雷达 / 资产页一键转出直接用它
      nftSendTo: (() => { const v = loadSaved().nftSendTo; return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? v : ''; })(),
      autoSendFourMigrated: !!SEND_TO0 && loadSaved().autoSendFourMigrated === true,
      autoSendGangMigrated: !!SEND_TO0 && loadSaved().autoSendGangMigrated === true,
      qbPresets: loadSaved().qbPresets || null,
      sellToBnb: loadSaved().sellToBnb !== false,
      preApproveCap: loadSaved().preApproveCap !== false, walletOn: loadSaved().walletOn || {} };   /* 多钱包「参与下单」开关，重启后保留 */   // 预先授权（较大固定额度，用户可在页面关闭）；关掉 = 只授权本次数量   // 卖出后自动把报价币（BNCB / GANG / 币股…）换回 BNB，默认开，可在交易设置里关   // 一键买卖面板的预设金额 / 比例（页面上编辑，存 live-settings.json）   // Gang 发射（毕业）后自动转出，同样只能本人打开   // Four 发射后自动转出（同样只能本人在页面打开）
    this.claimable = []; this.claimRetry = new Map(); this.claiming = new Set(); this.inflight = new Set(); this.tokenQ = new Map(); this.dupAt = new Map();
    // 交易手续费：只在官方安装版（PIUPIU_APP=1）且允许真实下单时收；开发模式可用 PIUPIU_FEES=1 打开（自测用）
    this.fees = new Fees({
      enabled: !DRY_RUN && (APP_MODE || process.env.PIUPIU_FEES === '1'),
      // 先预检：需要在币安 App 里确认或有风险提示的，不发（发了会锁住钱包、挡住用户下一笔订单），先欠着
      send: (x) => baw.withSlot(x.slot, async () => {
        const pv = await baw.contractPreview({ from: x.address, to: x.to, valueWei: x.valueWei, inputData: x.inputData, slot: x.slot });
        if (pv.requireConfirmation || pv.risks) throw Object.assign(new Error(`付款需要在币安 App 中确认（${pv.riskTitles.join('；') || '风控提示'}），已暂缓`), { code: 'NEEDS_CONFIRM' });
        return this.portal.send({ wallet: x.address, to: x.to, valueWei: x.valueWei, inputData: x.inputData, label: '支付交易手续费', step: () => {} });
      }),
      busy: (slot) => {
        const w = this.wallets.find((x) => x.slot === slot);
        if (this.slotLock.get(slot)?.v === 'LOCKED') return true;
        return !!w && [...this.inflight, ...this.tokenQ.keys()].some((k) => String(k).startsWith(`${w.id}|`));
      },
      wallet: (slot) => { const w = this.wallets.find((x) => x.slot === slot); return w ? { address: w.address, bnb: w.bnb } : null; },
      log: (m) => console.log(`[手续费] ${m}`),
    });
    this.preapproving = new Set();
    this.on('order', (o) => { try { latency.record(o, { gasLevel: o.gas || this.settings.gas, rpc: this.market.provider?._getConnection?.().url || null }); } catch {} });
    this.status = { connected: false, error: null, dryRun: DRY_RUN, maxTradeBnb: loadMaxTrade(), auth: { state: 'checking', agentId: null, address: null, checkedAt: 0, message: '' }, login: null };
  }

  async init() {
    // 钱包槽位（data/wallets.json）：首次启动自动建 W1；每个槽位各自读地址 / 登录状态，互不影响
    for (const s of walletSlots.list()) this.slotAuth.set(s.slot, { state: 'checking', message: '', agentId: null, address: null, checkedAt: 0, fails: 0 });
    await Promise.all(walletSlots.list().map((s, i) => sleep(i * 800).then(() => this.initSlot(s.slot).catch(() => {}))));
    const anyOk = this.wallets.length > 0;
    this.status.connected = anyOk; this.status.error = anyOk ? null : (this.slotAuth.get(1)?.message || '没有已登录的钱包');
    clearInterval(this.balTimer); this.balTimer = setInterval(() => this.refreshBalance(), 20_000);
    await this.checkAllAuth().catch(() => {});
    clearInterval(this.authTimer); this.authTimer = setInterval(() => this.checkAllAuth().catch(() => {}), 10_000);   // 每 10 秒检查一次每个钱包的登录状态（baw wallet status，约 0.3 秒/个）
    clearInterval(this.lockTimer); this.lockTimer = setInterval(() => this.lockStatusAll().catch(() => {}), 5_000);   // 钱包锁状态后台每 5 秒刷新，下单时直接用
    clearInterval(this.claimTimer); this.claimTimer = setInterval(() => this.scanClaims(), 60_000); setTimeout(() => this.scanClaims(), 20_000);
    clearInterval(this.ruleTimer); this.ruleTimer = setInterval(() => this.ruleTick().catch((e) => console.error('tokenRule:', e.message)), 2_000);
  }

  // 某个槽位登录后读地址、建钱包对象（pin 校验：槽位记住第一次登录的地址，之后扫成别的账号就拒绝）
  async initSlot(slot) {
    const s = walletSlots.get(slot); if (!s) return;
    const st = this.slotAuth.get(slot) || this.slotAuth.set(slot, { state: 'checking', message: '', agentId: null, address: null, checkedAt: 0, fails: 0 }).get(slot);
    try {
      const addrs = await baw.walletAddresses({ slot });
      const bsc = addrs.find((a) => String(a.binanceChainId) === String(BINANCE_CHAIN_ID));
      if (!bsc?.address) throw Object.assign(new Error('未读取到钱包地址，请先登录币安钱包'), { notLogged: true });
      const lcA = String(bsc.address).toLowerCase();
      if (slot === 1 && EXPECT_WALLET && lcA !== EXPECT_WALLET) {
        this.dropWallet(slot); st.state = 'wrong_account'; st.message = `baw 登录的是 ${bsc.address.slice(0, 6)}…${bsc.address.slice(-4)}，不是这个后端的钱包 ${EXPECT_WALLET.slice(0, 6)}…${EXPECT_WALLET.slice(-4)}。请使用正确的币安账号重新登录`;
        throw new Error(st.message);
      }
      if (s.pinned && lcA !== s.pinned) {
        this.dropWallet(slot); st.state = 'wrong_account';
        const pin = s.pinned.slice(0, 6) + '…' + s.pinned.slice(-4);
        st.message = `W${slot} 绑定的是 ${pin}，这次登录的是 ${bsc.address.slice(0, 6)}…${bsc.address.slice(-4)}。如需更换钱包，请先在「钱包管理」中移除 W${slot}`;
        throw new Error(st.message);
      }
      if (!s.pinned) walletSlots.pin(slot, lcA);
      const w = { id: slot === 1 ? 'baw' : `w${slot}`, slot, label: s.label || (slot === 1 ? WALLET_LABEL : `钱包 ${slot}`), profile: walletSlots.profileOf(slot), address: bsc.address, bnb: 0, agentId: true, whitelisted: true, nonce: '—' };
      const i = this.wallets.findIndex((x) => x.slot === slot);
      if (i >= 0) this.wallets[i] = w; else this.wallets.push(w);
      this.syncAddrSlots();
      st.state = 'ok'; st.message = ''; st.address = bsc.address; st.fails = 0; st.checkedAt = Date.now();
      this.emit('wallets');
      await this.refreshBalance(slot);
      // .ai 名字：槽位没改过备注时拿它当默认名（GMGN 同款：钱包行显示名字）
      if (!s.label) baw.agentId({ slot }).then((id) => {
        if (id?.claimed && id.agentId) {
          st.agentId = id.agentId; this.market.names?.set(w.address, id.agentId);
          const cur = this.wallets.find((x) => x.slot === slot); const reg = walletSlots.get(slot);
          if (cur && !reg?.label) { cur.label = id.agentId; this.emit('wallets'); }
        }
      }).catch(() => {});
    } catch (e) {
      if (e.notLogged) { st.state = 'logged_out'; st.message = ''; this.dropWallet(slot); }
      else { st.state = 'error'; st.message = e.message; }
      st.checkedAt = Date.now();
      this.emit('wallets');
    }
  }
  dropWallet(slot) { const i = this.wallets.findIndex((x) => x.slot === slot); if (i >= 0) { this.wallets.splice(i, 1); this.syncAddrSlots(); this.emit('wallets'); } }
  syncAddrSlots() { baw.setAddressSlots(this.wallets.map((w) => [String(w.address).toLowerCase(), w.slot])); }
  primaryWallet() { const p = walletSlots.primary(); return this.wallets.find((w) => w.slot === p) || this.wallets[0]; }

  // 所有槽位的登录状态检查（每 10 秒）：偶发超时不算掉线，连续 2 次不正常才算
  async checkAllAuth() {
    // 连续失败的钱包按指数退避（authBackoff.js），不再每 10 秒都调 baw：读不到登录时（比如系统拦住了凭证读取）不至于一直重试
    const due = walletSlots.list().filter((s) => Date.now() >= (this.slotAuth.get(s.slot)?.nextAt || 0));
    await Promise.all(due.map((s, i) => sleep(i * 400).then(() => this.checkAuth(s.slot).catch(() => {}))));
    const p = this.slotAuth.get(walletSlots.primary()) || { state: 'error', message: '钱包不存在' };
    this.status.auth = { ...p, checkedAt: Date.now() };
    this.status.connected = this.wallets.length > 0;
    this.status.error = this.wallets.length ? null : p.message;
    return this.status.auth;
  }

  // 单个槽位的登录状态：baw wallet status（CONNECTED 才算已登录）。
  // 偶尔一次超时 / 网络错误不算掉线：连续 2 次不正常才改成未登录（页面才会挡住）；一次正常马上恢复
  async checkAuth(slot = 1) {
    const a = this.slotAuth.get(slot) || this.slotAuth.set(slot, { state: 'checking', message: '', agentId: null, address: null, checkedAt: 0, fails: 0 }).get(slot);
    let state, message = '', code = '', codeP = null;
    try {
      const st = await baw.walletStatus({ slot });
      state = st === 'CONNECTED' && !AUTH_SIMULATE_LOGGED_OUT ? 'ok' : 'logged_out';
      if (state !== 'ok') { code = AUTH_SIMULATE_LOGGED_OUT ? 'auth.simulated' : BAW_STATE_KEY[st] || 'auth.status'; codeP = code === 'auth.status' ? { st } : null; message = translate('zh', code, codeP); }
    } catch (e) {
      state = /找不到 baw/.test(e.message) ? 'missing' : /sign|auth|login|登录|401|unauthor/i.test(e.message) ? 'logged_out' : 'error';
      message = e.message;
    }
    const was = a.state;
    if (state === 'ok') a.fails = 0; else a.fails = (a.fails || 0) + 1;
    if (state === 'ok' && a.state === 'wrong_account') { /* 账号不对：保持锁定，等重新扫码 */ }
    else if (state === 'ok' || a.fails >= 2) { a.state = state; a.message = message; a.code = code; a.codeP = codeP; }
    else if (a.state === 'ok') { a.message = `本次检查失败，稍后将再次确认：${message}`; a.code = ''; }
    // 登录着突然掉线：币安同一个账号只保留最新的一次登录，别处（GMGN、AI Agent、另一台电脑）扫码就会把这里挤掉。说清楚，免得用户以为软件坏了
    if (was === 'ok' && a.state === 'logged_out') { a.code = 'auth.kicked'; a.codeP = null; a.message = translate('zh', a.code); }
    if (state !== 'ok' && a.fails === 1 && a.state === 'ok') setTimeout(() => this.checkAuth(slot), 3_000);   // 登录着的时候第一次失败 3 秒后马上再确认
    // 掉线（连续 2 次不正常）：下线这个钱包对象；重新登录后 initSlot 会再建
    if (a.state !== 'ok' && a.state !== 'checking' && a.state !== 'wrong_account' && this.wallets.some((w) => w.slot === slot)) {
      if (a.fails >= 2 || a.state === 'logged_out' || a.state === 'missing') this.dropWallet(slot);
    }
    // 在终端重新登录后：钱包对象还没建就重新初始化
    if (a.state === 'ok' && !this.wallets.some((w) => w.slot === slot) && !this.reIniting?.has?.(slot)) {
      (this.reIniting ||= new Set()).add(slot);
      this.initSlot(slot).catch(() => {}).finally(() => this.reIniting.delete(slot));
    }
    if (a.state === 'ok' && !a.agentId) { try { const id = await baw.agentId({ slot }); a.agentId = id.claimed ? id.agentId : null; if (a.agentId) { const w = this.wallets.find((x) => x.slot === slot); if (w) this.market.names?.set(w.address, a.agentId); } } catch { /* 域名拿不到不影响登录状态 */ } }
    a.address = this.wallets.find((w) => w.slot === slot)?.address || a.address;
    a.checkedAt = Date.now();
    a.nextAt = state === 'ok' ? 0 : a.checkedAt + authBackoffMs(a.fails);
    if (was !== a.state && was !== 'checking') walletLog(`W${slot} 登录状态 ${was} → ${a.state}（${sh0(a.address)}）${message ? ' ' + String(message).slice(0, 120) : ''}`);
    if (slot === walletSlots.primary()) this.status.auth = { ...a };
    this.emit('wallets');
    return a;
  }

  // 页面上点「登录」：baw auth signin 拿登录链接和配对码，后台跑 auth verify 等用户在币安 App 里确认。
  // 每个槽位各自一套；只允许未登录时发起（已登录再发起会换掉会话）；同一时间一个槽位只跑一个；
  // 5 分钟没确认就结束；可以取消。登录完成后核对地址：重复账号（已在别的槽位）/ 绑定不符 → 马上登出这个错的会话
  async startLogin(slot = 1) {
    slot = Number(slot);
    const s = walletSlots.get(slot); if (!s) throw new Error('钱包不存在');
    if (slot >= 2 || APP_MODE) { const sup = baw.profileSupport(); if (!sup.ok) throw new Error(`当前 baw ${sup.version || '?'} 尚未完成多钱包兼容性验证，暂不支持添加或登录其他钱包（已验证版本：1.11.0、1.12.0）`); }
    const cur = this.slotLogin.get(slot);
    if (cur?.state === 'waiting' && Date.now() < cur.expireAt) return cur;
    const st = this.slotAuth.get(slot);
    if (st?.state === 'ok') throw new Error('该钱包已登录');
    if (AUTH_SIMULATE_LOGGED_OUT) { const l = { state: 'failed', message: '调试模式：不会发起真实登录' }; this.slotLogin.set(slot, l); return l; }
    if (st?.state === 'wrong_account') { walletLog(`W${slot} 账号不对，先登出再登录`); try { await baw.authSignout({ slot }); } catch { /* 本来就没有会话 */ } }   // 现在登录的是错的账号：先清掉再登录
    walletLog(`W${slot} 发起扫码登录`);
    const d = await baw.authSignin({ slot });
    if (d.status === 'ALREADY_CONNECTED') { this.slotLogin.delete(slot); await this.initSlot(slot); await this.checkAuth(slot); return { state: 'done' };
    }
    const login = { id: Date.now(), slot, state: 'waiting', urlForWeb: d.urlForWeb, pairingCode: d.pairingCode, qrCodeId: d.qrCodeId, expireAt: Math.min(Number(d.expireAt) || Infinity, Date.now() + 300_000), message: '' };
    this.slotLogin.set(slot, login); this.emit('wallets');
    clearTimeout(this.slotTimer.get(slot)); this.slotTimer.set(slot, setTimeout(() => { if (login.state === 'waiting') { login.state = 'expired'; login.message = '5 分钟内未在币安 App 中确认，登录已结束'; try { login.child?.kill(); } catch { /* 已结束 */ } this.emit('wallets'); } }, Math.max(1000, login.expireAt - Date.now())));
    baw.authVerify(d.qrCodeId, (c) => { login.child = c; }, { slot })
      .then(async (r) => {
        if (login.state !== 'waiting') return;   // 已取消 / 已超时
        if (r.status !== 'SUCCESS') { login.state = 'failed'; login.message = r.status || ''; this.emit('wallets'); return; }
        await this.afterLogin(login);
      })
      .catch((e) => { if (login.state === 'waiting') { login.state = 'failed'; login.message = e.message; this.emit('wallets'); } })
      .finally(() => { clearTimeout(this.slotTimer.get(slot)); this.emit('wallets'); });
    return login;
  }
  // 登录成功后：读地址核对。重复 / 绑定不符就登出（不保存为可用），对了才初始化钱包
  async afterLogin(login) {
    const slot = login.slot;
    let addr = null; try { const addrs = await baw.walletAddresses({ slot }); addr = addrs.find((a) => String(a.binanceChainId) === String(BINANCE_CHAIN_ID))?.address || null; } catch (e) { login.state = 'failed'; login.message = `读取地址失败：${e.message}`; return; }
    const bad = async (msg) => {
      walletLog(`W${slot} 扫码后被拒绝，将登出这次会话（扫到的地址 ${sh0(addr)}）：${msg.slice(0, 100)}`);
      try { await baw.authSignout({ slot }); } catch (e) { console.error('signout after wrong account:', e.message); }
      login.state = 'wrong'; login.message = msg; login.address = addr; this.emit('wallets');
      await this.checkAuth(slot).catch(() => {});
    };
    const lcA = String(addr || '').toLowerCase();
    if (!addr) return bad('登录后未读取到地址，已退出本次登录，请重试');
    // 重复账号：这个地址已经是另一个槽位（别把同一个账号登两遍，下单会重复）
    const dup = walletSlots.byAddress(lcA);
    if (dup && dup.slot !== slot) {
      const dupName = this.slotAuth.get(dup.slot)?.agentId || `W${dup.slot}`;
      return bad(`这个账号已经是 W${dup.slot}（${dupName}），每个钱包须使用不同的币安账号。已自动退出本次登录`);
    }
    const s = walletSlots.get(slot);
    if (s.pinned && lcA !== s.pinned) {
      const pin = s.pinned.slice(0, 6) + '…' + s.pinned.slice(-4);
      return bad(`W${slot} 绑定的是 ${pin}，本次登录的是 ${addr.slice(0, 6)}…${addr.slice(-4)}。如需更换钱包，请先在「钱包管理」中移除 W${slot}。已自动退出本次登录`);
    }
    if (slot === 1 && EXPECT_WALLET && lcA !== EXPECT_WALLET) {
      return bad(`账号不符：本次登录的是 ${addr.slice(0, 6)}…${addr.slice(-4)}，该钱包应为 ${EXPECT_WALLET.slice(0, 6)}…${EXPECT_WALLET.slice(-4)}，已自动退出登录`);
    }
    if (!s.pinned) walletSlots.pin(slot, lcA);
    login.state = 'done'; login.address = addr;
    walletLog(`W${slot} 扫码登录成功 ${sh0(addr)}`);
    // 刚扫码成功时币安那边可能还在建钱包，状态会短暂不是 CONNECTED（UNCONFIGURED）：多确认几次再往下，别一次不对就当没登上
    for (let i = 0; i < 8; i++) {
      let st = null; try { st = await baw.walletStatus({ slot }); } catch { /* 继续等 */ }
      if (st === 'CONNECTED') break;
      if (i === 7) walletLog(`W${slot} 扫码后 20 秒钱包状态仍是 ${st || '读取失败'}`);
      else await new Promise((r) => setTimeout(r, 2500));
    }
    await this.initSlot(slot);
    await this.checkAuth(slot).catch(() => {});
    await this.syncHoldings().catch(() => {});
  }
  cancelLogin(slot = 1) {
    slot = Number(slot);
    const cur = this.slotLogin.get(slot); if (!cur || cur.state !== 'waiting') return cur || null;
    cur.state = 'cancelled'; cur.message = '已取消'; clearTimeout(this.slotTimer.get(slot));
    try { cur.child?.kill(); } catch { /* 已结束 */ }
    this.emit('wallets');
    return cur;
  }

  // 退出某个槽位的登录（槽位和绑定地址保留，可再扫码）；移除槽位见 removeWallet
  async logoutWallet(slot) {
    slot = Number(slot);
    this.cancelLogin(slot);
    walletLog(`W${slot} 手动退出登录（authSignout）`);
    try { await baw.authSignout({ slot }); } catch { /* 本来就没登录 */ }
    this.dropWallet(slot);
    const a = this.slotAuth.get(slot); if (a) { a.state = 'logged_out'; a.message = ''; a.code = ''; a.agentId = null; a.address = null; a.fails = 0; }
    await this.checkAllAuth().catch(() => {});
  }
  // 移除槽位：有持仓 / 在途订单时拒绝；同时把它从交易钱包选择里去掉
  async removeWallet(slot) {
    slot = Number(slot);
    const live = [...this.positions.values()].filter((p) => p.walletId === (slot === 1 ? 'baw' : `w${slot}`) && p.amount > 0);
    if (live.length) throw new Error(`W${slot} 还有 ${live.length} 个持仓，请先卖出或转出后再移除`);
    if (this.orders.some((o) => o.walletSlot === slot && ['pending'].includes(o.status))) throw new Error('该钱包有订单正在处理中，请稍后再移除');
    await this.logoutWallet(slot);
    walletSlots.remove(slot);
    const ts = this.tradeSlots().filter((x) => x !== slot);
    if (ts.length !== this.tradeSlots().length) this.setTradeSlots(ts);
    this.slotAuth.delete(slot); this.slotLogin.delete(slot); this.slotLock.delete(slot);
    await this.checkAllAuth().catch(() => {});
  }

  // 钱包锁状态缓存（每个槽位各自一份）：下单时用后台缓存（5 秒刷新一次），超过 30 秒没刷新就当场查；自己的订单进入「等 App 确认」时立刻标成已锁
  async lockStatus(force = false, slot = 1) {
    slot = Number(slot);
    const c = this.slotLock.get(slot);
    if (!force && c && Date.now() - c.at < 30_000) return c.v;
    const v = await baw.walletLock({ slot }).catch(() => 'UNKNOWN'); this.slotLock.set(slot, { v, at: Date.now() }); return v;
  }
  async lockStatusAll() { await Promise.all(walletSlots.list().map((s) => this.lockStatus(false, s.slot).catch(() => {}))); }

  // 余额：不传槽位 = 所有已登录钱包各自刷新（错开一点，别同时打满 baw）；传槽位 = 立刻刷这个钱包并等它完成
  async refreshBalance(slot = null) {
    if (slot != null) {
      const mine = this.wallets.find((w) => w.slot === Number(slot)); if (!mine) return;
      try {
        const rows = await baw.withSlot(mine.slot, () => baw.walletBalance({ slot: mine.slot }));
        const bnb = rows.find((r) => String(r.address || '').toLowerCase() === BNB_NATIVE.toLowerCase()) || rows.find((r) => String(r.symbol).toUpperCase() === 'BNB');
        mine.bnb = Number(bnb?.balance || 0);
        mine.tokens = Object.fromEntries(rows.filter((r) => r.address).map((r) => [String(r.address).toLowerCase(), Number(r.balance || 0)])); this.balAt = Date.now();
      } catch (e) { if (mine.slot === walletSlots.primary()) this.status.error = e.message; }
      this.syncHoldings().catch(() => {});
      return;
    }
    let i = 0;
    for (const mine of this.wallets) setTimeout(() => this.refreshBalance(mine.slot).catch(() => {}), i++ * 700);
  }

  // 「我的」持仓以链上为准（每个钱包各自读）：Flap 曲线读 sharesOf，其余读 baw 钱包余额；成本记录存 data/positions.json
  async syncHoldings() {
    if (!this.wallets.length || this.syncing || Date.now() - (this.syncAt || 0) < 55_000) return; this.syncing = true; this.syncAt = Date.now();
    try {
      if (!this.posLoaded) { this.posLoaded = true; try { for (const [k, p] of Object.entries(JSON.parse(readFileSync(POS_FILE, 'utf8')))) if (!this.positions.has(k)) this.positions.set(k, p); } catch { /* 没有文件 */ } }
      const toks = [...this.market.tokens.values()];
      await Promise.all(this.wallets.flatMap((w) => toks.map(async (t) => {
        let amt = null;
        if (t.source === 'agent-curve' && t.market && this.onCurve(t)) {
          try { amt = Number(ethers.formatEther(await this.portal.sharesOf(t.market, w.address))); } catch { return; }
        } else if (w.tokens) amt = w.tokens[t.address] || 0;
        if (amt == null) return;
        const k = `${w.id}:${t.address}`;
        if (amt > 0) { const p = this.pos(w.id, t.address); p.amount = amt; if (!p.openedAt) p.openedAt = Date.now(); }
        else if (this.positions.has(k)) this.positions.get(k).amount = 0;
      })));
      const o = {}; for (const [k, p] of this.positions) if (p.amount > 0 || p.boughtBnb) o[k] = p;
      try { mkdirSync(new URL('.', POS_FILE), { recursive: true }); writeFileSync(POS_FILE, JSON.stringify(o)); } catch { /* ignore */ }
    } finally { this.syncing = false; }
    this.autoTransferCheck().catch((e) => console.error('autoTransfer:', e.message));
  }

  /* ---------- 单币规则：发射后立刻领取，再（经本人确认后）把全部代币转到指定地址 ----------
     只对规则里的币生效，全局 AUTO_TRANSFER_FOUR 不受影响。存在 data/tokenRules.json，重启后继续。
     transfer: 'confirm'（等本人在页面上确认）| 'armed'（已确认，领取后自动转）| 'off'；转账只有 armed 才会执行 */
  rules() { if (!this._rules) { try { this._rules = JSON.parse(readFileSync(RULE_FILE, 'utf8')); } catch { this._rules = {}; } } return this._rules; }
  rulesSave() { try { mkdirSync(new URL('.', RULE_FILE), { recursive: true }); writeFileSync(RULE_FILE, JSON.stringify(this._rules, null, 1)); } catch { /* ignore */ } this.emit('rules', this.rulesView()); }
  rulesView() { return Object.fromEntries(Object.entries(this.rules()).map(([k, r]) => [k, { ...r }])); }
  setRule(token, patch) {
    const k = String(token || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(k)) throw new Error('代币地址无效');
    if (patch === null) { delete this.rules()[k]; this.rulesSave(); return this.rulesView(); }
    if (patch.to && String(patch.to).toLowerCase() !== String(this.settings.sendTo || '').toLowerCase()) throw new Error('转出地址与设置中的不一致');
    const t = this.market.get(k); const r = this.rules()[k] || { token: k, createdAt: Date.now(), claim: true, transfer: 'confirm', state: {} };
    Object.assign(r, { symbol: t?.symbol || r.symbol, market: t?.market || r.market, platform: t?.platform || r.platform }, patch);
    if (patch.transfer === 'armed') r.armedAt = Date.now();
    this.rules()[k] = r; this.rulesSave(); return this.rulesView();
  }
  // 授权管理：列出本程序授过的（代币, 合约）以及链上当前额度；撤销 = approve 0，只在本人点击时调用（当前只看主钱包）
  async allowancesView() {
    const w = this.primaryWallet(); const out = [];
    const i = new ethers.Interface(['function allowance(address,address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)']);
    const call = async (to, fn, args) => i.decodeFunctionResult(fn, await this.market.provider.call({ to, data: i.encodeFunctionData(fn, args) }))[0];
    for (const [token, sp] of Object.entries(listApprovals())) for (const [spender, v] of Object.entries(sp)) {
      try {
        const [al, dec, bal] = await Promise.all([call(token, 'allowance', [w.address, spender]), call(token, 'decimals', []).catch(() => 18n), call(token, 'balanceOf', [w.address]).catch(() => 0n)]);
        out.push({ token, spender, symbol: v.symbol || this.market.get(token)?.symbol || '', kind: v.kind, at: v.at, allowance: ethers.formatUnits(al, Number(dec)), balance: ethers.formatUnits(bal, Number(dec)), active: al > 0n });
      } catch { /* 读不到就跳过 */ }
    }
    return out.sort((a, b) => b.at - a.at);
  }
  async revokeApproval(token, spender) {
    const w = this.primaryWallet();
    if (!/^0x[0-9a-fA-F]{40}$/.test(token) || !/^0x[0-9a-fA-F]{40}$/.test(spender)) throw new Error('地址无效');
    if (!w || this.slotAuth.get(w.slot)?.state !== 'ok') throw new Error('币安钱包未登录');
    if ((await this.lockStatus(false, w.slot)) === 'LOCKED') throw new Error('钱包有交易正在等待币安 App 确认，请处理后再撤销');
    const order = { id: randomBytes(5).toString('hex'), ts: Date.now(), walletId: w.id, walletSlot: w.slot, wallet: w.label, token, symbol: this.market.get(token)?.symbol || '授权', side: 'approve', amount: 0, source: '手动', via: 'revoke', status: 'pending', steps: [], route: `撤销授权 → ${spender.slice(0, 6)}…${spender.slice(-4)}` };
    this.orders.unshift(order); this.emit('order', order);
    const step = (name, ms) => { order.steps.push({ name, ms: Math.round(ms), at: Date.now() - order.ts }); this.emit('order', order); };
    try { const h = await baw.withSlot(w.slot, () => this.portal.send({ wallet: w.address, to: token, inputData: new ethers.Interface(['function approve(address,uint256)']).encodeFunctionData('approve', [spender, 0n]), label: '撤销授权', step })); Object.assign(order, { status: 'filled', tx: h, latencyMs: Date.now() - order.ts }); }
    catch (e) { if (e.code === 'APP_CONFIRM') this.slotLock.set(w.slot, { v: 'LOCKED', at: Date.now() }); Object.assign(order, { status: 'failed', reason: e.message, latencyMs: Date.now() - order.ts }); }
    this.emit('order', order); return order;
  }

  // 持仓页「兑换」：BNB ⇄ 任意代币（baw market-order），只在本人点击时执行；走和普通下单一样的检查（当前主钱包）
  async tokenInfo(addr) {
    const w = this.primaryWallet(); const a = ethers.getAddress(addr);
    if (a.toLowerCase() === BNB_NATIVE.toLowerCase()) return { address: BNB_NATIVE, symbol: 'BNB', name: 'BNB', decimals: 18, balance: String(w?.bnb ?? 0) };
    const i = new ethers.Interface(['function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)']);
    const call = async (fn, args = []) => i.decodeFunctionResult(fn, await this.market.provider.call({ to: a, data: i.encodeFunctionData(fn, args) }))[0];
    let symbol, name, dec;
    try { [symbol, name, dec] = await Promise.all([call('symbol'), call('name').catch(() => ''), call('decimals')]); } catch { throw new Error('该地址不是 ERC20 代币'); }
    const bal = w ? await call('balanceOf', [w.address]).catch(() => 0n) : 0n;
    const t = this.market.get(a);
    return { address: a, symbol, name, decimals: Number(dec), balance: ethers.formatUnits(bal, Number(dec)), image: t?.image || null, priceUsd: t?.priceUsd || this.market.qUsd?.[a.toLowerCase()] || null };
  }
  async swapQuote({ from, to, amount, slippage = 1 }) {
    const q = await baw.marketQuote({ fromTokenQty: String(amount), fromToken: from, toToken: to, slippage, slot: this.primaryWallet()?.slot });
    const out = Number(q?.toCoinAmount || 0);
    return { out, minOut: out * (1 - slippage / 100), fromSymbol: q?.fromCoinSymbol, toSymbol: q?.toCoinSymbol, route: 'baw market-order（币安聚合路由）', slippage };
  }
  async swapManual({ from, to, amount, pct = null, slippage = 1, clientTs = null }) {
    const w = this.primaryWallet(); const fromBnb = from.toLowerCase() === BNB_NATIVE.toLowerCase();
    const order = { id: randomBytes(5).toString('hex'), ts: Date.now(), walletId: w?.id, walletSlot: w?.slot, wallet: w?.label || 'baw', token: fromBnb ? to : from, symbol: '?', platform: 'swap', side: fromBnb ? 'buy' : 'sell', amount: Number(amount) || pct || 0, slippage, source: '手动', via: '持仓兑换', status: 'pending', steps: [], dryRun: DRY_RUN, clientTs };
    this.orders.unshift(order); if (this.orders.length > 300) this.orders.length = 300; this.emit('order', order);
    const step = (name, ms, x) => { order.steps.push({ name, ms: Math.round(ms), at: Date.now() - order.ts }); this.emit('order', order); };
    const key = order.token.toLowerCase();
    try {
      if (!w) throw new Error('没有钱包');
      if (DRY_RUN) throw new Error('当前为演示模式，不会兑换');
      if (this.slotAuth.get(w.slot)?.state !== 'ok') throw new Error('币安钱包未登录，请先登录');
      const key = `${w.id}|${order.token.toLowerCase()}`;
      if (this.inflight.has(key)) throw Object.assign(new Error('该代币有订单正在处理中，请勿重复下单'), { code: 'BUSY' });
      if ((await this.lockStatus(false, w.slot)) === 'LOCKED') throw new Error('钱包有一笔交易正在等待你在币安 App 中确认或拒绝，处理前无法提交新订单（本次未发送交易）');
      order.preMs = Date.now() - order.ts; this.inflight.add(key);
      try {
        const [fi, ti] = await Promise.all([this.tokenInfo(from), this.tokenInfo(to)]);
        order.symbol = fromBnb ? ti.symbol : fi.symbol; order.route = `${fi.symbol}→${ti.symbol}`;
        let qty;
        if (fromBnb) {
          qty = Number(amount); if (!(qty > 0)) throw new Error('金额无效');
          const cap = this.status.maxTradeBnb; if (cap > 0 && qty > cap) throw new Error(`单笔上限 ${cap} BNB（可在交易设置中修改）`);
          if (!this.balAt || Date.now() - this.balAt > 30_000) await this.refreshBalance(w.slot);
          if (w.bnb && qty > w.bnb) throw new Error(`BNB 余额不足（${w.bnb.toFixed(4)}）`);
          qty = trim(qty);
        } else {
          // 卖出代币：从链上精确余额按整数算，向下取整；100% 用精确余额原样下单
          const ex = await this.exactBal(w, from);
          if (pct != null) qty = pct >= 100 ? ex.str : ethers.formatUnits((ex.raw * BigInt(Math.round(pct * 100))) / 10000n, ex.dec);
          else { const want = ethers.parseUnits(String(amount), ex.dec); qty = ethers.formatUnits(want > ex.raw ? ex.raw : want, ex.dec); }
          if (!(Number(qty) > 0)) throw new Error(`钱包中没有 ${fi.symbol}`);
        }
        step(`兑换 ${qty} ${fi.symbol} → ${ti.symbol}`, 0);
        const r = await baw.withSlot(w.slot, () => this.swapReal({ from, to, qty, slippage, step, label: `${fi.symbol}→${ti.symbol}` }));
        Object.assign(order, { status: 'filled', venue: r.venue, tx: r.txHash, txs: r.hashes, reason: r.note || null, amountIn: Number(qty), out: r.expected, latencyMs: Date.now() - order.ts });
      } finally { this.inflight.delete(`${w.id}|${order.token.toLowerCase()}`); }
      this.quoteCache.clear(); this.refreshBalance(); this.syncAt = 0; this.emit('order', order); return order;
    } catch (e) {
      if (['APP_CONFIRM', 'UNCONFIRMED', 'UNKNOWN_SUBMIT'].includes(e.code)) {
        if (e.code === 'APP_CONFIRM') this.slotLock.set(w?.slot || 1, { v: 'LOCKED', at: Date.now() });
        Object.assign(order, { status: 'pending', stage: 'unknown', reason: `已提交，正在确认，请勿重复下单：${e.message}`, latencyMs: Date.now() - order.ts });
        this.emit('order', order); this.followUp(order, e); return order;
      }
      Object.assign(order, { status: 'failed', reason: e.message, latencyMs: Date.now() - order.ts }); this.emit('order', order); return order;
    }
  }

  ruleLog(r, msg) { r.log = [...(r.log || []), { at: Date.now(), msg }].slice(-30); console.log(`[tokenRule] ${r.symbol} ${msg}`); }
  // 规则状态按钱包分开（每个钱包各自的领取 / 转出进度）。老数据（直接在 state 上的字段）第一次读到时归到钱包 1（id 'baw'）
  ruleWS(st, wid) {
    st.w ||= {};
    if (!st.w[wid] && (st.claimedAt != null || st.transferTx != null || st.sendNext != null || st.claimNext != null)) {
      if (wid === 'baw') st.w[wid] = { claimedAt: st.claimedAt, claimTx: st.claimTx, claimed: st.claimed, claimTries: st.claimTries, claimNext: st.claimNext, transferTx: st.transferTx, transferAt: st.transferAt, sent: st.sent, sendTries: st.sendTries, sendNext: st.sendNext, lastError: st.lastError, dryRunNoted: st.dryRunNoted };
      else st.w[wid] = {};
      delete st.claimedAt; delete st.claimTx; delete st.claimed; delete st.claimTries; delete st.claimNext; delete st.transferTx; delete st.transferAt; delete st.sent; delete st.sendTries; delete st.sendNext; delete st.lastError; delete st.dryRunNoted; delete st.done;
    }
    return (st.w[wid] ||= {});
  }
  async ruleTick() {
    if (this.ruleBusy) return; if (!this.wallets.length) return;
    const list = Object.values(this.rules()); if (!list.length) return;
    this.ruleBusy = true;
    try {
      for (const r of list) {
        const st = r.state ||= {};
        const t = this.market.get(r.token);
        for (const w of this.wallets) {
          const ws = this.ruleWS(st, w.id);
          const tag = this.wallets.length > 1 ? `W${w.slot} ` : '';
          // 1) 领取：Flap 曲线毕业后 Portal.claim 能模拟成功（之前会回滚）就立刻领取（每个钱包各自的份额各自领）
          if (r.claim && !ws.claimedAt && r.market && t?.source === 'agent-curve') {
            if (Date.now() < (ws.claimNext || 0) || this.claiming.has(`${w.id}:${r.market}`)) continue;
            let amt = 0n; try { amt = await this.portal.previewClaim(r.market, w.address); } catch { /* 还没毕业：模拟会回滚 */ }
            if (amt <= 0n) {
              ws.checkedAt = Date.now();
              // 已经被全局「自动领取」先领走了：毕业了、份额为 0、钱包里有代币 → 算领取完成
              if (t.stage === 'dex' && (w.tokens?.[r.token] || 0) > 0) { ws.claimedAt = Date.now(); this.ruleLog(r, `${tag}已由自动领取完成`); this.rulesSave(); }
              continue;
            }
            if (DRY_RUN || this.slotAuth.get(w.slot)?.state !== 'ok') { ws.claimNext = Date.now() + 10_000; this.ruleLog(r, `${tag}可以领取，但${DRY_RUN ? '当前是演示模式' : '币安钱包未登录'}`); this.rulesSave(); continue; }
            this.ruleLog(r, `${tag}已毕业，可领取 ${(Number(amt) / 1e18).toFixed(0)}，开始领取`); this.rulesSave();
            const o = await this.claimOne(r.market, '规则：发射后立刻领取', w);
            if (o.status === 'filled') { ws.claimedAt = Date.now(); ws.claimTx = o.tx; ws.claimed = o.out; this.ruleLog(r, `${tag}领取成功 ${o.tx}`); }
            else { ws.claimTries = (ws.claimTries || 0) + 1; ws.claimNext = Date.now() + [5_000, 15_000, 60_000, 300_000][Math.min(ws.claimTries, 4) - 1]; this.ruleLog(r, `${tag}领取未完成：${o.reason || o.status}`); }
            this.rulesSave(); continue;
          }
          // 2) 转账：只有本人确认过（armed）才执行；全部余额 → r.to（每个钱包转各自的）
          const ready = !r.claim || ws.claimedAt || t?.source !== 'agent-curve';
          if (!ready || r.transfer !== 'armed' || !r.to || ws.transferTx || ws.sendStopped) continue;
          if (Date.now() < (ws.sendNext || 0)) continue;
          if (t?.source !== 'agent-curve' && t?.stage !== 'dex') continue;   // 非 Flap 的币：等发射（迁移）后再转
          // 只报价模式（LIVE_TRADE=0）不转；地址被改过（不是 AUTO_TRANSFER_TO）也不转
          if (DRY_RUN) { ws.sendNext = Date.now() + 60_000; if (!ws.dryRunNoted) { ws.dryRunNoted = true; this.ruleLog(r, `${tag}可以转出，但当前是演示模式，不会转`); this.rulesSave(); } continue; }
          if (r.to.toLowerCase() !== String(this.settings.sendTo || '').toLowerCase()) { ws.sendNext = Date.now() + 300_000; this.ruleLog(r, `转出地址 ${r.to} 和设置里的转出地址不一致，已拒绝`); this.rulesSave(); continue; }
          const bal = Number((await baw.walletBalance({ tokenAddress: r.token, slot: w.slot }).catch(() => [])).find((x) => String(x.address || '').toLowerCase() === r.token)?.balance || 0);
          if (!(bal > 0)) { ws.sendNext = Date.now() + 5_000; continue; }   // 领取刚上链，余额可能还没更新
          if ((await baw.walletLock({ slot: w.slot }).catch(() => 'UNKNOWN')) === 'LOCKED') { ws.sendNext = Date.now() + 10_000; this.ruleLog(r, `${tag}钱包在等币安 App 确认，稍后再转`); this.rulesSave(); continue; }
          const short = r.to.slice(0, 6) + '…' + r.to.slice(-4);
          const order = { id: randomBytes(5).toString('hex'), ts: Date.now(), walletId: w.id, walletSlot: w.slot, wallet: w.label, token: r.token, symbol: r.symbol || '?', platform: r.platform, side: 'transfer', amountIn: bal, to: r.to, status: 'pending', steps: [], auto: true, source: '规则：领取后转出', route: `${tag}全部 ${r.symbol} → ${short}` };
          this.orders.unshift(order); this.emit('order', order);
          ws.sendTries = (ws.sendTries || 0) + 1; this.ruleLog(r, `${tag}转出 ${bal} → ${r.to}（第 ${ws.sendTries} 次）`);
          try {
            const d = await baw.sendMax({ tokenAddress: r.token, recipient: r.to, slot: w.slot });
            Object.assign(order, { status: 'filled', tx: d.txHash || d.hash || null, out: bal }); ws.transferTx = order.tx || 'submitted'; ws.transferAt = Date.now(); ws.sent = bal;
            this.ruleLog(r, `${tag}转出成功 ${order.tx || ''}`);
          } catch (e) {
            // 失败一次就停下并提醒，不自动重试（地址簿、风控这类错误重试没有用，反而刷出一串失败记录）。
            // 用户处理后，在设置里重新保存转出地址或重新打开自动转出开关即会再试一次（resumeAutoSend）
            Object.assign(order, { status: 'failed', reason: e.message, stopped: true }); ws.lastError = e.message; ws.sendStopped = true;
            this.ruleLog(r, `${tag}转出失败，已停止自动转出：${e.message}`);
          }
          this.rulesSave(); this.emit('order', order); this.emit('autoTransfer', { ...order, toShort: short }); this.refreshBalance();
        }
      }
    } finally { this.ruleBusy = false; }
  }

  // 自动转出失败后已停止的规则：用户在设置里重新保存转出地址或重新打开开关时，清掉停止标记，下一轮再试一次
  resumeAutoSend() {
    let n = 0;
    for (const r of Object.values(this.rules())) for (const ws of Object.values(r.state?.w || {})) if (ws?.sendStopped) { ws.sendStopped = false; ws.sendNext = 0; n++; }
    if (n) { this.rulesSave(); console.log(`[tokenRule] 已恢复 ${n} 个停止的自动转出`); }
    return n;
  }
  // Four 代币发射（curve→dex）后，把持仓全部转到 AUTO_TRANSFER_TO。done 记录在 data/autoTransfer.json，失败最多重试 3 次（退避 1/5/15 分钟）
  atState() { if (!this.at) { try { this.at = JSON.parse(readFileSync(AT_FILE, 'utf8')); } catch { this.at = {}; } } return this.at; }
  atSave() { try { mkdirSync(new URL('.', AT_FILE), { recursive: true }); writeFileSync(AT_FILE, JSON.stringify(this.at, null, 1)); } catch { /* ignore */ } }
  // Four 发射（内盘 → 外盘）后自动转出：页面「设置」里本人打开 autoSendFourMigrated（或环境变量 AUTO_TRANSFER_FOUR=1）才生效。
  // 只处理「打开后、看到从内盘变成已迁移」且当时钱包里有这个币的情况（迁移后才在外盘买的不转，启动后 3 分钟内的状态变化不算，避免把重启时补状态误当成发射）。
  // 认定后给这个币挂一条已确认的转出规则，由 ruleTick 负责转账：重试、等币安 App 确认、记录哈希、每个币只转一次
  async autoTransferCheck() {
    if (!this.wallets.length) return;
    // Four：autoSendFourMigrated（或环境变量 AUTO_TRANSFER_FOUR）；Gang（老盘和 V2 盘）：autoSendGangMigrated
    const onFor = this.settings.sendTo ? { four: AUTO_TRANSFER_FOUR || this.settings.autoSendFourMigrated, gang: this.settings.autoSendGangMigrated } : { four: false, gang: false };   // 没设目标地址就不转
    this.fourStage ||= new Map(); this.startedAt ||= Date.now();
    for (const t of this.market.tokens.values()) {
      if (t.platform !== 'four' && t.platform !== 'gang') continue;
      const prev = this.fourStage.get(t.address); this.fourStage.set(t.address, t.stage);
      if (!onFor[t.platform] || prev !== 'curve' || t.stage !== 'dex' || Date.now() - this.startedAt < 180_000) continue;
      if (!this.wallets.some((w) => (w.tokens?.[t.address] || 0) > 0) || this.rules()[t.address.toLowerCase()]) continue;   // 任一钱包持有就挂规则（转账时每个钱包转各自的）
      this.setRule(t.address, { claim: false, to: this.settings.sendTo, transfer: 'armed', auto: true, state: {} });
      this.ruleLog(this.rules()[t.address.toLowerCase()], `${t.platform === 'gang' ? 'Gang' : 'Four'} 已发射，按「${t.platform === 'gang' ? 'Gang' : 'Four'} 发射后自动转出」设置转出全部 ${t.symbol}`); this.rulesSave();
    }
  }

  wallet(id) { const w = this.wallets.find((x) => x.id === id) || this.wallets[0]; if (!w) throw new Error(this.status.error || '币安钱包未连接'); return w; }
  eligibility() { return { ok: true }; }       // 白名单以合约为准：不满足时 Portal / 聚合器预演会直接失败
  capLeft() { return Infinity; }
  pos(wid, token) {
    const k = `${wid}:${token}`;
    if (!this.positions.has(k)) this.positions.set(k, { walletId: wid, token, amount: 0, costBnb: 0, boughtBnb: 0, soldBnb: 0, peak: 0, openedAt: 0 });
    return this.positions.get(k);
  }

  // four.meme Agentic Wallet 专属盘在内盘阶段只能走 OpenFour Core（baw contract-call）；迁移后走 market-order
  // gang.fun 老盘（BNB 计价，合约 0x315B…）内盘：直接 buy/sell；V2 报价币盘还不支持
  // onCurve：行情说在内盘，且下单时没在链上发现已发射（checkMigrated 设的 t.migrated；行情接口常比链上晚几十秒）
  onCurve(t) { return t.stage === 'curve' && !t.migrated; }
  useGang(t) { return t.source === 'gang' && this.onCurve(t) && !['v2', 'v3', 'v3fair'].includes(t.gangTrack); }
  // gang.fun V2 报价币盘：先把 BNB 换成报价币再买，卖出后换回 BNB（非原子）
  // V3 系内盘（GangLaunchpad 1.0 / 2.0 / 金库版）也走这里：gangV2Pads 认出 V3 内盘后经官方网关买卖；V3 打新币走这里会报「不支持」
  useGangV2(t) { return t.source === 'gang' && this.onCurve(t) && ['v2', 'v3', 'v3fair'].includes(t.gangTrack); }
  // 铸币飞轮开盘前：买入 = 按份铸造（BNB 金额按每份价格向下取整），卖出 = 卖回份数；开盘后在池子里买卖走外盘，开盘后铸造另有入口（via = 'fly-post'）
  useGangFly(t) { return t.source === 'gang' && t.gangTrack === 'fly' && this.onCurve(t); }

  useOpenFour(t) { return t.source === 'four-agent' && this.onCurve(t); }
  // Flap 普通 Portal 的 Agent ID 门槛盘：内盘时直接调 Portal.swapExactInput（tx.origin 必须持有门槛 NFT；币安聚合不保证打到内盘）
  useFlapNft(t) { return t.source === 'flap-nft' && this.onCurve(t); }
  // 下单前的门槛检查：钱包没有门槛 NFT → 返回「跳过」原因（不发交易）；能交易 / 不是门槛盘 → null
  async nftBlock(t, w) { return this.useFlapNft(t) && w?.address ? this.flapNft.block(t.address, w.address).catch(() => null) : null; }

  usePortal(t, side) { return t.source === 'agent-curve' && t.market && this.onCurve(t) && (side === 'buy' || !DRY_RUN); }

  route(t, side) {
    if (this.useGangFly(t)) return side === 'buy' ? '铸币飞轮 · 开盘前按份铸造（BNB，一笔完成；金额按每份价格向下取整）' : '铸币飞轮 · 卖回开盘前的份数（按铸造价退回，扣退出费）';
    if (this.useGang(t)) return `Gang 内盘 · ${side === 'buy' ? 'buy' : 'sell'}（BNB，一笔完成）· baw contract-call（每个钱包最多买总量 1%）`;
    if (this.useGangV2(t) && t.gangTrack !== 'v2') return t.gangTrack === 'v3fair' ? 'Gang V3 打新币 · 暂不支持' : `Gang 内盘 · 官方网关 · ${side === 'buy' ? (/^W?BNB$/i.test(t.quote || '') ? 'BNB→buy（一笔完成）' : `BNB→${t.quote}→buy`) : (/^W?BNB$/i.test(t.quote || '') ? 'sell→BNB（一笔完成，另需一次授权）' : `sell→${t.quote}→BNB`)}${V3_TRADE ? '' : ' · 只报价（GANG_V3_TRADE=0）'}`;
    if (this.useGangV2(t)) return side === 'buy' ? `Gang V2 内盘 · BNB→${t.quote}→buy（非原子，2～3 笔交易）· 每个钱包最多 1%` : `Gang V2 内盘 · sell→${t.quote}→BNB（非原子，2～3 笔交易）`;
    if (this.useFlapNft(t)) return `Flap 内盘（${t.nftGate?.removed ? '门槛已取消' : `${t.nftGate?.name || 'NFT'} 门槛`}）· Portal.swapExactInput ${side === 'buy' ? 'BNB→代币' : '代币→BNB'} · baw contract-call（每个地址最多买总量 2%）`;
    if (this.useOpenFour(t)) return `Four Agent 专属内盘 · OpenFour Core.${side} · baw contract-call（每个钱包最多买总量 1%）`;
    if (this.usePortal(t, side) && side === 'sell') return `Flap Agent Curve · Portal.sell${t.quote === 'BNB' ? '' : ` → ${t.quote} → BNB`}`;
    if (this.usePortal(t, side)) return `Flap Agent Curve · ${t.quote === 'BNB' ? 'Portal.buy（BNB，原子）' : `BNB→${t.quote}→Portal.buyWithQuote（非原子）`}`;
    return `币安 Web3 DEX 聚合 · baw market-order ${side === 'buy' ? 'BNB→代币' : '代币→BNB'}${t.platform === 'four' && this.onCurve(t) ? '（可能打不到内盘）' : ''}（聚合没收录新池子时直连 PancakeSwap V2）`;
  }

  // 链上确认是否已发射（迁移）到 PancakeSwap：Gang V2 看曲线的 graduated；其他平台看 PancakeSwap V2 上有没有带储备的池子。
  // 只在内盘报价 / 下单失败后调用。确认了就记 t.migrated 并把状态改成外盘，后面的报价、下单直接走外盘
  async checkMigrated(t) {
    const yes = t.source === 'gang' && (t.gangTrack === 'v2' || t.gangTrack === 'v3') ? !!(await this.gangV2.curve(t.address)).c.graduated
      : t.source === 'flap-nft' ? (await this.flapNft.state(t.address)).status === 4 : !!(await this.dex.pool(t.address, t.quoteAddress));
    if (yes && !t.migrated) { t.migrated = true; t.stage = 'dex'; t.progress = 100; this.quoteCache.clear(); this.market.emit('migrate', this.market.summary(t)); }
    return yes;
  }

  // 外盘买卖：先走币安 DEX 聚合（baw market-order）；聚合没成交（刚迁移还没收录新池子、报不出价，或订单失败）就直连 PancakeSwap V2。
  // 已提交但结果未知（要在 App 确认 / 未确认）的不再重下
  async dexTrade({ t, w, side, qty, pct, slippage, step }) {
    try {
      return side === 'buy' ? await this.swapReal({ from: BNB_NATIVE, to: t.address, qty, slippage, step, label: `BNB→${t.symbol}` })
        : await this.swapReal({ from: t.address, to: BNB_NATIVE, qty, slippage, step, label: `${t.symbol}→BNB` });
    } catch (e) {
      if (['APP_CONFIRM', 'UNCONFIRMED', 'UNKNOWN_SUBMIT'].includes(e.code) || /insufficient|余额不足|仍在处理/i.test(e.message)) throw e;
      if (!(await this.dex.pool(t.address, t.quoteAddress).catch(() => null))) throw e;
      step(`币安聚合没成交（${String(e.message).slice(0, 80)}），改为直连 PancakeSwap V2`, 0);
      return side === 'buy' ? this.dex.buy({ wallet: w.address, token: t.address, quoteAddress: t.quoteAddress, amountBnb: trim(qty), slippage, step, taxPct: t.buyTax || 0 })
        : this.dex.sell({ wallet: w.address, token: t.address, quoteAddress: t.quoteAddress, pct, slippage, step, toBnb: this.settings.sellToBnb, taxPct: t.sellTax || 0 });
    }
  }

  // 链上精确余额（字符串，按代币精度原样给出，不经过浮点数）。以前用 Number 转一次再写成 18 位小数，
  // 尾数会被舍入得比实际余额大一点点（例如 0.931044697706272163 变成 …184），卖 100% 时 baw 报「余额不足」
  async exactBal(w, token) {
    const i = new ethers.Interface(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)']);
    const call = async (fn, args) => i.decodeFunctionResult(fn, await (this.market.tradeProvider || this.market.provider).call({ to: token, data: i.encodeFunctionData(fn, args) }))[0];
    const [raw, dec] = await Promise.all([call('balanceOf', [w.address]), call('decimals', []).catch(() => 18n)]);
    return { raw, dec: Number(dec), str: ethers.formatUnits(raw, Number(dec)) };
  }

  async tokenBal(w, token) {
    const k = `bal:${w.id}:${token}`; const c = this.quoteCache.get(k);
    if (c && Date.now() - c.at < 8000) return c.v;
    const rows = await baw.walletBalance({ tokenAddress: token, slot: w.slot });
    const v = Number((rows.find((r) => String(r.address || '').toLowerCase() === token) || rows[0])?.balance || 0);
    this.quoteCache.set(k, { v, at: Date.now() }); return v;
  }

  async preview({ walletId, token, side, amount, slippage }, again = false) {
    const t = this.market.get(token); if (!t) return null;
    const base = { route: this.route(t, side) };
    if (!(Number(amount) > 0) || !this.wallets.length) return base;
    const key = [walletId, token, side, amount, slippage].join('|'); const c = this.quoteCache.get(key);
    if (c && Date.now() - c.at < 4000) return c.v;
    try {
      const w = this.wallet(walletId);
      let v;
      if (side === 'buy' && this.usePortal(t, side) && t.quote === 'BNB') {
        const { ethers } = await import('ethers');
        const q = await this.portal.quoteBuy(t.market, w.address, ethers.parseEther(String(amount)));
        const out = +ethers.formatEther(q.shares);
        v = { ...base, amountIn: +amount, out, minOut: out * (1 - slippage / 100), feeBnb: +ethers.formatEther(q.fee), feePct: (+ethers.formatEther(q.fee) / amount) * 100 };
      } else if (side === 'buy' && t.source === 'agent-curve' && t.market && this.onCurve(t)) {
        // 非 BNB 底池：BNB→报价币用 baw 报价，再用 Portal.quoteBuy 算份额
        const { ethers } = await import('ethers');
        const sq = await baw.marketQuote({ fromTokenQty: trim(amount), fromToken: BNB_NATIVE, toToken: t.quoteAddress, slippage });
        const quoteOut = Number(sq?.toCoinAmount || 0);
        const q = await this.portal.quoteBuy(t.market, w.address, ethers.parseUnits(quoteOut.toFixed(12), 18));
        const out = +ethers.formatEther(q.shares);
        v = { ...base, amountIn: +amount, out, minOut: out * (1 - slippage / 100), quoteOut, feeQuote: +ethers.formatEther(q.fee), feePct: quoteOut ? (+ethers.formatEther(q.fee) / quoteOut) * 100 : null };
      } else if (this.useFlapNft(t)) {
        const nb = await this.nftBlock(t, w);
        if (side === 'buy') {
          const q = await this.flapNft.quoteBuy(t.address, w.address, trim(amount)); const out = +ethers.formatEther(q.out);
          const qa = await this.flapNft.quota(t.address, w.address).catch(() => null);
          v = { ...base, amountIn: +amount, out, minOut: out * (1 - slippage / 100), feeBnb: null, feePct: this.market.buyFeePct(t), note: nb || (qa?.capped && qa.remaining === 0n ? '已到每个地址 2% 上限' : null), nftBlocked: !!nb };
        } else {
          const bal = await this.flapNft.balance(t.address, w.address); const amt = (bal * BigInt(Math.round(Math.min(100, Number(amount)) * 100))) / 10000n;
          if (amt <= 0n) return { ...base, note: '没有可卖出的余额' };
          const out = +ethers.formatEther(await this.flapNft.quoteSell(t.address, w.address, amt));
          v = { ...base, amountIn: +ethers.formatEther(amt), out, minOut: out * (1 - slippage / 100), feeBnb: null, feePct: null, note: nb, nftBlocked: !!nb };
        }
      } else if (this.useGangFly(t)) {
        const { ethers } = await import('ethers');
        if (side === 'buy') {
          const q = await this.gangFly.previewMint({ token: t.address, wallet: w.address, amountBnb: trim(amount), fly: t.gangFly });
          v = q.shares ? { ...base, amountIn: Number(ethers.formatEther(q.spend)), out: q.tokens, minOut: q.tokens, feeBnb: Number(ethers.formatEther(q.fee)), feePct: t.gangFly.mintFeePct, note: `铸造 ${q.accepted} 份（剩余额度 ${q.quotaLeft} 份），实际花费 ${ethers.formatEther(q.spend)} BNB` } : { ...base, note: q.note };
        } else {
          const q = await this.gangFly.previewWithdraw({ token: t.address, wallet: w.address, pct: Math.min(100, Number(amount)) });
          v = q.shares ? { ...base, amountIn: q.shares, out: Number(ethers.formatEther(q.payout)), minOut: Number(ethers.formatEther(q.payout)), feeBnb: Number(ethers.formatEther(q.fee)), feePct: t.gangFly.exitFeeNowPct, note: `卖回 ${q.shares} / ${q.have} 份` } : { ...base, note: q.note };
        }
      } else if (this.useGangV2(t)) {
        const { ethers } = await import('ethers');
        if (side === 'buy') {
          const q = await this.gangV2.preview({ token: t.address, wallet: w.address, amountBnb: trim(amount) });
          v = { ...base, amountIn: +amount, out: q.out, minOut: q.out * (1 - slippage / 100), feeBnb: +amount * 0.01, feePct: 1, note: q.refund > 0n ? '接近 1% 上限，多余的报价币会退回' : null };
        } else {
          const bal = await this.gangV2.balanceOf(t.address, w.address); const amt = (bal * BigInt(Math.round(Math.min(100, Number(amount)) * 100))) / 10000n;
          if (amt <= 0n) return { ...base, note: '没有可卖出的余额' };
          const { c } = await this.gangV2.curve(t.address); this.gangV2.notGraduated(c); const r = this.gangV2.sellQuote(c, amt);
          v = { ...base, amountIn: Number(ethers.formatEther(amt)), out: Number(ethers.formatEther(r.out)), minOut: Number(ethers.formatEther(r.out)) * (1 - slippage / 100), feeBnb: null, feePct: 1, note: `卖出得到 ${t.quote}，再换回 BNB` };
        }
      } else if (this.useGang(t)) {
        if (side === 'buy') {
          const q = await this.gangTrade.quoteBuy(t.address, w.address, trim(amount));
          v = { ...base, amountIn: +amount, out: q.out, minOut: q.out * (1 - slippage / 100), feeBnb: q.feeBnb, feePct: (q.feeBnb / amount) * 100,
            note: q.refund > 0n ? `接近 1% 上限，只花 ${(Number(amount) - q.refundBnb).toFixed(4)} BNB，多余的同笔退回` : q.tokensOut === 0n ? '已到 1% 上限' : null };
        } else {
          const bal = await this.gangTrade.balance(t.address, w.address);
          const amt = (bal * BigInt(Math.round(Math.min(100, Number(amount)) * 100))) / 10000n;
          if (amt <= 0n) return { ...base, note: '没有可卖出的余额' };
          const q = await this.gangTrade.quoteSell(t.address, amt);
          v = { ...base, amountIn: Number(amt) / 1e18, out: q.out, minOut: q.out * (1 - slippage / 100), feeBnb: q.feeBnb, feePct: null };
        }
      } else if (this.useOpenFour(t)) {
        // 官方脚本报价（含 1% 持仓上限、链上模拟）
        const bps = Math.round(slippage * 100);
        if (side === 'buy') {
          const q = await openFour.quoteBuy(t.address, w.address, trim(amount), bps);
          const out = Number(q.estimate.tokenAmount), fee = Number(q.estimate.totalFee);
          v = { ...base, amountIn: +amount, out, minOut: Number(q.minTokenOut), feeBnb: fee, feePct: (fee / amount) * 100,
            note: q.estimate.budgetNotFullyUsed ? '已到 1% 持仓上限附近，只会花掉部分 BNB，多余的同笔退回' : q.simulation?.ok === false ? `预演失败：${q.simulation.error?.reason || ''}` : null };
        } else {
          const bal = await this.tokenBal(w, token); const qty = bal * Number(amount) / 100;
          if (!(qty > 0)) return { ...base, note: '没有可卖出的余额' };
          const q = await openFour.quoteSell(t.address, w.address, Number(amount) >= 100 ? 'all' : trim(qty), bps);
          v = { ...base, amountIn: qty, out: Number(q.estimate.userReceives), minOut: Number(q.minReceive), feeBnb: Number(q.estimate.totalFee), feePct: null };
        }
      } else {
        const qty = side === 'buy' ? Number(amount) : (await this.tokenBal(w, token)) * Number(amount) / 100;
        if (!(qty > 0)) return { ...base, note: '没有可卖出的余额' };
        let q = null, err = null;
        try { q = await baw.marketQuote({ fromTokenQty: trim(qty), fromToken: side === 'buy' ? BNB_NATIVE : token, toToken: side === 'buy' ? token : BNB_NATIVE, slippage }); } catch (e) { err = e; }
        let out = Number(q?.toCoinAmount || 0), route = base.route;
        if (!(out > 0)) {   // 币安聚合报不出价（刚迁移、还没收录新池子）：用 PancakeSwap V2 链上报价，下单时也会直连
          const sellQty = side === 'sell' ? await this.exactBal(w, t.address).then((x) => ethers.formatUnits((x.raw * BigInt(Math.round(Math.min(100, Number(amount)) * 100))) / 10000n, x.dec)).catch(() => trim(qty)) : null;
          const d = await this.dex.quote({ token: t.address, quoteAddress: t.quoteAddress, side, amount: side === 'buy' ? qty : sellQty, taxPct: (side === 'buy' ? t.buyTax : t.sellTax) || 0 }).catch(() => null);
          if (!d) { if (err) throw err; } else { out = d.out; route = `PancakeSwap V2 直连 · ${side === 'buy' ? (d.pool.isBnb ? 'BNB→代币' : 'BNB→报价币→代币') : (d.pool.isBnb ? '代币→BNB' : '代币→报价币→BNB')}（币安聚合还没收录这个池子）`; }
        }
        v = { ...base, route, amountIn: qty, out, minOut: out * (1 - slippage / 100), feeBnb: null, feePct: this.market.buyFeePct(t) };
      }
      if (side === 'buy' && !DRY_RUN) {   // BNB 不够时报价就说明会用哪个币付款
        const f = await this.fundingPlan(w, t, Number(amount)).catch(() => null); if (f) v = { ...v, fund: { mode: f.mode, symbol: f.symbol || null, qty: f.qty || null, note: f.note } }; }
      this.quoteCache.set(key, { v, at: Date.now() });
      return v;
    } catch (e) {
      // 内盘报价失败：可能刚发射到外盘、行情还没跟上。链上确认后按外盘重新报价一次
      if (!again && (e.code === 'MIGRATED' || t.stage === 'curve') && await this.checkMigrated(t).catch(() => false)) return this.preview({ walletId, token, side, amount, slippage }, true);
      return { ...base, error: e.message };
    }
  }

  async execute({ walletId, token, side, amount, slippage = 20, source = '手动', via = null, clientTs = null, symbol = null, batchId = null, mev = null, gas = null }) {
    const t = this.market.get(token);
    // 代号：本后端还没读到（钱包 2 刚收录的盘常这样）就用页面传来的，再没有就当场读链上 symbol()，读到后更新这笔订单
    const sym = t?.symbol && t.symbol !== '?' ? t.symbol : symbol || '?';
    const w0 = this.wallets.find((x) => x.id === walletId);
    const order = { id: randomBytes(5).toString('hex'), ts: Date.now(), walletId, walletSlot: w0?.slot, wallet: w0?.label || 'baw', token, symbol: sym, platform: t?.platform, batchId,
      side, amount: Number(amount), slippage, source, via, status: 'pending', steps: [], dryRun: DRY_RUN || !isRealSource(source), clientTs };
    order.feeable = !order.dryRun;   // 真实买卖才收手续费（领取、转出、授权不经过 execute）
    order.gas = ['normal', 'high', 'turbo'].includes(gas) ? gas : null;   // Gas 档位：页面按预设传；没传（狙击 / 跟单 / 条件单）用 HIGH
    order.mev = typeof mev === 'boolean' ? mev : !/狙击/.test(String(source));   // 防夹：页面按预设传；没传时狙击默认关（抢速度），其他默认开
    this.orders.unshift(order); if (this.orders.length > 300) this.orders.length = 300;
    this.emit('order', order);
    if (sym === '?' && /^0x[0-9a-fA-F]{40}$/.test(String(token))) this.market.provider.call({ to: token, data: '0x95d89b41' }).then((r) => {
      const v = ethers.AbiCoder.defaultAbiCoder().decode(['string'], r)[0]; if (!v) return;
      if (order.symbol === '?') { order.symbol = v; this.emit('order', order); }
      if (t && (!t.symbol || t.symbol === '?')) t.symbol = v;
    }).catch(() => {});
    // 每一步记两个时间：ms = 这一步自己的耗时（各模块原来的口径），at = 从服务器收到订单起累计的时间（统一时间线）
    const step = (name, ms, x) => { order.steps.push({ name, ms: Math.round(ms), at: Date.now() - order.ts }); if (x?.tx) { order.pendingTx = x.tx; order.stage = x.stage || 'broadcast'; } this.emit('order', order); };
    try {
      if (!t) throw new Error('代币不在列表中');
      const w = this.wallet(walletId);
      order.route = this.route(t, side); order.wallet = w.label; order.walletSlot = w.slot;
      // Agent ID 门槛盘：这个钱包没有门槛 NFT 就跳过（狙击 / 跟单 / 一键买都一样，不算失败、不发交易）。和钱包锁检查同时查，省一次往返
      const [nb, lock] = await Promise.all([this.nftBlock(t, w), order.dryRun ? null : this.lockStatus(false, w.slot)]);
      if (nb) { Object.assign(order, { status: 'failed', skipped: true, reason: nb, latencyMs: Date.now() - order.ts }); this.emit('order', order); return order; }

      if (!order.dryRun) {
        // 只拦真正的重复下单（同钱包、同币、同方向、同金额 / 比例，前一单还没结束且在 5 秒内）；
        // 其他同币订单（比如先卖 25% 再卖 50%）排队等前一单结束（确认或失败）再执行，避免同一钱包并发发交易，也不报错。
        // 不同钱包互不排队（多钱包一起买就是并行的）
        const tk = `${w.id}|${t.address.toLowerCase()}`, dupKey = `${tk}|${side}|${Number(amount)}`, prevDup = this.dupAt.get(dupKey);
        if (prevDup === 'wait') throw Object.assign(new Error('该订单正在等待币安 App 确认授权，确认后将自动继续卖出，无需重复操作'), { code: 'BUSY' });
        if (prevDup && Date.now() - prevDup < 5_000) throw Object.assign(new Error('相同订单（同一代币、方向和比例）正在处理中，本次未重复下单'), { code: 'BUSY' });
        if (lock === 'LOCKED') throw new Error('钱包有一笔交易正在等待你在币安 App 中确认或拒绝，处理前无法提交新订单（本次未发送交易）');
        const prev = this.tokenQ.get(tk), at = Date.now(); this.dupAt.set(dupKey, at);
        let release; const mine = new Promise((r) => { release = r; }); this.tokenQ.set(tk, mine);
        try {
          if (prev) { await prev; step('等待该代币的上一笔订单完成', Date.now() - at); }
          while (this.inflight.has(`${w.id}|${t.address}`) || this.inflight.has(tk)) await new Promise((r) => setTimeout(r, 200));   // 持仓兑换 / 计价币换回在跑同一个币
          this.inflight.add(`${w.id}|${t.address}`); order.preMs = Date.now() - order.ts;   // 下单前检查（钱包锁、在途）耗时
          return await baw.withSlot(w.slot, () => baw.withMev(order.mev, () => baw.withGas(order.gas, () => this.executeReal(order, t, w, step))));
        } finally {
          this.inflight.delete(`${w.id}|${t.address}`); release();
          if (this.tokenQ.get(tk) === mine) this.tokenQ.delete(tk);
          if (this.dupAt.get(dupKey) === at) this.dupAt.delete(dupKey);
        }
      }
      if (side === 'buy') {
        const amt = Number(amount); if (!(amt > 0)) throw new Error('金额无效');
        let r;
        if (this.useFlapNft(t)) {
          r = await baw.withSlot(w.slot, () => this.flapNft.previewBuy({ wallet: w.address, token: t.address, amountBnb: trim(amt), step }));
        } else if (side === 'buy' && t.source === 'agent-curve' && t.market && this.onCurve(t)) {
          r = await baw.withSlot(w.slot, () => this.portal.previewBuy({ wallet: w.address, market: t.market, quoteAddress: t.quoteAddress, amountBnb: trim(amt), slippage, step }));
        } else {
          r = await baw.withSlot(w.slot, () => this.swap({ w, from: BNB_NATIVE, to: t.address, qty: amt, slippage, step }));
        }
        return this.finish(order, r, null, { amountIn: amt, out: r.expected });
      }
      const bal = await this.tokenBal(w, t.address);
      const qty = bal * Math.min(100, Number(amount)) / 100;
      step(`查询余额 ${trim(bal)}`, 0);
      if (!(qty > 0)) throw new Error('没有可卖出的余额');
      if (this.useFlapNft(t)) {   // 只报价：Portal.quoteExactInput（from = 钱包）
        const ex = await this.exactBal(w, t.address); const raw = (ex.raw * BigInt(Math.round(Math.min(100, Number(amount)) * 100))) / 10000n;
        const out = +ethers.formatEther(await this.flapNft.quoteSell(t.address, w.address, raw));
        return this.finish(order, { dryRun: true, venue: 'Flap Portal.swapExactInput（Agent ID 门槛，未上链）', expected: out }, null, { amountIn: qty, out });
      }
      const r = await baw.withSlot(w.slot, () => this.swap({ w, from: t.address, to: BNB_NATIVE, qty, slippage, step }));
      return this.finish(order, r, null, { amountIn: qty, out: r.expected });
    } catch (e) {
      // 已经提交 / 广播但结果未知：标「待确认」并继续盯，不报失败，避免重复下单
      if (['APP_CONFIRM', 'UNCONFIRMED', 'UNKNOWN_SUBMIT'].includes(e.code)) {
        if (e.code === 'APP_CONFIRM') this.slotLock.set(w0?.slot || 1, { v: 'LOCKED', at: Date.now() });
        // 卖出前的授权要在币安 App 里确认（或已发出还没确认）：以前确认后这笔就结束了（「App 里的确认已处理」），要再点一次卖出。
        // 现在确认后查链上额度，够了就在同一笔订单里接着卖出；额度没变（App 里拒绝了）就不卖
        const ap = side === 'sell' && t && !e.afterConfirm ? e.approval : null;
        if (ap) { e.afterLabel = '授权确认后继续卖出…'; e.afterConfirm = () => this.sellAfterApproval(order, e, t, walletId, step); }
        Object.assign(order, { status: 'pending', stage: 'unknown', reason: ap ? `卖出前需要授权，请在币安 App 中确认，确认后将自动继续卖出（无需重复操作）：${e.message}` : `已提交，正在确认，请勿重复下单：${e.message}`, latencyMs: Date.now() - order.ts });
        this.emit('order', order);
        const fu = this.followUp(order, e);
        if (ap) { const dk = `${order.walletId}|${t.address.toLowerCase()}|${side}|${Number(amount)}`; this.dupAt.set(dk, 'wait'); fu.finally(() => { if (this.dupAt.get(dk) === 'wait') this.dupAt.delete(dk); }); }
        return order;
      }
      // 卖出时这个钱包没有这个币：灰色「无余额」提示，不算失败（多钱包一起卖时常见：另一个钱包没买到）
      if (side === 'sell' && /没有可卖出的余额|（实际 0 个）/.test(e.message)) Object.assign(order, { status: 'failed', skipped: true, noBalance: true, reason: '无余额：该钱包未持有此代币，已跳过（未发送交易）', latencyMs: Date.now() - order.ts });
      else Object.assign(order, { status: 'failed', reason: e.message, latencyMs: Date.now() - order.ts });
      this.emit('order', order);
      return order;
    }
  }

  // 计价币余额：钱包里作为别的盘报价币的 BNCB / GANG / NVDAB / WBNB 等（Flap、Gang V2 买卖中间换出来的），按 baw 实时余额列出（主钱包）
  quoteSet() { return new Set([...Object.values(QUOTE_TOKENS), ...Object.keys(this.market.qUsd || {})].map((a) => a.toLowerCase())); }
  async quoteBalances() {
    const slot = this.primaryWallet()?.slot;
    const rows = await baw.walletBalance({ slot }); const set = this.quoteSet(); const bnbUsd = this.market.bnbUsd || 0;
    return rows.filter((r) => r.address && set.has(String(r.address).toLowerCase()) && Number(r.balance) > 0).map((r) => {
      const usd = Number(r.value || 0) || Number(r.balance) * (this.market.qUsd?.[String(r.address).toLowerCase()] || 0);
      return { token: r.address, symbol: r.symbol, balance: r.balance, priceUsd: Number(r.price || 0) || null, valueUsd: usd, valueBnb: bnbUsd ? usd / bnbUsd : null, wbnb: String(r.address).toLowerCase() === QUOTE_TOKENS.WBNB.toLowerCase() };
    }).sort((a, b) => b.valueUsd - a.valueUsd);
  }

  // BNB 不够时用钱包里的计价币付款。只做规划，不发交易：
  // 这个盘的报价币本身就够（Gang V2 / Flap 报价币盘）→ 直接用它买，省掉 BNB→报价币那一步；
  // 否则挑价值最高、够用的计价币（BNCB / GANG / USDT / FXIon …）先换出差额 BNB 再按原来的路线买
  async fundingPlan(w, t, amt) {
    if (!(amt > 0)) return null;
    const bnb = w.bnb || 0;
    // 计价币盘（Gang V2 / Flap 非 BNB 盘）：先看钱包里有没有这个盘的报价币。
    // 实际怎么付由 gangV2Pads.buy / portal.buy 决定（够就直接用，不够只换差额），这里只算出来给报价和确认框显示
    const qa = t.quoteAddress && (this.useGangV2(t) || (this.usePortal(t, 'buy') && String(t.quoteAddress).toLowerCase() !== QUOTE_TOKENS.WBNB.toLowerCase())) ? t.quoteAddress : null;
    if (qa) {
      const [raw, rate, dec] = await Promise.all([this.gangV2.balanceOf(qa, w.address), this.gangV2.quoteRate(qa, { stale: 30_000 }), this.gangV2.decimals(qa)]).catch(() => [0n, 0, 18]);
      const n = Number(ethers.formatUnits(raw, dec)), sym = t.quote || '报价币';
      if (n > 0 && rate > 0) {
        const vb = n / rate;
        if (vb >= amt) return { mode: 'direct', token: qa, symbol: sym, qty: amt * rate, bnb, note: `直接用钱包里现有的约 ${fmtQ(amt * rate)} ${sym} 付款（共有 ${fmtQ(n)}），无需使用 BNB 兑换` };
        if (bnb >= (amt - vb) * 1.05 + FUND_GAS) return { mode: 'mixed', token: qa, symbol: sym, qty: n, bnb, note: `先用钱包里现有的 ${fmtQ(n)} ${sym}（约 ${vb.toFixed(4)} BNB），差额约 ${(amt - vb).toFixed(4)} BNB 换成 ${sym}` };
      }
    }
    if (bnb >= amt + FUND_GAS) return null;
    const bnbUsd = this.market.bnbUsd || 0; if (!bnbUsd) return null;
    const set = this.quoteSet(); set.add(USDT.toLowerCase());
    const held = (await baw.walletBalance({ slot: w.slot })).filter((r) => r.address && set.has(String(r.address).toLowerCase()) && Number(r.balance) > 0).map((r) => {
      const k = String(r.address).toLowerCase(), usd = Number(r.value || 0) || Number(r.balance) * (this.market.qUsd?.[k] || 0);
      return { token: r.address, symbol: r.symbol, balance: Number(r.balance), valueBnb: usd / bnbUsd, wbnb: k === QUOTE_TOKENS.WBNB.toLowerCase() };
    }).filter((x) => x.valueBnb > 0);
    const q = (this.useGangV2(t) || this.usePortal(t, 'buy')) && t.quoteAddress ? String(t.quoteAddress).toLowerCase() : null;
    const own = q && held.find((x) => x.token.toLowerCase() === q);
    if (own && !own.wbnb && own.valueBnb >= amt * 1.02) return { mode: 'direct', token: own.token, symbol: own.symbol, qty: own.balance * amt / own.valueBnb, bnb: w.bnb || 0, note: `BNB 余额不足（${(w.bnb || 0).toFixed(4)}），改用钱包中约 ${fmtQ(own.balance * amt / own.valueBnb)} ${own.symbol} 付款` };
    const need = (amt + FUND_GAS - (w.bnb || 0)) * 1.05;   // 多换 5%：兑换滑点 + 手续费
    const pick = held.filter((x) => !x.wbnb && x.valueBnb >= need).sort((a, b) => b.valueBnb - a.valueBnb)[0];
    if (!pick) return { mode: 'none', bnb: w.bnb || 0, note: `BNB 余额不足（${(w.bnb || 0).toFixed(4)}），钱包中也没有足够兑换 ${need.toFixed(4)} BNB 的计价代币` };
    const qty = Math.floor(pick.balance * need / pick.valueBnb * 1e8) / 1e8;
    return { mode: 'swap', token: pick.token, symbol: pick.symbol, qty, needBnb: need, bnb: w.bnb || 0, note: `BNB 余额不足（${(w.bnb || 0).toFixed(4)}），先用约 ${fmtQ(qty)} ${pick.symbol} 换出 ${need.toFixed(4)} BNB 后买入（需额外 1～2 笔交易）` };
  }

  async quoteBal(token, opts) { const r = (await baw.walletBalance({ tokenAddress: token, ...opts })).find((x) => String(x.address || '').toLowerCase() === token.toLowerCase()); return { balance: Number(r?.balance || 0), symbol: r?.symbol || '?' }; }

  // 换回 BNB 前的报价（按此刻余额，主钱包）：WBNB 解包 1:1；其他走 baw market-order quote
  async quoteToBnbPreview(token, slippage = 1) {
    const slot = this.primaryWallet()?.slot;
    if (!this.quoteSet().has(String(token).toLowerCase())) throw new Error('不是计价币');
    const { balance, symbol } = await this.quoteBal(token, { slot }); if (!(balance > 0)) throw new Error(`钱包中没有 ${symbol}`);
    if (token.toLowerCase() === QUOTE_TOKENS.WBNB.toLowerCase()) return { token, symbol, balance, out: balance, minOut: balance, route: 'WBNB 换回 BNB（1:1，仅需网络费用）', slippage: 0 };
    const two = async () => {   // Ondo 类：报价两步，代币→USDT→BNB
      const a = await baw.marketQuote({ fromTokenQty: trim(balance), fromToken: token, toToken: USDT, slippage, slot });
      return baw.marketQuote({ fromTokenQty: trim(Number(a?.toCoinAmount || 0)), fromToken: USDT, toToken: BNB_NATIVE, slippage, slot });
    };
    let q, via = viaUsdt(token);
    if (via) q = await two();
    else try { q = await baw.marketQuote({ fromTokenQty: trim(balance), fromToken: token, toToken: BNB_NATIVE, slippage, slot }); }
    catch (e) { if (!ONDO_RE.test(e.message)) throw e; markViaUsdt(token); via = true; q = await two(); }
    const out = Number(q?.toCoinAmount || 0); const mid = (this.market.qUsd?.[token.toLowerCase()] || 0) * balance / (this.market.bnbUsd || 1);
    return { token, symbol, balance, out, minOut: out * (1 - slippage / 100), route: via ? `baw market-order：${symbol}→USDT→BNB（Ondo 类只能和稳定币直接换，两笔）` : 'baw market-order（币安聚合路由）', slippage, midBnb: mid || null };
  }

  // 一键把某个计价币全部换回 BNB（主钱包）：点击这一刻读余额；登录、钱包锁、同币在途检查和普通订单一样；已提交但结果未知按「待确认」跟踪
  async quoteToBnb({ token, slippage = 1 }) {
    const w = this.primaryWallet();
    const order = { id: randomBytes(5).toString('hex'), ts: Date.now(), walletId: w?.id, walletSlot: w?.slot, wallet: w?.label || 'baw', token, symbol: '?', platform: 'quote',
      side: 'sell', amount: 100, slippage, source: '手动', via: '计价币换回 BNB', status: 'pending', steps: [], dryRun: false };
    this.orders.unshift(order); if (this.orders.length > 300) this.orders.length = 300;
    const step = (name, ms, x) => { order.steps.push({ name, ms: Math.round(ms) }); if (x?.tx) { order.pendingTx = x.tx; order.stage = x.stage || 'broadcast'; } this.emit('order', order); };
    const key = `${w?.id || 'baw'}|${String(token).toLowerCase()}`;
    try {
      if (!w) throw new Error('没有钱包');
      if (!this.quoteSet().has(String(token).toLowerCase())) throw new Error('不是计价币');
      if (DRY_RUN) throw new Error('当前为演示模式，不会发送交易');
      if (this.slotAuth.get(w.slot)?.state !== 'ok') throw new Error('币安钱包未登录，请先登录');
      if (this.inflight.has(key)) throw Object.assign(new Error('该代币有订单正在处理中，请勿重复下单'), { code: 'BUSY' });
      if ((await baw.walletLock({ slot: w.slot }).catch(() => 'UNKNOWN')) === 'LOCKED') throw new Error('钱包有一笔交易正在等待你在币安 App 中确认或拒绝，处理前无法提交新订单（本次未发送交易）');
      this.inflight.add(key);
      try {
        const { symbol } = await this.quoteBal(token, { slot: w.slot }); const ex = await this.exactBal(w, token); const balance = Number(ex.str); order.symbol = symbol; order.route = `${symbol}→BNB`;
        if (!(balance > 0)) throw new Error(`钱包中没有 ${symbol}`);
        step(`当前余额 ${ex.str} ${symbol}（链上精确值）`, 0);
        let r;
        if (token.toLowerCase() === QUOTE_TOKENS.WBNB.toLowerCase()) {
          const bal = await (this.market.tradeProvider || this.market.provider).call({ to: token, data: new ethers.Interface(['function balanceOf(address) view returns (uint256)']).encodeFunctionData('balanceOf', [w.address]) }).then((x) => BigInt(x));
          const hash = await this.portal.send({ wallet: w.address, to: token, inputData: new ethers.Interface(['function withdraw(uint256)']).encodeFunctionData('withdraw', [bal]), label: 'WBNB→BNB 解包', step });
          r = { venue: 'WBNB.withdraw', expected: Number(ethers.formatEther(bal)), txHash: hash, hashes: [hash] };
        } else r = await baw.withSlot(w.slot, () => this.swapReal({ from: token, to: BNB_NATIVE, qty: ex.str, slippage, step, label: `${symbol}→BNB` }));
        Object.assign(order, { status: 'filled', venue: r.venue, tx: r.txHash, txs: r.hashes, reason: r.note || null, amountIn: balance, out: r.expected, latencyMs: Date.now() - order.ts });
      } finally { this.inflight.delete(key); }
      this.quoteCache.clear(); this.refreshBalance(); this.syncAt = 0;
      this.emit('order', order);
      return order;
    } catch (e) {
      if (['APP_CONFIRM', 'UNCONFIRMED', 'UNKNOWN_SUBMIT'].includes(e.code)) {
        Object.assign(order, { status: 'pending', stage: 'unknown', reason: `已提交，正在确认，请勿重复下单：${e.message}`, latencyMs: Date.now() - order.ts });
        this.emit('order', order); this.followUp(order, e); return order;
      }
      Object.assign(order, { status: 'failed', reason: e.message, latencyMs: Date.now() - order.ts });
      this.emit('order', order); return order;
    }
  }

  // 授权确认后接着卖出（同一笔订单）：先等链上额度够（最多约 30 秒），再按当时余额 / 比例重新走一遍卖出
  async sellAfterApproval(order, e, t, walletId, step) {
    const a = e.approval, prov = this.market.tradeProvider || this.market.provider;
    const I = new ethers.Interface(['function allowance(address,address) view returns (uint256)']);
    let ok = false;
    for (let i = 0; i < 15 && !ok; i++) {
      try { ok = BigInt(await prov.call({ to: a.token, data: I.encodeFunctionData('allowance', [a.wallet, a.spender]) })) >= a.amount; } catch { /* 下一次 */ }
      if (!ok) await sleep(2000);
    }
    if (!ok) return { done: true, status: 'failed', reason: '授权未生效（可能已在币安 App 中拒绝），未卖出' };
    step('授权已生效，继续卖出', 0);
    Object.assign(order, { status: 'pending', stage: null, reason: '授权已确认，正在卖出…' }); this.emit('order', order);
    try { await baw.withSlot(order.walletSlot || 1, () => this.executeReal(order, t, this.wallet(walletId), step)); return { handedOff: true }; }
    catch (x) {
      if (['APP_CONFIRM', 'UNCONFIRMED', 'UNKNOWN_SUBMIT'].includes(x.code)) {   // 卖出那笔也要在 App 里确认：照常继续跟踪
        if (x.code === 'APP_CONFIRM') this.slotLock.set(order.walletSlot || 1, { v: 'LOCKED', at: Date.now() });
        Object.assign(order, { status: 'pending', stage: 'unknown', reason: `已提交，正在确认，请勿重复下单：${x.message}`, latencyMs: Date.now() - order.ts }); this.emit('order', order);
        this.followUp(order, x); return { handedOff: true };
      }
      return { done: true, status: 'failed', reason: `授权已确认，但卖出失败：${x.message}` };
    }
  }

  // 待确认订单的后续：有 txHash 就等回执（最多 10 分钟）；在等 App 确认的，等钱包解锁后再看结果。
  // 换回 BNB 等后续步骤也在这笔订单的钱包上下文里跑（baw 调用才不会用错钱包）
  async followUp(order, e) {
    return baw.withSlot(order.walletSlot || 1, () => this.followUpInner(order, e));
  }
  async followUpInner(order, e) {
    const end = Date.now() + 10 * 60_000;
    const fin = (status, reason, tx) => { Object.assign(order, { status, reason, tx: tx || order.tx, stage: null }); this.quoteCache.clear(); this.refreshBalance(); this.syncAt = 0; this.emit('order', order); };
    // 卖出那笔确认后，接着把到账的报价币换回 BNB（e.afterConfirm 由 Gang V2 / Portal 卖出挂上）
    const done = async (status, reason, tx) => {
      if (!e.afterConfirm || status === 'failed') return fin(status, reason, tx);
      Object.assign(order, { reason: `${reason}；${e.afterLabel || '正在将计价代币换回 BNB…'}` }); this.emit('order', order);
      const log = (name, ms = 0) => { order.steps.push({ name, ms: Math.round(ms), at: Date.now() - order.ts }); this.emit('order', order); };
      try {
        const r = await e.afterConfirm(log);
        if (r?.handedOff) return;   // 授权后接着卖出：那一笔自己会更新订单
        if (r?.done) return fin(r.status, r.reason, tx);
        if (r.hashes?.length) order.txs = [...(order.txs || []), ...r.hashes];
        if (r.expected) { order.out = r.expected; return fin('filled', `已卖出并换回 ${trim(r.expected)} BNB${r.note ? '；' + r.note : ''}`, tx); }
        return fin(status, `${reason}；${r.note || '未换回 BNB'}`, tx);
      } catch (x) { return fin(status, `${reason}；换回 BNB 失败：${x.message}，计价代币保留在钱包中（可在资产页「计价币余额」中换回）`, tx); }
    };
    // 只认这一步自己的 txHash：order.pendingTx 可能是前面授权那笔（已上链），拿它判断会把还在等 App 确认的卖出误标成「已成交」
    if (e.tx) {
      const tx = e.tx;
      while (Date.now() < end) { const rc = await (this.market.tradeProvider || this.market.provider).getTransactionReceipt(tx).catch(() => null); if (rc) return done(rc.status === 1 ? 'filled' : 'failed', rc.status === 1 ? '已上链确认' : `链上执行失败：${tx}`, tx); await sleep(3000); }
      return done('unknown', `10 分钟内未确认，请在钱包记录中查看：${tx}`, tx);
    }
    while (Date.now() < end) { if ((await baw.walletLock({ slot: order.walletSlot || 1 }).catch(() => 'UNKNOWN')) !== 'LOCKED') break; await sleep(10_000); }
    return done('unknown', e.code === 'APP_CONFIRM' ? '币安 App 中的确认已处理（同意或拒绝），结果请查看持仓或钱包记录' : '结果未知，请先在持仓或钱包记录中查看，勿直接重新下单');
  }

  // 真实下单（只由手动订单进入）。曲线阶段的 Flap Agent 盘走 Portal；其余走 baw market-order。
  /** 成交后记手续费应付：买入用下单前扣出的数；卖出按实际换回的 BNB 算（不足 0.00002 BNB 不收；没换回 BNB 的不收） */
  chargeFee(o) {
    if (!this.fees.enabled || o.feeBnb != null) return;
    const w = this.wallets.find((x) => x.slot === o.walletSlot);
    const feeW = o.side === 'buy' ? BigInt(o.feeWei || 0) : feeFor(o.out || o.feeBaseBnb || 0);
    if (feeW <= 0n) return;
    const got = this.fees.accrue({ id: o.id, slot: o.walletSlot, address: w?.address, side: o.side, symbol: o.symbol, baseBnb: o.side === 'buy' ? (o.amountIn ?? o.amount) : (o.out || o.feeBaseBnb), feeWei: feeW });
    if (got > 0n) o.feeBnb = feeBnb(got);
  }

  // 内盘下单失败时看看是不是刚发射到外盘（行情还没跟上）：链上确认后改走外盘重下一次。
  // 只在内盘那条路没有发出过买卖交易时重下（授权不算）；已提交 / 结果未知的不重下
  async executeReal(order, t, w, step) {
    const curve = this.onCurve(t), n0 = order.steps.length;
    try { return await this.executeRoute(order, t, w, step); }
    catch (e) {
      if (!curve || ['APP_CONFIRM', 'UNCONFIRMED', 'UNKNOWN_SUBMIT'].includes(e.code)) throw e;
      if (e.code !== 'MIGRATED' && order.steps.slice(n0).some((s) => /已提交|已广播|已上链/.test(s.name) && !/授权/.test(s.name))) throw e;
      if (!(await this.checkMigrated(t).catch(() => false))) throw e;
      step(`这个盘已发射到 PancakeSwap（内盘：${String(e.message).slice(0, 60)}），改走外盘`, 0);
      order.route = this.route(t, order.side);
      return this.executeRoute(order, t, w, step);
    }
  }

  async executeRoute(order, t, w, step) {
    const { side, slippage } = order;
    const p = this.pos(w.id, t.address);
    let r;
    if (side === 'buy') {
      const gross = order.amount;
      if (!(gross > 0)) throw new Error('金额无效');
      if (this.slotAuth.get(w.slot)?.state !== 'ok') throw new Error('币安钱包未登录，请点击右上角登录');
      const cap = this.status.maxTradeBnb;
      if (cap > 0 && gross > cap) throw new Error(`单笔上限 ${cap} BNB（可在交易设置中修改）`);
      // 交易手续费 0.5%：从买入金额里扣出（买 0.1 = 0.0995 去买 + 0.0005 手续费），成交后由 fees.js 在钱包空闲时付掉；没成交不收
      const feeW = order.feeable ? this.fees.buyFee(gross) : 0n;
      const amt = feeW > 0n ? Number(ethers.formatEther(ethers.parseEther(gross.toFixed(18)) - feeW)) : gross;
      if (feeW > 0n) { order.feeWei = feeW.toString(); step(`交易手续费 ${trim(feeBnb(feeW))} BNB（0.5%），实际买入 ${trim(amt)} BNB`, 0); }
      // BNB 余额用后台每 20 秒刷新的缓存；超过 30 秒没刷新才当场查（只查这个钱包）
      if (!this.balAt || Date.now() - this.balAt > 30_000) { const t0 = Date.now(); await this.refreshBalance(w.slot); step('检查 BNB 余额（baw）', Date.now() - t0); }
      let payQuote = null;
      // Gang V2 的 WBNB 盘：钱包里已有够用的 WBNB 就直接用（只发 buy 一笔，狙击要快），BNB 只要够 gas
      const wbnbReady = this.useGangV2(t) && String(t.quoteAddress || '').toLowerCase() === QUOTE_TOKENS.WBNB.toLowerCase() && (w.tokens?.[QUOTE_TOKENS.WBNB.toLowerCase()] || 0) >= amt && (w.bnb || 0) >= 0.0005;
      if (!wbnbReady && (w.bnb || 0) < gross + FUND_GAS) {
        const f = await this.fundingPlan(w, t, gross);
        if (!f || f.mode === 'none') throw new Error(f?.note || `BNB 余额不足（${(w.bnb || 0).toFixed(4)}）`);
        if ((w.bnb || 0) < 0.0005) throw new Error(`BNB 只剩 ${(w.bnb || 0).toFixed(5)}，不足以支付网络费用，无法使用 ${f.symbol} 付款`);
        order.fund = { mode: f.mode, symbol: f.symbol, token: f.token, qty: f.qty }; step(f.note, 0);
        if (f.mode === 'direct') payQuote = f.qty;
        else if (f.mode === 'mixed') { /* 买入时先用钱包里的报价币，差额用 BNB 换（gangV2Pads.buy / portal.buy 里做） */ }
        else {
          await this.swapReal({ from: f.token, to: BNB_NATIVE, qty: trim(f.qty), slippage: 2, step, label: `${f.symbol}→BNB（补足买入 BNB）` });
          await this.refreshBalance(w.slot);
          if ((w.bnb || 0) < gross) throw new Error(`已用 ${f.symbol} 换出 BNB，但余额 ${(w.bnb || 0).toFixed(4)} 仍不足 ${gross}，未买入（换出的 BNB 保留在钱包中）`);
        }
      }
      r = order.via === 'fly-post' ? await this.flyPostMint({ t, w, amt, slippage, step })
        : this.useGangFly(t) ? await this.gangFly.mint({ wallet: w.address, token: t.address, amountBnb: trim(amt), step, fly: t.gangFly })
        : this.useGangV2(t) ? await this.gangV2.buy({ wallet: w.address, token: t.address, amountBnb: trim(amt), slippage, step, payQuote })
        : this.useGang(t) ? await this.gangTrade.buy({ wallet: w.address, token: t.address, amountBnb: trim(amt), slippage, step })
        : this.useOpenFour(t) ? await this.openFourBuy({ w, t, amt, slippage, step })
        : this.useFlapNft(t) ? await this.flapNft.buy({ wallet: w.address, token: t.address, amountBnb: trim(amt), slippage, step })
        : this.usePortal(t, 'buy')
        ? await this.portal.buy({ wallet: w.address, market: t.market, quoteAddress: t.quoteAddress, quoteSym: t.quote, amountBnb: trim(amt), slippage, step, payQuote, quoteRate: t.quoteAddress ? await this.gangV2.quoteRate(t.quoteAddress, { stale: 30_000 }).catch(() => null) : null })
        : await this.dexTrade({ t, w, side: 'buy', qty: amt, slippage, step });
      if (!p.openedAt) p.openedAt = Date.now();
      p.boughtBnb += gross; p.costBnb += gross; p.amount += r.expected || 0;   // 成本含手续费
      Object.assign(order, { amountIn: gross, out: r.expected });
    } else {
      const pct = Math.min(100, order.amount);
      if (this.slotAuth.get(w.slot)?.state !== 'ok') throw new Error('币安钱包未登录，请点击右上角登录');
      if (this.useGangFly(t)) {
        r = await this.gangFly.withdraw({ wallet: w.address, token: t.address, pct, step, toBnb: this.settings.sellToBnb });
      } else if (this.useGangV2(t)) {
        r = await this.gangV2.sell({ wallet: w.address, token: t.address, pct, slippage, step, toBnb: this.settings.sellToBnb });
      } else if (this.useGang(t)) {
        r = await this.gangTrade.sell({ wallet: w.address, token: t.address, pct, slippage, step });
      } else if (this.useOpenFour(t)) {
        r = await this.openFourSell({ w, t, pct, slippage, step });
      } else if (this.useFlapNft(t)) {
        r = await this.flapNft.sell({ wallet: w.address, token: t.address, pct, slippage, step });
      } else if (this.usePortal(t, 'sell')) {
        r = await this.portal.sell({ wallet: w.address, market: t.market, quoteAddress: t.quoteAddress, quoteSym: t.quote, pct, slippage, step, toBnb: this.settings.sellToBnb });
      } else {
        // 按下单这一刻的真实余额算；全卖时留 0.1% 余量（转账税 / 小数位舍入会让「卖 100%」报余额不足）
        this.quoteCache.delete(`bal:${w.id}:${t.address}`);
        const bal = await this.tokenBal(w, t.address);
        // 卖 100%：用链上精确余额原样下单；按比例：从实时余额算，向下取整到代币精度
        const ex = await this.exactBal(w, t.address).catch(() => null);
        const qty = ex ? (pct >= 100 ? ex.str : ethers.formatUnits((ex.raw * BigInt(Math.round(pct * 100))) / 10000n, ex.dec)) : bal * Math.min(pct, 99.9) / 100;
        step(`查询余额 ${trim(bal)}`, 0);
        if (!(qty > 0)) throw new Error(`钱包中没有 ${t.symbol}（实际 0 个）`);
        try { r = await this.dexTrade({ t, w, side: 'sell', qty, pct, slippage, step }); }
        catch (e) { if (/insufficient|balance/i.test(e.message)) throw new Error(`钱包里的 ${t.symbol} 余额不足（实际 ${trim(bal)} 个）：${e.message}`); throw e; }
      }
      p.soldBnb += (r.expected || 0) * (order.feeable && this.fees.enabled && feeFor(r.expected || 0) > 0n ? 1 - 0.005 : 1); p.amount = Math.max(0, p.amount * (1 - pct / 100));   // 卖出所得扣手续费
      // 所得留在计价代币里（关了「卖出后自动换回 BNB」或换回失败）：按当时汇率折成 BNB 算手续费
      if (r.expected == null && r.quoteGot && order.feeable && this.fees.enabled) {
        const rate = await this.gangV2.quoteRate(r.quoteGot.token).catch(() => null);   // 每 1 BNB 换多少计价代币
        if (rate > 0) order.feeBaseBnb = Number(ethers.formatUnits(BigInt(r.quoteGot.raw), r.quoteGot.dec)) / rate;
      }
      Object.assign(order, { amountIn: pct, out: r.expected });
    }
    Object.assign(order, { status: 'filled', dryRun: false, venue: r.venue, tx: r.txHash, txs: r.hashes, reason: r.note || null, latencyMs: Date.now() - order.ts });
    this.quoteCache.clear(); this.refreshBalance();
    this.emit('order', order);
    if (PREAPPROVE && side === 'buy' && this.useOpenFour(t)) setTimeout(() => this.preApprove(t, w).catch(() => {}), 0);
    return order;
  }

  // 买入成交后后台预授权：把代币 max 授权给卖出要用的合约（OpenFour 内盘 = Core），卖出时就不用再等授权。
  // Flap Portal 卖的是曲线份额不需要授权；外盘走 baw market-order，由 baw 自己处理，所以这里只处理 OpenFour。
  async preApprove(t, w) {
    const key = t.address.toLowerCase();
    if (this.preapproving.has(key)) return;
    this.preapproving.add(key);
    const order = { id: randomBytes(5).toString('hex'), ts: Date.now(), walletId: w.id, wallet: w.label, token: t.address, symbol: t.symbol, platform: t.platform,
      side: 'approve', amount: 0, source: '预授权', via: 'preapprove', status: 'pending', steps: [], dryRun: false, route: 'OpenFour Core 预授权（max）' };
    const step = (name, ms) => { order.steps.push({ name, ms: Math.round(ms) }); };
    try {
      const t0 = Date.now();
      const i = await openFour.info(t.address, w.address);
      const core = i?.contracts?.core;
      if (!core) throw new Error('未获取到 Core 合约地址');
      const erc = new ethers.Contract(t.address, ['function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'], this.market.provider);
      const cur = await erc.allowance(w.address, core);
      step(`查询授权 ${cur > 0n ? '已有' : '0'}`, Date.now() - t0);
      if (cur >= ethers.MaxUint256 / 2n) { this.preapproving.delete(key); return; }   // 已足够，不发交易、不记录
      this.orders.unshift(order); this.emit('order', order);
      const hash = await this.portal.send({ wallet: w.address, to: t.address, inputData: erc.interface.encodeFunctionData('approve', [core, ethers.MaxUint256]), label: `授权 ${t.symbol}`, step });
      Object.assign(order, { status: 'filled', tx: hash, txs: [hash], venue: 'approve(Core, max)', latencyMs: Date.now() - order.ts });
    } catch (e) {
      Object.assign(order, { status: 'failed', reason: e.message, latencyMs: Date.now() - order.ts });
      if (!this.orders.includes(order)) this.orders.unshift(order);
    } finally { this.preapproving.delete(key); }
    this.emit('order', order);
  }

  // 「发射后自动领取」：Flap Agent 曲线迁移后，份额要调用 Portal.claim(market) 领成代币（Four 的代币本来就在钱包里，不用领）。
  // 每分钟查一次已迁移市场的份额（每个钱包各自的份额各自领）；开着自动领取且钱包已登录时，每个（钱包, 市场）只领一次，失败按 1→2→4…最多 30 分钟退避重试
  async scanClaims() {
    if (!this.wallets.length) return;
    const list = [];
    for (const w of this.wallets) for (const t of this.market.list().filter((x) => x.source === 'agent-curve' && x.market && x.stage === 'dex')) {
      try { const sh = await this.portal.sharesOf(t.market, w.address); if (sh > 0n) list.push({ token: t.address, market: t.market, symbol: t.symbol, shares: Number(sh) / 1e18, walletId: w.id, walletSlot: w.slot, wallet: w.label }); } catch { /* 单个市场读失败跳过 */ }
    }
    this.claimable = list;
    if (DRY_RUN || !this.settings.autoClaim) return;
    for (const c of list) {
      const w = this.wallets.find((x) => x.id === c.walletId);
      if (!w || this.slotAuth.get(w.slot)?.state !== 'ok') continue;
      const k = `${c.walletId}:${c.market}`, r = this.claimRetry.get(k);
      if (this.claiming.has(k) || (r && Date.now() < r.next)) continue;
      this.claimOne(c.market, '自动领取', w);
    }
  }

  // 领取某个市场：不传 wallet = 所有持有份额的钱包都领一遍
  // 铸币飞轮开盘后铸造（代币页飞轮卡片）：只对已开盘、开着开盘后铸造的飞轮
  async flyPostMint({ t, w, amt, slippage, step }) {
    if (t.gangTrack !== 'fly' || !t.gangFly) throw new Error('不是铸币飞轮的代币');
    if (this.onCurve(t)) throw new Error('尚未开盘：开盘前请直接铸造');
    if (!t.gangFly.postMint) throw new Error('这个飞轮开盘后不能继续铸造');
    return this.gangFly.mintPost({ wallet: w.address, token: t.address, amountBnb: trim(amt), slippage, step, fly: t.gangFly });
  }

  // 铸币飞轮的钱包情况（飞轮卡片用）：剩余额度、可卖回份数、卖回能拿多少、可领奖励、开盘后铸造 1 份的价格。只读
  async flyInfo(token, slot) {
    const t = this.market.get(token); if (!t?.gangFly) throw new Error('不是铸币飞轮的代币');
    const w = this.wallets.find((x) => x.slot === Number(slot)) || this.primaryWallet();
    if (!w?.address) return { wallet: null };
    const a = await this.gangFly.account(t.address, w.address);
    const back = a.preShares > 0 && t.gangFly.withdrawable ? await this.gangFly.previewWithdraw({ token: t.address, wallet: w.address, pct: 100 }).catch(() => null) : null;
    const post = !this.onCurve(t) && t.gangFly.postMint && a.quotaLeft > 0 ? await this.gangFly.previewMintPost({ token: t.address, wallet: w.address, amountBnb: 1000, fly: { ...t.gangFly, maxPerTx: 1 } }).catch(() => null) : null;
    const { ethers } = await import('ethers');
    return { wallet: { slot: w.slot, address: w.address }, quotaLeft: a.quotaLeft, preShares: a.preShares, used: a.used, bonus: a.bonus, minted: a.minted,
      withdrawAll: back?.shares ? { shares: back.shares, payout: Number(ethers.formatEther(back.payout)), fee: Number(ethers.formatEther(back.fee)) } : null,
      pendingReward: Number(ethers.formatEther(a.pendingReward)),
      postOne: post?.shares ? { price: Number(ethers.formatEther(post.spend)), tokens: post.tokens } : post ? { paused: true, note: post.note } : null };
  }

  // 领取铸币飞轮的持有人奖励（奖励是 WBNB，按设置换回 BNB）。和领取代币一样记一笔订单
  async flyClaim(token, slot, source = '手动') {
    const t = this.market.get(token); if (!t?.gangFly) throw new Error('不是铸币飞轮的代币');
    const w = this.wallets.find((x) => x.slot === Number(slot)) || this.primaryWallet();
    const order = { id: randomBytes(5).toString('hex'), ts: Date.now(), walletId: w?.id, walletSlot: w?.slot, wallet: w?.label || 'baw', token: t.address, symbol: t.symbol || '?', platform: 'gang',
      side: 'claim', amount: 0, source, status: 'pending', steps: [], dryRun: DRY_RUN || !isRealSource(source), route: '铸币飞轮 · 分红金库 claim（持有人奖励）' };
    this.orders.unshift(order); this.emit('order', order);
    const step = (name, ms, x) => { order.steps.push({ name, ms: Math.round(ms) }); if (x?.tx) { order.pendingTx = x.tx; order.stage = x.stage || 'broadcast'; } this.emit('order', order); };
    try {
      if (order.dryRun) throw new Error('演示模式不会领取');
      if (this.slotAuth.get(w.slot)?.state !== 'ok') throw new Error('币安钱包未登录，请点击右上角登录');
      const r = await baw.withSlot(w.slot, () => this.gangFly.claim({ wallet: w.address, token: t.address, step, toBnb: this.settings.sellToBnb }));
      Object.assign(order, { status: 'filled', venue: r.venue, out: r.expected, tx: r.txHash, txs: r.hashes, latencyMs: Date.now() - order.ts });
    } catch (e) { Object.assign(order, { status: 'failed', reason: e.message, latencyMs: Date.now() - order.ts }); }
    this.emit('order', order);
    return order;
  }

  async claimOne(market, source = '手动领取', wallet = null) {
    const ws = wallet ? [wallet] : this.wallets.filter((w) => this.claimable.some((c) => c.market === market && c.walletId === w.id));
    if (!ws.length) ws.push(this.primaryWallet());
    const outs = [];
    for (const w of ws) outs.push(await this.claimOneWallet(market, source, w));
    return outs[0];
  }
  async claimOneWallet(market, source, w) {
    const t = this.market.list().find((x) => x.market === market);
    const ck = `${w.id}:${market}`;
    const order = { id: randomBytes(5).toString('hex'), ts: Date.now(), walletId: w?.id, walletSlot: w?.slot, wallet: w?.label || 'baw', token: t?.address, symbol: t?.symbol || '?', platform: 'flap',
      side: 'claim', amount: 0, source, status: 'pending', steps: [], dryRun: DRY_RUN, route: 'Flap Agent Curve · Portal.claim（迁移后领取代币）' };
    this.orders.unshift(order); this.emit('order', order);
    const step = (name, ms, x) => { order.steps.push({ name, ms: Math.round(ms) }); if (x?.tx) { order.pendingTx = x.tx; order.stage = x.stage || 'broadcast'; } this.emit('order', order); };
    this.claiming.add(ck);
    try {
      if (DRY_RUN) throw new Error('演示模式不会领取');
      if (this.slotAuth.get(w.slot)?.state !== 'ok') throw new Error('币安钱包未登录，请点击右上角登录');
      const r = await baw.withSlot(w.slot, () => this.portal.claim({ wallet: w.address, market, step }));
      Object.assign(order, { status: 'filled', venue: r.venue, out: r.expected, tx: r.txHash, txs: r.hashes, latencyMs: Date.now() - order.ts });
      this.claimRetry.delete(ck); this.claimable = this.claimable.filter((c) => !(c.market === market && c.walletId === w.id));
      // 打开了「领取后自动转出」：给这个币挂上已确认的转出规则，由 ruleTick 负责转账（重试、钱包锁、记录哈希）
      if (this.settings.sendTo && this.settings.autoSendAfterClaim && t?.address) {
        const k = t.address.toLowerCase(), ex = this.rules()[k];
        if (ex) { ex.to ||= this.settings.sendTo; if (ex.transfer !== 'off') ex.transfer = 'armed'; ex.state ||= {}; this.ruleWS(ex.state, w.id).claimedAt ||= Date.now(); this.ruleWS(ex.state, w.id).claimTx ||= r.txHash; this.ruleLog(ex, '领取成功，按「领取后自动转出」设置转出'); this.rulesSave(); }
        else { this.setRule(k, { claim: true, to: this.settings.sendTo, transfer: 'armed', auto: true, state: { w: { [w.id]: { claimedAt: Date.now(), claimTx: r.txHash } } } }); }
      }
    } catch (e) {
      const prev = this.claimRetry.get(ck)?.wait || 30_000; const wait = Math.min(prev * 2, 30 * 60_000);
      this.claimRetry.set(ck, { wait, next: Date.now() + wait });
      Object.assign(order, { status: 'failed', reason: e.message, latencyMs: Date.now() - order.ts });
    } finally { this.claiming.delete(ck); }
    this.emit('order', order);
    return order;
  }

  // 内盘买入：info 确认还在内盘 → quote-buy 生成 Core 交易 → baw contract-call preview + execute → 等上链
  async openFourBuy({ w, t, amt, slippage, step }) {
    let t0 = Date.now();
    const i = await openFour.info(t.address, w.address);
    if (i.route !== 'contract-call') throw new Error(`该代币当前无法在内盘买入（route=${i.route}，${i.curve?.phase?.name || ''}）`);
    const q = openFour.checkQuote(await openFour.quoteBuy(t.address, w.address, trim(amt), Math.round(slippage * 100)));
    step(`OpenFour 报价 ${Number(q.estimate.tokenAmount).toFixed(0)} ${t.symbol}（至少 ${Number(q.minTokenOut).toFixed(0)}）`, Date.now() - t0);
    if (q.estimate.budgetNotFullyUsed) step('接近 1% 持仓上限，只花掉部分 BNB，多余的同笔退回', 0);
    if (q.approveTx) throw new Error('需先授权计价代币，当前版本仅支持使用 BNB 买入');
    const hash = await this.portal.send({ wallet: w.address, to: q.tx.to, valueWei: q.tx.value, inputData: q.tx.inputData, label: 'OpenFour Core.buy', step });
    return { venue: 'OpenFour Core.buy（内盘）', expected: Number(q.estimate.tokenAmount), txHash: hash, hashes: [hash] };
  }

  // 内盘卖出：quote-sell；需要时先授权（只授权本次卖出数量），授权上链后重新报价再卖
  async openFourSell({ w, t, pct, slippage, step }) {
    const bps = Math.round(slippage * 100);
    const bal = await this.tokenBal(w, t.address);
    step(`查询余额 ${trim(bal)}`, 0);
    if (!(bal > 0)) throw new Error('没有可卖出的余额');
    const amount = pct >= 100 ? 'all' : trim(bal * pct / 100);
    let q = openFour.checkQuote(await openFour.quoteSell(t.address, w.address, amount, bps));
    const hashes = [];
    if (q.approveTx) {
      // 技能脚本给的是「授权本次数量」；按设置改成较大固定额度（全部余额 × 1.01），授权对象不变
      const ai = new ethers.Interface(['function approve(address,uint256)']); let spender = null, amt0 = 0n;
      try { [spender, amt0] = ai.decodeFunctionData('approve', q.approveTx.inputData); } catch { /* 解析不了就按脚本原样 */ }
      if (spender && q.approveTx.to.toLowerCase() === t.address.toLowerCase()) {
        const cap = await capFor({ token: t.address, wallet: w.address, amount: amt0, kind: 'sell' });
        hashes.push(await sendApproval({ send: (o) => this.portal.send(o), wallet: w.address, token: t.address, spender, amount: amt0, cap, label: `授权 ${t.symbol}（${capLabel('sell')}）`, symbol: t.symbol, kind: 'sell', step }));
      } else hashes.push(await this.portal.send({ wallet: w.address, to: q.approveTx.to, valueWei: q.approveTx.value || '0', inputData: q.approveTx.inputData, label: `授权 ${t.symbol}`, step }));
      q = openFour.checkQuote(await openFour.quoteSell(t.address, w.address, amount, bps));
    }
    step(`OpenFour 报价 → ${Number(q.estimate.userReceives).toFixed(6)} BNB（至少 ${Number(q.minReceive).toFixed(6)}）`, 0);
    hashes.push(await this.portal.send({ wallet: w.address, to: q.tx.to, valueWei: q.tx.value || '0', inputData: q.tx.inputData, label: 'OpenFour Core.sell', step }));
    return { venue: 'OpenFour Core.sell（内盘）', expected: Number(q.estimate.userReceives), txHash: hashes.at(-1), hashes };
  }

  // BNB ↔ Ondo 类代币（只能和稳定币直接换）自动拆成经 USDT 两步；路线表里没记录的，第一次报错时记下来并改走 USDT（报错时还没提交订单）
  async swapReal({ from, to, qty, slippage, step, label }) {
    const isBnb = (a) => String(a).toLowerCase() === BNB_NATIVE.toLowerCase();
    const other = isBnb(from) ? to : isBnb(to) ? from : null;
    if (other && viaUsdt(other)) return this.swapViaUsdt({ from, to, qty, slippage, step, label });
    try { return await this.swapOnce({ from, to, qty, slippage, step, label }); }
    catch (e) {
      if (!other || !ONDO_RE.test(e.message)) throw e;
      markViaUsdt(other); step(`${label} 只能和稳定币直接兑换（Ondo 类），改走 USDT 两步`, 0);
      return this.swapViaUsdt({ from, to, qty, slippage, step, label });
    }
  }
  async swapViaUsdt({ from, to, qty, slippage, step, label }) {
    const a = await this.swapOnce({ from, to: USDT, qty, slippage, step, label: `${label}（第 1 步 →USDT）` });
    if (!(a.raw > 0)) throw new Error(`${label} 第 1 步未获得 USDT，已停止`);
    let b;
    try { b = await this.swapOnce({ from: USDT, to, qty: String(a.raw), slippage, step, label: `${label}（第 2 步 USDT→）` }); }
    catch (e) { e.message = `${e.message}；第 1 步已换出 ${a.raw} USDT 留在钱包`; throw e; }
    return { venue: 'baw market-order（经 USDT 两步）', expected: b.expected, txHash: b.txHash, hashes: [...a.hashes, ...b.hashes], note: [a.note, b.note].filter(Boolean).join('；') || null };
  }
  async swapOnce({ from, to, qty, slippage, step, label }) {
    const t0 = Date.now();
    const sw = await baw.marketSwap({ fromTokenQty: typeof qty === 'string' ? qty : trim(qty), fromToken: from, toToken: to, slippage });   // 字符串 = 精确数量，原样传
    if (!sw.orderId) throw new Error(`${label} 未返回订单号`);
    step(`${label} 已提交 ${sw.orderId}`, Date.now() - t0);
    const o = await baw.pollOrder(sw.orderId);
    if (o?.status !== 'FINISHED') throw Object.assign(new Error(`${label} ${o?.status === 'FAILED' ? '失败' : '仍在处理，请稍后在钱包中查看'}（订单 ${sw.orderId}）`), o?.status === 'FAILED' ? {} : { code: 'UNCONFIRMED', tx: o?.txHash || null });   // 没失败也没完成 = 已提交、结果未知，按待确认跟踪
    const refund = Array.isArray(o.refund) && o.refund.length ? `；部分成交，退回 ${o.refund.map((x) => `${x.amount} ${x.symbol}`).join('、')}` : '';
    step(`${label} 完成${refund}`, Date.now() - t0);
    return { venue: 'baw market-order', expected: Number(o.toTokenActualQty || 0), raw: o.toTokenActualQty || 0, txHash: o.txHash || null, hashes: [o.txHash].filter(Boolean), note: refund ? refund.slice(1) : null };
  }

  async swap({ from, to, qty, slippage, step }) {
    const t0 = Date.now();
    const q = await baw.marketQuote({ fromTokenQty: trim(qty), fromToken: from, toToken: to, slippage });
    step(`baw 报价 → ${q?.toCoinAmount ?? '?'} ${q?.toCoinSymbol || ''}`, Date.now() - t0);
    return { dryRun: true, expected: Number(q?.toCoinAmount || 0), venue: 'baw-dex 报价' };
  }

  finish(order, r, apply, extra) {
    Object.assign(order, { status: 'dry_run', reason: '演示模式：仅报价，未成交', ...extra });
    order.venue = r.venue; order.latencyMs = Date.now() - order.ts;
    this.emit('order', order);
    return order;
  }

  positionsView() {
    const out = [];
    for (const p of this.positions.values()) {
      if (p.amount <= 0 && !p.boughtBnb) continue;
      const t = this.market.get(p.token); if (!t) continue;
      // t.price 以报价币计（GANG、BNCB…），折成 BNB 再算价值和盈亏，否则 GANG 盘会把 GANG 数量当 BNB（和 holdings.js 同一换算）
      const bnbUsd = this.market.bnbUsd, isBnbQuote = !t.quote || ['BNB', 'WBNB'].includes(String(t.quote).toUpperCase());
      const rate = isBnbQuote ? 1 : (bnbUsd ? (this.market.quoteUsd?.(t) || 0) / bnbUsd : 0);
      const value = p.amount * (t.price || 0) * rate;
      if (p.amount > 0) p.peak = Math.max(p.peak, t.price || 0);
      out.push({ ...p, symbol: t.symbol, platform: t.platform, image: t.image || null, stage: t.stage, price: t.price, valueBnb: value, valueUsd: value * bnbUsd,
        pnlBnb: value + p.soldBnb - p.boughtBnb, pnlPct: p.costBnb > 0 && t.price && rate ? ((value - p.costBnb) / p.costBnb) * 100 : 0,
        drawdownPct: p.peak ? ((t.price - p.peak) / p.peak) * 100 : 0, wallet: this.wallets.find((w) => w.id === p.walletId)?.label || 'baw' });
    }
    return out.sort((a, b) => b.openedAt - a.openedAt);
  }

  walletsView() { return this.wallets.map(({ tokens, ...w }) => w); }

  // 钱包槽位列表（页面顶栏 / 钱包选择用）：槽位号、名字、地址、状态、余额、登录进度、是否主钱包；加上全局「交易钱包」选择
  slotsView() {
    const pri = walletSlots.primary();
    const sup = baw.profileSupport();
    return {
      slots: walletSlots.list().map((s) => {
        const a = this.slotAuth.get(s.slot) || { state: 'checking' };
        const w = this.wallets.find((x) => x.slot === s.slot);
        const l = this.slotLogin.get(s.slot);
        return { slot: s.slot, label: w?.label || s.label || (s.slot === 1 ? WALLET_LABEL : `钱包 ${s.slot}`), customName: !!s.label, primary: s.slot === pri,
          fresh: s.slot > 1 && !s.pinned,   // 新加的槽位还没扫码成功过：页面列表里不显示，下次「添加钱包」直接复用
          auth: a.state, authMessage: a.state === 'ok' ? '' : a.message || '', authCode: a.state === 'ok' ? '' : a.code || '', authCodeP: a.codeP || null, agentId: a.agentId || null,
          address: w?.address || s.pinned || null, bnb: w?.bnb ?? null, tokens: w?.tokens || null,
          login: l ? { state: l.state, urlForWeb: l.urlForWeb, pairingCode: l.pairingCode, message: l.message, expireAt: l.expireAt } : null };
      }),
      primary: pri,
      tradeSlots: this.tradeSlots(),
      canAdd: walletSlots.list().length < walletSlots.MAX_SLOTS && sup.ok,
      bawVersion: sup.version || null,
      canAddReason: sup.ok ? null : `baw ${sup.version || '?'} 还没有核对过多钱包隔离，暂不能添加钱包（主钱包不受影响）`,
    };
  }
  // 全局「交易钱包」：页面各处一键买卖共用（存在 data/live-settings.json）。默认 = 主钱包；未登录 / 已移除的槽位自动剔除
  tradeSlots() {
    const valid = new Set(walletSlots.list().map((s) => s.slot));
    const saved = (loadSaved().tradeSlots || []).map(Number).filter((x) => valid.has(x));
    return saved.length ? saved : [walletSlots.primary()];
  }
  setTradeSlots(arr) {
    const valid = new Set(walletSlots.list().map((s) => s.slot));
    const next = [...new Set((arr || []).map(Number).filter((x) => valid.has(x) && x > 0))].sort((a, b) => a - b);
    if (!next.length) throw new Error('至少选择一个钱包');
    saveSetting('tradeSlots', next);
    return next;
  }
  loginView(slot = 1) {
    const l = this.slotLogin.get(Number(slot));
    return l ? { id: l.id, slot: l.slot, state: l.state, urlForWeb: l.urlForWeb, pairingCode: l.pairingCode, expireAt: l.expireAt, message: l.message, address: l.address || null } : null;
  }
}

// 实盘设置（单笔上限、自动领取）存在 data/live-settings.json，重启后仍然有效；没存过就用默认值
function loadSaved() { try { return JSON.parse(readFileSync(LIVE_SETTINGS_FILE, 'utf8')); } catch { return {}; } }
function saveSetting(k, v) {
  mkdirSync(new URL('.', LIVE_SETTINGS_FILE), { recursive: true });
  writeFileSync(LIVE_SETTINGS_FILE, JSON.stringify({ ...loadSaved(), [k]: v }, null, 2));
}
function loadMaxTrade() { const v = loadSaved().maxTradeBnb; return v != null && Number(v) >= 0 ? Number(v) : MAX_TRADE_BNB; }
LiveTrader.prototype.saveSetting = function (k, v) { saveSetting(k, v); };
LiveTrader.prototype.loadSaved = function () { return loadSaved(); };
LiveTrader.prototype.setMaxTrade = function (v) {
  const n = v === '' || v == null ? 0 : Number(v);
  if (!(n >= 0) || !Number.isFinite(n)) throw new Error('单笔上限须为大于等于 0 的数字（0 表示不限）');
  this.status.maxTradeBnb = n;
  saveSetting('maxTradeBnb', n);
  return n;
};

const FUND_GAS = 0.002;   // 用计价币补 BNB 时给 gas 留的 BNB
const fmtQ = (n) => (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(4) : n.toPrecision(4));
const trim = (n) => Number(n).toFixed(18).replace(/\.?0+$/, '') || '0';
// 会真实上链的订单来源：页面手动点击（手动），以及本人在页面上关掉「模拟」并启动的跟单任务（跟单 任务名）。
// 以前只认「手动」，跟单任务传来的「跟单 xxx」被当成自动订单，真实模式的跟单永远只报价、从不下单，也不计次数
// 2026-10-27 起还有本人在页面上打开、并关掉「模拟」的 Gang 新盘狙击（狙击 Gang，engine/live/sniper.js）
// 另外可以在环境变量 TMTN_EXTRA_SOURCES（逗号分隔，写在 .env 里）放行其他来源：本机脚本带访问令牌调 /api/order 时用。默认为空
const EXTRA_SOURCES = new Set(String(process.env.TMTN_EXTRA_SOURCES || '').split(',').map((x) => x.trim()).filter(Boolean));
const isRealSource = (s) => s === '手动' || /^跟单 /.test(String(s || '')) || /^条件单 /.test(String(s || '')) || s === '狙击 Gang' || EXTRA_SOURCES.has(String(s || ''));
