// 底栏：和 GMGN 一样当 Dock 用——左边开关侧边面板，中间行情，右边连接状态
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Eye, Briefcase, Fuel, Boxes, Activity, Send } from './gi'
import clsx from 'clsx'
import { useApp } from '../store/app'
import { usePrefs } from '../store/prefs'
import { gasLabel, isReal } from '../lib/trade'
import { BnbCoin, XLogo } from './icons'
import { SOCIAL } from '../../../shared/links.js'
import { BRAND } from '../brand'
import { AutomationChip } from './AutomationChip'
import { UpdateChip } from './UpdateChip'
import { useT } from '../lib/i18n'

export function BottomBar() {
  const t = useT()
  const trackDock = usePrefs((s) => s.trackDock)
  const set = usePrefs((s) => s.set)
  const bnbUsd = useApp((s) => s.bnbUsd)
  const block = useApp((s) => s.block)
  const net = useApp((s) => s.net)
  const wsOk = useApp((s) => s.wsOk)
  const gas = useApp((s) => s.settings?.gas)
  const mode = useApp((s) => s.mode)
  const feedN = useApp((s) => s.track.feed.length)
  const rpc = net?.rpc
  const downAt = useApp((s) => s.wsDownAt)
  const [, tick] = useState(0)
  useEffect(() => { const h = setInterval(() => tick((x) => x + 1), 2000); return () => clearInterval(h) }, [])
  // 三种状态：应用推送断了 = 连接中（超过 15 秒才是异常）；推送正常但链上订阅还在重连 / RPC 很慢 = 同步中
  const downFor = downAt ? Date.now() - downAt : 0
  // 只看「本机页面 ↔ 后端」这条连接和读链延迟；上游订阅（Four / Flush / 行情源）的状态写在悬停提示里，
  // 它们 partial 可能持续很久，不该一直把底栏染成黄色。
  const state: 'ok' | 'sync' | 'bad' = wsOk ? (rpc != null && rpc >= 1500 ? 'sync' : 'ok') : downFor > 15_000 ? 'bad' : 'sync'
  const label = state === 'ok' ? t('bottom.ok') : state === 'sync' ? (wsOk ? t('bottom.sync') : t('bottom.connecting')) : t('bottom.bad')
  const tone = state === 'ok' ? 'text-up bg-up/10' : state === 'sync' ? 'text-warn bg-warn/10' : 'text-down bg-down/10'
  return (
    <footer className="h-[32px] flex-none flex items-center gap-1 px-2 bg-bg-deep border-t border-line text-sm">
      <DockBtn on={trackDock} onClick={() => set({ trackDock: !trackDock })} icon={<Eye className="ico" />} label={t('bottom.track')} badge={feedN ? undefined : undefined} />
      <Link to="/portfolio" className="h-6 px-2 flex items-center gap-1.5 rounded-xs text-t2 hover:text-t1 hover:bg-btn"><Briefcase className="ico" />{t('bottom.portfolio')}</Link>
      <AutomationChip />
      <span className="w-px h-4 bg-line-2 mx-2" />
      <span className="flex items-center gap-1.5 text-t2" title={t('bottom.bnbPrice')}><BnbCoin size={13} />${bnbUsd ? bnbUsd.toFixed(2) : '—'}</span>
      <span className="flex items-center gap-1 text-t3 ml-3" title={t('bottom.gasTip')}><Fuel className="ico" />{gas ? gasLabel(gas) : '—'}</span>
      <span className="flex items-center gap-1 text-t3 ml-3" title={t('bottom.block')}><Boxes className="ico" />{block ? block.toLocaleString() : '—'}</span>
      <div className="flex-1" />
      {/* 更新入口放在连接状态旁边（右下角），比混在左边的功能按钮里更容易看到 */}
      <UpdateChip />
      <span className={clsx('h-6 px-2 flex items-center gap-1.5 rounded-xs', tone)}
        title={t('bottom.netTip', { ws: wsOk ? t('bottom.wsOn') : t('bottom.wsOff'), node: net?.rpcNode?.active || '', ms: rpc ?? '—', sub: net?.wssState || '—' })}>
        <Activity className="ico" />{label} {rpc != null && <span className="text-t3">{rpc}ms</span>}
      </span>
      {/* 真实下单时不显示模式（这里以后放常用链接）；模拟盘 / 演示模式仍然提示：这时下单不会真成交 */}
      {!(mode === 'live' && isReal()) && <span className='h-6 px-2 ml-1 flex items-center rounded-xs text-warn'>{mode !== 'live' ? t('mode.sim') : t('mode.demo')}</span>}
      <SocialLinks />
      <span className="text-t4 ml-2">{BRAND.name}</span>
    </footer>
  )
}

/** 官方 X 与 Telegram 群（地址在 shared/links.js；还没有账号时图标变灰，悬停提示「即将开放」） */
function SocialLinks() {
  const t = useT()
  const items: [string, string, React.ReactNode][] = [['x', SOCIAL.x, <XLogo className="w-3 h-3" />], ['telegram', SOCIAL.telegram, <Send className="ico" />]]
  return (
    <span className="flex items-center gap-0.5 ml-2">
      {items.map(([k, url, icon]) => url
        ? <a key={k} href={url} target="_blank" rel="noreferrer" title={t('bottom.' + k)} aria-label={t('bottom.' + k)} className="w-6 h-6 grid place-items-center rounded-xs text-t3 hover:text-t1 hover:bg-btn">{icon}</a>
        : <span key={k} title={t('bottom.soon', { name: t('bottom.' + k) })} aria-label={t('bottom.' + k)} className="w-6 h-6 grid place-items-center rounded-xs text-t4 cursor-default">{icon}</span>)}
    </span>
  )
}

function DockBtn({ on, onClick, icon, label }: { on: boolean; onClick: () => void; icon: React.ReactNode; label: string; badge?: number }) {
  return (
    <button onClick={onClick} className={clsx('h-6 px-2 flex items-center gap-1.5 rounded-xs transition-colors', on ? 'bg-btn-2 text-t1' : 'text-t2 hover:text-t1 hover:bg-btn')}>
      {icon}{label}
    </button>
  )
}
