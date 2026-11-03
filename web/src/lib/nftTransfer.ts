// 一键把 NFT 转到「NFT 转出地址」（设置里填一次保存的，比如你自己的 OKX 钱包）。
// 预检、批次、逐个提交都在 Gateway（engine/live/radar/nftBatch.js）；这里只负责展示预检结果并让用户确认。
// 预检只模拟 + 币安钱包预演，不发交易；60 秒内有效，确认后才提交。
import { api } from './api'
import { useApp } from '../store/app'
import { useUI } from '../store/ui'
import { t as T } from './i18n'
import { requireWallet } from './trade'

const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')

type Item = { slot: number; id: string }
type BatchPreview = { batchId: string; expiresAt: number; dest: string; rows: { slot: number; tokenId: string }[]; risks: string[]; needAppConfirm: boolean; skipped: number }
type BatchResult = { sent: number; total: number; failed: { tokenId: string; error?: string } | null }

export async function quickTransfer(opts: { address: string; title: string; items: Item[] }): Promise<boolean> {
  if (!requireWallet()) return false
  const S = useApp.getState()
  if (!S.settings?.nftSendTo) { S.toast({ kind: 'error', title: T('nt.noDest'), body: T('nt.noDestBody') }); return false }
  let pv: BatchPreview
  try { pv = await api<BatchPreview>('/api/nft/transfer/preview', { address: opts.address, items: opts.items.map((x) => ({ slot: x.slot, tokenId: x.id })) }) }
  catch (e: any) { S.toast({ kind: 'error', title: T('nt.pvFailed'), body: e.message }); return false }
  const ok = await useUI.getState().ask({
    title: T('nt.title', { s: opts.title }), okText: T('nt.ok', { n: pv.rows.length }),
    rows: [
      [T('nt.from'), [...new Set(pv.rows.map((r) => `W${r.slot}`))].join(', ')], [T('nt.to'), pv.dest], [T('nt.ids'), pv.rows.map((r) => `#${r.tokenId}`).join(' ')],
      ...(pv.risks.length ? [[T('nt.risks'), pv.risks.join('; ')] as [string, string]] : []),
      ...(pv.needAppConfirm ? [[T('nt.note'), T('nt.app')] as [string, string]] : []),
      [T('nt.note'), T('nt.final', { a: short(pv.dest) })],
    ],
  })
  if (!ok) return false
  let r: BatchResult
  try { r = await api<BatchResult>('/api/nft/transfer/submit', { batchId: pv.batchId }) }
  catch (e: any) { S.toast({ kind: 'error', title: T('nt.failed'), body: e.message }); return false }
  if (r.failed) S.toast({ kind: 'error', title: T('nt.idFailed', { id: r.failed.tokenId }), body: `${r.failed.error || ''}${r.sent ? T('nt.partial', { n: r.sent }) : ''}` })
  if (r.sent && pv.skipped > 0) S.toast({ kind: 'info', title: T('nt.sentN', { n: r.sent }), body: T('nt.more', { n: pv.rows.length, m: pv.skipped }) })
  return r.sent > 0
}
