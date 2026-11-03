// 战壕：新创建 / 即将打满 / 已开盘三列（GMGN 首页）。
// 每列有自己的 ⚡ 快买金额和 P1–P3 交易预设；筛选在漏斗里；鼠标停在列里时列表暂停滚动（不会点错）。
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { Filter, Loader2, Pause, Star, Users, Zap, Check, AlertCircle, G, X } from '../components/gi'
import clsx from 'clsx'
import { useApp } from '../store/app'
import { emptyFilter, filterCount, usePrefs, type ColFilter, type ColKey, type PresetId } from '../store/prefs'
import { matchColumn, sortColumn, volUsd } from '../../../shared/filters.js'
import { SoundList, SoundPopover, type SoundValue } from '../components/SoundPicker'
import { age, ageColor, compact, fullTime, short, usd, launchpadLabel } from '../lib/format'
import { buy, defaultPct } from '../lib/trade'
import { api } from '../lib/api'
import type { Token } from '../lib/types'
import { CopyBtn, TokenAvatar, useNow, useOutsideClose } from '../components/common'
import { BnbCoin, PlatformBadge } from '../components/icons'
import { Tip } from '../components/Hover'
import { BondChip, DevTag, DivChip, DexStats, FairLine, GateChip, QuoteChip, Socials, TaxChip, bondInfo, href, platformUrl } from '../components/TokenMeta'
import { useT, t as T } from '../lib/i18n'

const COLS: { k: ColKey; title: string }[] = [
  { k: 'new', title: 'tr.col.new' },
  { k: 'soon', title: 'tr.col.soon' },
  { k: 'dex', title: 'tr.col.dex' },
]
const LIMIT = 80
const lc = (a?: string | null) => String(a || '').toLowerCase()

export { volUsd }   // 成交额（美元），定义在 shared/filters.js

function useColumnTokens(k: ColKey): Token[] {
  const tokens = useApp((s) => s.tokens)
  const blocklist = useApp((s) => s.blocklist)
  const platforms = usePrefs((s) => s.platforms)
  const c = usePrefs((s) => s.cols[k])
  const bnbUsd = useApp((s) => s.bnbUsd)
  // 匹配和排序规则在 shared/filters.js（Gateway 判断新币提醒用的是同一份）
  return useMemo(() => {
    const ctx = { platforms, bnbUsd, now: Date.now(), isBlocked: (t: { address: string; creator?: string | null }) => !!(blocklist.tokens[lc(t.address)] || (t.creator && blocklist.devs[lc(t.creator)])) }
    return sortColumn([...tokens.values()].filter((t) => matchColumn(t, k, c.filter, ctx)), k, c.sort)
  }, [tokens, blocklist, platforms, c.filter, c.sort, k, bnbUsd])
}

export function TrenchesPage() {
  useT()   // 切换语言时重绘（下面用 T() 取文案）
  useNow(1000)
  return (
    <div className="h-full flex flex-col min-h-0 p-1.5 gap-1.5 overflow-x-auto overflow-y-hidden">
      {/* 三列每列最少 360px（再窄卡片内容放不下），窗口不够时横向滚动，不裁列；flex-1 让三列占满高度、各自滚动 */}
      <div className="grid grid-cols-3 gap-1.5 flex-1 min-h-0" style={{ gridTemplateColumns: 'repeat(3, minmax(360px, 1fr))' }}>
        {COLS.map((c) => <Column key={c.k} k={c.k} title={c.title} />)}
      </div>
    </div>
  )
}


function Column({ k, title }: { k: ColKey; title: string }) {
  const list = useColumnTokens(k)
  const tokens = useApp((s) => s.tokens)
  const [hover, setHover] = useState(false)
  const frozen = useRef<string[] | null>(null)
  // 新币提示音由 Gateway 判断（engine/live/notifier.js，规则和筛选与这里的列表同一份），网页只负责播放（store/app.ts 的 alert）

  // 鼠标在列里：顺序冻结（只更新数据，不插入 / 不重排），离开后恢复
  useEffect(() => { frozen.current = hover ? list.slice(0, LIMIT).map((t) => lc(t.address)) : null }, [hover]) // eslint-disable-line
  // 冻结时也要去掉刚屏蔽的（顺序不变，只是少一张）
  const blocklist = useApp((s) => s.blocklist)
  const shown = hover && frozen.current ? frozen.current.map((a) => tokens.get(a)).filter((t): t is Token => !!t && !blocklist.tokens[lc(t.address)] && !(t.creator && blocklist.devs[lc(t.creator)])) : list.slice(0, LIMIT)

  return (
    <section className="flex flex-col min-h-0 rounded-md bg-card border border-line overflow-hidden @container/col" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <ColumnHeader k={k} title={title} count={list.length} paused={hover} />
      <div className="flex-1 min-h-0 scroll-y no-sb">
        {shown.map((t) => <Card key={t.address} t={t} col={k} />)}
        {!shown.length && <div className="py-16 text-center text-t4">{T('tr.empty')}</div>}
      </div>
    </section>
  )
}

/** 新币提醒（GMGN 列头同一个位置、同一套声音）：点开是声音列表，悬停试听、点击选中即关闭 */
function SoundButton({ k }: { k: ColKey }) {
  const c = usePrefs((s) => s.cols[k])
  const setCol = usePrefs((s) => s.setCol)
  const value: SoundValue = c.sound ? (c.soundKind || 'Bell') : 'Off'
  return (
    <SoundPopover trigger={({ open, toggle, ref }) => (
      <Tip text={c.sound ? T('tr.soundOn', { s: c.soundKind || 'Bell' }) : T('tr.sound')}>
        <button ref={ref} className={clsx('icon-btn w-6 h-6 flex-none', (open || c.sound) && '!text-t1')} onClick={toggle}>
          <G n={c.sound ? 'Volume16pxRegular' : 'Mute16pxRegular'} className="ico" />
        </button>
      </Tip>
    )}>
      {(close) => <SoundList value={value} onSelect={(v) => { setCol(k, v === 'Off' || v === 'default' ? { sound: false } : { sound: true, soundKind: v }); close() }} />}
    </SoundPopover>
  )
}

function ColumnHeader({ k, title, count, paused }: { k: ColKey; title: string; count: number; paused: boolean }) {
  const c = usePrefs((s) => s.cols[k])
  const setCol = usePrefs((s) => s.setCol)
  const [amt, setAmt] = useState(String(c.amount || ''))
  const [fOpen, setFOpen] = useState(false)
  const hdr = useRef<HTMLDivElement>(null)
  const fBtn = useRef<HTMLButtonElement>(null)
  const active = filterCount(c.filter) > 0
  // 三列表头完全一致：「即将打满」的进度 / 市值排序放进筛选面板，不在表头单独占位（原来这一列更挤，开钱包追踪时最先变形）
  const tip = k === 'soon' && c.sort === 'mc' ? [T('tr.filter'), T('tr.sortMc')] : T('tr.filter')
  return (
    <div ref={hdr} className="relative h-12 flex-none flex items-center gap-1.5 pl-2 pr-3 border-b border-line whitespace-nowrap">
      <span className="text-md font-medium flex-none">{T(title)}</span>
      {/* 数量和暂停叠在同一个位置：暂停标记是浮层（absolute），出现 / 消失时表头一个像素都不动 */}
      <span className="relative flex-none">
        <span className={clsx('text-t3 text-sm hidden @[340px]/col:inline transition-opacity', paused && 'opacity-0')}>{count}</span>
        {paused && (
          <Tip text={T('tr.pausedTip')} className="absolute left-0 top-1/2 -translate-y-1/2">
            <span className="h-5 px-1.5 flex items-center gap-1 rounded-xs bg-warn/16 text-warn text-xs"><Pause className="w-2.5 h-2.5" />{T('tr.paused')}</span>
          </Tip>
        )}
      </span>
      <div className="flex-1" />
      <Tip text={[T('tr.qbAmt'), T('tr.qbAmtHint')]}>
        <label className="input-box h-6 px-1.5 w-[64px] @[400px]/col:w-[78px] gap-1 flex-none">
          <BnbCoin size={12} />
          <input className="w-full text-sm font-medium" value={amt} placeholder="0" inputMode="decimal"
            onChange={(e) => setAmt(e.target.value)} onBlur={() => { const v = Math.max(0, Number(amt) || 0); setCol(k, { amount: v }); setAmt(v ? String(v) : '') }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
        </label>
      </Tip>
      <Tip text={[T('tr.qbPreset'), T('tr.qbPresetHint')]}>
        <div className="seg h-6 flex-none">
          {([1, 2, 3] as PresetId[]).map((p) => <button key={p} data-on={c.preset === p} onClick={() => setCol(k, { preset: p })}>P{p}</button>)}
        </div>
      </Tip>
      <SoundButton k={k} />
      <Tip text={tip}>
        <button ref={fBtn} className={clsx('icon-btn w-6 h-6 flex-none relative', active && 'text-t1')} onClick={() => setFOpen((o) => !o)}>
          <Filter className="ico" />{active && <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-buy" />}
        </button>
      </Tip>
      {fOpen && <FilterPop k={k} anchor={hdr.current} toggle={fBtn} onClose={() => setFOpen(false)} />}
    </div>
  )
}

const FILTER_TABS: [ColKey, string][] = [['new', 'tr.col.new'], ['soon', 'tr.col.soon'], ['dex', 'tr.col.dex']]   // 第二项是文案键
type RangeKey = 'Progress' | 'Age' | 'Liq' | 'Mc' | 'Vol' | 'Holders' | 'Tax'
const RANGES: [RangeKey, string, string, ColKey[]][] = [
  ['Progress', 'tr.r.Progress', '%', ['new', 'soon']], ['Age', 'tr.r.Age', 'min', ['new', 'soon', 'dex']], ['Liq', 'tr.r.Liq', 'K', ['dex']],
  ['Mc', 'tr.r.Mc', 'K', ['new', 'soon', 'dex']], ['Vol', 'tr.r.Vol', 'K', ['new', 'soon', 'dex']], ['Holders', 'tr.r.Holders', '', ['new', 'soon', 'dex']], ['Tax', 'tr.r.Tax', '%', ['new', 'soon', 'dex']],
]

/** 列筛选面板（GMGN 同款结构）：三列各自一套条件，改完点「应用」才生效 */
function FilterPop({ k, anchor, toggle, onClose }: { k: ColKey; anchor: HTMLElement | null; toggle?: React.RefObject<HTMLElement | null>; onClose: () => void }) {
  const cols = usePrefs((s) => s.cols)
  const setCol = usePrefs((s) => s.setCol)
  const [tab, setTab] = useState<ColKey>(k)
  const [draft, setDraft] = useState<Record<ColKey, ColFilter>>(() => ({ new: { ...emptyFilter(), ...cols.new.filter }, soon: { ...emptyFilter(), ...cols.soon.filter }, dex: { ...emptyFilter(), ...cols.dex.filter } }))
  const [sortDraft, setSortDraft] = useState(cols.soon.sort)   // 只有「即将打满」有排序
  const f = draft[tab]
  const put = (v: Partial<ColFilter>) => setDraft((d) => ({ ...d, [tab]: { ...d[tab], ...v } }))
  const ref = useRef<HTMLDivElement>(null)
  // 挂到 body 上（列容器会裁掉溢出的内容），位置跟着列头走，并限制在屏幕内
  const r = anchor?.getBoundingClientRect()
  const W = Math.min(420, innerWidth - 24)
  const left = Math.max(12, Math.min((r?.right ?? innerWidth) - W - 8, innerWidth - W - 12)), top = (r?.bottom ?? 100) + 4
  useOutsideClose(ref, onClose, toggle)
  const apply = () => { for (const [c] of FILTER_TABS) setCol(c, { filter: draft[c] }); setCol('soon', { sort: sortDraft }); onClose() }
  // 注意：这两个是普通函数、用 {text(...)} 调用，不要写成 <Text />——渲染函数里定义的组件每次渲染都是新类型，输入框会被重建、每敲一个字就丢焦点
  const text = (label: string, field: 'keywords' | 'exclude' | 'dev', ph: string) => (
    <label key={field} className="flex flex-col gap-1.5">
      <span className="text-sm text-t2">{label}</span>
      <input className="input-box h-8 px-2.5 text-sm" value={f[field]} placeholder={ph} onChange={(e) => put({ [field]: e.target.value })} />
    </label>
  )
  const box = (field: keyof ColFilter, ph: string, unit: string) => (
    <span key={field} className="input-box h-8 px-2.5 flex items-center gap-1 text-sm min-w-0">
      <input className="flex-1 min-w-0 bg-transparent outline-none" inputMode="decimal" value={String(f[field])} placeholder={ph}
        onChange={(e) => put({ [field]: e.target.value.replace(/[^\d.]/g, '') } as Partial<ColFilter>)} />
      {unit && <span className="text-t3 text-xs">{unit}</span>}
    </span>
  )
  return createPortal(
    <div ref={ref} style={{ left, top, width: W, maxHeight: innerHeight - top - 16 }} className="pop fixed z-[90] flex flex-col">
      <div className="px-4 pt-4 flex items-center justify-between">
        <span className="text-lg font-semibold">{T('tr.filter')}</span>
        <button className="icon-btn w-7 h-7" onClick={onClose}><X className="ico-md" /></button>
      </div>
      <div className="px-4 mt-3 flex items-center gap-5 border-b border-line">
        {FILTER_TABS.map(([c, name]) => {
          const n = filterCount(draft[c])
          return (
            <button key={c} onClick={() => setTab(c)} className={clsx('relative h-9 flex items-center gap-1.5 text-md font-medium', tab === c ? 'text-t1' : 'text-t3 hover:text-t2')}>
              {T(name)}{n > 0 && <span className="h-4 min-w-4 px-1 rounded-xs bg-up text-on-accent text-2xs font-semibold grid place-items-center">{n}</span>}
              {tab === c && <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-t1 rounded-full" />}
            </button>
          )
        })}
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {tab === 'soon' && (
          <div className="flex items-center justify-between">
            <span className="text-sm text-t2">{T('tr.sort')}</span>
            <div className="seg h-7">
              <button className="px-3" data-on={sortDraft === 'progress'} onClick={() => setSortDraft('progress')}>{T('tr.byProgress')}</button>
              <button className="px-3" data-on={sortDraft === 'mc'} onClick={() => setSortDraft('mc')}>{T('tr.byMc')}</button>
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          {text(T('tr.kw'), 'keywords', T('tr.kwPh'))}
          {text(T('tr.ex'), 'exclude', T('tr.kwPh'))}
          {text(T('tr.dev'), 'dev', T('tr.devPh'))}
          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-t2">{T('tr.social')}</span>
            <button onClick={() => put({ social: !f.social })} className={clsx('h-8 px-2.5 rounded-sm border text-sm text-left', f.social ? 'border-up/60 text-up bg-up/10' : 'border-line-2 text-t3 hover:text-t2')}>{T('tr.socialOnly')}</button>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-t2">{T('tr.bond')}</span>
            <button onClick={() => put({ bond: !f.bond })} className={clsx('h-8 px-2.5 rounded-sm border text-sm text-left', f.bond ? 'border-up/60 text-up bg-up/10' : 'border-line-2 text-t3 hover:text-t2')} title={T('tr.bondTip')}>{T('tr.bondOnly')}</button>
          </label>
        </div>
        <div className="border-t border-line pt-4 space-y-2.5">
          <div className="text-md font-medium text-t2">{T('tr.metrics')}</div>
          {RANGES.filter(([, , , on]) => on.includes(tab)).map(([key, name, unit]) => (
            <div key={key} className="grid grid-cols-[72px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
              <span className="text-sm text-t2">{T(name)}</span>
              {box(`min${key}` as keyof ColFilter, 'Min', unit)}
              {box(`max${key}` as keyof ColFilter, 'Max', unit)}
            </div>
          ))}
        </div>
      </div>
      <div className="px-4 py-3 border-t border-line flex gap-2">
        <button className="flex-1 h-9 rounded-sm bg-btn hover:bg-btn-2 text-t1 font-medium" onClick={() => { put(emptyFilter()); if (tab === 'soon') setSortDraft('progress') }}>{T('tr.reset')}</button>
        <button className="flex-1 h-9 rounded-sm bg-solid text-on-solid font-semibold" onClick={apply}>{T('tr.apply')}</button>
      </div>
    </div>,
    document.body,
  )
}

type BuyState = 'busy' | 'ok' | 'err' | null

export const Card = memo(function Card({ t, col }: { t: Token; col: ColKey }) {
  useT()   // memo 组件：切换语言时也要重绘
  const nav = useNavigate()
  const c = usePrefs((s) => s.cols[col])
  const bnbUsd = useApp((s) => s.bnbUsd)
  const isNew = useApp((s) => s.newTokens.has(lc(t.address)))
  const fav = useApp((s) => !!s.favorites.items[lc(t.address)])
  const [st, setSt] = useState<BuyState>(null)
  const curve = t.stage === 'curve'
  const opened = !curve && t.migratedAt ? t.migratedAt : null
  const fairMint = !!t.gangFair && curve   // 打新认购中：这里不支持认购，给一个去 gang.fun 的入口
  const label = c.amount > 0 ? `${c.amount} BNB` : `${defaultPct(t)}%`
  const bond = bondInfo(t)   // gang.fun 押金承诺：卡片左侧色条 + 淡色底（.bond-card），颜色和「押金」标签一致
  const vol = volUsd(t, bnbUsd)

  const onBuy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (st === 'busy') return
    setSt('busy')
    const r = await buy(t, c.amount > 0 ? { amount: c.amount, preset: c.preset, via: 'quick' } : { pctSupply: defaultPct(t), preset: c.preset, via: 'quick' })
    const ok = !!r && r.some((o) => o.status !== 'failed')
    setSt(r == null ? null : ok ? 'ok' : 'err')
    setTimeout(() => setSt(null), 2500)
  }
  const toggleFav = (e: React.MouseEvent) => { e.stopPropagation(); api('/api/favorites', fav ? { op: 'remove', address: t.address } : { op: 'set', address: t.address, symbol: t.symbol, platform: t.platform }).catch(() => {}) }
  // 先在本地标记屏蔽、卡片立刻消失（以前要等服务器推回 blocklist，鼠标还在列里时冻结的列表也不会去掉它）；请求失败再恢复
  const block = (kind: 'token' | 'dev', address: string, label: string) => {
    const key = kind === 'token' ? 'tokens' : 'devs', a = lc(address)
    useApp.setState((s) => ({ blocklist: { ...s.blocklist, [key]: { ...s.blocklist[key], [a]: { label } } } }))
    api('/api/blocklist', { kind, address, on: true, label }).catch((err) => {
      useApp.setState((s) => { const m = { ...s.blocklist[key] }; delete m[a]; return { blocklist: { ...s.blocklist, [key]: m } } })
      useApp.getState().toast({ kind: 'error', title: T('tr.blockFailed'), body: err.message })
    })
  }
  const hide = (e: React.MouseEvent) => { e.stopPropagation(); block('token', t.address, t.symbol) }
  const hideDev = (e: React.MouseEvent) => { e.stopPropagation(); if (t.creator) block('dev', t.creator, t.creatorName || short(t.creator)) }

  // 卡片高度跟内容走（最低 124）：间距都是 rem，浏览器默认字号不是 16px 时写死高度会把底部那行挤到贴边；
  // 右列 pb-1.5 让按钮的中心线对齐左边最底下那行信息（按钮比文字行高，底边对齐会显得偏高）
  return (
    <div onClick={() => nav(`/token/${t.address}`)}
      className={clsx('group relative @container/card cursor-pointer border-b border-line hover:bg-hover transition-colors', bond && `bond-card bond-${bond.tone}`, isNew && Date.now() - t.createdAt < 120_000 && 'flash-in')}>
    {/* 按这张卡片自己的宽度排版（不是整个窗口）：打开右侧追踪、窗口变窄、列变窄都一样适用，规则见 docs/DESIGN-GMGN-PARITY.md「卡片的收缩」 */}
    <div className="grid grid-cols-[80px_minmax(0,1fr)_auto]" style={{ minHeight: 124 }}>   {/* 头像列固定 80px：头像（64px）左边缘距卡片 8px，和列标题（pl-2）对齐 */}
      {/* 左：头像（右下角平台，点开平台页）+ 进度 + CA */}
      <div className="flex flex-col items-center pt-3 gap-3">
        <span className="relative av-wrap">
          <TokenAvatar t={t} size={64} progress={curve ? t.progress : 100} badge={false} />
          <span className="absolute z-10 flex flex-col gap-px" style={{ left: -6, top: -6 }}>
            <Tip text={T('tr.hide')}><button onClick={hide} className="side-btn hover:!text-down"><G n="Hide16pxRegular" className="w-3.5 h-3.5" /></button></Tip>
            {t.creator && <Tip text={T('tr.blockDev')}><button onClick={hideDev} className="side-btn hover:!text-down"><G n="Blacklistdev16pxRegular" className="w-3.5 h-3.5" /></button></Tip>}
            <Tip text={fav ? T('tr.unfav') : T('tr.fav')}><button onClick={toggleFav} className={clsx('side-btn', fav && '!opacity-100 !text-warn')}><Star className="w-3.5 h-3.5" fill={fav ? 'currentColor' : 'none'} /></button></Tip>
          </span>
          <Tip className="absolute -right-1 -bottom-1" text={[launchpadLabel(t), curve ? T('tr.curvePct', { p: t.progress.toFixed(1) }) : T('tr.launchedPcs')]}>
            <a href={platformUrl(t)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}><PlatformBadge p={t.platform} size={16} /></a>
          </Tip>
        </span>
        <span className="flex items-center text-t3 text-xs mt-0.5 whitespace-nowrap">{short(t.address, 2, 4)}<CopyBtn text={t.address} size={10} className="w-4 h-4" /></span>
      </div>
      {/* 中：名称 / 时间与社交 / 标签 / 进度或外盘数据 */}
      <div className="min-w-0 py-3 pr-2 flex flex-col gap-[7px] @container/mid">
        <div className="flex items-center gap-1.5 min-w-0 h-5">
          <span className="text-lg font-medium truncate max-w-[50%]">{t.symbol}</span>
          <span className="text-base text-t3 truncate min-w-0">{t.name !== t.symbol ? t.name : ''}</span>
        </div>
        <div className="flex items-center gap-2.5 h-4 text-sm text-t3 min-w-0 whitespace-nowrap">
          <Tip text={[...(opened ? [T('tr.openedAt', { t: fullTime(opened) })] : []), T('tr.createdAt', { t: fullTime(t.createdAt) })]}>
            <span className={clsx('font-medium', ageColor(opened || t.createdAt))}>{age(opened || t.createdAt)}</span>
          </Tip>
          <Socials t={t} size={13} narrow />
          {t.holders != null && t.holders > 0 && <Tip text={T('tr.holders', { n: t.holders })}><span className="hidden @[230px]/mid:flex items-center gap-0.5"><Users className="ico-sm" />{compact(t.holders, 1)}</span></Tip>}
          <DevTag t={t} />
        </div>
        <div className="flex items-center gap-1 min-w-0 overflow-hidden">
          <TaxChip t={t} />
          <DivChip t={t} />
          <BondChip t={t} />
          <QuoteChip t={t} />
          <GateChip t={t} />
        </div>
        <div className="flex items-center gap-2 text-xs text-t3 h-4 whitespace-nowrap overflow-hidden">
          {fairMint ? <FairLine t={t} />
            : curve
              ? <Tip text={[T('tr.raised', { r: compact(t.raised, 3), g: compact(t.target, 2), q: t.quote }), T('tr.raisedNote')]}><span className="text-up">{compact(t.raised, 2)}/{compact(t.target, 1)} {t.quote} · {t.progress.toFixed(1)}%</span></Tip>
              : <><DexStats t={t} />
          {!curve && t.dexChg?.h1 != null && <Tip text={[T('tr.h1', { v: `${t.dexChg.h1 > 0 ? '+' : ''}${t.dexChg.h1}` }), T('tr.m5h24', { m5: t.dexChg.m5 ?? '—', h24: t.dexChg.h24 ?? '—' })]}><span className={t.dexChg.h1 >= 0 ? 'text-up' : 'text-down'}>{t.dexChg.h1 > 0 ? '+' : ''}{t.dexChg.h1.toFixed(1)}%</span></Tip>}</>}
          {curve && t.firstBuyerName && <Tip text={T('tr.firstBuyerTip', { n: t.firstBuyerName })}><span className="truncate">{T('tr.firstBuyer', { n: t.firstBuyerName })}</span></Tip>}
        </div>
      </div>
      {/* 右：V / MC + 一键买 */}
      <div className="flex flex-col items-end justify-between pt-3 pb-1.5 pr-3 pl-2 min-w-[112px]">
        <div className="flex flex-col-reverse items-end @[500px]/card:flex-row @[500px]/card:items-baseline @[500px]/card:gap-2 whitespace-nowrap">
          {vol > 0 && <Tip text={curve ? T('tr.volCurve') : T('tr.vol24')}><span className="text-sm text-t3">V <span className="text-lg font-medium text-vol">{usd(vol, 1)}</span></span></Tip>}
          <Tip text={t.mcapEst ? T('tr.mcEst') : T('tr.mc')}><span className="text-sm text-t3">MC <span className={clsx('text-lg font-medium', curve ? 'text-t1' : 'text-up')}>{t.mcapEst ? '≈' : ''}{usd(t.mcapUsd, 1)}</span></span></Tip>
        </div>
        {fairMint
          ? <Tip text={[T('tr.fairTip1'), T('tr.fairTip2')]}><a href={platformUrl(t)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="h-7 px-3 rounded-full flex items-center gap-1 text-sm font-medium bg-btn-2 text-t1 hover:bg-hover-2">{T('tr.subscribe')}<G n="Newtab16pxRegular" className="ico-sm" /></a></Tip>
          : <button onClick={onBuy}
          className={clsx('h-7 px-3 rounded-full flex items-center gap-1 text-sm font-medium transition-colors',
            st === 'busy' ? 'bg-warn/16 text-warn' : st === 'ok' ? 'bg-up/16 text-up' : st === 'err' ? 'bg-down/16 text-down' : 'bg-btn-2 text-t1 hover:bg-buy hover:text-on-accent')}>
          {st === 'busy' ? <Loader2 className="ico-sm spin" /> : st === 'ok' ? <Check className="ico-sm" /> : st === 'err' ? <AlertCircle className="ico-sm" /> : <Zap className="ico-sm" fill="currentColor" />}
          {label}
        </button>}
      </div>
    </div>
    </div>
  )
})

export { href }
