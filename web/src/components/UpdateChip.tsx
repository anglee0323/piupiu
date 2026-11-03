// 更新（只在桌面版出现）。下载、验签、退回都在启动器（desktop/main.cjs、updater.cjs），这里只显示和确认：
//   右下角：正在下载时显示百分比；下好后「新版本 x.y.z · 重启更新」（内核）/「新版客户端 · 安装」（Windows）/「· 去下载」（Mac，未签名不能自动替换）
//   下好后右下角弹一张卡片（不挡操作，同一个版本只弹一次；点「稍后」后右下角的入口还在）
//   设置 → 外观 →「版本与更新」：当前版本 + 「检查更新」（外壳 0.1.9 起）
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import { api } from '../lib/api'
import { useApp } from '../store/app'
import { useUI } from '../store/ui'
import { usePrefs } from '../store/prefs'
import { RefreshCw, X, Loader2 } from './gi'
import { useT, t as T } from '../lib/i18n'

export type AppInfo = {
  app: boolean; platform: string; coreVersion: string; shellVersion: string | null
  update: {
    coreReady: string | null; coreNotes?: string; shellNeeded?: string
    shell: { version: string; page: string; action: 'install' | 'download'; ready?: boolean; notes?: string } | null
    downloading?: { kind: 'core' | 'shell'; version: string; got: number; total: number | null } | null
    checking?: boolean; checkedAt?: number | null; error?: string | null
  } | null
}

// 一个轮询给右下角、卡片、设置页共用：正在检查 / 下载时每 1.5 秒，平时每 30 秒
const useInfo = create<{ v: AppInfo | null; load: () => Promise<void> }>((set) => ({
  v: null,
  load: () => api<AppInfo>('/api/app').then((v) => set({ v })).catch(() => {}),
}))
let polling = false
function usePoll() {
  const v = useInfo((s) => s.v)
  useEffect(() => {
    if (polling) return
    polling = true
    let h: ReturnType<typeof setTimeout>
    const tick = async () => { await useInfo.getState().load(); const u = useInfo.getState().v?.update; h = setTimeout(tick, u?.downloading || u?.checking ? 1500 : 30_000) }
    tick()
    return () => { clearTimeout(h); polling = false }
  }, [])
  return v
}
export const useAppInfo = () => useInfo((s) => s.v)
export const reloadAppInfo = () => useInfo.getState().load()

const pct = (d: NonNullable<NonNullable<AppInfo['update']>['downloading']>) => (d.total ? Math.min(99, Math.floor((d.got / d.total) * 100)) : null)

async function restartCore(v: AppInfo) {
  const u = v.update!
  const lang = usePrefs.getState().lang
  const ok = await useUI.getState().ask({ title: T('upd.coreTitle', { v: u.coreReady }), okText: T('upd.restart'), rows: [[T('upd.current'), v.coreVersion], [T('upd.new'), u.coreReady!], ...(u.coreNotes && lang !== 'en' ? [[T('upd.notes'), u.coreNotes] as [string, string]] : []), [T('upd.note'), T('upd.coreNote')]] })
  if (!ok) return
  const toast = useApp.getState().toast
  try { await api('/api/app/restart', {}); toast({ kind: 'info', title: T('upd.restarting') }) } catch (e: any) { toast({ kind: 'error', title: T('upd.restartFailed'), body: e.message }) }
}
async function installShell(v: AppInfo) {
  const s = v.update!.shell!
  const ok = await useUI.getState().ask({ title: T('upd.shellTitle', { v: s.version }), okText: T('upd.install'), rows: [[T('upd.current'), v.shellVersion || '—'], [T('upd.new'), s.version], [T('upd.note'), T('upd.shellNote')]] })
  if (ok) { try { await api('/api/app/install-shell', {}) } catch (e: any) { useApp.getState().toast({ kind: 'error', title: T('upd.installFailed'), body: e.message }) } }
}

/** 现在有什么可以做：内核优先（重启几秒），其次客户端（Windows 安装 / Mac 去下载） */
function readyItem(v: AppInfo | null) {
  const u = v?.update
  if (!v?.app || !u) return null
  if (u.coreReady) return { key: `core:${u.coreReady}`, kind: 'core' as const, version: u.coreReady, notes: u.coreNotes }
  const s = u.shell
  if (s?.action === 'install' && s.ready) return { key: `shell:${s.version}`, kind: 'install' as const, version: s.version, notes: s.notes }
  if (s?.action === 'download') return { key: `shell:${s.version}`, kind: 'download' as const, version: s.version, notes: s.notes, page: s.page }
  return null
}

const chipCls = 'h-6 px-2 flex items-center gap-1.5 rounded-xs text-t2 hover:text-t1 hover:bg-btn'

export function UpdateChip() {
  const t = useT()
  const v = usePoll()
  if (!v?.app || !v.update) return null
  const u = v.update
  const r = readyItem(v)
  const chip = (() => {
    if (r?.kind === 'core') return <button onClick={() => restartCore(v)} className={chipCls}><RefreshCw className="ico" />{t('upd.coreChip', { v: r.version })}</button>
    if (u.downloading) {
      const p = pct(u.downloading)
      return <span className="h-6 px-2 flex items-center gap-1.5 text-t3" title={t('upd.dlTip')}><Loader2 className="ico spin" />{t(u.downloading.kind === 'core' ? 'upd.dlCore' : 'upd.dlShell', { p: p ?? '…' })}</span>
    }
    if (r?.kind === 'install') return <button onClick={() => installShell(v)} className={chipCls}><RefreshCw className="ico" />{t('upd.shellChip', { v: r.version })}</button>
    if (r?.kind === 'download') return <a href={r.page} target="_blank" rel="noreferrer" title={t('upd.pageTip')} className={chipCls}><RefreshCw className="ico" />{t('upd.shellLink', { v: r.version })}</a>
    return null
  })()
  return <>{chip}<ReadyCard v={v} /></>
}

/** 下好后的提示卡片：右下角、底栏上方，不挡操作；同一版本只弹一次（记在本机） */
function ReadyCard({ v }: { v: AppInfo }) {
  const t = useT()
  const lang = usePrefs((s) => s.lang)
  const r = readyItem(v)
  const [seen, setSeen] = useState(() => { try { return localStorage.getItem('upd-seen') || '' } catch { return '' } })
  if (!r || seen === r.key) return null
  const close = () => { try { localStorage.setItem('upd-seen', r.key) } catch { /* 隐私模式 */ } setSeen(r.key) }
  const go = () => { close(); if (r.kind === 'core') restartCore(v); else if (r.kind === 'install') installShell(v); else window.open(r.page, '_blank', 'noreferrer') }
  const title = r.kind === 'core' ? t('upd.readyCore', { v: r.version }) : r.kind === 'install' ? t('upd.readyShell', { v: r.version }) : t('upd.readyMac', { v: r.version })
  const body = r.kind === 'core' ? t('upd.coreNote') : r.kind === 'install' ? t('upd.shellNote') : t('upd.macNote')
  return createPortal(
    <div className="pop fixed right-3 bottom-[44px] z-[60] w-[360px] p-3 space-y-2" role="dialog" aria-label={title}>
      <div className="flex items-start gap-2.5">
        <span className="w-7 h-7 rounded-full grid place-items-center flex-none bg-up/14 text-up"><RefreshCw className="ico" /></span>
        <div className="flex-1 min-w-0 text-base font-medium leading-7">{title}</div>
        <button className="icon-btn w-6 h-6 -mt-0.5 -mr-1 flex-none" aria-label={t('upd.later')} onClick={close}><X className="ico-sm" /></button>
      </div>
      <div className="pl-[38px] space-y-1">
        {r.notes && lang !== 'en' && <div className="text-sm text-t2 leading-5">{r.notes}</div>}
        <div className="text-xs text-t3 leading-5">{body}</div>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button className="h-8 px-3 rounded-sm bg-btn hover:bg-btn-2 text-sm text-t2" onClick={close}>{t('upd.later')}</button>
        <button className="h-8 px-3 rounded-sm bg-buy text-on-accent text-sm font-semibold hover:brightness-110" onClick={go}>{r.kind === 'core' ? t('upd.restart') : r.kind === 'install' ? t('upd.install') : t('upd.download')}</button>
      </div>
    </div>,
    document.body,
  )
}

/** 设置 → 外观 →「版本与更新」里的内容（只在桌面版显示） */
export function UpdateSettings() {
  const t = useT()
  const v = usePoll()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<'' | 'latest' | 'found' | 'failed'>('')
  if (!v?.app) return null
  const bridge = (window as any).piupiuApp as { checkUpdates: () => Promise<any> } | undefined
  const u = v.update
  const check = async () => {
    if (!bridge) return
    setBusy(true); setResult('')
    try {
      const st = await bridge.checkUpdates()
      await reloadAppInfo()
      setResult(st?.error ? 'failed' : st?.coreReady || st?.shell || st?.downloading ? 'found' : 'latest')
    } catch { setResult('failed') } finally { setBusy(false) }
  }
  const state = u?.downloading ? t(u.downloading.kind === 'core' ? 'upd.dlCore' : 'upd.dlShell', { p: pct(u.downloading) ?? '…' })
    : busy || u?.checking ? t('upd.checking')
    : result === 'failed' || u?.error ? t('upd.checkFailed')
    : readyItem(v) ? t('upd.found', { v: readyItem(v)!.version })
    : result === 'latest' ? t('upd.latest') : ''
  return (
    <div className="flex items-center gap-4 flex-wrap">
      <div className="text-sm text-t2 space-y-0.5">
        <div>{t('upd.shellVer')} <span className="text-t1 font-medium">{v.shellVersion || '—'}</span><span className="text-t4 mx-2">·</span>{t('upd.coreVer')} <span className="text-t1 font-medium">{v.coreVersion}</span></div>
        {state && <div className="text-xs text-t3" title={u?.error || undefined}>{state}</div>}
      </div>
      {bridge && <button className="h-8 px-3 rounded-sm bg-btn hover:bg-btn-2 text-sm text-t1 disabled:opacity-50 flex items-center gap-1.5" disabled={busy || !!u?.checking} onClick={check}>{(busy || u?.checking) && <Loader2 className="ico spin" />}{t('upd.check')}</button>}
    </div>
  )
}
