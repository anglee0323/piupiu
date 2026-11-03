// 数字 / 时间格式化（和 GMGN 一致：$34K、0.0₅71、51m）

import type { Platform, PlatformFilter } from './types'
import { gangVer, launchpadOf, inPlatforms } from '../../../shared/filters.js'   // 平台归属和筛选共用一份（Gateway 判断提醒也用）
import { t as T } from './i18n'
export { gangVer, launchpadOf, inPlatforms }

/** 发射台：Gang 的四个版本是四个独立的发射台（合约、规则都不同），和 Flap、Four 平级。
 *  所有显示平台的地方（筛选、卡片角标、详情页标签、代币信息）都用这里的名字 */
export const LAUNCHPAD_LABEL: Record<PlatformFilter, string> = { flap: 'Flap', four: 'Four', 'gang-v1': 'Gang V1', 'gang-v2': 'Gang V2', 'gang-v3': 'Gang V3', 'gang-fair': 'Gang 打新', 'gang-fly': 'Gang 飞轮' }   // i18n-ignore（打新 / 飞轮的显示名由 launchpadLabel 按语言取 lp.gangFair / lp.gangFly）
export const launchpadLabel = (t: { platform: Platform; gangTrack?: string | null }) => { const k = launchpadOf(t); return k === 'gang-fair' ? T('lp.gangFair') : k === 'gang-fly' ? T('lp.gangFly') : LAUNCHPAD_LABEL[k] }

const SUBS = '₀₁₂₃₄₅₆₇₈₉'

/** 很小的数用下标零：0.0000071 → 0.0₅71 */
export function small(x: number, sig = 4): string {
  if (!isFinite(x)) return '—'
  if (x === 0) return '0'
  const a = Math.abs(x)
  if (a >= 1) return x.toLocaleString('en-US', { maximumFractionDigits: 4 })
  if (a >= 0.001) return x.toFixed(Math.max(4, sig + 1)).replace(/0+$/, '').replace(/\.$/, '')
  const zeros = -Math.floor(Math.log10(a)) - 1
  const digits = String(Math.round(a * 10 ** (zeros + sig))).slice(0, sig).replace(/0+$/, '')
  return (x < 0 ? '-' : '') + '0.0' + String(zeros).split('').map((d) => SUBS[+d]).join('') + digits
}

/** 紧凑数字：1234 → 1.23K */
export function compact(n: number | null | undefined, d = 2): string {
  if (n == null || !isFinite(n)) return '—'
  const a = Math.abs(n)
  const f = (v: number, s: string) => (+v.toFixed(d)).toString() + s
  if (a >= 1e9) return f(n / 1e9, 'B')
  if (a >= 1e6) return f(n / 1e6, 'M')
  if (a >= 1e3) return f(n / 1e3, 'K')
  if (a >= 1) return (+n.toFixed(d)).toString()
  return small(n)
}

export const usd = (n: number | null | undefined, d = 2) => (n == null || !isFinite(n) || n === 0 ? '—' : (n < 0 ? '-$' : '$') + compact(Math.abs(n), d))
export const usdSigned = (n: number | null | undefined) => (n == null || !isFinite(n) ? '—' : (n >= 0 ? '+$' : '-$') + compact(Math.abs(n)))
export const bnb = (n: number | null | undefined, d = 4) => (n == null || !isFinite(n) ? '—' : n !== 0 && Math.abs(n) < 0.0001 ? small(n) : (+n.toFixed(d)).toString())
export const pct = (n: number | null | undefined, d = 2) => (n == null || !isFinite(n) ? '—' : (n > 0 ? '+' : '') + n.toFixed(d) + '%')
export const short = (a?: string | null, h = 4, t = 4) => (a ? `${a.slice(0, h + 2)}…${a.slice(-t)}` : '')

export function age(ts?: number | null): string {
  if (!ts) return '—'
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return Math.floor(s) + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm'
  if (s < 86400) return Math.floor(s / 3600) + 'h'
  return Math.floor(s / 86400) + 'd'
}

export function fullTime(ts?: number | null): string {
  if (!ts) return ''
  const d = new Date(ts), p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export const hms = (ts: number) => new Date(ts).toTimeString().slice(0, 8)

/** 币龄颜色：GMGN 新币时间是绿色，久了变黄 */
export const ageColor = (ts?: number | null) => (!ts ? 'text-t3' : Date.now() - ts < 3600_000 ? 'text-buy' : 'text-warn')
