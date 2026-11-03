// 多钱包的钱包标签 + 「选择钱包」弹层（照 GMGN 的多钱包交互，docs/PLAN-MULTI-WALLET.md §3.4）。
// 弹层挂 body（列容器 / 卡片都是 overflow-hidden，写在里面会被裁掉）
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { Check, Plus, RefreshCw } from './gi'
import { useApp } from '../store/app'
import { useUI } from '../store/ui'
import { api } from '../lib/api'
import { bnb, short } from '../lib/format'
import { BnbCoin } from './icons'
import type { SlotView } from '../lib/types'
import { t as T, lz } from '../lib/i18n'

// 槽位颜色固定（W 号是身份，颜色跟着槽位走）
export const SLOT_COLORS = ['#3fb950', '#4c8dff', '#b07df0', '#f0a03c', '#e05a7a', '#3ab8c4', '#8fb040', '#9098a8']
export const slotColor = (slot: number) => SLOT_COLORS[(Math.max(1, slot) - 1) % SLOT_COLORS.length]

/** 钱包标签：W1 / W2…（小方块，带槽位颜色；掉线的划掉） */
export function WalletTag({ slot, dim = false }: { slot: number; dim?: boolean }) {
  const c = slotColor(slot)
  return (
    <span className={clsx('flex-none h-5 min-w-5 px-1 grid place-items-center rounded-[4px] text-[11px] font-bold', dim && 'opacity-40 line-through')}
      style={{ color: c, background: c + '22' }}>W{slot}</span>
  )
}

/** 当前选中的交易钱包（全局，存在后端）：数量、合计余额、选中槽位列表 */
export function useTradeWallets() {
  const slots = useApp((s) => s.slots)
  const setTradeSlots = useApp((s) => s.setTradeSlots)
  const holdings = useApp((s) => s.holdings)
  const selected = slots?.tradeSlots || []
  const bySlot = new Map((slots?.slots || []).map((s) => [s.slot, s]))
  const picked = selected.map((n) => bySlot.get(n)).filter(Boolean) as SlotView[]
  const bal = picked.reduce((a, s) => a + (s.bnb || 0), 0)
  const loggedAll = (slots?.slots || []).filter((s) => s.auth === 'ok')
  return { slots, selected, picked, bal, bySlot, loggedAll, multi: picked.length > 1, setTradeSlots, holdings }
}

/** 「选择钱包」弹层：复选行（标签、名字、短地址、BNB 余额）+ 全选 / 只用主钱包 + 添加钱包 + 钱包管理 */
export function WalletPicker({ trigger, width = 300, align = 'left' }: {
  trigger: (p: { open: boolean; toggle: () => void; ref: (el: HTMLButtonElement | null) => void }) => ReactNode
  width?: number; align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement | null>(null)
  const pop = useRef<HTMLDivElement>(null)
  const { slots, selected, setTradeSlots, loggedAll } = useTradeWallets()
  const setUI = useUI((s) => s.set)
  const nav = useNavigate()
  useEffect(() => {
    if (!open) return
    const h = (e: PointerEvent) => { const t = e.target as Node; if (!btn.current?.contains(t) && !pop.current?.contains(t)) setOpen(false) }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', h, true); window.addEventListener('keydown', k)
    return () => { document.removeEventListener('pointerdown', h, true); window.removeEventListener('keydown', k) }
  }, [open])
  const toggle = (n: number) => {
    const next = selected.includes(n) ? selected.filter((x) => x !== n) : [...selected, n].sort((a, b) => a - b)
    if (!next.length) { useApp.getState().toast({ kind: 'error', title: T('wp.atLeastOne') }); return }
    setTradeSlots(next)
  }
  const r = open ? btn.current?.getBoundingClientRect() : null
  const left = r ? Math.max(8, Math.min(align === 'right' ? r.right - width : r.left, innerWidth - width - 8)) : 0
  const below = r ? r.bottom + 4 : 0
  const H = Math.min(innerHeight - 16, 380)
  const top = r && below + H > innerHeight ? Math.max(8, r.top - 4 - H) : below
  const list = slots?.slots || []
  return (
    <>
      {trigger({ open, toggle: () => setOpen((v) => !v), ref: (el) => { btn.current = el } })}
      {open && createPortal(
        <div ref={pop} className="pop fixed z-[95] overflow-hidden !rounded-[8px] p-3 space-y-2" style={{ left, top, width }}>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-t2">{T('wp.pick')}</span>
            <button className="text-xs text-t3 hover:text-t1" onClick={() => { setOpen(false); nav('/wallets') }}>{T('wp.manage')}</button>
          </div>
          <div className="space-y-1 max-h-[16rem] overflow-y-auto [scrollbar-width:thin]">
            {list.map((s) => {
              const on = selected.includes(s.slot)
              return (
                <button key={s.slot} type="button" onClick={() => (s.auth === 'ok' ? toggle(s.slot) : (setUI({ loginOpen: true, loginSlot: s.slot }), setOpen(false)))}
                  className={clsx('w-full flex items-center gap-2 px-2 h-10 rounded-sm text-left transition-colors', s.auth === 'ok' ? 'hover:bg-hover-2' : 'opacity-60')}>
                  <span className={clsx('w-4 h-4 flex-none rounded-[4px] border grid place-items-center', on ? 'border-transparent' : 'border-line-3')}
                    style={on ? { background: slotColor(s.slot) } : undefined}>{on && <Check className="w-3 h-3 text-[#121212]" />}</span>
                  <WalletTag slot={s.slot} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-medium truncate leading-4">{lz(s.label)}{s.primary && <span className="ml-1 text-[10px] text-t4">{T('wp.primary')}</span>}</span>
                    <span className="block text-xs text-t4 truncate leading-4">{s.address ? short(s.address, 4, 4) : T('wp.notLogged')}</span>
                  </span>
                  {s.auth === 'ok' && s.bnb != null && <span className="flex items-center gap-1 text-sm flex-none"><BnbCoin size={12} />{bnb(s.bnb, 4)}</span>}
                  {s.auth !== 'ok' && <span className="text-xs text-t4 flex-none">{T('wp.login')}</span>}
                </button>
              )
            })}
          </div>
          <div className="flex gap-2">
            <button onClick={() => setTradeSlots((slots?.slots || []).filter((s) => s.auth === 'ok').map((s) => s.slot))}
              className="flex-1 h-7 rounded-xs bg-btn-2 text-xs font-semibold text-t1 hover:bg-hover-2">{T('wp.all', { n: loggedAll.length })}</button>
            <button onClick={() => setTradeSlots([slots?.primary || 1])}
              className="flex-1 h-7 rounded-xs bg-btn-2 text-xs font-semibold text-t1 hover:bg-hover-2">{T('wp.onlyMain')}</button>
          </div>
          <button
            disabled={!slots?.canAdd}
            title={slots?.canAddReason || undefined}
            onClick={() => { setUI({ loginOpen: true, loginSlot: 'add' }); setOpen(false) }}
            className="w-full h-8 rounded-sm bg-btn hover:bg-btn-2 text-sm text-t2 flex items-center justify-center gap-1.5 disabled:opacity-50">
            {slots?.canAdd ? <Plus className="ico-sm" /> : <RefreshCw className="ico-sm" />}{T('wp.add')}{slots && list.length >= 2 ? T('wp.addN', { n: list.length }) : ''}
          </button>
        </div>,
        document.body)}
    </>
  )
}

/** 槽位登录二维码弹窗内容（添加钱包 / 重新登录共用）：从 /api/wallets 接口拿登录进度 */
export function useSlotLogin() {
  const [st, setSt] = useState<{ slot: number; url?: string; code?: string; state?: string; message?: string } | null>(null)
  return { st, setSt }
}

export async function startSlotLogin(slot: number | 'add', cancel = false) {
  return api<any>(slot === 'add' ? '/api/wallets/add' : `/api/wallets/${slot}/login`, cancel ? { cancel: true } : {})
}

/** 任务自己的「下单钱包」多选（跟单 / 狙击用，不跟全局选择联动；方案 §3.11）。
 *  只有一个钱包时只显示 W1 标签，不出现下拉（单钱包零感知） */
/** label：只有一个钱包时显示在标签旁的文字；旁边已经有「下单钱包」之类的标题时传 ''（避免重复） */
export function TaskWallets({ value, onChange, label }: { value: number[]; onChange: (v: number[]) => void; label?: string }) {
  label ??= T('wp.taskLabel')
  const slots = useApp((s) => s.slots)
  const logged = (slots?.slots || []).filter((s) => s.auth === 'ok')
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement | null>(null)
  const pop = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: PointerEvent) => { const t = e.target as Node; if (!btn.current?.contains(t) && !pop.current?.contains(t)) setOpen(false) }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', h, true); window.addEventListener('keydown', k)
    return () => { document.removeEventListener('pointerdown', h, true); window.removeEventListener('keydown', k) }
  }, [open])
  // 保存的槽位里可能有后来掉线的：显示时保留（划掉），触发时会被跳过
  const all = [...new Set([...(value || []), ...logged.map((s) => s.slot)])].sort((a, b) => a - b)
  if (logged.length <= 1 && all.length <= 1) return <span className="flex items-center gap-1.5 text-sm text-t3"><WalletTag slot={all[0] || 1} />{label}</span>
  const bySlot = new Map((slots?.slots || []).map((s) => [s.slot, s]))
  const toggle = (n: number) => {
    const cur = value || []
    const next = cur.includes(n) ? cur.filter((x) => x !== n) : [...cur, n].sort((a, b) => a - b)
    if (!next.length) { useApp.getState().toast({ kind: 'error', title: T('wp.atLeastOne') }); return }
    onChange(next)
  }
  const r = open ? btn.current?.getBoundingClientRect() : null
  const left = r ? Math.max(8, Math.min(r.left, innerWidth - 268)) : 0
  const top = r ? r.bottom + 4 : 0
  return (
    <>
      <button ref={btn} type="button" onClick={() => setOpen((v) => !v)} className="h-8 px-2 rounded-sm bg-btn hover:bg-btn-2 flex items-center gap-1.5 text-sm">
        {(value || []).map((n) => <WalletTag key={n} slot={n} dim={bySlot.get(n)?.auth !== 'ok'} />)}
        <span className="text-t3">{T('wp.nWallets', { n: (value || []).length })}</span>
        <span className="text-t4">▾</span>
      </button>
      {open && createPortal(
        <div ref={pop} className="pop fixed z-[95] overflow-hidden !rounded-[8px] p-3 space-y-2" style={{ left, top, width: 268 }}>
          <div className="text-sm font-medium text-t2">{T('wp.taskPick')}</div>
          <div className="space-y-1">
            {all.map((n) => {
              const s = bySlot.get(n)
              const on = (value || []).includes(n)
              return (
                <button key={n} type="button" disabled={s && s.auth !== 'ok'} onClick={() => toggle(n)}
                  className={clsx('w-full flex items-center gap-2 px-2 h-9 rounded-sm text-left transition-colors', s?.auth === 'ok' ? 'hover:bg-hover-2' : 'opacity-50')}>
                  <span className={clsx('w-4 h-4 flex-none rounded-[4px] border grid place-items-center', on ? 'border-transparent' : 'border-line-3')}
                    style={on ? { background: slotColor(n) } : undefined}>{on && <Check className="w-3 h-3 text-[#121212]" />}</span>
                  <WalletTag slot={n} dim={s && s.auth !== 'ok'} />
                  <span className="flex-1 min-w-0 truncate text-sm">{s?.label || `W${n}`}</span>
                  {s && s.auth !== 'ok' ? <span className="text-xs text-t4">{T('wp.notLogged')}</span> : s?.bnb != null && <span className="text-xs text-t4">{bnb(s.bnb, 3)}</span>}
                </button>
              )
            })}
          </div>
          <div className="text-xs text-t4 leading-4">{T('wp.skipNote')}</div>
        </div>,
        document.body)}
    </>
  )
}
