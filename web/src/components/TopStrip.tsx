// 顶栏下面的工具条（GMGN 第二行）：设置 / 收藏 / 持仓 / 最近浏览。点图标，同一条里展开对应的代币（持仓带快捷卖出）
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Settings, Star, History, Wallet, Zap, Loader2 } from './gi'
import clsx from 'clsx'
import { useApp } from '../store/app'
import { usePrefs } from '../store/prefs'
import { useUI } from '../store/ui'
import { compact, pct, usd } from '../lib/format'
import { buy, sell } from '../lib/trade'
import type { HoldingRow, Token } from '../lib/types'
import { Tip } from './Hover'
import { TokenAvatar } from './common'
import { useT, t as L } from '../lib/i18n'

type StripKey = 'fav' | 'hold' | 'hist'

export function TopStrip() {
  useT()
  const strip = usePrefs((s) => s.topStrip)
  const hist = usePrefs((s) => s.searchHistory)
  const set = usePrefs((s) => s.set)
  const favs = useApp((s) => s.favorites.items)
  const holdings = useApp((s) => s.holdings)
  const setUI = useUI((s) => s.set)
  const list = strip === 'fav' ? Object.entries(favs).sort((a, b) => b[1].at - a[1].at).map(([a, v]) => ({ a, sym: v.symbol })) : strip === 'hist' ? hist.map((a) => ({ a, sym: '' })) : []
  const pos = useMemo(() => (holdings?.rows || []).filter((r) => r.amount > 0).sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0)), [holdings?.rows])   // 选择器里不能 filter：每次返回新数组会让 zustand 无限重渲染
  const T = holdings?.totals
  // 持有的 NFT：不估值（OKX 对这些合集没有挂单价），顶部栏里放一个汇总，点进资产页 → NFT（转出 / 去 OKX）
  const nft = useApp((s) => s.nft)
  const nftTotal = nft?.total ?? 0
  const Btn = ({ k, icon, title, n }: { k: StripKey; icon: React.ReactNode; title: string; n?: number }) => (
    <button title={title} onClick={() => set({ topStrip: strip === k ? null : k })} className={clsx('icon-btn relative w-6 h-6', strip === k && '!text-t1 bg-btn-2')}>
      {icon}
      {!!n && <span className="absolute -top-0.5 -right-0.5 h-3 min-w-3 px-0.5 rounded-full bg-up text-on-accent text-2xs font-bold grid place-items-center">{n > 9 ? '9+' : n}</span>}
    </button>
  )
  return (
    <div className="h-8 flex-none flex items-center gap-1 px-3 border-b border-line bg-bg-deep">
      <button className="icon-btn w-6 h-6" title={L('ts.settings')} onClick={() => setUI({ settingsOpen: true, settingsTab: 'topbar' })}><Settings className="ico" /></button>
      <span className="w-px h-3.5 bg-line-2 mx-1" />
      <Btn k="fav" icon={<Star className="ico" />} title={L('ts.fav')} />
      <Btn k="hold" icon={<Wallet className="ico" />} title={L('ts.hold')} n={pos.length} />
      <Btn k="hist" icon={<History className="ico" />} title={L('ts.hist')} />
      <span className={clsx('w-px h-3.5 bg-line-2 mx-1 transition-opacity duration-150', strip ? 'opacity-100' : 'opacity-0')} />
      {strip === 'hold' && (
        <span className="flex-none flex items-center gap-2 pl-1 pr-2 text-sm">
          <span className="text-t3">{L('ts.holdN', { n: pos.length })}</span>
          {pos.length > 0 && <span className="text-t1 font-medium">{usd(T?.valueUsd)}</span>}
          {pos.length > 0 && T?.pnlUsd != null && <span className={clsx('font-medium', T.pnlUsd >= 0 ? 'text-up' : 'text-down')}>{T.pnlUsd >= 0 ? '+' : '-'}${Math.abs(T.pnlUsd).toFixed(2)}</span>}

        </span>
      )}
      <div key={strip || 'none'} className="strip-in flex-1 min-w-0 flex items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {strip === 'hold' && pos.map((r) => <PosChip key={r.token} r={r} />)}
        {strip === 'hold' && nftTotal > 0 && <NftChip total={nftTotal} kinds={(nft?.rows || []).filter((r) => r.count > 0).length} />}
        {strip === 'hold' && !pos.length && !nftTotal && <span className="text-sm text-t4 px-2">{holdings ? L('ts.noHold') : L('ts.loading')}</span>}
        {strip !== 'hold' && list.map(({ a, sym }) => <TokChip key={a} addr={a} sym={sym || ''} quick={strip === 'fav'} />)}
        {strip && strip !== 'hold' && !list.length && <span className="text-sm text-t4 px-2">{strip === 'fav' ? L('ts.noFav') : L('ts.noHist')}</span>}
      </div>
    </div>
  )
}

/** 收藏 / 最近浏览里的一个代币：头像、代号、市值、涨跌；收藏里还有快捷买入（模式和金额在「顶部栏设置」里） */
function TokChip({ addr, sym, quick }: { addr: string; sym: string; quick: boolean }) {
  const t = useApp((s) => s.tokens.get(addr))
  const tb = usePrefs((s) => s.topBar)
  const nav = useNavigate()
  const [busy, setBusy] = useState(false)
  const c = t?.chg?.h1 ?? t?.chg?.m5
  const canBuy = quick && !!t && tb.quick !== 'off' && !(t.gangFair && t.stage === 'curve')   // 打新认购中不能在这里买
  const doBuy = async (e: React.MouseEvent) => { e.stopPropagation(); if (!t) return; setBusy(true); try { await buy(t, { amount: tb.favAmount, preset: tb.favPreset, via: 'quick' }) } finally { setBusy(false) } }
  const btn = (
    <button onClick={doBuy} disabled={busy} className="h-5 px-1.5 rounded-xs bg-buy/14 text-buy text-xs font-medium hover:bg-buy hover:text-on-accent flex items-center gap-0.5 disabled:opacity-60">
      {busy ? <Loader2 className="w-2.5 h-2.5 spin" /> : <Zap className="w-2.5 h-2.5" fill="currentColor" />}{tb.favAmount}
    </button>
  )
  return (
    <div onClick={() => nav(`/token/${addr}`)} className="group/chip h-6 flex-none flex items-center gap-1.5 pl-1 pr-2 rounded-xs hover:bg-btn text-sm cursor-pointer">
      {t && <TokenAvatar t={t} size={16} badge={false} />}
      <span className="font-medium">{t?.symbol || sym || addr.slice(0, 6)}</span>
      {tb.favMc && t && <span className="text-t3">{usd(t.mcapUsd)}</span>}
      {tb.favChg && c != null && <span className={c >= 0 ? 'text-up' : 'text-down'}>{pct(c, 1)}</span>}
      {canBuy && tb.quick === 'always' && btn}
      {canBuy && tb.quick === 'hover' && <span className="hidden group-hover/chip:flex">{btn}</span>}
    </div>
  )
}

/** 持仓块（顶部条内，和收藏 / 最近浏览同一条）：名字、持仓金额、盈亏；点进去看详情；快捷卖出的模式和比例在「顶部栏设置」里 */
/** 持有的 NFT 汇总：点击进资产页的 NFT 标签（那里可以一键转到自己的 OKX 钱包、去 OKX 查看） */
function NftChip({ total, kinds }: { total: number; kinds: number }) {
  const nav = useNavigate()
  return (
    <Tip text={[L('ts.nft', { k: kinds, n: total }), L('ts.nftClick')]}>
      <button onClick={() => nav('/portfolio?tab=nft')} className="h-6 flex-none flex items-center gap-1.5 px-2 rounded-xs hover:bg-btn text-sm">
        <span className="font-medium">NFT</span><span className="text-t3">{total}</span>
      </button>
    </Tip>
  )
}

function PosChip({ r }: { r: HoldingRow }) {
  const tokens = useApp((s) => s.tokens)
  const tb = usePrefs((s) => s.topBar)
  const nav = useNavigate()
  const [busy, setBusy] = useState(0)
  const up = (r.pnlUsd ?? 0) >= 0
  const claim = r.stage === 'claim'   // 内盘买的还没开盘领到钱包：先不给卖
  const t = tokens.get(r.token.toLowerCase()) || ({ ...r, address: r.token } as unknown as Token)
  const sellPct = async (e: React.MouseEvent, pctOfHolding: number) => {
    e.stopPropagation(); e.preventDefault()
    setBusy(pctOfHolding)
    try { await sell(t, pctOfHolding, tb.holdPreset) } finally { setBusy(0) }
  }
  const data = (
    <span className="flex items-center gap-1.5">
      {tb.holdValue && <span className="text-t3">{usd(r.valueUsd)}</span>}
      {tb.holdPnl && r.pnlPct != null && <span className={clsx('font-medium', up ? 'text-up' : 'text-down')}>{up ? '+' : ''}{r.pnlPct.toFixed(1)}%</span>}
    </span>
  )
  const sells = (
    <span className="flex items-center justify-end gap-1">
      {claim
        ? <span className="text-warn text-xs">{L('ts.claimLater')}</span>
        : tb.holdPcts.map((p) => (
          <button key={p} onClick={(e) => sellPct(e, p)} disabled={busy > 0}
            className="h-5 px-1.5 rounded-xs bg-down/14 text-down text-xs font-medium hover:bg-down hover:text-on-accent disabled:opacity-50">{busy === p ? '…' : `${p}%`}</button>
        ))}
    </span>
  )
  return (
    <div onClick={() => nav(`/token/${r.token}`)} title={`${r.symbol} · ${compact(r.amount)} · ${usd(r.valueUsd)}`}
      className="group/chip h-6 flex-none flex items-center gap-1.5 pl-1 pr-2 rounded-xs hover:bg-btn text-sm cursor-pointer">
      <TokenAvatar t={t} size={16} badge={false} />
      <span className="font-medium">{r.symbol}</span>
      {tb.quick === 'off' && data}
      {tb.quick === 'always' && <>{data}{sells}</>}
      {/* 悬停显示：数据和快捷卖出叠在同一个格子里（宽度取较大的），切换时旁边的块不会被推着动 */}
      {tb.quick === 'hover' && (
        <span className="grid items-center">
          <span className="col-start-1 row-start-1 transition-opacity duration-100 group-hover/chip:opacity-0 group-hover/chip:pointer-events-none">{data}</span>
          <span className="col-start-1 row-start-1 opacity-0 pointer-events-none transition-opacity duration-100 group-hover/chip:opacity-100 group-hover/chip:pointer-events-auto">{sells}</span>
        </span>
      )}
    </div>
  )
}
