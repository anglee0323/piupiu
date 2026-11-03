// 后端 HTTP 接口。写操作走同源（页面和 /api 同源，后端按 Origin 放行）。
import { lz } from './i18n'
import { DEMO, asset } from './env'

export class ApiError extends Error {
  status: number
  constructor(msg: string, status: number) { super(msg); this.status = status }
}

export async function api<T = any>(url: string, body?: unknown, init?: RequestInit): Promise<T> {
  if (DEMO) return (await import('./demo')).demoApi(url, body, init)   // 在线体验：没有后端，读录制的样本
  const r = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...init,
  })
  const j = await r.json().catch(() => null)
  if (!r.ok) throw new ApiError(lz(j?.error) || `HTTP ${r.status}`, r.status)   // 网关的中文提示按界面语言显示
  return j as T
}

/** 代币头像走后端代理（白名单图床 + 本地缓存） */
export const imgUrl = (u?: string | null) => (!u ? null : DEMO ? (u.startsWith('demo/') ? asset(u) : null) : `/api/img?u=${encodeURIComponent(u)}`)   // 在线体验：图片是录制时存下来的本地文件
