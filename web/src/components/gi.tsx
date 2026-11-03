// Icons (open-source build): Lucide icons under the same component names and icon keys the app uses.
// The official build renders its own icon font here; this file keeps every call site unchanged.
import type { CSSProperties, ComponentType } from 'react'
import * as Lc from 'lucide-react'

type P = { className?: string; style?: CSSProperties; fill?: string; strokeWidth?: number; title?: string }
type L = ComponentType<{ className?: string; style?: CSSProperties; fill?: string; strokeWidth?: number }>

const MAP: Record<string, L> = {
  Search16pxRegular: Lc.Search, Gmgnsearch20px: Lc.Search, Settings16pxRegular: Lc.Settings, Slippage16pxRegular: Lc.SlidersHorizontal,
  Wallet16pxRegular: Lc.Wallet, Earth16pxRegular: Lc.Globe, Website16pxRegular: Lc.Globe, Gmgnexpand16pxRegular: Lc.ChevronDown,
  Arrowright16pxRegular: Lc.ArrowRight, History16pxRegular: Lc.History, Hide16pxRegular: Lc.EyeOff, Track16pxRegular: Lc.Eye,
  Audioon16pxRegular: Lc.Volume2, Volume16pxRegular: Lc.Volume2, Mute16pxRegular: Lc.VolumeX, Filter16pxRegular: Lc.Filter,
  Quickbuy16pxBold: Lc.Zap, Telegram16pxRegular: Lc.Send, Holder16pxRegular: Lc.Users, Xcommunity16pxRegular: Lc.Users,
  Dev16pxRegular: Lc.UserRound, Blacklistdev16pxRegular: Lc.UserX, Copy16pxRegular: Lc.Copy, Checkmark16pxRegular: Lc.Check,
  Close16pxRegular: Lc.X, Newtab16pxRegular: Lc.ExternalLink, Edit16pxRegular: Lc.Pencil, Fromto16pxRegular: Lc.ArrowLeftRight,
  Percent16pxRegular: Lc.Percent, Dollar16pxRegular: Lc.Coins, Bscbal12px: Lc.Coins, Lock16pxRegular: Lc.Lock,
  Holderreward16pxRegular: Lc.Gift, Activepositions16pxBold: Lc.Briefcase, Gas16pxRegular: Lc.Fuel, Chain16pxRegular: Lc.Boxes,
  Signal16pxBold: Lc.Activity, Paused16pxRegular: Lc.Pause, Delete16pxRegular: Lc.Trash2, Plus16pxRegular: Lc.Plus,
  Refresh16pxRegular: Lc.RefreshCw, Warning16pxRegular: Lc.TriangleAlert, Error16pxRegular: Lc.CircleAlert, Safe16pxRegular: Lc.ShieldCheck,
  Security16pxRegular: Lc.ShieldAlert, Timer16pxRegular: Lc.Clock, Arrowup16pxRegular: Lc.ArrowUp, Arrowdown16pxRegular: Lc.ArrowDown,
  Drag16pxRegular: Lc.GripHorizontal, Phone16pxBold: Lc.Smartphone, Info16pxRegular: Lc.Info, Success16pxRegular: Lc.CircleCheck,
  Play16pxRegular: Lc.Play, Stop16pxBold: Lc.Power, Unwatch16pxRegular: Lc.Star, Watched16pxBold: Lc.Star,
  Officialx16pxRegular: Lc.AtSign, Tweet16pxRegular: Lc.MessageSquare,
}

/** Render an icon by its key, e.g. <G n="Quickbuy16pxBold" /> */
export function G({ n, className, style, title }: { n: string } & P) {
  const I = MAP[n]
  if (!I) return null
  const filled = /Bold$/.test(n) && n.startsWith('Watched')
  const el = <I className={className || 'ico'} style={style} fill={filled ? 'currentColor' : 'none'} strokeWidth={2} />
  return title ? <span title={title} className="inline-flex">{el}</span> : el
}

const mk = (n: string) => (p: P) => <G n={n} {...p} />

export const Search = mk('Search16pxRegular')
export const Settings = mk('Settings16pxRegular')
export const Settings2 = mk('Slippage16pxRegular')
export const Wallet = mk('Wallet16pxRegular')
export const LogIn = mk('Wallet16pxRegular')
export const Layers = mk('Earth16pxRegular')
export const ChevronDown = mk('Gmgnexpand16pxRegular')
export const ChevronRight = mk('Arrowright16pxRegular')
export const History = mk('History16pxRegular')
export const EyeOff = mk('Hide16pxRegular')
export const Eye = mk('Track16pxRegular')
export const Volume2 = mk('Audioon16pxRegular')
export const VolumeX = mk('Mute16pxRegular')
export const Filter = mk('Filter16pxRegular')
export const Zap = mk('Quickbuy16pxBold')
export const Globe = mk('Website16pxRegular')
export const Send = mk('Telegram16pxRegular')
export const Users = mk('Holder16pxRegular')
export const UserRound = mk('Dev16pxRegular')
export const Copy = mk('Copy16pxRegular')
export const Check = mk('Checkmark16pxRegular')
export const X = mk('Close16pxRegular')
export const ExternalLink = mk('Newtab16pxRegular')
export const Pencil = mk('Edit16pxRegular')
export const ArrowLeftRight = mk('Fromto16pxRegular')
export const Percent = mk('Percent16pxRegular')
export const Coins = mk('Dollar16pxRegular')
export const Lock = mk('Lock16pxRegular')
export const Gift = mk('Holderreward16pxRegular')
export const Briefcase = mk('Activepositions16pxBold')
export const Fuel = mk('Gas16pxRegular')
export const Boxes = mk('Chain16pxRegular')
export const Activity = mk('Signal16pxBold')
export const Pause = mk('Paused16pxRegular')
export const Trash2 = mk('Delete16pxRegular')
export const Plus = mk('Plus16pxRegular')
export const RefreshCw = mk('Refresh16pxRegular')
export const AlertTriangle = mk('Warning16pxRegular')
export const AlertCircle = mk('Error16pxRegular')
export const ShieldCheck = mk('Safe16pxRegular')
export const ShieldAlert = mk('Security16pxRegular')
export const Clock = mk('Timer16pxRegular')
export const ArrowUp = mk('Arrowup16pxRegular')
export const ArrowDown = mk('Arrowdown16pxRegular')
export const GripHorizontal = mk('Drag16pxRegular')
export const Smartphone = mk('Phone16pxBold')
export const Info = mk('Info16pxRegular')
export const CheckCircle2 = mk('Success16pxRegular')
export const XCircle = mk('Error16pxRegular')
export const Play = mk('Play16pxRegular')
export const Power = mk('Stop16pxBold')
export const Star = (p: P) => <G n={p.fill && p.fill !== 'none' ? 'Watched16pxBold' : 'Unwatch16pxRegular'} {...p} />

export { Loader2, Sun, Moon } from 'lucide-react'
