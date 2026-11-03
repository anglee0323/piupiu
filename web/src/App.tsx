import { useEffect, useState } from 'react'
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Loader2 } from './components/gi'
import { useApp } from './store/app'
import { usePrefs } from './store/prefs'
import { TopBar } from './components/TopBar'
import { BottomBar } from './components/BottomBar'
import { SearchPalette } from './components/SearchPalette'
import { ConfirmModal, LoginModal, SettingsModal, Toasts } from './components/Modals'
import { TrenchesPage } from './pages/Trenches'
import { TokenPage } from './pages/Token'
import { PortfolioPage } from './pages/Portfolio'
import { FollowPage, TrackDock } from './panels/Track'
import { LogoMark } from './brand'
import { TrendPage } from './pages/Trend'
import { CopyPage } from './pages/Copy'
import { SnipePage } from './pages/Snipe'
import { RadarPage } from './pages/Radar'
import { WalletsPage } from './pages/Wallets'
import { TopStrip } from './components/TopStrip'
import { TraderDrawer } from './components/TraderDrawer'
import { ErrorBoundary } from './components/ErrorBoundary'
import { RadarAlerts } from './components/RadarAlerts'
import { SetupGuide } from './components/SetupGuide'
import { WarmGate } from './components/common'
import { DemoBar, DemoLoginModal } from './components/DemoBar'
import { DEMO, EMBED, demoParam } from './lib/env'

// 官网嵌入的展示画面：按设计宽度（?w=，默认 1280）缩放到 iframe 的大小（用 zoom 重新排版，文字仍是清晰的矢量字）
if (EMBED) { const fit = () => { (document.documentElement.style as any).zoom = String(innerWidth / Number(demoParam('w') || 1280)) }; fit(); addEventListener('resize', fit) }
// 在线体验在手机上打开：按桌面宽度排版后整体缩小，可双指放大（界面本身为桌面设计）
if (DEMO && !EMBED && screen.width < 1024) document.querySelector('meta[name=viewport]')?.setAttribute('content', 'width=1280')
// 在线体验跟随官网选的语言（官网把语言存在 localStorage 的 lang，嵌入画面用 ?lang=）
if (DEMO) {
  const l = demoParam('lang') || (() => { try { return localStorage.getItem('lang') } catch { return null } })()
  const apply = () => { if (l === 'en' || l === 'zh') usePrefs.setState({ lang: l }) }
  apply(); usePrefs.persist.onFinishHydration(apply)   // 本地缓存的设置载入后再套一次，以官网的选择为准
  // 第一次打开：顶部栏展开「持仓代币」，一眼看到正常使用时的样子
  const first = (() => { try { return !localStorage.getItem('terminal-prefs') } catch { return false } })()
  const open = () => usePrefs.setState({ topStrip: 'hold' })
  if (first || EMBED) { open(); usePrefs.persist.onFinishHydration(open) }
}

export default function App() {
  const ready = useApp((s) => s.ready)
  const init = useApp((s) => s.init)
  const trackDock = usePrefs((s) => s.trackDock)
  const theme = usePrefs((s) => s.theme), lang = usePrefs((s) => s.lang)
  // 主题和语言挂在 <html> 上（index.css 按 data-theme 换配色）；首屏由 Gateway 写进 index.html，避免加载时闪一下
  useEffect(() => { document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light'; document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN' }, [theme, lang])
  const loc = useLocation()
  const nav = useNavigate()
  // 官网嵌入的展示画面：官网让它换页面 / 换语言；载入完成后告诉官网（官网先显示截图，收到后换成实时界面）
  useEffect(() => {
    if (!EMBED) return
    const h = (e: MessageEvent) => {
      if (e.origin !== location.origin) return
      if (e.data?.type === 'piupiu-go' && typeof e.data.path === 'string') nav(e.data.path)
      if (e.data?.type === 'piupiu-lang' && (e.data.lang === 'en' || e.data.lang === 'zh')) usePrefs.setState({ lang: e.data.lang })
    }
    addEventListener('message', h); return () => removeEventListener('message', h)
  }, [nav])
  useEffect(() => { if (EMBED && ready) setTimeout(() => parent.postMessage({ type: 'piupiu-ready' }, location.origin), 400) }, [ready])
  // 设置从后端载入完（异步）之前不渲染、也不连行情：否则会先用默认设置跑一会儿（提示音、筛选都不对）
  const [hyd, setHyd] = useState(() => usePrefs.persist.hasHydrated())
  useEffect(() => { if (usePrefs.persist.hasHydrated()) setHyd(true); return usePrefs.persist.onFinishHydration(() => setHyd(true)) }, [])
  useEffect(() => { if (hyd) init().catch(() => setTimeout(() => location.reload(), 3000)) }, [init, hyd])
  if (!ready || !hyd) return <div className="h-full grid place-items-center"><div className="flex flex-col items-center gap-3 text-t3"><LogoMark size={44} /><Loader2 className="ico spin" /></div></div>
  return (
    <div className="h-full flex flex-col relative">
      {DEMO && <DemoBar />}
      <ErrorBoundary fallback="inline" name="顶栏"><TopBar /></ErrorBoundary>{/* i18n-ignore（name 只用于控制台日志） */}
      <ErrorBoundary fallback="none" name="顶部栏"><TopStrip /></ErrorBoundary>{/* i18n-ignore */}
      <div className="flex-1 min-h-0 flex">
        {/* 钱包追踪在左侧：交易面板始终贴着窗口右边，开关追踪时下单按钮位置不动 */}
        {trackDock && <ErrorBoundary fallback="none" name="钱包追踪"><TrackDock /></ErrorBoundary>}{/* i18n-ignore */}
        <main className="flex-1 min-w-0 min-h-0">
          <ErrorBoundary resetKey={loc.pathname} name="页面">{/* i18n-ignore */}
          <Routes>
            <Route path="/" element={<WarmGate><TrenchesPage /></WarmGate>} />
            <Route path="/token/:address" element={<TokenPage />} />
            <Route path="/trend" element={<WarmGate><TrendPage /></WarmGate>} />
            <Route path="/copy" element={<CopyPage />} />
            <Route path="/snipe" element={<SnipePage />} />
            <Route path="/radar" element={<RadarPage />} />
            <Route path="/portfolio" element={<PortfolioPage />} />
            <Route path="/wallets" element={<WalletsPage />} />
            <Route path="/follow" element={<FollowPage />} />
            <Route path="*" element={<WarmGate><TrenchesPage /></WarmGate>} />
          </Routes>
          </ErrorBoundary>
        </main>
      </div>
      <ErrorBoundary fallback="none" name="底栏"><BottomBar /></ErrorBoundary>{/* i18n-ignore */}
      <ErrorBoundary fallback="none" name="弹窗">{/* i18n-ignore */}
        <SearchPalette />
        <SettingsModal />
        {DEMO ? <DemoLoginModal /> : <LoginModal />}
        <SetupGuide />
        <ConfirmModal />
        <Toasts />
        <RadarAlerts />
        <TraderDrawer />
      </ErrorBoundary>
    </div>
  )
}
