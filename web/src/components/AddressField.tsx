// 转出地址输入：NFT 转出地址和代币转出地址共用这一个组件，外观、校验、保存前的确认完全一致。
//   没设置：输入框 + 保存；已设置：完整地址 + 复制 / 修改 / 清除；修改：输入框 + 保存 / 取消。
//   compact：给资产页 / 雷达详情里用的单行小号版本（同样的逻辑和确认，只是短地址、没有边框）。
import { useState } from 'react'
import clsx from 'clsx'
import { useApp } from '../store/app'
import { useUI } from '../store/ui'
import { CopyBtn } from './common'
import { RowBtn } from './SettingsKit'
import { useT } from '../lib/i18n'

type Props = {
  value?: string
  placeholder: string
  /** 保存；空字符串 = 清除。出错直接抛，这里会弹出提示 */
  onSave: (addr: string) => Promise<unknown>
  /** 保存 / 清除前的确认框文案 */
  confirm: { save: string; clear: string }
  compact?: boolean
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export function AddressField({ value, placeholder, onSave, confirm, compact }: Props) {
  const [edit, setEdit] = useState(false)
  const [v, setV] = useState('')
  const [busy, setBusy] = useState(false)
  const t = useT()
  const toast = (title: string, body?: string) => useApp.getState().toast({ kind: 'error', title, body })

  const submit = async (addr: string) => {
    if (addr && !/^0x[0-9a-fA-F]{40}$/.test(addr)) { toast(t('addr.badFormat'), t('addr.badFormatHint')); return }
    if (addr === (value || '')) { setEdit(false); return }
    const ok = await useUI.getState().ask(addr
      ? { title: t('addr.confirmTitle'), okText: t('addr.save'), rows: [[t('addr.address'), addr], [t('addr.note'), confirm.save]] }
      : { title: t('addr.clearTitle'), okText: t('addr.clear'), danger: true, rows: [[t('addr.current'), value || ''], [t('addr.note'), confirm.clear]] })
    if (!ok) return
    setBusy(true)
    try { await onSave(addr); setEdit(false); setV('') } catch (e: any) { toast(t('common.saveFailed'), e.message) }
    setBusy(false)
  }

  if (!edit && value) {
    return compact ? (
      <span className="flex items-center gap-2 text-sm min-w-0">
        <span className="text-t3 flex-none">{t('addr.sendTo')}</span><span className="font-mono text-t1" title={value}>{short(value)}</span>
        <button className="text-xs text-t3 hover:text-t1 flex-none" onClick={() => { setV(value); setEdit(true) }}>{t('addr.edit')}</button>
      </span>
    ) : (
      <div className="flex items-center gap-2 min-w-0">
        <span className="flex-1 min-w-0 h-8 px-3 rounded-sm bg-btn flex items-center font-mono text-sm text-t1 truncate" title={value}>{value}</span>
        <CopyBtn text={value} className="w-8 h-8 flex-none" />
        <RowBtn onClick={() => { setV(value); setEdit(true) }}>{t('addr.edit')}</RowBtn>
        <RowBtn danger disabled={busy} onClick={() => submit('')}>{t('addr.clear')}</RowBtn>
      </div>
    )
  }
  return (
    <div className={clsx('flex items-center gap-2 min-w-0', compact && 'text-sm')}>
      {compact && <span className="text-t3 flex-none">{value ? t('addr.change') : t('addr.set')}</span>}
      <input value={v} onChange={(e) => setV(e.target.value.trim())} onKeyDown={(e) => { if (e.key === 'Enter') submit(v) }} placeholder={placeholder} spellCheck={false}
        className={clsx('input-box px-3 font-mono flex-1 min-w-0', compact ? 'h-7 text-xs max-w-[330px]' : 'h-8 text-sm')} />
      <button onClick={() => submit(v)} disabled={busy || !v} className={clsx('rounded-sm bg-up text-on-accent font-semibold disabled:opacity-40 flex-none', compact ? 'h-7 px-3 text-xs' : 'h-8 px-4 text-sm')}>{t('addr.save')}</button>
      {value && <RowBtn className={compact ? '!h-7 !text-xs' : ''} onClick={() => { setEdit(false); setV('') }}>{t('common.cancel')}</RowBtn>}
    </div>
  )
}
