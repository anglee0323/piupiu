// 界面设置：交易参数预设 P1–P3、战壕各列设置、快捷金额、平台选择、搜索历史、侧边面板、雷达筛选与提醒…
// 存后端 data/prefs.json（lib/prefsSync.ts），浏览器 localStorage 只当缓存：换浏览器 / 清缓存 / Electron 都不丢
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { prefsStorage } from '../lib/prefsSync'
import type { PlatformFilter } from '../lib/types'
import { emptyFilter, emptyRadarFilter, recommendedRadarFilter, defaultRadarSoon, type ColFilter, type ColKey, type RadarFilter, type RadarSoon } from '../../../shared/filters.js'   // 筛选条件和匹配规则 Gateway 与网页共用一份
export { emptyFilter, emptyRadarFilter, recommendedRadarFilter, type ColFilter, type ColKey, type RadarFilter }

export type Gas = 'normal' | 'high' | 'turbo'
export interface SideParams { slippage: number; gas: Gas; mev?: boolean }
/** 和 GMGN 一样：P1/P2/P3 是一组交易参数（滑点、Gas），不是筛选条件 */
export interface TradePreset { buy: SideParams; sell: SideParams }
export type PresetId = 1 | 2 | 3

// 列筛选 ColFilter（和 GMGN 的筛选面板同一套）：市值 / 池子 / 成交额单位 K（千美元），时间单位分钟，进度 / 税率单位 %；bond = 仅看 gang.fun 开发者押金承诺中的币。定义在 shared/filters.js
// 和 GMGN 同一套音效（lib/sound.ts 里有列表和播放）
export type SoundKind = 'Bell' | 'Boom' | 'Cheer' | 'Coins' | 'C' | 'H' | 'Handgun' | 'Kaching' | 'Nice' | 'Pop' | 'Shotgun' | 'Sonumi' | 'Yes' | 'Alipay' | 'Wechat'
const OLD_SOUND: Record<string, SoundKind> = { ding: 'Bell', coin: 'Coins', pop: 'Pop', double: 'Bell' }   // v8 之前自己合成的四种
export type Theme = 'light' | 'dark'
export type Lang = 'zh' | 'en'
export interface ColPrefs { amount: number; preset: PresetId; sound: boolean; soundKind?: SoundKind; sort: 'progress' | 'mc'; filter: ColFilter }

/** 生效的筛选条件数（列头的筛选图标、面板标签页上显示） */
export const filterCount = (f: Partial<ColFilter>) => Object.values({ ...emptyFilter(), ...f }).filter((v) => v !== '' && v !== false).length
// 机会雷达筛选：同时决定「最新 / 最高分」列表显示哪些、以及哪些新推荐会弹出提醒（和战壕「筛选 = 看到的 = 响的」一致）
// 雷达筛选 RadarFilter、空条件、推荐筛选（免费 + 一键铸造 + 评分 ≥68，默认）也在 shared/filters.js
export const radarFilterCount = (f: Partial<RadarFilter>) => { const x = { ...emptyRadarFilter(), ...f }; return [x.maxAgeH, x.minScore, x.price !== 'any' ? 1 : '', x.oneClick ? 1 : '', x.minAi, x.minPct, x.maxPct, x.keywords, x.exclude].filter((v) => v !== '').length }
const col = (amount: number, preset: PresetId): ColPrefs => ({ amount, preset, sound: false, sort: 'progress', filter: emptyFilter() })

interface Prefs {
  presets: Record<PresetId, TradePreset>
  activePreset: PresetId                 // 代币页下单面板当前用的预设
  buyAmounts: number[]                   // 下单面板 4 个快捷金额（BNB）
  sellPcts: number[]                     // 卖出快捷比例
  cols: Record<ColKey, ColPrefs>
  platforms: PlatformFilter[]                  // 顶栏「平台」选择（对应 GMGN 的链选择）
  searchHistory: string[]
  searchBuy: { amount: number; preset: PresetId }   // 搜索面板里 "⚡买入" 的金额和预设
  trackDock: boolean                     // 右侧钱包追踪面板
  confirmOrders: boolean                 // 下单前弹确认（默认开，真金白银）
  chartMetric: 'mcap' | 'price'
  theme: Theme                           // 界面主题：dark 黑暗（默认，更适合盯盘和展示）/ light 明亮
  lang: Lang                             // 界面语言（中英文字典在 shared/i18n/）
  tokenBottomH: number                   // 代币页底部面板（活动 / 交易者…）高度（px），拖动 K 线与面板之间的分隔条调整
  appIcon: 'white' | 'black'             // 桌面版的应用图标（mac Dock / Windows 任务栏），desktop/main.cjs 读 data/prefs.json 切换
  qbOpen: boolean                        // 一键买卖浮窗
  qbPos: { x: number; y: number }
  qbBuy: number[]                        // 一键买卖：8 个买入金额（BNB）
  qbSell: number[]                       // 8 个卖出比例
  topStrip: 'fav' | 'hist' | 'hold' | null   // 顶栏下面的收藏 / 持仓 / 最近浏览条
  trackSound: { on: boolean; kind: SoundKind }   // 钱包追踪：有买卖时提示音（每个钱包还能单独选声音 / 关闭，在「管理」里）
  soundVolume: number                            // 提示音音量 0–1（GMGN 默认 50%）
  topBar: TopBarPrefs                    // 顶部栏设置（左上角齿轮）
  chartInterval: number
  radarSound: { new: { on: boolean; kind: SoundKind }; hot: { on: boolean; kind: SoundKind } }   // 雷达提醒（新发现默认不出声；升温中默认 Bell）
  radarSeenAt: number                    // 上次看雷达页的时间（导航绿点 / 新推荐提示）
  radarRecSeenAt: number                 // 上次看「推荐」列表的时间：这之后新进入推荐的项目算未读
  radarBell: boolean                     // 旧版：新的「优先」项目响一声（v12 起由 radarAlert / radarAlertSound 取代）
  radarFilter: RadarFilter               // 雷达筛选（列表 + 提醒共用）
  radarAlert: boolean                    // 新推荐命中筛选时，在任意页面右上角弹出提醒卡片（可直接铸造 / 查看）
  radarAlertSound: boolean               // 弹出提醒时播放提示音
  radarAlertSecs: number                 // 雷达提醒卡片无操作多少秒后自动关闭（0 = 不自动关闭）
  radarSoon: RadarSoon                   // 雷达「即将打满」页签的条件 + 达到条件时是否弹出提醒（Gateway 的 notifier 按它判断）
  set: (p: Partial<Prefs>) => void
  setPreset: (id: PresetId, side: 'buy' | 'sell', v: Partial<SideParams>) => void
  setCol: (k: ColKey, v: Partial<ColPrefs>) => void
  setColFilter: (k: ColKey, v: Partial<ColFilter>) => void
  pushHistory: (addr: string) => void
}

/** 顶部栏设置：顶部栏里收藏 / 持仓代币的快捷交易。quick：不显示 / 常驻显示 / 悬停显示 */
export type QuickMode = 'off' | 'always' | 'hover'
export interface TopBarPrefs {
  quick: QuickMode
  favAmount: number; favPreset: PresetId; favMc: boolean; favChg: boolean      // 收藏：快捷买金额（BNB）、用哪组预设、显示市值 / 涨跌
  holdPcts: number[]; holdPreset: PresetId; holdValue: boolean; holdPnl: boolean // 持仓：快捷卖比例（最多 4 个）、预设、显示持仓金额 / 盈亏
}
export const TOPBAR_DEFAULTS: TopBarPrefs = { quick: 'hover', favAmount: 0.1, favPreset: 1, favMc: true, favChg: true, holdPcts: [25, 50, 100], holdPreset: 1, holdValue: true, holdPnl: true }

export const usePrefs = create<Prefs>()(persist((set, get) => ({
  presets: {
    1: { buy: { slippage: 20, gas: 'high', mev: true }, sell: { slippage: 20, gas: 'high', mev: true } },
    2: { buy: { slippage: 35, gas: 'turbo', mev: true }, sell: { slippage: 35, gas: 'turbo', mev: true } },
    3: { buy: { slippage: 10, gas: 'normal', mev: true }, sell: { slippage: 10, gas: 'normal', mev: true } },
  },
  activePreset: 1,
  buyAmounts: [0.01, 0.05, 0.1, 0.2],
  sellPcts: [25, 50, 75, 100],
  cols: { new: col(0.01, 1), soon: col(0.02, 1), dex: col(0.05, 3) },
  platforms: ['flap', 'four', 'gang-v1', 'gang-v2', 'gang-v3', 'gang-fair', 'gang-fly'],
  searchHistory: [],
  searchBuy: { amount: 0.01, preset: 1 },
  trackDock: false,
  confirmOrders: true,
  chartMetric: 'mcap',
  theme: 'dark',
  lang: 'zh',
  tokenBottomH: 330,
  appIcon: 'white',
  qbOpen: false,
  qbPos: { x: -1, y: 120 },
  qbBuy: [0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 1],
  qbSell: [10, 25, 50, 100, 5, 15, 35, 70],
  topStrip: null,
  topBar: TOPBAR_DEFAULTS,
  trackSound: { on: true, kind: 'Kaching' },
  soundVolume: 0.5,
  chartInterval: 60,
  radarSound: { new: { on: false, kind: 'Bell' }, hot: { on: true, kind: 'Bell' } },
  radarSeenAt: 0,
  radarRecSeenAt: 0,
  radarBell: false,
  radarFilter: recommendedRadarFilter(),
  radarAlert: true,
  radarAlertSound: true,
  radarAlertSecs: 10,
  radarSoon: defaultRadarSoon(),
  set: (p) => set(p),
  setPreset: (id, side, v) => set({ presets: { ...get().presets, [id]: { ...get().presets[id], [side]: { ...get().presets[id][side], ...v } } } }),
  setCol: (k, v) => set({ cols: { ...get().cols, [k]: { ...get().cols[k], ...v } } }),
  setColFilter: (k, v) => set({ cols: { ...get().cols, [k]: { ...get().cols[k], filter: { ...get().cols[k].filter, ...v } } } }),
  pushHistory: (addr) => set({ searchHistory: [addr.toLowerCase(), ...get().searchHistory.filter((x) => x !== addr.toLowerCase())].slice(0, 20) }),
}), {
  name: 'terminal-prefs',
  storage: createJSONStorage(() => prefsStorage),
  version: 21,
  // 每一步只在「从更早的版本升上来」时跑一次。以前没判断版本，每次升版本号都会把所有步骤重跑一遍——
  // 其中市值筛选 ÷1000 那步在 v6、v7 升级时又各执行了一次，已保存的市值筛选值被缩小了
  migrate: (s: any, from: number) => {
    if (s && from < 4 && Array.isArray(s.platforms)) {   // gang 拆成 V1 / V2 / V3（v3），v4 加「Gang 打新」
      const out = new Set<string>(s.platforms.filter((x: string) => x !== 'gang'))
      if (s.platforms.includes('gang')) { out.add('gang-v1'); out.add('gang-v2'); out.add('gang-v3') }
      if (out.has('gang-v3')) out.add('gang-fair')   // 新增的「Gang 打新」：选了 V3 的默认也看打新
      s.platforms = [...out].filter((x) => ['flap', 'four', 'gang-v1', 'gang-v2', 'gang-v3', 'gang-fair'].includes(x))
      if (!s.platforms.length) s.platforms = ['flap', 'four', 'gang-v1', 'gang-v2', 'gang-v3', 'gang-fair']
    }
    // v5：筛选改成 GMGN 那套字段，市值从美元改成 K
    if (s?.cols && from < 5) for (const k of Object.keys(s.cols)) {
      const f = s.cols[k]?.filter || {}
      const k1 = (v: string) => (v === '' || v == null || !isFinite(Number(v)) ? '' : String(Number(v) / 1000))
      s.cols[k].filter = { ...emptyFilter(), ...f, minMc: k1(f.minMc), maxMc: k1(f.maxMc) }
    }
    if (s && from < 6) s.topBar = { ...TOPBAR_DEFAULTS, ...(s.topBar || {}) }   // v6：顶部栏设置
    // v11：推荐未读单独记时间（在「已关注」时也能看到「有 N 个新推荐」）
    if (s && from < 11) s.radarRecSeenAt = s.radarSeenAt || 0
    // v12：雷达筛选 + 命中弹窗（用户要求：待在战壕页也能看到新机会并直接铸造）。声音沿用以前「推荐提醒」的开关
    // v14：雷达默认筛选改成「免费 + 支持一键铸造 + 评分 ≥68」（原来没有筛选，一小时弹好几张卡片）。只改还是空筛选的，用户自己设过的不动
    if (s && from < 14 && !(s.radarFilter && Object.values(s.radarFilter).some((v) => v !== '' && v !== false && v !== 'any'))) s.radarFilter = recommendedRadarFilter()
    if (s && from < 12) { s.radarFilter = emptyRadarFilter(); s.radarAlert = true; s.radarAlertSound = !!s.radarBell }
    // v16：主题（默认浅色，原来的暗色可在设置里切回）+ 界面语言；v17：主题改名为 明亮 light / 黑暗 dark
    if (s && from < 16) { s.theme = 'light'; s.lang = s.lang === 'en' ? 'en' : 'zh' }
    if (s && from < 17) { s.theme = s.theme === 'gmgn' || s.theme === 'dark' ? 'dark' : 'light'; if (s.radarAlertSecs == null) s.radarAlertSecs = 10 }   // v17 也加了雷达提醒卡片自动关闭秒数
    if (s && from < 18) s.appIcon = s.appIcon === 'black' ? 'black' : 'white'   // v18：应用图标可选白色 / 黑色（默认白色）
    if (s && from < 19) s.tokenBottomH = 330
    // v20：Gang 铸币飞轮单独一类；选着 Gang 打新的（默认全选）一起加上，免得飞轮币被筛掉看不到
    // v21：预设加「防夹」（币安市价单的 MEV 保护），原有预设一律补成开
    if (s && from < 21 && s.presets) for (const id of [1, 2, 3]) for (const sd of ['buy', 'sell']) { const p = s.presets[id]?.[sd]; if (p && p.mev == null) p.mev = true }
    if (s && from < 20 && Array.isArray(s.platforms) && s.platforms.includes('gang-fair') && !s.platforms.includes('gang-fly')) s.platforms = [...s.platforms, 'gang-fly']   // v19：代币页 K 线与底部面板之间可拖动
    // v15：雷达加「即将打满」（已铸比例达到门槛、还没铸完的项目，可筛上线时间，达标时提醒）
    if (s && from < 15) s.radarSoon = defaultRadarSoon()
    // v10：雷达只留一个「新的优先项目响一声」开关，默认关（以前两个声音按钮用户看不懂）
    if (s && from < 10) s.radarBell = false
    // v9：雷达（新发现 / 升温中的提醒音 + 上次看过雷达页的时间）
    if (s && from < 9) { s.radarSound = { new: { on: false, kind: 'Bell' }, hot: { on: true, kind: 'Bell' } }; s.radarSeenAt = 0 }
    // v8：换成 GMGN 的音效。战壕三列按原来的开关保留、音效换成相近的；追踪默认 Kaching；音量默认 50%（以前合成音偏小，按 100% 设的）
    if (s && from < 8) {
      if (s.cols) for (const k of Object.keys(s.cols)) if (s.cols[k]) s.cols[k].soundKind = OLD_SOUND[s.cols[k].soundKind] || s.cols[k].soundKind || 'Bell'
      s.trackSound = { on: s.trackSound?.on ?? true, kind: 'Kaching' }
      if (typeof s.soundVolume !== 'number' || s.soundVolume === 1) s.soundVolume = 0.5
    }
    return s
  },
  merge: (saved: any, cur) => ({ ...cur, ...saved, radarFilter: { ...emptyRadarFilter(), ...(saved?.radarFilter || {}) }, radarSoon: { ...defaultRadarSoon(), ...(saved?.radarSoon || {}) }, topBar: { ...TOPBAR_DEFAULTS, ...(saved?.topBar || {}) }, trackSound: { ...cur.trackSound, ...(saved?.trackSound || {}) },
    radarSound: { new: { ...cur.radarSound.new, ...(saved?.radarSound?.new || {}) }, hot: { ...cur.radarSound.hot, ...(saved?.radarSound?.hot || {}) } } }),
}))

// 主题挂到 <html data-theme>：在设置变化的同一刻同步改（早于各组件重新渲染）。
// K 线等按 CSS 变量取色的地方在渲染时读颜色，放在 effect 里改会读到上一个主题的颜色
usePrefs.subscribe((s, prev) => { if (s.theme !== prev.theme && typeof document !== 'undefined') document.documentElement.dataset.theme = s.theme === 'dark' ? 'dark' : 'light' })
