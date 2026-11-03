// 在线体验的提示条（官网 /preview/）：说明数据是录制的样本、不能连接钱包；嵌入官网页面时不显示。
// 样式和界面一致（浅色底、细分隔线、绿色主按钮），不用整条黑底
import { useState } from 'react'
import { useT } from '../lib/i18n'
import { EMBED } from '../lib/env'
import { X } from './gi'
import { useUI } from '../store/ui'
import { Modal } from './common'
import { LogoMark } from '../brand'

export const SITE = '/'   // 官网首页（在线体验和官网同一个域名）

export function DemoBar() {
  const t = useT()
  const [open, setOpen] = useState(true)
  if (EMBED || !open) return null
  return (
    <div className="relative h-9 flex-none flex items-center justify-center gap-3 px-10 bg-card border-b border-line text-sm text-t3">
      <span className="h-5 px-1.5 flex items-center rounded-xs bg-up/12 text-up text-xs font-semibold whitespace-nowrap">{t('demo.bar')}</span>
      <span className="hidden md:inline truncate">{t('demo.barNote')}</span>
      <a href={SITE + '#download'} className="h-6 px-2.5 flex items-center rounded-xs bg-up text-on-accent text-xs font-semibold whitespace-nowrap hover:brightness-110">{t('demo.download')}</a>
      <button className="absolute right-3 text-t3 hover:text-t1" aria-label={t('common.close')} onClick={() => setOpen(false)}><X className="ico-sm" /></button>
    </div>
  )
}

/** 在线体验里点了需要钱包的操作（连接钱包、下单、铸造…）：说明这里不能操作，引导下载 */
export function DemoLoginModal() {
  const t = useT()
  const open = useUI((s) => s.loginOpen)
  const setUI = useUI((s) => s.set)
  if (!open) return null
  return (
    <Modal open onClose={() => setUI({ loginOpen: false })} width={420}>
      <div className="flex flex-col items-center text-center gap-3 pt-6">
        <LogoMark size={48} />
        <div className="text-xl font-semibold">{t('demo.title')}</div>
        <div className="text-sm text-t3 leading-6">{t('demo.body')}</div>
        <div className="w-full flex gap-2 pt-2">
          <a href={SITE + '#download'} className="flex-1 h-10 flex items-center justify-center rounded-sm bg-up text-on-accent font-semibold hover:brightness-110">{t('demo.download')}</a>
          <button onClick={() => setUI({ loginOpen: false })} className="flex-1 h-10 rounded-sm bg-btn text-t2 hover:bg-btn-2">{t('demo.continue')}</button>
        </div>
      </div>
    </Modal>
  )
}
