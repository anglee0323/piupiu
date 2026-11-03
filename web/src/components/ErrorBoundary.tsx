// 错误边界：某个组件渲染出错时，只让那一块显示「出错了」，不会像以前那样整页变黑。
// resetKey 变化（比如切换页面）时自动恢复。
import { Component, type ReactNode } from 'react'
import { t as T } from '../lib/i18n'

interface Props { children: ReactNode; resetKey?: string; fallback?: 'page' | 'inline' | 'none'; name?: string }
interface State { err: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null }
  static getDerivedStateFromError(err: Error): State { return { err } }
  componentDidCatch(err: Error) { console.error(`[界面出错${this.props.name ? ' · ' + this.props.name : ''}]`, err) }   // i18n-ignore（控制台日志）
  componentDidUpdate(prev: Props) { if (this.state.err && prev.resetKey !== this.props.resetKey) this.setState({ err: null }) }
  render() {
    if (!this.state.err) return this.props.children
    const mode = this.props.fallback ?? 'page'
    if (mode === 'none') return null
    const box = (
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="text-md text-t1">{T('eb.failed')}</div>
        <div className="text-sm text-t3 max-w-[360px] break-words">{String(this.state.err.message || this.state.err).slice(0, 160)}</div>
        <div className="flex gap-2">
          <button className="h-8 px-4 rounded-sm bg-btn-2 text-t1 text-sm hover:bg-hover-2" onClick={() => this.setState({ err: null })}>{T('eb.retry')}</button>
          <button className="h-8 px-4 rounded-sm bg-btn text-t2 text-sm hover:bg-btn-2" onClick={() => location.reload()}>{T('eb.reload')}</button>
        </div>
      </div>
    )
    return mode === 'inline' ? <div className="h-9 px-3 flex items-center text-sm text-t3 gap-2">{T('eb.error')}<button className="underline" onClick={() => this.setState({ err: null })}>{T('eb.retry')}</button></div> : <div className="h-full min-h-[240px] grid place-items-center p-6">{box}</div>
  }
}
