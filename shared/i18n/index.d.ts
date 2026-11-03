export type Lang = 'zh' | 'en'
export declare const LANGS: Lang[]
export declare const DICTS: Record<Lang, Record<string, string>>
export declare function translate(lang: string | null | undefined, key: string, params?: Record<string, string | number | null | undefined>): string
export declare function localize(lang: string | null | undefined, text: string | null | undefined, depth?: number): string
