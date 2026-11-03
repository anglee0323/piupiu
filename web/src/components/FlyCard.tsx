// 铸币飞轮卡片（代币页右侧，和打新卡片同一位置）：开盘前替代普通下单面板（按份铸造 / 卖回），开盘后放在下单面板下面
// （开盘后铸造、领持有人奖励）。规则来自 gang.fun 官方说明（skill/references/fly.md），数据：t.gangFly（行情推送）+ /api/gang/fly/:addr（钱包的额度、可卖回份数、奖励）
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { Token } from '../lib/types'
import { useApp } from '../store/app'
import { usePrefs } from '../store/prefs'
import { flyClaim, flyMint, flySellBack } from '../lib/trade'
import { bnb, compact, fullTime } from '../lib/format'
import { RangeSlider } from './common'
import { useT } from '../lib/i18n'

type FlyInfo = {
  wallet: { slot: number; address: string } | null
  quotaLeft?: number; preShares?: number; used?: number; bonus?: number
  withdrawAll?: { shares: number; payout: number; fee: number } | null
  pendingReward?: number
  postOne?: { price?: number; tokens?: number; paused?: boolean; note?: string } | null
}

export function FlyCard({ t, compactMode = false }: { t: Token; compactMode?: boolean }) {
  const tr = useT()
  const f = t.gangFly!
  const preset = usePrefs((s) => s.activePreset)
  const slot = useApp((s) => s.slots?.tradeSlots?.[0] ?? s.slots?.primary ?? 1)
  const [info, setInfo] = useState<FlyInfo | null>(null)
  const [n, setN] = useState(1)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    const load = () => api<FlyInfo>(`/api/gang/fly/${t.address}?slot=${slot}`).then((v) => { if (alive) setInfo(v) }).catch(() => {})
    load(); const h = setInterval(load, 10_000)
    return () => { alive = false; clearInterval(h) }
  }, [t.address, slot])
  const launched = t.stage !== 'curve'
  const perShare = f.sharePrice * (1 + f.mintFeePct / 100)
  const left = info?.quotaLeft ?? null
  const maxN = Math.max(1, Math.min(f.maxPerTx || 10, left ?? (f.maxPerTx || 10)))
  const shares = Math.max(1, Math.min(Math.floor(n) || 1, maxN))
  const status = f.refundOnly ? 'refund' : launched ? 'launched' : f.status === 'minting' ? 'minting' : 'filled'
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn() } finally { setBusy(false); setTimeout(() => api<FlyInfo>(`/api/gang/fly/${t.address}?slot=${slot}`).then(setInfo).catch(() => {}), 4000) } }
  const stat = (k: string, v: React.ReactNode) => <div key={k} className="rounded-xs bg-card px-2.5 py-1.5 min-w-0"><div className="text-xs text-t3">{k}</div><div className="font-medium mt-0.5 leading-5 break-words">{v}</div></div>
  const btn = 'h-10 w-full rounded-sm text-md font-semibold flex items-center justify-center gap-2 disabled:opacity-50'
  const post = info?.postOne
  const poolPrice = t.price > 0 ? t.price : null
  const mintPrice = post?.price && post.tokens ? post.price / post.tokens : null
  return (
    <div className={compactMode ? 'flex flex-col gap-3 px-3 pb-3' : 'flex flex-col gap-3 p-3'}>
      <div className="rounded-sm bg-btn p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-md font-medium">{tr('fly.title')}</span>
          <span className={`h-5 px-2 rounded-full text-xs grid place-items-center ${status === 'minting' ? 'bg-up/14 text-up' : status === 'refund' ? 'bg-warn/14 text-warn' : 'bg-card text-t3'}`}>{tr(`fly.st.${status}`)}</span>
        </div>
        {!launched && (
          <div className="space-y-1">
            <div className="h-1.5 rounded-full bg-card overflow-hidden"><div className="h-full rounded-full bg-up transition-[width] duration-500" style={{ width: `${Math.min(100, (f.sold / Math.max(1, f.totalShares)) * 100)}%` }} /></div>
            <div className="flex justify-between text-xs text-t3 tabular-nums"><span>{tr('fly.shares', { sold: f.sold, total: f.totalShares })}</span><span>{((f.sold / Math.max(1, f.totalShares)) * 100).toFixed(2)}%</span></div>
          </div>
        )}
        <div className="text-sm text-t2 leading-6">{launched ? (f.postMint ? tr('fly.descPostOn') : tr('fly.descPostOff')) : tr('fly.desc', { n: compact(f.tokensPerShare), total: f.totalShares })}</div>
        <div className="grid grid-cols-2 gap-2 pt-1 text-sm">
          {!launched && stat(tr('fly.price'), tr('fly.priceVal', { p: +f.sharePrice.toPrecision(4), f: f.mintFeePct }))}
          {!launched && stat(tr('fly.perShare'), tr('fly.perShareVal', { n: compact(f.tokensPerShare) }))}
          {stat(tr('fly.quota'), f.inviteBonus ? tr('fly.quotaVal', { n: f.baseQuota, b: f.inviteBonus }) : tr('fly.quotaN', { n: f.baseQuota }))}
          {stat(tr('fly.participants'), String(f.participants))}
          {launched && f.postMint && mintPrice != null && stat(tr('fly.postPrice'), `${compact(mintPrice, 3)} / ${poolPrice ? compact(poolPrice, 3) : '—'}`)}
          {launched && stat(tr('fly.tax'), tr('fly.taxVal', { b: f.buyTaxPct, s: f.sellTaxPct }))}
        </div>
        {status === 'filled' && f.launchAt && <div className="text-xs text-t3">{tr('fly.launchAt', { t: fullTime(f.launchAt) })}</div>}
      </div>

      {info?.wallet ? (
        <div className="flex items-center gap-4 text-sm px-0.5">
          <span className="text-t3">{tr('fly.myLeft')} <b className="text-t1 font-medium tabular-nums">{info.quotaLeft ?? 0}</b></span>
          {!launched && <span className="text-t3">{tr('fly.myBack')} <b className="text-t1 font-medium tabular-nums">{info.preShares ?? 0}</b></span>}
          {(info.bonus ?? 0) > 0 && <span className="text-t3">{tr('fly.myBonus')} <b className="text-t1 font-medium tabular-nums">+{info.bonus}</b></span>}
        </div>
      ) : <div className="text-sm text-t3 px-0.5">{tr('fly.noWallet')}</div>}

      {/* 开盘前：按份铸造 + 卖回 */}
      {!launched && status === 'minting' && (
        <div className="space-y-2.5">
          <div className="flex items-baseline justify-between text-sm px-0.5">
            <span className="text-t3">{tr('fly.n')}</span>
            <span><b className="text-lg font-semibold tabular-nums">{shares}</b><span className="text-t3 ml-1.5">{tr('fly.approx', { v: bnb(shares * perShare), n: compact(shares * f.tokensPerShare) })}</span></span>
          </div>
          <RangeSlider value={shares} max={maxN} onChange={setN} disabled={busy || left === 0} />
          <button className={`${btn} bg-buy text-on-accent hover:brightness-110`} disabled={busy || left === 0} onClick={() => run(() => flyMint(t, shares, perShare, preset))}>
            {left === 0 ? tr('fly.quotaOut') : tr('fly.mintBtn', { n: shares, v: bnb(shares * perShare) })}
          </button>
        </div>
      )}
      {!launched && (f.withdrawable || f.sellBackOpen || f.refundOnly) && info?.withdrawAll && (
        <button className={`${btn} bg-btn text-t1 hover:bg-btn-2`} disabled={busy} onClick={() => run(() => flySellBack(t, info.withdrawAll!.shares, info.preShares || info.withdrawAll!.shares, info.withdrawAll!.payout, preset))}>
          {tr('fly.backBtn', { n: info.withdrawAll.shares, v: bnb(info.withdrawAll.payout) })}
        </button>
      )}

      {/* 开盘后：继续铸造（价格按档位，不低于池子价） */}
      {launched && f.postMint && (
        post?.paused ? <div className="text-xs text-t3 leading-5">{tr('fly.postPaused')}</div>
        : post?.price ? (
          <div className="space-y-2.5">
            <div className="flex items-baseline justify-between text-sm px-0.5">
              <span className="text-t3">{tr('fly.n')}</span>
              <span><b className="text-lg font-semibold tabular-nums">{shares}</b><span className="text-t3 ml-1.5">{tr('fly.approxPost', { v: bnb(shares * post.price), n: post.tokens ? compact(shares * post.tokens) : '—' })}</span></span>
            </div>
            <RangeSlider value={shares} max={maxN} onChange={setN} disabled={busy || left === 0} />
            <button className={`${btn} bg-buy text-on-accent hover:brightness-110`} disabled={busy || left === 0} onClick={() => run(() => flyMint(t, shares, post.price!, preset, true))}>
              {left === 0 ? tr('fly.quotaOut') : tr('fly.postBtn', { n: shares, v: bnb(shares * post.price) })}
            </button>
          </div>
        ) : null
      )}
      {launched && (info?.pendingReward || 0) > 0 && info?.wallet && (
        <button className={`${btn} bg-btn text-t1 hover:bg-btn-2`} disabled={busy} onClick={() => run(() => flyClaim(t, info.wallet!.slot, info.pendingReward!))}>
          {tr('fly.claimBtn', { v: bnb(info.pendingReward!) })}
        </button>
      )}
      <div className="text-xs text-t3 leading-5">{launched ? tr('fly.rules', { s: f.sellTaxPct, h: f.holdPct }) : tr('fly.preRules', { e: f.exitFeeNowPct, b: f.inviteBonus })}</div>
    </div>
  )
}
