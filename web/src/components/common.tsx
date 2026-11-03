// 通用小组件：代币头像、复制按钮、弹窗外壳、提示
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Check, Copy, Loader2, X } from './gi'
import { useApp } from '../store/app'
import clsx from 'clsx'
import { imgUrl } from '../lib/api'
import type { Token } from '../lib/types'
import { PlatformBadge } from './icons'
import { t as T } from '../lib/i18n'

/** 代币头像：方形圆角（GMGN 风格），右下角平台角标，下方可选进度条 */
export function TokenAvatar({ t, size = 64, progress, badge = true }: { t: Pick<Token, 'image' | 'symbol' | 'platform'> & { stage?: string }; size?: number; progress?: number | null; badge?: boolean }) {
  const [bad, setBad] = useState(false)
  const src = !bad ? imgUrl(t.image) : null
  const r = size >= 48 ? 6 : 4
  return (
    <span className="relative inline-block flex-none" style={{ width: size, height: size }}>
      <span className="absolute inset-0 overflow-hidden grid place-items-center bg-btn-2 text-t2 font-semibold" style={{ borderRadius: r, fontSize: size * 0.34 }}>
        {src ? <img src={src} alt="" loading="lazy" className="w-full h-full object-cover" onError={() => setBad(true)} /> : (t.symbol || '?').slice(0, 2).toUpperCase()}
      </span>
      {badge && <span className="absolute -right-1 -bottom-1"><PlatformBadge p={t.platform} size={Math.max(12, Math.round(size * 0.24))} /></span>}
      {progress != null && (
        <span className="absolute left-0 right-0 h-[3px] rounded-full bg-line-2 overflow-hidden" style={{ bottom: -7 }}>
          <span className="block h-full rounded-full" style={{ width: `${Math.max(2, Math.min(100, progress))}%`, background: t.stage === 'dex' ? 'var(--color-warn)' : 'var(--color-up)' }} />
        </span>
      )}
    </span>
  )
}

export function CopyBtn({ text, className, size = 12 }: { text: string; className?: string; size?: number }) {
  const [ok, setOk] = useState(false)
  return (
    <button type="button" title={T('common.copy')} className={clsx('icon-btn', className)}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); navigator.clipboard?.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1200) }) }}>
      {ok ? <Check style={{ width: size, height: size }} className="text-up" /> : <Copy style={{ width: size, height: size }} strokeWidth={1.7} />}
    </button>
  )
}

export function Modal({ open, onClose, title, width = 420, children, closable = true }: { open: boolean; onClose: () => void; title?: ReactNode; width?: number; children: ReactNode; closable?: boolean }) {
  useEffect(() => {
    if (!open || !closable) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k)
  }, [open, closable, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-overlay p-4" onMouseDown={(e) => { if (closable && e.target === e.currentTarget) onClose() }}>
      <div className="pop relative w-full max-h-[88vh] flex flex-col" style={{ maxWidth: width }}>
        {title == null && closable && <button className="icon-btn w-7 h-7 absolute right-3 top-3 z-10" aria-label={T('common.close')} title={T('common.close')} onClick={onClose}><X className="ico-md" /></button>}
        {title != null && (
          <div className="flex items-center justify-between px-5 pt-4 pb-3">
            <div className="text-[15px] font-semibold">{title}</div>
            {closable && <button className="icon-btn w-7 h-7" aria-label={T('common.close')} title={T('common.close')} onClick={onClose}><X className="ico-md" /></button>}
          </div>
        )}
        <div className="px-5 pb-5 scroll-y">{children}</div>
      </div>
    </div>
  )
}

/** 元素自身宽度（ResizeObserver）。布局要按「这块区域多宽」变化、又不能用容器查询时用 */
// 用回调 ref：元素晚挂载（比如先显示「加载中」再渲染正文）时也能接上观察
export function useWidth<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)))
    ro.observe(el); return () => ro.disconnect()
  }, [el])
  return [setEl, w] as const
}

/** 后台服务刚启动的头几秒，各个发射台的行情陆续到达（先是历史的，再是最新的，一条一条往外蹦）。
 *  这几秒里先显示「正在同步行情」，等数据到得差不多再整页出现。只在刚启动时出现；在线体验和已经跑了一会儿的后台不受影响 */
export const WARMUP_MS = 12_000
export function WarmGate({ children }: { children: ReactNode }) {
  const startedAt = useApp((s) => s.startedAt)
  const warm = useApp((s) => s.warm)
  const [, tick] = useState(0)
  // 后台说首批行情到齐了就立即显示；否则（旧版后台）按启动后 12 秒
  const left = warm || !startedAt ? 0 : startedAt + WARMUP_MS - Date.now()
  useEffect(() => { if (left <= 0) return; const h = setTimeout(() => tick((x) => x + 1), left + 50); return () => clearTimeout(h) }, [left])
  if (left > 0) return <div className="h-full grid place-items-center text-t3"><span className="flex items-center gap-2"><Loader2 className="ico spin" />{T('warm.syncing')}</span></div>
  return <>{children}</>
}

/** 整数滑动条（min–max，每格 1）：拖动连续变化；下面标出最小、中间、最大 */
export function RangeSlider({ value, min = 1, max, onChange, disabled }: { value: number; min?: number; max: number; onChange: (v: number) => void; disabled?: boolean }) {
  const span = Math.max(1, max - min), v = Math.min(max, Math.max(min, value))
  const marks = max - min >= 2 ? [min, Math.round((min + max) / 2), max] : [min, max]
  return (
    <div className="select-none">
      <input type="range" className="range" min={min} max={max} step={1} value={v} disabled={disabled || max <= min}
        style={{ ['--p' as string]: `${((v - min) / span) * 100}%` }} onChange={(e) => onChange(Number(e.target.value))} />
      <div className="flex justify-between text-xs text-t4 tabular-nums px-0.5">{marks.map((m) => <button key={m} type="button" className="hover:text-t2" onClick={() => onChange(m)} disabled={disabled}>{m}</button>)}</div>
    </div>
  )
}

/** 1 秒刷新一次（相对时间） */
export function useNow(ms = 1000) {
  const [, set] = useState(0)
  useEffect(() => { const t = setInterval(() => set((x) => x + 1), ms); return () => clearInterval(t) }, [ms])
}

/** 数字输入：本地草稿，失焦 / 回车才提交。父组件刷新（轮询、别的输入变化）不会打断输入，
 * 所以不要在渲染函数里定义带输入的子组件（每次渲染都是新组件，输入会被销毁重建丢内容）。
 * zero：留空（= 0）表示「不限制」时右侧显示这段文字，不让人去填 0 */
/** 浮层「点外面关闭」。onClose 通常是父组件里的内联函数、每次渲染都是新的：
 *  以前把它放进 effect 依赖，父组件一刷新（行情 / 雷达每秒推送）effect 就重跑，而延迟挂上的监听器在清理之后才挂上去、再也摘不掉；
 *  浮层关掉后这个泄漏的监听器还在（ref 已经是 null），下次打开时在面板里任何一次点击都会把它关掉。
 *  这里只挂一次，onClose 用 ref 取最新值，延迟挂载的定时器在清理时一并取消。 */
export function useOutsideClose(ref: RefObject<HTMLElement | null>, onClose: () => void, toggle?: RefObject<HTMLElement | null>) {
  const cb = useRef(onClose); cb.current = onClose
  useEffect(() => {
    // toggle：打开它的按钮。点按钮交给按钮自己切换开关，不算「点外面」（否则先被关掉、紧接着又被按钮打开）
    const h = (e: MouseEvent) => { const n = e.target as Node; if (ref.current && !ref.current.contains(n) && !toggle?.current?.contains(n)) cb.current() }
    const t = setTimeout(() => window.addEventListener('mousedown', h))
    return () => { clearTimeout(t); window.removeEventListener('mousedown', h) }
  }, [ref, toggle])
}

export function NumField({ value, onCommit, label, unit, zero, prefix, align = 'left', w = 'w-full', h = 'h-8', placeholder }: {
  value: number; onCommit: (v: number) => void; label?: string; unit?: string; zero?: string; prefix?: string; align?: 'left' | 'right'; w?: string; h?: string; placeholder?: string
}) {
  const [draft, setDraft] = useState(value ? String(value) : '')
  const [focus, setFocus] = useState(false)
  useEffect(() => { if (!focus) setDraft(value ? String(value) : '') }, [value, focus])
  const commit = () => {
    const v = Number(draft)
    setDraft(isFinite(v) && v ? String(v) : '')
    onCommit(isFinite(v) ? v : 0)
  }
  const input = (
    <span className={`input-box ${h} px-2 ${w}`}>
      {prefix && <span className="text-t3">{prefix}</span>}
      <input inputMode="decimal" placeholder={placeholder ?? (zero ? zero : '0')} value={draft}
        onChange={(e) => { const v = e.target.value.replace(/[^\d.]/g, ''); setDraft(v.indexOf('.') >= 0 ? v.slice(0, v.indexOf('.') + 1) + v.slice(v.indexOf('.') + 1).replace(/\./g, '') : v) }}
        onFocus={() => setFocus(true)} onBlur={() => { setFocus(false); commit() }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        className={`flex-1 text-sm ${align === 'right' ? 'text-right' : ''}`} />
      {(zero ? (value ? unit : zero) : unit) && <span className={zero && !value ? 'text-t2 text-xs whitespace-nowrap' : 'text-t3 text-xs whitespace-nowrap'}>{zero ? (value ? unit : zero) : unit}</span>}
    </span>
  )
  return label
    ? <label className="flex flex-col gap-1"><span className="text-xs text-t3">{label}</span>{input}</label>
    : input
}

export const Dot = ({ ok }: { ok: boolean | null }) => (
  <span className={clsx('inline-block w-[7px] h-[7px] rounded-full', ok == null ? 'bg-t4' : ok ? 'bg-up' : 'bg-down')} />
)

/** 数值在左，单位在框内右侧（和 GMGN 一样，一整块，没有边框）；0 表示「没有这个限制」时用 zeroLabel */
export function NumBox({ value, onSave, unit, min = 0, max = Infinity, w = 'w-[96px]', zeroLabel }: { value: number; onSave: (v: number) => void; unit: string; min?: number; max?: number; w?: string; zeroLabel?: string }) {
  // zeroLabel：0 表示「没有这个限制」时，框里留空、右侧显示该文字（比如「不限制」），而不是让人去填一个 0
  const show = (n: number) => (zeroLabel && n === 0 ? '' : String(n))
  const [v, setV] = useState(show(value))
  useEffect(() => setV(show(value)), [value])   // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => {
    if (zeroLabel && v.trim() === '') { if (value !== 0) onSave(0); return }
    const n = Number(v); if (isFinite(n) && n >= min && n <= max) onSave(n); else setV(show(value))
  }
  const empty = !!zeroLabel && (v.trim() === '' || Number(v) === 0)
  return (
    <label className={clsx('h-8 px-2.5 flex items-center gap-1 rounded-sm bg-btn focus-within:ring-1 focus-within:ring-line-3', w)}>
      <input value={v} inputMode="decimal" onChange={(e) => setV(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        className="w-full min-w-0 bg-transparent text-base" />
      <span className={clsx('text-sm flex-none', empty ? 'text-t2' : 'text-t3')}>{empty ? zeroLabel : unit}</span>
    </label>
  )
}
