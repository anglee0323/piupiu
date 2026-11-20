// Piupiu Pass：Agent ID 持有者可选领取的免费通行证（不可转让的链上徽章）。底栏一个入口，点开看说明并领取。
// 不影响任何现有功能，不领也能照常使用；从不自动领取：先预检（币安钱包预演）→ 用户点「确认领取」→ 才提交。
// 合约没配置 / 在线体验（没有后端）时整个入口不显示。
import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { Modal } from './common'
import { Check, ExternalLink, Loader2, ShieldCheck } from './gi'
import { useT, t as T, lz } from '../lib/i18n'

type Job = { status: 'sending' | 'app-confirm' | 'broadcast' | 'unconfirmed' | 'unknown' | 'failed' | 'done'; tx?: string | null; reason?: string | null; passId?: number | null }
type Row = { slot: number; label: string; address: string; loggedIn: boolean; agentName: string | null; holdsAgentId: boolean | null; passId: number | null; claimed: boolean | null; job: Job | null }
type View = { available: boolean; contract?: string; total?: number | null; wallets?: Row[] }
type Preview = { id: string; slot: number; risks: string[]; needAppConfirm: boolean }

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const ACTIVE = new Set(['sending', 'app-confirm', 'broadcast'])

export function PiupiuPass() {
  useT()
  const [v, setV] = useState<View | null>(null)
  const [open, setOpen] = useState(false)
  const [pv, setPv] = useState<Preview | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [err, setErr] = useState('')

  const load = useCallback(() => api<View>('/api/pass').then(setV).catch(() => setV({ available: false })), [])
  useEffect(() => { load() }, [load])
  // 打开着、且有正在进行的领取时，每 2 秒刷新一次
  const active = !!v?.wallets?.some((w) => w.job && ACTIVE.has(w.job.status))
  useEffect(() => {
    if (!open) return
    load()
    if (!active) return
    const h = setInterval(load, 2000)
    return () => clearInterval(h)
  }, [open, active, load])

  if (!v?.available) return null
  const anyClaimed = !!v.wallets?.some((w) => w.claimed)

  const check = async (slot: number) => {
    setBusy(slot); setErr(''); setPv(null)
    try { setPv(await api<Preview>('/api/pass/preview', { slot })) } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }
  const confirm = async () => {
    if (!pv) return
    setBusy(pv.slot); setErr('')
    try { await api('/api/pass/submit', { previewId: pv.id }); setPv(null); await load() } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }

  const state = (w: Row) => {
    const j = w.job
    if (w.claimed) return <span className="text-up inline-flex items-center gap-1"><Check className="ico-sm" />{T('pass.claimed', { n: w.passId ?? '' })}</span>
    if (j && ACTIVE.has(j.status)) return <span className="text-t2 inline-flex items-center gap-1"><Loader2 className="ico-sm animate-spin" />{T(j.status === 'app-confirm' ? 'pass.appWait' : j.status === 'broadcast' ? 'pass.broadcast' : 'pass.sending')}</span>
    if (!w.loggedIn) return <span className="text-t3">{T('pass.loggedOut')}</span>
    if (w.holdsAgentId === false) return <span className="text-t3">{T('pass.noAgent')}</span>
    if (w.holdsAgentId == null) return <span className="text-t3">{T('pass.unknown')}</span>
    return <span className="text-t2">{T('pass.unclaimed')}</span>
  }

  return (
    <>
      <button onClick={() => setOpen(true)} title={T('pass.short')} className="h-6 px-2 flex items-center gap-1.5 rounded-xs text-t3 hover:text-t1 hover:bg-btn flex-none">
        <ShieldCheck className="ico-sm" />{T('pass.tag')}{anyClaimed && <Check className="ico-sm text-up" />}
      </button>
      <Modal open={open} title={T('pass.title')} onClose={() => { setOpen(false); setPv(null); setErr('') }} width={460}>
        <div className="space-y-3 text-sm leading-6 text-t2">
          <div>{T('pass.about')}</div>
          <div className="rounded-sm bg-btn divide-y divide-line">
            {(v.wallets || []).map((w) => {
              const canClaim = w.loggedIn && w.holdsAgentId === true && !w.claimed && !(w.job && ACTIVE.has(w.job.status))
              return (
                <div key={w.slot} className="px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-t1 truncate">{w.agentName || w.label}</div>
                      <div className="text-xs text-t3 font-mono">{short(w.address)}</div>
                    </div>
                    <div className="flex items-center gap-2 flex-none text-xs">
                      {state(w)}
                      {canClaim && !(pv && pv.slot === w.slot) && (
                        <button disabled={busy === w.slot} onClick={() => check(w.slot)} className="h-7 px-3 rounded-sm bg-btn-2 hover:bg-btn text-t1 text-xs font-medium disabled:opacity-60 flex items-center gap-1.5">
                          {busy === w.slot && <Loader2 className="ico-sm animate-spin" />}{busy === w.slot ? T('pass.checking') : T('pass.claim')}
                        </button>
                      )}
                    </div>
                  </div>
                  {pv && pv.slot === w.slot && (
                    <div className="mt-2.5 rounded-sm border border-line px-3 py-2.5 space-y-2 text-xs">
                      <div className="text-t2">{T('pass.preview')}</div>
                      {pv.risks.length > 0 && <div className="text-warn">{T('pass.risks', { r: pv.risks.join('；') })}</div>}
                      {pv.needAppConfirm && <div className="text-t3">{T('pass.appConfirm')}</div>}
                      <div className="flex gap-2">
                        <button disabled={busy === w.slot} onClick={confirm} className="h-8 px-4 rounded-sm bg-btn-2 hover:bg-btn text-t1 text-xs font-medium disabled:opacity-60 flex items-center gap-1.5">
                          {busy === w.slot && <Loader2 className="ico-sm animate-spin" />}{T('pass.confirm')}
                        </button>
                        <button disabled={busy === w.slot} onClick={() => setPv(null)} className="h-8 px-4 rounded-sm bg-btn hover:bg-btn-2 text-t2 text-xs">{T('common.cancel')}</button>
                      </div>
                    </div>
                  )}
                  {w.job && !ACTIVE.has(w.job.status) && w.job.status !== 'done' && w.job.reason && <div className="mt-1.5 text-xs text-warn">{lz(w.job.reason)}</div>}
                  {w.job?.tx && <a href={`https://bscscan.com/tx/${w.job.tx}`} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-xs text-link hover:underline">{T('pass.viewTx')}<ExternalLink className="ico-sm" /></a>}
                </div>
              )
            })}
            {!v.wallets?.length && <div className="px-3 py-3 text-xs text-t3">{T('pass.noWallet')}</div>}
          </div>
          {err && <div className="text-xs text-warn">{err}</div>}
          <div className="flex items-center justify-between text-xs text-t3">
            <span>{v.total != null ? T('pass.total', { n: v.total }) : ''}</span>
            {v.contract && <a href={`https://bscscan.com/address/${v.contract}#code`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-link hover:underline">{T('pass.contract')} {short(v.contract)}<ExternalLink className="ico-sm" /></a>}
          </div>
        </div>
      </Modal>
    </>
  )
}
