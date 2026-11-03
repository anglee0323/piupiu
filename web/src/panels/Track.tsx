// 钱包追踪：右侧停靠面板（底栏开关，GMGN 的钱包追踪栏）+ 追踪页（管理地址）
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Trash2, X, Loader2, History, G } from '../components/gi'
import clsx from 'clsx'
import { useApp } from '../store/app'
import { usePrefs } from '../store/prefs'
import { api } from '../lib/api'
import { age, compact, short, usd } from '../lib/format'
import type { TrackEvent, TrackTarget } from '../lib/types'
import { CopyBtn, TokenAvatar, useNow } from '../components/common'
import { Empty } from '../pages/Token'
import { isSoundKind, playSound } from '../lib/sound'
import { SoundList, SoundPopover, type SoundValue } from '../components/SoundPicker'
import { Tip } from '../components/Hover'
import { useT, t as T } from '../lib/i18n'

// 网关给的动作是中文原文（tracker.js）：按原文取颜色和文案键
const ACTION_ID: Record<string, string> = { 建仓: 'open', 加仓: 'add', 减仓: 'reduce', 清仓: 'close' }   // i18n-ignore
const ACTION_CLS: Record<string, string> = { open: 'text-up', add: 'text-up', reduce: 'text-down', close: 'text-down' }
const actionText = (a: string) => (ACTION_ID[a] ? T('trk.a.' + ACTION_ID[a]) : a)


function FeedItem({ e }: { e: TrackEvent }) {
  const nav = useNavigate()
  const name = useApp((s) => e.targetName || s.names[e.target.toLowerCase()] || short(e.target))
  return (
    <div onClick={() => nav(`/token/${e.token}`)} className="px-3 py-2.5 border-b border-line hover:bg-hover cursor-pointer">
      <div className="flex items-center gap-1.5 text-sm">
        <span className="text-warn font-medium truncate max-w-[140px]">{name}</span>
        <span className={clsx('font-medium', ACTION_CLS[ACTION_ID[e.action]] || (e.side === 'buy' ? 'text-up' : 'text-down'))}>{actionText(e.action)}{e.pct != null && e.side === 'sell' ? ` ${e.pct.toFixed(0)}%` : ''}</span>
        <span className="ml-auto text-t3 text-xs">{age(e.ts)}</span>
      </div>
      <div className="flex items-center gap-2 mt-1.5 text-sm">
        <span className={e.side === 'buy' ? 'text-up' : 'text-down'}>{e.usd != null ? `$${compact(e.usd)}` : `${compact(e.bnb)} BNB`}</span>
        <TokenAvatar t={{ image: e.image, symbol: e.symbol, platform: e.platform || 'flap' }} size={16} badge={false} />
        <span className="font-medium truncate">{e.symbol}</span>
        {e.createdAt && <span className="text-t3 text-xs">{age(e.createdAt)}</span>}
        <span className="ml-auto text-t3 text-xs" title={T('trk.mcTip')}>MC {usd(e.mcapUsd)}</span>
      </div>
    </div>
  )
}

export function TrackDock() {
  useT()
  const feed = useApp((s) => s.track.feed)
  const n = useApp((s) => s.track.targets.length)
  const set = usePrefs((s) => s.set)
  const nav = useNavigate()
  useNow(5000)
  return (
    <aside className="w-[340px] flex-none flex flex-col min-h-0 border-r border-line bg-card">
      <div className="h-11 flex-none flex items-center gap-2 px-3 border-b border-line">
        <span className="text-md font-medium">{T('trk.title')}</span>
        <span className="text-t3 text-sm">{T('trk.nAddr', { n })}</span>
        <div className="flex-1" />
        <TrackSoundMenu />
        <button className="h-6 px-2 rounded-xs bg-btn text-sm text-t2 hover:bg-btn-2" onClick={() => nav('/follow')}>{T('trk.manage')}</button>
        <button className="icon-btn w-6 h-6" onClick={() => set({ trackDock: false })}><X className="ico" /></button>
      </div>
      <div className="flex-1 min-h-0 scroll-y">
        {feed.slice(0, 200).map((e) => <FeedItem key={e.id} e={e} />)}
        {!feed.length && <div className="p-8 text-center text-t4 text-sm">{n ? T('trk.noTrades') : T('trk.noAddr')}</div>}
      </div>
    </aside>
  )
}

/** 钱包追踪提醒（照 GMGN）：声音列表——悬停试听、点击选中即关闭；底部是全局提醒音量 */
function TrackSoundMenu() {
  const ts = usePrefs((s) => s.trackSound)
  const vol = usePrefs((s) => s.soundVolume)
  const set = usePrefs((s) => s.set)
  return (
    <SoundPopover width={220} trigger={({ open, toggle, ref }) => (
      <Tip text={ts.on ? T('trk.soundOn', { k: ts.kind }) : T('trk.soundOff')}>
        <button ref={ref} className={clsx('icon-btn w-6 h-6', (open || ts.on) && '!text-t1')} onClick={toggle}><G n={ts.on ? 'Volume16pxRegular' : 'Mute16pxRegular'} className="ico" /></button>
      </Tip>
    )}>
      {(close) => (
        <>
          <div className="px-2.5 pt-2 pb-1 text-xs text-t3">{T('trk.soundHead')}</div>
          <SoundList value={ts.on ? ts.kind : 'Off'} onSelect={(v) => { set({ trackSound: v === 'Off' || v === 'default' ? { ...ts, on: false } : { on: true, kind: v } }); close() }} />
          <div className="border-t border-line px-2.5 py-2 flex items-center gap-2">
            <span className="text-xs text-t3 flex-none">{T('trk.volume')}</span>
            <input type="range" min={0} max={100} value={Math.round(vol * 100)} onChange={(e) => set({ soundVolume: Number(e.target.value) / 100 })} onPointerUp={() => ts.on && playSound(ts.kind)} className="flex-1 min-w-0 accent-buy" />
            <span className="text-xs text-t3 w-8 text-right flex-none">{Math.round(vol * 100)}%</span>
          </div>
        </>
      )}
    </SoundPopover>
  )
}

/** 单个钱包的提醒声音（GMGN 每个钱包可以单独设置）：跟随默认 / 关闭 / 指定一个声音 */
function TargetSound({ t }: { t: TrackTarget }) {
  const ts = usePrefs((s) => s.trackSound)
  const value: SoundValue = t.sound === false ? 'Off' : isSoundKind(t.sound) ? t.sound : 'default'
  const own = value !== 'default'
  return (
    <SoundPopover width={220} trigger={({ open, toggle, ref }) => (
      <Tip text={value === 'Off' ? T('trk.walletOff') : own ? T('trk.walletOwn', { v: value }) : T('trk.walletDefault', { v: ts.on ? ts.kind : T('trk.off') })}>
        <button ref={ref} onClick={(e) => { e.stopPropagation(); toggle() }}
          className={clsx('icon-btn w-7 h-7', open || own ? 'opacity-100' : 'opacity-0 group-hover:opacity-100', value === 'Off' ? 'text-t3' : own ? '!text-t1' : '')}>
          <G n={value === 'Off' ? 'Mute16pxRegular' : 'Volume16pxRegular'} className="ico" />
        </button>
      </Tip>
    )}>
      {(close) => <SoundList value={value} defaultLabel={T('trk.defaultLabel', { v: ts.on ? ts.kind : T('trk.off') })}
        onSelect={(v) => { api('/api/track/targets', { address: t.address, sound: v === 'default' ? true : v === 'Off' ? false : v }).catch(() => {}); close() }} />}
    </SoundPopover>
  )
}

export function FollowPage() {
  useT()
  const { targets, feed, groups } = useApp((s) => s.track)
  const [backfilling, setBackfilling] = useState('')
  // 手动补最近 24 小时（默认不补：添加即实时，历史要的话按这个）
  const backfill = (a: string) => {
    setBackfilling(a)
    api('/api/track/backfill', { address: a })
      .then((r: any) => useApp.getState().toast({ kind: 'ok', title: T('trk.backfilled'), body: T('trk.backfillBody', { a: r.trades ?? 0, b: r.added ?? 0 }) }))
      .catch((e: any) => useApp.getState().toast({ kind: 'error', title: T('trk.backfillFailed'), body: e.message }))
      .finally(() => setBackfilling(''))
  }
  const nameOf = useApp((s) => s.names)
  const [addr, setAddr] = useState('')
  const [name, setName] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<string | null>(null)
  useNow(5000)
  const add = async () => {
    const v = addr.trim(); if (!v) return
    setBusy(true); setMsg(null)
    try {
      const r = await api(`/api/track/resolve?name=${encodeURIComponent(v)}`)
      await api('/api/track/targets', { address: r.address, name: name.trim() || r.name || '', domain: r.name || null, group: groups[0] || '默认' })   // i18n-ignore（分组名是数据值）
      setAddr(''); setName(''); setMsg({ ok: true, t: T('trk.added', { n: r.name || short(r.address) }) })
    } catch (e: any) { setMsg({ ok: false, t: e.message }) } finally { setBusy(false) }
  }
  const remove = (a: string) => api('/api/track/targets', { remove: true, address: a }).catch(() => {})
  const list = useMemo(() => (filter ? feed.filter((e) => e.target === filter) : feed), [feed, filter])
  return (
    <div className="h-full grid min-h-0" style={{ gridTemplateColumns: '360px minmax(0,1fr)' }}>
      <aside className="flex flex-col min-h-0 border-r border-line bg-card">
        <div className="p-3 space-y-2 border-b border-line">
          <div className="text-md font-medium">{T('trk.addrs')}</div>
          <input className="input-box w-full h-9 px-3 text-base" placeholder={T('trk.addrPh')} value={addr} onChange={(e) => setAddr(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          <div className="flex gap-2">
            <input className="input-box flex-1 h-9 px-3 text-base" placeholder={T('trk.namePh')} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
            <button onClick={add} disabled={busy} className="h-9 px-3 rounded-sm bg-solid text-on-solid font-medium flex items-center gap-1 disabled:opacity-50">{busy ? <Loader2 className="ico spin" /> : <Plus className="ico" />}{T('trk.add')}</button>
          </div>
          {msg && <div className={clsx('text-sm', msg.ok ? 'text-up' : 'text-down')}>{msg.t}</div>}
          <div className="text-xs text-t3">{T('trk.addNote')}</div>
        </div>
        <div className="flex-1 min-h-0 scroll-y">
          <button onClick={() => setFilter(null)} className={clsx('w-full px-3 h-9 text-left text-sm', !filter ? 'bg-hover-2 text-t1' : 'text-t2 hover:bg-hover')}>{T('trk.allFeed')}</button>
          {targets.map((t) => (
            <div key={t.address} onClick={() => setFilter(t.address)} className={clsx('group flex items-center gap-2 px-3 h-12 cursor-pointer border-t border-line', filter === t.address ? 'bg-hover-2' : 'hover:bg-hover')}>
              <div className="min-w-0 flex-1">
                <div className="text-base font-medium truncate text-warn">{t.name || t.domain || nameOf[t.address] || short(t.address)}</div>
                <div className="flex items-center text-xs text-t3">{short(t.address, 4, 4)}<CopyBtn text={t.address} size={10} /></div>
              </div>
              <TargetSound t={t} />
              <button className="icon-btn w-7 h-7 opacity-0 group-hover:opacity-100" title={T('trk.backfillTip')} onClick={(e) => { e.stopPropagation(); backfill(t.address) }}>{backfilling === t.address ? <Loader2 className="ico spin" /> : <History className="ico" />}</button>
              <button className="icon-btn w-7 h-7 opacity-0 group-hover:opacity-100 hover:!text-down" title={T('trk.remove')} onClick={(e) => { e.stopPropagation(); remove(t.address) }}><Trash2 className="ico" /></button>
            </div>
          ))}
        </div>
      </aside>
      <section className="min-h-0 scroll-y">
        <div className="tbl-x"><table className="tbl">
          <thead><tr><th>{T('trk.th.time')}</th><th className="l">{T('trk.th.wallet')}</th><th className="l">{T('trk.th.action')}</th><th className="l">{T('trk.th.token')}</th><th>{T('trk.th.amount')}</th><th>{T('trk.th.mc')}</th><th>{T('trk.th.age')}</th></tr></thead>
          <tbody>
            {list.map((e) => <FollowRow key={e.id} e={e} />)}
            {!list.length && <tr><td colSpan={7} className="!border-0"><Empty text={T('trk.noActivity')} /></td></tr>}
          </tbody>
        </table></div>
      </section>
    </div>
  )
}

function FollowRow({ e }: { e: TrackEvent }) {
  const nav = useNavigate()
  const name = useApp((s) => e.targetName || s.names[e.target.toLowerCase()] || short(e.target))
  return (
    <tr className="cursor-pointer" onClick={() => nav(`/token/${e.token}`)}>
      <td className="text-t3">{age(e.ts)}</td>
      <td className="l text-warn">{name}</td>
      <td className={clsx('l font-medium', ACTION_CLS[ACTION_ID[e.action]] || (e.side === 'buy' ? 'text-up' : 'text-down'))}>{actionText(e.action)}{e.pct != null && e.side === 'sell' ? ` ${e.pct.toFixed(0)}%` : ''}</td>
      <td className="l"><span className="flex items-center gap-2"><TokenAvatar t={{ image: e.image, symbol: e.symbol, platform: e.platform || 'flap' }} size={20} badge={false} />{e.symbol}</span></td>
      <td className={e.side === 'buy' ? 'text-up' : 'text-down'}>{e.usd != null ? `$${compact(e.usd)}` : `${compact(e.bnb)} BNB`}</td>
      <td>{usd(e.mcapUsd)}</td>
      <td className="text-t3">{age(e.createdAt)}</td>
    </tr>
  )
}
