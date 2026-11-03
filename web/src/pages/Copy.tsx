// 跟单（GMGN「跟单」）：填一个钱包地址建任务，对方在内盘建仓 / 加仓时跟买，可选跟卖。创建后立即开始，随时暂停。
import { useEffect, useState } from 'react'
import { Pause, Play, Plus, Power, Trash2, Loader2 } from '../components/gi'
import clsx from 'clsx'
import { useApp } from '../store/app'
import { api } from '../lib/api'
import { NumField } from '../components/common'
import { TaskWallets, WalletTag } from '../components/WalletPicker'
import { Empty } from './Token'
import { age, bnb, short } from '../lib/format'
import { Modal } from '../components/common'
import { useT, t as T, lz } from '../lib/i18n'
import { requireWallet } from '../lib/trade'

interface Task { id: string; target: string; name: string; createdAt: number; status: 'running' | 'paused' | 'closed'; params: any; stats: any }
interface LogRow { ts: number; task?: string; taskName?: string; kind: string; reason: string; symbol?: string; side?: string; target?: string }

export function CopyPage() {
  useT()   // 切换语言时重绘
  const [data, setData] = useState<{ tasks: Task[]; paused: boolean; log: LogRow[] } | null>(null)
  const [edit, setEdit] = useState<Task | 'new' | null>(null)
  const [tab, setTab] = useState<'active' | 'history'>('active')
  const load = () => api('/api/copy').then(setData).catch((e) => setData({ tasks: [], paused: false, log: [{ ts: Date.now(), kind: 'error', reason: e.message }] }))
  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t) }, [])
  const op = async (body: any) => { try { await api('/api/copy/tasks', body); load() } catch (e: any) { useApp.getState().toast({ kind: 'error', title: T('cp.opFailed'), body: e.message }) } }
  const tasks = (data?.tasks || []).filter((t) => (tab === 'active' ? t.status !== 'closed' : t.status === 'closed'))
  return (
    <div className="h-full scroll-y">
      <div className="p-5 space-y-4">
        <div className="flex items-center gap-4">
          <div className="text-xl font-semibold">{T('cp.title')}</div>
          <div className="seg h-8"><button data-on={tab === 'active'} onClick={() => setTab('active')}>{T('cp.active')}</button><button data-on={tab === 'history'} onClick={() => setTab('history')}>{T('cp.closed')}</button></div>
          <div className="flex-1" />
          <button onClick={() => api('/api/copy/pause-all', { paused: !data?.paused }).then(load)} className={clsx('h-8 px-3 rounded-sm text-sm font-medium', data?.paused ? 'bg-warn/16 text-warn' : 'bg-down/12 text-down')}>{data?.paused ? T('cp.pausedAll') : T('cp.pauseAll')}</button>
          <button onClick={() => setEdit('new')} className="h-8 px-3 rounded-sm bg-solid text-on-solid text-sm font-medium flex items-center gap-1"><Plus className="ico" />{T('cp.new')}</button>
        </div>
        <div className="rounded-md bg-card border border-line overflow-hidden">
          <table className="tbl">
            <thead><tr><th className="l">{T('cp.th.task')}</th><th className="l">{T('cp.th.status')}</th><th className="l">{T('cp.th.rule')}</th><th>{T('cp.th.buys')}</th><th>{T('cp.th.sells')}</th><th>{T('cp.th.cost')}</th><th>{T('cp.th.realized')}</th><th>{T('cp.th.created')}</th><th>{T('cp.th.ops')}</th></tr></thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id}>
                  <td className="l"><div className="font-medium text-warn">{t.name}</div><div className="text-xs text-t3 flex items-center gap-1">{(t.params?.wallets || []).map((n: number) => <WalletTag key={n} slot={n} />)}{short(t.target)}</div></td>
                  <td className="l"><span className={clsx('px-1.5 py-0.5 rounded-xs text-xs', t.status === 'running' ? 'bg-up/14 text-up' : 'bg-btn-2 text-t3')}>{T('cp.st.' + t.status)}</span></td>
                  <td className="l text-t2 text-xs max-w-[320px]">{t.params.mode === 'ratio' ? T('cp.r.ratio', { p: t.params.ratioPct }) : T('cp.r.fixed', { v: t.params.amountBnb })}{T('cp.r.perTrade', { v: t.params.maxPerTrade })}{T('cp.r.daily', { v: t.params.dailyCap })}{t.params.onlyFirst ? T('cp.r.onlyFirst') : ''}{t.params.followSell ? T('cp.r.followSell') : ''}{t.params.maxCopies ? T('cp.r.max', { n: t.params.maxCopies }) : ''}</td>
                  <td>{t.stats.buys}</td>
                  <td>{t.stats.sells}</td>
                  <td>{bnb(t.stats.buyBnb, 4)}</td>
                  <td className={t.stats.realized >= 0 ? 'text-up' : 'text-down'}>{bnb(t.stats.realized, 4)}</td>
                  <td className="text-t3">{age(t.createdAt)}</td>
                  <td>
                    <span className="inline-flex gap-1">
                      {t.status !== 'closed' && (t.status === 'running'
                        ? <button className="icon-btn w-7 h-7" title={T('cp.pause')} onClick={() => op({ id: t.id, status: 'paused' })}><Pause className="ico" /></button>
                        : <button className="icon-btn w-7 h-7 hover:!text-up" title={T('cp.start')} onClick={() => { if (requireWallet()) op({ id: t.id, status: 'running' }) }}><Play className="ico" /></button>)}
                      {t.status !== 'closed' && <button className="h-7 px-2 rounded-xs bg-btn text-xs text-t2 hover:bg-btn-2" onClick={() => setEdit(t)}>{T('cp.edit')}</button>}
                      {t.status !== 'closed' ? <button className="icon-btn w-7 h-7 hover:!text-down" title={T('cp.close')} onClick={() => op({ id: t.id, status: 'closed' })}><Power className="ico" /></button>
                        : <button className="icon-btn w-7 h-7 hover:!text-down" title={T('cp.delete')} onClick={() => op({ id: t.id, delete: true })}><Trash2 className="ico" /></button>}
                    </span>
                  </td>
                </tr>
              ))}
              {!tasks.length && <tr><td colSpan={9} className="!text-center text-t3 !py-10">{data ? T('cp.noTasks') : <Loader2 className="ico spin inline" />}</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="rounded-md bg-card border border-line overflow-hidden">
          <div className="px-4 h-11 flex items-center border-b border-line text-md font-medium">{T('cp.log')}<span className="text-t3 text-sm ml-2">{T('cp.logNote')}</span></div>
          <div className="max-h-[420px] scroll-y">
            {(data?.log || []).slice(0, 200).map((r, i) => (
              <div key={i} className="grid gap-3 px-4 py-1.5 border-b border-line text-sm" style={{ gridTemplateColumns: '70px 120px 120px 60px 1fr' }}>
                <span className="text-t3">{age(r.ts)}</span>
                <span className="truncate text-warn">{r.taskName || r.task || ''}</span>
                <span className="truncate">{r.symbol || ''}</span>
                <span className={clsx('font-medium', r.kind === 'order' ? 'text-up' : r.kind === 'sim' ? 'text-warn' : r.kind === 'skip' ? 'text-t3' : 'text-down')}>{['order', 'sim', 'skip', 'fail', 'error'].includes(r.kind) ? T('cp.k.' + r.kind) : r.kind}</span>
                <span className="text-t2 truncate" title={lz(r.reason)}>{lz(r.reason)}</span>
              </div>
            ))}
            {!data?.log?.length && <Empty text={T('cp.noLog')} />}
          </div>
        </div>
      </div>
      {edit && <TaskEditor task={edit === 'new' ? null : edit} onClose={() => { setEdit(null); load() }} />}
    </div>
  )
}

const DEF = { mode: 'fixed', amountBnb: 0.01, ratioPct: 10, maxPerTrade: 0.05, maxPerToken: 0.05, dailyCap: 0.2, maxOpen: 5, onlyFirst: true, minTargetBnb: 0, maxTargetBnb: 0, maxMcUsd: 0, platforms: ['flap', 'four', 'gang'], maxDelaySec: 15, slippage: 20, followSell: false, dryRun: false, maxCopies: 1 }

function TaskEditor({ task, onClose }: { task: Task | null; onClose: () => void }) {
  const targets = useApp((s) => s.track.targets)
  const [target, setTarget] = useState(task?.target || '')
  const [name, setName] = useState(task?.name || '')
  const [p, setP] = useState<any>({ ...DEF, ...(task?.params || {}) })
  const [err, setErr] = useState('')
  const set = (k: string) => (v: number) => setP((cur: any) => ({ ...cur, [k]: v }))
  const C = ({ k, label }: { k: string; label: string }) => (
    <label className="flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" checked={!!p[k]} onChange={(e) => setP({ ...p, [k]: e.target.checked })} className="accent-buy" />{label}</label>
  )
  const save = async () => {
    setErr('')
    try {
      const params = { ...p, dryRun: false }
      if (task) await api('/api/copy/tasks', { id: task.id, name, params })
      else {
        if (!/^0x[0-9a-fA-F]{40}$/.test(target.trim())) throw new Error(T('cp.badAddr'))
        if (!requireWallet()) return   // 创建即开始：没连接钱包先扫码登录
        const t = await api<{ id: string }>('/api/copy/tasks', { target: target.trim(), name, params })
        await api('/api/copy/tasks', { id: t.id, status: 'running' })   // 创建即开始
      }
      onClose()
    } catch (e: any) { setErr(e.message) }
  }
  return (
    <Modal open onClose={onClose} title={task ? T('cp.editTitle') : T('cp.newTitle')} width={560}>
      <div className="space-y-4">
        {!task && (
          <div className="flex flex-col gap-1.5"><span className="text-xs text-t3">{T('cp.target')}</span>
            <input value={target} onChange={(e) => setTarget(e.target.value)} className="input-box h-9 px-2 text-base font-mono" placeholder={T('cp.targetPh')} />
            {targets.length > 0 && <div className="flex flex-wrap gap-1.5">{targets.slice(0, 12).map((t) => (
              <button key={t.address} onClick={() => { setTarget(t.address); if (!name) setName(t.name || t.domain || '') }} className={clsx('h-6 px-2 rounded-xs text-xs', target.toLowerCase() === t.address.toLowerCase() ? 'bg-up/14 text-up' : 'bg-btn text-t2 hover:bg-btn-2')}>{t.name || t.domain || short(t.address)}</button>
            ))}</div>}
          </div>
        )}
        <div className="flex items-center gap-2"><span className="text-xs text-t3 flex-none">{T('cp.wallets')}</span><TaskWallets label="" value={p.wallets || [1]} onChange={(v) => setP((cur: any) => ({ ...cur, wallets: v }))} /></div>
        <label className="flex flex-col gap-1"><span className="text-xs text-t3">{T('cp.name')}</span><input value={name} onChange={(e) => setName(e.target.value)} className="input-box h-9 px-2 text-base" placeholder={T('cp.namePh')} /></label>
        <div className="seg h-8 w-full"><button className="flex-1" data-on={p.mode === 'fixed'} onClick={() => setP({ ...p, mode: 'fixed' })}>{T('cp.fixed')}</button><button className="flex-1" data-on={p.mode === 'ratio'} onClick={() => setP({ ...p, mode: 'ratio' })}>{T('cp.ratio')}</button></div>
        <div className="grid grid-cols-3 gap-3">
          {p.mode === 'fixed' ? <NumField label={T('cp.amount')} unit="BNB" value={p.amountBnb} onCommit={set('amountBnb')} /> : <NumField label={T('cp.ratioPct')} unit="%" value={p.ratioPct} onCommit={set('ratioPct')} />}
          <NumField label={T('cp.maxTrade')} unit="BNB" value={p.maxPerTrade} onCommit={set('maxPerTrade')} />
          <NumField label={T('cp.maxToken')} unit="BNB" value={p.maxPerToken} onCommit={set('maxPerToken')} />
          <NumField label={T('cp.daily')} unit="BNB" value={p.dailyCap} onCommit={set('dailyCap')} />
          <NumField label={T('cp.maxOpen')} value={p.maxOpen} onCommit={set('maxOpen')} />
          <NumField label={T('cp.maxCopies')} zero={T('cp.noLimit')} value={p.maxCopies} onCommit={set('maxCopies')} />
          <NumField label={T('cp.minTarget')} unit="BNB" value={p.minTargetBnb} onCommit={set('minTargetBnb')} />
          <NumField label={T('cp.maxTarget')} unit="BNB" zero={T('cp.noLimit')} value={p.maxTargetBnb} onCommit={set('maxTargetBnb')} />
          <NumField label={T('cp.maxMc')} unit="$" zero={T('cp.noLimit')} value={p.maxMcUsd} onCommit={set('maxMcUsd')} />
          <NumField label={T('cp.delay')} unit={T('cp.sec')} value={p.maxDelaySec} onCommit={set('maxDelaySec')} />
          <NumField label={T('cp.slip')} unit="%" value={p.slippage} onCommit={set('slippage')} />
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <C k="onlyFirst" label={T('cp.onlyFirst')} />
          <C k="followSell" label={T('cp.followSell')} />
          {(['flap', 'four', 'gang'] as const).map((pl) => (
            <label key={pl} className="flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" checked={p.platforms.includes(pl)} onChange={(e) => setP({ ...p, platforms: e.target.checked ? [...p.platforms, pl] : p.platforms.filter((x: string) => x !== pl) })} className="accent-buy" />{pl === 'flap' ? 'Flap' : pl === 'four' ? 'Four' : 'Gang'}</label>
          ))}
        </div>
        <div className="text-xs text-t3 leading-5">{T('cp.note')}</div>
        {err && <div className="text-sm text-down">{err}</div>}
        <div className="flex gap-2"><button onClick={onClose} className="flex-1 h-10 rounded-sm bg-btn text-t2">{T('cp.cancel')}</button><button onClick={save} className="flex-1 h-10 rounded-sm bg-up text-on-accent font-semibold">{task ? T('cp.save') : T('cp.createStart')}</button></div>
      </div>
    </Modal>
  )
}
