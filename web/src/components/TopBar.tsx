// 顶栏：和 GMGN 一样只放「导航 + 账户」——左 Logo 和页面导航，右搜索、平台选择、设置、钱包
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { NavLink, Link } from 'react-router-dom'
import { ChevronDown, Layers, Search, Settings, Wallet, LogIn, Sun, Moon } from './gi'
import clsx from 'clsx'
import { Logo } from '../brand'
import { useApp } from '../store/app'
import { usePrefs } from '../store/prefs'
import { useUI } from '../store/ui'
import { bnb, short } from '../lib/format'
import { isReal } from '../lib/trade'
import { api } from '../lib/api'
import type { PlatformFilter } from '../lib/types'
import { BnbCoin, PLATFORM, PLATFORM_FILTERS, PlatformBadge, alpha } from './icons'
import { CopyBtn, Dot } from './common'
import { WalletTag } from './WalletPicker'
import { useT } from '../lib/i18n'
import { Plus } from './gi'
import { authText } from '../lib/authText'
import { lz } from '../lib/i18n'
import { ConnectHint } from './ConnectHint'

// 和 GMGN 顶部导航同样的顺序：战壕 / 热门 / 跟单 / 狙击 / 追踪 / 资产（文案键见 shared/i18n）
// 导航不放未读点（只有雷达一个有点，和其他页不一致）；新机会由右上角的命中提醒告知（components/RadarAlerts.tsx）

const NAV = [
  { to: '/', label: 'nav.trenches', end: true },
  { to: '/trend', label: 'nav.trend' },
  { to: '/copy', label: 'nav.copy' },
  { to: '/snipe', label: 'nav.snipe' },
  { to: '/radar', label: 'nav.radar' },
  { to: '/follow', label: 'nav.follow' },
  { to: '/portfolio', label: 'nav.portfolio' },
]

export function TopBar() {
  const setUI = useUI((s) => s.set)
  const t = useT()
  const [hdrRef, cols] = useCenteredGrid()
  return (
    // 三段：左（logo + 导航）、中（搜索，居中于窗口）、右（设置类控件 + Windows 窗口按钮）。
    // 用三列网格，左右两列宽度由 useCenteredGrid 定：放得下时两列等宽（取两边内容较宽者），搜索落在窗口正中、按剩余空间缩放；
    // 窗口太窄、等宽放不下时两列按各自内容宽，搜索占中间剩下的位置（不居中，但不挤出顶栏）。
    // mac 红绿灯的位置、旧版 Windows 外壳的系统按钮位置都留在左右段的内边距里（index.css），不破坏居中。
    <header ref={hdrRef} className="app-titlebar h-[56px] flex-none grid items-center justify-between gap-3 px-4 bg-bg-deep border-b border-line" style={{ gridTemplateColumns: cols }}>
      <div className="tb-left w-max justify-self-start flex items-center gap-3 xl:gap-5">
        <Link to="/" className="flex-none"><Logo /></Link>
        <nav className="tb-nd flex-none flex items-center gap-1 whitespace-nowrap">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}
              className={({ isActive }) => clsx('h-8 px-2 xl:px-2.5 rounded-sm inline-flex items-center gap-1 text-md font-medium transition-colors',
                isActive ? 'text-up bg-up/14' : 'text-t1 hover:text-up hover:bg-up/14')}>
              {t(n.label)}
            </NavLink>
          ))}
        </nav>
      </div>
      {/* 搜索框按自身宽度显示（容器查询量的是去掉左右内边距后的宽度）：够宽显示完整提示，窄一些只写「搜索」，再窄只留放大镜，不出现「S…」这种截断 */}
      <button onClick={() => setUI({ searchOpen: true })} title={t('top.search')} aria-label={t('top.search')} className="tb-nd @container h-9 w-full min-w-[44px] flex items-center justify-center @[76px]:justify-start gap-2 px-3 rounded-md bg-btn text-t3 hover:bg-btn-2 transition-colors">
        <Search className="ico-md" />
        <span className="hidden @[222px]:block flex-1 text-left text-base truncate">{t('top.search')}</span>
        <span className="hidden @[76px]:block @[222px]:hidden flex-1 text-left text-base whitespace-nowrap">{t('top.searchShort')}</span>
        <kbd className="hidden @[104px]:grid px-1.5 h-5 place-items-center rounded-xs bg-btn-2 text-t3 text-xs font-sans">/</kbd>
      </button>
      <div className="tb-right w-max justify-self-end flex items-center gap-0.5">
        <div className="tb-nd flex items-center gap-0.5">
          <PlatformSelect />
          <LangSwitch />
          <ThemeToggle />
          <button className="icon-btn w-8 h-9" title={t('top.settings')} onClick={() => setUI({ settingsOpen: true })}><Settings className="ico-md" /></button>
          <WalletButton />
        </div>
        <WinControls />
      </div>
    </header>
  )
}

/** 顶栏三列的列宽：两边内容较宽者 × 2 + 搜索最窄 44px 放得下时，左右等宽（搜索居中）；放不下时左右按内容宽。
 *  左右两段是 w-max，ResizeObserver 盯着顶栏和两段（切换语言、钱包按钮变化都会改宽度） */
function useCenteredGrid() {
  const ref = useRef<HTMLElement>(null)
  const [cols, setCols] = useState('max-content minmax(44px, 1fr) max-content')
  useLayoutEffect(() => {
    const h = ref.current
    const L = h?.querySelector<HTMLElement>('.tb-left'), R = h?.querySelector<HTMLElement>('.tb-right')
    if (!h || !L || !R) return
    const fit = () => {
      const cs = getComputedStyle(h)
      const avail = h.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2 * parseFloat(cs.columnGap || '0')
      const side = Math.ceil(Math.max(L.offsetWidth, R.offsetWidth))
      setCols(2 * side + 44 <= avail ? `${side}px minmax(44px, 320px) ${side}px` : 'max-content minmax(44px, 1fr) max-content')
    }
    fit()
    const ro = new ResizeObserver(fit); ro.observe(h); ro.observe(L); ro.observe(R)
    return () => ro.disconnect()
  }, [])
  return [ref, cols] as const
}

/** Windows 桌面版的最小化 / 最大化 / 关闭（外壳隐藏了系统标题栏）：尺寸和顶栏的图标按钮一致，贴着窗口右边缘，关闭悬停变红 */
function WinControls() {
  const w = (window as any).piupiuWindow as { minimize: () => void; toggleMaximize: () => void; close: () => void; isMaximized: () => Promise<boolean>; onMaximizeChange: (cb: (v: boolean) => void) => () => void } | undefined
  const [max, setMax] = useState(false)
  useEffect(() => { if (!w) return; w.isMaximized().then(setMax).catch(() => {}); return w.onMaximizeChange(setMax) }, [w])
  // 只在 Windows 上画（外壳 0.1.7 的预加载脚本在 Mac 上也开放了这组动作，Mac 用系统红绿灯，不能再画一套）
  if (!w || !document.documentElement.classList.contains('win-shell')) return null
  // 和顶栏其他图标按钮同样大小（40 × 45），不占满顶栏高度；前面一条细分隔线把窗口按钮和应用控件分开
  const base = 'icon-btn w-8 h-9'
  const ico = { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  return (
    <div className="tb-nd flex-none flex items-center gap-0.5">
      <span className="w-px h-5 bg-line-2 mx-2" />
      <button className={base} aria-label="Minimize" onClick={() => w.minimize()}><svg {...ico}><path d="M2.5 7h9" /></svg></button>
      <button className={base} aria-label={max ? 'Restore' : 'Maximize'} onClick={() => w.toggleMaximize()}>
        {max ? <svg {...ico}><path d="M4.5 4.5V2.5h7v7h-2" /><rect x="2.5" y="4.5" width="7" height="7" rx="0.5" /></svg> : <svg {...ico}><rect x="2.5" y="2.5" width="9" height="9" rx="0.5" /></svg>}
      </button>
      <button className={clsx(base, 'hover:!bg-down hover:!text-on-accent')} aria-label="Close" onClick={() => w.close()}><svg {...ico}><path d="M2.5 2.5l9 9M11.5 2.5l-9 9" /></svg></button>
    </div>
  )
}

/** 中 / EN 切换：选择存在界面设置里（prefs.lang），网关返回的提示也跟着切换 */
function LangSwitch() {
  const lang = usePrefs((s) => s.lang)
  const set = usePrefs((s) => s.set)
  const t = useT()
  return (
    <div className="seg h-7 flex-none" title={t('top.lang')}>
      <button className="px-2 text-xs font-semibold" data-on={lang !== 'en'} onClick={() => set({ lang: 'zh' })}>中</button>{/* i18n-ignore */}
      <button className="px-2 text-xs font-semibold" data-on={lang === 'en'} onClick={() => set({ lang: 'en' })}>EN</button>
    </div>
  )
}

/** 明亮 / 黑暗一键切换：和「设置 → 外观」里的主题是同一个设置（prefs.theme，存到后端；桌面版的标题栏也跟着变）。
 *  图标表示点了以后切到哪种：明亮时显示月亮，黑暗时显示太阳 */
function ThemeToggle() {
  const dark = usePrefs((s) => s.theme) === 'dark'
  const set = usePrefs((s) => s.set)
  const t = useT()
  const label = t(dark ? 'top.toLight' : 'top.toDark')
  return (
    <button className="icon-btn w-8 h-9 flex-none" title={label} aria-label={label} onClick={() => set({ theme: dark ? 'light' : 'dark' })}>
      {dark ? <Sun className="ico-md" /> : <Moon className="ico-md" />}
    </button>
  )
}

function PlatformSelect() {
  const [open, setOpen] = useState(false)
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const platforms = usePrefs((s) => s.platforms)
  const set = usePrefs((s) => s.set)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', h); return () => window.removeEventListener('mousedown', h)
  }, [open])
  const toggle = (p: PlatformFilter) => {
    const next = platforms.includes(p) ? platforms.filter((x) => x !== p) : [...platforms, p]
    if (next.length) set({ platforms: next })
  }
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen(!open)} className="h-9 flex items-center gap-1.5 px-2 rounded-sm text-t1 hover:bg-btn transition-colors" title={t('platform.pick')}>
        <Layers className="ico-md text-t2" />
        <span className="hidden min-[1440px]:inline text-md whitespace-nowrap">{platforms.length === PLATFORM_FILTERS.length ? t('platform.all') : t('platform.count', { n: platforms.length })}</span>
        <ChevronDown className="ico-sm text-t3" />
      </button>
      {open && (
        <div className="pop absolute right-0 top-11 z-50 w-[340px] p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-md font-medium text-t2">{t('platform.title')}</span>
            <button onClick={() => set({ platforms: platforms.length === PLATFORM_FILTERS.length ? [PLATFORM_FILTERS[0].id] : PLATFORM_FILTERS.map((f) => f.id) })}
              className="h-6 px-2 rounded-xs bg-btn-2 text-xs font-semibold text-t1 hover:bg-hover-2">{platforms.length === PLATFORM_FILTERS.length ? t('platform.selectNone') : t('platform.selectAll')}</button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {PLATFORM_FILTERS.map((f) => {
              const on = platforms.includes(f.id), c = PLATFORM[f.logo].color
              return (
                <button key={f.id} onClick={() => toggle(f.id)} className="h-7 px-2 rounded-full border flex items-center gap-1.5 text-sm transition-colors"
                  style={{ borderColor: on ? c : alpha(c, 25), color: on ? c : alpha(c, 40), background: on ? alpha(c, 8) : 'transparent' }}>
                  <span style={{ opacity: on ? 1 : 0.45 }}><PlatformBadge p={f.logo} size={14} ring="transparent" /></span>
                  <span className="truncate">{f.id === 'gang-fair' ? t('platform.gangFair') : f.id === 'gang-fly' ? t('platform.gangFly') : f.label}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function WalletButton() {
  const baw = useApp((s) => s.baw)
  const mode = useApp((s) => s.mode)
  const w = useApp((s) => s.wallets[0])
  const slots = useApp((s) => s.slots)   // hook 必须在任何提前 return 之前，否则登录成功那一刻 hook 数量变化会让整页崩溃
  const holdings = useApp((s) => s.holdings)
  const setUI = useUI((s) => s.set)
  const t = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const connectRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', h); return () => window.removeEventListener('mousedown', h)
  }, [open])
  const list = slots?.slots || []
  const logged = list.filter((s) => s.auth === 'ok')
  const logged2 = mode !== 'live' || baw?.auth?.state === 'ok' || logged.length > 0
  if (!logged2) {
    return (
      <>
        <button ref={connectRef} onClick={() => setUI({ loginOpen: true, loginSlot: slots?.primary || 1, connectHint: false })} className="h-9 px-3.5 flex items-center gap-1.5 rounded-md bg-buy text-on-accent font-semibold text-md whitespace-nowrap hover:brightness-110">
          <LogIn className="ico-md" />{t('wallet.connect')}
        </button>
        <ConnectHint anchor={connectRef} />
      </>
    )
  }
  const bal = holdings?.bnb ?? w?.bnb ?? 0
  const wbnb = holdings?.wbnb ?? 0        // 狙击预换 / 内盘交易留下的 WBNB，和 BNB 1:1，合计显示更直观
  const total = bal + wbnb
  const agentId = baw?.auth?.agentId
  const addr = baw?.auth?.address || w?.address || ''
  const offline = list.filter((s) => s.auth !== 'ok' && s.auth !== 'checking')
  return (
    <div className="relative flex items-center gap-2" ref={ref}>
      {mode === 'live' && !isReal() && <span className="h-6 px-2 grid place-items-center rounded-xs bg-warn/16 text-warn text-xs font-medium" title={t('wallet.demoTip')}>{t('mode.demo')}</span>}
      <button onClick={() => setOpen(!open)} className="h-9 flex items-center gap-2 px-3 rounded-md bg-btn hover:bg-btn-2 transition-colors">
        <Wallet className="ico-md text-t2" />
        {logged.length > 1 && logged.slice(0, 3).map((s) => <WalletTag key={s.slot} slot={s.slot} />)}
        <BnbCoin />
        <span className="text-md font-medium" title={wbnb > 0 ? t('wallet.balanceTip', { bnb: bnb(bal, 4), wbnb: bnb(wbnb, 4) }) : undefined}>{bnb(total, 4)}</span>
        {logged.length > 3 && <span className="text-sm text-t3 whitespace-nowrap">{t('wallet.nWallets', { n: logged.length })}</span>}
        <ChevronDown className="ico-sm text-t3" />
      </button>
      {open && (
        <div className="pop absolute right-0 top-11 z-50 w-[320px] p-3 space-y-2.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-t2 font-medium">{t('wallet.headCount', { logged: logged.length, all: list.length })}</span>
            <Link to="/wallets" onClick={() => setOpen(false)} className="text-xs text-t3 hover:text-t1">{t('wallet.manage')}</Link>
          </div>
          {list.map((s) => (
            <div key={s.slot} className="rounded-sm bg-btn p-2.5 space-y-1.5">
              <div className="flex items-center gap-2">
                <Dot ok={s.auth === 'ok' ? true : s.auth === 'checking' || s.auth === 'wrong_account' || s.auth === 'error' ? null : false} />
                <WalletTag slot={s.slot} />
                <span className="text-base font-medium truncate flex-1" title={lz(s.label)}>{lz(s.label)}{s.primary && <span className="ml-1 text-xs text-t4">{t('wallet.primary')}</span>}</span>
                {s.auth === 'ok' && s.bnb != null && <span className="flex items-center gap-1 text-sm"><BnbCoin size={12} />{bnb(s.bnb, 4)}</span>}
              </div>
              <div className="flex items-center gap-1 text-xs text-t4">
                {s.address && <>{short(s.address, 6, 4)}<CopyBtn text={s.address} /></>}
                {s.address && <a href={`https://bscscan.com/address/${s.address}`} target="_blank" rel="noreferrer" className="hover:text-t2">BscScan</a>}
                {s.auth !== 'ok' && !!s.authMessage && <span className="text-down truncate" title={authText(s.authCode, s.authCodeP, s.authMessage)}>{authText(s.authCode, s.authCodeP, s.authMessage).slice(0, 40)}</span>}
              </div>
              {s.auth !== 'ok' && s.auth !== 'wrong_account' && (
                <button onClick={() => { setOpen(false); setUI({ loginOpen: true, loginSlot: s.slot }) }} className="w-full h-7 rounded-xs bg-buy text-on-accent text-sm font-medium hover:brightness-110">{t('wallet.scanLogin')}</button>
              )}
              {s.auth === 'wrong_account' && (
                <button onClick={() => { setOpen(false); setUI({ loginOpen: true, loginSlot: s.slot }) }} className="w-full h-7 rounded-xs bg-warn/16 text-warn text-sm font-medium">{t('wallet.wrongAccount')}</button>
              )}
            </div>
          ))}
          <button disabled={!slots?.canAdd} title={slots?.canAddReason || undefined}
            onClick={() => { setOpen(false); setUI({ loginOpen: true, loginSlot: 'add' }) }}
            className="w-full h-8 rounded-sm bg-btn hover:bg-btn-2 text-sm text-t2 flex items-center justify-center gap-1.5 disabled:opacity-50">
            <Plus className="ico-sm" />{t('wallet.add')}{list.length >= 2 ? ` (${list.length}/8)` : ''}
          </button>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-sm bg-btn p-2">
              <div className="text-t3">{t('wallet.bnbBalance')}{logged.length > 1 ? t('wallet.allWallets') : ''}</div>
              <div className="text-md font-medium mt-0.5">{bnb(total, 4)}</div>
              {wbnb > 0 && <div className="text-xs text-t3 mt-0.5" title={t('wallet.wbnbTip')}>BNB {bnb(bal, 3)} + WBNB {bnb(wbnb, 3)}</div>}
            </div>
            <div className="rounded-sm bg-btn p-2"><div className="text-t3">{t('wallet.mode')}</div><div className={clsx('text-md font-medium mt-0.5', isReal() ? 'text-down' : 'text-warn')}>{mode !== 'live' ? t('mode.sim') : isReal() ? t('mode.live') : t('mode.demo')}</div></div>
          </div>
          {mode === 'live' && agentId && logged.length === 1 && (
            <div className="text-xs text-t4 text-center truncate">{agentId}{addr ? ` · ${short(addr, 4, 4)}` : ''}</div>
          )}
          {!!offline.length && <div className="text-xs text-warn">{t('wallet.offline', { n: offline.length })}</div>}
          {mode === 'live' && <button onClick={() => { setOpen(false); setUI({ setupOpen: true }) }} className="w-full text-xs text-t3 hover:text-t1">{t('wallet.setupCheck')}</button>}
        </div>
      )}
    </div>
  )
}

/** 钱包安全设置（参考 EZbot：读取并提示，不自动修改；只能在币安 App 里改）。按钱包读（?slot=N，默认主钱包） */
export function WalletSettings({ slot }: { slot?: number }) {
  const [v, setV] = useState<any>(null)
  const [err, setErr] = useState('')
  const t = useT()
  useEffect(() => { setV(null); setErr(''); api('/api/wallet-settings' + (slot ? '?slot=' + slot : '')).then(setV).catch((e) => setErr(e.message)) }, [slot])
  if (err) return <div className="text-xs text-t3">{t('ws.readFailed', { err })}</div>
  if (!v) return <div className="text-xs text-t3">{t('ws.reading')}</div>
  const dev = v.devMode || {}
  const rows: [string, string, 'ok' | 'warn' | 'bad', string?][] = [
    [t('ws.devMode'), dev.enabled ? `${t('ws.on')}${dev.expiresAt ? ` · ${t('ws.expires', { date: new Date(typeof dev.expiresAt === 'number' ? dev.expiresAt * 1000 : Date.parse(dev.expiresAt)).toLocaleDateString() })}` : ''}` : t('ws.off'), dev.enabled ? 'ok' : 'bad', t('ws.devModeTip')],
    [t('ws.abnormal'), v.abnormalTxnHandling === 'NeedConfirmation' ? t('ws.needConfirm') : v.abnormalTxnHandling === 'AutoReject' ? t('ws.autoReject') : String(v.abnormalTxnHandling ?? '—'), v.abnormalTxnHandling === 'AutoReject' ? 'warn' : 'ok', t('ws.abnormalTip')],
    [t('ws.scope'), v.tradeAllTokens ? t('ws.allTokens') : t('ws.whitelist'), v.tradeAllTokens ? 'ok' : 'warn', t('ws.scopeTip')],
    [t('ws.dailyQuota'), v.dailyLimit != null ? `$${Math.round(v.quotaUsed ?? 0)} / $${v.dailyLimit}` : '—', 'ok'],
    [t('ws.devQuota'), dev.dailyLimit != null ? `$${Math.round(v.developerModeQuotaUsed ?? 0)} / $${dev.dailyLimit}` : '—', 'ok'],
    [t('ws.sessionEnd'), v.sessionExpireTime ? new Date(v.sessionExpireTime).toLocaleString() : '—', 'ok'],
  ]
  return (
    <div className="rounded-sm bg-btn p-2.5 space-y-1.5">
      <div className="text-xs text-t3">{t('ws.title')}</div>
      {rows.map(([k, val, st, tip]) => (
        <div key={k} className="flex justify-between gap-2 text-sm" title={tip}>
          <span className="text-t3">{k}</span>
          <span className={clsx(st === 'bad' ? 'text-down' : st === 'warn' ? 'text-warn' : 'text-t1')}>{val}</span>
        </div>
      ))}
    </div>
  )
}
