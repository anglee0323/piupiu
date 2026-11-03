// 战壕列筛选、雷达筛选：Gateway（判断要不要提醒）和网页（列表显示）共用这一份。
// 以前只写在网页里（Trenches.tsx / lib/radarFilter.ts），提醒也在网页里判断；以后 Telegram 等入口要在 Gateway 里判断，
// 两边各写一份迟早会对不上，所以只保留这一份。纯函数、不依赖浏览器或 Node，改动后两边自动一致。
// 类型声明在同目录的 filters.d.ts（网页 TypeScript 用）。

/** 战壕列筛选的空条件（字符串留空 = 不限） */
export const emptyFilter = () => ({
  keywords: '', exclude: '', dev: '', social: false, bond: false, minProgress: '', maxProgress: '', minAge: '', maxAge: '',
  minLiq: '', maxLiq: '', minMc: '', maxMc: '', minVol: '', maxVol: '', minHolders: '', maxHolders: '', minTax: '', maxTax: '',
});

/** 雷达筛选的空条件 */
export const emptyRadarFilter = () => ({ maxAgeH: '', minScore: '', price: 'any', maxBnb: '', oneClick: false, minAi: '', minPct: '', maxPct: '', keywords: '', exclude: '' });
/** 推荐筛选（默认）：免费、支持一键铸造。不再默认要求 ≥68 分：进推荐本来就要 ≥50 分，而实际的推荐项目大多在 50–65 分，
 *  加了 68 分门槛的人列表常年是空的（2026-11-02） */
export const recommendedRadarFilter = () => ({ ...emptyRadarFilter(), price: 'free', oneClick: true });

/** gang 币属于哪个版本（v3 曲线和 V3 打新都算 V3 系；铸币飞轮单独一类） */
export const gangVer = (t) => (t.gangTrack === 'fly' ? 'gang-fly' : t.gangTrack === 'v3fair' ? 'gang-fair' : /^v3/.test(t.gangTrack || '') ? 'gang-v3' : t.gangTrack === 'v2' ? 'gang-v2' : 'gang-v1');
/** 发射台：Gang 的四个版本各算一个，和 Flap、Four 平级 */
export const launchpadOf = (t) => (t.platform === 'gang' ? gangVer(t) : t.platform);
/** 代币是否落在选中的发射台里 */
export const inPlatforms = (t, sel) => sel.includes(launchpadOf(t));

/** 成交额（美元）：开盘后优先用 DEX 24h 成交额，内盘用累计成交量 × 计价币价格 */
export function volUsd(t, bnbUsd) {
  if (t.stage === 'dex' && t.dexVolUsd24 != null) return t.dexVolUsd24;
  if (t.stage === 'dex' && t.dexVol24 != null) return t.dexVol24 * (t.quoteUsd || bnbUsd || 0);
  return (t.volume || 0) * (t.quoteUsd || bnbUsd || 0);
}

/** 有生效中、未违约的开发者押金（Gang） */
export const bondActive = (t) => !!t.gangBond && t.gangBond.state === 'active' && !t.gangBond.violated;

const num = (v) => (v === '' || v == null || !isFinite(Number(v)) ? null : Number(v));
const words = (v) => String(v || '').toLowerCase().split(/[,，\s]+/).filter(Boolean);

/**
 * 战壕某一列（new 新创建 / soon 即将打满 / dex 已开盘）是否显示这个币。
 * ctx：platforms 顶栏选中的发射台；isBlocked(t) 是否被屏蔽（币或开发者）；bnbUsd；now
 */
export function matchColumn(t, k, f0, ctx) {
  const f = { ...emptyFilter(), ...(f0 || {}) };
  const now = ctx.now ?? Date.now();
  if (!inPlatforms(t, ctx.platforms)) return false;
  if (ctx.isBlocked?.(t)) return false;
  if (k === 'new' && t.stage !== 'curve') return false;
  if (k === 'soon' && !(t.stage === 'curve' && t.progress > 0)) return false;
  if (k === 'dex' && t.stage !== 'dex') return false;
  const kws = words(f.keywords), exs = words(f.exclude), devs = words(f.dev);
  const range = (x, lo, hi, m = 1) => (num(lo) == null || (x ?? 0) >= num(lo) * m) && (num(hi) == null || (x ?? 0) <= num(hi) * m);
  const text = `${t.symbol} ${t.name} ${t.address}`.toLowerCase();
  if (kws.length && !kws.some((w) => text.includes(w))) return false;
  if (exs.length && exs.some((w) => `${t.symbol} ${t.name}`.toLowerCase().includes(w))) return false;
  if (devs.length && !devs.some((w) => `${t.creator || ''} ${t.creatorName || ''}`.toLowerCase().includes(w))) return false;
  if (f.social && !(t.website || t.twitter || t.telegram)) return false;
  if (f.bond && !bondActive(t)) return false;
  if (!range(t.progress, f.minProgress, f.maxProgress)) return false;
  if (!range((now - ((k === 'dex' && t.migratedAt) || t.createdAt)) / 60_000, f.minAge, f.maxAge)) return false;
  if (!range(t.liqUsd, f.minLiq, f.maxLiq, 1000)) return false;
  if (!range(t.mcapUsd, f.minMc, f.maxMc, 1000)) return false;
  if (!range(volUsd(t, ctx.bnbUsd), f.minVol, f.maxVol, 1000)) return false;
  if (!range(t.holders, f.minHolders, f.maxHolders)) return false;
  if (!range(Math.max(t.buyFeePct ?? 0, t.sellFeePct ?? 0), f.minTax, f.maxTax)) return false;
  return true;
}

/** 列内排序（原地排序并返回）：即将打满按进度或市值，已开盘按开盘时间，新创建按创建时间 */
export function sortColumn(list, k, sort) {
  if (k === 'soon') list.sort((a, b) => (sort === 'mc' ? (b.mcapUsd || 0) - (a.mcapUsd || 0) : b.progress - a.progress));
  else if (k === 'dex') list.sort((a, b) => (b.migratedAt || b.createdAt) - (a.migratedAt || a.createdAt) || (a.address < b.address ? -1 : 1));
  else list.sort((a, b) => b.createdAt - a.createdAt || (a.address < b.address ? -1 : 1));
  return list;
}

/** 雷达项目是否符合筛选（「最新 / 最高分」列表和新推荐提醒共用） */
export function matchRadar(it, f0, now = Date.now()) {
  const f = { ...emptyRadarFilter(), ...(f0 || {}) };
  const age = num(f.maxAgeH);
  if (age != null && (now - (it.bornAt || it.firstSeen)) / 3600_000 > age) return false;
  const ms = num(f.minScore);
  if (ms != null && (it.priority?.score ?? -1) < ms) return false;
  if (f.price === 'free' && it.free !== true) return false;
  if (f.price === 'max') {
    const cap = num(f.maxBnb);
    if (cap != null && it.free !== true) { if (it.price == null) return false; if (Number(BigInt(it.price)) / 1e18 > cap) return false; }
  }
  if (f.oneClick && !(it.canDo && !it.mineExhausted)) return false;
  const ai = num(f.minAi);
  if (ai != null && it.aiCallers < ai) return false;
  const pct = num(f.maxPct);
  if (pct != null && it.supply?.pct != null && it.supply.pct > pct) return false;
  const minPct = num(f.minPct);
  if (minPct != null && !(it.supply?.pct != null && it.supply.pct >= minPct)) return false;   // 要求已铸比例时，读不到总量的项目不算
  const text = `${it.title} ${it.name || ''} ${it.tagline || ''} ${it.kindLabel || ''} ${it.address}`.toLowerCase();
  const kws = words(f.keywords), exs = words(f.exclude);
  if (kws.length && !kws.some((w) => text.includes(w))) return false;
  if (exs.length && exs.some((w) => text.includes(w))) return false;
  return true;
}

// ---------- 雷达「即将打满」 ----------
// 已铸比例达到门槛、但还没铸完的项目（不限是否在推荐里）：列表、筛选和提醒共用
export const defaultRadarSoon = () => ({ minPct: 60, maxAgeH: 72, free: true, oneClick: false, alert: true });
export const RADAR_SOON_PCTS = [50, 60, 70, 80];
export const RADAR_SOON_AGES = [[24, '1 天内'], [72, '3 天内'], [168, '7 天内'], [0, '不限']];

/** 是否算「即将打满」：已铸 ≥ minPct 且 < 100%，上线时间在 maxAgeH 内（0 = 不限）；可选仅免费 / 仅一键铸造；屏蔽、冷却、已铸过的不算 */
export function matchRadarSoon(it, s0, now = Date.now()) {
  const s = { ...defaultRadarSoon(), ...(s0 || {}) };
  const pct = it.supply?.pct;
  if (pct == null || !(pct >= Number(s.minPct)) || pct >= 100) return false;
  if (it.blocked || it.state === 'cool' || it.mineExhausted || it.mintTx > 0) return false;
  if (Number(s.maxAgeH) > 0 && (now - (it.bornAt || it.firstSeen)) / 3600_000 > Number(s.maxAgeH)) return false;
  if (s.free && it.free !== true) return false;
  if (s.oneClick && !it.canDo) return false;
  return true;
}

