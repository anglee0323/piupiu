// 下单面板（GMGN 右栏）：预设 + 钱包 + 余额 → 买入 / 卖出 / 自动 → 市价 / 限价 / DCA → 金额 → 报价 → 风险提示 → 大按钮 → 参数摘要 → 挂单 → 动量
import { FlyCard } from './FlyCard'
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ChevronDown, Fuel, Loader2, Pencil, Plus, ShieldCheck, ShieldAlert, Trash2, Check, X, G } from './gi'
import clsx from 'clsx'
import { useApp } from '../store/app'
import { usePrefs, type PresetId } from '../store/prefs'
import { useUI } from '../store/ui'
import { api } from '../lib/api'
import { age, bnb, compact, pct, small, usd } from '../lib/format'
import { authOk, buy, gasLabel, isReal, sell } from '../lib/trade'
import type { Audit, CondOrder, Preview, Token } from '../lib/types'
import { BnbCoin } from './icons'
import { WalletPicker, WalletTag, useTradeWallets } from './WalletPicker'
import { useT, t as T, lz } from '../lib/i18n'
import { NumField } from './common'
import { Switch } from './SettingsKit'
import { demoParam } from '../lib/env'

const lc = (a?: string | null) => String(a || '').toLowerCase()
type Side = 'buy' | 'sell' | 'auto'
type Mode = 'market' | 'limit' | 'dca'

/** 解析 $ 市值输入：支持 25K / 1.5M */
export function parseMc(v: string): number {
  const m = String(v).trim().replace(/[$,\s]/g, '').match(/^([\d.]+)([kKmMbB]?)$/)
  if (!m) return NaN
  return Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 } as Record<string, number>)[m[2].toLowerCase()] || Number(m[1])
}

async function createCond(body: Record<string, unknown>, label: string) {
  const app = useApp.getState()
  if (!authOk()) { app.toast({ kind: 'error', title: T('tp.walletOff'), body: T('tp.condNeedWallet') }); useUI.getState().set({ loginOpen: true }); return false }
  try { await api('/api/cond', body); app.toast({ kind: 'ok', title: T('tp.created', { label }), body: T('tp.createdBody') }); return true }
  catch (e: any) { app.toast({ kind: 'error', title: T('tp.createFailed', { label }), body: e.message }); return false }
}

export function TradePanel({ t }: { t: Token }) {
  const tr = useT()
  const [side, setSide] = useState<Side>(() => (demoParam('side') === 'auto' ? 'auto' : 'buy'))   // 官网嵌入的展示画面可指定打开「自动」
  const [mode, setMode] = useState<Mode>('market')
  const preset = usePrefs((s) => s.activePreset)
  const setP = usePrefs((s) => s.set)
  const wallets = useApp((s) => s.wallets)
  const holdings = useApp((s) => s.holdings)
  const tw = useTradeWallets()
  const bal = tw.picked.length ? tw.bal : holdings?.bnb ?? wallets[0]?.bnb ?? 0
  const pos = holdings?.rows.find((r) => lc(r.token) === lc(t.address))
  // 打新认购中：固定价认购 / 退出这里暂不支持，说明白并给 gang.fun 的入口（开盘后和普通币一样在这里买卖）
  if (t.gangFair && t.stage === 'curve') return <FairNotice t={t} />
  // 铸币飞轮开盘前：按份铸造 / 卖回（飞轮卡片替代普通下单面板）；开盘后普通下单面板下面再放飞轮卡片（开盘后铸造、领奖励）
  if (t.gangFly && t.stage === 'curve') return <FlyCard t={t} />
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-center gap-2">
        <div className="seg h-7">{([1, 2, 3] as PresetId[]).map((p) => <button key={p} data-on={preset === p} onClick={() => setP({ activePreset: p })}>P{p}</button>)}</div>
        {/* 钱包栏：单钱包只显示 W1 + 余额；多钱包显示选中的标签和合计余额，点开选择（GMGN 同款）；不另放「W1 / W2 / 全部」快捷切换，面板窄会挤出去 */}
        {tw.slots && tw.slots.slots.length > 1 ? (
          <WalletPicker trigger={({ toggle, ref }) => (
            <button onClick={toggle} ref={ref} className="flex items-center gap-1 h-7 px-2 rounded-xs bg-btn hover:bg-btn-2 text-sm" title={tr('tp.pickWallets')}>
              {tw.picked.slice(0, 3).map((s) => <WalletTag key={s.slot} slot={s.slot} />)}
              {tw.picked.length > 3 && <span className="text-t3">+{tw.picked.length - 3}</span>}
              <span className="flex items-center gap-1 text-t2 whitespace-nowrap"><BnbCoin size={12} />{bnb(bal, 3)}</span>
              <ChevronDown className="ico-sm text-t3" />
            </button>
          )} />
        ) : (
          <span className="flex items-center gap-1.5 h-7 px-2 rounded-xs bg-btn text-t2 text-sm" title={wallets[0]?.address}><WalletTag slot={tw.slots?.primary || 1} />{bnb(bal, 4)} BNB</span>
        )}
      </div>
      <div className="grid grid-cols-3 gap-1 p-[3px] rounded-sm bg-btn">
        {(['buy', 'sell', 'auto'] as Side[]).map((s) => (
          <button key={s} onClick={() => setSide(s)} className={clsx('h-8 rounded-[5px] text-md font-semibold',
            side !== s ? 'text-t2 hover:text-t1' : s === 'buy' ? 'bg-buy/10 text-buy' : s === 'sell' ? 'bg-down/12 text-down' : 'bg-btn-2 text-t1')}>
            {s === 'buy' ? tr('tp.buy') : s === 'sell' ? tr('tp.sell') : tr('tp.auto')}
          </button>
        ))}
      </div>
      {side === 'auto' ? <AutoTab t={t} /> : (
        <>
          <div className="flex items-center gap-4 text-md">
            {(['market', 'limit', 'dca'] as Mode[]).map((m) => (
              <button key={m} onClick={() => setMode(m)} className={clsx('font-medium', mode === m ? 'text-t1' : 'text-t3 hover:text-t2')}>{m === 'market' ? tr('tp.market') : m === 'limit' ? tr('tp.limit') : 'DCA'}</button>
            ))}
            <span className="ml-auto text-sm text-t3 whitespace-nowrap">{side === 'buy' ? (tw.multi ? tr('tp.balTotal', { v: bnb(bal, 4) }) : `${bnb(bal, 4)} BNB`) : pos ? `${compact(pos.amount)} ${t.symbol}` : tr('tp.noPos')}</span>
          </div>
          <OrderForm key={side + mode} t={t} side={side} mode={mode} />
        </>
      )}
      {t.gangFly && <div className="-mx-3"><FlyCard t={t} compactMode /></div>}
      <AuditBox token={t.address} />
      <CondList t={t} />
      <Momentum t={t} />
      {pos && <PositionMini t={t} />}
    </div>
  )
}

function FairNotice({ t }: { t: Token }) {
  const tr = useT()
  const f = t.gangFair!
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="rounded-sm bg-btn p-3 space-y-2">
        <div className="text-md font-medium">{tr('tp.fairTitle')}</div>
        <div className="text-sm text-t2 leading-6">{tr('tp.fairDesc', { n: f.totalShares })}</div>
        <div className="grid grid-cols-2 gap-2 pt-1 text-sm">
          {[[tr('tp.sharePrice'), `${+f.sharePrice.toPrecision(4)} ${t.quote}`], [tr('tp.subscribed'), tr('tp.shares', { sold: f.sold, total: f.totalShares })], [tr('tp.perWalletCap'), tr('tp.nShares', { n: f.capShares })], [tr('tp.walletsNeeded'), f.minWalletsLeft > 0 ? tr('tp.atLeast', { n: f.minWalletsLeft }) : tr('tp.reached')]].map(([k, v]) => (
            <div key={k} className="rounded-xs bg-card px-2.5 py-1.5"><div className="text-xs text-t3">{k}</div><div className="font-medium mt-0.5">{v}</div></div>
          ))}
        </div>
      </div>
      <a href={`https://gang.fun/token/${t.address}`} target="_blank" rel="noreferrer" className="h-10 rounded-sm bg-up text-on-accent text-md font-semibold flex items-center justify-center gap-2 hover:brightness-110">{tr('tp.fairGo')}<G n="Newtab16pxRegular" className="ico" /></a>
      <div className="text-xs text-t3 leading-5">{tr('tp.fairNote')}</div>
    </div>
  )
}

function OrderForm({ t, side, mode }: { t: Token; side: 'buy' | 'sell'; mode: Mode }) {
  const tr = useT()
  const [amt, setAmt] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pv, setPv] = useState<Preview | null>(null)
  const [mc, setMc] = useState('')
  const [expire, setExpire] = useState(24)
  const [parts, setParts] = useState('5')
  const [interval, setIntervalSec] = useState(60)
  const [guard, setGuard] = useState('')
  const preset = usePrefs((s) => s.activePreset)
  const presets = usePrefs((s) => s.presets)
  const buyAmounts = usePrefs((s) => s.buyAmounts)
  const sellPcts = usePrefs((s) => s.sellPcts)
  const setP = usePrefs((s) => s.set)
  const wallets = useApp((s) => s.wallets)
  const tw = useTradeWallets()
  const mode2 = useApp((s) => s.mode)
  const feeRate = useApp((s) => s.feeRate)
  const setUI = useUI((s) => s.set)
  const params = presets[preset][side]
  const quick = side === 'buy' ? buyAmounts : sellPcts
  const n = Number(amt)
  const target = parseMc(mc)
  const cur = t.mcapUsd || 0

  useEffect(() => {
    setPv(null)
    if (!(n > 0) || mode !== 'market' || tw.multi) return   // 多钱包的按钱包预览在确认框里（/api/order/preview）
    const h = setTimeout(() => {
      api<Preview>(`/api/preview?wallet=${wallets.find((w) => tw.selected.includes(w.slot || 1))?.id || wallets[0]?.id || 'baw'}&token=${t.address}&side=${side}&amount=${n}&slippage=${params.slippage}`).then(setPv).catch((e) => setPv({ error: e.message }))
    }, 350)
    return () => clearTimeout(h)
  }, [n, side, t.address, params.slippage, mode, tw.multi]) // eslint-disable-line

  const saveQuick = (i: number, v: string) => {
    const x = Number(v); if (!(x > 0)) return
    const arr = [...quick]; arr[i] = side === 'sell' ? Math.min(100, x) : x
    setP(side === 'buy' ? { buyAmounts: arr } : { sellPcts: arr })
  }
  // 限价：买单目标要低于现价、卖单要高于现价，否则会立刻成交（提示用户改用市价）
  const limitWrong = mode === 'limit' && target > 0 && cur > 0 && (side === 'buy' ? target >= cur : target <= cur)
  const ready = n > 0 && (mode !== 'limit' || (target > 0 && !limitWrong)) && (mode !== 'dca' || Number(parts) >= 2)

  const submit = async () => {
    if (!ready || busy) return
    setBusy(true)
    try {
      if (mode === 'market') { if (side === 'buy') await buy(t, { amount: n, preset }); else await sell(t, Math.min(100, n), preset) }
      else if (mode === 'limit') {
        const ok = await createCond({ kind: 'limit', side, token: t.address, amount: side === 'buy' ? n : undefined, pct: side === 'sell' ? Math.min(100, n) : undefined, triggerMc: target, slippage: params.slippage, expireAt: expire ? Date.now() + expire * 3600_000 : null }, tr(side === 'buy' ? 'tp.limitBuy' : 'tp.limitSell'))
        if (ok) { setAmt(''); setMc('') }
      } else {
        const ok = await createCond({ kind: 'dca', side, token: t.address, amount: side === 'buy' ? n : undefined, pct: side === 'sell' ? Math.min(100, n) : undefined, parts: Number(parts), intervalSec: interval, guardMc: parseMc(guard) || null, slippage: params.slippage }, ' DCA')
        if (ok) setAmt('')
      }
    } finally { setBusy(false) }
  }
  const pctBtns = side === 'buy' ? [-10, -20, -30, -50] : [20, 50, 100, 200]
  const label = mode === 'market'
    ? tw.multi
      ? (side === 'buy' ? (n > 0 ? tr('tp.btnBuyMulti', { total: bnb(n * tw.picked.length), w: tw.picked.length, each: n }) : tr('tp.btnBuyMultiNoAmt', { w: tw.picked.length })) : (n > 0 ? tr('tp.btnSellMulti', { p: n, w: tw.picked.length }) : tr('tp.btnSellMultiNoAmt', { w: tw.picked.length })))
      : (side === 'buy' ? (n > 0 ? tr('tp.btnBuyAmt', { n }) : tr('tp.buy')) : (n > 0 ? tr('tp.btnSellPct', { p: n }) : tr('tp.sell')))
    : mode === 'limit' ? tr(side === 'buy' ? 'tp.createLimitBuy' : 'tp.createLimitSell') : tr(side === 'buy' ? 'tp.startDcaBuy' : 'tp.startDcaSell')
  return (
    <>
      {mode === 'limit' && (
        <div className="rounded-sm bg-btn overflow-hidden">
          <label className="flex items-center h-11 px-3 gap-2 border-b border-line">
            <span className="text-t3 text-base">{tr('tp.mc')}</span>
            <input value={mc} onChange={(e) => setMc(e.target.value)} placeholder={cur ? compact(cur) : tr('tp.egMc')} className="flex-1 text-right text-lg font-medium" />
            <span className="text-t2 text-base">USD</span>
          </label>
          <div className="grid grid-cols-4 h-8">
            {pctBtns.map((p) => <button key={p} onClick={() => setMc(compact(cur * (1 + p / 100), 2))} className="text-sm text-t2 border-r border-line last:border-r-0 hover:bg-btn-2">{p > 0 ? '+' : ''}{p}%</button>)}
          </div>
        </div>
      )}
      <div className="rounded-sm bg-btn overflow-hidden">
        <label className="flex items-center h-11 px-3 gap-2 border-b border-line">
          <span className="text-t3 text-base">{side === 'buy' ? (mode === 'dca' ? tr('tp.total') : tr('tp.amount')) : tr('tp.ratio')}{tw.multi && side === 'buy' ? <span className="text-t4 text-sm">{tr('tp.perWallet')}</span> : ''}</span>
          <input value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0.0" inputMode="decimal"
            className="flex-1 text-right text-lg font-medium" onKeyDown={(e) => { if (e.key === 'Enter') submit() }} />
          <span className="text-t2 text-base">{side === 'buy' ? 'BNB' : '%'}</span>
        </label>
        <div className="grid grid-cols-[1fr_1fr_1fr_1fr_32px] h-9">
          {quick.map((q, i) => editing
            ? <input key={i} defaultValue={q} onBlur={(e) => saveQuick(i, e.target.value)} className="text-center text-sm border-r border-line bg-card-2" />
            : <button key={i} onClick={() => setAmt(String(q))} className={clsx('text-sm border-r border-line hover:bg-btn-2', Number(amt) === q ? 'text-t1 bg-btn-2' : 'text-t2')}>{q}{side === 'sell' ? '%' : ''}</button>)}
          <button className={clsx('icon-btn rounded-none', editing && 'text-up')} title={editing ? tr('tp.done') : tr('tp.editQuick')} onClick={() => setEditing(!editing)}>{editing ? <Check className="ico" /> : <Pencil className="ico-sm" />}</button>
        </div>
      </div>
      {mode === 'limit' && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-t3">{tr('tp.expiry')}</span>
          <div className="seg h-7 flex-1">{[1, 24, 168, 0].map((h) => <button key={h} className="flex-1" data-on={expire === h} onClick={() => setExpire(h)}>{tr('tp.exp.' + h)}</button>)}</div>
        </div>
      )}
      {mode === 'dca' && (
        <div className="grid grid-cols-2 gap-2 text-sm">
          <label className="input-box h-9 px-2"><span className="text-t3">{tr('tp.parts')}</span><input value={parts} onChange={(e) => setParts(e.target.value.replace(/\D/g, ''))} className="flex-1 text-right" /></label>
          <label className="input-box h-9 px-2"><span className="text-t3">{tr('tp.interval')}</span>
            <select value={interval} onChange={(e) => setIntervalSec(Number(e.target.value))} className="flex-1 bg-transparent text-right outline-none">
              {[30, 60, 300, 900, 3600].map((v) => <option key={v} value={v} className="bg-card">{tr('tp.iv.' + v)}</option>)}
            </select>
          </label>
          <label className="input-box h-9 px-2 col-span-2"><span className="text-t3 whitespace-nowrap">{side === 'buy' ? tr('tp.mcAbove') : tr('tp.mcBelow')}</span><input value={guard} onChange={(e) => setGuard(e.target.value)} placeholder={tr('tp.optionalMc')} className="flex-1 text-right" /><span className="text-t3 whitespace-nowrap">{tr('tp.skip')}</span></label>
          {n > 0 && Number(parts) >= 2 && <div className="col-span-2 text-xs text-t3">{tr('tp.dcaSum', { iv: interval >= 60 ? tr('tp.nMin', { n: interval / 60 }) : tr('tp.nSec', { n: interval }), act: side === 'buy' ? tr('tp.dcaBuyEach', { v: bnb(n / Number(parts), 4) }) : tr('tp.dcaSellOne'), parts })}</div>}
        </div>
      )}
      {mode === 'market' && (tw.multi
        ? <div className="h-4 text-xs text-t3">{!(n > 0) ? tr('tp.multiIdle', { w: tw.picked.length }) : side === 'buy' ? tr('tp.multiBuySum', { w: tw.picked.length, n, total: bnb(n * tw.picked.length) }) : tr('tp.multiSellSum', { w: tw.picked.length, n })}</div>
        : <QuoteLine pv={pv} side={side} t={t} n={n} />)}
      {limitWrong && <div className="text-xs text-warn">{tr(side === 'buy' ? 'tp.limitBuyWrong' : 'tp.limitSellWrong', { now: usd(cur) })}</div>}
      {mode === 'limit' && target > 0 && !limitWrong && <div className="text-xs text-t3">{tr(side === 'buy' ? 'tp.limitBuySum' : 'tp.limitSellSum', { mc: usd(target), n: n || '—', diff: cur ? pct((target / cur - 1) * 100, 1) : '—' })}</div>}
      <button disabled={!ready || busy} onClick={submit}
        className={clsx('h-10 rounded-sm text-md font-semibold transition-[filter] disabled:opacity-45 hover:brightness-110 flex items-center justify-center gap-2',
          side === 'buy' ? 'bg-up text-on-accent' : 'bg-down text-white')}>
        {busy && <Loader2 className="ico spin" />}{label}
      </button>
      {/* 当前预设的参数摘要，点击改预设；真实下单时不再写「实盘」，模拟 / 演示时仍提示 */}
      <button onClick={() => setUI({ settingsOpen: true })} title={tr('tp.editPreset')} className="flex items-center gap-3 text-sm text-t3 hover:text-t2 self-start">
        <span>P{preset}</span><span>{tr('tp.slip', { v: params.slippage })}</span>
        <span className="flex items-center gap-0.5"><Fuel className="ico-sm" />{gasLabel(params.gas)}</span>
        <span>{params.mev !== false ? tr('tp.mevOn') : tr('tp.mevOff')}</span>
        {feeRate > 0 && <span>{tr('tp.feeRate', { v: +(feeRate * 100).toFixed(2) })}</span>}
        {!(mode2 === 'live' && isReal()) && <span className="text-warn">{mode2 !== 'live' ? tr('mode.sim') : tr('mode.demo')}</span>}
      </button>
    </>
  )
}

/** 自动（止盈止损）：按持仓买入均价算目标市值；止盈、止损各最多 4 档，每档触发时卖出当时持仓的一定比例 */
type Tier = { move: number; pct: number }
const MAX_TIERS = 4
function AutoTab({ t }: { t: Token }) {
  const tr = useT()
  const pos = useApp((s) => s.holdings?.rows.find((r) => lc(r.token) === lc(t.address)))
  const preset = usePrefs((s) => s.activePreset)
  const slip = usePrefs((s) => s.presets[preset].sell.slippage)
  const toast = useApp((s) => s.toast)
  const [tp, setTp] = useState<Tier[]>([{ move: 100, pct: 50 }])
  const [sl, setSl] = useState<Tier[]>([{ move: 50, pct: 100 }])
  const [useTp, setUseTp] = useState(true)
  const [useSl, setUseSl] = useState(true)
  const [busy, setBusy] = useState(false)
  // 参考市值：有买入均价就用均价对应的市值，否则用现价
  const base = pos?.avgBuyUsd && t.priceUsd > 0 ? t.mcapUsd * (pos.avgBuyUsd / t.priceUsd) : t.mcapUsd
  const plan = [
    ...(useTp ? tp.map((r) => ({ kind: 'tp' as const, ...r, mc: base * (1 + r.move / 100), bad: !(r.move > 0) ? tr('tp.errUp') : !(r.pct > 0 && r.pct <= 100) ? tr('tp.errPct') : '' })) : []),
    ...(useSl ? sl.map((r) => ({ kind: 'sl' as const, ...r, mc: base * (1 - r.move / 100), bad: !(r.move > 0 && r.move < 100) ? tr('tp.errDown') : !(r.pct > 0 && r.pct <= 100) ? tr('tp.errPct') : '' })) : []),
  ]
  const bad = plan.find((x) => x.bad)?.bad || (!(base > 0) ? tr('tp.noMc') : '')
  const create = async () => {
    if (!authOk()) { toast({ kind: 'error', title: tr('tp.walletOff'), body: tr('tp.condNeedWallet') }); useUI.getState().set({ loginOpen: true }); return }
    setBusy(true)
    const fails: string[] = []
    try {
      for (const x of plan) {
        const name = tr(x.kind === 'tp' ? 'tp.tpName' : 'tp.slName', { v: x.move })
        try { await api('/api/cond', { kind: x.kind, token: t.address, pct: x.pct, triggerMc: x.mc, slippage: slip }) } catch (e: any) { fails.push(`${name}：${e.message}`) }
      }
    } finally { setBusy(false) }
    const ok = plan.length - fails.length
    if (fails.length) toast({ kind: 'error', title: ok ? tr('tp.createdPartial', { ok, fail: fails.length }) : tr('tp.createFailedAll'), body: fails.join(' · ') })
    else toast({ kind: 'ok', title: tr('tp.createdN', { n: ok }), body: tr('tp.createdNBody') })
  }
  return (
    <div className="space-y-4">
      <div className="text-sm text-t3">{tr('tp.refMc')} <span className="text-t1">{usd(base)}</span>{pos?.avgBuyUsd ? tr('tp.byAvg') : tr('tp.byNow')}</div>
      {!pos && <div className="text-xs text-warn -mt-2">{tr('tp.noPosWarn')}</div>}
      <TierGroup title={tr('tp.tp')} tone="up" word={tr('tp.rise')} on={useTp} setOn={setUseTp} rows={tp} setRows={setTp} base={base} dir={1} />
      <TierGroup title={tr('tp.sl')} tone="down" word={tr('tp.drop')} on={useSl} setOn={setUseSl} rows={sl} setRows={setSl} base={base} dir={-1} />
      {bad && plan.length > 0 && <div className="text-xs text-warn">{bad}</div>}
      <button disabled={busy || !plan.length || !!bad} onClick={create} className="w-full h-10 rounded-sm bg-btn-2 text-t1 font-semibold hover:bg-hover-2 flex items-center justify-center gap-2 disabled:opacity-50">
        {busy && <Loader2 className="ico spin" />}{plan.length ? tr('tp.createN', { n: plan.length }) : tr('tp.needOne')}
      </button>
      <div className="text-xs text-t4 leading-5">{tr('tp.autoNote', { p: preset })}</div>
    </div>
  )
}

/** 止盈 / 止损的一组档位：标题 + 开关；每档「涨幅/跌幅 · 卖出比例」，下面一行写清楚触发市值。只有一档时不显示删除 */
function TierGroup({ title, tone, word, on, setOn, rows, setRows, base, dir }: {
  title: string; tone: 'up' | 'down'; word: string; on: boolean; setOn: (v: boolean) => void; rows: Tier[]; setRows: (r: Tier[]) => void; base: number; dir: 1 | -1
}) {
  const tr = useT()
  const set = (i: number, patch: Partial<Tier>) => setRows(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const next = () => { const last = rows[rows.length - 1]; setRows([...rows, dir > 0 ? { move: (last?.move || 50) * 2, pct: 50 } : { move: Math.min(90, (last?.move || 30) + 20), pct: 100 }]) }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className={clsx('text-sm font-medium', on ? (tone === 'up' ? 'text-up' : 'text-down') : 'text-t3')}>{title}</span>
        <Switch on={on} onChange={setOn} label={title} />
      </div>
      {on && rows.map((r, i) => (
        <div key={i} className="space-y-1">
          <div className="flex items-center gap-2">
            <NumField value={r.move} onCommit={(v) => set(i, { move: v })} prefix={word} unit="%" align="right" w="flex-1 min-w-0" />
            <NumField value={r.pct} onCommit={(v) => set(i, { pct: v })} prefix={tr('tp.sellPrefix')} unit="%" align="right" w="flex-1 min-w-0" />
            {rows.length > 1 && <button className="icon-btn w-8 h-8 flex-none" title={tr('tp.removeTier', { title })} onClick={() => setRows(rows.filter((_, j) => j !== i))}><X className="ico-sm" /></button>}
          </div>
          <div className="text-xs text-t4">{tr(dir > 0 ? 'tp.tierUp' : 'tp.tierDown', { mc: base > 0 && r.move > 0 && (dir > 0 || r.move < 100) ? usd(base * (1 + dir * r.move / 100)) : '—', p: r.pct > 0 ? `${r.pct}%` : '—' })}</div>
        </div>
      ))}
      {on && rows.length < MAX_TIERS && <button onClick={next} className="flex items-center gap-1 text-sm text-t3 hover:text-t1"><Plus className="ico-sm" />{tr('tp.addTier', { title })}</button>}
    </div>
  )
}

const kindLabel = (k: string) => T('cond.kind.' + k)
export const condDesc = (o: CondOrder) =>
  o.kind === 'dca'
    ? T('cond.dcaDesc', { act: o.side === 'buy' ? T('cond.buyAmt', { v: bnb(o.amount) }) : T('cond.sellPct', { p: o.pct }), done: o.done ?? 0, parts: o.parts, iv: (o.intervalSec || 0) >= 60 ? T('cond.min', { n: (o.intervalSec || 0) / 60 }) : T('cond.sec', { n: o.intervalSec }) })
    : `${o.side === 'buy' ? T('cond.buyAmt', { v: bnb(o.amount) }) : T('cond.sellPct', { p: o.pct })} · MC ${o.cmp === 'lte' ? '≤' : '≥'} ${usd(o.triggerMc)}`
export const statusLabel = (s: string) => T('cond.st.' + s)

function CondList({ t }: { t: Token }) {
  const tr = useT()
  const all = useApp((s) => s.cond)
  const list = useMemo(() => all.filter((o) => lc(o.token) === lc(t.address) && (o.status === 'open' || o.status === 'running' || Date.now() - o.createdAt < 3600_000)), [all, t.address])
  if (!list.length) return null
  return (
    <div className="rounded-sm border border-line">
      <div className="px-3 py-2 border-b border-line text-sm font-medium flex">{tr('tp.orders')}<span className="text-t3 ml-1">{list.filter((o) => o.status === 'open').length}</span></div>
      {list.map((o) => (
        <div key={o.id} className="flex items-center gap-2 px-3 py-2 border-b border-line last:border-b-0 text-sm">
          <span className={clsx('px-1.5 rounded-xs text-xs', o.side === 'buy' ? 'bg-up/14 text-up' : 'bg-down/14 text-down')}>{kindLabel(o.kind)}</span>
          <span className="flex-1 min-w-0 truncate text-t2" title={lz(o.results[o.results.length - 1]?.reason)}>{o.slots?.length ? <span className="text-t4 mr-1">{o.slots.map((n) => `W${n}`).join('·')}</span> : ''}{condDesc(o)}</span>
          <span className={clsx('text-xs', o.status === 'open' ? 'text-warn' : o.status === 'done' ? 'text-up' : 'text-t3')}>{statusLabel(o.status)}</span>
          {o.status === 'open' ? <button className="icon-btn w-6 h-6 hover:!text-down" title={tr('tp.cancel')} onClick={() => api('/api/cond/cancel', { id: o.id })}><X className="ico-sm" /></button>
            : <button className="icon-btn w-6 h-6" title={tr('tp.removeRecord')} onClick={() => api('/api/cond/remove', { id: o.id })}><Trash2 className="ico-sm" /></button>}
        </div>
      ))}
    </div>
  )
}

function QuoteLine({ pv, side, t, n }: { pv: Preview | null; side: 'buy' | 'sell'; t: Token; n: number }) {
  const tr = useT()
  if (!(n > 0)) return <div className="h-4 text-xs text-t4">{side === 'buy' ? `1 BNB ≈ ${t.price > 0 ? compact(1 / t.price) : '—'} ${t.symbol}` : tr('tp.sellByPct')}</div>
  if (!pv) return <div className="h-4 text-xs text-t3 flex items-center gap-1"><Loader2 className="w-3 h-3 spin" />{tr('tp.quoting')}</div>
  if (pv.error) return <div className="text-xs text-down">{pv.error}</div>
  return (
    <div className="text-xs text-t3 space-y-0.5">
      {pv.out != null && <div className="flex justify-between"><span>{tr('tp.expect')}</span><span className="text-t1">{side === 'buy' ? `${compact(pv.out)} ${t.symbol}` : `${bnb(pv.out)} ${t.quote}`}</span></div>}
      {pv.minOut != null && <div className="flex justify-between"><span>{tr('tp.minOut')}</span><span className="text-t2">{side === 'buy' ? compact(pv.minOut) : bnb(pv.minOut)}</span></div>}
      {pv.feePct != null && <div className="flex justify-between"><span>{tr('tp.fee')}</span><span className="text-t2">{pv.feePct.toFixed(2)}%</span></div>}
      {pv.route && <div className="truncate text-t4" title={pv.route}>{pv.route}</div>}
      {pv.note && <div className="text-warn">{lz(pv.note)}</div>}
    </div>
  )
}

/** 币安公开安全审计（GMGN 的「代币风险提示」） */
export function AuditBox({ token }: { token: string }) {
  const tr = useT()
  const [a, setA] = useState<Audit | null>(null)
  useEffect(() => { setA(null); api<Audit>(`/api/audit/${token}`).then(setA).catch((e) => setA({ available: false, reason: 'error', error: e.message })) }, [token])
  // 钱包设为「自动拒绝」时，币安判为高风险的代币买得进、卖不出（实测 Gang 2.0、铸币飞轮的币会这样）：加重提示
  const slot = useApp((s) => s.slots?.tradeSlots?.[0] ?? s.slots?.primary ?? 1)
  const [autoReject, setAutoReject] = useState(false)
  useEffect(() => { if (!a?.appConfirm) return; api<{ abnormalTxnHandling?: string }>(`/api/wallet-settings?slot=${slot}`).then((v) => setAutoReject(v?.abnormalTxnHandling === 'AutoReject')).catch(() => {}) }, [a?.appConfirm, slot])
  if (!a) return <div className="h-9 rounded-sm bg-btn flex items-center gap-2 px-3 text-sm text-t3"><Loader2 className="ico-sm spin" />{tr('tp.auditLoading')}</div>
  if (!a.available) return (
    <div className="rounded-sm bg-btn flex items-center gap-2 px-3 py-2 text-sm text-t3">
      <ShieldAlert className="ico" />{tr('tp.auditNone', { r: tr(a.reason === 'pending' ? 'tp.auditPending' : a.reason === 'unsupported' ? 'tp.auditUnsupported' : 'tp.auditFailed') })}
    </div>
  )
  const lv = a.level ?? 0, hi = lv >= 4, mid = lv >= 2
  const tags = [a.verified === false && tr('tp.tagUnverified'), a.unusualTax && tr('tp.tagTax'), a.flagged && tr('tp.tagFlagged'), a.reported && tr('tp.tagReported')].filter(Boolean) as string[]
  return (
    <div className={clsx('rounded-sm px-3 py-2 text-sm', hi ? 'bg-down/10 text-down' : mid ? 'bg-warn/10 text-warn' : 'bg-btn text-t2')}>
      <div className="flex items-center gap-2">
        {hi || mid ? <AlertTriangle className="ico" /> : <ShieldCheck className="ico text-up" />}
        <span className="font-medium">{tr('tp.auditLevel', { lv: tr(hi ? 'tp.riskHigh' : mid ? 'tp.riskMid' : 'tp.riskLow') })}</span>
        <span className="text-t3">{lv}/5{a.buyTax != null ? tr('tp.taxShort', { b: a.buyTax, s: a.sellTax ?? '—' }) : ''}</span>
      </div>
      {!!tags.length && <div className="mt-1 text-xs">{tags.join(' · ')}</div>}
      {!!a.hits?.length && <div className="mt-1.5 flex flex-wrap gap-1">{a.hits.map((h, i) => <span key={i} title={h.desc} className={clsx('px-1.5 rounded-xs text-xs', h.type === 'RISK' ? 'bg-down/14 text-down' : 'bg-warn/14 text-warn')}>{h.title}</span>)}</div>}
      {a.appConfirm && (autoReject ? <div className="mt-1.5 text-xs text-down font-medium leading-5">{tr('tp.autoRejectWarn')}</div> : <div className="mt-1.5 text-xs text-warn">{tr('tp.appConfirm')}</div>)}
    </div>
  )
}

function Momentum({ t }: { t: Token }) {
  const tr = useT()
  const bnbUsd = useApp((s) => s.bnbUsd)
  const vol = (t.volume || 0) * (t.quoteUsd || bnbUsd)
  const cells: [string, number | null | undefined][] = [['5m', t.chg?.m5], ['1h', t.chg?.h1], ['24h', t.chg?.h24], [tr('tp.sinceLaunch'), t.chg?.launch]]
  return (
    <div className="rounded-sm border border-line">
      <div className="grid grid-cols-4">
        {cells.map(([k, v]) => (
          <div key={k} className="py-2 text-center">
            <div className="text-xs text-t3">{k}</div>
            <div className={clsx('text-base font-medium', v == null ? 'text-t4' : v >= 0 ? 'text-up' : 'text-down')}>{v == null ? '—' : pct(v)}</div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 border-t border-line text-sm">
        <div className="py-2 text-center"><div className="text-xs text-t3">{tr('tp.volume')}</div><div>{usd(vol)}</div></div>
        <div className="py-2 text-center"><div className="text-xs text-t3">{tr('tp.buys')}</div><div className="text-up">{t.buys || 0}</div></div>
        <div className="py-2 text-center"><div className="text-xs text-t3">{tr('tp.sells')}</div><div className="text-down">{t.sells || 0}</div></div>
      </div>
    </div>
  )
}

function PositionMini({ t }: { t: Token }) {
  const tr = useT()
  const r = useApp((s) => s.holdings?.rows.find((x) => lc(x.token) === lc(t.address)))
  const sellPcts = usePrefs((s) => s.sellPcts)
  const preset = usePrefs((s) => s.activePreset)
  if (!r || !(r.amount > 0)) return null
  return (
    <div className="rounded-sm border border-line p-3 space-y-2">
      <div className="flex justify-between text-sm"><span className="text-t3">{tr('tp.myPos')}</span><span>{compact(r.amount)} {t.symbol}</span></div>
      <div className="flex justify-between text-sm"><span className="text-t3">{tr('tp.value')}</span><span>{usd(r.valueUsd)}</span></div>
      <div className="flex justify-between text-sm"><span className="text-t3">{tr('tp.pnl')}</span><span className={r.pnlUsd == null ? 'text-t3' : r.pnlUsd >= 0 ? 'text-up' : 'text-down'}>{r.pnlUsd == null ? '—' : `${r.pnlUsd >= 0 ? '+' : '-'}$${Math.abs(r.pnlUsd).toFixed(2)}`}{r.pnlPct != null && ` (${pct(r.pnlPct)})`}</span></div>
      {r.avgBuyUsd != null && <div className="flex justify-between text-sm"><span className="text-t3">{tr('tp.avg')}</span><span>${small(r.avgBuyUsd)}</span></div>}
      {r.firstAt && <div className="flex justify-between text-sm"><span className="text-t3">{tr('tp.held')}</span><span>{age(r.firstAt)}</span></div>}
      <div className="grid grid-cols-4 gap-1">
        {sellPcts.map((p) => <button key={p} onClick={() => sell(t, p, preset)} className="h-7 rounded-xs bg-down/8 text-down text-sm hover:bg-down/18">{p}%</button>)}
      </div>
    </div>
  )
}
