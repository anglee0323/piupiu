// 顶部栏设置（「设置」弹窗里的「顶部栏」页签；顶部栏左边的齿轮会直接打开它）：控制顶部栏里收藏 / 持仓代币的快捷交易
import { useState } from 'react'
import clsx from 'clsx'
import { usePrefs, type PresetId, type QuickMode } from '../store/prefs'
import { NumBox } from './common'
import { Section, Rows, Row } from './SettingsKit'
import { X } from './gi'
import { useT } from '../lib/i18n'

const MODES: [QuickMode, string, string][] = [['off', 'tbs.off', 'tbs.offHint'], ['always', 'tbs.always', 'tbs.alwaysHint'], ['hover', 'tbs.hover', 'tbs.hoverHint']]   // 文案键
type Tab = 'fav' | 'hold'

const Preset = ({ value, onChange }: { value: PresetId; onChange: (p: PresetId) => void }) => (
  <div className="seg h-8 w-[132px]">{([1, 2, 3] as PresetId[]).map((p) => <button key={p} className="flex-1" data-on={value === p} onClick={() => onChange(p)}>P{p}</button>)}</div>
)
const Check = ({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) => (
  <button onClick={onClick} className={clsx('h-8 px-3 rounded-sm border text-sm transition-colors', on ? 'border-up/60 text-up bg-up/10' : 'border-line bg-btn text-t3 hover:text-t2')}>{label}</button>
)

/** 设置弹窗里的「顶部栏」页：控制顶部栏里收藏 / 持仓代币的快捷交易 */
export function TopBarSettingsBody() {
  const tb = usePrefs((s) => s.topBar)
  const set = usePrefs((s) => s.set)
  const [tab, setTab] = useState<Tab>('fav')
  const t = useT()
  const put = (v: Partial<typeof tb>) => set({ topBar: { ...tb, ...v } })
  return (
    <div className="space-y-6">
        <Section title={t('tbs.quick')} hint={t('tbs.quickHint')}>
          <div className="grid grid-cols-3 gap-2">
            {MODES.map(([k, name, hint]) => (
              <button key={k} onClick={() => put({ quick: k })} className={clsx('rounded-md border px-3 py-2.5 text-left transition-colors', tb.quick === k ? 'border-up/70 bg-up/8' : 'border-line bg-card hover:border-line-3')}>
                <div className="flex items-center gap-1.5 h-5 mb-2">
                  <span className="w-3.5 h-3.5 rounded-full bg-btn-2" /><span className="text-xs text-t2">{t('tbs.token')}</span>
                  {k !== 'off' && <span className={clsx('ml-auto h-4 px-1.5 rounded-full text-2xs font-semibold grid place-items-center', k === 'always' ? 'bg-up/20 text-up' : 'bg-btn-2 text-t3')}>{tab === 'fav' ? t('tbs.buyShort') : t('tbs.sellShort')}</span>}
                </div>
                <div className={clsx('text-sm font-medium', tb.quick === k ? 'text-t1' : 'text-t2')}>{t(name)}</div>
                <div className="text-xs text-t3 mt-0.5">{t(hint)}</div>
              </button>
            ))}
          </div>
        </Section>
        <Section title={t('tbs.lists')} hint={t('tbs.listsHint')}>
        <div className="seg h-8 w-full mb-1">
          <button className="flex-1" data-on={tab === 'fav'} onClick={() => setTab('fav')}>{t('tbs.fav')}</button>
          <button className="flex-1" data-on={tab === 'hold'} onClick={() => setTab('hold')}>{t('tbs.hold')}</button>
        </div>
        {tab === 'fav' ? (
          <Rows>
            <Row label={t('tbs.favAmount')} hint={t('tbs.favAmountHint')}><NumBox value={tb.favAmount} unit="BNB" min={0.0001} w="w-[132px]" onSave={(v) => put({ favAmount: v })} /></Row>
            <Row label={t('tbs.preset')} hint={t('tbs.presetHint')}><Preset value={tb.favPreset} onChange={(p) => put({ favPreset: p })} /></Row>
            <Row label={t('tbs.show')}><div className="flex gap-2"><Check on={tb.favMc} label={t('tbs.mc')} onClick={() => put({ favMc: !tb.favMc })} /><Check on={tb.favChg} label={t('tbs.chg')} onClick={() => put({ favChg: !tb.favChg })} /></div></Row>
          </Rows>
        ) : (
          <Rows>
            <Row label={t('tbs.sellPcts')} hint={t('tbs.sellPctsHint')}>
              <div className="flex items-center gap-1.5">
                {tb.holdPcts.map((p, i) => (
                  <span key={i} className="relative">
                    <NumBox value={p} unit="%" min={1} max={100} w="w-[72px]" onSave={(v) => put({ holdPcts: tb.holdPcts.map((x, j) => (j === i ? Math.round(v) : x)) })} />
                    {tb.holdPcts.length > 1 && <button title={t('tbs.remove')} onClick={() => put({ holdPcts: tb.holdPcts.filter((_, j) => j !== i) })} className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-btn-2 text-t3 hover:text-down grid place-items-center"><X className="w-2.5 h-2.5" /></button>}
                  </span>
                ))}
                {tb.holdPcts.length < 4 && <button onClick={() => put({ holdPcts: [...tb.holdPcts, 100] })} className="h-8 w-8 rounded-sm bg-btn text-t2 hover:bg-btn-2 text-md">+</button>}
              </div>
            </Row>
            <Row label={t('tbs.preset')} hint={t('tbs.presetHint')}><Preset value={tb.holdPreset} onChange={(p) => put({ holdPreset: p })} /></Row>
            <Row label={t('tbs.show')}><div className="flex gap-2"><Check on={tb.holdValue} label={t('tbs.value')} onClick={() => put({ holdValue: !tb.holdValue })} /><Check on={tb.holdPnl} label={t('tbs.pnl')} onClick={() => put({ holdPnl: !tb.holdPnl })} /></div></Row>
          </Rows>
        )}
        </Section>
    </div>
  )
}
