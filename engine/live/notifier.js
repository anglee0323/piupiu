// 提醒判断（Gateway）：战壕新币、钱包追踪、雷达新推荐三个来源「要不要提醒、响什么声音」都在这里决定。
// 结果发一个 alert 事件（server.js 转成 WebSocket 的 { type: 'alert' }）；网页只负责播放声音、弹卡片。
// 以后 Telegram 等入口订阅同一个事件即可，不用各自再写一遍规则。
// 以前这些规则写在网页里（Trenches.tsx 的新币判断、RadarAlerts.tsx 的命中判断、lib/notify.ts 的冷却表），
// 只有页面开着才算得出来，换入口就得重写；筛选条件本身来自 shared/filters.js，和网页列表是同一份。
import { EventEmitter } from 'node:events';
import { matchColumn, matchRadar, matchRadarSoon, defaultRadarSoon, recommendedRadarFilter } from '../../shared/filters.js';

const lc = (a) => String(a || '').toLowerCase();

export const RULES = {
  // 战壕：只为「真的刚出现」的币提醒——新创建 = 3 分钟内创建的；已开盘 = 3 分钟内开盘的；即将打满 = 新进入这一列的。
  // Gateway 刚启动时行情在补历史，一次会冒出一批老币：启动后 60 秒内只记下、不提醒
  trench: { cooldown: 0, recentMs: 180_000, quietAfterStart: 60_000 },
  // 钱包追踪：实时成交每笔都提醒（手动回补的历史事件不提醒）
  track: { cooldown: 0 },
  // 雷达：几个项目同时命中只算一次，30 秒内不重复响
  radar: { cooldown: 30_000 },
};

// 读不到界面设置（新装、还没保存过）时的默认值：和 web/src/store/prefs.ts 的默认值一致
export const DEFAULT_PREFS = {
  cols: { new: { sound: false }, soon: { sound: false }, dex: { sound: false } },
  platforms: ['flap', 'four', 'gang-v1', 'gang-v2', 'gang-v3', 'gang-fair', 'gang-fly'],
  trackSound: { on: true, kind: 'Kaching' },
  radarAlert: true,
  radarAlertSound: true,
  radarFilter: recommendedRadarFilter(),
  radarSoon: defaultRadarSoon(),
};

const SEEN_MAX = 20_000;   // 「见过的币」上限：超过就以当前列表重新起算（极少发生）

export class Notifier extends EventEmitter {
  /** getPrefs()：界面设置（data/prefs.json 的 state）；isBlocked(t)：币或开发者被屏蔽；autoMintOn()：雷达自动铸造是否开着；now：测试可注入时钟 */
  constructor({ getPrefs = () => null, isBlocked = () => false, autoMintOn = () => false, now = () => Date.now() } = {}) {
    super();
    this.getPrefs = getPrefs; this.isBlocked = isBlocked; this.autoMintOn = autoMintOn; this.now = now;
    this.startAt = now();
    this.colSeen = {};        // 列 → 见过的币地址
    this.radarSeen = null;    // 见过的推荐（第一次拿到列表时全部记下、不提醒）
    this.soonSeen = null;     // 已经算过「即将打满」的项目（同上：第一次只记下；每个项目只提醒一次）
    this.lastAt = {};         // 来源 → 上次响声时间（冷却用）
  }

  prefs() {
    const p = this.getPrefs() || {};
    return { ...DEFAULT_PREFS, ...p, cols: { ...DEFAULT_PREFS.cols, ...(p.cols || {}) }, trackSound: { ...DEFAULT_PREFS.trackSound, ...(p.trackSound || {}) }, radarSoon: { ...DEFAULT_PREFS.radarSoon, ...(p.radarSoon || {}) } };
  }

  alert(a) { this.emit('alert', { at: this.now(), ...a }); }

  /** 冷却：该来源这次能不能响 */
  soundOk(source) {
    const r = RULES[source], t = this.now();
    if (r.cooldown && t - (this.lastAt[source] ?? -Infinity) < r.cooldown) return false;
    this.lastAt[source] = t;
    return true;
  }

  /** 战壕：每次行情推送后调用（tokens = 当前全部代币） */
  onTokens(tokens, bnbUsd) {
    const p = this.prefs(), t0 = this.now();
    const ctx = { platforms: p.platforms, bnbUsd, now: t0, isBlocked: this.isBlocked };
    const quiet = t0 - this.startAt < RULES.trench.quietAfterStart;
    const recent = (ts) => !!ts && t0 - ts < RULES.trench.recentMs;
    for (const k of ['new', 'soon', 'dex']) {
      const c = p.cols[k] || {};
      const list = tokens.filter((t) => matchColumn(t, k, c.filter, ctx));
      let seen = this.colSeen[k];
      if (!seen || seen.size > SEEN_MAX) { this.colSeen[k] = new Set(list.map((t) => lc(t.address))); continue; }
      const fresh = list.filter((t) => !seen.has(lc(t.address)));
      for (const t of fresh) seen.add(lc(t.address));
      const real = fresh.filter((t) => (k === 'new' ? recent(t.createdAt) : k === 'dex' ? recent(t.migratedAt) : true));
      if (!real.length || quiet || !c.sound) continue;
      this.alert({ source: 'trench', col: k, sound: c.soundKind || 'Bell', tokens: real.slice(0, 10).map((t) => ({ address: t.address, symbol: t.symbol })) });
    }
  }

  /** 雷达：每次推送新的雷达列表后调用 */
  onRadarView(view) {
    const keysOf = (it) => (it.keys?.length ? it.keys : [it.address]);
    const items = view?.items || [];
    const recs = items.filter((x) => x.rec);
    const p = this.prefs(), now = this.now();
    // 即将打满：第一次达到条件时提醒一次（和新推荐分开记；条件改宽后新进入的也算第一次）
    const soon = items.filter((it) => matchRadarSoon(it, p.radarSoon, now));
    let soonHits = [];
    if (!this.soonSeen) this.soonSeen = new Set(soon.map((it) => it.id));
    else { soonHits = soon.filter((it) => !this.soonSeen.has(it.id)); for (const it of soon) this.soonSeen.add(it.id); }
    if (!this.radarSeen) { this.radarSeen = new Set(recs.flatMap(keysOf)); return; }
    const fresh = recs.filter((it) => keysOf(it).some((k) => !this.radarSeen.has(k)));
    for (const it of recs) for (const k of keysOf(it)) this.radarSeen.add(k);
    // 命中的判断和提醒开关无关：自动铸造开着时，命中的直接交给自动铸造（emit radarMatch），不再弹卡片让人点
    const recMatch = fresh.filter((it) => !it.blocked && it.state !== 'cool' && !it.mineExhausted && !(it.mintTx > 0) && matchRadar(it, p.radarFilter, now));
    const all = [...recMatch, ...soonHits.filter((x) => !recMatch.some((y) => y.id === x.id))];
    if (all.length && this.autoMintOn()) { this.emit('radarMatch', all); return; }
    // radarAlert 是雷达提醒的总开关：关掉后新推荐、即将打满都不弹、不响；即将打满另有自己的开关（总开关开着时才看它）
    const hits = !p.radarAlert ? [] : [...recMatch, ...(p.radarSoon.alert ? soonHits.filter((x) => !recMatch.some((y) => y.id === x.id)) : [])];
    if (!hits.length) return;
    const sound = p.radarAlertSound && this.soundOk('radar') ? 'Bell' : null;
    this.alert({ source: 'radar', ids: hits.map((h) => h.id), items: hits.map((h) => ({ id: h.id, address: h.address, title: h.title })), sound });
  }

  /** 钱包追踪：每个实时买卖事件调用（targets = 追踪的钱包列表，每个可以单独指定声音或关掉） */
  onTrackEvent(ev, targets = []) {
    if (!ev || ev.backfill) return;
    const p = this.prefs();
    const own = targets.find((t) => t.address === ev.target)?.sound;
    if (!p.trackSound.on || own === false) return;
    this.alert({ source: 'track', id: ev.id, target: ev.target, sound: typeof own === 'string' ? own : p.trackSound.kind });
  }
}
