// 一键买卖浮窗（GMGN「一键买卖」）：代币页上的半透明可拖动小窗，8 个买入金额 + 8 个卖出比例，点一下就下单
import { useEffect, useRef, useState } from 'react'
import { GripHorizontal, Pencil, Check, X } from './gi'
import clsx from 'clsx'
import { useApp } from '../store/app'
import { usePrefs, type PresetId } from '../store/prefs'
import { bnb, compact, usd } from '../lib/format'
import { buy, sell } from '../lib/trade'
import type { Token } from '../lib/types'
import { t as T } from '../lib/i18n'

const lc = (a?: string | null) => String(a || '').toLowerCase()

export function QuickPanel({ t }: { t: Token }) {
  const open = usePrefs((s) => s.qbOpen)
  const pos = usePrefs((s) => s.qbPos)
  const qbBuy = usePrefs((s) => s.qbBuy)
  const qbSell = usePrefs((s) => s.qbSell)
  const preset = usePrefs((s) => s.activePreset)
  const set = usePrefs((s) => s.set)
  const bal = useApp((s) => s.holdings?.bnb ?? s.wallets[0]?.bnb ?? 0)
  const r = useApp((s) => s.holdings?.rows.find((x) => lc(x.token) === lc(t.address)))
  const [edit, setEdit] = useState(false)
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!drag) return
    const mv = (e: MouseEvent) => set({ qbPos: { x: Math.max(0, Math.min(innerWidth - 300, e.clientX - drag.dx)), y: Math.max(56, Math.min(innerHeight - 120, e.clientY - drag.dy)) } })
    const up = () => setDrag(null)
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up) }
  }, [drag, set])
  if (!open) return null
  const x = pos.x < 0 ? innerWidth - 300 - 360 : pos.x
  const save = (k: 'qbBuy' | 'qbSell', i: number, v: string) => { const n = Number(v); if (!(n > 0)) return; const arr = [...(k === 'qbBuy' ? qbBuy : qbSell)]; arr[i] = k === 'qbSell' ? Math.min(100, n) : n; set({ [k]: arr } as any) }
  return (
    <div ref={box} className="fixed z-[80] w-[300px] rounded-md border border-line-2 bg-card/90 backdrop-blur-md shadow-2xl select-none" style={{ left: x, top: pos.y }}>
      <div className="h-9 flex items-center gap-2 px-2 border-b border-line cursor-move" onMouseDown={(e) => { const b = box.current!.getBoundingClientRect(); setDrag({ dx: e.clientX - b.left, dy: e.clientY - b.top }) }}>
        <GripHorizontal className="ico-sm text-t4" />
        <span className="text-sm font-medium whitespace-nowrap">{T('qp.title')}</span>
        <span className="text-sm text-t3 truncate">{t.symbol}</span>
        <div className="flex-1" />
        <div className="seg h-6" onMouseDown={(e) => e.stopPropagation()}>{([1, 2, 3] as PresetId[]).map((p) => <button key={p} data-on={preset === p} onClick={() => set({ activePreset: p })}>P{p}</button>)}</div>
        <button onMouseDown={(e) => e.stopPropagation()} className={clsx('icon-btn w-6 h-6', edit && 'text-up')} onClick={() => setEdit(!edit)} title={T('qp.edit')}>{edit ? <Check className="ico-sm" /> : <Pencil className="ico-sm" />}</button>
        <button onMouseDown={(e) => e.stopPropagation()} className="icon-btn w-6 h-6" onClick={() => set({ qbOpen: false })}><X className="ico-sm" /></button>
      </div>
      <div className="p-2 space-y-2">
        <div className="flex items-center justify-between text-xs"><span className="text-buy font-medium">{T('qp.buy')}</span><span className="text-t3">{bnb(bal, 4)} BNB</span></div>
        <div className="grid grid-cols-4 gap-1">
          {qbBuy.map((a, i) => edit
            ? <input key={i} defaultValue={a} onBlur={(e) => save('qbBuy', i, e.target.value)} className="h-8 rounded-xs bg-btn text-center text-sm" />
            : <button key={i} onClick={() => buy(t, { amount: a, preset, via: 'quick' })} className="h-8 rounded-xs bg-buy/8 text-buy text-sm font-medium hover:bg-buy hover:text-on-accent">{a}</button>)}
        </div>
        <div className="flex items-center justify-between text-xs pt-1"><span className="text-down font-medium">{T('qp.sell')}</span><span className="text-t3">{r && r.amount > 0 ? `${compact(r.amount)} · ${usd(r.valueUsd)}` : T('qp.noPos')}</span></div>
        <div className="grid grid-cols-4 gap-1">
          {qbSell.map((p, i) => edit
            ? <input key={i} defaultValue={p} onBlur={(e) => save('qbSell', i, e.target.value)} className="h-8 rounded-xs bg-btn text-center text-sm" />
            : <button key={i} onClick={() => sell(t, p, preset)} className="h-8 rounded-xs bg-down/8 text-down text-sm font-medium hover:bg-down hover:text-white">{p}%</button>)}
        </div>
        {r && (r.pnlUsd != null) && <div className="grid grid-cols-3 text-xs pt-1 border-t border-line">
          <div className="pt-1.5"><div className="text-t3">{T('qp.bought')}</div><div>{usd(r.costUsd)}</div></div>
          <div className="pt-1.5"><div className="text-t3">{T('qp.sold')}</div><div>{usd(r.soldUsd)}</div></div>
          <div className="pt-1.5"><div className="text-t3">{T('qp.pnl')}</div><div className={r.pnlUsd >= 0 ? 'text-up' : 'text-down'}>{r.pnlUsd >= 0 ? '+' : '-'}${Math.abs(r.pnlUsd).toFixed(2)}</div></div>
        </div>}
      </div>
    </div>
  )
}
