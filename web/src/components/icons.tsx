// Lucide 没有的图标：X（推特）、平台角标、BNB 币标。风格和 Lucide 一致（24 网格、圆角描边）
import type { SVGProps } from 'react'
import type { Platform, PlatformFilter } from '../lib/types'
import { G } from './gi'
import { asset } from '../lib/env'

/** X（推特）：GMGN 的 Tweet 图标 */
/** X（原 Twitter）的标志 */
export function XLogo(p: SVGProps<SVGSVGElement>) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...p}><path fill="currentColor" d="M17.75 3h3.07l-6.71 7.67L22 21h-6.18l-4.84-6.33L5.44 21H2.37l7.18-8.2L2 3h6.33l4.38 5.79L17.75 3zm-1.08 16.18h1.7L7.4 4.73H5.58l11.09 14.45z" /></svg>
}

/** BNB 币标：和 GMGN 同一个字形（Bscbal），金色 */
export function BnbCoin({ size = 14 }: { size?: number }) {
  return <G n="Bscbal12px" className="flex-none" style={{ width: size, height: size, color: '#FED15C' }} />
}

export const PLATFORM: Record<Platform, { label: string; color: string; letter: string }> = {
  flap: { label: 'Flap', color: 'var(--color-flap)', letter: 'F' },
  four: { label: 'Four', color: 'var(--color-four)', letter: '4' },
  gang: { label: 'Gang', color: 'var(--color-gang)', letter: 'G' },
}
/** 颜色加透明度（颜色可以是 CSS 变量，所以不能再用「#rrggbb + 'aa'」拼接） */
export const alpha = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`
/** 顶栏发射台筛选项（gang 按版本拆开） */
export const PLATFORM_FILTERS: { id: PlatformFilter; label: string; logo: Platform; hint?: string }[] = [
  { id: 'flap', label: 'Flap', logo: 'flap' },
  { id: 'four', label: 'Four', logo: 'four' },
  { id: 'gang-v1', label: 'Gang V1', logo: 'gang' },
  { id: 'gang-v2', label: 'Gang V2', logo: 'gang' },
  { id: 'gang-v3', label: 'Gang V3', logo: 'gang' },
  { id: 'gang-fair', label: 'Gang 打新', logo: 'gang' },   // i18n-ignore（界面显示用 platform.gangFair）
  { id: 'gang-fly', label: 'Gang 飞轮', logo: 'gang' },   // i18n-ignore（界面显示用 platform.gangFly）
]

/** 平台角标：官方 Logo（public/platforms/，取自各平台官网，来源见 EZbot-agentic-wallet 的 PLATFORM-LOGOS.md） */
export function PlatformBadge({ p, size = 16, ring = 'var(--color-card)' }: { p: Platform; size?: number; ring?: string }) {
  const c = PLATFORM[p] || PLATFORM.flap
  return (
    <span className="inline-grid place-items-center rounded-full flex-none overflow-hidden"
      title={c.label} style={{ width: size, height: size, background: p.startsWith('gang') ? '#fcd535' : '#0d0d0d', boxShadow: `0 0 0 2px ${ring}` }}>
      {/* gang-v3 只是个筛选口径，logo 还是用 gang 官方的 */}
      <img src={asset(`platforms/${p.startsWith('gang') ? 'gang' : p}.svg`)} alt={c.label} draggable={false} style={{ width: p.startsWith('gang') ? '100%' : '78%', height: p.startsWith('gang') ? '100%' : '78%' }} />
    </span>
  )
}
