// 设置类界面的统一积木：「设置」弹窗各页签、顶部栏页、底栏「自动化」弹层都用这几个，不要各写各的。
//   Section：一个分组（标题 + 一句话说明 + 内容）
//   Row：一行设置（左边名称 + 说明，右边放控件）；Toggle 是带开关的 Row
//   Card：分组里的子卡片（如 NFT / 代币两个转出地址）
//   RowBtn：行右侧的次级按钮（修改 / 管理 / 清除 都是它）
import clsx from 'clsx'

export function Section({ title, hint, children, className }: { title?: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={className}>
      {title != null && <div className="text-md font-medium">{title}</div>}
      {hint != null && <div className="text-xs text-t3 leading-5 mt-0.5">{hint}</div>}
      <div className={title != null || hint != null ? 'mt-2' : ''}>{children}</div>
    </section>
  )
}

/** 一组 Row：行与行之间一条分隔线 */
export const Rows = ({ children }: { children: React.ReactNode }) => <div className="divide-y divide-line">{children}</div>

export function Row({ label, hint, tag, children, disabled }: { label: React.ReactNode; hint?: React.ReactNode; tag?: React.ReactNode; children?: React.ReactNode; disabled?: boolean }) {
  return (
    <div className={clsx('flex items-center justify-between gap-4 py-2.5', disabled && 'opacity-50')}>
      <span className="min-w-0">
        <span className="flex items-baseline gap-2"><span className="text-base">{label}</span>{tag}</span>
        {hint != null && <span className="block text-xs text-t3 leading-5 mt-0.5">{hint}</span>}
      </span>
      {children != null && <span className="flex-none">{children}</span>}
    </div>
  )
}

/** 单独的开关（不带整行布局）：面板里的小开关用它，设置页用 Toggle */
export function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} className={clsx('relative flex-none w-9 h-5 rounded-full transition-colors disabled:opacity-50', on ? 'bg-up' : 'bg-line-3')}>
      <span className={clsx('absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all', on ? 'left-[18px]' : 'left-0.5')} />
    </button>
  )
}

export function Toggle({ on, onChange, label, hint, tag, disabled }: { on: boolean; onChange: (v: boolean) => void; label: React.ReactNode; hint?: React.ReactNode; tag?: React.ReactNode; disabled?: boolean }) {
  return (
    <Row label={label} hint={hint} tag={tag} disabled={disabled}>
      <Switch on={on} onChange={onChange} disabled={disabled} />
    </Row>
  )
}

export function Card({ title, tag, hint, children, className }: { title?: React.ReactNode; tag?: React.ReactNode; hint?: React.ReactNode; children?: React.ReactNode; className?: string }) {
  return (
    <div className={clsx('rounded-md border border-line bg-card p-3.5 space-y-2.5', className)}>
      {(title != null || hint != null) && (
        <div>
          {title != null && <div className="flex items-baseline gap-2"><span className="text-base font-medium">{title}</span>{tag}</div>}
          {hint != null && <div className="text-xs text-t3 leading-5 mt-1">{hint}</div>}
        </div>
      )}
      {children}
    </div>
  )
}

/** 行内次级按钮：和输入框同高（h-8），底色 bg-btn */
export const RowBtn = ({ children, danger, className, ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }) => (
  <button type="button" {...p} className={clsx('h-8 px-2.5 rounded-sm bg-btn hover:bg-btn-2 text-sm flex-none disabled:opacity-50', danger ? 'text-t3 hover:!text-down' : 'text-t2 hover:text-t1', className)}>{children}</button>
)

/** 说明文字里的小标签：纯文字，不带底色 */
export const Tag = ({ children, tone = 'dim' }: { children: React.ReactNode; tone?: 'dim' | 'warn' }) => <span className={clsx('text-xs', tone === 'warn' ? 'text-warn' : 'text-t3')}>{children}</span>
