// 声音选择（照 GMGN 的 SoundSelectPopoverContent）：一列选项，选中的右侧绿色对勾；
// 鼠标停在某个声音上就试听，点击选中并关闭弹层。弹层挂在 body 上（列容器会裁掉溢出、挤压时还会盖住旁边的控件）
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { Check } from './gi'
import { SOUNDS, cancelPreview, previewSound } from '../lib/sound'
import type { SoundKind } from '../store/prefs'
import { t as T } from '../lib/i18n'

/** 'Off' = 关闭；'default' = 跟随全局（每个钱包单独设置时才有） */
export type SoundValue = SoundKind | 'Off' | 'default'

export function SoundList({ value, onSelect, defaultLabel }: { value: SoundValue; onSelect: (v: SoundValue) => void; defaultLabel?: string }) {
  const item = (v: SoundValue, label: string) => (
    <button key={v} type="button" onClick={() => { cancelPreview(); onSelect(v) }}
      onMouseEnter={() => (v !== 'Off' && v !== 'default' ? previewSound(v) : cancelPreview())} onMouseLeave={cancelPreview}
      className={clsx('w-full h-7 shrink-0 flex items-center justify-between gap-2 px-2.5 text-sm font-medium text-left hover:bg-hover-2 transition-colors', value === v ? 'text-t1' : 'text-t2')}>
      <span className="truncate">{label}</span>
      {value === v && <Check className="w-3 h-3 flex-none text-up" />}
    </button>
  )
  return (
    <div className="flex flex-col max-h-[18rem] overflow-y-auto py-1 [scrollbar-width:thin]">   {/* 约 10 项可见，和 GMGN 一屏的量差不多 */}
      {defaultLabel && item('default', defaultLabel)}
      {item('Off', T('sound.off'))}
      {SOUNDS.map((s) => item(s.id, s.label))}
    </div>
  )
}

/** 带触发按钮的弹层：位置跟着按钮、夹在屏幕内；点外面关闭 */
export function SoundPopover({ trigger, width = 180, children, align = 'right' }: {
  trigger: (p: { open: boolean; toggle: () => void; ref: (el: HTMLButtonElement | null) => void }) => ReactNode
  width?: number; align?: 'left' | 'right'
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement | null>(null)
  const pop = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: PointerEvent) => { const t = e.target as Node; if (!btn.current?.contains(t) && !pop.current?.contains(t)) setOpen(false) }
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', h, true); window.addEventListener('keydown', k)
    return () => { document.removeEventListener('pointerdown', h, true); window.removeEventListener('keydown', k); cancelPreview() }
  }, [open])
  const r = open ? btn.current?.getBoundingClientRect() : null
  const left = r ? Math.max(8, Math.min(align === 'right' ? r.right - width : r.left, innerWidth - width - 8)) : 0
  const below = r ? r.bottom + 4 : 0
  const H = Math.min(innerHeight - 16, 430)   // 弹层大致高度（列表 18rem + 标题 / 音量行）
  const top = r && below + H > innerHeight ? Math.max(8, r.top - 4 - H) : below   // 下面放不下就往上翻
  return (
    <>
      {trigger({ open, toggle: () => setOpen((v) => !v), ref: (el) => { btn.current = el } })}
      {open && createPortal(
        <div ref={pop} className="pop fixed z-[95] overflow-hidden !rounded-[8px]" style={{ left, top, width }}>{children(() => setOpen(false))}</div>,
        document.body)}
    </>
  )
}
