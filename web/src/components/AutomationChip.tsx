// 底栏「自动化」：列出全部会自动执行交易或转账的功能及其状态（运行中 / 未开启）。只读汇总，开关在各功能页面。
// 按钮本身和底栏其他按钮一样不亮（数量只用灰字）；弹层里的行用设置弹窗同一套 Row / Section / RowBtn。
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { api } from '../lib/api'
import { useApp } from '../store/app'
import { useUI } from '../store/ui'
import { useOutsideClose } from './common'
import { Zap } from './gi'
import { Section, Rows, Row, RowBtn, Tag } from './SettingsKit'
import { useT } from '../lib/i18n'
import { usePrefs } from '../store/prefs'

type Item = { key: string; label: string; to: string | null; on: boolean; about: string; detail: string }

/** 没有独立页面的（自动领取 / 自动转出）去设置里的「自动化与转出」页签 */
const inSettings = (k: string) => k === 'claim' || k === 'send'

export function AutomationChip() {
  const nav = useNavigate()
  const t = useT()
  const live = useApp((s) => s.mode === 'live')
  const [items, setItems] = useState<Item[] | null>(null)
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const lang = usePrefs((s) => s.lang)
  const load = () => api<{ items: Item[] }>(`/api/automation?lang=${lang}`).then((d) => setItems(d.items)).catch(() => {})
  useEffect(() => { load(); const h = setInterval(load, 10_000); return () => clearInterval(h) }, [lang])   // eslint-disable-line react-hooks/exhaustive-deps
  useOutsideClose(pop, () => setOpen(false), btn)
  if (!live) return null
  const n = items?.filter((i) => i.on).length ?? 0
  const r = btn.current?.getBoundingClientRect()
  const manage = (i: Item) => {
    setOpen(false)
    if (inSettings(i.key) || !i.to) useUI.getState().set({ settingsOpen: true, settingsTab: 'auto' })
    else nav(i.to)
  }
  return (
    <>
      <button ref={btn} onClick={() => { setOpen((o) => !o); if (!open) load() }} title={t('auto.tip')}
        className={clsx('h-6 px-2 flex items-center gap-1.5 rounded-xs transition-colors', open ? 'bg-btn-2 text-t1' : 'text-t2 hover:text-t1 hover:bg-btn')}>
        <Zap className="ico" />{t('auto.title')}{n > 0 && <span className="text-t3">{n}</span>}
      </button>
      {open && createPortal(
        <div ref={pop} style={{ left: Math.max(8, r?.left ?? 8), bottom: innerHeight - (r?.top ?? innerHeight) + 6, width: 380 }} className="pop fixed z-[90] p-4">
          <Section title={t('auto.title')} hint={t('auto.hint')}>
            <Rows>
              {(items || []).map((i) => (
                <Row key={i.key} label={i.label} tag={<Tag tone={i.on ? 'warn' : 'dim'}>{i.on ? t('auto.running') : t('auto.off')}</Tag>}
                  hint={<>{i.about}{i.on && i.detail ? <span className="block text-t2">{i.detail}</span> : null}</>}>
                  <RowBtn onClick={() => manage(i)}>{t('auto.manage')}</RowBtn>
                </Row>
              ))}
            </Rows>
          </Section>
        </div>, document.body)}
    </>
  )
}
