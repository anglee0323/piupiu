// K 线（TradingView Lightweight Charts）：基础 K 线按选的周期聚合；市值 = 价格 × (当前市值 / 当前价格)
import { useEffect, useMemo, useRef, useState } from 'react'
import { createChart, CrosshairMode, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts'
import clsx from 'clsx'
import { usePrefs } from '../store/prefs'
import type { Candle, TokenDetail } from '../lib/types'
import { compact, small } from '../lib/format'
import { useT } from '../lib/i18n'

const IVS: [number, string][] = [[1, '1s'], [5, '5s'], [15, '15s'], [60, '1m'], [300, '5m'], [900, '15m'], [3600, '1h'], [14400, '4h']]
const TZ = -new Date().getTimezoneOffset() * 60   // 图表库按 UTC 画，换成本地时间

function aggregate(cs: Candle[], iv: number, k: number) {
  const out: { time: UTCTimestamp; open: number; high: number; low: number; close: number; v: number }[] = []
  for (const c of cs) {
    const t = (Math.floor(c.t / iv) * iv + TZ) as UTCTimestamp
    const last = out[out.length - 1]
    if (last && last.time === t) { last.high = Math.max(last.high, c.h * k); last.low = Math.min(last.low, c.l * k); last.close = c.c * k; last.v += c.v }
    else out.push({ time: t, open: c.o * k, high: c.h * k, low: c.l * k, close: c.c * k, v: c.v })
  }
  return out
}

const BAR_SPACING = 8   // 默认柱宽（像素）：约 110 根铺满 900px 宽的图，和 GMGN 打开时的疏密差不多
const MIN_BARS = 30     // 刚进代币页时，选的周期下不足这么多根（新币、只在最近有成交的币）就自动换更细的周期，不让图上只有几根粗柱子
const bucketCount = (cs: Candle[], iv: number) => { const s = new Set<number>(); for (const c of cs) s.add(Math.floor(c.t / iv)); return s.size }
/** 自动周期：从选定周期往细里找，取第一个能有 MIN_BARS 根的 */
function autoInterval(cs: Candle[], pref: number) {
  const cands = IVS.map(([s]) => s).filter((s) => s <= pref).sort((a, b) => b - a)
  for (const s of cands) if (bucketCount(cs, s) >= MIN_BARS) return s
  // 换细也凑不够（成交本来就稀）：选定周期下已有几根就不换，免得出现一堆不连续的 1 秒柱；几乎没有成交的新币才用最细的
  return bucketCount(cs, pref) >= 8 ? pref : (cands[cands.length - 1] ?? pref)
}
const fmt = (x: number) => (Math.abs(x) >= 1 ? compact(x, 2) : small(x))

/** 图表颜色取自当前主题的 CSS 变量（index.css 的 --chart-*），换主题时重新应用 */
function chartColors() {
  const v = (k: string) => getComputedStyle(document.documentElement).getPropertyValue(k).trim()
  return { text: v('--chart-text'), grid: v('--chart-grid'), cross: v('--chart-cross'), label: v('--chart-label'), border: v('--chart-border'), up: v('--chart-up'), down: v('--chart-down') }
}
const themeOptions = (k: ReturnType<typeof chartColors>) => ({
  layout: { background: { color: 'transparent' }, textColor: k.text, fontSize: 11, fontFamily: 'Geist, sans-serif' },
  grid: { vertLines: { color: k.grid }, horzLines: { color: k.grid } },
  crosshair: { mode: CrosshairMode.Normal, vertLine: { color: k.cross, labelBackgroundColor: k.label }, horzLine: { color: k.cross, labelBackgroundColor: k.label } },
  rightPriceScale: { borderColor: k.border },
  timeScale: { borderColor: k.border },
})

export function PriceChart({ d, emptyText }: { d: TokenDetail; emptyText?: string }) {
  const box = useRef<HTMLDivElement>(null)
  const chart = useRef<IChartApi | null>(null)
  const candle = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const vol = useRef<ISeriesApi<'Histogram'> | null>(null)
  // 默认视图：固定柱宽、最新一根贴右边（不用 fitContent：柱子少时会被拉成粗柱子，多时又挤成一条线）。
  // 换代币 / 周期 / 价格与市值时重新摆一次；进来后的头 8 秒内数据还在补（先到几根、再补历史），每次补完也重新摆，之后不再动用户的缩放
  const view = useRef({ key: '', at: 0, n: 0 })
  const metric = usePrefs((s) => s.chartMetric)
  const prefIv = usePrefs((s) => s.chartInterval)
  // 实际用的周期：用户在这个代币上点过就用点的；否则进来后的头 8 秒按数据多少自动选（见 autoInterval），之后固定，不随新成交跳来跳去
  const [manual, setManual] = useState<{ a: string; iv: number } | null>(null)
  const autoRef = useRef<{ a: string; at: number; iv: number }>({ a: '', at: 0, iv: prefIv })
  if (autoRef.current.a !== d.address) autoRef.current = { a: d.address, at: Date.now(), iv: prefIv }
  if (Date.now() - autoRef.current.at < 8000 && (d.candles?.length || 0) > 0) autoRef.current.iv = autoInterval(d.candles, prefIv)
  const iv = manual?.a === d.address ? manual.iv : autoRef.current.iv
  const set = usePrefs((s) => s.set)
  const theme = usePrefs((s) => s.theme)
  const tr = useT()
  const [ohlc, setOhlc] = useState<{ o: number; h: number; l: number; c: number } | null>(null)

  useEffect(() => {
    if (!box.current) return
    const k0 = chartColors(), o0 = themeOptions(k0)
    const c = createChart(box.current, {
      ...o0,
      autoSize: true,
      rightPriceScale: { ...o0.rightPriceScale, scaleMargins: { top: 0.1, bottom: 0.08 } },
      timeScale: { ...o0.timeScale, timeVisible: true, secondsVisible: true, rightOffset: 4, barSpacing: BAR_SPACING },
      localization: { priceFormatter: fmt, locale: usePrefs.getState().lang === 'en' ? 'en-US' : 'zh-CN' },   // 时间轴的日期写法跟界面语言（默认跟系统，中文系统下英文界面会显示「28日」）
    })
    candle.current = c.addCandlestickSeries({ upColor: k0.up, downColor: k0.down, borderVisible: false, wickUpColor: k0.up, wickDownColor: k0.down, priceFormat: { type: 'custom', formatter: fmt, minMove: 1e-12 },
      // 价格 / 市值不会是负数：自动缩放的下沿最低到 0
      autoscaleInfoProvider: (orig: () => any) => { const r = orig(); if (r?.priceRange) r.priceRange.minValue = Math.max(0, r.priceRange.minValue); return r } })
    vol.current = c.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false })
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } })   // 成交量柱叠在 K 线底部（和 GMGN 一样），主刻度不留负数区
    c.subscribeCrosshairMove((p) => {
      const v = p.seriesData.get(candle.current!) as any
      setOhlc(v ? { o: v.open, h: v.high, l: v.low, c: v.close } : null)
    })
    chart.current = c
    return () => { c.remove(); chart.current = null }
  }, [])

  const lang = usePrefs((s) => s.lang)
  useEffect(() => { chart.current?.applyOptions({ localization: { priceFormatter: fmt, locale: lang === 'en' ? 'en-US' : 'zh-CN' } }) }, [lang])   // eslint-disable-line react-hooks/exhaustive-deps

  // 换主题：重新读颜色并应用（K 线、成交量柱的颜色在下面 setData 时也按主题取）
  const colors = useMemo(() => chartColors(), [theme])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!chart.current || !candle.current) return
    chart.current.applyOptions(themeOptions(colors))
    candle.current.applyOptions({ upColor: colors.up, downColor: colors.down, wickUpColor: colors.up, wickDownColor: colors.down })
  }, [colors])

  const k = metric === 'mcap' && d.price > 0 && d.mcapUsd > 0 ? d.mcapUsd / d.price : 1
  const data = useMemo(() => aggregate(d.candles || [], iv, k), [d.candles, iv, k])

  useEffect(() => {
    if (!candle.current || !vol.current) return
    candle.current.setData(data)
    // 图表库自己解析颜色，不认 color-mix()：把主题里的 #rrggbb 换成 rgba
    const tint = (c: string) => { const h = c.replace('#', ''); const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},.35)` }
    vol.current.setData(data.map((x) => ({ time: x.time, value: x.v, color: tint(x.close >= x.open ? colors.up : colors.down) })))
    const key = `${d.address}|${iv}|${metric}`, n = data.length, v = view.current, now = Date.now()
    if (v.key !== key) { v.key = key; v.at = now; v.n = -1 }
    if (n && n !== v.n && now - v.at < 8000) {
      v.n = n
      const ts = chart.current?.timeScale()
      // 根数少时柱子放宽一些（最多 16px），让数据铺满图宽的七成左右；根数多时用默认柱宽，显示最近的一段
      const w = ts?.width() || 900
      ts?.applyOptions({ barSpacing: Math.min(16, Math.max(BAR_SPACING, (w * 0.7) / n)), rightOffset: 4 })
      ts?.scrollToRealTime()
    }
  }, [data, d.address, iv, metric, colors])

  const last = data[data.length - 1]
  const show = ohlc || (last ? { o: last.open, h: last.high, l: last.low, c: last.close } : null)
  const chg = show && show.o ? ((show.c - show.o) / show.o) * 100 : 0
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="h-10 flex-none flex items-center gap-3 px-3 border-b border-line">
        <div className="flex items-center gap-0.5">
          {IVS.map(([s, l]) => (
            <button key={s} onClick={() => { set({ chartInterval: s }); setManual({ a: d.address, iv: s }) }} className={clsx('h-7 px-2 rounded-xs text-base', iv === s ? 'text-t1 font-medium' : 'text-t3 hover:text-t1')}>{l}</button>
          ))}
        </div>
        <span className="w-px h-4 bg-line-2" />
        <div className="flex items-center text-base">
          <button onClick={() => set({ chartMetric: 'price' })} className={metric === 'price' ? 'text-t1' : 'text-t3 hover:text-t1'}>{tr('pc.price')}</button>
          <span className="text-t4 mx-1">/</span>
          <button onClick={() => set({ chartMetric: 'mcap' })} className={metric === 'mcap' ? 'text-t1' : 'text-t3 hover:text-t1'}>{tr('pc.mc')}</button>
        </div>
        <div className="flex-1" />
        {show && (
          <div className="flex items-center gap-2 text-sm text-t3 whitespace-nowrap">
            <span>{tr('pc.o')} <b className={chg >= 0 ? 'text-up font-normal' : 'text-down font-normal'}>{fmt(show.o)}</b></span>
            <span>{tr('pc.h')} <b className={chg >= 0 ? 'text-up font-normal' : 'text-down font-normal'}>{fmt(show.h)}</b></span>
            <span>{tr('pc.l')} <b className={chg >= 0 ? 'text-up font-normal' : 'text-down font-normal'}>{fmt(show.l)}</b></span>
            <span>{tr('pc.c')} <b className={chg >= 0 ? 'text-up font-normal' : 'text-down font-normal'}>{fmt(show.c)}</b></span>
            <span className={chg >= 0 ? 'text-up' : 'text-down'}>{chg >= 0 ? '+' : ''}{chg.toFixed(2)}%</span>
          </div>
        )}
      </div>
      <div className="relative flex-1 min-h-0">
        <div ref={box} className="absolute inset-0" />
        {!data.length && <div className="absolute inset-0 grid place-items-center text-t4 text-center px-6">{emptyText || tr('pc.empty')}</div>}
      </div>
    </div>
  )
}
