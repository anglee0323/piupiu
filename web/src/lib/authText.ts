// 登录状态说明：网关给了文案键就按当前语言显示，否则用网关的原文（例如 baw 的原始报错）
import { t as T } from './i18n'
import { usePrefs } from '../store/prefs'

export const authText = (code?: string | null, p?: Record<string, string> | null, msg?: string | null) =>
  code && usePrefs.getState().lang !== 'zh' ? T(code, p || undefined) : msg || ''
