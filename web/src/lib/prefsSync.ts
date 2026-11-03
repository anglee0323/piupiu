// 界面设置同步到后端（data/prefs.json），给 zustand persist 当存储用：
//   读：后端有就用后端的（并写回 localStorage 当缓存）；后端没有而这个浏览器里已经有设置 → 第一次把它存上去；后端连不上 → 先用浏览器里的。
//   写：先写 localStorage，再防抖 0.8 秒存后端；页面关闭前补存一次。
// 防止误覆盖：
//   · 加载刚结束后的 1.5 秒内的写入不上传（persist 会在加载完马上回写一次，空浏览器会因此把「默认值」当成你的设置传上去）
//   · 加载时后端没连上的，先确认后端到底有没有设置再决定上传；后端已经有、内容又不同 → 这次不覆盖（刷新后会载入后端那份）
//   · 测试 / 临时浏览器想完全不同步：localStorage 设 prefs-sync-off = 1
import type { StateStorage } from 'zustand/middleware'
import { DEMO, EMBED } from './env'

type Srv = 'unknown' | 'down' | 'empty' | 'has'
let srv: Srv = 'unknown'
let pending: string | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let quietUntil = 0
let lastSent: string | null = null
const off = () => { if (DEMO) return true; try { return localStorage.getItem('prefs-sync-off') === '1' } catch { return true } }   // 在线体验没有后端

async function fetchServer(): Promise<string | null | undefined> {
  try { const r = await fetch('/api/prefs', { cache: 'no-store' }); if (!r.ok) return undefined; const j = await r.json(); return typeof j.value === 'string' ? j.value : null } catch { return undefined }
}
async function put(value: string): Promise<boolean> {
  try { const r = await fetch('/api/prefs', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }), keepalive: value.length < 60_000 }); if (r.ok) lastSent = value; return r.ok } catch { return false }
}
async function flush() {
  timer = null
  const v = pending; if (v == null || v === lastSent) return
  if (srv === 'unknown' || srv === 'down') {
    const sv = await fetchServer()
    if (sv === undefined) { timer = setTimeout(flush, 15_000); return }
    srv = sv ? 'has' : 'empty'
    if (sv && sv !== v) { console.warn('[prefs] 后端已经有一份不同的设置：这次不覆盖，刷新页面会载入后端那份'); pending = null; return }   // i18n-ignore（控制台日志）
  }
  if (!(await put(v))) timer = setTimeout(flush, 15_000)
  else if (pending === v) pending = null
}

export const prefsStorage: StateStorage = {
  getItem: async (name) => {
    if (EMBED) return null   // 官网里嵌入的展示画面：每次都用默认设置（黑暗、展开持仓），不受访客在在线体验里改过的设置影响
    const local = localStorage.getItem(name)
    if (off()) return local
    const sv = await fetchServer()
    quietUntil = Date.now() + 1500
    if (sv === undefined) { srv = 'down'; return local }
    if (sv) { srv = 'has'; lastSent = sv; try { localStorage.setItem(name, sv) } catch { /* 存满了也不影响 */ } return sv }
    srv = 'empty'
    if (local) void put(local)   // 后端第一次没有：把这个浏览器里已有的设置存上去
    return local
  },
  setItem: (name, value) => {
    if (EMBED) return
    try { localStorage.setItem(name, value) } catch { /* ignore */ }
    if (off() || Date.now() < quietUntil) return
    pending = value
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, 800)
  },
  removeItem: (name) => { try { localStorage.removeItem(name) } catch { /* ignore */ } },
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { if (!off() && pending != null && pending !== lastSent && srv !== 'down' && srv !== 'unknown') void put(pending) })
}
