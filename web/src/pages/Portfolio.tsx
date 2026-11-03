// 持仓（GMGN「资产」）：总览 + 持仓表（价值、成本、已卖出、盈亏，一键卖出）+ 订单记录
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { RefreshCw } from '../components/gi'
import clsx from 'clsx'
import { useApp } from '../store/app'
import { usePrefs } from '../store/prefs'
import { useUI } from '../store/ui'
import { api } from '../lib/api'
import { age, bnb, compact, pct, small, usd } from '../lib/format'
import { sell } from '../lib/trade'
import type { HoldingRow, NftSnap, RadarMint, Token } from '../lib/types'
import { TokenAvatar } from '../components/common'
import { NftDest, NFT_TRANSFER } from '../components/NftDest'
import { okxCollectionUrl } from '../lib/okx'
import { quickTransfer } from '../lib/nftTransfer'
import { WalletTag } from '../components/WalletPicker'
import { mintStatus } from './Radar'
import { CondTable, Orders, Empty } from './Token'
import { useT, t as L, lz } from '../lib/i18n'

export function PortfolioPage() {
  useT()   // 切换语言时重绘（下面用 L() 取文案；T 在这一页是合计数据）
  const h = useApp((s) => s.holdings)
  const orders = useApp((s) => s.orders)
  const tokens = useApp((s) => s.tokens)
  const bnbUsd = useApp((s) => s.bnbUsd)
  const preset = usePrefs((s) => s.activePreset)
  const nav = useNavigate()
  const [params] = useSearchParams()
  const [tab, setTab] = useState<'open' | 'all' | 'orders' | 'nft'>(params.get('tab') === 'nft' ? 'nft' : 'open')   // /portfolio?tab=nft：顶部持仓条的 NFT 点进来直接到 NFT 标签
  const nft = useApp((s) => s.nft)
  const [busy, setBusy] = useState(false)
  const rows = useMemo(() => (h?.rows || []).filter((r) => (tab === 'open' ? r.amount > 0 && (r.valueUsd ?? 1) >= 0.5 : true)), [h, tab])
  const refresh = async () => {
    setBusy(true)
    try {
      const holdings = await api('/api/holdings?refresh=1')
      const state = await api('/api/state')
      useApp.setState({ holdings, orders: state.orders || [] })
    } catch (e: any) {
      useApp.getState().toast({ kind: 'error', title: L('pf.refreshFailed'), body: e.message })
    } finally { setBusy(false) }
  }
  const T = h?.totals
  const asToken = (r: HoldingRow): Token => (tokens.get(r.token.toLowerCase()) || { ...r, address: r.token } as unknown as Token)
  const Box = ({ k, v, cls }: { k: string; v: React.ReactNode; cls?: string }) => (
    <div className="rounded-md bg-card border border-line px-4 py-3 min-w-0"><div className="text-sm text-t3">{k}</div><div className={clsx('text-2xl font-semibold mt-1', cls)}>{v}</div></div>
  )
  return (
    <div className="h-full scroll-y">
      <div className="p-5 space-y-4">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
          <Box k={L('pf.bnb')} v={<span>{bnb((h?.bnb ?? 0) + (h?.wbnb ?? 0), 4)} <span className="text-md text-t3">${(((h?.bnb ?? 0) + (h?.wbnb ?? 0)) * bnbUsd).toFixed(2)}</span></span>} />
          <Box k={L('pf.value')} v={usd(T?.valueUsd)} />
          <Box k={L('pf.bought')} v={usd(T?.costUsd)} />
          <Box k={L('pf.sold')} v={usd(T?.soldUsd)} />
          <Box k={L('pf.pnl')} v={T?.pnlUsd == null ? '—' : `${T.pnlUsd > 0 ? '+' : T.pnlUsd < 0 ? '-' : ''}$${Math.abs(T.pnlUsd).toFixed(2)}`} cls={!T?.pnlUsd ? 'text-t1' : T.pnlUsd > 0 ? 'text-up' : 'text-down'} />
        </div>
        {(h?.wbnb ?? 0) > 0 && <div className="text-xs text-t3 -mt-2">{L('pf.wbnb', { v: bnb(h!.wbnb!, 4) })}</div>}
        <QuoteBalances />
        <div className="rounded-md bg-card border border-line overflow-hidden">
          <div className="h-12 flex items-center gap-6 pl-4 pr-3.5 border-b border-line">
            <button className="tab" data-on={tab === 'open'} onClick={() => setTab('open')}>{L('pf.open')}{T?.open != null && <span className="ml-1.5 text-t3">{T.open}</span>}</button>
            <button className="tab" data-on={tab === 'all'} onClick={() => setTab('all')}>{L('pf.all')}</button>
            <button className="tab" data-on={tab === 'orders'} onClick={() => setTab('orders')}>{L('pf.orders')}</button>
            <button className="tab" data-on={tab === 'nft'} onClick={() => setTab('nft')}>NFT{nft?.rows?.length ? <span className="ml-1.5 text-t3">{nft.rows.filter((r) => r.count > 0).length}</span> : null}</button>
            <div className="flex-1" />
            {tab !== 'nft' && <button onClick={refresh} disabled={busy} className="icon-btn w-8 h-8" title={L('pf.refreshTip')}><RefreshCw className={clsx('ico', busy && 'spin')} /></button>}
          </div>
          {tab === 'all' && <div className="px-4 py-2 text-xs text-t3">{L('pf.allNote')}</div>}
          {tab === 'nft' ? <NftTab snap={nft} /> : tab === 'orders' ? <><CondTable /><Orders orders={orders} /></> : (
            <div className="tbl-x"><table className="tbl">
              <thead><tr><th className="l">{L('pf.th.token')}</th><th>{L('pf.th.hold')}</th><th>{L('pf.th.value')}</th><th>{L('pf.th.cost')}</th><th>{L('pf.th.sold')}</th><th>{L('pf.th.pnl')}</th><th>{L('pf.th.avg')}</th><th>{L('pf.th.age')}</th><th>{L('pf.th.sell')}</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.token} className="cursor-pointer" onClick={() => nav(`/token/${r.token}`)}>
                    <td className="l"><span className="flex items-center gap-2.5"><TokenAvatar t={{ ...r, symbol: r.symbol }} size={30} /><span><span className="block text-base font-medium">{r.symbol}</span><span className="block text-xs text-t3">{r.stage === 'curve' ? L('pf.st.curve') : r.stage === 'claim' ? L('pf.st.claim') : L('pf.st.dex')}</span></span></span></td>
                    <td>{compact(r.amount)}{r.supplyPct != null && <span className="block text-xs text-t3">{r.supplyPct.toFixed(3)}%</span>}</td>
                    <td>{usd(r.valueUsd)}{r.warn && <span className="block text-xs text-warn max-w-[180px] truncate" title={lz(r.warn)}>{lz(r.warn)}</span>}</td>
                    <td>{usd(r.costUsd)}</td>
                    <td>{usd(r.soldUsd)}</td>
                    <td className={r.pnlUsd == null ? 'text-t3' : r.pnlUsd >= 0 ? 'text-up' : 'text-down'}>{r.pnlUsd == null ? '—' : `${r.pnlUsd >= 0 ? '+' : '-'}$${Math.abs(r.pnlUsd).toFixed(2)}`}<span className="block text-xs">{pct(r.pnlPct)}</span></td>
                    <td className="text-t2">{r.avgBuyUsd != null ? `$${small(r.avgBuyUsd)}` : '—'}</td>
                    <td className="text-t3">{age(r.firstAt)}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {r.amount > 0 && <span className="inline-flex gap-1">{[50, 100].map((p) => <button key={p} onClick={() => sell(asToken(r), p, preset)} className="h-6 px-2 rounded-xs bg-down/10 text-down text-xs hover:bg-down/20">{p}%</button>)}</span>}
                    </td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={9} className="!border-0 !py-14"><Empty text={h ? L('pf.empty') : L('pf.loading')} /></td></tr>}
              </tbody>
            </table></div>
          )}
        </div>
      </div>
    </div>
  )
}

/** 持有的 NFT（雷达铸造的 + 分析时读到你持有的合约）+ 铸造记录。不估值：OKX 对这些合集没有挂单价。
 *  挂单流程：转到自己的 OKX 钱包（转出地址填一次就保存）→ 在 OKX 里挂单 */
function NftTab({ snap }: { snap: NftSnap | null }) {
  const nav = useNavigate()
  const dest = useApp((s) => s.settings?.nftSendTo)
  const [busy, setBusy] = useState('')
  const [hist, setHist] = useState<(RadarMint & { nft?: number })[] | null>(null)
  useEffect(() => { api<{ items: (RadarMint & { nft?: number })[] }>('/api/radar/history?limit=200').then((x) => setHist(x.items)).catch(() => setHist([])) }, [snap?.at])
  const rows = (snap?.rows || []).filter((r) => r.count > 0)
  const refresh = async () => { setBusy('refresh'); try { useApp.setState({ nft: await api<NftSnap>('/api/nft?refresh=1') }) } catch (e: any) { useApp.getState().toast({ kind: 'error', title: L('pf.refreshFailed'), body: e.message }) } finally { setBusy('') } }
  const send = async (r: NftSnap['rows'][number]) => {
    setBusy(r.address)
    try { if (await quickTransfer({ address: r.address, title: r.title, items: r.ids.map((x) => ({ slot: x.slot, id: x.id })) })) setTimeout(refresh, 9000) } finally { setBusy('') }
  }
  const title = (a: string) => (snap?.rows || []).find((r) => r.address === a)?.title || `${a.slice(0, 6)}…${a.slice(-4)}`
  return (
    <div>
      <div className="px-4 py-2.5 flex flex-wrap items-center gap-3 text-sm border-b border-line">
        <span className="text-t3">{L('pf.nftHeld', { c: rows.length, n: snap?.total ?? 0 })}</span>
        <span className="flex-1" />
        <NftDest />
        <button onClick={refresh} disabled={busy === 'refresh'} className="icon-btn w-7 h-7" title={L('pf.nftRefresh')}><RefreshCw className={clsx('ico', busy === 'refresh' && 'spin')} /></button>
      </div>
      <div className="tbl-x"><table className="tbl">
        <thead><tr><th className="l">{L('pf.th.project')}</th><th>{L('pf.th.hold')}</th><th className="l">{L('pf.th.ids')}</th><th>{L('pf.th.ops')}</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.address}>
              <td className="l"><span className="flex items-center gap-2.5">{r.image ? <img src={r.image} alt="" className="w-[30px] h-[30px] rounded-md object-cover" /> : <span className="w-[30px] h-[30px] rounded-md bg-btn-2" />}<span><span className="block text-base font-medium">{r.title}</span>{r.name && r.name !== r.title && <span className="block text-xs text-t3">{r.name}</span>}</span></span></td>
              <td>{r.count}{r.perSlot.length > 1 && <span className="block text-xs text-t3">{r.perSlot.map((p) => `W${p.slot} ${p.count}`).join(' · ')}</span>}</td>
              <td className="l text-xs text-t2 max-w-[260px] truncate" title={r.ids.map((x) => `#${x.id}`).join(' ')}>{r.ids.slice(0, 6).map((x) => `#${x.id}`).join(' ')}{r.ids.length > 6 ? ' …' : ''}</td>
              <td><span className="inline-flex items-center gap-3 text-xs">
                {NFT_TRANSFER.available && <button onClick={() => send(r)} disabled={!dest || !!busy} title={dest ? L('pf.sendTo', { a: dest }) : L('pf.setDest')} className="h-6 px-2.5 rounded-sm bg-up/14 text-up font-medium hover:bg-up/22 disabled:opacity-40 disabled:cursor-not-allowed">{busy === r.address ? L('pf.processing') : r.count > 1 ? L('pf.sendAll', { n: r.count }) : L('pf.send')}</button>}
                <a href={okxCollectionUrl(r.address)} target="_blank" rel="noreferrer" className="text-link hover:underline">{L('pf.okx')}</a>
                <button className="text-t2 hover:text-t1" onClick={() => nav(`/radar?a=${r.address}`)}>{L('pf.detail')}</button>
              </span></td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={4} className="!border-0 !py-10"><Empty text={snap ? L('pf.noNft') : L('pf.loading')} /></td></tr>}
        </tbody>
      </table></div>
      <div className="px-4 py-2 text-[11px] text-t4 leading-5 border-b border-line"><div>{NFT_TRANSFER.available ? L('pf.nftSell') : NFT_TRANSFER.note}</div><div>{L('pf.nftScope')}</div></div>
      <div className="px-4 pt-4 pb-2 text-md font-medium">{L('pf.mints')}</div>
      <div className="tbl-x"><table className="tbl">
        <thead><tr><th className="l">{L('pf.th.time')}</th><th className="l">{L('pf.th.project')}</th><th>{L('pf.th.wallet')}</th><th>{L('pf.th.status')}</th><th className="l">{L('pf.th.got')}</th><th>{L('pf.th.tx')}</th></tr></thead>
        <tbody>
          {(hist || []).map((m) => { const [label, color] = mintStatus(m.status); return (
            <tr key={m.id} className="cursor-pointer" onClick={() => nav(`/radar?a=${m.address}`)}>
              <td className="l text-t3">{L('pf.ago', { t: age(m.ts) })}</td>
              <td className="l">{m.symbol || title(m.address)}</td>
              <td><WalletTag slot={m.slot} /></td>
              <td className={color}>{m.kind === 'transfer' ? (m.status === 'transferred' ? L('pf.transferred') : label) : label}</td>
              <td className="l text-t2 text-xs">{m.kind === 'transfer' ? `#${m.tokenId} → ${m.to ? `${m.to.slice(0, 6)}…${m.to.slice(-4)}` : ''}` : m.got?.length ? m.got.map((g) => (g.std === '721' ? `#${g.id}` : g.amount)).join('、') : m.reason || '—'}</td>
              <td onClick={(e) => e.stopPropagation()}>{m.tx ? <a href={`https://bscscan.com/tx/${m.tx}`} target="_blank" rel="noreferrer" className="text-xs text-t3 hover:text-t1">{L('pf.onchain')}</a> : '—'}</td>
            </tr>) })}
          {hist && !hist.length && <tr><td colSpan={6} className="!border-0 !py-8"><Empty text={L('pf.noMints')} /></td></tr>}
        </tbody>
      </table></div>
    </div>
  )
}

/** 计价币余额（Flap / Gang V2 计价币盘交易时产生、尚未兑换回 BNB 的）+ 一键换回 BNB */
export function QuoteBalances() {
  const [list, setList] = useState<any[] | null>(null)
  const [busy, setBusy] = useState('')
  const load = () => api<any[]>('/api/quote-balances').then(setList).catch(() => setList([]))
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t) }, [])
  const swap = async (q: any) => {
    setBusy(q.token)
    try {
      const p = await api('/api/quote-to-bnb/preview', { token: q.token, slippage: 1 })
      // WBNB 是狙击的预换库存：狙击开着时换回去，它每 60 秒又会补回来，先提醒（别让两个功能互相打架）
      let snipeOn = false
      if (q.wbnb) { try { snipeOn = !!(await api<any>('/api/snipe')).enabled } catch { /* 问不到就当没开 */ } }
      const ok = await useUI.getState().ask({
        title: L('pf.swapTitle', { s: q.symbol }), okText: L('pf.swapOk'),
        rows: [[L('pf.amount'), `${compact(Number(p.balance))} ${q.symbol}`], [L('pf.expect'), `${bnb(p.out)} BNB`], [L('pf.min'), `${bnb(p.minOut)} BNB`], [L('pf.route'), p.route || L('pf.agg')]],
        ...(snipeOn ? { danger: true, note: L('pf.snipeOn') } : {}),
      })
      if (ok) { const o = await api('/api/quote-to-bnb', { token: q.token, slippage: p.slippage }); if (o.status === 'failed') throw new Error(o.reason || L('pf.swapFailed')); load() }
    } catch (e: any) { useApp.getState().toast({ kind: 'error', title: L('pf.swapErr'), body: e.message }) } finally { setBusy('') }
  }
  const rows = (list || []).filter((q) => (q.valueUsd ?? 0) >= 0.5)
  if (!rows.length) return null
  return (
    <div className="rounded-md bg-card border border-line overflow-hidden">
      <div className="px-4 h-11 flex items-center border-b border-line text-md font-medium">{L('pf.quotes')}<span className="text-t3 text-sm ml-2">{L('pf.quotesNote')}</span></div>
      <div className="tbl-x"><table className="tbl">
        <thead><tr><th className="l">{L('pf.th.coin')}</th><th>{L('pf.th.bal')}</th><th>{L('pf.th.value')}</th><th></th></tr></thead>
        <tbody>{rows.map((q) => (
          <tr key={q.token}><td className="l font-medium">{q.symbol}</td><td>{compact(Number(q.balance))}</td><td>{usd(q.valueUsd)}{q.valueBnb != null && <span className="text-t3 text-xs ml-1">≈ {bnb(q.valueBnb)} BNB</span>}</td>
            <td><button disabled={!!busy} onClick={() => swap(q)} className="h-7 px-3 rounded-xs bg-btn-2 text-sm hover:bg-hover-2 disabled:opacity-50">{busy === q.token ? L('pf.processing') : L('pf.toBnb')}</button></td></tr>
        ))}</tbody>
      </table></div>
    </div>
  )
}
