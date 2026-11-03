import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'

// mac 桌面版（Electron，系统标题栏已隐藏）：顶栏要给红绿灯留位置、可拖动窗口（index.css 的 .mac-shell）
if (/Electron\//.test(navigator.userAgent) && /Mac/.test(navigator.platform)) document.documentElement.classList.add('mac-shell')
// Windows 桌面版：系统标题栏已隐藏，窗口按钮叠在顶栏右侧（index.css 的 .win-shell）
if (/Electron\//.test(navigator.userAgent) && /Win/.test(navigator.platform)) { document.documentElement.classList.add('win-shell'); if ((window as any).piupiuWindow) document.documentElement.classList.add('win-own') }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
      <ErrorBoundary name="根"><App /></ErrorBoundary>{/* i18n-ignore */}
    </BrowserRouter>
  </StrictMode>,
)
// 兜底：任何链接 / 图片的拖拽一律取消（上面的 CSS 之外再拦一道，覆盖带 draggable 的情况）
document.addEventListener('dragstart', (e) => { if ((e.target as HTMLElement | null)?.closest?.('a, img')) e.preventDefault() })
