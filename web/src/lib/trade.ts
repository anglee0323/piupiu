// 下单：套用 P1–P3 预设（滑点、Gas），按需弹确认，结果由 WebSocket 的 order 推送显示成提示。
// 多钱包：金额按「每个钱包」计，确认框按钱包分行预览（/api/order/preview），同一批的提示合成一个（store/app.ts）
import { api } from './api'
import { useApp } from '../store/app'
import { usePrefs, type PresetId } from '../store/prefs'
import { useUI } from '../store/ui'
import type { Order, Token } from './types'
import { bnb, compact } from './format'
import { t, lz } from './i18n'
const tr = t   // 下面的函数里 t 是代币参数，文案用 tr()

export const gasLabel = (g: string) => (['normal', 'high', 'turbo'].includes(g) ? t(`gas.${g}`) : g)

/** 实盘真实下单（LIVE_TRADE=1）；否则只报价 / 模拟 */
export const isReal = () => { const s = useApp.getState(); return s.mode === 'live' && s.baw?.dryRun === false }
export const authOk = () => { const s = useApp.getState(); return s.mode !== 'live' || s.baw?.auth?.state === 'ok' || (s.slots?.slots || []).some((x) => x.auth === 'ok') }
export const modeText = () => (useApp.getState().mode !== 'live' ? t('trd.sim') : isReal() ? t('trd.live') : t('trd.demo'))

/** 平台默认快买：每列金额为 0 时按总量百分比买（Flap 2%、其他 1%，和合约单钱包上限一致） */
export const defaultPct = (t?: Token | null) => (t?.platform === 'flap' ? 2 : 1)

async function ensureGas(gas: string) {
  const cur = useApp.getState().settings?.gas
  if (cur !== gas) await api('/api/settings', { gas }).catch(() => {})
}

/** 需要钱包的操作先调这个：没有已连接的钱包就打开扫码登录并返回 false（模拟盘不需要钱包） */
export function requireWallet(): boolean {
  if (authOk()) return true
  useUI.getState().set({ loginOpen: true, loginSlot: useApp.getState().slots?.primary || 1, connectHint: false })
  return false
}
const guard = requireWallet

async function send(body: Record<string, unknown>, label: string): Promise<Order[] | null> {
  const app = useApp.getState()
  const pid = 'req-' + Math.random().toString(36).slice(2)
  const req = `${String(body.token).toLowerCase()}:${body.side}`
  app.toast({ id: pid, kind: 'info', title: label, body: t('trd.sent'), req })   // 服务器的订单一推过来就会替换掉它（见 store/app.ts），不会出现两个
  try {
    const r = [].concat(await api('/api/order', { source: '手动', ...body })) as Order[]   // i18n-ignore（来源白名单里的值，不是界面文案）
    app.dropToast(pid)
    return r
  } catch (e: any) {
    app.dropToast(pid)
    // 订单已经创建又失败时，服务器推的订单提示里已经写了原因，这里不再重复弹一个；没创建出订单（登录过期、超过上限等）才在这里提示
    await new Promise((ok) => setTimeout(ok, 400))
    const dup = useApp.getState().toasts.some((x) => (x.batchId || (x.kind === 'order' && x.order && `${String(x.order.token).toLowerCase()}:${x.order.side}` === req)) && Date.now() - x.at < 15_000)
    if (!dup) app.toast({ kind: 'error', title: t('trd.failed', { label }), body: e.message })
    return null
  }
}

/** 多钱包时按钱包拿预览（确认框分行显示）；单钱包返回 null（走原来的固定行） */
async function previewRows(t: Token, body: Record<string, unknown>): Promise<{ slot: number; label: string; text: string; warn?: string }[] | null> {
  const sel = useApp.getState().slots?.tradeSlots || []
  if (sel.length < 2) return null
  try {
    const r = await api<{ rows: { slot: number; label: string; amountIn?: number; out?: number | null; note?: string | null; skip?: string | null }[] }>('/api/order/preview', body)
    return (r.rows || []).map((x) => ({
      slot: x.slot, label: x.label,
      text: x.skip ? lz(x.skip) : body.side === 'buy' ? `${bnb(x.amountIn ?? 0)} BNB${x.out ? ` → ${tr('trd.approx', { v: compact(x.out) })}` : ''}` : `${x.out != null ? tr('trd.approx', { v: `${bnb(x.out)} ${t.quote}` }) : ''}${x.note ? ` (${lz(x.note)})` : ''}`,
      warn: lz(x.skip || x.note) || undefined,
    }))
  } catch { return null }
}

export async function buy(t: Token, o: { amount?: number; pctSupply?: number; preset: PresetId; via?: 'quick' | null }) {
  if (!guard()) return null
  const p = usePrefs.getState().presets[o.preset].buy
  const sel = useApp.getState().slots?.tradeSlots || []
  const multi = sel.length > 1
  const what = o.amount && o.amount > 0 ? `${bnb(o.amount)} BNB${multi ? tr('trd.perWallet') : ''}` : `${tr('trd.supplyPct', { p: o.pctSupply ?? defaultPct(t) })}${multi ? tr('trd.perWallet') : ''}`
  const body = o.amount && o.amount > 0
    ? { token: t.address, side: 'buy', amount: o.amount, slippage: p.slippage, via: o.via ?? null, symbol: t.symbol, mev: p.mev !== false, gas: p.gas }
    : { token: t.address, side: 'buy', amount: 0, pctSupply: o.pctSupply ?? defaultPct(t), slippage: p.slippage, via: o.via ?? null, symbol: t.symbol, mev: p.mev !== false, gas: p.gas }
  if (usePrefs.getState().confirmOrders) {
    const rows = await previewRows(t, body)
    const ok = await useUI.getState().ask({
      title: tr('trd.buyTitle', { s: t.symbol }), okText: tr('trd.buyOk'), order: true,
      rows: rows
        ? rows.map((r): [string, string] => [`W${r.slot} ${lz(r.label)}`, r.text])
        : [[tr('trd.amount'), what], [tr('trd.slip'), `${p.slippage}%`], ['Gas', gasLabel(p.gas)]],
      note: multi ? `${tr('trd.multiBuy', { n: sel.length })}${isReal() ? tr('trd.final') : ''}` : isReal() ? tr('trd.realNote') : tr('trd.demoNote'),
    })
    if (!ok) return null
  }
  await ensureGas(p.gas)
  return send(body, tr('trd.buyLabel', { s: t.symbol, what }))
}

export async function sell(t: Token, pctOfHolding: number, preset: PresetId) {
  if (!guard()) return null
  const p = usePrefs.getState().presets[preset].sell
  const sel = useApp.getState().slots?.tradeSlots || []
  const multi = sel.length > 1
  const body = { token: t.address, side: 'sell', amount: pctOfHolding, slippage: p.slippage, symbol: t.symbol, mev: p.mev !== false, gas: p.gas }
  if (usePrefs.getState().confirmOrders) {
    const rows = await previewRows(t, body)
    const ok = await useUI.getState().ask({
      title: tr('trd.sellTitle', { s: t.symbol }), okText: tr('trd.sellOk'), danger: true, order: true,
      rows: rows
        ? rows.map((r): [string, string] => [`W${r.slot} ${lz(r.label)}`, r.text])
        : [[tr('trd.sell'), tr('trd.ofHolding', { p: pctOfHolding })], [tr('trd.slip'), `${p.slippage}%`], ['Gas', gasLabel(p.gas)]],
      note: multi ? `${tr('trd.multiSell', { p: pctOfHolding })}${isReal() ? tr('trd.final') : ''}` : isReal() ? tr('trd.realNote') : tr('trd.demoNote'),
    })
    if (!ok) return null
  }
  await ensureGas(p.gas)
  return send(body, tr('trd.sellLabel', { s: t.symbol, p: pctOfHolding }))
}

// ---------- 铸币飞轮（代币页飞轮卡片）----------
// 下单接口按 BNB 金额 / 卖出比例走，后端按每份价格向下取整成份数（gangFly.js）：这里把「N 份」换成刚好够 N 份的金额（多 0.0001%，不会多出一份）
const sharesToBnb = (n: number, perShare: number) => n * perShare * 1.000001

/** 开盘前铸造 N 份（perShare = 每份价格含铸造费），或开盘后铸造（post = true，perShare = 开盘后 1 份的实时价格） */
export async function flyMint(t: Token, shares: number, perShare: number, preset: PresetId, post = false) {
  if (!guard()) return null
  const p = usePrefs.getState().presets[preset].buy
  const sel = useApp.getState().slots?.tradeSlots || []
  const amount = sharesToBnb(shares, perShare)
  const body = { token: t.address, side: 'buy', amount, slippage: p.slippage, via: post ? 'fly-post' : null, symbol: t.symbol, mev: p.mev !== false, gas: p.gas }
  if (usePrefs.getState().confirmOrders) {
    const ok = await useUI.getState().ask({
      title: tr(post ? 'fly.postTitle' : 'fly.mintTitle', { s: t.symbol }), okText: tr('fly.mintOk'), order: true,
      rows: [[tr('fly.n'), String(shares)], [tr('fly.total'), `${bnb(amount)} BNB`], ...(post ? [[tr('trd.slip'), `${p.slippage}%`] as [string, string]] : [])],
      note: `${sel.length > 1 ? tr('fly.perWallet', { n: shares }) : ''}${isReal() ? tr('trd.realNote') : tr('trd.demoNote')}`,
    })
    if (!ok) return null
  }
  await ensureGas(p.gas)
  return send(body, tr(post ? 'fly.postLabel' : 'fly.mintLabel', { s: t.symbol, n: shares }))
}

/** 卖回 N 份开盘前铸造的份数（have = 现在持有的可卖回份数） */
export async function flySellBack(t: Token, shares: number, have: number, payout: number, preset: PresetId) {
  if (!guard()) return null
  const p = usePrefs.getState().presets[preset].sell
  const pct = Math.min(100, ((shares + 0.0001) * 100) / Math.max(1, have))
  const body = { token: t.address, side: 'sell', amount: pct, slippage: p.slippage, symbol: t.symbol, mev: p.mev !== false, gas: p.gas }
  if (usePrefs.getState().confirmOrders) {
    const ok = await useUI.getState().ask({
      title: tr('fly.backTitle', { s: t.symbol }), okText: tr('fly.backOk'), danger: true, order: true,
      rows: [[tr('fly.n'), String(shares)], [tr('fly.get'), `≈ ${bnb(payout)} BNB`]],
      note: isReal() ? tr('trd.realNote') : tr('trd.demoNote'),
    })
    if (!ok) return null
  }
  await ensureGas(p.gas)
  return send(body, tr('fly.backLabel', { s: t.symbol, n: shares }))
}

/** 领取持有人奖励（分红金库 claim） */
export async function flyClaim(t: Token, slot: number, amount: number) {
  if (!guard()) return null
  const ok = await useUI.getState().ask({ title: tr('fly.claimTitle'), okText: tr('fly.claimOk'), rows: [[tr('fly.reward'), `${bnb(amount)} BNB`]], note: isReal() ? tr('trd.realNote') : tr('trd.demoNote') })
  if (!ok) return null
  try { return await api('/api/gang/fly/claim', { token: t.address, slot }) } catch (e: any) { useApp.getState().toast({ kind: 'error', title: tr('fly.claimFailed'), body: lz(e.message) }); return null }
}
