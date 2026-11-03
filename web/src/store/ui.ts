// 全局弹窗状态：搜索面板、登录（loginSlot：给哪个钱包槽位登录；'add' = 添加新钱包）、设置、下单确认
import { create } from 'zustand'

export interface ConfirmReq { title: string; rows: [string, string][]; body?: string; danger?: boolean; note?: string; okText?: string; order?: boolean; resolve: (ok: boolean) => void }

interface UI {
  searchOpen: boolean
  loginOpen: boolean
  loginSlot: number | 'add' | null
  settingsOpen: boolean
  settingsTab: string | null   // 打开设置弹窗时直接定位到哪个页签（如 'topbar'）；关闭后清空
  setupOpen: boolean           // 使用前检查（components/SetupGuide.tsx）
  connectHint: boolean         // 右上角「连接钱包」旁的引导气泡（首次进入、尚未登录时显示一次）
  confirm: ConfirmReq | null
  set: (p: Partial<Omit<UI, 'set' | 'ask'>>) => void
  ask: (r: Omit<ConfirmReq, 'resolve'>) => Promise<boolean>
}

export const useUI = create<UI>((set) => ({
  searchOpen: false, loginOpen: false, loginSlot: null, settingsOpen: false, settingsTab: null, setupOpen: false, connectHint: false, confirm: null,
  set: (p) => set(p),
  ask: (r) => new Promise<boolean>((resolve) => set({ confirm: { ...r, resolve: (ok) => { set({ confirm: null }); resolve(ok) } } })),
}))
