// shared/filters.js 的类型声明（网页 TypeScript 用；Gateway 直接用 JS）

export type PlatformFilter = 'flap' | 'four' | 'gang-v1' | 'gang-v2' | 'gang-v3' | 'gang-fair' | 'gang-fly'
export type ColKey = 'new' | 'soon' | 'dex'

export interface ColFilter {
  keywords: string; exclude: string; dev: string; social: boolean; bond: boolean
  minProgress: string; maxProgress: string; minAge: string; maxAge: string
  minLiq: string; maxLiq: string; minMc: string; maxMc: string; minVol: string; maxVol: string
  minHolders: string; maxHolders: string; minTax: string; maxTax: string
}
export interface RadarFilter {
  maxAgeH: string; minScore: string; price: 'any' | 'free' | 'max'; maxBnb: string; oneClick: boolean; minAi: string; minPct: string; maxPct: string; keywords: string; exclude: string
}
/** 雷达「即将打满」：已铸比例门槛、上线时间（小时，0 = 不限）、仅免费、仅一键铸造、是否弹出提醒 */
export interface RadarSoon { minPct: number; maxAgeH: number; free: boolean; oneClick: boolean; alert: boolean }

/** 筛选需要用到的代币字段（结构类型，网页的 Token 满足它） */
export interface TokenLike {
  address: string; symbol: string; name: string; platform: string; gangTrack?: string | null; stage: string; progress: number
  createdAt: number; migratedAt?: number | null; creator?: string | null; creatorName?: string | null
  website?: string | null; twitter?: string | null; telegram?: string | null
  liqUsd?: number | null; mcapUsd?: number | null; holders?: number | null; buyFeePct?: number | null; sellFeePct?: number | null
  volume?: number | null; quoteUsd?: number | null; dexVol24?: number | null; dexVolUsd24?: number | null
  gangBond?: { state?: string; violated?: boolean } | null
}
/** 雷达筛选需要用到的项目字段 */
export interface RadarItemLike {
  address: string; title: string; name?: string | null; tagline?: string | null; kindLabel?: string | null
  bornAt?: number | null; firstSeen: number; priority?: { score?: number } | null; free?: boolean | null; price?: string | null
  canDo?: boolean; mineExhausted?: boolean; aiCallers: number; supply?: { pct?: number | null } | null
  blocked?: boolean; state?: string; mintTx?: number
}
export interface ColumnCtx { platforms: PlatformFilter[]; isBlocked?: (t: TokenLike) => boolean; bnbUsd: number; now?: number }

export function emptyFilter(): ColFilter
export function emptyRadarFilter(): RadarFilter
export function recommendedRadarFilter(): RadarFilter
export function gangVer(t: { gangTrack?: string | null }): 'gang-v1' | 'gang-v2' | 'gang-v3' | 'gang-fair' | 'gang-fly'
export function launchpadOf(t: { platform: string; gangTrack?: string | null }): PlatformFilter
export function inPlatforms(t: { platform: string; gangTrack?: string | null }, sel: PlatformFilter[]): boolean
export function volUsd(t: TokenLike, bnbUsd: number): number
export function bondActive(t: TokenLike): boolean
export function matchColumn(t: TokenLike, k: ColKey, f: Partial<ColFilter> | null | undefined, ctx: ColumnCtx): boolean
export function sortColumn<T extends TokenLike>(list: T[], k: ColKey, sort?: 'progress' | 'mc'): T[]
export function matchRadar(it: RadarItemLike, f: Partial<RadarFilter> | null | undefined, now?: number): boolean
export declare function defaultRadarSoon(): RadarSoon
export declare const RADAR_SOON_PCTS: number[]
export declare const RADAR_SOON_AGES: [number, string][]
export declare function matchRadarSoon(it: RadarItemLike, s?: Partial<RadarSoon> | null, now?: number): boolean
