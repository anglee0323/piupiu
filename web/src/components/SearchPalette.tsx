// 全局搜索（按 / 打开，GMGN 的命令面板）：搜名称 / 代号 / 合约；每行可以直接 ⚡ 买入
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Clock, ExternalLink, Loader2, Search, Trash2, Users, Zap } from './gi'
import clsx from 'clsx'
import { useApp } from '../store/app'
import { inPlatforms } from '../lib/format'
import { usePrefs, type PresetId } from '../store/prefs'
import { useUI } from '../store/ui'
import { api } from '../lib/api'
import { age, ageColor, short, usd } from '../lib/format'
import { buy } from '../lib/trade'
import type { Token } from '../lib/types'
import { BnbCoin } from './icons'
import { CopyBtn, TokenAvatar } from './common'
import { volUsd } from '../pages/Trenches'
import { useT, t as T } from '../lib/i18n'

const lc = (a?: string | null) => String(a || '').toLowerCase()

export function SearchPalette() {
  useT()
  const open = useUI((s) => s.searchOpen)
  const setUI = useUI((s) => s.set)
  // 全局快捷键：/ 打开，Esc 关闭
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (e.key === '/' && !typing) { e.preventDefault(); setUI({ searchOpen: true }) }
    }
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k)
  }, [setUI])
  if (!open) return null
  return <Palette onClose={() => setUI({ searchOpen: false })} />
}

function Palette({ onClose }: { onClose: () => void }) {
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [remote, setRemote] = useState<Token | null | 'none' | 'loading'>(null)
  const tokens = useApp((s) => s.tokens)
  const bnbUsd = useApp((s) => s.bnbUsd)
  const platforms = usePrefs((s) => s.platforms)
  const history = usePrefs((s) => s.searchHistory)
  const sb = usePrefs((s) => s.searchBuy)
  const setPrefs = usePrefs((s) => s.set)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])

  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(q.trim())
  const results: Token[] = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return history.map((a) => tokens.get(a)).filter(Boolean) as Token[]
    return [...tokens.values()].filter((t) => inPlatforms(t, platforms) && (t.symbol.toLowerCase().includes(s) || t.name.toLowerCase().includes(s) || lc(t.address).includes(s)))
      .sort((a, b) => Number(b.symbol.toLowerCase() === s) - Number(a.symbol.toLowerCase() === s) || (b.mcapUsd || 0) - (a.mcapUsd || 0)).slice(0, 50)
  }, [q, tokens, history, platforms])

  // 粘贴的合约本地没有：问后端（链上查 Four 盘等）
  useEffect(() => {
    setRemote(null)
    if (!isAddr || tokens.has(lc(q.trim()))) return
    setRemote('loading')
    api<Token>(`/api/lookup/${q.trim()}`).then(setRemote).catch(() => setRemote('none'))
  }, [q]) // eslint-disable-line

  const list = remote && typeof remote === 'object' ? [remote, ...results] : results
  useEffect(() => setSel(0), [q])
  const go = (t: Token) => { onClose(); nav(`/token/${t.address}`) }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((x) => Math.min(list.length - 1, x + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((x) => Math.max(0, x - 1)) }
    else if (e.key === 'Enter' && list[sel]) go(list[sel])
  }

  return (
    <div className="fixed inset-0 z-[90] bg-overlay flex justify-center pt-[10vh]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="pop w-[880px] max-w-[94vw] h-fit max-h-[76vh] flex flex-col overflow-hidden">
        <div className="flex items-center gap-3 px-4 h-14 border-b border-line">
          <Search className="ico-md text-t3" />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder={T('sp.ph')} className="flex-1 text-lg" />
          <kbd className="px-1.5 h-5 grid place-items-center rounded-xs bg-btn-2 text-t3 text-xs font-sans">Esc</kbd>
        </div>
        <div className="flex items-center gap-2 px-4 h-11 border-b border-line">
          <span className="text-sm text-t3">{q ? T('sp.results', { n: list.length }) : T('sp.history')}</span>
          {!q && !!history.length && <button className="icon-btn w-6 h-6" title={T('sp.clear')} onClick={() => setPrefs({ searchHistory: [] })}><Trash2 className="ico-sm" /></button>}
          <div className="flex-1" />
          <label className="input-box h-7 px-2 w-[96px]" title={T('sp.amount')}>
            <Zap className="ico-sm text-t3" />
            <input className="w-full text-sm" defaultValue={sb.amount} onBlur={(e) => setPrefs({ searchBuy: { ...sb, amount: Math.max(0, Number(e.target.value) || 0) } })} />
            <BnbCoin size={12} />
          </label>
          <div className="seg h-7">{([1, 2, 3] as PresetId[]).map((p) => <button key={p} data-on={sb.preset === p} onClick={() => setPrefs({ searchBuy: { ...sb, preset: p } })}>P{p}</button>)}</div>
        </div>
        <div className="scroll-y flex-1 min-h-[120px]">
          {remote === 'loading' && <div className="px-4 py-3 text-t3 flex items-center gap-2"><Loader2 className="ico spin" />{T('sp.querying')}</div>}
          {remote === 'none' && (
            <a href={`https://gmgn.ai/bsc/token/${q.trim()}`} target="_blank" rel="noreferrer" className="mx-4 my-3 flex items-center gap-2 text-t2 hover:text-t1">
              {T('sp.gmgn')}<ExternalLink className="ico-sm" />
            </a>
          )}
          {list.map((t, i) => (
            <div key={t.address} onMouseEnter={() => setSel(i)} onClick={() => go(t)}
              className={clsx('grid items-center gap-4 px-4 h-[72px] cursor-pointer', i === sel ? 'bg-hover-2' : 'hover:bg-hover')}
              style={{ gridTemplateColumns: '48px minmax(0,1fr) 110px 110px 70px 80px' }}>
              <TokenAvatar t={t} size={44} />
              <div className="min-w-0">
                <div className="flex items-center gap-1.5"><span className="text-md font-medium">{t.symbol}</span><span className="text-t3 truncate">{t.name !== t.symbol ? t.name : ''}</span></div>
                <div className="flex items-center gap-2 mt-1 text-sm text-t3">
                  <span className={ageColor(t.createdAt)}>{age(t.createdAt)}</span>
                  <span className="flex items-center">{short(t.address, 4, 4)}<CopyBtn text={t.address} size={10} /></span>
                  {t.buyFeePct != null && <span>{T('sp.tax', { b: +(t.buyFeePct).toFixed(1), s: +(t.sellFeePct ?? 0).toFixed(1) })}</span>}
                  <span>{t.stage === 'curve' ? T('sp.curve', { p: t.progress.toFixed(1) }) : T('sp.launched')}</span>
                </div>
              </div>
              <div className="text-sm"><span className="text-t3">MC </span><span className="text-md font-medium">{usd(t.mcapUsd)}</span></div>
              <div className="text-sm"><span className="text-t3">V </span><span className="text-md font-medium text-vol">{usd(volUsd(t, bnbUsd))}</span></div>
              <div className="text-sm flex items-center gap-1 text-t2"><Users className="ico-sm text-t3" />{t.holders ?? '—'}</div>
              <button onClick={(e) => { e.stopPropagation(); buy(t, sb.amount > 0 ? { amount: sb.amount, preset: sb.preset, via: 'quick' } : { preset: sb.preset, via: 'quick' }) }}
                className="h-8 rounded-sm flex items-center justify-center gap-1 bg-btn-2 text-buy text-sm font-medium hover:bg-buy hover:text-on-accent">
                <Zap className="ico-sm" fill="currentColor" />{T('sp.buy')}
              </button>
            </div>
          ))}
          {!list.length && remote !== 'loading' && remote !== 'none' && (
            <div className="py-12 text-center text-t4 flex flex-col items-center gap-2"><Clock className="ico-md" />{q ? T('sp.noMatch') : T('sp.noHistory')}</div>
          )}
        </div>
      </div>
    </div>
  )
}
