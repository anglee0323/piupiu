// 雷达命中提醒：新进入推荐、且符合「雷达筛选」的项目，在任意页面右上角（顶栏下方）弹出一张卡片；右下角留给下单 / 铸造结果通知。
// 卡片上可以直接「一键铸造」（先预检，再确认；不离开当前页面），或「查看」跳到雷达详情。
// 哪些项目要提醒由 Gateway 判断（engine/live/notifier.js：新进入推荐 + 符合雷达筛选 + 冷却），通过 alert 事件推来；
// 这里只负责弹卡片。在雷达页时不弹（列表「最新」里已经能看到），声音照响（store/app.ts）。
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { useLocation, useNavigate } from 'react-router-dom'
import { useApp } from '../store/app'
import { usePrefs } from '../store/prefs'
import { useUI } from '../store/ui'
import { api } from '../lib/api'
import { age } from '../lib/format'
import type { RadarItem } from '../lib/types'
import { Loader2, X } from './gi'
import { WalletTag } from './WalletPicker'
import { t as T, lz } from '../lib/i18n'
import { requireWallet } from '../lib/trade'

const MAX_CARDS = 3
// 没有操作时多少秒后自动收起：雷达设置里的 prefs.radarAlertSecs（默认 10 秒，0 = 不自动收起）；鼠标停在卡片上、预检 / 提交中不收

const fmtBnb = (wei?: string | null) => { if (wei == null) return '—'; const x = Number(BigInt(wei)) / 1e18; return x === 0 ? '0' : String(+x.toFixed(x < 0.01 ? 5 : 4)) }
const priceText = (it: RadarItem) => (it.free === true ? T('rd.free') : it.price && it.price !== '0' ? `${fmtBnb(it.price)} BNB` : it.free === false ? T('rd.paid') : null)

export function useRadarAlerts() {
  const radar = useApp((s) => s.radar)
  const hit = useApp((s) => s.radarHit)
  const loc = useLocation()
  const [cards, setCards] = useState<{ it: RadarItem; at: number }[]>([])
  const onRadar = loc.pathname.startsWith('/radar')
  useEffect(() => {
    if (!hit || onRadar) return
    const items = radar?.items || []
    const hits = hit.ids.map((id) => items.find((x) => x.id === id)).filter((x): x is RadarItem => !!x)
    if (!hits.length) return
    setCards((cs) => [...hits.map((it) => ({ it, at: Date.now() })), ...cs.filter((c) => !hits.some((h) => h.id === c.it.id))].slice(0, MAX_CARDS))
  }, [hit?.seq])   // eslint-disable-line react-hooks/exhaustive-deps
  // 卡片上的数据跟着列表更新（价格、已铸比例变化）
  const live = cards.map((c) => ({ ...c, it: radar?.items.find((x) => x.id === c.it.id) || c.it }))
  return { cards: live, drop: (id: string) => setCards((cs) => cs.filter((c) => c.it.id !== id)) }
}

export function RadarAlerts() {
  const { cards, drop } = useRadarAlerts()
  if (!cards.length) return null
  return (
    <div className="fixed right-4 top-[68px] z-[120] flex flex-col gap-2 w-[340px]">
      {cards.map((c) => <AlertCard key={c.it.id} it={c.it} at={c.at} onClose={() => drop(c.it.id)} />)}
    </div>
  )
}

type Preview = { previewId: string; expiresAt: number; rows: { slot: number; ok: boolean; valueWei?: string; reason?: string; risks?: string[]; needAppConfirm?: boolean }[] }

function AlertCard({ it, at, onClose }: { it: RadarItem; at: number; onClose: () => void }) {
  const nav = useNavigate()
  const slots = useApp((s) => s.slots)
  const canTrade = useApp((s) => !!s.radar?.canTrade)
  const quickOn = useApp((s) => !!s.radar?.settings?.quickMint)   // 一键直铸（雷达设置里，默认关）
  const life = usePrefs((s) => s.radarAlertSecs ?? 10) * 1000
  const lang = usePrefs((s) => s.lang)
  const [hover, setHover] = useState(false)
  const [busy, setBusy] = useState<'' | 'check' | 'send'>('')
  const [pv, setPv] = useState<Preview | null>(null)
  const [err, setErr] = useState('')
  const [sent, setSent] = useState(false)
  const [now, setNow] = useState(Date.now())
  const closeRef = useRef(onClose); closeRef.current = onClose
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  // 自动收起：没有操作、鼠标不在卡片上
  const idle = !hover && !busy && !pv
  useEffect(() => { if (!idle || (!life && !sent)) return; const left = sent ? 4000 : Math.max(2000, life - (Date.now() - at)); const t = setTimeout(() => closeRef.current(), left); return () => clearTimeout(t) }, [idle, sent, at, life])

  const wallets = slots?.tradeSlots?.length ? slots.tradeSlots : [slots?.primary || 1]
  const mintable = canTrade && it.canDo && !it.mineExhausted
  const okRows = (pv?.rows || []).filter((r) => r.ok)
  const total = okRows.reduce((s, r) => s + BigInt(r.valueWei || 0), 0n)
  const expired = !!pv && now > pv.expiresAt
  const view = () => { nav(`/radar?a=${it.address}`); onClose() }
  const check = async () => {
    if (!requireWallet()) return
    setBusy('check'); setErr(''); setPv(null)
    try {
      const r = await api<Preview>(`/api/radar/${it.address}/preview`, { slots: wallets, qty: 1 })
      setPv(r)
      const ok = r.rows.filter((x) => x.ok)
      if (!ok.length) setErr(r.rows.map((x) => `W${x.slot}: ${lz(x.reason) || T('ra.pvFail')}`).join('; '))
      // 一键直铸：开关开着、免费、币安钱包没有风险提示 → 预检通过就直接提交（服务端会再核一遍，不满足就退回「确认铸造」）
      else if (quickOn && ok.every((x) => String(x.valueWei || '0') === '0' && !(x.risks?.length))) {
        setBusy('send')
        try { await api(`/api/radar/${it.address}/submit`, { previewId: r.previewId, slots: ok.map((x) => x.slot), quick: true }); setPv(null); setSent(true) } catch (e: any) { setErr(e.message) }
      }
    } catch (e: any) { setErr(e.message) }
    setBusy('')
  }
  const send = async () => {
    if (!pv || !okRows.length) return
    if (usePrefs.getState().confirmOrders) {
      const ok = await useUI.getState().ask({
        title: T('rd.mintTitle', { name: title }), okText: T('rd.confirmN', { n: okRows.length }),
        rows: [[T('rd.wallets'), okRows.map((r) => `W${r.slot}`).join(', ')], [T('rd.totalFee'), total === 0n ? T('rd.freeGas') : `${fmtBnb(String(total))} BNB + gas`], [T('rd.note'), T('rd.signNote')]],
      })
      if (!ok) return
    }
    setBusy('send'); setErr('')
    try { await api(`/api/radar/${it.address}/submit`, { previewId: pv.previewId, slots: okRows.map((r) => r.slot) }); setPv(null); setSent(true) } catch (e: any) { setErr(e.message) }
    setBusy('')
  }

  const facts = [
    priceText(it),
    it.supply?.pct != null ? T('rd.mintedPct', { p: it.supply.pct.toFixed(0) }) : null,
    it.aiCallers > 0 ? T('ra.aiN', { n: it.aiCallers }) : null,
    it.bornAt ? T(it.bornBy === 'deploy' ? 'rd.deployed' : 'rd.found', { t: age(it.bornAt) }) : null,
  ].filter(Boolean)
  const title = lang === 'en' && it.titleK ? T(it.titleK.k, it.titleK.p || undefined) : it.title
  const line = lang === 'en' ? it.taglineEn || (it.kind ? T('rk.' + it.kind) : null) : it.tagline   // 英文界面用项目原文描述

  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} className="toast-in pop px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        {it.image ? <img src={it.image} alt="" className="w-10 h-10 rounded-md object-cover flex-none bg-card" /> : <div className="w-10 h-10 rounded-md flex-none bg-card" />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[11px] text-up flex-none">{T('ra.newRec')}</span>
            <span className="text-base font-semibold truncate">{title}</span>
            {it.priority && <span className={clsx('chip !h-[18px] !text-[10px] flex-none tabular-nums', it.priority.level === 'high' && '!border-up/50 text-up')}>{it.priority.score}</span>}
            <span className="flex-1" />
            <button className="icon-btn w-6 h-6 -mr-1 flex-none" onClick={onClose} aria-label={T('ra.close')}><X className="ico-sm" /></button>
          </div>
          {line && <div className="text-xs text-t2 line-clamp-1 mt-0.5">{line}</div>}
          {facts.length > 0 && <div className="text-[11px] text-t3 mt-0.5">{facts.join(' · ')}</div>}
          {sent ? <div className="text-xs text-up mt-2">{T('ra.sent')}</div> : (
            <div className="flex items-center gap-2 mt-2">
              {mintable && !pv && <button onClick={check} disabled={!!busy} className="h-7 px-3 rounded-sm bg-up text-on-accent text-sm font-semibold flex items-center gap-1.5 whitespace-nowrap disabled:opacity-60">{busy && <Loader2 className="ico-sm spin" />}{busy === 'check' ? T('ra.checking') : busy === 'send' ? T('ra.submitting') : T('rd.oneClickMint')}</button>}
              {pv && okRows.length > 0 && !expired && (
                <button onClick={send} disabled={!!busy} className="h-7 px-3 rounded-sm bg-up text-on-accent text-sm font-semibold flex items-center gap-1.5 whitespace-nowrap disabled:opacity-60">
                  {busy === 'send' && <Loader2 className="ico-sm spin" />}{T('ra.confirm', { fee: total === 0n ? T('rd.free') : `${fmtBnb(String(total))} BNB` })}
                </button>
              )}
              {pv && expired && <button onClick={check} className="h-7 px-3 rounded-sm bg-btn-2 text-sm">{T('ra.expired')}</button>}
              <button onClick={view} className="h-7 px-3 rounded-sm bg-btn hover:bg-btn-2 text-sm text-t1 whitespace-nowrap">{T('ra.view')}</button>
              <span className="flex-1" />
              {pv && okRows.length > 0 && !expired && <span className="flex items-center gap-1 text-[11px] text-t4">{okRows.map((r) => <WalletTag key={r.slot} slot={r.slot} />)}{Math.max(0, Math.ceil((pv.expiresAt - now) / 1000))}s</span>}
            </div>
          )}
          {!mintable && !sent && <div className="text-[11px] text-t4 mt-1">{!canTrade ? T('ra.demo') : it.mineExhausted ? T('ra.minted') : T('ra.noOneClick')}</div>}
          {err && <div className="text-[11px] text-down mt-1 break-words">{err}</div>}
        </div>
      </div>
    </div>
  )
}
