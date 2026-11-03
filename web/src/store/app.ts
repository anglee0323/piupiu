// 全局行情 / 钱包状态：启动时拉 /api/state，之后由 WebSocket 推送更新（tick 每 500ms 一次）
import { create } from 'zustand'
import { usePrefs } from './prefs'
import { playAlert, type Alert } from '../lib/notify'
import { api } from '../lib/api'
import { short } from '../lib/format'
import type { CondOrder, BawStatus, Blocklist, Favorites, Holdings, NetStatus, NftSnap, Order, RadarView, Settings, SlotsInfo, Token, TokenDetail, Trade, TrackEvent, TrackTarget, WalletView } from '../lib/types'
import { t, lz } from '../lib/i18n'
import { DEMO } from '../lib/env'
const DEMO_BLOCKED = '__demo__'

export interface Toast { id: string; kind: 'order' | 'info' | 'error' | 'ok'; title: string; body?: string; order?: Order; at: number; req?: string; batchId?: string }   // req：点下单那一刻的临时提示，和服务器随后推来的订单提示是同一笔（token:方向）；batchId：一次多钱包下单合成一个提示

interface AppState {
  ready: boolean
  wsOk: boolean
  mode: 'live' | 'sim'
  baw: BawStatus | null
  block: number
  bnbUsd: number
  startedAt: number | null   // 后台服务的启动时间（毫秒），启动后的头几秒界面显示「正在同步行情」
  net: NetStatus | null
  wallets: WalletView[]
  slots: SlotsInfo | null          // 页面列表用：不含扫码没完成的空槽位
  slotsAll: SlotsInfo | null       // 完整（登录弹窗跟踪新槽位的扫码进度用）
  settings: Settings | null
  // 交易手续费率（0.005）；0 = 不收（开发版、开源版、演示）
  feeRate: number
  tokens: Map<string, Token>
  holdings: Holdings | null
  orders: Order[]
  flow: Trade[]
  favorites: Favorites
  blocklist: Blocklist
  names: Record<string, string>
  namesVer: number
  detail: TokenDetail | null
  subToken: string | null
  newTokens: Set<string>          // 本次会话新出现的币（卡片闪一下）
  track: { targets: TrackTarget[]; groups: string[]; feed: TrackEvent[] }
  toasts: Toast[]
  cond: CondOrder[]
  radar: RadarView | null
  radarHit: { seq: number; ids: string[] } | null   // Gateway 判断出的雷达新推荐命中（RadarAlerts 据此弹卡片）
  nft: NftSnap | null   // 我持有的 NFT（资产页 / 顶部栏）
  radarTick: { address: string; at: number } | null   // 某个候选的分析 / 参与有更新：详情页看到是自己就重新拉
  wsDownAt: number | null   // 应用推送断开的时间：底栏据此区分「连接中」和「连接异常」
  // actions
  init: () => Promise<void>
  subscribe: (addr: string | null) => void
  toast: (t: Omit<Toast, 'id' | 'at'> & { id?: string }) => void
  dropToast: (id: string) => void
  refreshTrack: () => Promise<void>
  nameOf: (addr?: string | null) => string | null
  setTradeSlots: (slots: number[]) => Promise<void>
}

let ws: WebSocket | null = null
let retry = 0

const lc = (a?: string | null) => String(a || '').toLowerCase()
// 扫码没完成的新槽位（fresh）不在页面列表里出现；登录弹窗用完整的 slotsAll
const splitSlots = (x?: SlotsInfo | null) => ({ slotsAll: x || null, slots: x ? { ...x, slots: x.slots.filter((s) => !s.fresh) } : null })

export const useApp = create<AppState>((set, get) => ({
  ready: false, wsOk: false, wsDownAt: null, startedAt: null, mode: 'live', baw: null, block: 0, bnbUsd: 0, net: null, wallets: [], slots: null, slotsAll: null, settings: null, feeRate: 0,
  tokens: new Map(), holdings: null, orders: [], flow: [], favorites: { groups: ['默认'], items: {} }, blocklist: { tokens: {}, devs: {} },   // i18n-ignore（「默认」是分组名，数据值）
  names: {}, namesVer: -1, detail: null, subToken: null, newTokens: new Set(), track: { targets: [], groups: ['默认'], feed: [] }, toasts: [], cond: [], radarHit: null, radar: null as RadarView | null, nft: null, radarTick: null,   // i18n-ignore

  async init() {
    const [st, fav, bl] = await Promise.all([api('/api/state'), api<Favorites>('/api/favorites').catch(() => null), api<Blocklist>('/api/blocklist').catch(() => null)])
    set({
      ready: true, mode: st.mode, baw: st.baw, block: st.block, bnbUsd: st.bnbUsd, net: st.net, wallets: st.wallets, ...splitSlots(st.slots), settings: st.settings, feeRate: st.feeRate || 0,
      tokens: new Map((st.tokens as Token[]).map((t) => [lc(t.address), t])), holdings: st.holdings, orders: st.orders || [], flow: st.flow || [],
      ...(fav ? { favorites: fav } : {}), ...(bl ? { blocklist: bl } : {}),
    })
    api<NftSnap>('/api/nft').then((nft) => set({ nft })).catch(() => {})
    connect()
    pollNames()
    get().refreshTrack()
    api<CondOrder[]>('/api/cond').then((cond) => set({ cond })).catch(() => {})
  },

  subscribe(addr) {
    const a = addr ? lc(addr) : null
    if (get().subToken === a) return
    set({ subToken: a, detail: null })
    if (a && ws?.readyState === 1) ws.send(JSON.stringify({ type: 'sub', token: a }))
    if (a) api<TokenDetail>(`/api/token/${a}`).then((d) => { if (get().subToken === a) set({ detail: d }) }).catch(() => {})
  },

  toast(t) {
    if (DEMO && (t.body === DEMO_BLOCKED || t.title === DEMO_BLOCKED)) return   // 在线体验拦下的操作：已经弹了说明框
    const id = t.id || Math.random().toString(36).slice(2)
    set((s) => ({ toasts: [...s.toasts.filter((x) => x.id !== id), { ...t, id, at: Date.now() }].slice(-6) }))
    const life = t.kind === 'order' && (t.batchId || t.order?.status === 'pending') ? 120_000 : t.kind === 'error' ? 9000 : 5000
    setTimeout(() => { const cur = get().toasts.find((x) => x.id === id); if (cur && Date.now() - cur.at >= life - 50) get().dropToast(id) }, life)
  },
  dropToast(id) { set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })) },

  async refreshTrack() {
    try { const v = await api('/api/track'); set({ track: { targets: v.targets || [], groups: v.groups || ['默认'], feed: v.feed || [] } }) } catch { /* 模拟盘没有追踪 */ }   // i18n-ignore
  },

  nameOf(addr) { return addr ? get().names[lc(addr)] || null : null },

  // 全局「交易钱包」选择：保存到后端（跟单 / 条件单等后端逻辑和页面看到的是同一份），服务器会推 wallets 事件回来
  async setTradeSlots(slots) {
    try { await api('/api/wallets/trade-slots', { slots }) } catch (e: any) { get().toast({ kind: 'error', title: t('toast.pickWalletFailed'), body: e.message }) }
  },
}))

let wsTimer: ReturnType<typeof setTimeout> | null = null
let reconnectT: ReturnType<typeof setTimeout> | null = null
let wsGen = 0   // 连接代号：旧连接的 close / message 回调不能影响新连接的状态
let tickSeq = -1   // 上一帧 tick 的序号；-1 = 还没收到全量（重连后第一帧必须是 full）
// 服务端每 500ms 推一帧 tick。超过 12 秒一帧都没有：连接已经半死（重启 / 网络切换时可能收不到 close 事件），主动重连
function armWatch(gen: number) {
  if (wsTimer) clearTimeout(wsTimer)
  wsTimer = setTimeout(() => {
    wsTimer = null
    if (gen !== wsGen) return
    if (document.visibilityState === 'hidden') return   // 后台标签页的定时器会被节流，别误判成断线
    useApp.setState({ wsOk: false, wsDownAt: useApp.getState().wsDownAt || Date.now() })
    try { ws?.close() } catch { /* ignore */ }
    setTimeout(connect, 200)   // close 事件不一定来：自己再叫一次
  }, 12_000)
}
function connect() {
  if (DEMO) {   // 在线体验：没有推送，按样本做小幅行情变化
    useApp.setState({ wsOk: true })
    import('../lib/demo').then(({ demoTicks }) => demoTicks((changed) => { const next = new Map(useApp.getState().tokens); for (const t of changed) next.set(lc(t.address), t); useApp.setState({ tokens: next }) }))
    return
  }
  if (reconnectT) { clearTimeout(reconnectT); reconnectT = null }
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return
  const gen = ++wsGen
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const sock = new WebSocket(`${proto}://${location.host}/ws`)
  ws = sock
  sock.onopen = () => {
    if (gen !== wsGen) return
    retry = 0; tickSeq = -1; useApp.setState({ wsOk: true, wsDownAt: null }); armWatch(gen)
    const sub = useApp.getState().subToken
    if (sub) sock.send(JSON.stringify({ type: 'sub', token: sub }))
  }
  sock.onclose = () => {
    if (gen !== wsGen) return   // 旧连接的关闭事件：忽略，否则会把新连接标成断开
    if (wsTimer) { clearTimeout(wsTimer); wsTimer = null }
    useApp.setState({ wsOk: false, wsDownAt: useApp.getState().wsDownAt || Date.now() })
    if (reconnectT) clearTimeout(reconnectT)
    reconnectT = setTimeout(connect, Math.min(3_000, 500 * 2 ** retry++))   // 本机应用：最多 3 秒重试一次
  }
  sock.onmessage = (e) => {
    if (gen !== wsGen) return
    if (!useApp.getState().wsOk) useApp.setState({ wsOk: true })   // 收到数据就是活的（onopen 可能被节流吞掉）
    armWatch(gen)
    try { onMsg(JSON.parse(e.data)) } catch { /* 忽略坏帧 */ }
  }
}

// 系统恢复联网 / 页面重新可见时立刻试一次（休眠唤醒、切 Wi-Fi 的情况）
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { retry = 0; connect() })
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !useApp.getState().wsOk) { retry = 0; connect() } })
}

function onMsg(m: { type: string; full?: boolean; seq?: number; data: any }) {
  const S = useApp.getState()
  switch (m.type) {
    case 'tick': {
      const d = m.data
      // 增量协议（server.js tokenDelta）：full = 全量替换；否则 tokens 只含变化的币、tokensDel 是消失的币。
      // seq 必须连续，断档就重连拿一帧全量。没变化的币保持原对象引用，没变化时 tokens 整个 Map 也不换，订阅它的组件不会重算
      if (m.full) tickSeq = m.seq ?? -1
      else if (tickSeq < 0 || m.seq == null || m.seq !== tickSeq + 1) { tickSeq = -1; try { ws?.close() } catch { /* 已经断了 */ } break }
      else tickSeq = m.seq
      const prev = S.tokens
      let next = prev, fresh = S.newTokens
      const ups = (d.tokens || []) as Token[], dels = (d.tokensDel || []) as string[]
      if (m.full) {
        next = new Map<string, Token>()
        for (const t of ups) next.set(lc(t.address), t)
        // 全量只在连上 / 重连时来：已经有列表时，新出现的币也算新币（和以前每帧全量替换时一样）
        if (prev.size) { for (const k of next.keys()) if (!prev.has(k)) { if (fresh === S.newTokens) fresh = new Set(S.newTokens); fresh.add(k) } }
      } else if (ups.length || dels.length) {
        next = new Map(prev)
        for (const t of ups) { const k = lc(t.address); if (prev.size && !prev.has(k)) { if (fresh === S.newTokens) fresh = new Set(S.newTokens); fresh.add(k) } next.set(k, t) }
        for (const k of dels) next.delete(k)
      }
      useApp.setState({ startedAt: d.startedAt ?? null, mode: d.mode, baw: d.baw, block: d.block, bnbUsd: d.bnbUsd, net: d.net, wallets: d.wallets, ...(d.slots ? splitSlots(d.slots) : {}), ...(next !== prev ? { tokens: next } : {}), ...(fresh !== S.newTokens ? { newTokens: fresh } : {}) })
      break
    }
    case 'wallets': useApp.setState(splitSlots(m.data)); break
    case 'detail': {
      const d = m.data as TokenDetail
      if (lc(d.address) !== S.subToken) break
      if (m.full || !S.detail) { useApp.setState({ detail: d }); break }
      const byT = new Map(S.detail.candles.map((c) => [c.t, c]))
      for (const c of d.candles) byT.set(c.t, c)
      useApp.setState({ detail: { ...d, candles: [...byT.values()].sort((a, b) => a.t - b.t) } })
      break
    }
    case 'trade': {
      const t = m.data as Trade
      useApp.setState({ flow: [t, ...S.flow].slice(0, 200) })
      break
    }
    case 'holdings': useApp.setState({ holdings: m.data }); break
    case 'settings': useApp.setState({ settings: m.data }); break
    case 'favorites': useApp.setState({ favorites: m.data }); break
    case 'blocklist': useApp.setState({ blocklist: m.data }); break
    case 'order': {
      const o = m.data as Order
      const orders = [o, ...S.orders.filter((x) => x.id !== o.id)].slice(0, 200)
      useApp.setState({ orders })
      if (o.side === 'buy' || o.side === 'sell') {
        // 一次多钱包下单：同一批（batchId）只用一个提示，里面按钱包分行更新状态
        if (o.batchId && S.slots && S.slots.slots.length > 1) {
          const batch = orders.filter((x) => x.batchId === o.batchId && (x.side === 'buy' || x.side === 'sell'))
          S.toast({ id: 'b-' + o.batchId, kind: 'order', title: t('toast.batch', { side: o.side === 'buy' ? t('toast.buy') : t('toast.sell'), sym: o.symbol || '', n: batch.length }), batchId: o.batchId })
          return
        }
        // 订单一出现，点击时的临时提示（「已发送，等待执行…」）就撤掉：一笔订单只留一个提示，状态在这一个上更新
        const req = `${String(o.token).toLowerCase()}:${o.side}`
        if (S.toasts.some((x) => x.req === req)) useApp.setState({ toasts: S.toasts.filter((x) => x.req !== req) })
        S.toast({ id: 'o-' + o.id, kind: 'order', title: o.symbol || '', order: o })
      }
      break
    }
    case 'track': {
      const ev = m.data as TrackEvent
      if (S.track.feed.some((x) => x.id === ev.id)) break
      const feed = [...S.track.feed]; const i = feed.findIndex((x) => x.ts <= ev.ts); if (i < 0) feed.push(ev); else feed.splice(i, 0, ev)   // 按时间插入（晚到的成交不一定最新）
      useApp.setState({ track: { ...S.track, feed: feed.slice(0, 500) } })
      // 提示音由 Gateway 判断后单独推 alert（见下面的 case 'alert'）
      break
    }
    case 'radar': {
      useApp.setState({ radar: m.data as RadarView }); break
    }
    // 提醒：要不要响、响什么、哪些雷达推荐要弹卡片，都由 Gateway 决定（engine/live/notifier.js），这里只呈现
    case 'alert': {
      const a = m.data as Alert
      if (a.source === 'trench') { if (location.pathname === '/') playAlert(a.sound) }   // 战壕新币只在战壕页响（和以前一样）
      else if (a.source === 'track') playAlert(a.sound, usePrefs.getState().trackSound.kind)
      else if (a.source === 'radar') { useApp.setState({ radarHit: { seq: (S.radarHit?.seq || 0) + 1, ids: a.ids } }); playAlert(a.sound) }
      break
    }
    // 自动转出结果（engine/live/liveTrader.js 的规则转出、transferWatch.js）：成功、失败都弹提示；失败后自动转出已暂停
    case 'autoTransfer': {
      const o = m.data as { symbol?: string; status?: string; reason?: string; toShort?: string; stopped?: boolean }
      if (o.status === 'filled') S.toast({ kind: 'ok', title: t('toast.sent', { sym: o.symbol || t('toast.token') }), body: o.toShort ? t('toast.sentTo', { to: o.toShort }) : undefined })
      else if (o.status === 'failed') S.toast({ kind: 'error', title: t('toast.sendFailed', { sym: o.symbol || t('toast.token') }), body: `${lz(o.reason)}${o.stopped ? t('toast.sendStopped') : ''}` })
      break
    }
    case 'nft': useApp.setState({ nft: m.data as NftSnap }); break
    case 'radarDetail': useApp.setState({ radarTick: { address: m.data.address, at: Date.now() } }); break
    case 'radarMint': {
      const r = m.data as { address: string; symbol?: string | null; slot: number; status: string; reason?: string | null; got?: unknown[] }
      useApp.setState({ radarTick: { address: r.address, at: Date.now() } })
      const name = r.symbol || short(r.address)
      if (r.status === 'done') S.toast({ kind: 'ok', title: t('toast.minted', { slot: r.slot, name }), body: t('toast.mintedGot', { n: (r.got || []).length }) })
      else if (r.status === 'done-nothing') S.toast({ kind: 'info', title: t('toast.mintTxOk', { slot: r.slot, name }), body: t('toast.mintNothing') })
      else if (r.status === 'transferred') S.toast({ kind: 'ok', title: t('toast.nftSent', { slot: r.slot, name }) })
      else if (['failed', 'unknown', 'unconfirmed', 'app-confirm'].includes(r.status)) S.toast({ kind: r.status === 'app-confirm' ? 'info' : 'error', title: t(r.status === 'app-confirm' ? 'toast.mintAppConfirm' : 'toast.mintIncomplete', { slot: r.slot, name }), body: lz(r.reason) || undefined })
      break
    }
    case 'radarAlert': break   // 雷达不再弹窗（旧后端还可能推）
    case 'trackTargets': useApp.setState({ track: { ...S.track, targets: m.data.targets, groups: m.data.groups } }); break
    case 'trackReload': S.refreshTrack(); break
    case 'cond': {
      const prev = new Map(S.cond.map((o) => [o.id, o.status]))
      useApp.setState({ cond: m.data })
      for (const o of m.data as CondOrder[]) if (prev.get(o.id) === 'open' && o.status !== 'open' && o.status !== 'cancelled') S.toast({ kind: o.status === 'done' ? 'ok' : 'error', title: t(o.status === 'done' ? 'toast.condDone' : o.status === 'expired' ? 'toast.condExpired' : 'toast.condFailed', { sym: o.symbol }), body: lz(o.results[o.results.length - 1]?.reason) || undefined })
      break
    }
  }
}

async function pollNames() {
  for (;;) {
    try {
      const j = await api(`/api/names?ver=${useApp.getState().namesVer}`)
      if (j.names) useApp.setState({ names: { ...useApp.getState().names, ...j.names }, namesVer: j.ver })
    } catch { /* 下次再试 */ }
    await new Promise((r) => setTimeout(r, 3000))
  }
}
