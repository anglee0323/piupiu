// 界面里取文案：组件里用 const t = useT()；store / 工具函数里用 t()（按当前语言）。字典在 shared/i18n/。
import { useCallback } from 'react'
import { translate, localize } from '../../../shared/i18n/index.js'
import { usePrefs } from '../store/prefs'

type P = Record<string, string | number | null | undefined>
export const t = (key: string, params?: P) => translate(usePrefs.getState().lang, key, params)
export function useT() {
  const lang = usePrefs((s) => s.lang)
  return useCallback((key: string, params?: P) => translate(lang, key, params), [lang])
}

// 网关返回的中文提示（报错、订单原因、任务记录）按当前语言显示（shared/i18n 的 localize，按 gw.* 模板反查）
export const lz = (text: string | null | undefined) => localize(usePrefs.getState().lang, text)
