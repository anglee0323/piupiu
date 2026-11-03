// 使用前检查（首次启动引导）：交易前要满足的条件逐项检查，缺哪项就告诉用户去哪里改。
// 检查在 Gateway（GET /api/setup）：装了币安钱包命令行 → 扫码登录 → 领了 Agent ID → 开了开发者模式 → 可交易代币选「全部」。
// 不再自动弹这个清单（一屏文字会把新用户吓退）。首次启动只做两件事：
//   1. 组件在后台装，装好后如果还没登录，在右上角「连接钱包」旁显示一个引导气泡（不直接弹登录框，由用户自己点）；
//   2. 登录后如果 Agent ID / 开发者模式 / 可交易代币有缺项，只弹一条简短提示，告诉去哪里补。
// 完整清单从右上角钱包菜单的「使用前检查」打开。Agent ID、开发者模式、交易范围只能在币安 App 里改，这里只读。
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { api } from '../lib/api'
import { useApp } from '../store/app'
import { useUI } from '../store/ui'
import { CopyBtn, Modal } from './common'
import { CheckCircle2, Clock, Loader2, XCircle } from './gi'
import { Section, Rows, Row, RowBtn } from './SettingsKit'
import { useT } from '../lib/i18n'
import { usePrefs } from '../store/prefs'

type Step = { key: 'baw' | 'login' | 'agentId' | 'devMode' | 'abnormal' | 'tradeAll' | 'four'; ok: boolean | null; detail: string; installing?: boolean; retry?: boolean }
type Setup = { appMode: boolean; platform?: string; live: boolean; liveTrade: boolean; dismissedAt: number | null; steps: Step[]; done: boolean; wallet: { slot: number; address: string | null; agentId: string | null } | null }

const BAW_CMD = 'npm i -g @binance/agentic-wallet'
// 每一项的标题和说明在中英文字典里：setup.t.<key>、setup.h.<key>

/** 自动弹出的判断 + 弹窗本体（在 App 里挂一次） */
export function SetupGuide() {
  const t = useT()
  const open = useUI((s) => s.setupOpen)
  const setUI = useUI((s) => s.set)
  const mode = useApp((s) => s.mode)
  const authState = useApp((s) => s.baw?.auth?.state)
  const [v, setV] = useState<Setup | null>(null)
  const [busy, setBusy] = useState(false)
  const autoTried = useRef(false)
  const load = async (refresh = false) => {
    setBusy(true)
    try { const r = await api<Setup>(`/api/setup?lang=${usePrefs.getState().lang}` + (refresh ? '&refresh=1' : '')); setV(r); return r } catch { return null } finally { setBusy(false) }
  }
  const toast = useApp((s) => s.toast)
  const missHint = (r: Setup) => {
    const m = r.steps.find((x) => x.key !== 'login' && x.key !== 'baw' && x.key !== 'abnormal' && x.ok === false)
    if (m) toast({ id: 'setup-miss', kind: 'info', title: t('setup.missTitle'), body: t('setup.missBody', { item: t('setup.t.' + m.key), detail: m.detail }) })
  }
  // 启动后：等组件装好（后台，不挡界面）→ 没登录就直接弹登录二维码；已登录但有缺项就弹一条简短提示。用户点过「稍后再说」就不打扰
  useEffect(() => {
    if (mode !== 'live' || autoTried.current || !authState || authState === 'checking') return
    autoTried.current = true
    ;(async () => {
      for (let i = 0; i < 40; i++) {
        const r = await load()
        if (!r || !r.live || r.dismissedAt) return
        const baw = r.steps.find((x) => x.key === 'baw')
        if (baw?.installing || baw?.ok === null) { await new Promise((ok) => setTimeout(ok, 2500)); continue }
        if (baw?.ok === false) { toast({ id: 'setup-baw', kind: 'error', title: t('setup.bawFailTitle'), body: t('setup.bawFailBody', { detail: baw.detail }) }); return }
        if (r.steps.find((x) => x.key === 'login')?.ok === false) { setUI({ connectHint: true }); return }
        missHint(r); return
      }
    })()
  }, [mode, authState])   // eslint-disable-line react-hooks/exhaustive-deps
  // 刚扫码登录成功：检查一次其他条件，有缺项给一条简短提示
  const prevAuth = useRef(authState)
  useEffect(() => {
    if (authState === 'ok' && prevAuth.current && prevAuth.current !== 'ok' && prevAuth.current !== 'checking') load(true).then((r) => { if (r && r.live) missHint(r) })
    prevAuth.current = authState
  }, [authState])   // eslint-disable-line react-hooks/exhaustive-deps
  // 打开时、登录状态变化时重新检查
  useEffect(() => { if (open) load() }, [open, authState])   // eslint-disable-line react-hooks/exhaustive-deps
  // 组件安装 / 下载中：每 3 秒刷新一次进度
  const pending = !!v?.steps.some((x) => x.installing || (x.ok === null && (x.key === 'baw' || x.key === 'four')))
  useEffect(() => { if (!open || !pending) return; const t = setInterval(() => load(), 3000); return () => clearInterval(t) }, [open, pending])   // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null
  const close = () => setUI({ setupOpen: false })
  const later = async () => { await api('/api/setup', { dismiss: true }).catch(() => {}); close() }
  const login = () => { close(); setUI({ loginOpen: true, loginSlot: v?.wallet?.slot || 1 }) }
  const retry = async () => { await api('/api/setup', { retry: true }).catch(() => {}); setTimeout(() => load(), 800) }
  const done = !!v?.done
  return (
    <Modal open onClose={close} title={t('setup.title')} width={560}>
      <div className="space-y-5">
        <Section hint={done ? t('setup.allReady') : t('setup.intro')}>
          {!v ? <div className="py-6 grid place-items-center"><Loader2 className="ico spin text-t3" /></div> : (
            <Rows>
              {v.steps.map((s) => (
                <Row key={s.key}
                  label={<span className="flex items-center gap-2"><StepIcon ok={s.ok} busy={s.installing} />{t('setup.t.' + s.key)}</span>}
                  tag={<span className={clsx('text-xs', s.ok === false ? 'text-down' : s.ok ? 'text-t3' : 'text-t4')}>{s.detail}</span>}
                  hint={s.ok === true ? undefined : (
                    <>
                      {t('setup.h.' + s.key)}
                      {s.key === 'baw' && !v.appMode && <span className="mt-1.5 flex items-center gap-1.5"><code className="px-2 py-0.5 rounded-xs bg-btn font-mono text-t2">{BAW_CMD}</code><CopyBtn text={BAW_CMD} className="w-6 h-6" /></span>}
                    </>
                  )}>
                  {s.key === 'login' && s.ok === false && <RowBtn onClick={login}>{t('setup.scan')}</RowBtn>}
                  {s.retry && !s.installing && <RowBtn onClick={retry}>{t('setup.retry')}</RowBtn>}
                </Row>
              ))}
            </Rows>
          )}
        </Section>
        <div className="text-xs text-t4 leading-5">{t('setup.privacy')}</div>
        <div className="flex gap-2">
          <button onClick={() => load(true)} disabled={busy} className="h-9 px-4 rounded-sm bg-btn hover:bg-btn-2 text-t2 flex items-center gap-1.5 disabled:opacity-60">{busy && <Loader2 className="ico-sm spin" />}{t('setup.recheck')}</button>
          <span className="flex-1" />
          {done
            ? <button onClick={close} className="h-9 px-5 rounded-sm bg-up text-on-accent font-semibold">{t('setup.start')}</button>
            : <button onClick={later} className="h-9 px-4 rounded-sm bg-btn hover:bg-btn-2 text-t2">{t('setup.later')}</button>}
        </div>
      </div>
    </Modal>
  )
}

function StepIcon({ ok, busy }: { ok: boolean | null; busy?: boolean }) {
  if (busy) return <Loader2 className="ico spin text-t3" />
  if (ok === true) return <CheckCircle2 className="ico text-up" />
  if (ok === false) return <XCircle className="ico text-down" />
  return <Clock className="ico text-t4" />   // 还没法检查（没登录 / 读取失败）
}
