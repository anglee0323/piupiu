// 狙击（Gang 新盘）：gang.fun 出新盘时各钱包买总量 N%，带每日上限和自动卖出档位。
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2, Plus, X } from '../components/gi'
import clsx from 'clsx'
import { useApp } from '../store/app'
import { useUI } from '../store/ui'
import { api } from '../lib/api'
import { age, bnb, compact } from '../lib/format'
import { NumField } from '../components/common'
import { TaskWallets } from '../components/WalletPicker'
import { Empty } from './Token'
import { useT, t as T, lz } from '../lib/i18n'
import { requireWallet } from '../lib/trade'

export function SnipePage() {
  useT()   // 切换语言时重绘（下面用 T() 取文案）
  const wbnb = useApp((s) => s.holdings?.wbnb ?? 0)   // 狙击预换的 WBNB（和 BNB 1:1，计入顶栏余额）
  const [v, setV] = useState<any>(null)
  const [err, setErr] = useState('')
  const slots = useApp((s) => s.slots)
  const [p, setP] = useState<any>(null)
  const load = () => api('/api/snipe').then((d) => { setV(d); setErr(''); setP((cur: any) => cur || d.params) }).catch((e) => setErr(e.message))
  useEffect(() => { load(); const t = setInterval(load, 2500); return () => clearInterval(t) }, [])
  const post = async (body: any, msg: string) => { try { setV(await api('/api/snipe', body)); useApp.getState().toast({ kind: 'ok', title: msg }) } catch (e: any) { useApp.getState().toast({ kind: 'error', title: T('sn.opFailed'), body: e.message }) } }
  // 停止狙击时如果还有预换的 WBNB：问一句要不要顺手换回 BNB（不然钱静静躺在 WBNB 里，容易忘了）
  const stop = async () => {
    post({ enabled: false }, T('sn.stopped'))
    try {
      const rows = await api<any[]>('/api/quote-balances')
      const w = rows.find((r) => r.wbnb)
      if (!w || !(Number(w.balance) > 0.0001)) return
      const p = await api('/api/quote-to-bnb/preview', { token: w.token, slippage: 1 })
      const ok = await useUI.getState().ask({ title: T('sn.unwrapTitle'), okText: T('sn.unwrapOk'), rows: [[T('sn.amount'), `${compact(Number(p.balance))} WBNB`], [T('sn.expect'), `${bnb(p.out)} BNB`], [T('sn.note'), T('sn.unwrapNote')]] })
      if (ok) { const o = await api('/api/quote-to-bnb', { token: w.token, slippage: p.slippage }); if (o.status === 'failed') throw new Error(o.reason || T('sn.swapFailed')) }
    } catch { /* 问不到余额就算了 */ }
  }
  // 这一页的参数是「草稿」：改了要点下面的「保存」才会存到后端（以前页面没有任何提示，勾选框一动看起来就像存好了，刷新后又变回去）。
  // 有没有没存的修改：对比草稿和后端里的参数（dryRun 不比：保存按钮总是把它写成 false）
  const dirty = !!(p && v?.params) && Object.keys(p).some((k) => k !== 'dryRun' && JSON.stringify(p[k]) !== JSON.stringify(v.params[k]))
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', h); return () => window.removeEventListener('beforeunload', h)
  }, [dirty])
  // 下单钱包决定「哪些钱包会花钱」：一勾选就立刻存，不等「保存」
  const saveWallets = async (wallets: number[]) => {
    setP((cur: any) => ({ ...cur, wallets }))
    try { setV(await api('/api/snipe', { params: { wallets } })); useApp.getState().toast({ kind: 'ok', title: T('sn.walletsSaved', { w: wallets.map((w) => `W${w}`).join(', ') }) }) }
    catch (e: any) { useApp.getState().toast({ kind: 'error', title: T('sn.walletsFailed'), body: e.message }) }
  }
  if (err && !v) return <div className="p-10 text-center text-t3">{err}</div>
  if (!v || !p) return <div className="h-full grid place-items-center"><Loader2 className="ico spin text-t3" /></div>
  // 数字输入用 NumField（模块级组件 + 本地草稿）：页面 2.5 秒轮询一次，输入组件如果在渲染函数里定义，每次轮询都会被销毁重建，正在输入的内容会丢失
  const set = (k: string) => (val: number) => setP((cur: any) => ({ ...cur, [k]: val }))
  const Check = ({ k, label }: { k: string; label: string }) => (
    <label className="flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" checked={!!p[k]} onChange={(e) => setP({ ...p, [k]: e.target.checked })} className="accent-buy" />{label}</label>
  )
  return (
    <div className="h-full scroll-y">
      <div className="p-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="text-xl font-semibold">{T('sn.title')}</div>
          <span className={clsx('px-2 py-0.5 rounded-xs text-sm', v.enabled ? 'bg-up/14 text-up' : 'bg-btn-2 text-t3')}>{v.enabled ? T('sn.running') : T('sn.off')}</span>
          {!v.liveTrade && <span className="text-xs text-warn">{T('sn.demo')}</span>}
          <div className="flex-1" />
          {v.enabled
            ? <button onClick={stop} className="h-9 px-4 rounded-sm bg-down text-white font-semibold">{T('sn.stop')}</button>
            : <button onClick={() => { if (requireWallet()) post({ params: { ...p, dryRun: false }, enabled: true }, T('sn.started')) }} className="h-9 px-5 rounded-sm bg-up text-on-accent font-semibold">{T('sn.start')}</button>}
        </div>
        <div className="text-sm text-t3 leading-6">{T('sn.intro')}</div>
        <div className="grid grid-cols-4 gap-3">
          {[[T('sn.todayIn'), `${bnb(v.today?.bnb ?? 0, 4)} BNB`], [T('sn.todayN'), T('sn.nTokens', { n: v.today?.tokens ?? 0 })], [T('sn.totalBuys'), T('sn.nTimes', { n: v.stats?.orders ?? 0 })], [T('sn.totalFails'), T('sn.nTimes', { n: v.stats?.fails ?? 0 })]].map(([k, val]) => (
            <div key={k} className="rounded-md bg-card border border-line p-3"><div className="text-xs text-t3">{k}</div><div className="text-lg font-semibold mt-1">{val}</div></div>
          ))}
        </div>
        <div className="rounded-md bg-card border border-line p-4 space-y-4">
          <div className="text-md font-medium">{T('sn.buy')}</div>
          <div className="flex items-center gap-2"><span className="text-xs text-t3">{T('sn.wallets')}</span><TaskWallets label="" value={p.wallets || [1]} onChange={saveWallets} />{(slots?.slots || []).filter((x) => x.auth === 'ok').length > 1 && <span className="text-[11px] text-t4">{T('sn.savedOnPick')}</span>}</div>
          <div className="grid grid-cols-3 gap-3">
            <NumField label={T('sn.pct')} unit="%" value={p.pct} onCommit={set('pct')} />
            <NumField label={T('sn.maxBuy', { n: v.hardMax })} unit="BNB" value={p.maxBnbPerBuy} onCommit={set('maxBnbPerBuy')} />
            <NumField label={T('sn.window')} unit={T('sn.sec')} value={p.maxDelaySec} onCommit={set('maxDelaySec')} />
            <NumField label={T('sn.maxSold')} unit="%" value={p.maxSoldPct} onCommit={set('maxSoldPct')} />
            <NumField label={T('sn.slip')} unit="%" value={p.slippage} onCommit={set('slippage')} />
            <NumField label={T('sn.wbnb')} unit="BNB" zero={T('sn.noWrap')} value={p.wbnbFloat} onCommit={set('wbnbFloat')} />
          </div>
          {p.wbnbFloat > 0 && (
            <div className="text-xs text-t3 leading-5">
              {T('sn.wbnbNow', { cur: bnb(wbnb, 4), goal: bnb(p.wbnbFloat, 4) })}
              {T('sn.wbnbNote')}
            </div>
          )}
          <div className="flex flex-col gap-1.5"><span className="text-xs text-t3">{T('sn.quotes')}</span>
            <div className="flex flex-wrap gap-1.5">{Array.from(new Set(['BNB', 'GANG', 'BNCB', 'USDT', ...(p.quotes || [])])).map((q: string) => {
              const on = (p.quotes || []).includes(q)
              return <button key={q} onClick={() => setP({ ...p, quotes: on ? p.quotes.filter((x: string) => x !== q) : [...(p.quotes || []), q] })} className={clsx('h-7 px-3 rounded-xs text-sm', on ? 'bg-up/14 text-up' : 'bg-btn text-t3 hover:bg-btn-2')}>{q}</button>
            })}</div></div>
          {(v.typical || []).length > 0 && <div className="text-xs text-t3">{T('sn.typical', { p: p.pct, list: (v.typical || []).map((x: any) => T('sn.typicalItem', { bnb: bnb(x.bnb, 4), sold: x.soldPct })).join(T('sn.sep')) })}</div>}
          <div className="border-t border-line pt-4 space-y-3">
            <div className="text-md font-medium">{T('sn.sell')}</div>
            <Check k="autoSell" label={T('sn.autoSell')} />
            {p.autoSell && (
              <div className="space-y-2">
                {(p.tiers || []).map((t: any, i: number) => (
                  <div key={i} className="flex items-center gap-2 text-sm">
                    <span className="text-t3 w-12">{T('sn.tierN', { n: i + 1 })}</span>
                    <NumField w="w-[150px]" align="right" prefix={T('sn.reach')} unit={T('sn.x')} value={t.mult} onCommit={(val) => setP((cur: any) => ({ ...cur, tiers: cur.tiers.map((x: any, j: number) => (j === i ? { ...x, mult: val } : x)) }))} />
                    <NumField w="w-[150px]" align="right" prefix={T('sn.sellPct')} unit="%" value={t.pct} onCommit={(val) => setP((cur: any) => ({ ...cur, tiers: cur.tiers.map((x: any, j: number) => (j === i ? { ...x, pct: val } : x)) }))} />
                    <button className="icon-btn w-7 h-7" onClick={() => setP({ ...p, tiers: p.tiers.filter((_: any, j: number) => j !== i) })}><X className="ico-sm" /></button>
                  </div>
                ))}
                {(p.tiers || []).length < 3 && <button onClick={() => setP({ ...p, tiers: [...(p.tiers || []), { mult: 3, pct: 50 }] })} className="flex items-center gap-1 text-sm text-t3 hover:text-t1"><Plus className="ico-sm" />{T('sn.addTier')}</button>}
                <div className="grid grid-cols-3 gap-3">
                  <NumField label={T('sn.stopLoss')} unit="%" zero={T('sn.noStop')} value={p.stopLossPct} onCommit={set('stopLossPct')} />
                  <NumField label={T('sn.sellSlip')} unit="%" value={p.sellSlippage} onCommit={set('sellSlippage')} />
                  <NumField label={T('sn.hold')} unit={T('sn.hours')} value={p.holdHours} onCommit={set('holdHours')} />
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => post({ params: { ...p, dryRun: false } }, T('sn.saved'))} className="h-9 px-5 rounded-sm bg-solid text-on-solid font-medium">{T('sn.save')}</button>
            {dirty && <span className="text-sm text-warn">{T('sn.dirty')}</span>}
            {dirty && <button className="text-xs text-t3 hover:text-t1" onClick={() => setP(v.params)}>{T('sn.discard')}</button>}
          </div>
        </div>
        <div className="rounded-md bg-card border border-line overflow-hidden">
          <div className="px-4 h-11 flex items-center border-b border-line text-md font-medium">{T('sn.positions')}<span className="text-t3 text-sm ml-2">{T('sn.positionsNote')}</span></div>
          <div className="tbl-x"><table className="tbl">
            <thead><tr><th className="l">{T('sn.token')}</th><th>{T('sn.boughtAt')}</th><th>{T('sn.cost')}</th><th>{T('sn.mult')}</th><th className="l">{T('sn.tiersDone')}</th><th></th></tr></thead>
            <tbody>
              {(v.positions || []).map((x: any) => (
                <tr key={x.token}>
                  <td className="l"><Link to={`/token/${x.token}`} className="hover:underline">{x.symbol}</Link></td>
                  <td className="text-t3">{age(x.ts)}</td>
                  <td>{bnb(x.bnb, 4)} BNB</td>
                  <td className={x.mult >= 1 ? 'text-up' : 'text-down'}>{x.mult != null ? `${x.mult.toFixed(2)}×` : '—'}</td>
                  <td className="l text-t2">{(x.tiersDone || []).map((m: any) => (m === 'sl' ? T('sn.sl') : T('sn.multN', { n: m }))).join(', ') || '—'}</td>
                  <td><button className="text-xs text-t3 hover:text-down" onClick={() => post({ forget: x.token }, T('sn.forgot'))}>{T('sn.forget')}</button></td>
                </tr>
              ))}
              {!v.positions?.length && <tr><td colSpan={6} className="!text-center text-t3 !py-8">{T('sn.noPos')}</td></tr>}
            </tbody>
          </table></div>
        </div>
        <div className="rounded-md bg-card border border-line overflow-hidden">
          <div className="px-4 h-11 flex items-center border-b border-line text-md font-medium">{T('sn.log')}</div>
          <div className="max-h-[420px] scroll-y">
            {(v.log || []).slice(0, 200).map((r: any, i: number) => (
              <div key={i} className="grid gap-3 px-4 py-1.5 border-b border-line text-sm" style={{ gridTemplateColumns: '70px 140px 60px 1fr' }}>
                <span className="text-t3">{age(r.ts)}</span>
                <span className="truncate">{r.symbol || ''}</span>
                <span className={clsx('font-medium', r.kind === 'order' || r.kind === 'sell' ? 'text-up' : r.kind === 'sim' ? 'text-warn' : r.kind === 'skip' ? 'text-t3' : 'text-down')}>{['order', 'sim', 'skip', 'fail', 'error', 'sell'].includes(r.kind) ? T('sn.k.' + r.kind) : r.kind}</span>
                <span className="text-t2 truncate" title={lz(r.reason)}>{lz(r.reason)}</span>
              </div>
            ))}
            {!v.log?.length && <Empty text={T('sn.noLog')} />}
          </div>
        </div>
      </div>
    </div>
  )
}
