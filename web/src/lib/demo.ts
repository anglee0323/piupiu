// 在线体验（官网 /preview/）：没有后端。读取类接口从录制的样本（demo/fixtures.json 和 demo/token、demo/radar 下的文件）里取，
// 写入类接口一律不执行，弹出「下载 Piupiu」说明。样本由私有仓库 piupiu-cloud 的 scripts/capture-demo.mjs 录制：
// 真实行情（去掉个人数据）+ 一位正常使用中的用户（两个演示钱包、持仓、订单、追踪、跟单、狙击、条件单、已铸 NFT），每个页面都有内容。
// 时间整体平移到「现在」（录制时间 → 打开时间），新币、成交、动态的「几分钟前」始终是新鲜的；之后按样本做小幅行情变化和新成交。
import { asset } from './env'
import { useUI } from '../store/ui'
import { usePrefs } from '../store/prefs'

export const DEMO_BLOCKED = '__demo__'   // 写入类接口被拦下时的错误标记：不弹出错提示（已经弹了说明框）

// ---------- 时间平移：录制时的时间戳整体挪到现在（毫秒和秒两种单位都有，按数值范围判断） ----------
const TIME_KEYS = new Set(['t', 'ts', 'at', 'createdAt', 'migratedAt', 'lastTradeAt', 'firstSeen', 'lastSeen', 'lastAiAt', 'bornAt', 'recAt', 'metaAt', 'seenAt', 'addedAt', 'backfilledAt',
  'firstAt', 'updatedAt', 'historyAt', 'syncedAt', 'expireAt', 'nextAt', 'lastAt', 'lastHeadAt', 'detectAt', 'lastLogAt', 'lastEventAt', 'openedAt', 'pingAt', 'connectedAt'])
let base = 0, shift = 0
function shiftTimes<T>(v: T, key?: string): T {
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = shiftTimes(v[i], key); return v }
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) (v as any)[k] = shiftTimes((v as any)[k], k); return v }
  if (typeof v === 'number' && key && TIME_KEYS.has(key) && shift) {
    if (v > base - 400 * 864e5 && v < base + 864e5) return (v + shift) as T                                          // 毫秒
    if (v > base / 1000 - 400 * 86400 && v < base / 1000 + 86400) return (v + Math.round(shift / 1000)) as T          // 秒（K 线）
  }
  return v
}

let fx: Promise<any> | null = null
const load = () => (fx ??= fetch(asset('demo/fixtures.json')).then((r) => r.json()).then((f) => {
  base = f.capturedAt || Date.now()
  shift = Math.max(0, Math.round((Date.now() - base) / 60_000) * 60_000)   // 按整分钟平移，K 线的分钟边界不变
  return shiftTimes(f)
}))
const files = new Map<string, Promise<any>>()   // demo/token、demo/radar 下按需取的文件（取到后同样平移时间）
const file = (path: string) => {
  if (!files.has(path)) files.set(path, load().then(() => fetch(asset(path))).then((r) => (r.ok ? r.json() : null)).then((d) => (d ? shiftTimes(d) : null)).catch(() => null))
  return files.get(path)!
}

class DemoError extends Error { status: number; constructor(m: string, s = 404) { super(m); this.status = s } }

export async function demoApi(url: string, body?: unknown, init?: RequestInit): Promise<any> {
  const f = await load()
  const u = new URL(url, location.origin)
  const p = u.pathname
  const method = (init?.method || (body === undefined ? 'GET' : 'POST')).toUpperCase()
  if (method !== 'GET') { useUI.getState().set({ loginOpen: true, connectHint: false }); throw new DemoError(DEMO_BLOCKED, 400) }
  const m = (re: RegExp) => re.exec(p)
  let r: RegExpExecArray | null
  if (p === '/api/state') return structuredClone(f.state)
  if (p === '/api/favorites') return structuredClone(f.favorites || { groups: ['默认'], items: {} })   // i18n-ignore（分组名是数据值）
  if (p === '/api/blocklist') return { tokens: {}, devs: {} }
  if (p === '/api/nft') return structuredClone(f.nft || { at: Date.now(), rows: [], total: 0 })
  if (p === '/api/cond') return structuredClone(f.cond || [])
  if (p === '/api/track') return structuredClone(liveTrack(f))
  if (p === '/api/names') return { ver: 1, names: f.names || {} }
  if ((r = m(/^\/api\/token\/(0x[0-9a-fA-F]{40})$/))) {
    const a = r[1].toLowerCase()
    const d = await file(`demo/token/${a}.json`)
    if (d) { const { __audit, ...rest } = d; void __audit; return structuredClone(rest) }
    return { ...(f.state.tokens.find((t: any) => t.address.toLowerCase() === a) || {}), candles: [], trades: [] }
  }
  if (m(/^\/api\/trades\//)) return []
  if ((r = m(/^\/api\/lookup\/(0x[0-9a-fA-F]{40})$/))) { const t = f.state.tokens.find((x: any) => x.address.toLowerCase() === r![1].toLowerCase()); if (t) return structuredClone(t); throw new DemoError('—') }
  if ((r = m(/^\/api\/trader\/(0x[0-9a-fA-F]{40})\/(0x[0-9a-fA-F]{40})$/))) return traderStats(f, await file(`demo/token/${r[1].toLowerCase()}.json`), r[2])
  if (p === '/api/preview') return preview(f, u.searchParams)
  if ((r = m(/^\/api\/audit\/(0x[0-9a-fA-F]{40})$/))) { const d = await file(`demo/token/${r[1].toLowerCase()}.json`); return d?.__audit || { available: false, reason: 'unsupported' } }
  if (p === '/api/radar') return structuredClone(f.radar)
  // 铸造记录、项目详情里的「我的持仓」：按样本里已铸的 NFT（资产页 NFT 同一份）
  if (p === '/api/radar/history') return { items: (f.nft?.rows || []).map((x: any) => ({ id: 'm-' + x.address, ts: x.minted?.lastAt || Date.now(), address: x.address, symbol: x.title, slot: 1, from: f.state.wallets?.[0]?.address, valueWei: '0', qty: x.count, status: 'done', tx: '0x' + (x.address.slice(2) + x.address.slice(2)).slice(0, 64), got: x.ids.map((i: any) => ({ token: x.address, std: x.std, amount: '1', id: i.id })), nft: x.count })) }
  if ((r = m(/^\/api\/radar\/(0x[0-9a-fA-F]{40})\/holdings$/))) {
    const row = (f.nft?.rows || []).find((x: any) => x.address.toLowerCase() === r![1].toLowerCase()), w = f.state.wallets?.[0]
    return { std: row?.std || '721', sendTo: null, rows: row && w ? [{ slot: 1, address: w.address, label: w.label, std: row.std, balance: row.count, ids: row.ids.map((i: any) => ({ id: i.id })) }] : [] }
  }
  if ((r = m(/^\/api\/radar\/(0x[0-9a-fA-F]{40})$/))) {
    const a = r[1].toLowerCase()
    const d = f.radarDetails?.[a] ?? await file(`demo/radar/${a}.json`)   // 雷达项目详情每个一份文件，点到哪个再取哪个
    if (d) return structuredClone(d)
    throw new DemoError('—')
  }
  if (p === '/api/setup') return { appMode: false, live: true, liveTrade: true, dismissedAt: Date.now(), steps: [], done: true, wallet: null }
  if (p === '/api/app') return { app: false }
  if (p === '/api/automation') { const a = f.automation || {}; return structuredClone(a[u.searchParams.get('lang') || usePrefs.getState().lang] || a.zh || a) }
  if (p === '/api/quote-balances' || p === '/api/approvals') return []
  if (p === '/api/snipe') return structuredClone(f.snipe)
  if (p === '/api/copy') return structuredClone(f.copy || { tasks: [], paused: false, log: [] })
  if (p === '/api/holdings') return structuredClone(f.state.holdings || { rows: [], bnb: 0, wbnb: 0, bnbUsd: f.state.bnbUsd, updatedAt: Date.now(), totals: { valueUsd: 0, costUsd: 0, soldUsd: 0, pnlUsd: 0, open: 0 } })
  throw new DemoError('—')
}

// ---------- 交易者详情（代币页点成交里的地址）和下单前的报价：按样本里的成交和价格算，公式和 Gateway 一致 ----------
function traderStats(f: any, d: any, trader: string) {
  const me = trader.toLowerCase()
  const list = ((d?.trades || []) as any[]).filter((x) => String(x.trader || '').toLowerCase() === me).sort((a, b) => a.ts - b.ts)
  const buys = list.filter((x) => x.side === 'buy'), sells = list.filter((x) => x.side === 'sell')
  const sum = (a: any[], k: string) => a.reduce((s, x) => s + (Number(x[k]) || 0), 0)
  const bT = sum(buys, 'tokens'), bQ = sum(buys, 'bnb'), sT = sum(sells, 'tokens'), sQ = sum(sells, 'bnb')
  const hold = Math.max(0, bT - sT), avgBuy = bT ? bQ / bT : null, holdQ = hold * (d?.price || 0)
  const realized = avgBuy != null ? sQ - avgBuy * Math.min(sT, bT) : sQ, unrealized = avgBuy != null ? holdQ - avgBuy * hold : holdQ
  const qUsd = d?.quoteUsd || f.state.bnbUsd
  return { address: d?.address, symbol: d?.symbol, quote: d?.quote || 'BNB', trader, name: f.names?.[me] || list.find((x) => x.name)?.name || null, qUsd, qBnb: qUsd / (f.state.bnbUsd || qUsd),
    buys: buys.length, sells: sells.length, boughtTokens: bT, boughtQ: bQ, soldTokens: sT, soldQ: sQ, avgBuy, avgSell: sT ? sQ / sT : null, hold, holdSrc: 'trades', holdQ,
    realized, unrealized, total: realized + unrealized, pct: bQ ? ((realized + unrealized) / bQ) * 100 : null, firstBuy: buys[0]?.ts || null, price: d?.price, trades: list.slice(-200).reverse(), complete: true }
}
function preview(f: any, q: URLSearchParams) {
  const t = f.state.tokens.find((x: any) => x.address.toLowerCase() === String(q.get('token')).toLowerCase())
  const amount = Number(q.get('amount')) || 0, slip = Number(q.get('slippage')) || 20, side = q.get('side')
  if (!t || !(amount > 0)) return { error: '—' }
  const usd = f.state.bnbUsd || 700, route = t.stage === 'dex' ? (side === 'sell' ? 'PancakeSwap V2 直连 · 代币→BNB' : 'PancakeSwap V2 直连 · BNB→代币') : undefined   // i18n-ignore（网关的交易路径原文，界面按语言显示）
  const row = f.state.holdings?.rows?.find((x: any) => x.token.toLowerCase() === t.address.toLowerCase())
  const out = side === 'sell' ? ((row?.amount || 0) * (amount / 100) * (t.priceUsd || 0)) / usd * 0.99 : (amount * usd) / (t.priceUsd || 1) * 0.99
  return { route, amountIn: amount, out, minOut: out * (1 - slip / 100), feeBnb: 0.00009, feePct: 1, note: null }
}

// ---------- 让页面看起来在运行：行情小幅波动、正在看的代币有新成交、追踪的钱包有新动态 ----------
const rand = (a: number, b: number) => a + (b - a) * Math.random()
const fakeTx = () => '0x' + Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')
const fakeTrader = () => '0x' + Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')
let liveFeed: any[] = []   // 打开页面后新出现的追踪动态（排在样本前面）
function liveTrack(f: any) { const t = f.track || { targets: [], groups: ['默认'], feed: [] }; return { ...t, feed: [...liveFeed, ...(t.feed || [])].slice(0, 200) } }   // i18n-ignore

export function demoTicks(onTokens: (changed: any[]) => void) {
  let n = 0
  setInterval(() => {
    n++
    Promise.all([import('../store/app'), load()]).then(([{ useApp }, f]) => {
      const S = useApp.getState()
      const list = [...S.tokens.values()]
      if (!list.length) return
      const changed: any[] = []
      for (let i = 0; i < 6; i++) {
        const t = list[Math.floor(Math.random() * list.length)]
        const k = 1 + (Math.random() - 0.45) * 0.012
        changed.push({ ...t, mcapUsd: t.mcapUsd ? t.mcapUsd * k : t.mcapUsd, priceUsd: t.priceUsd ? t.priceUsd * k : t.priceUsd, volume: (t.volume || 0) + Math.random() * 0.05 })
      }
      onTokens(changed)
      // 正在看的代币：大约每 4 秒一笔新成交，K 线最后一根跟着动
      const d = S.detail
      if (d && d.trades?.length && n % 2 === 0) {
        const last = d.trades[0], side: 'buy' | 'sell' = Math.random() < 0.55 ? 'buy' : 'sell'
        const price = last.price * (1 + (side === 'buy' ? 1 : -1) * rand(0.0005, 0.006))
        const bnb = +Math.exp(rand(Math.log(0.003), Math.log(0.25))).toFixed(5)
        const tr = { ...last, side, price, bnb, tokens: bnb / price, ts: Date.now(), tx: fakeTx(), trader: fakeTrader(), name: null, usd: bnb * (S.bnbUsd || 700), mcapUsd: last.mcapUsd ? last.mcapUsd * (price / last.price) : last.mcapUsd }
        const candles = [...(d.candles || [])], sec = Math.floor(Date.now() / 60_000) * 60, lc = candles[candles.length - 1]
        if (lc && lc.t === sec) candles[candles.length - 1] = { ...lc, h: Math.max(lc.h, price), l: Math.min(lc.l, price), c: price, v: lc.v + bnb }
        else candles.push({ t: sec, o: lc?.c ?? price, h: Math.max(lc?.c ?? price, price), l: Math.min(lc?.c ?? price, price), c: price, v: bnb })
        useApp.setState({ detail: { ...d, trades: [tr, ...d.trades].slice(0, 200), candles } })
      }
      // 追踪的钱包：大约每 15 秒一条新动态（从样本里的钱包和代币里挑）
      const tg = f.track?.targets || []
      if (tg.length && n % 8 === 0) {
        const who = tg[Math.floor(Math.random() * tg.length)], t = list[Math.floor(Math.random() * Math.min(list.length, 60))]
        const side = Math.random() < 0.65 ? 'buy' : 'sell', bnb = +rand(0.01, 0.6).toFixed(4)
        liveFeed = [{ id: fakeTx(), ts: Date.now(), seenAt: Date.now(), target: who.address, targetName: who.name, group: who.group, action: side === 'buy' ? (Math.random() < 0.6 ? '建仓' : '加仓') : '减仓', side, token: t.address, symbol: t.symbol, image: t.image, platform: t.platform, quote: 'BNB', quoteAmt: bnb, bnb, usd: bnb * (S.bnbUsd || 700), tokens: t.priceUsd ? (bnb * (S.bnbUsd || 700)) / t.priceUsd : 0, pct: side === 'sell' ? +rand(10, 60).toFixed(0) : null, mcapUsd: t.mcapUsd, createdAt: t.createdAt, tx: fakeTx() }, ...liveFeed].slice(0, 40)   // i18n-ignore（建仓 / 加仓 / 减仓 是网关的动作值，界面按语言显示）
        useApp.setState({ track: { ...S.track, feed: [liveFeed[0], ...S.track.feed].slice(0, 200) } })
      }
    })
  }, 1800)
}
