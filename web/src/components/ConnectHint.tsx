// 首次进入、尚未登录时，在右上角「连接钱包」下方显示的引导气泡（不直接弹登录框，由用户自己决定）。
// 「连接钱包」打开扫码登录；「稍后」或关闭按钮记在 data/setup.json（/api/setup dismiss），之后不再显示。
import { useEffect, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useUI } from '../store/ui'
import { useApp } from '../store/app'
import { api } from '../lib/api'
import { useT } from '../lib/i18n'
import { X } from './gi'

const W = 320
export function ConnectHint({ anchor }: { anchor: RefObject<HTMLButtonElement | null> }) {
  const t = useT()
  const show = useUI((s) => s.connectHint)
  const loginOpen = useUI((s) => s.loginOpen)
  const setUI = useUI((s) => s.set)
  const [r, setR] = useState<DOMRect | null>(null)
  useEffect(() => {
    if (!show) return
    const upd = () => setR(anchor.current?.getBoundingClientRect() ?? null)
    upd(); const h = setTimeout(upd, 300)
    addEventListener('resize', upd); return () => { clearTimeout(h); removeEventListener('resize', upd) }
  }, [show, anchor])
  if (!show || loginOpen || !r) return null
  const later = () => { setUI({ connectHint: false }); api('/api/setup', { dismiss: true }).catch(() => {}) }
  const go = () => setUI({ connectHint: false, loginOpen: true, loginSlot: useApp.getState().slots?.primary || 1 })
  const left = Math.max(12, Math.min(r.right - W, innerWidth - W - 12))
  return createPortal(
    <div role="dialog" aria-label={t('hint.title')} className="pop fixed z-[95] p-4 toast-in" style={{ top: r.bottom + 10, left, width: W }}>
      <span className="absolute -top-[7px] w-3 h-3 rotate-45 bg-card border-l border-t border-line-2" style={{ left: Math.min(W - 24, Math.max(12, r.left + r.width / 2 - left - 6)) }} />
      <button className="icon-btn w-6 h-6 absolute right-2.5 top-2.5" aria-label={t('common.close')} title={t('common.close')} onClick={later}><X className="ico-sm" /></button>
      <div className="text-md font-semibold pr-6">{t('hint.title')}</div>
      <div className="text-sm text-t2 leading-6 mt-1.5">{t('hint.body')}</div>
      <div className="flex items-center gap-2 mt-3.5">
        <button onClick={go} className="h-8 px-3.5 rounded-sm bg-buy text-on-accent text-sm font-semibold hover:brightness-110">{t('hint.go')}</button>
        <button onClick={later} className="h-8 px-3 rounded-sm text-sm text-t2 hover:text-t1 hover:bg-btn">{t('hint.later')}</button>
      </div>
    </div>,
    document.body,
  )
}
