// 风险提示：涉及交易的产品必须在页面上有风险提示（活动规则与一般合规要求）。
// 底栏常驻一行简短提示，点开是完整说明；不弹窗、不重复打扰，也不做"确认后才可交易"的门槛。
import { useState } from 'react'
import { AlertTriangle } from './gi'
import { Modal } from './common'
import { useT, t as T } from '../lib/i18n'

const POINTS = ['risk.p1', 'risk.p2', 'risk.p3', 'risk.p4']

export function RiskNote() {
  useT()   // 语言切换时重渲染（文案都通过 T 取）
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)} title={T('risk.short')} className="h-6 px-2 flex items-center gap-1.5 rounded-xs text-t3 hover:text-t1 hover:bg-btn flex-none">
        <AlertTriangle className="ico-sm" />{T('risk.tag')}
      </button>
      <Modal open={open} title={T('risk.title')} onClose={() => setOpen(false)}>
          <div className="space-y-2.5 text-sm leading-6 text-t2">
            {POINTS.map((k) => <div key={k} className="flex gap-2"><span className="text-t4 flex-none">·</span><span>{T(k)}</span></div>)}
            <div className="text-xs text-t3 leading-5 pt-1">{T('risk.self')}</div>
          </div>
      </Modal>
    </>
  )
}
