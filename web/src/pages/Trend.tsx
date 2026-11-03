// 热门（GMGN「热门」）：排行表，按涨跌 / 成交额 / 持有人 / 市值排序，每行快买
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowDown, ArrowUp, Zap } from '../components/gi'
import clsx from 'clsx'
import { useApp } from '../store/app'
import { usePrefs, type PresetId } from '../store/prefs'
import { age, ageColor, compact, pct, short, usd, inPlatforms } from '../lib/format'
import { buy } from '../lib/trade'
import type { Token } from '../lib/types'
import { CopyBtn, TokenAvatar, useNow } from '../components/common'
import { BnbCoin } from '../components/icons'
import { Tip } from '../components/Hover'
import { Socials, TaxChip } from '../components/TokenMeta'
import { volUsd } from './Trenches'
import { t as T, useT } from '../lib/i18n'

type SortKey = 'm5' | 'h1' | 'h24' | 'vol' | 'mc' | 'holders' | 'txs' | 'age' | 'progress'
const lc = (a?: string | null) => String(a || '').toLowerCase()
/** 涨跌：已开盘的用外盘数据（DexScreener），内盘用 K 线算 */
const chgOf = (t: Token, k: 'm5' | 'h1' | 'h24') => (t.stage === 'dex' ? t.dexChg?.[k] ?? t.chg?.[k] : t.chg?.[k]) ?? null
/** 交易笔数：已开盘的看 24 小时外盘，内盘看累计 */
const txOf = (t: Token) => (t.stage === 'dex' && t.dexTx24 ? { b: t.dexTx24.buys, s: t.dexTx24.sells } : { b: t.buys || 0, s: t.sells || 0 })

export function TrendPage() {
  useT()
  useNow(3000)
  const tokens = useApp((s) => s.tokens)
  const bnbUsd = useApp((s) => s.bnbUsd)
  const blocklist = useApp((s) => s.blocklist)
  const platforms = usePrefs((s) => s.platforms)
  const sb = usePrefs((s) => s.searchBuy)
  const setPrefs = usePrefs((s) => s.set)
  const nav = useNavigate()
  const [stage, setStage] = useState<'all' | 'curve' | 'dex'>('all')
  const [sort, setSort] = useState<{ k: SortKey; desc: boolean }>({ k: 'vol', desc: true })
  const val = (t: Token, k: SortKey): number => {
    switch (k) {
      case 'm5': return chgOf(t, 'm5') ?? -Infinity
      case 'h1': return chgOf(t, 'h1') ?? -Infinity
      case 'h24': return chgOf(t, 'h24') ?? -Infinity
      case 'vol': return volUsd(t, bnbUsd)
      case 'mc': return t.mcapUsd || 0
      case 'holders': return t.holders || 0
      case 'txs': return txOf(t).b + txOf(t).s
      case 'age': return -(t.stage === 'dex' && t.migratedAt ? t.migratedAt : t.createdAt)
      case 'progress': return t.stage === 'curve' ? t.progress : 100 + (t.liqUsd || 0) / 1e9
    }
  }
  const rows = useMemo(() => [...tokens.values()]
    .filter((t) => inPlatforms(t, platforms) && (stage === 'all' || t.stage === stage) && !blocklist.tokens[lc(t.address)])
    .sort((a, b) => (sort.desc ? val(b, sort.k) - val(a, sort.k) : val(a, sort.k) - val(b, sort.k)))
    .slice(0, 150), [tokens, platforms, stage, sort, bnbUsd, blocklist]) // eslint-disable-line
  const H = ({ k, children, className }: { k: SortKey; children: React.ReactNode; className?: string }) => (
    <th className={clsx('cursor-pointer select-none hover:text-t1', className)} onClick={() => setSort({ k, desc: sort.k === k ? !sort.desc : true })}>
      <span className="inline-flex items-center gap-0.5">{children}{sort.k === k && (sort.desc ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" />)}</span>
    </th>
  )
  const chg = (v?: number | null) => <span className={v == null ? 'text-t4' : v >= 0 ? 'text-up' : 'text-down'}>{v == null ? '—' : pct(v, 1)}</span>
  return (
    <div className="h-full flex flex-col min-h-0 p-1.5">
      <div className="flex-1 min-h-0 flex flex-col rounded-md bg-card border border-line overflow-hidden">
        <div className="h-12 flex-none flex items-center gap-4 px-4 border-b border-line">
          <span className="text-md font-medium">{T('trend.title')}</span>
          <div className="seg h-7">{(['all', 'curve', 'dex'] as const).map((k) => <button key={k} data-on={stage === k} onClick={() => setStage(k)}>{T('trend.' + k)}</button>)}</div>
          <div className="flex-1" />
          <Tip text={[T('tr.qbAmt'), T('tr.qbAmtHint')]}><label className="input-box h-7 px-2 w-[90px] gap-1"><BnbCoin size={12} /><input className="w-full text-sm" defaultValue={sb.amount || ''} placeholder="0" onBlur={(e) => setPrefs({ searchBuy: { ...sb, amount: Math.max(0, Number(e.target.value) || 0) } })} /></label></Tip>
          <div className="seg h-7">{([1, 2, 3] as PresetId[]).map((p) => <button key={p} data-on={sb.preset === p} onClick={() => setPrefs({ searchBuy: { ...sb, preset: p } })}>P{p}</button>)}</div>
        </div>
        <div className="flex-1 min-h-0 scroll-y">
          <div className="tbl-x"><table className="tbl">
            <thead><tr>
              <th className="l">{T('trend.th.coin')}</th><H k="age">{T('trend.th.age')}</H><H k="mc">{T('trend.th.mc')}</H><H k="vol">{T('trend.th.vol')}</H><H k="txs">{T('trend.th.txs')}</H><H k="holders">{T('trend.th.holders')}</H>
              <H k="progress">{T('trend.th.progress')}</H><H k="m5">5m</H><H k="h1">1h</H><H k="h24">24h</H><th>{T('trend.th.tax')}</th><th></th>
            </tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.address} className="cursor-pointer" onClick={() => nav(`/token/${t.address}`)}>
                  <td className="l"><span className="flex items-center gap-2.5"><TokenAvatar t={t} size={32} /><span className="min-w-0"><span className="block text-base font-medium max-w-[180px] truncate">{t.symbol} <span className="text-t3 font-normal">{t.name !== t.symbol ? t.name : ''}</span></span><span className="flex items-center gap-2 text-xs text-t3 h-4">{short(t.address, 4, 4)}<CopyBtn text={t.address} size={10} /><Socials t={t} size={12} /></span></span></span></td>
                  <td className={ageColor(t.stage === 'dex' && t.migratedAt ? t.migratedAt : t.createdAt)}>{age(t.stage === 'dex' && t.migratedAt ? t.migratedAt : t.createdAt)}</td>
                  <td className="font-medium">{usd(t.mcapUsd)}</td>
                  <td className="text-vol">{usd(volUsd(t, bnbUsd))}</td>
                  <td><span className="text-up">{compact(txOf(t).b, 1)}</span><span className="text-t4">/</span><span className="text-down">{compact(txOf(t).s, 1)}</span></td>
                  <td>{t.holders ? compact(t.holders, 1) : '—'}</td>
                  <td className={t.stage === 'curve' ? 'text-up' : 'text-t2'}>{t.stage === 'curve' ? `${t.progress.toFixed(1)}%` : usd(t.liqUsd || 0, 1)}</td>
                  <td>{chg(chgOf(t, 'm5'))}</td><td>{chg(chgOf(t, 'h1'))}</td><td>{chg(chgOf(t, 'h24'))}</td>
                  <td className="text-t2" onClick={(e) => e.stopPropagation()}><span className="inline-flex justify-end"><TaxChip t={t} /></span></td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {t.gangFair && t.stage === 'curve'
                      ? <Tip text={[T('tr.fairTip1'), T('tr.fairTip2')]}><a href={`https://gang.fun/token/${t.address}`} target="_blank" rel="noreferrer" className="h-7 px-2.5 rounded-sm inline-flex items-center gap-1 bg-btn-2 text-t1 text-sm font-medium hover:bg-hover-2">{T('tr.subscribe')}</a></Tip>
                      : <button onClick={() => buy(t, sb.amount > 0 ? { amount: sb.amount, preset: sb.preset, via: 'quick' } : { preset: sb.preset, via: 'quick' })}
                      className="h-7 px-2.5 rounded-sm inline-flex items-center gap-1 bg-btn-2 text-buy text-sm font-medium hover:bg-buy hover:text-on-accent"><Zap className="ico-sm" fill="currentColor" />{sb.amount > 0 ? sb.amount : '1%'}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      </div>
    </div>
  )
}
