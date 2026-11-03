// 提醒声音的出口：战壕新币、钱包追踪、雷达新推荐「要不要响、响什么」由 Gateway 判断（engine/live/notifier.js），
// 通过 WebSocket 的 alert 事件告诉页面；这里只负责播放（sound.ts 里另有「1.2 秒内只响一个」的全局间隔）。
// 用户主动试听（声音选择器、音量滑块）不走这里，直接用 sound.ts 的 playSound / previewSound。
import { isSoundKind, playSound } from './sound'
import type { SoundKind } from '../store/prefs'

/** Gateway 推来的提醒（engine/live/notifier.js 的 alert） */
export type Alert =
  | { source: 'trench'; at: number; col: 'new' | 'soon' | 'dex'; sound: string; tokens: { address: string; symbol: string }[] }
  | { source: 'track'; at: number; id: string; target: string; sound: string }
  | { source: 'radar'; at: number; ids: string[]; items: { id: string; address: string; title: string }[]; sound: string | null }

/** 播放 Gateway 指定的声音；不认识的声音名用 fallback */
export function playAlert(kind: string | null | undefined, fallback: SoundKind = 'Bell'): boolean {
  if (!kind || kind === 'Off') return false
  playSound(isSoundKind(kind) ? kind : fallback)
  return true
}
