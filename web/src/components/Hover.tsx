// 悬浮弹层：鼠标停在元素上一会儿弹出，移到弹层上不会消失（推文预览卡里可以滚动、点链接）。
// 弹层挂到 body 上（fixed 定位），不会被卡片的 overflow 裁掉；下方放不下就翻到上方。
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'

export function Hover({ content, children, delay = 220, className, popClass, as = 'span', off }: {
  content: () => ReactNode; children: ReactNode; delay?: number; className?: string; popClass?: string; as?: 'span' | 'div'; off?: boolean   // off：不弹（比如这个按钮正好打开了别的面板，提示会压在面板上）
}) {
  const ref = useRef<HTMLElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const show = () => { clearTimeout(timer.current); if (!off) timer.current = window.setTimeout(() => setOpen(true), delay) }
  useEffect(() => { if (off) { clearTimeout(timer.current); setOpen(false); setPos(null) } }, [off])
  const hide = () => { clearTimeout(timer.current); timer.current = window.setTimeout(() => { setOpen(false); setPos(null) }, 140) }
  useEffect(() => () => clearTimeout(timer.current), [])
  useLayoutEffect(() => {
    if (!open || !ref.current || !pop.current) return
    const a = ref.current.getBoundingClientRect(), p = pop.current.getBoundingClientRect()
    let left = Math.min(Math.max(8, a.left + a.width / 2 - p.width / 2), window.innerWidth - p.width - 8)
    let top = a.bottom + 6
    if (top + p.height > window.innerHeight - 8) top = Math.max(8, a.top - p.height - 6)
    if (!isFinite(left)) left = 8
    setPos({ left, top })
  }, [open])
  const Tag = as as any
  return (
    <Tag ref={ref} className={className} onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {open && createPortal(
        <div ref={pop} onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={hide} onClick={(e) => e.stopPropagation()}
          className={clsx('pop fixed z-[200] text-sm text-t1 cursor-default', popClass ?? 'px-2.5 py-2 max-w-[280px]')}
          style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}>
          {content()}
        </div>, document.body)}
    </Tag>
  )
}

/** 纯文字提示（多行用数组） */
export function Tip({ text, children, className, off }: { text: ReactNode | ReactNode[]; children: ReactNode; className?: string; off?: boolean }) {
  return (
    <Hover className={className} delay={150} off={off} content={() => Array.isArray(text)
      ? <div className="space-y-0.5">{text.map((x, i) => <div key={i} className={i ? 'text-t2' : ''}>{x}</div>)}</div>
      : <div className="whitespace-pre-line">{text}</div>}>
      {children}
    </Hover>
  )
}

/** 两列的小表格（提示里用：左边名称灰色，右边数值） */
export function KV({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <div className="grid gap-x-4 gap-y-1" style={{ gridTemplateColumns: 'auto auto' }}>
      {rows.map(([k, v], i) => <div key={i} className="contents"><span className="text-t3">{k}</span><span className="text-right">{v}</span></div>)}
    </div>
  )
}
