// 机会雷达 · 工作台（docs/PLAN-RADAR.md、docs/PLAN-RADAR-WORKBENCH-V4.md）
// 页面只做三件事：挑一个 → 铸 → 铸完处理。
//   左：推荐 / 已关注 / 已铸造。操作（关注、不再显示）常驻在固定槽位，不悬浮、不盖文字。
//   右：一张完整的详情页，所有内容在同一个滚动容器里（没有单独吸顶的小面板）。
// 列表：最新（按进入推荐的时间）/ 最高分 / 即将打满（已铸比例达到门槛、未铸完，不限是否在推荐里）/ 已关注 / 已铸造；「筛选」同时决定列表和右上角命中提醒（components/RadarAlerts.tsx）。
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { useApp } from '../store/app'
import { emptyRadarFilter, radarFilterCount, recommendedRadarFilter, usePrefs, type RadarFilter } from '../store/prefs'
import { matchRadar, matchRadarSoon, RADAR_SOON_PCTS, RADAR_SOON_AGES, type RadarSoon } from '../../../shared/filters.js'
import { useUI } from '../store/ui'
import { api } from '../lib/api'
import { age } from '../lib/format'
import { playSound } from '../lib/sound'
import { CopyBtn, Modal, NumBox, NumField, useOutsideClose, useWidth } from '../components/common'
import { Section, Rows, Row as SetRow, Toggle, RowBtn, Switch } from '../components/SettingsKit'
import { ExternalLink, AlertTriangle, ChevronRight, EyeOff, Filter, G, Loader2, Star, X } from '../components/gi'
import { TaskWallets, WalletTag } from '../components/WalletPicker'
import { XLogo } from '../components/icons'
import { NftDest, NFT_TRANSFER } from '../components/NftDest'
import { okxAssetUrl, okxCollectionUrl } from '../lib/okx'
import { quickTransfer } from '../lib/nftTransfer'
import { Tip } from '../components/Hover'
import type { RadarDetail, RadarHoldings, RadarItem, RadarKP, RadarMint, RadarView } from '../lib/types'
import { useT, t as T, lz } from '../lib/i18n'
import { proxyId, reasonId } from '../../../shared/radarLabels.js'
import { requireWallet } from '../lib/trade'
import { DEMO, demoParam } from '../lib/env'

/** 一键直铸的条件（和服务端 participate.submit 的校验一致）：预检通过的钱包全部免费、币安钱包没有风险提示 */
const quickMintable = (rows: any[]) => rows.length > 0 && rows.every((r) => String(r.valueWei || '0') === '0' && !(r.risks?.length))
const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')
const fmtBnb = (wei?: string | null) => { if (wei == null) return '—'; const x = Number(BigInt(wei)) / 1e18; return x === 0 ? '0' : x < 0.0001 ? x.toExponential(2) : String(+x.toFixed(x < 0.01 ? 5 : 4)) }
// 「基本信息」每行的核验方式：第三列淡色文字（不用带框的标签），悬停看来源说明；模拟通过 / 实际成功用绿色
const EV_COLOR: Record<string, string> = { none: 'text-t4', source: 'text-t3', chain: 'text-t3', sim: 'text-up', done: 'text-up' }
const n = (x?: number | null) => (x == null ? '—' : Math.round(x).toLocaleString('en-US'))
type Tab = 'new' | 'top' | 'soon' | 'follow' | 'mine'
// 网关生成的文字：中文界面用原文；英文界面按网关给的文案键显示（旧数据没有键就退回原文）
const isEn = () => usePrefs.getState().lang === 'en'
const ago = (ts: number) => T('rd.ago', { t: age(ts) })
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const utilTags = (ids: unknown) => String(ids || '').split(',').filter(Boolean).map((id) => T('ut.' + id)).join(', ')
function partText(x: { k?: string; p?: Record<string, any>; why?: string }) {
  if (!x.k || !isEn()) return x.why || ''
  if (x.k === 'rs.util') return T('rs.util', { tags: utilTags(x.p?.ids) || x.p?.tags })
  if (x.k === 'rs.admin') return T('rs.admin', { label: x.p?.id ? T('risk.' + x.p.id) : x.p?.label })
  return T(x.k, x.p)
}
/** 列表条目上的简短理由（英文） */
function chipText(x: RadarKP) {
  if (x.k === 'rs.util') return utilTags(x.p?.ids)
  if (x.k === 'rs.left') return T('rs.left.s', x.p || undefined)
  if (x.k === 'rs.admin') return cap(x.p?.id ? T('risk.' + x.p.id) : String(x.p?.label || ''))
  return T(x.k, x.p || undefined)
}
const titleOf = (it: { title: string; titleK?: RadarKP | null }) => (isEn() && it.titleK ? T(it.titleK.k, it.titleK.p || undefined) : it.title)
const kindText = (kind?: string | null, zh?: string | null) => (isEn() ? (kind ? T('rk.' + kind) : null) : zh)
const recipeWhy = (r: { why?: string; whyK?: string; whyP?: Record<string, any> } | null | undefined) => (r?.whyK && isEn() ? T(r.whyK, r.whyP) : r?.why || '')
const reasonText = (r?: string | null) => (r && isEn() && reasonId(r) ? T('rv.f.' + reasonId(r)) : lz(r))
const ACT_KEY: Record<string, string> = { '聚合器交易': 'agg', 'WBNB 包装 / 解包': 'wbnb', 'Four 内盘交易': 'four', 'Gang 内盘交易': 'gang', 'Agent ID 注册 / 转移': 'agentId', '其他合约': 'other' }   // i18n-ignore（网关给的中文标签 → 文案键）
const OFF_FROM_ADDR = '该账号发布过合约地址'   // i18n-ignore（网关 social.js 写的来源原文）
const actLabel = (l: string) => (isEn() && ACT_KEY[l] ? T('rd.act.' + ACT_KEY[l]) : l)
const TREND_KINDS = ['nft-mint', 'token-mint', 'claim', 'trade', 'launch', 'interact']
function trendText(t: RadarView['trend'][number]) {
  if (t.gate == null || !TREND_KINDS.includes(t.kind)) return t.label
  const p = t.kind === 'nft-mint' ? T(t.free ? 'rd.trend.free' : 'rd.trend.paid') : t.kind === 'token-mint' && t.free ? T('rd.trend.free') : ''
  return cap(T('rd.trend.' + t.kind, { p, g: t.gate ? T('rd.trend.agent') : '' }).trim())
}
const supplyText = (s: { minted: number | null; max: number | null; pct: number | null }) =>
  s.max ? `${s.minted != null ? n(s.minted) : T('rd.unknown')} / ${n(s.max)}${s.pct != null ? T('rd.pctParen', { p: s.pct.toFixed(1) }) : ''}` : T('rd.mintedOnly', { n: n(s.minted) })

function Thumb({ src, seed, size = 44 }: { src?: string | null; seed: string; size?: number }) {
  const [bad, setBad] = useState(false)
  const hue = parseInt(seed.slice(2, 6), 16) % 360
  if (src && !bad) return <img src={src} onError={() => setBad(true)} className="rounded-md object-cover flex-none bg-card" style={{ width: size, height: size }} alt="" />
  return <div className="rounded-md flex-none" style={{ width: size, height: size, background: `linear-gradient(135deg, hsl(${hue} 50% 32%), hsl(${(hue + 60) % 360} 50% 20%))` }} />
}

/** 评分只表达排序档位，不做成安全认证；颜色只用在中性底色上 */
type ScoreLike = { score: number; level: 'high' | 'mid' | 'low'; label: string } | null
function Score({ p, big = false }: { p: ScoreLike; big?: boolean }) {
  if (!p) return <span className={clsx('chip flex-none justify-center', big ? '!h-7 !text-sm' : '!h-[18px] !text-[10px]')}>{big ? T('rd.pending') : '—'}</span>
  return (
    <Tip text={T('rd.scoreTip', { s: p.score, l: T('rs.lvl.' + p.level) })}>
      <span className={clsx('chip flex-none justify-center gap-1 tabular-nums', big && '!h-7 !text-sm', p.level === 'high' && '!border-up/50')}>
        {big && <span className="text-t3">{T('rs.lvl.' + p.level)}</span>}<span className={clsx('font-semibold', p.level === 'high' ? 'text-up' : 'text-t1')}>{p.score}</span>
      </span>
    </Tip>
  )
}

function Card({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-md border border-line bg-card p-3.5 space-y-2.5">
      <div className="flex items-center gap-2 min-w-0"><span className="text-md font-semibold truncate">{title}</span><span className="flex-1" />{right}</div>
      {children}
    </section>
  )
}
function More({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="rounded-md border border-line">
      <button onClick={() => setOpen(!open)} className="w-full h-10 px-3.5 flex items-center gap-2 text-sm text-t2 hover:text-t1"><span className="font-medium">{title}</span><span className="flex-1" /><ChevronRight className={clsx('ico-sm transition-transform', open ? '-rotate-90' : 'rotate-90')} /></button>
      {open && <div className="px-3.5 pb-3.5">{children}</div>}
    </section>
  )
}

/** 顶部一行：最近 .ai 钱包主要在做什么（点开看明细） */
function NowLine({ v, onPick }: { v: RadarView; onPick: (a: string) => void }) {
  const [open, setOpen] = useState(false)
  const t = v.trend[0]
  return (
    <div className="flex-none border-b border-line px-4 text-xs">
      <button onClick={() => setOpen(!open)} className="h-8 w-full flex items-center gap-2 text-t3 hover:text-t1 min-w-0">
        <span className="truncate">{T('rd.now', { n: v.activity.active })}{t ? <>{T('rd.nowMain')}<span className="text-t1">{trendText(t)}</span>{T('rd.nowCount', { n: t.count, c: t.creators > 1 ? T('rd.nowCreators', { n: t.creators }) : '' })}</> : ''}</span>
        <span className="flex-1" /><span className="flex-none">{open ? T('rd.collapse') : T('rd.spread')}</span><ChevronRight className={clsx('ico-sm flex-none transition-transform', open ? '-rotate-90' : 'rotate-90')} />
      </button>
      {open && (
        <div className="pb-2.5 flex flex-wrap gap-1.5">
          {v.activity.rows.map((r) => (
            <button key={r.key} disabled={!r.address} onClick={() => r.address && onPick(r.address)} className={clsx('chip', r.cand ? '!border-up/40 text-up hover:bg-up/10' : 'text-t3 cursor-default')}>{actLabel(r.label)}<span className="text-t4">{r.ai}</span></button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 队列条目：选择区是一条独立的覆盖按钮；关注 / 隐藏常驻在右侧固定槽位，永远不压住文字 */
function Row({ it, on, isNew, when, onSelect, onFollow, onHide }: { it: RadarItem; on: boolean; isNew: boolean; when?: boolean; onSelect: () => void; onFollow: () => void; onHide: () => void }) {
  const sup = it.supply
  const facts = [
    when && it.recAt ? T('rd.recAgo', { t: age(it.recAt) }) : null,
    it.bornAt ? T(it.bornBy === 'deploy' ? 'rd.deployed' : 'rd.found', { t: age(it.bornAt) }) : null,
    it.free === true ? T('rd.free') : it.price && it.price !== '0' ? `${fmtBnb(it.price)} BNB` : it.free === false ? T('rd.paid') : null,
    sup?.pct != null ? `${T('rd.mintedPct', { p: sup.pct.toFixed(0) })}${sup.max ? ` / ${n(sup.max)}` : ''}` : null,
    it.aiCallers > 0 ? T('rd.aiJoined', { n: it.aiCallers }) : null,
  ].filter(Boolean) as string[]
  const why = isEn() && it.whyK ? it.whyK.map(chipText) : it.why, whyNot = isEn() && it.whyNotK ? it.whyNotK.map(chipText) : it.whyNot
  const line = isEn() ? it.taglineEn || kindText(it.kind) || '—' : it.tagline || it.utility || it.kindLabel || '—'
  return (
    <div className={clsx('relative border-b border-line transition-colors', on ? 'bg-hover-2' : 'hover:bg-hover')}>
      <button type="button" onClick={onSelect} aria-label={T('rd.view', { name: titleOf(it) })} className="absolute inset-0 z-0 rounded-none" />
      <div className="relative z-[1] pointer-events-none flex gap-2.5 px-3 py-2.5">
        <Thumb src={it.image} seed={it.address} />
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-md font-semibold truncate" title={titleOf(it)}>{titleOf(it)}</span>
            {it.followed && <Star className="w-3 h-3 text-warn flex-none" fill="currentColor" />}
            {isNew && <span className="chip !h-[18px] !text-[10px] !border-up/50 text-up flex-none">{T('rd.new')}</span>}
            {it.mintTx > 0 && <span className="chip !h-[18px] !text-[10px] !border-up/40 text-up flex-none">{T('rd.mintedN', { n: it.nft || it.mintTx })}</span>}
            {it.blocked && <span className="chip !h-[18px] !text-[10px] text-t4 flex-none">{T('rd.hidden')}</span>}
          </div>
          <div className="text-xs text-t2 line-clamp-2 break-words">{it.analyzed ? line : it.queuePos ? T('rd.queued', { n: it.queuePos }) : T('rd.analyzing')}</div>
          {facts.length > 0 && <div className="text-[11px] text-t3 break-words">{facts.join(' · ')}</div>}
          {it.analyzed && (
            <div className="text-[11px] flex flex-wrap gap-x-3 gap-y-0.5 break-words">
              {why.map((w) => <span key={w} className="text-t2">{w}</span>)}
              {!it.mineExhausted && whyNot.map((w) => <span key={w} className="text-warn inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3 flex-none" />{w}</span>)}
              {it.mineExhausted && <span className="text-t3">{T('rd.mineDone')}</span>}
              {!why.length && !whyNot.length && !it.mineExhausted && <span className="text-t4">{it.canDo ? T('rd.canOneClick') : T('rd.noOneClick')}</span>}
            </div>
          )}
        </div>
        <div className="flex-none w-[68px] flex flex-col items-end gap-1.5">
          <Score p={it.priority} />
          <div className="flex gap-0.5 pointer-events-auto">
            <Tip text={it.followed ? T('rd.unfollow') : T('rd.follow')}>
              <button className={clsx('icon-btn w-7 h-7', it.followed && '!text-warn')} onClick={(e) => { e.stopPropagation(); onFollow() }}>
                <Star className="ico-sm" fill={it.followed ? 'currentColor' : 'none'} />
              </button>
            </Tip>
            <Tip text={T('rd.hideTip')}>
              <button className="icon-btn w-7 h-7 hover:!text-warn" onClick={(e) => { e.stopPropagation(); onHide() }}>
                <EyeOff className="ico-sm" />
              </button>
            </Tip>
          </div>
        </div>
      </div>
    </div>
  )
}

const MINT_STATUS: Record<string, string> = {   // 状态 → 颜色；文字在字典 rd.st.*
  sending: 'text-t2', broadcast: 'text-warn', done: 'text-up', 'done-nothing': 'text-t2',
  failed: 'text-down', unknown: 'text-warn', unconfirmed: 'text-warn', 'app-confirm': 'text-warn', transferred: 'text-up',
}
export const mintStatus = (s: string): [string, string] => (MINT_STATUS[s] ? [T('rd.st.' + s), MINT_STATUS[s]] : [s, 'text-t2'])

/** 铸造：模拟铸造（不发交易）→ 确认铸造 */
function Mint({ d, canTrade }: { d: RadarDetail; canTrade: boolean }) {
  const an = d.analysis!
  const slots = useApp((s) => s.slots)
  const [wallets, setWallets] = useState<number[]>(() => slots?.tradeSlots?.length ? slots.tradeSlots : [slots?.primary || 1])
  const [qty, setQty] = useState(1)
  const [pv, setPv] = useState<any>(null)
  const [pick, setPick] = useState<number[]>([])
  const [busy, setBusy] = useState<'' | 'check' | 'send'>('')
  const [err, setErr] = useState('')
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  const supported = !!an.recipe?.supported
  const quickOn = useApp((s) => !!s.radar?.settings?.quickMint)   // 一键直铸（雷达设置里，默认关）
  const check = async () => {
    if (!requireWallet()) return   // 没连接钱包：先扫码登录，不发预检
    setBusy('check'); setErr(''); setPv(null)
    try {
      const r = await api<any>(`/api/radar/${d.address}/preview`, { slots: wallets, qty })
      const ok = r.rows.filter((x: any) => x.ok)
      setPv(r); setPick(ok.map((x: any) => x.slot))
      // 一键直铸：开关开着、免费、币安钱包没有风险提示 → 预检通过就直接提交（服务端会再核一遍，不满足就退回下面的确认）
      if (quickOn && quickMintable(ok)) {
        setBusy('send')
        try { await api(`/api/radar/${d.address}/submit`, { previewId: r.previewId, slots: ok.map((x: any) => x.slot), quick: true }); setPv(null) } catch (e: any) { setErr(`${e.message}`) }
      }
    } catch (e: any) { setErr(e.message) }
    setBusy('')
  }
  const expired = pv && now > pv.expiresAt
  const okRows = (pv?.rows || []).filter((r: any) => r.ok && pick.includes(r.slot))
  const total = okRows.reduce((s: bigint, r: any) => s + BigInt(r.valueWei || 0), 0n)
  const send = async () => {
    const ok = await useUI.getState().ask({
      title: T('rd.mintTitle', { name: d.symbol || d.name || short(d.address) }), okText: T('rd.confirmN', { n: okRows.length }),
      rows: [[T('rd.wallets'), okRows.map((r: any) => `W${r.slot}`).join(', ')], [T('rd.totalFee'), total === 0n ? T('rd.freeGas') : `${fmtBnb(String(total))} BNB + gas`], [T('rd.note'), T('rd.signNote')]],
    })
    if (!ok) return
    setBusy('send'); setErr('')
    try { await api(`/api/radar/${d.address}/submit`, { previewId: pv.previewId, slots: okRows.map((r: any) => r.slot) }); setPv(null) } catch (e: any) { setErr(e.message) }
    setBusy('')
  }
  const price = an.review.needWei === '0' ? T('rd.freeGas') : an.review.needWei ? T('rd.perMint', { v: fmtBnb(an.review.needWei) }) : null
  const site = (an.project?.links || []).find((u) => !/x\.com|twitter/i.test(u))
  return (
    <Card title={T('rd.mint')} right={price ? <span className="text-sm text-up font-medium">{price}</span> : null}>
      {an.mineExhausted ? (
        <div className="text-sm text-t2 leading-6">{T('rd.alreadyMinted', { n: d.nft ? T('rd.alreadyN', { n: d.nft }) : '' })}{an.mine.find((m) => m.reason) ? <span className="text-t3">{T('rd.contractSays', { r: reasonText(an.mine.find((m) => m.reason)?.reason) })}</span> : null}</div>
      ) : !supported ? (
        // 不支持一键铸造：说明原因，并直接给去处（项目官网铸造页；没有官网时去 BscScan 的合约写入页）
        <div className="space-y-3">
          <div className="text-sm text-t2 leading-6">{T('rd.noOneClickWhy', { why: an.recipe ? recipeWhy(an.recipe) : T('rd.recipeTbd') })}</div>
          <div className="flex flex-wrap items-center gap-2">
            {site && <a href={site} target="_blank" rel="noreferrer" className="h-9 px-4 rounded-sm bg-up text-on-accent font-semibold inline-flex items-center gap-1.5 hover:brightness-110">{T('rd.goSite')}<ExternalLink className="ico-sm" /></a>}
            <a href={`https://bscscan.com/address/${d.address}#writeContract`} target="_blank" rel="noreferrer" className={clsx('h-9 px-4 rounded-sm font-medium inline-flex items-center gap-1.5', site ? 'bg-btn text-t1 hover:bg-btn-2' : 'bg-up text-on-accent hover:brightness-110')}>{T('rd.goScan')}<ExternalLink className="ico-sm" /></a>
          </div>
          <div className="text-[11px] text-t4 leading-5">{T('rd.manualRisk')}</div>
        </div>
      ) : !canTrade ? <div className="text-sm text-warn">{T('rd.demoNoMint')}</div> : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <TaskWallets value={wallets} onChange={setWallets} />
            {an.recipe?.qtyWord != null && <NumField w="w-[130px]" prefix={T('rd.qty')} unit={T('rd.unitPcs')} value={qty} onCommit={(v) => setQty(Math.max(1, Math.min(100, Math.floor(v || 1))))} />}
            {!pv && <button onClick={check} disabled={!!busy} className="h-9 px-4 rounded-sm bg-up text-on-accent font-semibold flex items-center gap-1.5 disabled:opacity-60">{busy && <Loader2 className="ico-sm spin" />}{quickOn && an.review.needWei === '0' ? T('rd.oneClickMint') : T('rd.simMint')}</button>}
          </div>
          {!pv && <div className="text-[11px] text-t4">{quickOn && an.review.needWei === '0' ? T('rd.quickHint') : T('rd.simHint')}</div>}
          {pv && (
            <div className="space-y-2">
              {pv.rows.map((r: any) => (
                <label key={r.slot} className={clsx('flex items-center gap-2 text-sm rounded-sm px-2 py-1.5', r.ok ? 'bg-up/8' : 'bg-down/8')}>
                  <input type="checkbox" disabled={!r.ok} checked={pick.includes(r.slot)} onChange={(e) => setPick(e.target.checked ? [...pick, r.slot] : pick.filter((x) => x !== r.slot))} className="accent-buy" />
                  <WalletTag slot={r.slot} />
                  <span className={clsx('flex-1 text-xs', r.ok ? 'text-up' : 'text-down')}>{r.ok ? `${T('rd.pvOk', { fee: BigInt(r.valueWei || 0) > 0n ? `${fmtBnb(r.valueWei)} BNB` : T('rd.pvFree') })}${r.risks?.length ? T('rd.pvRisk', { r: r.risks.join('; ') }) : ''}${r.needAppConfirm ? T('rd.pvApp') : ''}` : reasonText(r.reason)}</span>
                </label>
              ))}
              <div className="flex flex-wrap items-center gap-3">
                {expired ? <button onClick={check} className="h-9 px-4 rounded-sm bg-btn-2 text-sm font-medium">{T('rd.pvExpired')}</button>
                  : <button onClick={send} disabled={!okRows.length || !!busy} className="h-9 px-5 rounded-sm bg-up text-on-accent font-semibold disabled:opacity-50 flex items-center gap-1.5">{busy === 'send' && <Loader2 className="ico-sm spin" />}{T('rd.confirm')}{okRows.length ? T('rd.nTx', { n: okRows.length }) : ''}</button>}
                {!expired && <span className="text-xs text-t4 tabular-nums min-w-[9rem]">{T('rd.pvValid', { n: Math.max(0, Math.ceil((pv.expiresAt - now) / 1000)) })}</span>}
                <button onClick={() => setPv(null)} className="text-xs text-t4 hover:text-t1">{T('rd.cancel')}</button>
              </div>
            </div>
          )}
        </>
      )}
      {err && <div className="text-sm text-down">{err}</div>}
    </Card>
  )
}

/** 我的持仓：当前持有（和铸造历史分开：转走后历史还在）。转出地址填一次就保存（NftDest），之后点「转出」一次确认即可 */
function Holdings({ d, canTrade }: { d: RadarDetail; canTrade: boolean }) {
  const [h, setH] = useState<RadarHoldings | null>(null)
  const dest = useApp((s) => s.settings?.nftSendTo)
  const [busy, setBusy] = useState('')
  const load = () => api<RadarHoldings>(`/api/radar/${d.address}/holdings`).then(setH).catch(() => {})
  useEffect(() => { if (canTrade) load() }, [d.address, d.mints.length])   // eslint-disable-line react-hooks/exhaustive-deps
  const held = (h?.rows || []).filter((r) => (r.balance || 0) > 0 || Number(r.amount || 0) > 0)
  const send = async (items: { slot: number; id: string }[], key: string) => {
    setBusy(key)
    try { if (await quickTransfer({ address: d.address, title: d.symbol || d.name || short(d.address), items })) setTimeout(load, 9000) } finally { setBusy('') }
  }
  if (!canTrade) return null
  const nft = h && h.std !== '20'
  const all = held.flatMap((r) => r.ids.map((x) => ({ slot: r.slot, id: x.id })))
  return (
    <Card title={T('rd.holdings')} right={<button className="text-xs text-t3 hover:text-t1" onClick={load}>{T('rd.refresh')}</button>}>
      {!h ? <div className="text-xs text-t4">{T('rd.loading')}</div> : !held.length ? <div className="text-xs text-t4">{d.mintTx ? T('rd.noHoldMinted') : T('rd.noHold')}</div> : held.map((r) => (
        <div key={r.slot} className="space-y-1">
          <div className="flex items-center gap-2 text-sm"><WalletTag slot={r.slot} /><span className="text-t2">{h.std === '20' ? r.amount : T('rd.nPcs', { n: r.balance })}</span></div>
          {r.ids.length > 0 && <div className="flex flex-wrap items-center gap-1">{r.ids.map((x) => (
            <span key={x.id} className="chip gap-1.5">
              <a href={okxAssetUrl(d.address, x.id)} target="_blank" rel="noreferrer" className="hover:underline" title={T('rd.okxNft')}>#{x.id}</a>
              {NFT_TRANSFER.available && h.std !== '1155' && dest && <button className="text-up hover:underline disabled:opacity-50" disabled={!!busy} onClick={() => send([{ slot: r.slot, id: x.id }], r.slot + ':' + x.id)}>{busy === r.slot + ':' + x.id ? '…' : T('rd.send')}</button>}
            </span>))}
          </div>}
        </div>
      ))}
      {nft && (
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <NftDest />
          {NFT_TRANSFER.available && dest && all.length > 1 && h?.std !== '1155' && <button disabled={!!busy} onClick={() => send(all, 'all')} className="h-7 px-3 rounded-sm bg-up/14 text-up text-xs font-medium hover:bg-up/22 disabled:opacity-50">{busy === 'all' ? T('rd.processing') : T('rd.sendAll', { n: all.length })}</button>}
          <a href={okxCollectionUrl(d.address)} target="_blank" rel="noreferrer" className="text-xs text-link hover:underline">{T('rd.okxColl')}</a>
        </div>
      )}
      <div className="text-[11px] text-t4 leading-5">{NFT_TRANSFER.available ? T('rd.sellNote') : NFT_TRANSFER.note}</div>
    </Card>
  )
}

/** 铸造记录（含失败与转出）：和「我的持仓」分开，转走后历史仍在 */
function History({ d }: { d: RadarDetail }) {
  if (!d.mints.length) return null
  return (
    <Card title={T('rd.history', { n: d.mintTx || 0, nft: d.nft ? T('rd.historyNft', { n: d.nft }) : '' })}>
      <div className="space-y-1">
        {d.mints.map((m: RadarMint) => {
          const [label, color] = mintStatus(m.status)
          return (
            <div key={m.id} className="flex items-center gap-2 text-sm min-w-0">
              <WalletTag slot={m.slot} />
              <span className={clsx('text-xs flex-none', color)}>{m.kind === 'transfer' ? (m.status === 'transferred' ? T('rd.st.transferred') : label) : label}</span>
              <span className="text-xs text-t2 flex-none">{m.kind === 'transfer' ? `#${m.tokenId} → ${short(m.to)}` : m.got?.length ? m.got.map((g) => (g.std === '721' ? `#${g.id}` : `${g.amount}`)).join(', ') : '—'}</span>
              {m.reason && <span className="text-xs text-t3 truncate" title={m.reason}>{reasonText(m.reason)}</span>}
              <span className="flex-1" />
              {m.kind !== 'transfer' && (m.got || []).filter((g) => (g.std === '721' || g.std === '1155') && g.id).slice(0, 3).map((g) => (
                <a key={g.id} className="text-xs text-link hover:underline flex-none" href={okxAssetUrl(d.address, String(g.id))} target="_blank" rel="noreferrer" title={T('rd.okxNft')}>OKX #{g.id}</a>
              ))}
              {m.tx && <a className="text-xs text-t3 hover:text-t1 flex-none" href={`https://bscscan.com/tx/${m.tx}`} target="_blank" rel="noreferrer" title={T('rd.txLink')}>{T('rd.onchain')}</a>}
              <span className="text-xs text-t4 flex-none">{ago(m.ts)}</span>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

function Tweets({ d }: { d: RadarDetail }) {
  const s = d.analysis?.social
  const [orig, setOrig] = useState(false)
  if (!s) return null
  const any = !isEn() && s.top.some((t) => t.zh)   // 英文界面直接显示推文原文
  return (
    <Card title={T('rd.talk')} right={<span className="flex items-center gap-3">{any && <button className="text-xs text-t3 hover:text-t1" onClick={() => setOrig(!orig)}>{orig ? T('rd.showTr') : T('rd.showOrig')}</button>}<a href={s.searchUrl} target="_blank" rel="noreferrer" className="text-xs text-link hover:underline">{T('rd.searchX')}</a></span>}>
      <div className="text-sm text-t2 leading-5">
        {s.official && <>{T('rd.official')}<a href={s.official.url} target="_blank" rel="noreferrer" className="text-link hover:underline">@{s.official.handle}</a><span className="text-t4">{T('rd.paren', { s: isEn() ? T(s.official.from === OFF_FROM_ADDR ? 'rd.offFromAddr' : 'rd.offFromMeta') : s.official.from })}</span> · </>}
        {!s.enabled ? T('rd.noX') : s.pending ? T('rd.querying') : s.error && !s.count ? T('rd.xErr') : s.count
          ? `${s.byAddr != null ? T('rd.byAddr', { a: s.byAddr, b: s.byName }) : T('rd.total', { n: s.count })}${s.lists ? T('rd.lists', { n: s.lists }) : ''}${s.last24h != null ? T('rd.last24', { n: s.last24h }) : ''}${s.error ? T('rd.stale') : ''}`
          : T('rd.noTweets')}
      </div>
      {!s.official && s.enabled && !s.pending && <div className="text-[11px] text-t4 leading-5">{T('rd.noOfficial')}</div>}
      {s.top.map((t) => (
        <a key={t.url || t.text} href={t.url || s.searchUrl} target="_blank" rel="noreferrer" className="block rounded-sm bg-bg/60 border border-line p-2.5 hover:border-line-3">
          <div className="text-xs text-t3 mb-1">{t.list ? <span className="text-t4">{T('rd.listTag')}</span> : t.how === 'addr' ? <span className="text-t2">{T('rd.hasAddr')}</span> : null}@{t.user}{t.followers != null ? T('rd.fans', { n: t.followers >= 1000 ? (t.followers / 1000).toFixed(1) + 'K' : t.followers }) : ''}{t.at ? ` · ${ago(t.at)}` : ''}{t.likes ? T('rd.likes', { n: t.likes }) : ''}</div>
          <div className="text-sm text-t2 leading-5 line-clamp-4">{!orig && any && t.zh ? t.zh : t.text}</div>
        </a>
      ))}
      {any && !orig && <div className="text-[11px] text-t4">{T('rd.mtNote')}</div>}
    </Card>
  )
}

function Detail({ address, canTrade, onPick, onBack }: { address: string; canTrade: boolean; onPick: (a: string) => void; onBack?: () => void }) {
  const t = useT()
  const [d, setD] = useState<RadarDetail | null>(null)
  const [err, setErr] = useState('')
  const [orig, setOrig] = useState(false)
  const [rules, setRules] = useState(false)
  const [link, setLink] = useState('')
  const [ref, w] = useWidth<HTMLDivElement>()
  const tick = useApp((s) => s.radarTick)
  const load = () => api<RadarDetail>(`/api/radar/${address}`).then((x) => { setD(x); setErr('') }).catch((e) => setErr(e.message))
  useEffect(() => { setD(null); load(); const t = setInterval(load, 15_000); return () => clearInterval(t) }, [address])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tick && tick.address === address) load() }, [tick])   // eslint-disable-line react-hooks/exhaustive-deps
  const wide = !!w && w >= 1000
  if (err && !d) return <div ref={ref} className="p-8 text-center text-t3">{err}</div>
  if (!d) return <div ref={ref} className="h-full grid place-items-center"><Loader2 className="ico spin text-t3" /></div>
  const an = d.analysis, r = an?.review, pj = an?.project
  const site = (pj?.links || []).find((u) => !/x\.com|twitter\.com|t\.me|discord/i.test(u))
  const xLink = an?.social?.official?.url || (pj?.links || []).find((u) => /x\.com|twitter\.com/i.test(u))
  const parts = d.priority?.parts || []
  const en = isEn(), explain = en ? an?.reviewEn?.explain || r?.explain : r?.explain, cons = (en ? an?.reviewEn?.cons : null) || r?.cons || []
  const desc = en ? pj?.description : pj?.descriptionZh || pj?.description
  const tagline = desc || explain || ''
  const addLink = async () => { if (!/^https:\/\//i.test(link.trim())) return; try { await api(`/api/radar/${d.address}/links`, { links: [link.trim()] }); setLink(''); useApp.getState().toast({ kind: 'ok', title: t('rd.added') }) } catch (e: any) { useApp.getState().toast({ kind: 'error', title: t('rd.addFailed'), body: e.message }) } }
  const fact = (k: string) => r?.facts.find(([x]) => x === k)?.[1] || null   // 旧分析没有 vals 时退回中文事实表
  const vals = r?.vals
  const info: [string, string][] = an ? ([
    ['price', r!.needWei === '0' || (r!.needWei == null && an.cls.valueWei === '0') ? t('rd.freeGas') : r!.needWei ? t('rd.perMint', { v: fmtBnb(r!.needWei) }) : t('rd.unknown')],
    ['perCall', vals ? (vals.perCall ? `${vals.perCall.n} ${vals.perCall.unit === 'nft' ? t('rd.nftUnit') : vals.perCall.unit}`.trim() : null) : fact('每次得到')],   // i18n-ignore（旧数据的中文事实名）
    ['supply', vals ? (vals.supply ? supplyText(vals.supply) : null) : fact('供应')],   // i18n-ignore
    ['perWallet', vals ? (vals.perWallet != null ? n(vals.perWallet) : null) : fact('每钱包上限')],   // i18n-ignore
    ['gate', ['verified', 'likely', 'open'].includes(an.aiOnly.state) ? t('rd.gate.' + an.aiOnly.state) : t('rd.unknown')],
    ['heat', d.stats ? t('rd.heatV', { n: d.stats.aiCallers }) : null],
    ['creator', an.creator ? `${an.creator.name || short(an.creator.address)}${an.creator.others?.length ? t('rd.creatorOthers', { n: an.creator.others.length }) : ''}` : null],
    ['source', an.src.verified ? t('rd.src.yes') : an.src.verified === false ? t('rd.src.no') : t('rd.src.unknown')],
  ] as ([string, string | null])[]).filter((x): x is [string, string] => !!x[1]) : []

  const header = (
    <div className="flex gap-4">
      <Thumb src={pj?.image} seed={d.address} size={84} />
      <div className="flex-1 min-w-0 space-y-2">
        <div className="flex items-start gap-2 flex-wrap">
          <span className="text-xl font-semibold break-words">{d.symbol || pj?.name || d.name || t('rd.untitled')}</span>
          {pj?.name && pj.name !== d.symbol && <span className="text-sm text-t3">{pj.name}</span>}
          <span className="flex-1" />
          <Score p={d.priority} big />
        </div>
        {an ? <div className="text-sm text-t2 leading-6 line-clamp-2">{tagline}</div> : null}
        <div className="text-xs text-t3 flex flex-wrap items-center gap-x-3 gap-y-1">
          {d.rec && <span className="text-t2">{t('rd.inRec')}{d.recAt ? t('rd.inRecAgo', { t: age(d.recAt) }) : ''}</span>}
          {d.mintTx ? <span className="text-t2">{t('rd.mintedHere', { n: d.nft || d.mintTx })}</span> : null}
          {d.historyOnly && <span>{t('rd.histOnly')}</span>}
          {d.blocked && <span>{t('rd.hidden')}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {site && <a href={site} target="_blank" rel="noreferrer" className="chip hover:border-line-3"><G n="Website16pxRegular" className="ico-sm" />{t('rd.site')}</a>}
          {xLink && <a href={xLink} target="_blank" rel="noreferrer" className="chip hover:border-line-3"><XLogo className="w-3 h-3" />X</a>}
          <a href={`https://bscscan.com/token/${d.address}`} target="_blank" rel="noreferrer" className="chip hover:border-line-3">BscScan</a>
          <span className="chip gap-1.5 font-mono">{short(d.address)}<CopyBtn text={d.address} /></span>
        </div>
      </div>
    </div>
  )

  const infoCard = an && (
    <Card title={t('radar.info.title')}>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-sm">{info.map(([k, v]) => { const e = r?.evidence?.[k]; return (
        <Fragment key={k}><dt className="text-t3">{t('radar.info.' + k)}</dt><dd className="text-t1 break-words">{v}</dd>
          <dd className="text-right whitespace-nowrap">{e && <Tip text={t(e.k)}><span className={clsx('text-xs', EV_COLOR[e.level] || 'text-t4')}>{t('ev.' + e.level)}</span></Tip>}</dd></Fragment>) })}</dl>
      {!!r?.evidence && <div className="mt-2 text-[11px] text-t4 leading-4">{t('ev.legend')}</div>}
    </Card>
  )
  const riskCard = an && cons.length > 0 && (
    <Card title={t('rd.risks')}>{cons.map((c) => <div key={c} className="text-sm text-t2 flex gap-2"><AlertTriangle className="w-3.5 h-3.5 text-warn flex-none mt-0.5" /><span>{c}</span></div>)}</Card>
  )
  const main = an && (
    <>
      <Mint d={d} canTrade={canTrade} />
      {!wide && infoCard}
      <Card title={t('rd.about')}>
        <p className="text-sm text-t1 leading-6">{tagline}</p>
        {desc && explain && <p className="text-xs text-t3 leading-5">{t('rd.chainData', { s: explain })}</p>}
        {(en ? an.notice : an.noticeZh || an.notice) && (
          <div>
            <button onClick={() => setRules(!rules)} className="text-xs text-t3 hover:text-t1 flex items-center gap-1">{t('rd.rules')}<ChevronRight className={clsx('ico-sm transition-transform', rules ? '-rotate-90' : 'rotate-90')} /></button>
            {rules && <div className="mt-1.5 rounded-sm bg-bg/60 border border-line p-2.5 space-y-1">
              {!en && an.noticeZh && an.notice && <button className="text-xs text-t4 hover:text-t1" onClick={() => setOrig(!orig)}>{orig ? t('rd.showTr') : t('rd.showOrig')}</button>}
              <div className="text-sm text-t2 leading-6 whitespace-pre-line">{orig || en ? an.notice : an.noticeZh || an.notice}</div>
            </div>}
          </div>
        )}
        {!site && !xLink && (
          <div className="flex gap-2">
            <input value={link} onChange={(e) => setLink(e.target.value)} placeholder={t('rd.linkPh')} className="input-box h-8 px-2 text-sm flex-1" />
            <button onClick={addLink} className="h-8 px-3 rounded-sm bg-btn hover:bg-btn-2 text-sm">{t('rd.add')}</button>
          </div>
        )}
      </Card>
      <Card title={t('rd.use')}>
        {an.utility?.list?.length ? an.utility.list.map((u) => (
          <div key={u.tag} className="text-sm flex gap-2"><span className="text-t1 font-medium flex-none w-24">{en && u.id ? t('ut.' + u.id) : u.tag}</span><span className="text-t3">{u.src === 'contract' ? (en && u.id ? t('ut.' + u.id + '.why') : u.why) : t('rd.utilText')}</span></div>
        )) : <div className="text-sm text-t2">{t('rd.noUtil')}</div>}
      </Card>
      {!wide && <Holdings d={d} canTrade={canTrade} />}
      <Tweets d={d} />
      {!wide && riskCard}
      <History d={d} />
      {(d.family.length > 1 || d.creatorOthers.length > 0) && (
        <More title={d.family.length > 1 ? t('rd.family', { n: d.family.length - 1 }) : t('rd.creatorProjects', { n: d.creatorOthers.length })}>
          <div className="rounded-sm border border-line divide-y divide-line">
            {(d.family.length > 1 ? d.family.filter((m) => m.address !== d.address) : d.creatorOthers).map((m) => (
              <button key={m.address} onClick={() => onPick(m.address)} className="w-full flex items-center gap-2 px-3 h-9 text-sm text-left hover:bg-hover">
                <span className="font-medium truncate">{m.symbol || m.name || short(m.address)}</span><span className="text-xs text-t4 font-mono">{short(m.address)}</span><span className="flex-1" /><ChevronRight className="ico-sm text-t4" />
              </button>
            ))}
          </div>
        </More>
      )}
      <More title={t('rd.basis')}>
        {parts.length ? <div className="tbl-x"><table className="tbl"><thead><tr><th>{t('rd.pts')}</th><th className="l">{t('rd.reason')}</th></tr></thead><tbody>
          {parts.map((p) => <tr key={p.why}><td className="tabular-nums text-t1">{p.pts > 0 ? '+' : ''}{p.pts}</td><td className="l text-t2">{partText(p)}</td></tr>)}
        </tbody></table></div> : <div className="text-sm text-t4">{t('rd.pending')}</div>}
        <div className="text-[11px] text-t4 mt-2">{t('rd.basisNote')}</div>
      </More>
      <More title={t('rd.tech')}>
        <div className="text-xs text-t4 font-mono leading-5">
          <div>{t('rd.fn', { fn: an.fn || an.selector, s: an.aiOnly.state, why: an.aiOnly.why ? t('rd.paren', { s: en && an.aiOnly.k ? t(an.aiOnly.k, an.aiOnly.p) : an.aiOnly.why }) : '' })}</div>
          <div>{t('rd.oneClickTech', { s: an.recipe ? (an.recipe.supported ? t('rd.supportedN', { n: an.recipe.samples }) : t('rd.unsupported', { why: recipeWhy(an.recipe) })) : t('rd.fewSamples') })}</div>
          <div>{t('rd.contract', { a: short(d.address), n: an.profile.size })}{an.profile.proxy ? ` · ${en && proxyId(an.profile.proxy.kind) ? t('px.' + proxyId(an.profile.proxy.kind)) : an.profile.proxy.kind}` : ''}{an.src.deployer ? t('rd.deployer', { a: an.src.deployer }) : ''}</div>
          {an.mine.map((m) => <div key={m.slot}>{t('rd.walletPv', { n: m.slot, s: m.ok ? t('rd.pass', { v: fmtBnb(m.valueWei) }) : reasonText(m.reason) })}</div>)}
          <div>{t('rd.updated', { t: age(an.at) })}</div>
        </div>
      </More>
    </>
  )

  return (
    <div ref={ref} className="h-full scroll-y" style={{ scrollbarGutter: 'stable' }}>   {/* 预留滚动条位置：内容变高出现滚动条时不左右跳 */}
      <div className="p-5 space-y-4">
        {onBack && <button onClick={onBack} className="text-sm text-t3 hover:text-t1 flex items-center gap-1"><ChevronRight className="ico-sm rotate-180" />{t('rd.back')}</button>}
        {header}
        {!an ? <div className="rounded-md border border-line p-6 text-center text-t3 flex items-center justify-center gap-2"><Loader2 className="ico-sm spin" />{d.queuePos ? t('rd.queuedN', { n: d.queuePos }) : ''}{t('rd.reading')}</div>
          : wide ? <div className="grid grid-cols-[minmax(0,1fr)_280px] gap-4 items-start"><div className="space-y-4 min-w-0">{main}</div><div className="space-y-4">{infoCard}<Holdings d={d} canTrade={canTrade} />{riskCard}</div></div>
          : <div className="space-y-4">{main}</div>}
      </div>
    </div>
  )
}

function SettingsModal({ v, onClose }: { v: RadarView; onClose: () => void }) {
  const [s, setS] = useState<RadarView['settings']>({ ...v.settings })
  const [adv, setAdv] = useState(false)
  const hidden = v.hidden || []
  const save = async () => { try { await api('/api/radar/settings', s); onClose() } catch (e: any) { useApp.getState().toast({ kind: 'error', title: T('rd.saveFailed'), body: e.message }) } }
  const restore = (a: string) => api(`/api/radar/${a}`, { block: false }).catch((e) => useApp.getState().toast({ kind: 'error', title: T('rd.restoreFailed'), body: e.message }))
  const social = v.status.social
  const alert = usePrefs((x) => x.radarAlert), alertSound = usePrefs((x) => x.radarAlertSound), alertSecs = usePrefs((x) => x.radarAlertSecs ?? 10), setPrefs = usePrefs((x) => x.set)
  const soon = usePrefs((x) => x.radarSoon)
  const t = useT()
  return (
    <Modal open onClose={onClose} title={t('rd.settings')} width={520}>
      <div className="space-y-6">
        <Section title={t('rd.secScan')}>
          <Rows>
            <Toggle on={!!s.scan} onChange={(v) => setS({ ...s, scan: v })} label={t('rd.scan')} hint={t('rd.scanHint')} />
            <Toggle on={alert} onChange={(v) => setPrefs({ radarAlert: v })} label={t('rd.recAlert')} hint={t('rd.recAlertHint')} />
            {alert && <Toggle on={alertSound} onChange={(v) => { setPrefs({ radarAlertSound: v }); if (v) playSound('Bell') }} label={t('rd.alertSound')} hint={t('rd.alertSoundHint')} />}
            {/* 「即将打满」的提醒放在这里，和总开关一起（以前在即将打满页签里单独一个开关，和其他页签不一致） */}
            {alert && <Toggle on={!!soon.alert} onChange={(v) => setPrefs({ radarSoon: { ...soon, alert: v } })} label={t('rd.soonAlert')} hint={t('rd.soonAlertHint')} />}
            <SetRow label={t('radar.alertSecs')} hint={t('radar.alertSecsHint')}>
              <div className="seg h-8">{[5, 10, 20, 60, 0].map((n) => <button key={n} className="px-2.5" data-on={alertSecs === n} onClick={() => setPrefs({ radarAlertSecs: n })}>{n ? t('radar.secs', { n }) : t('radar.never')}</button>)}</div>
            </SetRow>
          </Rows>
        </Section>
        <Section title={t('rd.secMint')}>
          <Rows>
            <SetRow label={t('rd.maxFee')} hint={t('rd.maxFeeHint')}>
              <NumBox value={s.maxValueBnb} unit="BNB" zeroLabel={t('rd.freeOnly')} w="w-[150px]" onSave={(x) => setS({ ...s, maxValueBnb: x })} />
            </SetRow>
            <Toggle on={!!s.quickMint} onChange={(v) => setS({ ...s, quickMint: v })} label={t('rd.quick')}
              hint={<>{t('rd.quickHint1')}<b className="text-t2 font-medium">{t('rd.quickHint2')}</b>{t('rd.quickHint3')}</>} />
            {s.quickMint && (
              <SetRow label={t('rd.quickMax')} hint={t('rd.quickMaxHint')}>
                <NumBox value={s.quickMintMax} unit={t('rd.times')} min={1} max={200} w="w-[120px]" onSave={(x) => setS({ ...s, quickMintMax: Math.round(x) })} />
              </SetRow>
            )}
            <Toggle on={!!s.autoMint} onChange={async (v) => { if (v && !(await useUI.getState().ask({ title: t('rd.autoTitle'), okText: t('rd.autoOk'), rows: [[t('rd.autoWhen'), t('rd.autoWhenV')], [t('rd.autoLimits'), t('rd.autoLimitsV')], [t('rd.autoWallet'), t('rd.autoWalletV')], [t('rd.note'), t('rd.autoNoteV')]] }))) return; setS({ ...s, autoMint: v }) }} label={t('rd.auto')}
              hint={<>{t('rd.autoHint1')}<b className="text-t2 font-medium">{t('rd.autoHintA')}</b>{t('rd.autoHintOr')}<b className="text-t2 font-medium">{t('rd.autoHintB')}</b>{t('rd.autoHint2')}</>} />
            {s.autoMint && (
              <SetRow label={t('rd.autoMax')} hint={t('rd.autoMaxHint')}>
                <NumBox value={s.autoMintMax} unit={t('rd.times')} min={1} max={100} w="w-[120px]" onSave={(x) => setS({ ...s, autoMintMax: Math.round(x) })} />
              </SetRow>
            )}
          </Rows>
        </Section>
        <div>
          <button onClick={() => setAdv(!adv)} className="text-sm text-t2 hover:text-t1 flex items-center gap-1">{t('rd.adv')}<ChevronRight className={clsx('ico-sm transition-transform', adv ? '-rotate-90' : 'rotate-90')} /></button>
          {adv && (
            <Section hint={t('rd.advHint')} className="mt-2">
              <Rows>
                <SetRow label={t('rd.minAi')}><NumBox value={s.minAi} unit={t('rd.unitWallets')} w="w-[120px]" onSave={(x) => setS({ ...s, minAi: x })} /></SetRow>
                <SetRow label={t('rd.aiRatio')}><NumBox value={s.aiRatioPct} unit="%" w="w-[120px]" onSave={(x) => setS({ ...s, aiRatioPct: x })} /></SetRow>
                <SetRow label={t('rd.coolMin')}><NumBox value={s.coolMin} unit={t('rd.minutes')} w="w-[120px]" onSave={(x) => setS({ ...s, coolMin: x })} /></SetRow>
              </Rows>
            </Section>
          )}
        </div>
        <Section title={t('rd.secData')}>
          <Rows>
            <SetRow label={t('rd.chainScan')} hint={t('rd.chainScanHint')} />
            <SetRow label={t('rd.xTalk')} hint={`${t('rd.xApi')}${social?.enabled ? `${t('rd.xUsage', { a: social.today, b: social.max ?? '—' })}${social.capped ? t('rd.xCapped') : ''}${t('rd.xTotal', { n: social.total })}${social.failures ? t('rd.xFails', { n: social.failures }) : ''}` : t('rd.xOff')}${t('rd.xQuota')}`} />
            {social?.enabled && (
              <SetRow label={t('rd.xMax')} hint={t('rd.xMaxHint')}>
                <NumBox value={s.xDailyMax ?? 300} unit={t('rd.times')} min={20} max={5000} w="w-[120px]" onSave={(x) => setS({ ...s, xDailyMax: Math.round(x) })} />
              </SetRow>
            )}
            <SetRow label={t('rd.mintSrc')} hint={t('rd.mintSrcHint')} />
          </Rows>
        </Section>
        {hidden.length > 0 && (
          <Section title={t('rd.hiddenN', { n: hidden.length })} hint={t('rd.hiddenHint')}>
            <div className="max-h-[140px] overflow-y-auto">
              <Rows>{hidden.map((h) => (
                <SetRow key={h.address} label={h.title} hint={<span className="font-mono">{short(h.address)}</span>}><RowBtn onClick={() => restore(h.address)}>{t('rd.restore')}</RowBtn></SetRow>
              ))}</Rows>
            </div>
          </Section>
        )}
        <div className="flex gap-2"><button onClick={onClose} className="flex-1 h-9 rounded-sm bg-btn hover:bg-btn-2 text-t2">{t('rd.cancel')}</button><button onClick={save} className="flex-1 h-9 rounded-sm bg-up text-on-accent font-semibold">{t('rd.save')}</button></div>
      </div>
    </Modal>
  )
}

/** 「即将打满」的条件：已铸比例门槛、上线时间、仅免费 / 仅一键铸造、达到条件时提醒。一改就存（Gateway 按它判断提醒） */
function SoonBar({ v, onChange }: { v: RadarSoon; onChange: (p: Partial<RadarSoon>) => void }) {
  const chip = (on: boolean, label: string, click: () => void) => (
    <button onClick={click} className={clsx('h-6 px-2 rounded-xs text-xs border', on ? 'border-up/60 text-up bg-up/10' : 'border-line-2 text-t3 hover:text-t2')}>{label}</button>
  )
  return (
    <div className="flex-none px-3 py-2.5 space-y-2 border-b border-line text-xs">
      <div className="flex items-center gap-2">
        <span className="w-14 flex-none text-t3">{T('rd.soon.pct')}</span>
        <div className="seg h-6 flex-1">{RADAR_SOON_PCTS.map((p) => <button key={p} className="flex-1" data-on={v.minPct === p} onClick={() => onChange({ minPct: p })}>≥ {p}%</button>)}</div>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-14 flex-none text-t3">{T('rd.soon.age')}</span>
        <div className="seg h-6 flex-1">{RADAR_SOON_AGES.map(([h]) => <button key={h} className="flex-1" data-on={v.maxAgeH === h} onClick={() => onChange({ maxAgeH: h })}>{h ? T('rd.soon.days', { n: h / 24 }) : T('rd.soon.any')}</button>)}</div>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-14 flex-none text-t3">{T('rd.soon.other')}</span>
        {chip(v.free, T('rd.soon.free'), () => onChange({ free: !v.free }))}
        {chip(v.oneClick, T('rd.soon.oneClick'), () => onChange({ oneClick: !v.oneClick }))}
      </div>
    </div>
  )
}

/** 雷达筛选（和战壕列的筛选同一种面板）：决定「最新 / 最高分」显示哪些，也决定哪些新推荐会弹出提醒 */
function FilterPop({ anchor, toggle, onClose }: { anchor: HTMLElement | null; toggle?: React.RefObject<HTMLElement | null>; onClose: () => void }) {
  const saved = usePrefs((s) => s.radarFilter)
  const setPrefs = usePrefs((s) => s.set)
  const [f, setF] = useState<RadarFilter>(() => ({ ...emptyRadarFilter(), ...saved }))
  const recScores = (useApp((s) => s.radar?.items) || []).filter((x) => x.rec && !x.blocked).map((x) => x.priority?.score ?? 0)
  const scoreTop = recScores.length ? Math.max(...recScores) : null, scoreLo = recScores.length ? Math.min(...recScores) : null
  const put = (v: Partial<RadarFilter>) => setF((x) => ({ ...x, ...v }))
  const ref = useRef<HTMLDivElement>(null)
  const r = anchor?.getBoundingClientRect()
  const W = Math.min(400, innerWidth - 24)
  const left = Math.max(12, Math.min(r?.left ?? 12, innerWidth - W - 12)), top = (r?.bottom ?? 100) + 4
  useOutsideClose(ref, onClose, toggle)
  const s2n = (v: string) => (v === '' ? 0 : Number(v) || 0)
  const n2s = (v: number) => (v ? String(v) : '')
  // 普通函数、用 {text(...)} 调用：渲染函数里定义组件会让输入框每次重建、丢焦点
  const text = (label: string, field: 'keywords' | 'exclude', ph: string) => (
    <label key={field} className="flex flex-col gap-1.5">
      <span className="text-sm text-t2">{label}</span>
      <input className="input-box h-8 px-2.5 text-sm" value={f[field]} placeholder={ph} onChange={(e) => put({ [field]: e.target.value })} />
    </label>
  )
  const apply = () => { setPrefs({ radarFilter: f }); onClose() }
  return createPortal(
    <div ref={ref} style={{ left, top, width: W, maxHeight: innerHeight - top - 16 }} className="pop fixed z-[90] flex flex-col">
      <div className="px-4 pt-4 flex items-center justify-between">
        <span className="text-lg font-semibold">{T('rd.filter')}</span>
        <button className="icon-btn w-7 h-7" onClick={onClose}><X className="ico-md" /></button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <NumField label={T('rd.f.age')} unit={T('rd.hours')} zero={T('rd.any')} value={s2n(f.maxAgeH)} onCommit={(v) => put({ maxAgeH: n2s(v) })} />
          <NumField label={T('rd.f.score')} unit={T('rd.pt')} zero={T('rd.any')} value={s2n(f.minScore)} onCommit={(v) => put({ minScore: n2s(Math.min(100, v)) })} />
          <NumField label={T('rd.f.ai')} unit={T('rd.unitWallets')} zero={T('rd.any')} value={s2n(f.minAi)} onCommit={(v) => put({ minAi: n2s(Math.floor(v)) })} />
          <NumField label={T('rd.f.minPct')} unit="%" zero={T('rd.any')} value={s2n(f.minPct)} onCommit={(v) => put({ minPct: n2s(Math.min(100, v)) })} />
          <NumField label={T('rd.f.maxPct')} unit="%" zero={T('rd.any')} value={s2n(f.maxPct)} onCommit={(v) => put({ maxPct: n2s(Math.min(100, v)) })} />
        </div>
        <div className="text-[11px] text-t4 leading-5 -mt-2">{T('rd.f.ageNote')}{scoreTop != null ? T('rd.f.scoreRange', { lo: scoreLo, hi: scoreTop }) : ''}</div>
        <div className="space-y-1.5">
          <span className="text-sm text-t2">{T('rd.f.fee')}</span>
          <div className="flex items-center gap-2">
            <div className="seg h-8">
              <button className="px-3" data-on={f.price === 'any'} onClick={() => put({ price: 'any' })}>{T('rd.any')}</button>
              <button className="px-3" data-on={f.price === 'free'} onClick={() => put({ price: 'free' })}>{T('rd.soon.free')}</button>
              <button className="px-3" data-on={f.price === 'max'} onClick={() => put({ price: 'max' })}>{T('rd.f.cap')}</button>
            </div>
            {f.price === 'max' && <NumField w="w-[130px]" unit="BNB" zero={T('rd.any')} value={s2n(f.maxBnb)} onCommit={(v) => put({ maxBnb: n2s(v) })} />}
          </div>
        </div>
        <button onClick={() => put({ oneClick: !f.oneClick })} className={clsx('h-8 px-2.5 rounded-sm border text-sm text-left w-full', f.oneClick ? 'border-up/60 text-up bg-up/10' : 'border-line-2 text-t3 hover:text-t2')}>{T('rd.f.oneClick')}</button>
        <div className="grid grid-cols-2 gap-3">
          {text(T('rd.f.kw'), 'keywords', T('rd.f.kwPh'))}
          {text(T('rd.f.ex'), 'exclude', T('rd.f.kwPh'))}
        </div>
        <div className="text-[11px] text-t4 leading-5">{T('rd.f.note')}</div>
      </div>
      <div className="px-4 py-3 border-t border-line flex gap-2">
        <button className="flex-1 h-9 rounded-sm bg-btn hover:bg-btn-2 text-t1 font-medium" onClick={() => setF(emptyRadarFilter())} title={T('rd.f.clearTip')}>{T('rd.f.clear')}</button>
        <button className="flex-1 h-9 rounded-sm bg-btn hover:bg-btn-2 text-t1 font-medium" onClick={() => setF(recommendedRadarFilter())} title={T('rd.f.recTip')}>{T('rd.f.rec')}</button>
        <button className="flex-1 h-9 rounded-sm bg-solid text-on-solid font-semibold" onClick={apply}>{T('rd.f.apply')}</button>
      </div>
    </div>,
    document.body,
  )
}

export function RadarPage() {
  useT()   // 切换语言时整页重绘（子组件用 T() 取文案）
  const radar = useApp((s) => s.radar)
  const alertOn = usePrefs((s) => s.radarAlert)
  const recSeenAt = usePrefs((s) => s.radarRecSeenAt)
  const rf = usePrefs((s) => s.radarFilter)
  const soonCfg = usePrefs((s) => s.radarSoon)
  const setPrefs = usePrefs((s) => s.set)
  const [params, setParams] = useSearchParams()
  const [open, setOpen] = useState(false)
  const [fOpen, setFOpen] = useState(false)
  const fBtn = useRef<HTMLButtonElement>(null)
  const [tab, setTab] = useState<Tab>(() => (demoParam('tab') as Tab) || 'new')   // 官网嵌入的展示画面可指定页签
  const [sel, setSel] = useState<string | null>(null)
  // 「新」标记：以进入「最新」时的已读时间为准（停留期间不会突然消失）；进入后把已读时间推到现在
  const [seenSnap, setSeenSnap] = useState(recSeenAt)
  const [ref, w] = useWidth<HTMLDivElement>()
  useEffect(() => {
    setPrefs({ radarSeenAt: Date.now() })
    if (!useApp.getState().radar) api<RadarView>('/api/radar').then((d) => useApp.setState({ radar: d })).catch(() => {})
  }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'new') { setSeenSnap(usePrefs.getState().radarRecSeenAt); setPrefs({ radarRecSeenAt: Date.now() }) } }, [tab])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'new') setPrefs({ radarRecSeenAt: Date.now() }) }, [radar])   // eslint-disable-line react-hooks/exhaustive-deps
  // 从右上角提醒「查看」跳过来：/radar?a=<地址>
  useEffect(() => { const a = params.get('a'); if (a) { if (!demoParam('tab')) setTab('new'); setSel(a.toLowerCase()); if (!DEMO) setParams({}, { replace: true }) } }, [params])   // eslint-disable-line react-hooks/exhaustive-deps

  const all = radar?.items || []
  const lists = useMemo(() => {
    const recs = all.filter((x) => x.rec && !x.blocked)
    const shown = recs.filter((x) => matchRadar(x, rf))
    const byScore = (a: RadarItem, b: RadarItem) => (b.priority?.score ?? -1) - (a.priority?.score ?? -1) || b.lastAiAt - a.lastAiAt
    return {
      latest: shown.slice().sort((a, b) => b.recAt - a.recAt || byScore(a, b)),
      top: shown.slice().sort(byScore),
      follow: all.filter((x) => x.followed).sort(byScore),
      mine: all.filter((x) => x.mintTx > 0 || x.nft > 0).sort((a, b) => b.firstSeen - a.firstSeen),
      soon: all.filter((x) => matchRadarSoon(x, soonCfg)).sort((a, b) => (b.supply?.pct ?? 0) - (a.supply?.pct ?? 0) || b.aiCallers - a.aiCallers),
      filtered: recs.length - shown.length,
    }
  }, [all, rf, soonCfg])
  const items = tab === 'new' ? lists.latest : tab === 'top' ? lists.top : tab === 'soon' ? lists.soon : tab === 'follow' ? lists.follow : lists.mine
  const unread = lists.latest.filter((x) => x.recAt > recSeenAt).length
  const fN = radarFilterCount(rf)
  const narrow = !!w && w < 900
  const current = sel || (!narrow ? items[0]?.address : null) || null
  if (!radar) return <div className="h-full grid place-items-center text-t3">{T('rd.starting')}</div>
  const s = radar.status
  const act = (it: RadarItem, body: any, okMsg?: string) => api(`/api/radar/${it.address}`, body)
    .then(() => { if (okMsg) useApp.getState().toast({ kind: 'ok', title: okMsg }) })
    .catch((e) => useApp.getState().toast({ kind: 'error', title: T('rd.opFailed'), body: e.message }))
  const groups = tab === 'top' ? [
    { label: T('rd.g.top'), list: items.filter((x) => (x.priority?.score ?? 0) >= 68) },
    { label: T('rd.g.watch'), list: items.filter((x) => (x.priority?.score ?? 0) < 68) },
  ] : [{ label: '', list: items }]
  const filterable = tab === 'new' || tab === 'top'
  return (
    <div ref={ref} className="h-full flex flex-col">
      <div className="h-10 flex-none flex items-center gap-3 px-4 text-xs border-b border-line text-t3">
        <span className="text-md font-semibold text-t1">{T('rd.title')}</span>
        {!s.scanning ? <span className="text-warn">{T('rd.paused')}<button className="underline" onClick={() => api('/api/radar/settings', { scan: true }).catch(() => {})}>{T('rd.resume')}</button></span>
          : s.behind > 20 ? <span className="text-warn">{T('rd.behind')}</span>
          : <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-up animate-pulse" />{T('rd.live')}</span>}
        <span>{T('rd.today')}<span className="text-t2">{s.todayNew}</span>{s.queue > 0 ? T('rd.queue', { n: s.queue }) : ''}</span>
        <span className="flex-1" />
        {radar.settings?.autoMint && <Tip text={T('rd.autoOnTip', { n: radar.settings.autoMintMax })}><button onClick={() => setOpen(true)} className="h-7 px-2 rounded-xs bg-warn/12 text-warn">{T('rd.autoOn')}</button></Tip>}
        <Tip text={alertOn ? T('rd.alertOnTip') : T('rd.alertOffTip')}>
          <span className="h-7 px-1 flex items-center gap-2 text-t2">{T('rd.alertBtn')}<Switch on={alertOn} onChange={(v) => setPrefs({ radarAlert: v })} label={T('rd.alertBtn')} /></span>
        </Tip>
        <button className="h-7 px-2 rounded-xs bg-btn hover:bg-btn-2 text-t2" onClick={() => setOpen(true)}>{T('rd.settingsBtn')}</button>
      </div>
      {!(narrow && current) && <NowLine v={radar} onPick={(a) => { setTab('new'); setSel(a) }} />}
      <div className="flex-1 min-h-0 flex">
        {!(narrow && current) && (
          <div className={clsx('flex flex-col min-h-0 border-r border-line', narrow ? 'flex-1' : 'w-[380px] flex-none')}>
            <div className="h-10 flex-none flex items-center gap-1 px-2 border-b border-line">
              <div className="seg h-7 whitespace-nowrap">
                <button data-on={tab === 'new'} onClick={() => setTab('new')} className="flex items-center gap-1">{T('rd.tab.new')}{unread > 0 && tab !== 'new' ? <span className="h-4 min-w-4 px-1 rounded-xs bg-up text-on-accent text-2xs font-semibold grid place-items-center">{unread}</span> : lists.latest.length ? ` ${lists.latest.length}` : ''}</button>
                <button data-on={tab === 'top'} onClick={() => setTab('top')}>{T('rd.tab.top')}</button>
                <button data-on={tab === 'soon'} onClick={() => setTab('soon')}>{T('rd.tab.soon')}{lists.soon.length ? ` ${lists.soon.length}` : ''}</button>
                <button data-on={tab === 'follow'} onClick={() => setTab('follow')}>{T('rd.tab.follow')}{lists.follow.length ? ` ${lists.follow.length}` : ''}</button>
                <button data-on={tab === 'mine'} onClick={() => setTab('mine')}>{T('rd.tab.mine')}{lists.mine.length ? ` ${lists.mine.length}` : ''}</button>
              </div>
              <span className="flex-1" />
              {filterable && <Tip off={fOpen} text={fN ? T('rd.filterN', { n: fN }) : T('rd.filter')}>
                <button ref={fBtn} onClick={() => setFOpen((o) => !o)} className={clsx('icon-btn w-7 h-7 relative', fN > 0 && '!text-t1')}>
                  <Filter className="ico" />{fN > 0 && <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-buy" />}
                </button>
              </Tip>}
            </div>
            {tab === 'soon' && <SoonBar v={soonCfg} onChange={(p) => setPrefs({ radarSoon: { ...soonCfg, ...p } })} />}
            <div className="flex-1 min-h-0 scroll-y no-sb">
              {groups.map((g) => g.list.length > 0 && (
                <Fragment key={g.label}>
                  {g.label && <div className="h-8 px-3 flex items-center gap-2 text-[11px] text-t4 bg-bg/40 border-b border-line"><span>{g.label}</span><span>{g.list.length}</span></div>}
                  {g.list.map((it) => (
                    <Row key={it.id} it={it} on={it.address === current} isNew={tab === 'new' && it.recAt > seenSnap} when={tab === 'new'} onSelect={() => setSel(it.address)}
                      onFollow={() => act(it, { follow: !it.followed })}
                      onHide={() => act(it, { block: true }, T('rd.hiddenOk'))} />
                  ))}
                </Fragment>
              ))}
              {!items.length && <div className="text-sm text-t4 text-center py-10 px-4">{filterable ? (lists.filtered ? T('rd.e.filtered') : <>{T('rd.e.none')}<span className="block mt-2 text-xs text-t4">{T('rd.e.fresh')}</span></>) : tab === 'soon' ? T('rd.e.soon') : tab === 'follow' ? T('rd.e.follow') : T('rd.e.mine')}</div>}
              {filterable && lists.filtered > 0 && (
                <div className="text-xs text-t4 text-center py-3">{T('rd.moreFiltered', { n: lists.filtered })}<button className="text-t2 hover:text-t1 underline" onClick={() => setPrefs({ radarFilter: emptyRadarFilter() })}>{T('rd.clearFilter')}</button></div>
              )}
            </div>
          </div>
        )}
        {current && <div className="flex-1 min-w-0 min-h-0"><Detail key={current} address={current} canTrade={radar.canTrade} onPick={(a) => setSel(a)} onBack={narrow ? () => setSel(null) : undefined} /></div>}
        {!current && !narrow && <div className="flex-1 grid place-items-center text-t4 text-sm">{T('rd.pick')}</div>}
      </div>
      {fOpen && <FilterPop anchor={fBtn.current} toggle={fBtn} onClose={() => setFOpen(false)} />}
      {open && <SettingsModal v={radar} onClose={() => setOpen(false)} />}
    </div>
  )
}
