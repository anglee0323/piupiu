// 代币卡片上的小元素（战壕、热门、代币页共用），交互照 GMGN：
// - 推特图标：只在有推特链接时出现；悬浮显示推文 / 账号预览卡，点击打开原推
// - 官网 / 电报：有才显示，点击跳转
// - 创建者：悬浮看他发过的其他币，点击打开 BscScan
// - 税 / 分红 / 计价币 / Agent ID 标签：悬浮看具体规则
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { G } from './gi'
import { Hover, KV, Tip } from './Hover'
import { CopyBtn } from './common'
import { api, imgUrl } from '../lib/api'
import { age, compact, fullTime, short, usd } from '../lib/format'
import { useApp } from '../store/app'
import type { Token } from '../lib/types'
import { t as T } from '../lib/i18n'

const lc = (a?: string | null) => String(a || '').toLowerCase()
export const href = (u: string) => (/^https?:/.test(u) ? u : 'https://' + u)
const stop = (e: React.MouseEvent) => e.stopPropagation()

// ───────────────────────── 推特 ─────────────────────────

type XAuthor = { name: string; handle: string; avatar: string | null; followers: number | null; following?: number | null; joined: string | null; bio?: string }
type XInfo =
  | { kind: 'status'; url: string; author: XAuthor; text: string; createdAt: number | null; likes: number; retweets: number; replies: number; image: string | null; quote: { author: XAuthor; text: string; createdAt: number | null } | null }
  | { kind: 'user'; url: string; author: XAuthor }
  | { kind: 'community' | 'other' | 'gone'; url: string }

const xCache = new Map<string, Promise<XInfo>>()
const loadX = (u: string) => { let p = xCache.get(u); if (!p) { p = api<XInfo>(`/api/tweet?u=${encodeURIComponent(u)}`); p.catch(() => xCache.delete(u)); xCache.set(u, p) } return p }

export function xKind(u: string): 'status' | 'user' | 'community' | 'other' {
  try {
    const x = new URL(href(u)); if (!/(^|\.)(x|twitter)\.com$/i.test(x.hostname)) return 'other'
    const p = x.pathname.split('/').filter(Boolean)
    if (p[0] === 'i' && p[1] === 'communities') return 'community'
    if (p[1] === 'status') return 'status'
    return p[0] ? 'user' : 'other'
  } catch { return 'other' }
}

const joinedText = (j: string | null) => { if (!j) return ''; const d = new Date(j); return isNaN(+d) ? '' : T('tm.joined', { y: d.getFullYear(), m: d.getMonth() + 1 }) }

function AuthorRow({ a, ts }: { a: XAuthor; ts?: number | null }) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      {a.avatar ? <img src={imgUrl(a.avatar) || ''} alt="" className="w-8 h-8 rounded-full flex-none bg-btn" /> : <span className="w-8 h-8 rounded-full bg-btn flex-none" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0"><span className="font-medium truncate">{a.name}</span>{ts ? <span className="text-t3 text-xs flex-none">{age(ts)}</span> : null}</div>
        <div className="text-t3 text-xs truncate">@{a.handle}{a.followers != null && <> · <span className="text-t2">{compact(a.followers, 1)}</span> {T('tm.followers')}</>}{a.joined && <> · {joinedText(a.joined)}</>}</div>
      </div>
    </div>
  )
}

function XCard({ url }: { url: string }) {
  const [v, setV] = useState<XInfo | null>(null)
  const [err, setErr] = useState(false)
  useEffect(() => { let on = true; loadX(url).then((x) => on && setV(x)).catch(() => on && setErr(true)); return () => { on = false } }, [url])
  if (err) return <div className="text-t3">{T('tm.previewFailed')}</div>
  if (!v) return <div className="text-t3 flex items-center gap-2"><span className="w-3 h-3 rounded-full border-2 border-t4 border-t-t1 spin" />{T('tm.loadingTweet')}</div>
  if (v.kind === 'gone') return <div className="text-warn">{T('tm.tweetGone')}</div>
  if (v.kind === 'user') return (
    <div className="space-y-2">
      <AuthorRow a={v.author} />
      {v.author.bio && <div className="text-t2 whitespace-pre-wrap break-words">{v.author.bio}</div>}
    </div>
  )
  if (v.kind !== 'status') return v.kind === 'community' ? <div>{T('tm.community')}</div> : <div className="break-all text-t2">{url}</div>
  return (
    <div className="space-y-2">
      <AuthorRow a={v.author} ts={v.createdAt} />
      <div className="whitespace-pre-wrap break-words leading-5">{v.text}</div>
      {v.image && <img src={imgUrl(v.image) || ''} alt="" className="rounded-sm max-h-40 w-full object-cover bg-btn" />}
      {v.quote && (
        <div className="rounded-sm border border-line p-2 space-y-1.5">
          <AuthorRow a={v.quote.author} ts={v.quote.createdAt} />
          <div className="whitespace-pre-wrap break-words text-t2 line-clamp-6">{v.quote.text}</div>
        </div>
      )}
      <div className="flex items-center gap-4 text-xs text-t3">
        <span>{T('tm.replies', { n: compact(v.replies, 1) })}</span><span>{T('tm.retweets', { n: compact(v.retweets, 1) })}</span><span>{T('tm.likes', { n: compact(v.likes, 1) })}</span>
        {v.createdAt && <span className="ml-auto">{fullTime(v.createdAt)}</span>}
      </div>
    </div>
  )
}

// 推文 ID 自带发布时间（雪花 ID：高位是毫秒时间戳），不用请求就能算出这条推文是多久前发的
const TW_EPOCH = 1288834974657n
export function tweetTime(url: string): number | null {
  const m = String(url).match(/status\/(\d+)/)
  if (!m) return null
  try { return Number((BigInt(m[1]) >> 22n) + TW_EPOCH) } catch { return null }
}

// 颜色和 GMGN 一致（取的是它的主题色）：刚发的推文偏绿 / 蓝，时间越久越黄、越红
const C_GREEN = 'var(--color-up)', C_BLUE = 'var(--color-vol)', C_YELLOW = 'var(--color-warn)', C_RED = 'var(--color-down)', C_X = 'var(--color-link)'   // 跟随主题
// 阈值是在 GMGN 上实测的：10 分钟内绿，10–30 蓝，30–60 黄，超过 60 分钟红（绿→蓝在 10.6~11.1 分钟之间切换；蓝最晚见到 21 分钟，黄最早 35 分钟）
export const TWEET_AGE_STEPS: [number, string][] = [[10, C_GREEN], [30, C_BLUE], [60, C_YELLOW]]   // 分钟；超过最后一档 = 红
export function tweetColor(ts: number | null, now = Date.now()): string {
  if (ts == null) return C_RED
  const min = Math.max(0, (now - ts) / 60_000)
  for (const [lim, c] of TWEET_AGE_STEPS) if (min < lim) return c
  return C_RED
}

// 全站共用一个 30 秒的时钟，推文颜色随时间自己变，不用每个图标各开一个定时器
const clock = { v: 0, subs: new Set<() => void>(), timer: 0 as unknown as number }
const subClock = (fn: () => void) => {
  clock.subs.add(fn)
  if (clock.subs.size === 1) clock.timer = window.setInterval(() => { clock.v++; clock.subs.forEach((f) => f()) }, 30_000)
  return () => { clock.subs.delete(fn); if (!clock.subs.size) clearInterval(clock.timer) }
}
const useClock = () => useSyncExternalStore(subClock, () => clock.v)

/** 推特链接图标（和 GMGN 一样）：具体某条推文 = 小羽毛，颜色看推文发了多久；账号主页 = X 图标（蓝）；社区 = 社区图标（蓝）。悬浮预览，点击打开 */
export function XLink({ url, size = 14 }: { url: string; size?: number }) {
  useClock()
  const k = xKind(url)
  const icon = k === 'status' ? 'Tweet16pxRegular' : k === 'community' ? 'Xcommunity16pxRegular' : 'Officialx16pxRegular'
  const color = k === 'status' ? tweetColor(tweetTime(url)) : C_X
  return (
    <Hover content={() => <XCard url={href(url)} />} popClass="w-[340px] max-h-[420px] overflow-y-auto p-3">
      <a href={href(url)} target="_blank" rel="noreferrer" onClick={stop} className="flex items-center hover:opacity-80">
        <G n={icon} style={{ width: size, height: size, color }} />
      </a>
    </Hover>
  )
}

export function SiteLink({ url, size = 14 }: { url: string; size?: number }) {
  return (
    <Tip text={[T('tm.site'), <span className="break-all">{url}</span>]}>
      <a href={href(url)} target="_blank" rel="noreferrer" onClick={stop} className="flex items-center text-t2 hover:text-t1"><G n="Website16pxRegular" style={{ width: size, height: size }} /></a>
    </Tip>
  )
}

export function TgLink({ url, size = 14 }: { url: string; size?: number }) {
  return (
    <Tip text={['Telegram', <span className="break-all">{url}</span>]}>
      <a href={href(url)} target="_blank" rel="noreferrer" onClick={stop} className="flex items-center text-t2 hover:text-t1"><G n="Telegram16pxRegular" style={{ width: size, height: size }} /></a>
    </Tip>
  )
}

/** 在 X 上搜这个合约地址（看谁在喊单） */
export function XSearch({ address, size = 14 }: { address: string; size?: number }) {
  return (
    <Tip text={T('tm.searchX')}>
      <a href={`https://x.com/search?q=${address}&f=live`} target="_blank" rel="noreferrer" onClick={stop} className="flex items-center text-t2 hover:text-t1"><G n="Gmgnsearch20px" style={{ width: size, height: size }} /></a>
    </Tip>
  )
}

type SocialKind = 'status' | 'user' | 'community' | 'site' | 'telegram'
const SOCIAL_ORDER: Record<SocialKind, number> = { status: 0, user: 1, community: 2, site: 3, telegram: 4 }
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase() } catch { return '' } }

/** 把代币的 推特 / 官网 / 电报 三个字段统一收集，按链接本身是什么来分类（平台常把推特链接填进官网或电报字段，推特字段也常只有个用户名） */
export function socialLinks(t: Pick<Token, 'twitter' | 'website' | 'telegram'>): { kind: SocialKind; url: string }[] {
  const seen = new Set<string>()
  const out: { kind: SocialKind; url: string }[] = []
  for (const [field, raw] of [['twitter', t.twitter], ['website', t.website], ['telegram', t.telegram]] as const) {
    let u = String(raw || '').trim()
    if (!u) continue
    if (field === 'twitter' && /^@?[A-Za-z0-9_]{1,15}$/.test(u)) u = 'https://x.com/' + u.replace(/^@/, '')   // 只填了用户名
    else u = href(u)
    const h = host(u)
    if (!h || !h.includes('.')) continue   // 不是有效网址（比如 https://predictdotfun/）
    const key = u.split(/[?#]/)[0].replace(/\/$/, '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const kind: SocialKind = /(^|\.)(x|twitter)\.com$/.test(h) ? (xKind(u) === 'other' ? 'user' : (xKind(u) as SocialKind)) : /(^|\.)(t\.me|telegram\.(me|org|dog))$/.test(h) ? 'telegram' : 'site'
    out.push({ kind, url: u })
  }
  return out.sort((x, y) => SOCIAL_ORDER[x.kind] - SOCIAL_ORDER[y.kind])
}

/** 代币的全部社交图标（只显示有的）：推文 → 账号 → 社区 → 官网 → 电报，最后是「在 X 上搜合约」 */
/** narrow：战壕卡片里用，所在的中间栏（@container/mid）很窄时先收起 X 搜索。其他页面没有这个容器，不要开 */
export function Socials({ t, size = 14, narrow = false }: { t: Token; size?: number; narrow?: boolean }) {
  return (
    <>
      {socialLinks(t).map((l) => l.kind === 'telegram' ? <TgLink key={l.url} url={l.url} size={size} /> : l.kind === 'site' ? <SiteLink key={l.url} url={l.url} size={size} /> : <XLink key={l.url} url={l.url} size={size} />)}
      {narrow ? <span className="hidden @[260px]/mid:flex"><XSearch address={t.address} size={size} /></span> : <XSearch address={t.address} size={size} />}
    </>
  )
}

// ───────────────────────── 创建者 ─────────────────────────

/** 创建者：名字（有 .ai 名的显示名字）。悬浮看他发过的其他币，点击打开 BscScan */
export function DevTag({ t, max = 96, className }: { t: Token; max?: number; className?: string }) {
  const nav = useNavigate()
  const name = useApp((s) => t.creatorName || (t.creator ? s.names[lc(t.creator)] : null))
  const tokens = useApp((s) => s.tokens)
  if (!t.creator) return null
  const others = () => [...tokens.values()].filter((x) => lc(x.creator) === lc(t.creator) && lc(x.address) !== lc(t.address)).sort((a, b) => b.createdAt - a.createdAt)
  return (
    <Hover className={clsx('min-w-0', className)} popClass="w-[300px] p-3" content={() => {
      const list = others()
      return (
        <div className="space-y-2.5">
          <div className="flex items-center gap-1.5">
            <span className="text-t3">{T('tm.creator')}</span>
            {name && <span className="text-violet">{name}</span>}
            <span className="flex items-center text-t2 ml-auto">{short(t.creator, 4, 4)}<CopyBtn text={t.creator!} size={11} className="w-5 h-5" /></span>
          </div>
          <div className="text-t3 text-xs">{list.length ? T('tm.otherTokens', { n: list.length }) : T('tm.noOther')}</div>
          {list.slice(0, 6).map((x) => (
            <button key={x.address} onClick={() => nav(`/token/${x.address}`)} className="w-full flex items-center gap-2 text-left hover:bg-hover-2 rounded-xs px-1 -mx-1 py-0.5">
              <span className="font-medium truncate max-w-[110px]">{x.symbol}</span>
              <span className={clsx('text-xs', x.stage === 'dex' ? 'text-warn' : 'text-t3')}>{x.stage === 'dex' ? T('tm.launched') : T('tm.curve')}</span>
              <span className="ml-auto text-up">{usd(x.mcapUsd, 1)}</span>
              <span className="w-10 text-right text-t3 text-xs">{age(x.createdAt)}</span>
            </button>
          ))}
          <div className="flex gap-2">
            <span className="flex-1 [&>span]:w-full [&_button]:w-full [&_button]:justify-center"><TrackBtn address={t.creator} name={name} size="md" /></span>
            <a href={`https://bscscan.com/address/${t.creator}`} target="_blank" rel="noreferrer" className="flex-1 text-center h-7 leading-7 rounded-xs bg-btn hover:bg-btn-2 text-t2 text-sm">BscScan</a>
          </div>
        </div>
      )
    }}>
      <a href={`https://bscscan.com/address/${t.creator}`} target="_blank" rel="noreferrer" onClick={stop}
        className={clsx('flex items-center gap-0.5 hover:underline min-w-0', name ? 'text-violet' : 'text-t2')}>
        <G n="Dev16pxRegular" className="ico-sm" />
        {name && <span className="truncate" style={{ maxWidth: max }}>{name}</span>}
      </a>
    </Hover>
  )
}

// ───────────────────────── 标签 ─────────────────────────

const pctOf = (bps?: number | null) => `${+((bps || 0) / 100).toFixed(2)}%`

/** 买 / 卖税（所有平台同一种写法：买%/卖%）。卡片标签和代币信息共用 */
export function taxInfo(t: Token): { label: string; lines: ReactNode[]; hi: boolean } | null {
  const v3 = t.gangV3, ft = t.flapTax, fr = t.gangFair, fy = t.gangFly
  let b: number | null = null, s: number | null = null, lines: ReactNode[] = []
  if (fy) {
    b = fy.buyTaxPct; s = fy.sellTaxPct
    lines = [T('tm.flyTax', { b: fy.buyTaxPct, s: fy.sellTaxPct }), T('tm.flyFees', { m: fy.mintFeePct, e: fy.exitFeeNowPct })]
  } else if (fr) {
    b = 1; s = 1
    lines = [T('tm.fairTax'), T('tm.fairFees', { m: fr.mintFeePct, e: fr.exitFeeNowPct })]
  } else if (v3) {
    b = (v3.buyTaxBps || 0) / 100; s = (v3.sellTaxBps || 0) / 100
    lines = [T('tm.taxes', { b: pctOf(v3.buyTaxBps), s: pctOf(v3.sellTaxBps) }), T('tm.taxAfterLaunch'), ...(v3.recipientLabel ? [T('tm.taxTo', { who: v3.recipientLabel })] : [])]
  } else if (ft) {
    b = (ft.buyBps || 0) / 100; s = (ft.sellBps || 0) / 100
    lines = [T('tm.taxes', { b: pctOf(ft.buyBps), s: pctOf(ft.sellBps) }), ...(ft.beneficiaryName ? [T('tm.taxTo', { who: ft.beneficiaryName })] : [])]
  } else if (t.buyFeePct != null || t.sellFeePct != null) {
    b = t.buyFeePct ?? 0; s = t.sellFeePct ?? 0
    lines = [T('tm.feeRates', { b: +b.toFixed(2), s: +s.toFixed(2) }), T('tm.feeIncl')]
  }
  if (b == null || s == null) return null
  return { label: `${+b.toFixed(2)}%/${+s.toFixed(2)}%`, lines, hi: Math.max(b, s) >= 5 }
}

export function TaxChip({ t }: { t: Token }) {
  const x = taxInfo(t)
  if (!x) return null
  return <Tip text={x.lines}><span className={clsx('chip', x.hi && '!text-down !border-down/40 bg-down/10')}><G n="Percent16pxRegular" className="w-2.5 h-2.5" />{x.label}</span></Tip>
}

/** 分红：交易税里分给持有人的部分 */
export function divInfo(t: Token): ReactNode[] | null {
  const v3 = t.gangV3, ft = t.flapTax, gd = t.gangDiv, fr = t.gangFair, fy = t.gangFly
  if (fy) return [T('tm.div.fly1'), T('tm.div.fly2', { p: fy.holdPct })]
  if (fr) return [T('tm.div.fair1'), T('tm.div.fair2', { p: fr.holdPct }), T('tm.div.fair3')]
  if (v3 && v3.dividendBps > 0 && (v3.buyTaxBps || v3.sellTaxBps)) return [T('tm.div.share', { p: pctOf(v3.dividendBps) }), T('tm.div.platform'), T('tm.div.cond10k')]
  if (ft && (ft.divBps ?? 0) > 0) return [T('tm.div.share', { p: pctOf(ft.divBps) }), ...(ft.divSym ? [T('tm.div.paidIn', { sym: ft.divSym })] : [])]
  if (!v3 && gd?.taxed) return [T('tm.div.gangTax', { p: pctOf(gd.taxBps ?? 100) }), T('tm.div.gang1'), T('tm.div.gang2')]
  return null
}

export function DivChip({ t }: { t: Token }) {
  const lines = divInfo(t)
  if (!lines) return null
  return <Tip text={lines}><span className="chip !text-up"><G n="Holderreward16pxRegular" className="w-2.5 h-2.5" />{T('tm.dividend')}</span></Tip>
}

/** gang.fun Agent 押金承诺（GangBond）：开发者押钱承诺「创建地址持有 ≥ X 个，直到开盘后 N 天」，期间卖出 / 转走会被举报罚没、押金回购销毁。
 *  颜色和 gang.fun 一致：覆盖率 ≥100% 绿「押金全覆盖」，50–100% 黄「押金」，其余灰色「押金」；已罚没红色 */
export function bondInfo(t: Token): { label: string; tone: 'up' | 'warn' | 'down' | 'gray'; lines: string[] } | null {
  const b = t.gangBond
  if (!b || b.state === 'refunded' || b.state === 'settled') return null
  const hold = b.holdPct != null ? `${+b.holdPct.toFixed(2)}%` : '—'
  const val = b.valueBnb != null ? `${+b.valueBnb.toPrecision(3)} BNB` : '—'
  if (b.state === 'slashed') return { label: T('tm.bond.slashed'), tone: 'down', lines: [T('tm.bond.slashed1'), T('tm.bond.slashed2')] }
  const clock = b.phase === 'pending' ? T('tm.bond.pending', { d: b.days ?? '—' }) : b.deadline ? T('tm.bond.until', { t: fullTime(b.deadline) }) : T('tm.bond.days', { d: b.days ?? '—' })
  const lines = [
    T('tm.bond.desc', { val, hold }),
    clock,
    b.coveragePct != null ? T('tm.bond.cover', { p: +b.coveragePct.toFixed(0), why: T(b.coveragePct >= 100 ? 'tm.bond.coverFull' : 'tm.bond.coverLow') }) : T('tm.bond.noPool'),
    b.violated ? T('tm.bond.violated') : T('tm.bond.rule'),
    ...(!b.qualified ? [T('tm.bond.unqualified')] : []),
  ]
  const tone = b.violated ? 'down' : b.tier === 'full' ? 'up' : b.tier === 'bond' ? 'warn' : 'gray'
  return { label: b.violated ? T('tm.bond.broken') : b.tier === 'full' ? T('tm.bond.full') : T('tm.bond.plain'), tone, lines }
}

export function BondChip({ t }: { t: Token }) {
  const x = bondInfo(t)
  if (!x) return null
  return <Tip text={x.lines}><span className={clsx('chip', x.tone === 'up' ? '!text-up' : x.tone === 'warn' ? '!text-warn' : x.tone === 'down' ? '!text-down' : 'text-t3')}><G n="Safe16pxRegular" className="w-2.5 h-2.5" />{x.label}</span></Tip>
}

/** 计价代币：不是 BNB 时才显示（BNB 是默认） */
export function QuoteChip({ t }: { t: Token }) {
  const q = String(t.quote || 'BNB').toUpperCase()
  if (q === 'BNB' || q === 'WBNB') return null
  return <Tip text={[T('tm.quoteToken', { sym: t.quote }), T('tm.quoteNote')]}><span className="chip !text-warn"><G n="Dollar16pxRegular" className="w-2.5 h-2.5" />{t.quote}</span></Tip>
}

/** 内盘交易门槛：本终端收录的币内盘都只对 Agent ID 钱包开放，这是默认，不单独标。
 *  只有门槛不是 Agent ID（要持有别的 NFT，Agent 钱包也买不了）时才标出来 */
export const gateNote = (t: Token): string | null =>
  t.stage === 'curve' && t.nftGate && !t.nftGate.removed && !t.nftGate.known ? T('tm.needNft', { name: t.nftGate.name || T('tm.someNft') }) : null

export function GateChip({ t }: { t: Token }) {
  const n = gateNote(t)
  if (!n) return null
  return <Tip text={[n, T('tm.nftGate')]}><span className="chip !text-down"><G n="Lock16pxRegular" className="w-2.5 h-2.5" />NFT</span></Tip>
}

/** 单钱包限购（有的平台有）：Flap NFT 门槛盘每个钱包最多买总量 2%；Gang 打新每人最多 N 份 */
export const walletCap = (t: Token): string | null =>
  t.gangFair ? T('tm.capShares', { n: t.gangFair.capShares }) : t.stage === 'curve' && t.nftGate && !t.nftGate.removed ? T('tm.capPct', { p: t.nftGate.capPct ?? 2 }) : null

/** 外盘统计：池子 + 24h 买卖笔数 */
/** 打新认购进度的一行文字 + 悬浮说明 */
export function FairLine({ t }: { t: Token }) {
  const f = t.gangFair
  if (!f) return null
  return (
    <Tip text={[T('tm.fair.sub', { sold: f.sold, total: f.totalShares, n: f.participants }), T('tm.fair.price', { p: +f.sharePrice.toPrecision(4), q: t.quote, cap: f.capShares }), f.minWalletsLeft > 0 ? T('tm.fair.need', { n: f.minWalletsLeft }) : T('tm.fair.full'), T('tm.fair.open'), f.stale ? T('tm.fair.stale') : T('tm.fair.exit', { p: f.exitFeeNowPct })]}>
      <span className="text-up">{T('tm.fair.short', { sold: compact(f.sold, 1), total: compact(f.totalShares, 1), n: f.participants })}</span>
    </Tip>
  )
}

export function DexStats({ t }: { t: Token }) {
  const liq = t.liqUsd || 0, tx = t.dexTx24
  return (
    <Tip text={<KV rows={[[T('tm.liq'), usd(liq, 1)], [T('tm.vol24'), usd(t.dexVolUsd24 ?? null, 1)], [T('tm.tx24'), tx ? `${tx.buys} / ${tx.sells}` : '—'], ...(t.migratedAt ? [[T('tm.openedAt'), fullTime(t.migratedAt)] as [string, string]] : [])]} />}>
      <span className="flex items-center gap-2 text-t3">
        {liq > 0 && <span>{T('tm.pool')} <span className="text-t2">{usd(liq, 1)}</span></span>}
        {tx && <span><span className="text-up">{compact(tx.buys, 1)}</span>/<span className="text-down">{compact(tx.sells, 1)}</span> {T('tm.txs')}</span>}
      </span>
    </Tip>
  )
}

/** 平台角标的说明（头像右下角），点击打开平台上的代币页 */
export function platformUrl(t: Token) {
  if (t.platform === 'four') return `https://four.meme/token/${t.address}`
  if (t.platform === 'gang') return `https://gang.fun/token/${t.address}`
  return `https://flap.sh/bnb/${t.address}`
}

// ───────────────────────── 追踪 ─────────────────────────

/** 追踪 / 取消追踪一个钱包（创建者、交易者）。追踪后它在内盘的买卖会出现在右侧「钱包追踪」和追踪页 */
export function TrackBtn({ address, name, size = 'sm' }: { address?: string | null; name?: string | null; size?: 'sm' | 'md' }) {
  const tracked = useApp((s) => !!address && s.track.targets.some((x) => lc(x.address) === lc(address)))
  const groups = useApp((s) => s.track.groups)
  const [busy, setBusy] = useState(false)
  if (!address) return null
  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation(); e.preventDefault(); if (busy) return
    setBusy(true)
    try {
      if (tracked) { await api('/api/track/targets', { remove: true, address }); useApp.getState().toast({ kind: 'ok', title: T('tm.untracked') }) }
      else { await api('/api/track/targets', { address, name: name || '', domain: name || null, group: groups[0] || '默认' }); useApp.getState().toast({ kind: 'ok', title: T('tm.trackedName', { name: name || short(address) }), body: T('tm.trackedBody') }) }   // i18n-ignore（「默认」是分组的数据值，不是界面文案）
    } catch (err: any) { useApp.getState().toast({ kind: 'error', title: T('tm.opFailed'), body: err.message }) } finally { setBusy(false) }
  }
  return (
    <Tip text={tracked ? T('tm.trackedTip') : T('tm.trackTip')}>
      <button onClick={toggle} className={clsx('inline-flex items-center gap-0.5 rounded-xs transition-colors', size === 'md' ? 'h-7 px-2 text-sm bg-btn hover:bg-btn-2' : 'h-5 px-1 text-xs hover:bg-btn-2', tracked ? 'text-warn' : 'text-t3 hover:text-t1')}>
        <G n={tracked ? 'Watched16pxBold' : 'Track16pxRegular'} className={size === 'md' ? 'ico' : 'ico-sm'} />{size === 'md' && (tracked ? T('tm.tracked') : T('tm.track'))}
      </button>
    </Tip>
  )
}
