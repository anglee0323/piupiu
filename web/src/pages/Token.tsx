// 代币页（GMGN 布局）：顶部代币信息条，中间 K 线，底部 Tab（活动 / 交易者 / 我的仓位 / 订单），右侧固定下单面板
import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { ExternalLink, Star, Users, Loader2, Zap } from '../components/gi'
import clsx from 'clsx'
import { useApp } from '../store/app'
import { usePrefs } from '../store/prefs'
import { api } from '../lib/api'
import { age, ageColor, bnb, compact, fullTime, hms, pct, short, small, usd, launchpadLabel } from '../lib/format'
import type { Token, TokenDetail, Trade } from '../lib/types'
import { CopyBtn, TokenAvatar, useNow, useWidth } from '../components/common'
import { PLATFORM, alpha } from '../components/icons'
import { PriceChart } from '../components/PriceChart'
import { QuickPanel } from '../components/QuickPanel'
import { TradePanel, condDesc, statusLabel } from '../components/TradePanel'
import { BondChip, DevTag, DivChip, Socials, TaxChip, TrackBtn, bondInfo, taxInfo, divInfo, gateNote, walletCap } from '../components/TokenMeta'
import { useDrawer } from '../components/TraderDrawer'
import { usePrefs as usePrefs2 } from '../store/prefs'
import { useT, t as T, lz } from '../lib/i18n'

const lc = (a?: string | null) => String(a || '').toLowerCase()
const platformUrl = (t: Token) => (t.platform === 'four' ? `https://four.meme/token/${t.address}` : t.platform === 'gang' ? `https://gang.fun/token/${lc(t.address)}` : `https://flap.sh/bnb/${t.address}`)

export function TokenPage() {
  useT()   // 切换语言时整页重绘（下面的子组件用 T() 取文案）
  const { address = '' } = useParams()
  const subscribe = useApp((s) => s.subscribe)
  const detail = useApp((s) => s.detail)
  const summary = useApp((s) => s.tokens.get(lc(address)))
  const pushHistory = usePrefs((s) => s.pushHistory)
  useNow(1000)
  useEffect(() => { subscribe(address); pushHistory(address); return () => subscribe(null) }, [address]) // eslint-disable-line
  const t: Token | undefined = detail && lc(detail.address) === lc(address) ? detail : summary
  const [pageRef, pageW] = useWidth<HTMLDivElement>()   // hook 必须在提前 return 之前
  const bottomH = usePrefs((s) => s.tokenBottomH) || 330
  if (!t) return <div className="h-full grid place-items-center text-t3"><span className="flex items-center gap-2"><Loader2 className="ico spin" />{T('tk.loading')}</span></div>
  const d = detail && lc(detail.address) === lc(address) ? detail : null
  // 主区不足 1000px（窗口窄或开着钱包追踪）：下单面板叠到 K 线下面、整页上下滚动，不把 K 线挤成一条
  const wide = !pageW || pageW >= 1000
  return (
    <div ref={pageRef} className={clsx('h-full grid min-h-0', wide ? 'grid-cols-[minmax(0,1fr)_340px]' : 'grid-cols-1 content-start overflow-y-auto')}>
      {/* 窄屏时左栏不能 min-h-0：网格的自动行会按最小高度给，左栏被压成 1px，K 线和成交叠到下单面板上 */}
      <div className={clsx('flex flex-col border-line', wide ? 'min-h-0 border-r' : 'border-b')}>
        <Header t={t} />
        <div data-chart className={clsx('flex-1 border-line', wide ? 'min-h-[140px]' : 'h-[440px] flex-none')}>{d ? <PriceChart d={d} emptyText={t.gangFair && t.stage === 'curve' ? T('tk.fairChart') : undefined} /> : <div className="h-full grid place-items-center text-t4"><Loader2 className="ico spin" /></div>}</div>
        <SplitBar wide={wide} />
        <div className="min-h-0 flex-none" style={{ height: bottomH }}><BottomTabs t={t} d={d} /></div>
      </div>
      <aside className={clsx('bg-bg', wide && 'min-h-0 scroll-y')}><TradePanel key={t.address} t={t} /><InfoBlock t={t} /></aside>
      <QuickPanel t={t} />
    </div>
  )
}

/** K 线与底部面板之间的分隔条：上下拖动，决定多看 K 线还是多看成交；松手后保存，下次进入保持 */
function SplitBar({ wide }: { wide: boolean }) {
  const t = useT()
  const set = usePrefs((s) => s.set)
  const ref = useRef<HTMLDivElement>(null)
  const down = (e: React.PointerEvent) => {
    e.preventDefault()
    const col = ref.current?.parentElement
    if (!col) return
    const startY = e.clientY, start = usePrefs.getState().tokenBottomH || 330
    // 宽屏：K 线至少留 140px、头部信息条不动；窄屏整页滚动，底部面板最高 900px
    const bottomNow = ref.current!.nextElementSibling!.getBoundingClientRect().height
    const max = wide ? Math.max(160, bottomNow + (col.querySelector('[data-chart]')?.getBoundingClientRect().height ?? 400) - 140) : 900
    const min = 120
    let cur = start
    const move = (ev: PointerEvent) => {
      cur = Math.round(Math.min(max, Math.max(min, start + (startY - ev.clientY))))
      usePrefs.setState({ tokenBottomH: cur })
    }
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); document.body.style.cursor = ''; set({ tokenBottomH: cur }) }
    document.body.style.cursor = 'row-resize'
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  return (
    <div ref={ref} onPointerDown={down} onDoubleClick={() => set({ tokenBottomH: 330 })} title={t('tk.splitTip')} role="separator" aria-orientation="horizontal"
      className="group relative h-[7px] -my-[3px] flex-none z-10 cursor-row-resize touch-none">
      <div className="absolute inset-x-0 top-[3px] h-px bg-line group-hover:bg-up group-active:bg-up transition-colors" />
    </div>
  )
}

function Header({ t }: { t: Token }) {
  const fav = useApp((s) => !!s.favorites.items[lc(t.address)])
  const dev = useApp((s) => t.creatorName || (t.creator ? s.names[lc(t.creator)] : null))
  const bnbUsd = useApp((s) => s.bnbUsd)
  const toggleFav = () => api('/api/favorites', fav ? { op: 'remove', address: t.address } : { op: 'set', address: t.address, symbol: t.symbol, platform: t.platform }).catch(() => {})
  const d = useApp((s) => s.detail)
  // 有的平台（Gang）行情里没有成交额：用已加载的成交记录估算（只算最近 24 小时）
  const vol = (t.stage === 'dex' && t.dexVolUsd24 ? t.dexVolUsd24 : 0) || (t.volume || 0) * (t.quoteUsd || bnbUsd) || (d && lc(d.address) === lc(t.address) ? d.trades.filter((x) => Date.now() - x.ts < 86400_000).reduce((a, x) => a + (x.usd || 0), 0) : 0)
  const [hdrRef, hdrW] = useWidth<HTMLDivElement>()
  // 标题栏按自身宽度排版：够宽一行放下；不够（窗口窄 / 开着钱包追踪）时数据换到第二行，标签和链接一律不换行，不会被挤成竖排
  const two = !!hdrW && hdrW < 1180
  const stat = (k: string, v: React.ReactNode, cls?: string) => (
    <div key={k} className="flex flex-col flex-none whitespace-nowrap"><span className="text-xs text-t3">{k}</span><span className={clsx('text-md font-medium', cls)}>{v}</span></div>
  )
  const stats = (
    <div className={clsx('flex items-center gap-6 flex-none', two && 'gap-5')}>
      <div className="flex flex-col flex-none whitespace-nowrap"><span className="text-xs text-t3">{T('tk.mc')}</span><span className={clsx('font-semibold leading-none mt-0.5', two ? 'text-xl' : 'text-2xl')}>{t.mcapEst ? '≈' : ''}{usd(t.mcapUsd)}</span></div>
      {stat(T('tk.price'), `${small(t.priceUsd)}`)}
      {stat(t.stage === 'dex' ? T('tk.vol24') : T('tk.vol'), usd(vol))}
      {stat(t.stage === 'curve' ? (t.gangFair ? T('tk.fairProgress') : t.gangFly ? T('tk.flyProgress') : T('tk.curveProgress')) : T('tk.liq'), t.stage === 'curve' ? `${t.progress.toFixed(1)}%` : usd(t.liqUsd), t.stage === 'curve' ? 'text-up' : '')}
      <div className="flex flex-col items-start flex-none whitespace-nowrap"><span className="text-xs text-t3">{T('tk.taxDiv')}</span><span className="flex items-center gap-1 mt-0.5"><TaxChip t={t} /><DivChip t={t} /><BondChip t={t} />{!t.gangV3 && !t.flapTax && t.buyFeePct == null && <span className="text-md">—</span>}</span></div>
    </div>
  )
  const links = (
    <div className="flex items-center gap-1 flex-none">
      <ExtLink href={platformUrl(t)} label={PLATFORM[t.platform].label} />
      <ExtLink href={`https://bscscan.com/token/${t.address}`} label="BscScan" />
      <ExtLink href={`https://gmgn.ai/bsc/token/${t.address}`} label="GMGN" />
    </div>
  )
  return (
    <div ref={hdrRef} className={clsx('flex-none border-b border-line px-4', two ? 'py-2.5 space-y-2.5' : 'h-[76px] flex items-center')}>
    <div className="flex items-center gap-4 min-w-0">
      <button className={clsx('icon-btn w-7 h-7', fav && '!text-warn')} onClick={toggleFav} title={fav ? T('tk.unfav') : T('tk.fav')}><Star className="ico-md" fill={fav ? 'currentColor' : 'none'} /></button>
      <TokenAvatar t={t} size={48} />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xl font-semibold whitespace-nowrap">{t.symbol}</span>
          <span className="text-md text-t3 truncate max-w-[220px] min-w-0">{t.name}</span>
          <span className="h-5 px-1.5 rounded-xs text-xs grid place-items-center flex-none whitespace-nowrap" style={{ background: alpha(PLATFORM[t.platform].color, 14), color: PLATFORM[t.platform].color }}>{launchpadLabel(t)}</span>
          {gateNote(t) && <span className="h-5 px-1.5 rounded-xs text-xs grid place-items-center flex-none whitespace-nowrap bg-down/14 text-down">{gateNote(t)}</span>}
        </div>
        <div className="flex items-center gap-3 mt-1 text-sm text-t3 whitespace-nowrap min-w-0 overflow-hidden">
          <span className={ageColor(t.createdAt)} title={fullTime(t.createdAt)}>{age(t.createdAt)}</span>
          <span className="flex items-center">{short(t.address, 4, 4)}<CopyBtn text={t.address} /></span>
          <Socials t={t} />
          {t.holders != null && t.holders > 0 && <span className="flex items-center gap-0.5"><Users className="ico-sm" />{t.holders}</span>}
          <DevTag t={t} max={140} />
          {t.creator && <TrackBtn address={t.creator} name={dev} />}
        </div>
      </div>
      <div className="flex-1" />
      {!two && stats}
      {links}
    </div>
    {two && <div className="overflow-hidden">{stats}</div>}
    </div>
  )
}

const ExtLink = ({ href, label }: { href: string; label: string }) => (
  <a href={href} target="_blank" rel="noreferrer" className="h-7 px-2 flex items-center gap-1 rounded-xs bg-btn text-t2 text-sm hover:bg-btn-2 hover:text-t1">{label}<ExternalLink className="w-3 h-3" /></a>
)

type TabKey = 'activity' | 'traders' | 'position' | 'orders'

function BottomTabs({ t, d }: { t: Token; d: TokenDetail | null }) {
  const [tab, setTab] = useState<TabKey>('activity')
  const [older, setOlder] = useState<Trade[]>([])
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  useEffect(() => { setOlder([]); setDone(false) }, [t.address])
  const trades = useMemo(() => {
    const m = new Map<string, Trade>()
    for (const x of [...(d?.trades || []), ...older]) m.set(x.tx + x.side + x.trader, x)
    return [...m.values()].sort((a, b) => b.ts - a.ts)
  }, [d?.trades, older])
  const loadMore = async () => {
    if (loading || done) return
    setLoading(true)
    try {
      const before = trades[trades.length - 1]?.ts || Date.now()
      const r = await api(`/api/trades/${t.address}?before=${before}&limit=100`)
      const list: Trade[] = r.trades || r.items || r || []
      if (list.length) setOlder((o) => [...o, ...list])
      // 后端说数据还没补完（complete=false）时不停：之后滚动还会再拉；只有到底且完整才显示「没有更多」
      if (!list.length && r.complete !== false) setDone(true)
    } catch { /* 网络失败：下次滚动再试 */ } finally { setLoading(false) }
  }
  const allOrders = useApp((s) => s.orders)
  const orders = useMemo(() => allOrders.filter((o) => lc(o.token) === lc(t.address)), [allOrders, t.address])   // 选择器里不能 filter：每次返回新数组会让 zustand 无限重渲染
  const allCond = useApp((s) => s.cond)
  const openCond = useMemo(() => allCond.filter((o) => lc(o.token) === lc(t.address) && o.status === 'open').length, [allCond, t.address])
  const tabs: [TabKey, string][] = [['activity', T('tk.activity')], ['traders', T('tk.traders')], ['position', T('tk.myPos')], ['orders', `${T('tk.orders')}${orders.length + openCond ? ' ' + (orders.length + openCond) : ''}`]]
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="h-11 flex-none flex items-center gap-6 px-4 border-b border-line">
        {tabs.map(([k, l]) => <button key={k} className="tab" data-on={tab === k} onClick={() => setTab(k)}>{l}</button>)}
        <div className="flex-1" />
        <QbToggle />
      </div>
      <div className="flex-1 min-h-0 scroll-y" onScroll={(e) => { const el = e.currentTarget; if (tab === 'activity' && el.scrollTop + el.clientHeight > el.scrollHeight - 80) loadMore() }}>
        {tab === 'activity' && <Activity t={t} trades={trades} loading={loading} done={done} onMore={loadMore} />}
        {tab === 'traders' && <Traders t={t} trades={trades} />}
        {tab === 'position' && <Position t={t} />}
        {tab === 'orders' && <><CondTable token={t.address} /><Orders orders={orders} /></>}
      </div>
    </div>
  )
}

function Who({ addr, name, token }: { addr: string; name?: string | null; token: string }) {
  const n = useApp((s) => name || s.names[lc(addr)])
  const me = useApp((s) => !!addr && !!s.baw?.auth?.address && lc(s.baw.auth.address) === lc(addr))
  const open = useDrawer((s) => s.open)
  return (
    <span className="group/who inline-flex items-center gap-1">
      <button onClick={() => open(token, addr)} className={clsx('hover:underline', me ? 'text-up' : n ? 'text-warn' : 'text-t2')} title={T('tk.whoTip')}>
        {me ? T('tk.me') : ''}{n || short(addr, 4, 4)}
      </button>
      {!me && <span className="opacity-0 group-hover/who:opacity-100"><TrackBtn address={addr} name={n} /></span>}
    </span>
  )
}

function Activity({ t, trades, loading, done, onMore }: { t: Token; trades: Trade[]; loading: boolean; done: boolean; onMore: () => void }) {
  return (
    <div className="tbl-x"><table className="tbl">
      <thead><tr><th>{T('tk.time')}</th><th className="l">{T('tk.type')}</th><th>{T('tk.totalUsd')}</th><th>{T('tk.amount')}</th><th>{t.quote}</th><th>{T('tk.mcAfter')}</th><th className="l">{T('tk.trader')}</th><th>Tx</th></tr></thead>
      <tbody>
        {trades.map((x) => (
          <tr key={x.tx + x.side + x.trader}>
            <td className="text-t3" title={fullTime(x.ts)}>{Date.now() - x.ts < 86400_000 ? hms(x.ts) : age(x.ts)}</td>
            <td className={clsx('l font-medium', x.side === 'buy' ? 'text-up' : 'text-down')}>{x.side === 'buy' ? T('tk.buy') : T('tk.sell')}</td>
            <td className={x.side === 'buy' ? 'text-up' : 'text-down'}>{x.usd != null ? `$${x.usd < 1 ? x.usd.toFixed(3) : compact(x.usd)}` : '—'}</td>
            <td>{compact(x.tokens)}</td>
            <td className="text-t2">{bnb(x.bnb)}</td>
            <td className="text-t2">{usd(x.mcapUsd)}</td>
            <td className="l"><Who addr={x.trader} name={x.name} token={t.address} /></td>
            <td className="font-mono text-xs"><a className="text-t3 hover:text-t1 hover:underline" href={`https://bscscan.com/tx/${x.tx}`} target="_blank" rel="noreferrer" title={T('tk.viewTx')}>{short(x.tx, 3, 4)}</a></td>
          </tr>
        ))}
        <tr><td colSpan={8} className="!text-center text-t3">
          {t.gangFair && t.stage === 'curve' ? T('tk.fairNoTrades') : loading ? T('tk.loadingDots') : done ? (trades.length ? T('tk.allLoaded') : T('tk.noTrades')) : <button onClick={onMore} className="hover:text-t1">{T('tk.loadMore')}</button>}
        </td></tr>
      </tbody>
    </table></div>
  )
}

function Traders({ t, trades }: { t: Token; trades: Trade[] }) {
  const rows = useMemo(() => {
    const m = new Map<string, { addr: string; name?: string | null; buyUsd: number; sellUsd: number; buyTok: number; sellTok: number; n: number; last: number }>()
    for (const x of trades) {
      const r = m.get(lc(x.trader)) || { addr: x.trader, name: x.name, buyUsd: 0, sellUsd: 0, buyTok: 0, sellTok: 0, n: 0, last: 0 }
      if (x.side === 'buy') { r.buyUsd += x.usd || 0; r.buyTok += x.tokens } else { r.sellUsd += x.usd || 0; r.sellTok += x.tokens }
      r.n++; r.last = Math.max(r.last, x.ts); m.set(lc(x.trader), r)
    }
    return [...m.values()].sort((a, b) => b.buyUsd + b.sellUsd - (a.buyUsd + a.sellUsd))
  }, [trades])
  return (
    <div className="tbl-x"><table className="tbl">
      <thead><tr><th className="l">{T('tk.trader')}</th><th>{T('tk.buys')}</th><th>{T('tk.sells')}</th><th>{T('tk.netLoaded')}</th><th>{T('tk.realized')}</th><th>{T('tk.txCount')}</th><th>{T('tk.latest')}</th></tr></thead>
      <tbody>
        {rows.map((r) => {
          const net = r.buyTok - r.sellTok, realized = r.sellUsd - (r.buyTok ? r.buyUsd * Math.min(1, r.sellTok / r.buyTok) : 0)
          return (
            <tr key={r.addr}>
              <td className="l"><Who addr={r.addr} name={r.name} token={t.address} /></td>
              <td className="text-up">${compact(r.buyUsd)}</td>
              <td className="text-down">${compact(r.sellUsd)}</td>
              <td>{net > 0 ? `${compact(net)} ${t.symbol}` : <span className="text-t3">{T('tk.cleared')}</span>}</td>
              <td className={realized >= 0 ? 'text-up' : 'text-down'}>{r.sellUsd ? `${realized >= 0 ? '+' : '-'}$${compact(Math.abs(realized))}` : '—'}</td>
              <td className="text-t2">{r.n}</td>
              <td className="text-t3">{age(r.last)}</td>
            </tr>
          )
        })}
        {!rows.length && <tr><td colSpan={7} className="!text-center text-t3">{T('tk.noTrades')}</td></tr>}
      </tbody>
    </table></div>
  )
}

function Position({ t }: { t: Token }) {
  const r = useApp((s) => s.holdings?.rows.find((x) => lc(x.token) === lc(t.address)))
  if (!r) return <div className="p-10 text-center text-t3">{T('tk.noPos', { sym: t.symbol })}</div>
  const cells: [string, React.ReactNode][] = [
    [T('tk.holding'), `${compact(r.amount)} ${t.symbol}`], [T('tk.supplyPct'), r.supplyPct != null ? `${r.supplyPct.toFixed(3)}%` : '—'], [T('tk.value'), usd(r.valueUsd)],
    [T('tk.cost'), usd(r.costUsd)], [T('tk.soldUsd'), usd(r.soldUsd)], [T('tk.avg'), r.avgBuyUsd != null ? `$${small(r.avgBuyUsd)}` : '—'],
    [T('tk.pnl'), <span className={r.pnlUsd == null ? '' : r.pnlUsd >= 0 ? 'text-up' : 'text-down'}>{r.pnlUsd == null ? '—' : `${r.pnlUsd >= 0 ? '+' : '-'}$${Math.abs(r.pnlUsd).toFixed(2)}`} {r.pnlPct != null && pct(r.pnlPct)}</span>],
  ]
  return (
    <div className="p-4 grid grid-cols-4 gap-2">
      {cells.map(([k, v]) => <div key={k} className="rounded-sm bg-btn p-3"><div className="text-xs text-t3">{k}</div><div className="text-md font-medium mt-1">{v}</div></div>)}
      {r.warn && <div className="col-span-4 text-warn text-sm">{lz(r.warn)}</div>}
    </div>
  )
}

/** 空状态：居中灰字，各表格统一用这个 */
export function Empty({ text, icon }: { text: string; icon?: React.ReactNode }) {
  return <div className="py-14 flex flex-col items-center gap-2 text-t4 text-sm">{icon}{text}</div>
}

export function Orders({ orders }: { orders: import('../lib/types').Order[] }) {
  return (
    <div className="tbl-x"><table className="tbl">
      <thead><tr><th>{T('tk.time')}</th><th className="l">{T('tk.token')}</th><th className="l">{T('tk.side')}</th><th>{T('tk.amount')}</th><th className="l">{T('tk.status')}</th><th className="l">{T('tk.note')}</th><th>Tx</th></tr></thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.id}>
            <td className="text-t3" title={fullTime(o.ts)}>{hms(o.ts)}</td>
            <td className="l"><Link to={`/token/${o.token}`} className="hover:underline">{o.symbol || short(o.token)}</Link></td>
            <td className={clsx('l font-medium', o.side === 'buy' ? 'text-up' : 'text-down')}>{o.side === 'buy' ? T('tk.buy') : o.side === 'sell' ? T('tk.sell') : o.side}</td>
            <td>{o.side === 'sell' ? T('tk.sellPct', { p: o.amount }) : `${bnb(o.amountIn ?? o.amount)} BNB`}</td>
            <td className={clsx('l', o.status === 'filled' ? 'text-up' : o.status === 'failed' ? 'text-down' : 'text-warn')}>{o.dryRun && o.status !== 'failed' ? T('tk.demo') : ['filled', 'failed', 'pending', 'unknown'].includes(o.status) ? T('tk.st.' + o.status) : o.status}</td>
            <td className="l text-t3 max-w-[420px] truncate" title={lz(o.reason) || lz(o.venue) || ''}>{lz(o.reason) || lz(o.venue) || '—'}</td>
            <td className="font-mono text-xs">{o.tx ? <a className="text-t3 hover:text-t1 hover:underline" href={`https://bscscan.com/tx/${o.tx}`} target="_blank" rel="noreferrer" title={T('tk.viewTx')}>{short(o.tx, 3, 4)}</a> : '—'}</td>
          </tr>
        ))}
        {!orders.length && <tr><td colSpan={7} className="!border-0"><Empty text={T('tk.noOrders')} /></td></tr>}
      </tbody>
    </table></div>
  )
}

function InfoBlock({ t }: { t: Token }) {
  const rows: [string, React.ReactNode][] = [
    [T('tk.platform'), launchpadLabel(t)],
    ...(t.gangFair
      ? ((f) => [
          [T('tk.status'), t.stage === 'curve' ? T('tk.fairState', { sold: f.sold, total: f.totalShares }) : T('tk.launched')],
          [T('tk.sharePrice'), `${+f.sharePrice.toPrecision(4)} ${t.quote}`],
          [T('tk.participants'), T('tk.nPeople', { n: f.participants })],
          ...(t.stage === 'curve' ? [[T('tk.walletsNeeded'), f.minWalletsLeft > 0 ? T('tk.atLeast', { n: f.minWalletsLeft }) : T('tk.reached')]] as [string, React.ReactNode][] : []),
          [T('tk.fees'), `${f.mintFeePct}% / ${f.stale ? T('tk.staleFree') : f.exitFeeNowPct + '%'}`],
        ] as [string, React.ReactNode][])(t.gangFair)
      : [
          [T('tk.status'), t.stage === 'curve' ? T('tk.curveState', { p: t.progress.toFixed(2) }) : t.stage === 'dex' ? T('tk.migrated') : t.stage],
          ...(t.stage === 'curve' ? [[T('tk.raised'), `${bnb(t.raised, 3)} / ${compact(t.target)} ${t.quote}`] as [string, React.ReactNode]] : []),
        ] as [string, React.ReactNode][]),
    [T('tk.tax'), taxInfo(t)?.label ?? '—'],
    ...(divInfo(t) ? [[T('tk.div'), String(divInfo(t)![0])] as [string, React.ReactNode]] : []),
    ...(t.stage === 'curve' && !t.gangFair ? [[T('tk.curveTrading'), gateNote(t) || T('tk.agentOnly')] as [string, React.ReactNode]] : []),
    ...(walletCap(t) ? [[T('tk.walletCap'), walletCap(t)] as [string, React.ReactNode]] : []),
    ...(bondInfo(t) ? ((b, x) => [
      [T('tk.bond'), <span className={x.tone === 'up' ? 'text-up' : x.tone === 'warn' ? 'text-warn' : x.tone === 'down' ? 'text-down' : ''}>{x.label}{b.valueBnb != null ? ` · ${+b.valueBnb.toPrecision(3)} BNB` : ''}</span>],
      [T('tk.commit'), `${b.holdPct != null ? +b.holdPct.toFixed(2) + '%' : '—'} · ${b.phase === 'pending' ? T('tk.afterLaunchDays', { d: b.days ?? '—' }) : b.deadline ? T('tk.until', { date: new Date(b.deadline).toLocaleDateString() }) : T('tk.days', { d: b.days ?? '—' })}`],
      ...(b.coveragePct != null ? [[T('tk.coverage'), `${+b.coveragePct.toFixed(0)}%`] as [string, React.ReactNode]] : []),
    ] as [string, React.ReactNode][])(t.gangBond!, bondInfo(t)!) : []),
    [T('tk.quote'), t.quote],
    [T('tk.creator'), t.creator ? <span className="flex items-center justify-end">{short(t.creator)}<CopyBtn text={t.creator} /></span> : '—'],
    [T('tk.firstBuyer'), t.firstBuyerName || (t.firstBuyer ? short(t.firstBuyer) : '—')],
  ]
  return (
    <div className="mx-3 mb-4 rounded-sm border border-line">
      <div className="px-3 py-2 border-b border-line text-md font-medium">{T('tk.info')}</div>
      <div className="p-3 space-y-2 text-sm">
        {rows.map(([k, v]) => <div key={k} className="flex justify-between gap-3"><span className="text-t3 flex-none">{k}</span><span className="text-right truncate">{v}</span></div>)}
        {t.description && <div className="pt-2 text-t3 text-xs leading-relaxed line-clamp-4">{t.description}</div>}
      </div>
    </div>
  )
}

/** 条件单表（限价 / 止盈 / 止损 / DCA）；token 为空时列出全部 */
export function CondTable({ token }: { token?: string }) {
  const all = useApp((s) => s.cond)
  const list = useMemo(() => all.filter((o) => !token || lc(o.token) === lc(token)), [all, token])
  if (!list.length) return null
  return (
    <div className="tbl-x"><table className="tbl">
      <thead><tr><th>{T('tk.created')}</th><th className="l">{T('tk.token')}</th><th className="l">{T('tk.type')}</th><th className="l">{T('tk.cond')}</th><th className="l">{T('tk.status')}</th><th className="l">{T('tk.lastResult')}</th><th></th></tr></thead>
      <tbody>
        {list.map((o) => {
          const last = o.results[o.results.length - 1]
          return (
            <tr key={o.id}>
              <td className="text-t3" title={fullTime(o.createdAt)}>{age(o.createdAt)}</td>
              <td className="l"><Link to={`/token/${o.token}`} className="hover:underline">{o.symbol}</Link></td>
              <td className={clsx('l', o.side === 'buy' ? 'text-up' : 'text-down')}>{T('cond.kind.' + o.kind)}{o.kind === 'limit' || o.kind === 'dca' ? T(o.side === 'buy' ? 'tk.buyShort' : 'tk.sellShort') : ''}</td>
              <td className="l text-t2">{o.slots?.length ? <span className="text-t4 mr-1">{o.slots.map((n) => `W${n}`).join('·')}</span> : ''}{condDesc(o)}</td>
              <td className={clsx('l', o.status === 'open' ? 'text-warn' : o.status === 'done' ? 'text-up' : 'text-t3')}>{statusLabel(o.status)}</td>
              <td className="l text-t3 max-w-[320px] truncate" title={lz(last?.reason)}>{last ? `${last.ok ? T('tk.ok') : last.skipped ? T('tk.skipped') : T('tk.fail')}${last.dryRun ? T('tk.demoMark') : ''}${last.reason ? ': ' + lz(last.reason) : ''}` : ''}</td>
              <td>{o.status === 'open' && <button className="text-xs text-t3 hover:text-down" onClick={() => api('/api/cond/cancel', { id: o.id })}>{T('tk.cancel')}</button>}</td>
            </tr>
          )
        })}
      </tbody>
    </table></div>
  )
}

function QbToggle() {
  const on = usePrefs2((s) => s.qbOpen)
  const set = usePrefs2((s) => s.set)
  return <button onClick={() => set({ qbOpen: !on })} className={clsx('h-7 px-2.5 rounded-sm flex items-center gap-1 text-sm font-medium border', on ? 'border-up/60 text-up bg-up/10' : 'border-up/40 text-up hover:bg-up/10')}><Zap className="ico-sm" fill="currentColor" />{T('tk.quick')}</button>
}
