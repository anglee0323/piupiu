// Alert sounds (open-source build): short tones synthesized with Web Audio, no audio files.
// Same exports and behaviour as the official build: one global volume, hover-to-preview, one sound at a time.
import { usePrefs, type SoundKind } from '../store/prefs'

export const SOUND_KINDS: SoundKind[] = ['Bell', 'Boom', 'Cheer', 'Coins', 'C', 'H', 'Handgun', 'Kaching', 'Nice', 'Pop', 'Shotgun', 'Sonumi', 'Yes', 'Alipay', 'Wechat']
export const SOUNDS: { id: SoundKind; label: string }[] = SOUND_KINDS.map((id) => ({ id, label: id }))
export const isSoundKind = (v: unknown): v is SoundKind => typeof v === 'string' && (SOUND_KINDS as string[]).includes(v)

// Each sound is a few notes: [frequency Hz, start s, length s, wave]
type Note = [number, number, number, OscillatorType]
const TONES: Record<SoundKind, Note[]> = {
  Bell: [[1318, 0, 0.6, 'sine'], [1976, 0, 0.4, 'sine']],
  Boom: [[90, 0, 0.35, 'triangle'], [60, 0.05, 0.35, 'sine']],
  Cheer: [[784, 0, 0.12, 'square'], [988, 0.12, 0.12, 'square'], [1175, 0.24, 0.2, 'square']],
  Coins: [[1568, 0, 0.08, 'triangle'], [2093, 0.09, 0.18, 'triangle']],
  C: [[523, 0, 0.25, 'sine']],
  H: [[988, 0, 0.25, 'sine']],
  Handgun: [[180, 0, 0.12, 'sawtooth']],
  Kaching: [[2637, 0, 0.06, 'square'], [3136, 0.07, 0.25, 'triangle']],
  Nice: [[659, 0, 0.12, 'sine'], [880, 0.13, 0.22, 'sine']],
  Pop: [[600, 0, 0.07, 'sine']],
  Shotgun: [[120, 0, 0.18, 'sawtooth'], [80, 0.02, 0.2, 'square']],
  Sonumi: [[440, 0, 0.15, 'triangle'], [554, 0.15, 0.15, 'triangle'], [659, 0.3, 0.25, 'triangle']],
  Yes: [[880, 0, 0.1, 'sine'], [1320, 0.11, 0.18, 'sine']],
  Alipay: [[1046, 0, 0.12, 'sine'], [1318, 0.12, 0.12, 'sine'], [1568, 0.24, 0.25, 'sine']],
  Wechat: [[740, 0, 0.1, 'triangle'], [740, 0.16, 0.1, 'triangle']],
}

let ctx: AudioContext | null = null
function audioCtx() {
  if (ctx && ctx.state !== 'closed') return ctx
  try { ctx = new AudioContext() } catch { ctx = null }
  return ctx
}
if (typeof window !== 'undefined') {
  const unlock = () => { audioCtx()?.resume().catch(() => {}); window.removeEventListener('pointerdown', unlock, true); window.removeEventListener('keydown', unlock, true) }
  window.addEventListener('pointerdown', unlock, true); window.addEventListener('keydown', unlock, true)
}

let previewOut: GainNode | null = null
async function play(k: SoundKind, { preview = false } = {}) {
  const vol = Math.max(0, Math.min(1, usePrefs.getState().soundVolume ?? 0.5))
  const c = audioCtx()
  if (!(vol > 0) || !c) return
  if (c.state === 'suspended') await Promise.race([c.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1500))])
  if (c.state !== 'running') return
  const out = c.createGain(); out.gain.value = vol * 0.4; out.connect(c.destination)
  if (preview) { try { previewOut?.disconnect() } catch { /* already gone */ } previewOut = out }
  const t0 = c.currentTime + 0.01
  for (const [f, at, len, wave] of TONES[k] || TONES.Bell) {
    const o = c.createOscillator(), g = c.createGain()
    o.type = wave; o.frequency.value = f
    g.gain.setValueAtTime(0.0001, t0 + at); g.gain.exponentialRampToValueAtTime(1, t0 + at + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len)
    o.connect(g); g.connect(out); o.start(t0 + at); o.stop(t0 + at + len + 0.02)
  }
}

let lastAt = 0
const GAP = 1200
export function playSound(kind?: SoundKind | 'Off' | null) {
  if (!kind || kind === 'Off') return
  const now = Date.now(); if (now - lastAt < GAP) return
  lastAt = now; void play(kind)
}

let hoverT = 0
export function previewSound(kind: SoundKind) { clearTimeout(hoverT); hoverT = window.setTimeout(() => void play(kind, { preview: true }), 120) }
export function cancelPreview() { clearTimeout(hoverT) }
