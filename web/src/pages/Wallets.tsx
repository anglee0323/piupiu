// 钱包管理（docs/PLAN-MULTI-WALLET.md §3.9）：左边钱包列表，右边选中钱包的详情（安全设置只读、备注、主钱包、登录 / 移除）
import { useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { ChevronRight, LogIn, Power, Plus, RefreshCw, Star, Trash2 } from '../components/gi'
import { useApp } from '../store/app'
import { useUI } from '../store/ui'
import { api } from '../lib/api'
import { bnb, short } from '../lib/format'
import { BnbCoin } from '../components/icons'
import { CopyBtn, Dot } from '../components/common'
import { WalletTag } from '../components/WalletPicker'
import { WalletSettings } from '../components/TopBar'
import { authText } from '../lib/authText'
import { useT, t as T, lz } from '../lib/i18n'

export function WalletsPage() {
  useT()
  const slots = useApp((s) => s.slots)
  const setUI = useUI((s) => s.set)
  const [sel, setSel] = useState<number | null>(null)
  const list = slots?.slots || []
  const cur = list.find((s) => s.slot === (sel ?? list[0]?.slot)) || null
  const toast = (kind: 'ok' | 'error', title: string, body?: string) => useApp.getState().toast({ kind, title, body })

  const rename = async (s: any, label: string) => {
    const v = label.trim().slice(0, 40)
    if (v === (s.customName ? s.label : '')) return
    try { await api(`/api/wallets/${s.slot}`, { label: v }); toast('ok', s.customName ? T('wl.renamed') : T('wl.noteSaved'), v ? `W${s.slot} → ${v}` : T('wl.cleared', { n: s.slot })) }
    catch (e: any) { toast('error', T('wl.saveFailed'), e.message) }
  }
  const setPrimary = async (s: any) => {
    const ok = await useUI.getState().ask({ title: T('wl.primaryTitle'), rows: [[T('wl.primary'), `W${s.slot} ${lz(s.label)}`]], body: T('wl.primaryBody'), okText: T('wl.primaryTitle') })
    if (!ok) return
    try { await api(`/api/wallets/${s.slot}`, { primary: true }); toast('ok', T('wl.primaryDone', { n: s.slot })) } catch (e: any) { toast('error', T('wl.setFailed'), e.message) }
  }
  const logout = async (s: any) => {
    const ok = await useUI.getState().ask({ title: T('wl.logoutTitle', { n: s.slot }), rows: [[T('wl.wallet'), `W${s.slot} ${lz(s.label)}`]], body: T('wl.logoutBody'), okText: T('wl.logout'), danger: true })
    if (!ok) return
    try { await api(`/api/wallets/${s.slot}/logout`); toast('ok', T('wl.loggedOut', { n: s.slot })) } catch (e: any) { toast('error', T('wl.logoutFailed'), e.message) }
  }
  const remove = async (s: any) => {
    const ok = await useUI.getState().ask({
      title: T('wl.removeTitle', { n: s.slot }), danger: true, okText: T('wl.removeOk'), order: false,
      rows: [[T('wl.wallet'), `W${s.slot} ${lz(s.label)}`], [T('wl.address'), s.address ? short(s.address, 6, 6) : '—']],
      body: T('wl.removeBody'),
    })
    if (!ok) return
    try { await api(`/api/wallets/${s.slot}`, {}, { method: 'DELETE' }); toast('ok', T('wl.removed', { n: s.slot })); setSel(null) } catch (e: any) { toast('error', T('wl.removeFailed'), e.message) }
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-[980px] mx-auto space-y-4">
        <div className="flex items-center gap-3">
          <Link to="/" className="icon-btn w-9 h-9" title={T('wl.back')}><ChevronRight className="ico-md rotate-180" /></Link>
          <div className="text-xl font-semibold">{T('wl.title')}</div>
          <span className="text-sm text-t3">{T('wl.count', { a: list.filter((s) => s.auth === 'ok').length, b: list.length })}</span>
          <div className="flex-1" />
          <button disabled={!slots?.canAdd} title={slots?.canAddReason || undefined}
            onClick={() => setUI({ loginOpen: true, loginSlot: 'add' })}
            className="h-9 px-3 flex items-center gap-1.5 rounded-sm bg-up text-on-accent text-md font-semibold hover:brightness-110 disabled:opacity-50">
            {slots?.canAdd ? <Plus className="ico" /> : <RefreshCw className="ico" />}{T('wl.add')}
          </button>
        </div>

        <div className="flex flex-col md:flex-row gap-4 items-start">
          {/* 列表 */}
          <div className="w-full md:w-[380px] flex-none rounded-sm border border-line divide-y divide-line overflow-hidden">
            {list.map((s) => (
              <button key={s.slot} onClick={() => setSel(s.slot)}
                className={clsx('w-full flex items-center gap-2.5 px-3 h-14 text-left hover:bg-btn transition-colors', cur?.slot === s.slot && 'bg-btn')}>
                <Dot ok={s.auth === 'ok' ? true : s.auth === 'checking' || s.auth === 'wrong_account' || s.auth === 'error' ? null : false} />
                <WalletTag slot={s.slot} />
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-1 text-base font-medium truncate">{lz(s.label)}{s.primary && <Star className="w-3 h-3 flex-none text-warn" fill="currentColor" />}</span>
                  <span className="block text-xs text-t4 truncate">{s.address ? short(s.address, 6, 4) : s.auth === 'checking' ? T('wl.checking') : T('wl.notLogged')}</span>
                </span>
                {s.auth === 'ok' && s.bnb != null && <span className="flex items-center gap-1 text-sm flex-none"><BnbCoin size={12} />{bnb(s.bnb, 4)}</span>}
              </button>
            ))}
          </div>

          {/* 详情 */}
          {cur && (
            <div className="flex-1 min-w-0 space-y-4 w-full">
              <div className="rounded-sm border border-line p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <WalletTag slot={cur.slot} />
                  <input key={cur.slot + String(cur.customName)} defaultValue={cur.customName ? cur.label : ''}
                    placeholder={cur.customName ? cur.label : T('wl.notePh')}
                    onBlur={(e) => rename(cur, e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                    className="flex-1 h-8 px-2.5 rounded-sm bg-btn text-base min-w-0" />
                  {cur.primary ? <span className="flex items-center gap-1 text-sm text-warn flex-none"><Star className="w-3.5 h-3.5" fill="currentColor" />{T('wl.primary')}</span>
                    : <button onClick={() => setPrimary(cur)} className="h-8 px-2.5 rounded-sm bg-btn hover:bg-btn-2 text-sm text-t2 flex items-center gap-1 flex-none"><Star className="w-3.5 h-3.5" />{T('wl.setPrimary')}</button>}
                </div>
                <div className="flex items-center gap-2 text-sm text-t3">
                  <span className="font-mono">{cur.address || '—'}</span>
                  {cur.address && <CopyBtn text={cur.address} />}
                  {cur.address && <a href={`https://bscscan.com/address/${cur.address}`} target="_blank" rel="noreferrer" className="hover:text-t2">BscScan ↗</a>}
                </div>
                <div className="flex gap-2 pt-1">
                  {cur.auth !== 'ok' && (
                    <button onClick={() => setUI({ loginOpen: true, loginSlot: cur.slot })} className="flex-1 h-9 rounded-sm bg-buy text-on-accent text-sm font-semibold flex items-center justify-center gap-1.5 hover:brightness-110">
                      <LogIn className="ico" />{cur.auth === 'wrong_account' ? T('wl.rescan') : T('wl.scan')}
                    </button>
                  )}
                  {cur.auth === 'ok' && (
                    <button onClick={() => logout(cur)} className="flex-1 h-9 rounded-sm bg-btn hover:bg-btn-2 text-sm text-t2 flex items-center justify-center gap-1.5"><Power className="ico" />{T('wl.logout')}</button>
                  )}
                  {list.length > 1 && (
                    <button onClick={() => remove(cur)} className="h-9 px-3 rounded-sm bg-down/10 text-down text-sm font-medium flex items-center gap-1.5 hover:bg-down/20"><Trash2 className="ico" />{T('wl.remove')}</button>
                  )}
                </div>
                {cur.auth !== 'ok' && !!cur.authMessage && <div className="text-sm text-down leading-5">{authText(cur.authCode, cur.authCodeP, cur.authMessage)}</div>}
              </div>
              {cur.auth === 'ok' && (
                <div className="rounded-sm border border-line p-4">
                  <div className="text-md font-medium mb-2">{T('wl.security')}</div>
                  <WalletSettings slot={cur.slot} />
                </div>
              )}
            </div>
          )}
        </div>

        <div className="text-xs text-t4 leading-5">
          {T('wl.foot1')}
          {T('wl.foot2')}
        </div>
      </div>
    </div>
  )
}
