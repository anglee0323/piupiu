// 全局弹窗：下单确认、钱包登录、设置（交易预设 P1–P3 等）、右下角提示
import { UpdateSettings } from './UpdateChip'
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, ExternalLink, Info, Loader2, Smartphone, X, XCircle } from './gi'
import clsx from 'clsx'
import { useApp } from '../store/app'
import { usePrefs, type Gas, type PresetId } from '../store/prefs'
import { useUI } from '../store/ui'
import { api } from '../lib/api'
import { age, bnb, compact, short } from '../lib/format'
import { gasLabel, isReal } from '../lib/trade'
import { Modal, NumBox } from './common'
import { LogoMark } from '../brand'
import { WalletTag } from './WalletPicker'
import type { Order } from '../lib/types'
import { AddressField } from './AddressField'
import { Section, Rows, Row, Toggle, Card, Tag, Switch } from './SettingsKit'
import { nftAddrConfirm, NFT_TRANSFER } from './NftDest'
import { TopBarSettingsBody } from './TopBarSettings'
import QRCode from 'qrcode'
import { useT, t as tr, lz } from '../lib/i18n'
import type { Theme } from '../store/prefs'
import { authText } from '../lib/authText'
import { asset } from '../lib/env'

export function ConfirmModal() {
  const t = useT()
  const c = useUI((s) => s.confirm)
  useEffect(() => {
    if (!c) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Enter') c.resolve(true); if (e.key === 'Escape') c.resolve(false) }
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k)
  }, [c])
  if (!c) return null
  return (
    <Modal open onClose={() => c.resolve(false)} title={c.title} width={400}>
      <div className="space-y-2">
        {c.body && <div className="text-base text-t2 whitespace-pre-line break-all leading-6">{c.body}</div>}
        {c.rows.map(([k, v]) => <div key={k} className="flex justify-between gap-4 text-base"><span className="text-t3 flex-none">{k}</span><span className="text-right break-all">{v}</span></div>)}
        {c.note && <div className="flex items-center gap-1.5 text-sm text-warn pt-1"><AlertTriangle className="ico" />{c.note}</div>}
        <div className="flex gap-2 pt-3">
          <button className="flex-1 h-10 rounded-sm bg-btn hover:bg-btn-2 text-t2" onClick={() => c.resolve(false)}>{t('common.cancel')}</button>
          <button className={clsx('flex-1 h-10 rounded-sm font-semibold hover:brightness-110', c.danger ? 'bg-down text-white' : 'bg-up text-on-accent')} onClick={() => c.resolve(true)}>{c.okText || t('common.confirm')}</button>
        </div>
        <div className="text-xs text-t4 text-center">{t('confirm.keys')}{c.order && t('confirm.keysOrder')}</div>
      </div>
    </Modal>
  )
}

export function LoginModal() {
  const t = useT()
  const open = useUI((s) => s.loginOpen)
  const loginSlot = useUI((s) => s.loginSlot)
  const setUI = useUI((s) => s.set)
  const baw = useApp((s) => s.baw)
  const slots = useApp((s) => s.slotsAll)   // 完整槽位（含扫码中的新槽位）。hook 全在提前 return 之前（登录状态变化时 hook 数量不能变）
  const [err, setErr] = useState('')
  const [starting, setStarting] = useState(false)
  // 目标槽位：「添加钱包」时先没有（loginSlot = 'add'），后端分配新槽位后切到那个槽位号；
  // 绝不能回退到主钱包——否则会读到 W1「已登录」直接显示「已连接」并关掉弹窗（曾经的 bug）
  const adding = loginSlot === 'add'
  const target = typeof loginSlot === 'number' ? loginSlot : adding ? null : slots?.primary || 1
  const sv = target != null ? slots?.slots.find((s) => s.slot === target) || null : null
  const login = sv?.login || (target === (slots?.primary || 1) && !adding ? baw?.login : null)
  const ok = target == null ? false : sv ? sv.auth === 'ok' : target === (slots?.primary || 1) && baw?.auth?.state === 'ok'
  useEffect(() => { if (ok && open) setTimeout(() => setUI({ loginOpen: false }), 900) }, [ok]) // eslint-disable-line
  const start = async () => {
    setErr(''); setStarting(true)
    try {
      const r = await api<any>(adding ? '/api/wallets/add' : `/api/wallets/${target}/login`, {})
      if (adding && r?.added) setUI({ loginSlot: Number(r.added) })   // 之后跟踪这个新槽位的登录进度
    } catch (e: any) { setErr(e.message) } finally { setStarting(false) }
  }
  const waiting = login?.state === 'waiting'
  const cancelSession = () => { if (target != null) api(`/api/wallets/${target}/login`, { cancel: true }).catch(() => {}) }
  const close = () => { if (waiting) cancelSession(); setUI({ loginOpen: false }) }
  const cancel = close
  const isNew = adding || (sv != null && !sv.address)   // 新加的槽位 / 第一次使用还没绑定地址
  // 还没绑定账号的钱包：打开弹窗就直接生成二维码（不用再多点一下）；只自动发起一次，失败了留给用户点按钮重试
  const autoRef = useRef(false)
  useEffect(() => {
    if (!open) { autoRef.current = false; return }
    if (isNew && !ok && !waiting && !autoRef.current) { autoRef.current = true; start() }
  }, [open, isNew, ok, waiting]) // eslint-disable-line react-hooks/exhaustive-deps
  const hasOther = !!slots?.slots.some((s) => s.slot !== target && s.address)   // 已经有别的钱包绑定了账号才需要「换一个账号」；第一次使用不要这么说
  // 状态说明只显示一条（钱包自己的和全局的是同一句话，之前会重复显示两遍）
  const note = adding ? '' : (sv && sv.auth !== 'ok' && authText(sv.authCode, sv.authCodeP, sv.authMessage)) || (!login && sv?.slot === (slots?.primary || 1) ? authText(baw?.auth?.code, baw?.auth?.codeP, baw?.auth?.message) : '') || ''
  const title = isNew && !hasOther ? t('login.connect') : isNew ? t('login.addTitle') + (target ? ` (W${target})` : '') : sv && sv.slot !== (slots?.primary || 1) ? t('login.loginSlot', { slot: sv.slot, label: lz(sv.label) }) : t('login.connect')
  return (
    <Modal open={open} onClose={close} width={420}>
      <div className="flex flex-col items-center text-center gap-3 pt-6">
        <LogoMark size={48} />
        <div className="text-xl font-semibold">{title}</div>
        <div className="text-sm text-t3 leading-relaxed">{isNew && hasOther ? t('login.anotherAccount') : isNew ? t('login.scanHint') : t('login.noKeys')}<br />{t('login.confirmInApp')}</div>
        {ok ? (
          <div className="flex items-center gap-2 text-up text-md py-4"><CheckCircle2 className="ico-md" />{t('login.connected', { name: lz(sv?.label) || baw?.auth?.agentId || '' })}</div>
        ) : waiting ? (
          <div className="w-full space-y-3 pt-2">
            <div className="text-sm text-t3">{t('login.scanAndPair')}</div>
            <div className="text-[30px] font-semibold tracking-[8px] text-warn">{login?.pairingCode}</div>
            {login?.urlForWeb && <LoginQr url={login.urlForWeb} />}
            {login?.urlForWeb && <a href={login.urlForWeb} target="_blank" rel="noreferrer" className="h-9 flex items-center justify-center gap-2 rounded-sm bg-btn text-t2 text-sm hover:bg-btn-2"><Smartphone className="ico" />{t('login.openPage')}<ExternalLink className="ico-sm" /></a>}
            <div className="flex items-center justify-center gap-2 text-sm text-t3"><Loader2 className="ico spin" />{t('login.waiting')}</div>
            <button onClick={cancel} className="text-sm text-t3 hover:text-t1">{t('common.cancel')}</button>
          </div>
        ) : (
          <div className="w-full space-y-3 pt-2">
            {login && ['failed', 'expired', 'wrong', 'cancelled'].includes(login.state) && <div className="text-sm text-down">{login.message || t('login.notDone')}</div>}
            {!!note && <div className="text-xs text-t3">{note}</div>}
            <button disabled={starting} onClick={start} className="w-full h-10 flex items-center justify-center gap-2 rounded-sm bg-up text-on-accent font-semibold hover:brightness-110 disabled:opacity-50">
              {starting && <Loader2 className="ico spin" />}{isNew ? t('login.genQr') : t('login.start')}
            </button>
          </div>
        )}
        {err && <div className="text-sm text-down">{err}</div>}
      </div>
    </Modal>
  )
}

/** 登录二维码：本机生成（参考 EZbot，不用第三方二维码服务） */
export function LoginQr({ url }: { url: string }) {
  const t = useT()
  const [src, setSrc] = useState('')
  useEffect(() => { QRCode.toDataURL(url, { margin: 1, width: 200, color: { dark: '#121212', light: '#f5f5f5' } }).then(setSrc).catch(() => setSrc('')) }, [url])
  return src ? <img src={src} alt={t('login.qrAlt')} className="mx-auto w-[200px] h-[200px] rounded-md" /> : null
}

const GAS: Gas[] = ['normal', 'high', 'turbo']
type STab = 'preset' | 'order' | 'auto' | 'topbar' | 'look' | 'approvals' | 'blocks'

export function SettingsModal() {
  const t = useT()
  const open = useUI((s) => s.settingsOpen)
  const want = useUI((s) => s.settingsTab)
  const setUI = useUI((s) => s.set)
  const [tab, setTab] = useState<STab>('preset')
  useEffect(() => { if (open && want) setTab(want as STab) }, [open, want])   // 从别处直接打开某个页签（如顶部栏左边的齿轮 → 顶部栏页签）
  const tabs: [STab, string][] = [['preset', t('settings.tab.preset')], ['order', t('settings.tab.order')], ['auto', t('settings.tab.auto')], ['topbar', t('settings.tab.topbar')], ['look', t('settings.tab.look')], ['approvals', t('settings.tab.approvals')], ['blocks', t('settings.tab.blocks')]]
  return (
    <Modal open={open} onClose={() => setUI({ settingsOpen: false, settingsTab: null })} title={t('settings.title')} width={720}>
      <div className="flex gap-4 h-[min(620px,calc(88vh-100px))]">
        <div className="w-[176px] flex-none space-y-0.5">
          {tabs.map(([k, l]) => <button key={k} onClick={() => setTab(k)} className={clsx('w-full h-9 px-3 rounded-sm text-left text-base', tab === k ? 'bg-btn-2 text-t1' : 'text-t2 hover:bg-btn')}>{l}</button>)}
        </div>
        <div className="flex-1 min-w-0 overflow-y-auto scroll-y pr-1">
          {tab === 'preset' && <PresetTab />}
          {tab === 'order' && <div className="space-y-6"><OrderTab /><FeeSection /></div>}
          {tab === 'auto' && <AutoSettingsTab />}
          {tab === 'topbar' && <TopBarSettingsBody />}
          {tab === 'look' && <AppearanceTab />}
          {tab === 'approvals' && <ApprovalsTab />}
          {tab === 'blocks' && <BlocksTab />}
        </div>
      </div>
    </Modal>
  )
}

const saveSettings = (body: Record<string, unknown>) => api('/api/settings', body).catch((e) => useApp.getState().toast({ kind: 'error', title: tr('common.saveFailed'), body: e.message }))

/** 数字输入框：数值在左，单位在框内右侧（和 GMGN 一样，一整块，没有边框） */

function PresetTab() {
  const presets = usePrefs((s) => s.presets)
  const setPreset = usePrefs((s) => s.setPreset)
  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const t = useT()
  return (
    <Section title={t('settings.tab.preset')} hint={t('preset.hint')}>
      <div className="space-y-3">
      <div className="seg h-8 w-full">
        <button className="flex-1" data-on={side === 'buy'} onClick={() => setSide('buy')}>{t('preset.buy')}</button>
        <button className="flex-1" data-on={side === 'sell'} onClick={() => setSide('sell')}>{t('preset.sell')}</button>
      </div>
      <div className="rounded-sm border border-line overflow-hidden">
        <div className="grid grid-cols-[56px_1fr_1.6fr_auto] gap-x-3 h-9 items-center px-3 text-xs text-t3 border-b border-line bg-card">
          <span /><span>{t('preset.slippage')}</span><span>{t('preset.gas')}</span><span>{t('preset.mev')}</span>
        </div>
        {([1, 2, 3] as PresetId[]).map((id) => {
          const p = presets[id][side]
          return (
            <div key={id} className="grid grid-cols-[56px_1fr_1.6fr_auto] gap-x-3 items-center px-3 py-3 border-b border-line last:border-0">
              <span className="text-base font-medium">P{id}</span>
              <NumBox value={p.slippage} unit="%" min={0.1} max={99} onSave={(v) => setPreset(id, side, { slippage: v })} />
              <div className="seg h-8">
                {GAS.map((g) => <button key={g} className="flex-1" data-on={p.gas === g} onClick={() => setPreset(id, side, { gas: g })}>{gasLabel(g)}</button>)}
              </div>
              <span className="flex justify-center"><Switch on={p.mev !== false} onChange={(v) => setPreset(id, side, { mev: v })} label={t('preset.mev')} /></span>
            </div>
          )
        })}
      </div>
      </div>
    </Section>
  )
}

function OrderTab() {
  const confirmOrders = usePrefs((s) => s.confirmOrders)
  const setPrefs = usePrefs((s) => s.set)
  const baw = useApp((s) => s.baw)
  const mode = useApp((s) => s.mode)
  const t = useT()
  return (
    <Section title={t('settings.tab.order')} hint={t('order.hint')}>
      <Rows>
        <Toggle on={confirmOrders} onChange={(v) => setPrefs({ confirmOrders: v })} label={t('order.confirm')} hint={t('order.confirmHint')} />
        {mode === 'live' && (
          <Row label={t('order.maxBuy')} hint={t('order.maxBuyHint')}>
            <NumBox value={baw?.maxTradeBnb ?? 0} unit="BNB" zeroLabel={t('order.noLimit')} w="w-[120px]" onSave={(v) => saveSettings({ maxTradeBnb: v })} />
          </Row>
        )}
      </Rows>
      {mode === 'live' && !isReal() && <div className="mt-3 rounded-sm bg-warn/10 text-warn text-sm px-3 py-2">{t('order.demoNote')}</div>}
    </Section>
  )
}

/** 交易手续费：费率、累计已付、待支付、最近记录（GET /api/fees）。不收费的版本（开发版、开源版、演示）不显示 */
type FeeInfo = { enabled: boolean; rate: number; contract: string | null; minBnb: number; paidBnb: number; owedBnb: number; recent: { at: number; id: string; slot: number; side: 'buy' | 'sell'; symbol: string; base: number; fee: number; paid: boolean }[] }
function FeeSection() {
  const t = useT()
  const [f, setF] = useState<FeeInfo | null>(null)
  useEffect(() => { api<FeeInfo>('/api/fees').then(setF).catch(() => {}) }, [])
  if (!f?.enabled) return null
  return (
    <Section title={t('fee.title')} hint={t('fee.hint', { v: +(f.rate * 100).toFixed(2), min: f.minBnb })}>
      <Rows>
        <Row label={t('fee.rate')} hint={t('fee.rateHint')}><span className="text-sm text-t1">{+(f.rate * 100).toFixed(2)}%</span></Row>
        <Row label={t('fee.paid')}><span className="text-sm text-t1 tabular-nums">{bnb(f.paidBnb, 6)} BNB</span></Row>
        <Row label={t('fee.owed')} hint={t('fee.owedHint')}><span className="text-sm text-t1 tabular-nums">{bnb(f.owedBnb, 6)} BNB</span></Row>
        {f.contract && <Row label={t('fee.contract')}><a className="text-sm text-link hover:underline inline-flex items-center gap-1" href={`https://bscscan.com/address/${f.contract}`} target="_blank" rel="noreferrer">{short(f.contract)}<ExternalLink className="ico-sm" /></a></Row>}
      </Rows>
      {f.recent.length > 0 && (
        <div className="mt-3 space-y-1">
          <div className="text-xs text-t3">{t('fee.recent')}</div>
          {f.recent.slice(0, 12).map((r) => (
            <div key={r.id} className="flex items-center gap-2 text-xs text-t2 tabular-nums">
              <span className="w-16 text-t3">{age(r.at)}</span>
              <WalletTag slot={r.slot} />
              <span className="flex-1 truncate">{r.side === 'buy' ? t('toast.buy') : t('toast.sell')} {r.symbol} · {bnb(r.base)} BNB</span>
              <span>{bnb(r.fee, 6)} BNB</span>
              <span className={clsx('w-12 text-right', r.paid ? 'text-t3' : 'text-warn')}>{r.paid ? t('fee.st.paid') : t('fee.st.owed')}</span>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

function AutoSettingsTab() {
  const s = useApp((x) => x.settings)
  const t = useT()
  if (!s) return <div className="text-t3">{t('autoset.demo')}</div>
  const canSend = !!s.sendTo
  return (
    <div className="space-y-6">
      <Section title={t('auto.title')} hint={t('autoset.hint')}>
        <Rows>
          <Toggle on={s.autoClaim} onChange={(v) => saveSettings({ autoClaim: v })} label={t('autoset.claim')} hint={t('autoset.claimHint')} />
          <Toggle on={s.sellToBnb} onChange={(v) => saveSettings({ sellToBnb: v })} label={t('autoset.toBnb')} hint={t('autoset.toBnbHint')} />
          <Toggle on={s.preApproveCap} onChange={(v) => saveSettings({ preApproveCap: v })} label={t('autoset.preApprove')} hint={t('autoset.preApproveHint')} />
        </Rows>
      </Section>
      <Section title={t('transfer.title')} hint={t('transfer.hint')}>
        <div className="space-y-3">
          <Card title={t('transfer.token')} hint={<>{t('transfer.tokenHint1')}<span className="text-t2">{t('transfer.tokenHint2')}</span>{t('transfer.tokenHint3')}</>}>
            <AddressField value={s.sendTo} placeholder={t('transfer.tokenPh')} confirm={{ save: t('transfer.tokenSaveNote'), clear: t('transfer.tokenClearNote') }} onSave={(a) => api('/api/settings', { sendTo: a })} />
            <div className="border-t border-line">
              <Rows>
                <Toggle disabled={!canSend} on={!!s.autoSendAfterClaim} onChange={(v) => saveSettings({ autoSendAfterClaim: v })} label={t('transfer.flap')} />
                <Toggle disabled={!canSend} on={!!s.autoSendFourMigrated} onChange={(v) => saveSettings({ autoSendFourMigrated: v })} label={t('transfer.four')} />
                <Toggle disabled={!canSend} on={!!s.autoSendGangMigrated} onChange={(v) => saveSettings({ autoSendGangMigrated: v })} label={t('transfer.gang')} />
              </Rows>
            </div>
          </Card>
          {NFT_TRANSFER.available
            ? <Card title={t('transfer.nft')} hint={t('transfer.nftHint')}>
                <AddressField value={s.nftSendTo} placeholder={t('transfer.nftPh')} confirm={nftAddrConfirm()} onSave={(a) => api('/api/settings', { nftSendTo: a })} />
              </Card>
            : <Card title={t('transfer.nft')} tag={<Tag>{t('transfer.unavailable')}</Tag>} hint={t('cap.nftTransfer')} />}
        </div>
      </Section>
    </div>
  )
}

/** 外观：主题（明亮 / 黑暗）、桌面版的应用图标和语言。一改就存（界面设置，同步到 Gateway） */
const IN_APP = /Electron\//.test(navigator.userAgent)
function AppearanceTab() {
  const t = useT()
  const theme = usePrefs((s) => s.theme), lang = usePrefs((s) => s.lang), appIcon = usePrefs((s) => s.appIcon ?? 'white'), set = usePrefs((s) => s.set)
  // 预览色块用各主题自己的颜色（和当前主题无关），所以这里写的是固定值
  const card = (id: Theme, name: string, desc: string, c: { bg: string; bar: string; card: string; line: string; t1: string; t3: string; up: string; down: string }) => (
    <button key={id} onClick={() => set({ theme: id })} className={clsx('flex-1 min-w-0 rounded-md border p-3 text-left transition-colors', theme === id ? 'border-up ring-1 ring-up' : 'border-line-2 hover:border-line-3')}>
      <div className="h-[84px] rounded-sm overflow-hidden flex flex-col" style={{ background: c.bg, boxShadow: `inset 0 0 0 1px ${c.line}` }}>
        <div className="h-4 flex items-center gap-1 px-2" style={{ background: c.bar, borderBottom: `1px solid ${c.line}` }}><span className="w-6 h-1 rounded-full" style={{ background: c.t1 }} /><span className="w-4 h-1 rounded-full" style={{ background: c.t3 }} /><span className="w-4 h-1 rounded-full" style={{ background: c.t3 }} /></div>
        <div className="flex-1 grid grid-cols-3 gap-1.5 p-2">{[0, 1, 2].map((i) => (
          <div key={i} className="rounded-xs p-1.5 space-y-1" style={{ background: c.card, boxShadow: `inset 0 0 0 1px ${c.line}` }}>
            <span className="block w-3/4 h-1 rounded-full" style={{ background: c.t1 }} /><span className="block w-1/2 h-1 rounded-full" style={{ background: c.t3 }} /><span className="block w-2/3 h-1 rounded-full" style={{ background: i === 1 ? c.down : c.up }} />
          </div>))}</div>
      </div>
      <div className="mt-2.5 flex items-center justify-between"><span className="text-base font-medium">{name}</span>{theme === id && <CheckCircle2 className="ico text-up" />}</div>
      <div className="text-xs text-t3 mt-0.5 leading-5">{desc}</div>
    </button>
  )
  return (
    <div className="space-y-6">
      <Section title={t('look.theme')} hint={t('look.themeHint')}>
        <div className="flex gap-3">
          {card('light', t('look.light'), t('look.lightDesc'), { bg: '#f4f2ec', bar: '#faf9f6', card: '#fdfcf9', line: '#e8e4da', t1: '#1b1b1a', t3: '#a8a49a', up: '#1b9658', down: '#d4443d' })}
          {card('dark', t('look.dark'), t('look.darkDesc'), { bg: '#121212', bar: '#0d0d0d', card: '#171717', line: '#242424', t1: '#f5f5f5', t3: '#525252', up: '#46b87d', down: '#de5759' })}
        </div>
      </Section>
      {IN_APP && (
        <Section title={t('look.icon')} hint={t('look.iconHint')}>
          <div className="flex gap-3">
            {(['white', 'black'] as const).map((c) => (
              <button key={c} onClick={() => set({ appIcon: c })} className={clsx('w-[132px] rounded-md border p-3 flex flex-col items-center gap-2 transition-colors', appIcon === c ? 'border-up ring-1 ring-up' : 'border-line-2 hover:border-line-3')}>
                <img src={asset(`brand/icon-${c}.png`)} alt="" className="w-16 h-16" />
                <span className="flex items-center gap-1.5 text-sm font-medium">{t('look.icon.' + c)}{appIcon === c && <CheckCircle2 className="ico-sm text-up" />}</span>
              </button>
            ))}
          </div>
        </Section>
      )}
      {IN_APP && <Section title={t('upd.title')} hint={t('upd.hint')}><UpdateSettings /></Section>}
      <Section title={t('look.lang')} hint={t('look.langHint')}>
        <div className="seg h-8 w-[220px]">
          <button className="flex-1" data-on={lang !== 'en'} onClick={() => set({ lang: 'zh' })}>中文</button>{/* i18n-ignore */}
          <button className="flex-1" data-on={lang === 'en'} onClick={() => set({ lang: 'en' })}>English</button>
        </div>
      </Section>
    </div>
  )
}

function ApprovalsTab() {
  const [list, setList] = useState<any[] | null>(null)
  const [busy, setBusy] = useState('')
  const t = useT()
  const load = () => api<any[]>('/api/approvals').then(setList).catch(() => setList([]))
  useEffect(() => { load() }, [])
  const revoke = async (a: any) => {
    setBusy(a.token + a.spender)
    try { await api('/api/approvals/revoke', { token: a.token, spender: a.spender }); useApp.getState().toast({ kind: 'ok', title: t('appr.revoked', { sym: a.symbol }) }); load() }
    catch (e: any) { useApp.getState().toast({ kind: 'error', title: t('appr.revokeFailed'), body: e.message }) } finally { setBusy('') }
  }
  if (!list) return <Loader2 className="ico spin text-t3" />
  return (
    <Section title={t('settings.tab.approvals')} hint={t('appr.hint')}>
      <table className="tbl">
        <thead><tr><th className="l">{t('appr.token')}</th><th className="l">{t('appr.spender')}</th><th>{t('appr.allowance')}</th><th>{t('appr.balance')}</th><th></th></tr></thead>
        <tbody>
          {list.map((a) => (
            <tr key={a.token + a.spender}>
              <td className="l">{a.symbol || short(a.token)}<span className="block text-xs text-t3">{a.kind === 'quote' ? t('appr.kindQuote') : t('appr.kindSell')} · {age(a.at)}</span></td>
              <td className="l text-t2">{short(a.spender)}</td>
              <td className={a.active ? '' : 'text-t4'}>{a.active ? compact(Number(a.allowance)) : t('appr.revokedState')}</td>
              <td className="text-t2">{compact(Number(a.balance))}</td>
              <td>{a.active && <button disabled={!!busy} onClick={() => revoke(a)} className="text-xs text-down hover:underline disabled:opacity-50">{busy === a.token + a.spender ? t('appr.revoking') : t('appr.revoke')}</button>}</td>
            </tr>
          ))}
          {!list.length && <tr><td colSpan={5} className="!text-center text-t3 !py-8">{t('appr.empty')}</td></tr>}
        </tbody>
      </table>
    </Section>
  )
}

function BlocksTab() {
  const t = useT()
  const bl = useApp((s) => s.blocklist)
  const unblock = (kind: string, address: string) => api('/api/blocklist', { kind, address, on: false }).catch(() => {})
  const hiddenRadar = useApp((s) => s.radar?.hidden) || []
  const restoreRadar = (a: string) => api(`/api/radar/${a}`, { block: false }).catch((e) => useApp.getState().toast({ kind: 'error', title: t('blocks.restoreFailed'), body: e.message }))
  const rows: [string, string, any][] = [...Object.entries(bl.tokens).map(([a, v]) => ['token', a, v] as [string, string, any]), ...Object.entries(bl.devs).map(([a, v]) => ['dev', a, v] as [string, string, any])]
  return (
    <div className="space-y-6">
      <Section title={`${t('blocks.title')}${rows.length ? ` · ${rows.length}` : ''}`} hint={t('blocks.hint')}>
      <table className="tbl">
        <thead><tr><th className="l">{t('blocks.type')}</th><th className="l">{t('blocks.name')}</th><th className="l">{t('blocks.address')}</th><th></th></tr></thead>
        <tbody>
          {rows.map(([k, a, v]) => (
            <tr key={k + a}><td className="l text-t2">{k === 'token' ? t('blocks.kToken') : t('blocks.kDev')}</td><td className="l">{(v && (v.label || v.symbol)) || '—'}</td><td className="l text-t3">{short(a)}</td>
              <td><button className="text-xs text-t3 hover:text-t1" onClick={() => unblock(k, a)}>{t('blocks.unblock')}</button></td></tr>
          ))}
          {!rows.length && <tr><td colSpan={4} className="!text-center text-t3 !py-8">{t('blocks.empty')}</td></tr>}
        </tbody>
      </table>
      </Section>
      <Section title={`${t('blocks.radarTitle')}${hiddenRadar.length ? ` · ${hiddenRadar.length}` : ''}`} hint={t('blocks.radarHint')}>
      <table className="tbl">
        <thead><tr><th className="l">{t('blocks.name')}</th><th className="l">{t('blocks.contract')}</th><th></th></tr></thead>
        <tbody>
          {hiddenRadar.map((h) => (
            <tr key={h.address}><td className="l">{h.title}</td><td className="l text-t3">{short(h.address)}</td>
              <td><button className="text-xs text-t3 hover:text-t1" onClick={() => restoreRadar(h.address)}>{t('blocks.restore')}</button></td></tr>
          ))}
          {!hiddenRadar.length && <tr><td colSpan={3} className="!text-center text-t3 !py-6">{t('blocks.radarEmpty')}</td></tr>}
        </tbody>
      </table>
      </Section>
    </div>
  )
}

export function Toasts() {
  const tr = useT()
  const toasts = useApp((s) => s.toasts)
  const orders = useApp((s) => s.orders)
  const drop = useApp((s) => s.dropToast)
  // 下单 / 提示卡片：和其他弹出卡片同一种外观（pop 卡片、状态图标放在浅色圆底里、右上角关闭），不加左侧色条，不用手打的 ✓ ✕
  const Badge = ({ st }: { st: 'ok' | 'err' | 'pend' | 'dry' }) => {
    const Icon = st === 'err' ? XCircle : st === 'ok' ? CheckCircle2 : st === 'dry' ? Info : Loader2
    return <span className={clsx('w-7 h-7 rounded-full grid place-items-center flex-none', st === 'err' ? 'bg-down/14 text-down' : st === 'ok' ? 'bg-up/14 text-up' : st === 'dry' ? 'bg-btn text-t2' : 'bg-warn/14 text-warn')}><Icon className={clsx('ico', st === 'pend' && 'spin')} /></span>
  }
  const Close = ({ id }: { id: string }) => <button className="icon-btn w-6 h-6 -mt-0.5 -mr-1 flex-none" aria-label={tr('common.close')} onClick={(e) => { e.stopPropagation(); drop(id) }}><X className="ico-sm" /></button>
  const stOf = (o: Order) => (o.status === 'failed' ? 'err' : o.status === 'filled' ? (o.dryRun ? 'dry' : 'ok') : 'pend') as 'ok' | 'err' | 'pend' | 'dry'
  return (
    <div className="fixed right-3 bottom-[44px] z-[120] flex flex-col gap-2 w-[360px]">
      {toasts.map((t) => {
        // 多钱包批量：同一批（batchId）按钱包分行，各自显示状态
        if (t.batchId) {
          const batch = orders.filter((x) => x.batchId === t.batchId && (x.side === 'buy' || x.side === 'sell')).slice(0, 4)
          if (!batch.length) return null
          const pend = batch.some((o) => o.status === 'pending')
          const okN = batch.filter((o) => o.status === 'filled' && !o.dryRun).length
          return (
            <div key={t.id} className="toast-in pop p-3">
              <div className="flex items-start gap-2.5">
                <Badge st={pend ? 'pend' : okN === batch.length ? 'ok' : 'err'} />
                <div className="min-w-0 flex-1">
                  <div className="text-base font-medium leading-7">{t.title}{!pend && tr('toast.filledN', { ok: okN, n: batch.length })}</div>
                  <div className="mt-1 space-y-1">
                    {batch.map((o) => {
                      const st = stOf(o), Ic = st === 'err' ? XCircle : st === 'ok' ? CheckCircle2 : st === 'dry' ? Info : Loader2
                      return (
                        <div key={o.id} className="flex items-center gap-1.5 text-sm">
                          {o.walletSlot ? <WalletTag slot={o.walletSlot} /> : <span className="w-5" />}
                          <Ic className={clsx('ico-sm flex-none', st === 'err' ? 'text-down' : st === 'ok' ? 'text-up' : st === 'dry' ? 'text-t3' : 'text-warn spin')} />
                          <span className="text-t2 truncate flex-1" title={lz(o.reason) || undefined}>{lz(o.reason) || (o.status === 'filled' && o.out != null ? tr('toast.got', { v: bnb(o.out) }) : o.side === 'sell' ? tr('toast.holdingPct', { p: o.amount }) : `${bnb(o.amountIn ?? o.amount)} BNB`)}</span>
                          {o.tx && <a href={`https://bscscan.com/tx/${o.tx}`} target="_blank" rel="noreferrer" className="text-xs text-link hover:underline flex-none">{tr('toast.tx')}</a>}
                        </div>
                      )
                    })}
                  </div>
                </div>
                <Close id={t.id} />
              </div>
            </div>
          )
        }
        const o = t.order
        const st = o ? stOf(o) : t.kind === 'error' ? 'err' : t.kind === 'ok' ? 'ok' : 'pend'
        const title = o ? `${o.side === 'buy' ? tr('toast.buy') : tr('toast.sell')} ${o.symbol || ''} ${o.status === 'failed' ? tr('toast.failed') : o.status === 'filled' ? (o.dryRun ? tr('toast.demoFilled') : tr('toast.filled')) : tr('toast.pending')}` : t.title
        const body = o ? (lz(o.reason) || (o.status === 'filled' && o.out != null ? tr('toast.got', { v: bnb(o.out) }) : o.side === 'sell' ? tr('toast.holdingPct', { p: o.amount }) : `${bnb(o.amountIn ?? o.amount)} BNB`)) : t.body
        return (
          <div key={t.id} className="toast-in pop p-3">
            <div className="flex items-start gap-2.5">
              <Badge st={st} />
              <div className="min-w-0 flex-1">
                <div className="text-base font-medium leading-7 truncate">{title}</div>
                {body && <div className="text-sm text-t2 leading-5 break-words line-clamp-3">{body}</div>}
                {o?.feeBnb != null && o.feeBnb > 0 && <div className="text-xs text-t3 leading-5">{tr('toast.fee', { v: bnb(o.feeBnb) })}</div>}
                {o?.tx && <a href={`https://bscscan.com/tx/${o.tx}`} target="_blank" rel="noreferrer" className="inline-block mt-1 text-xs text-link hover:underline">{tr('toast.viewTx')}</a>}
              </div>
              <Close id={t.id} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
