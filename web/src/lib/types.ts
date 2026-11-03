// 后端（server.js / engine/live）返回的数据结构。只列页面用到的字段。

export type Platform = 'flap' | 'four' | 'gang'
/** 顶栏发射台筛选：gang 按版本拆成 V1 / V2 / V3（V3 含打新） */
export type PlatformFilter = 'flap' | 'four' | 'gang-v1' | 'gang-v2' | 'gang-v3' | 'gang-fair' | 'gang-fly'
export type Stage = 'curve' | 'dex' | 'removed' | string

export interface Chg { launch: number | null; m5: number | null; h1: number | null; h24: number | null }

// 我持有的 NFT（雷达铸造历史 + 分析时读到持有的合约）：数量、编号。不估值（OKX 对这些合集没有挂单价）
export interface NftRow {
  address: string; title: string; name: string | null; std: string; image: string | null
  count: number; ids: { slot: number; id: string; amount: string | null }[]; perSlot: { slot: number; count: number }[]
  minted: { tx: number; nft: number; transfers: number; lastAt: number | null }
}
export interface NftSnap { at: number; rows: NftRow[]; total: number }
export interface GangBond {
  state: 'active' | 'slashed' | 'settled' | 'refunded' | string; phase: string | null; round: number
  creator: string; creatorHandle: string | null; quote: string; amount: string; valueBnb: number | null
  holdPct: number | null; holdOfBalancePct: number | null; days: number | null; deadline: number | null; postedAt: number | null
  coveragePct: number | null; tier: 'full' | 'bond' | 'gray' | null; qualified: boolean; violated: boolean; live: boolean
  burnLeft: string; tokensBurned: string; tx: string | null; checkedAt: number | null
}
export interface Token {
  address: string
  symbol: string
  name: string
  platform: Platform
  source: string
  agentExclusive?: boolean
  preset?: string
  quote: string
  quoteAddress?: string | null
  creator?: string
  creatorName?: string | null
  firstBuyer?: string
  firstBuyerName?: string | null
  createdAt: number
  stage: Stage
  price: number
  priceUsd: number
  mcapUsd: number
  mcapEst?: boolean
  liqUsd?: number
  quoteUsd?: number
  raised: number
  target: number
  progress: number
  holders: number | null
  buys: number
  sells: number
  volume: number
  dexVol24?: number | null
  dexVolUsd24?: number | null
  dexTx24?: { buys: number; sells: number } | null
  dexChg?: { m5: number | null; h1: number | null; h24: number | null } | null
  migratedAt?: number | null
  buyTax?: number
  sellTax?: number
  buyFeePct?: number
  sellFeePct?: number
  antiSniper?: boolean
  antiSniperPct?: number
  lastTradeAt?: number
  chg?: Chg
  image?: string | null
  gangTrack?: string | null
  gangFair?: GangFair | null
  gangFly?: GangFly | null
  gangBond?: GangBond | null   // gang.fun Agent 押金承诺：开发者承诺持有 ≥ X 个直到开盘后 N 天，卖了押金被罚没回购销毁
  gangV3?: { buyTaxBps: number; sellTaxBps: number; dividendBps: number; recipientLabel?: string | null } | null
  gangDiv?: { taxed?: boolean; taxBps?: number; divBps?: number; flap?: boolean } | null
  flapTax?: { buyBps: number; sellBps: number; divBps?: number; mktBps?: number; divSym?: string; beneficiaryName?: string | null } | null
  nftGate?: { capPct?: number; nft?: string; removed?: boolean; known?: boolean; name?: string } | null
  description?: string
  website?: string
  twitter?: string
  telegram?: string
}

/** Gang 打新：固定价认购，10000 份卖完自动开盘 */
export interface GangFair {
  status: 'minting' | 'launched' | string
  sold: number; totalShares: number; participants: number
  capShares: number; minParticipants: number; sharesLeft: number; minWalletsLeft: number
  sharePrice: number; raiseQuote: number
  holdPct: number; mintFeePct: number; exitFeePct: number; exitFeeNowPct: number
  stale: boolean; exitFeeFreeAt: number | null; lastMintAt: number | null
}

/** 铸币飞轮（gang.fun GangFlywheelPad）：开盘前按份铸造，打满后开池；金额是计价币（目前都是 WBNB）单位 */
export interface GangFly {
  status: 'minting' | 'filled' | 'launched' | 'refund' | string
  pad: string | null; padVersion: number | null; gated: boolean; wbnb: boolean
  sharePriceWei: string; sharePrice: number; basePrice: number; tokensPerShare: number
  totalShares: number; sold: number; sharesLeft: number; mintedShares: number; postMints: number; participants: number; minWalletsLeft: number
  baseQuota: number; inviteBonus: number; maxPerTx: number; holdPct: number
  mintFeePct: number; exitFeePct: number; exitFeeNowPct: number; exitFeeFreeAt: number | null
  devCutPct: number; buyPct: number; buyTaxPct: number; sellTaxPct: number
  launchDelay: number; windowSec: number; windowCapMul: number
  postMint: boolean; tierMode: number; supplyCapMul: number; guardPct: number; twapMin: number
  sellBackOpen: boolean; withdrawable: boolean; refundOnly: boolean; stale: boolean; mintPaused: unknown
  filledAt: number | null; filledEarly: boolean | null; launchAt: number | null; launchedAt: number | null; lastMintAt: number | null
}

export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

export interface Trade {
  ts: number
  side: 'buy' | 'sell'
  bnb: number          // 计价币数量
  tokens: number
  price: number
  trader: string
  tx: string
  name?: string | null
  usd?: number
  mcapUsd?: number
  // 全市场成交流额外带
  address?: string
  symbol?: string
  platform?: Platform
}

export interface TokenDetail extends Token { candles: Candle[]; trades: Trade[] }

export interface AuthState { state: 'ok' | 'checking' | 'logged_out' | 'error' | string; agentId?: string | null; address?: string | null; message?: string; code?: string; codeP?: Record<string, string> | null }
export interface BawStatus { connected: boolean; error: string | null; dryRun: boolean; maxTradeBnb: number; auth?: AuthState; login?: LoginView | null }
export interface LoginView { id: string; state: string; urlForWeb?: string; pairingCode?: string; expireAt?: number; message?: string; address?: string | null }

export interface WalletView { id: string; slot?: number; label: string; address: string; bnb: number; agentId?: boolean }

/** 钱包槽位（多钱包）：一个后端进程里管理 N 个币安账号（docs/PLAN-MULTI-WALLET.md） */
export interface SlotLogin { state: string; urlForWeb?: string; pairingCode?: string; message?: string; expireAt?: number }
export interface SlotView {
  slot: number
  label: string
  customName: boolean
  /** 新加的槽位还没扫码成功过（页面列表不显示） */
  fresh?: boolean
  primary: boolean
  auth: string
  authMessage: string
  /** 状态说明的文案键（有就按当前语言显示，没有用 authMessage 原文） */
  authCode?: string
  authCodeP?: Record<string, string> | null
  agentId: string | null
  address: string | null
  bnb: number | null
  login: SlotLogin | null
}
export interface SlotsInfo {
  slots: SlotView[]
  primary: number
  /** 全局「交易钱包」：所有一键买卖共用（存在后端） */
  tradeSlots: number[]
  canAdd: boolean
  bawVersion: string | null
  canAddReason: string | null
}

export interface NetStatus { wss: number | null; rpc: number | null; detect: number; wssState?: string; rpcNode?: { active?: string } }

export interface Settings {
  gas: 'normal' | 'high' | 'turbo' | string
  autoClaim: boolean
  sellToBnb: boolean
  preApproveCap: boolean
  sendTo?: string
  nftSendTo?: string   // NFT 转出地址（如自己的 OKX 钱包），填一次保存
  autoSendAfterClaim?: boolean
  autoSendFourMigrated?: boolean
  autoSendGangMigrated?: boolean
}

export interface Order {
  // 这笔成交收取的交易手续费（BNB）
  feeBnb?: number
  id: string
  ts: number
  wallet?: string
  walletSlot?: number
  /** 同一次多钱包下单共用（页面把同一批的提示合成一个） */
  batchId?: string | null
  skipped?: boolean
  token: string
  symbol?: string
  platform?: string
  side: 'buy' | 'sell' | string
  amount: number
  status: 'pending' | 'filled' | 'failed' | 'unknown' | string
  reason?: string | null
  dryRun?: boolean
  tx?: string | null
  out?: number
  amountIn?: number
  venue?: string
  latencyMs?: number
  source?: string
  via?: string | null
}

export interface HoldingRow {
  token: string
  symbol: string
  name: string
  platform: Platform
  image: string | null
  stage: string
  amount: number
  supplyPct: number | null
  price: number
  quote: string
  valueBnb: number | null
  valueUsd: number | null
  costUsd: number
  soldUsd: number
  pnlUsd: number | null
  pnlPct: number | null
  avgBuyUsd: number | null
  firstAt: number | null
  warn?: string | null
}

export interface Holdings {
  rows: HoldingRow[]
  wallets?: { slot: number; label: string; bnb: number; address: string }[]
  bnb: number
  wbnb?: number
  bnbUsd: number
  updatedAt: number
  totals: { valueUsd: number; costUsd: number; soldUsd: number; pnlUsd: number; open: number }
}

export interface Preview { route?: string; amountIn?: number; out?: number; minOut?: number; feeBnb?: number; feePct?: number; note?: string | null; error?: string }

export interface Audit {
  available: boolean
  reason?: string
  error?: string
  level?: number
  buyTax?: number | null
  sellTax?: number | null
  verified?: boolean | null
  flagged?: boolean
  reported?: boolean
  unusualTax?: boolean
  appConfirm?: boolean
  hits?: { group: string; title: string; desc: string; type: string }[]
}

export interface TrackTarget { address: string; name?: string; domain?: string | null; remark?: string; group?: string; sound?: boolean | import('../store/prefs').SoundKind }   // true / 不填 = 跟随默认，false = 不提醒，声音名 = 这个钱包专用
export interface TrackEvent {
  id: string
  ts: number
  target: string
  targetName?: string | null
  action: string
  backfill?: boolean
  side: 'buy' | 'sell'
  token: string
  symbol: string
  image?: string | null
  platform?: Platform
  quote?: string
  bnb: number
  usd?: number | null
  pct?: number | null
  mcapUsd?: number | null
  createdAt?: number | null
  tx: string
}

export interface Favorites { groups: string[]; items: Record<string, { group: string; at: number; symbol?: string; platform?: string | null }> }
export interface Blocklist { tokens: Record<string, unknown>; devs: Record<string, unknown> }

export interface CondResult { ts: number; mc?: number | null; amount?: number; ok: boolean; skipped?: boolean; reason?: string | null; tx?: string | null; dryRun?: boolean }
export interface CondOrder {
  id: string
  kind: 'limit' | 'tp' | 'sl' | 'dca'
  side: 'buy' | 'sell'
  token: string
  symbol: string
  platform?: Platform
  createdAt: number
  status: 'open' | 'running' | 'done' | 'failed' | 'cancelled' | 'expired'
  slippage: number
  createdMc: number | null
  triggerMc?: number
  cmp?: 'lte' | 'gte'
  amount?: number
  pct?: number
  parts?: number
  intervalSec?: number
  done?: number
  nextAt?: number
  guardMc?: number | null
  expireAt?: number | null
  slots?: number[]   // 多钱包：创建时记下的下单钱包（槽位号）；旧单没有 = 触发时用当时的全局选择
  results: CondResult[]
}

// 机会雷达（/radar）：列表一行是一个机会（同一套代码的多个合约合成「系列」），详情讲清楚是什么 / 怎么运作 / 值不值得 / 怎么参与
export type RadarLevel = 'go' | 'easy' | 'watch' | 'careful' | 'skip' | 'done'
export interface RadarVerdict { level: RadarLevel; label: string; why: string }
export interface RadarItem {
  id: string; address: string; members: number; title: string
  kind: string | null; kindLabel: string | null; oneLine: string | null; verdict: RadarVerdict | null; note: string | null; creator: string | null
  canDo: boolean; aiOnly: 'verified' | 'likely' | 'open' | 'unknown' | null; analyzed: boolean; analyzing: boolean
  state: 'new' | 'hot' | 'cool'; followed: boolean; joined: boolean
  firstSeen: number; lastAiAt: number; aiCallers: number; last10: number; bars: { t: number; n: number }[]; score: number
  keys: string[]; rec: boolean; recAt: number; mintTx: number; nft: number; mineExhausted?: boolean
  bornAt?: number; bornBy?: 'deploy' | 'seen'   // 上线时间：合约部署时间；未开源合约为雷达首次发现时间
  historyOnly?: boolean; followOnly?: boolean; blocked?: boolean
  priority: { score: number; level: 'high' | 'mid' | 'low'; label: string; top: string[]; minus: string[] } | null
  image: string | null; name: string | null; utility: string | null; free: boolean | null; price: string | null
  supply: { minted: number | null; max: number | null; pct: number | null } | null
  social: { count: number; official: string | null } | null; hasSite: boolean; mine: number; queuePos: number | null
  tagline: string | null; why: string[]; whyNot: string[]
  taglineEn?: string | null; whyK?: RadarKP[]; whyNotK?: RadarKP[]; titleK?: RadarKP | null   // 英文界面：原文描述、按文案键显示的理由
}
/** 网关给的文案键 + 参数（界面按当前语言显示）；没有键的旧数据用中文原文 */
export interface RadarKP { k: string; p?: Record<string, string | number | null> }
export interface RadarPriority { score: number; level: 'high' | 'mid' | 'low'; label: string; parts: { pts: number; why: string; k?: string; p?: Record<string, string | number | null> }[] }
export interface RadarSocial { enabled: boolean; pending?: boolean; searchUrl: string; query?: string; count: number; byAddr?: number; byName?: number; lists?: number; last24h?: number; error?: string | null; official: { handle: string; url: string; from: string } | null; top: { user: string | null; name: string | null; followers: number | null; text: string; zh?: string | null; likes: number; rts: number; at: number | null; url: string | null; how?: 'addr' | 'name'; list?: boolean }[] }
export interface RadarHoldings { std: string; sendTo: string | null; rows: { slot: number; address: string; label: string; std: string; balance: number | null; amount?: string; ids: { id: string; amount?: string }[] }[] }
export interface RadarView {
  items: RadarItem[]
  activity: { active: number; rows: { key: string; label: string; address: string | null; cand: boolean; ai: number }[]; other: number }
  trend: { kind: string; label: string; gate?: boolean; free?: boolean; count: number; ai: number; creators: number; lead: string }[]
  recCount: number
  hidden: { address: string; title: string; at: number }[]
  status: { scanning: boolean; cursor: number; behind: number; gaps: number; node: string; via?: string; lastError: string | null; aiKnown: number; todayNew: number; queue: number; platform: { kind: string; text: string }[]; social?: { day: string; today: number; total: number; failures: number; enabled: boolean; max?: number; capped?: boolean } }
  settings: { scan: boolean; minAi: number; aiRatioPct: number; hotMult: number; hotMin: number; coolMin: number; maxValueBnb: number; quickMint: boolean; quickMintMax: number; autoMint: boolean; autoMintMax: number; xDailyMax: number }
  canTrade: boolean
}
export interface RadarCall { t: number; from: string; name: string | null; ai: boolean; fn: string | null; value: string; hash: string; ok?: boolean; got?: { token: string; std: string; amount: string }[] | null }
export interface RadarMint { id: string; kind?: 'transfer'; ts: number; address: string; symbol: string | null; slot: number; from: string; to?: string; tokenId?: string; valueWei: string; qty: number; status: string; tx?: string; reason?: string | null; got?: { token: string; std: string; amount: string; id?: string }[] }
export interface RadarAnalysis {
  at: number; name: string | null; symbol: string | null; fn: string | null; selector: string | null
  cls: { kind: string; valueWei: string | null; perCall: string | null; gasWei: string | null; token?: string | null; std?: string | null }
  recipe: { supported: boolean; why?: string; whyK?: string; whyP?: Record<string, string | number>; selector?: string; qtyWord: number | null; qtySeen?: number[]; samples?: number } | null
  aiOnly: { state: string; why: string | null; k?: string; p?: Record<string, string> }
  mine: { slot: number; address: string; ok: boolean; valueWei?: string; gas?: string | null; reason?: string; friendly?: string | null; limit?: string | null; minted?: number | null }[]
  mineExhausted?: boolean
  received: { token: string; symbol: string | null; usd?: number | null; priceUsd?: number | null; dex?: string | null } | null
  profile: { size: number; codeHasAgentId: boolean; proxy: { kind: string; impl?: string | null } | null; erc721: boolean; erc1155: boolean; erc20: boolean; totalSupply: string | null; maxSupply: string | null; owner: string | null; paused: boolean | null }
  src: { verified: boolean | null; name: string | null; risks: { label: string; level: number; fn: string }[]; links: string[]; deployer: string | null }
  creator: { address: string; name: string | null; others: { address: string; symbol: string | null; name: string | null }[] } | null
  notice: string | null; noticeZh: string | null; fnDoc: string | null; fnDocZh: string | null
  site: { at: number; pages: { url: string; ok: boolean; title?: string; desc?: string; text?: string; zh?: string; guide?: boolean; error?: string; social?: boolean }[] } | null
  review: { oneLine: string; explain: string; facts: [string, string][]; pros: string[]; cons: string[]; evidence?: Record<string, { level: 'none' | 'source' | 'chain' | 'sim' | 'done'; k: string }>; verdict: RadarVerdict; howTo: string[]; needWei: string | null; canDo: boolean
    vals?: { perCall: { n: string; unit: string } | null; supply: { minted: number | null; max: number | null; pct: number | null } | null; perWallet: number | null } }
  reviewEn?: { explain: string; cons: string[] }   // 英文界面的简介与风险提示
  project: { name: string | null; description: string | null; descriptionZh: string | null; image: string | null; onchain: boolean; attributes: { k: string; v: string }[]; links: string[] } | null
  utility: { summary: string; list: { id?: string; tag: string; why: string; fn?: string; src: 'contract' | 'text' }[] } | null
  social: RadarSocial | null
  markets: { name: string; url: string; note?: string }[]
}
export interface RadarDetail {
  address: string; name: string | null; symbol: string | null; state: string; followed: boolean; blocked?: boolean; historyOnly?: boolean
  firstSeen: number; lastAiAt: number; mintTx?: number; nft?: number; transfers?: number; rec?: boolean; recAt?: number | null
  stats: { aiCallers: number; callers: number; ratio: number; last10: number; prev10: number; bars: { t: number; n: number }[] } | null
  analysis: RadarAnalysis | null; analyzing: boolean; links: string[]
  family: { address: string; symbol: string | null; name: string | null; state: string; aiCallers: number; verdict: RadarVerdict | null; canDo: boolean; oneLine: string | null }[]
  creatorOthers: { address: string; symbol: string | null; name: string | null; verdict: RadarVerdict | null }[]
  calls: RadarCall[]; mints: RadarMint[]; maxValueBnb: number
  priority: RadarPriority | null; queuePos: number | null; sendTo: string | null
}
