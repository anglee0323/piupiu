// NFT 转出地址（单行小号版，资产页 → NFT 和雷达详情里用）：填一次就保存，之后「转出」直接用它。
// 设置里的完整版在「设置 → 自动化与转出」，用的是同一个组件和同一份设置。
import { api } from '../lib/api'
import { useApp } from '../store/app'
import { AddressField } from './AddressField'
import { CAPS } from '../../../shared/capabilities.js'
import { t as T } from '../lib/i18n'

// note 按当前语言取（网关报错仍用中文原文 CAPS.nftTransfer.note）
export const NFT_TRANSFER = { get available() { return CAPS.nftTransfer.available }, get note() { return T(CAPS.nftTransfer.noteK) } }

export const nftAddrConfirm = () => ({ save: T('nft.saveNote'), clear: T('nft.clearNote') })

/** 转出不可用时（见 shared/capabilities.js）只显示一行说明，不再让用户填地址 */
export function NftDest() {
  const dest = useApp((s) => s.settings?.nftSendTo)
  if (!NFT_TRANSFER.available) return <span className="text-xs text-t3">{T('nft.unavailable')}</span>
  return <AddressField compact value={dest} placeholder={T('nft.addrPh')} confirm={nftAddrConfirm()} onSave={(a) => api('/api/settings', { nftSendTo: a })} />
}
