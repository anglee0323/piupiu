// 交易者盈亏抽屉：点成交里的地址，看这个地址在这个币上的买卖、均价、已实现 / 未实现盈亏；可直接加追踪
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { ExternalLink, Eye, Loader2, X } from './gi'
import clsx from 'clsx'
import { useApp } from '../store/app'
import { api } from '../lib/api'
import { age, bnb, compact, fullTime, hms, short, small } from '../lib/format'
import { CopyBtn } from './common'
import { t as T } from '../lib/i18n'

export const useDrawer = create<{ token: string | null; addr: string | null; open: (token: string, addr: string) => void; close: () => void }>((set) => ({
  token: null, addr: null, open: (token, addr) => set({ token, addr }), close: () => set({ token: null, addr: null }),
}))

export function TraderDrawer() {
  const { token, addr, close } = useDrawer()
  const [v, setV] = useState<any>(null)
  const [err, setErr] = useState('')
  const tracked = useApp((s) => !!addr && s.track.targets.some((t) => t.address === addr.toLowerCase()))
  const name = useApp((s) => (addr ? s.names[addr.toLowerCase()] : null))
  useEffect(() => {
    if (!token || !addr) return
    setV(null); setErr('')
    api(`/api/trader/${token}/${addr}`).then(setV).catch((e) => setErr(e.message))
  }, [token, addr])
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [close])
  if (!token || !addr) return null
  const q = v?.qUsd || 0
  const U = (x?: number | null) => (x == null ? '—' : `${x >= 0 ? '' : '-'}$${compact(Math.abs(x * q))}`)
  const track = () => api('/api/track/targets', { address: addr, name: v?.name || name || '', domain: v?.name || name || null }).then(() => useApp.getState().toast({ kind: 'ok', title: T('td.tracked') })).catch((e) => useApp.getState().toast({ kind: 'error', title: T('td.trackFailed'), body: e.message }))
  return (
    <div className="fixed inset-0 z-[95] bg-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <aside className="absolute right-0 top-0 bottom-0 w-[460px] max-w-full bg-card border-l border-line-2 shadow-2xl flex flex-col">
        <div className="h-14 flex-none flex items-center gap-2 px-4 border-b border-line">
          <div className="min-w-0">
            <div className="text-md font-semibold text-warn truncate">{v?.name || name || short(addr)}</div>
            <div className="flex items-center text-xs text-t3">{addr}<CopyBtn text={addr} size={10} /></div>
          </div>
          <div className="flex-1" />
          <button className="icon-btn w-8 h-8" onClick={close}><X className="ico-md" /></button>
        </div>
        <div className="flex-1 min-h-0 scroll-y p-4 space-y-4">
          <div className="flex gap-2">
            <button onClick={track} disabled={tracked} className={clsx('flex-1 h-9 rounded-sm flex items-center justify-center gap-1.5 text-sm font-medium', tracked ? 'bg-btn text-t3' : 'bg-btn-2 text-t1 hover:bg-hover-2')}><Eye className="ico" />{tracked ? T('td.trackedBtn') : T('td.track')}</button>
            <a href={`https://gmgn.ai/bsc/address/${addr}`} target="_blank" rel="noreferrer" className="h-9 px-3 rounded-sm bg-btn flex items-center gap-1 text-sm text-t2 hover:bg-btn-2">GMGN<ExternalLink className="ico-sm" /></a>
            <a href={`https://bscscan.com/address/${addr}`} target="_blank" rel="noreferrer" className="h-9 px-3 rounded-sm bg-btn flex items-center gap-1 text-sm text-t2 hover:bg-btn-2">BscScan<ExternalLink className="ico-sm" /></a>
          </div>
          {err && <div className="text-down text-sm">{err}</div>}
          {!v && !err && <div className="py-10 grid place-items-center"><Loader2 className="ico spin text-t3" /></div>}
          {v && (
            <>
              <div className="rounded-md bg-btn p-4">
                <div className="text-xs text-t3">{T('td.totalPnl', { sym: v.symbol })}</div>
                <div className={clsx('text-2xl font-semibold mt-1', v.total >= 0 ? 'text-up' : 'text-down')}>{U(v.total)} <span className="text-md">{v.pct != null ? `${v.pct >= 0 ? '+' : ''}${v.pct.toFixed(1)}%` : ''}</span></div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {[[T('td.realized'), U(v.realized)], [T('td.unrealized'), U(v.unrealized)], [T('td.buys'), `${U(v.boughtQ)} · ${T('td.n', { n: v.buys })}`], [T('td.sells'), `${U(v.soldQ)} · ${T('td.n', { n: v.sells })}`],
                  [T('td.hold'), `${compact(v.hold)} ${v.symbol}`], [T('td.holdVal'), U(v.holdQ)], [T('td.avgBuy'), v.avgBuy != null ? `${small(v.avgBuy)} ${v.quote}` : '—'], [T('td.firstBuy'), v.firstBuy ? age(v.firstBuy) : '—']].map(([k, val]) => (
                  <div key={k} className="rounded-sm bg-btn px-3 py-2"><div className="text-xs text-t3">{k}</div><div className="text-base font-medium mt-0.5">{val}</div></div>
                ))}
              </div>
              <div>
                <div className="text-sm font-medium mb-2">{T('td.trades')}{!v.complete && <span className="text-t3 font-normal">{T('td.loadingHist')}</span>}</div>
                <div className="tbl-x"><table className="tbl">
                  <thead><tr><th>{T('td.time')}</th><th className="l">{T('td.side')}</th><th>{T('td.amount')}</th><th>{v.quote}</th><th>Tx</th></tr></thead>
                  <tbody>{(v.trades || []).map((x: any) => (
                    <tr key={x.tx + x.side + x.tokens}>
                      <td className="text-t3" title={fullTime(x.ts)}>{Date.now() - x.ts < 86400_000 ? hms(x.ts) : age(x.ts)}</td>
                      <td className={clsx('l', x.side === 'buy' ? 'text-up' : 'text-down')}>{x.side === 'buy' ? T('td.buy') : T('td.sell')}</td>
                      <td>{compact(x.tokens)}</td><td>{bnb(x.bnb)}</td>
                      <td><a className="text-t3 hover:text-t1" href={`https://bscscan.com/tx/${x.tx}`} target="_blank" rel="noreferrer"><ExternalLink className="w-3 h-3 inline" /></a></td>
                    </tr>
                  ))}</tbody>
                </table></div>
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  )
}
