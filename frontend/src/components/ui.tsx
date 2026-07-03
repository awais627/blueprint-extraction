import { Loader2, X } from 'lucide-react'
import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes, useEffect } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '../lib/utils'

// ---- Button -----------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'good'

const buttonStyles: Record<ButtonVariant, string> = {
  primary:
    'bg-accent font-semibold text-accent-ink hover:bg-accent-bright shadow-beam-soft hover:shadow-beam active:translate-y-px',
  secondary:
    'bg-surface-3/80 text-ink border border-line-strong hover:border-accent/40 hover:text-white active:translate-y-px',
  ghost: 'text-ink-secondary hover:text-ink hover:bg-surface-3/70',
  danger: 'bg-crit/10 text-crit border border-crit/30 hover:bg-crit/20 hover:border-crit/50',
  good: 'bg-good/10 text-good border border-good/30 hover:bg-good/20 hover:border-good/50',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  loading?: boolean
}) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-all duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-page',
        'disabled:pointer-events-none disabled:opacity-40',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-[13px]',
        buttonStyles[variant],
        className,
      )}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <Loader2 size={14} className="animate-spin" />}
      {children}
    </button>
  )
}

// ---- Badge ------------------------------------------------------------------

type BadgeTone = 'good' | 'warn' | 'crit' | 'accent' | 'neutral'

const badgeStyles: Record<BadgeTone, string> = {
  good: 'bg-good/10 text-good border-good/25',
  warn: 'bg-warn/10 text-warn border-warn/25',
  crit: 'bg-crit/10 text-crit border-crit/30',
  accent: 'bg-accent/10 text-accent-bright border-accent/30',
  neutral: 'bg-surface-3/70 text-ink-secondary border-line-strong',
}

export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: BadgeTone
  className?: string
  children: ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.08em] leading-4',
        badgeStyles[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

// ---- Page header ---------------------------------------------------------------

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow: string
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <p className="microlabel text-accent/80">{eyebrow}</p>
        <h1 className="mt-1 font-display text-[22px] font-semibold leading-7 tracking-tight text-white">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

// ---- Inputs -----------------------------------------------------------------

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('input', className)} {...props} />
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn('input min-h-[72px] resize-y', className)} {...props} />
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative h-5 w-9 shrink-0 rounded-full transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
        checked ? 'bg-accent shadow-beam-soft' : 'border border-line-strong bg-surface-3',
      )}
    >
      <span
        className={cn(
          'absolute left-0 top-0.5 h-4 w-4 rounded-full shadow transition-transform duration-200',
          checked ? 'translate-x-[18px] bg-accent-ink' : 'translate-x-0.5 bg-ink-secondary',
        )}
      />
    </button>
  )
}

// ---- Kbd ----------------------------------------------------------------------

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line-strong bg-surface-2 px-1 font-mono text-[10px] font-medium text-ink-secondary shadow-[0_1px_0_rgba(0,0,0,0.4)]">
      {children}
    </kbd>
  )
}

// ---- Progress ring --------------------------------------------------------------

export function ProgressRing({
  value,
  size = 26,
  stroke = 2.5,
  className,
}: {
  value: number // 0..1
  size?: number
  stroke?: number
  className?: string
}) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const done = value >= 1
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cn('-rotate-90', className)}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(125,160,215,0.15)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={done ? '#2FD08A' : '#35C8EE'}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.min(1, Math.max(0, value)))}
        className="transition-[stroke-dashoffset] duration-500 ease-out"
      />
    </svg>
  )
}

// ---- Modal ------------------------------------------------------------------

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  wide = false,
}: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  children: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-page/80 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div
        className={cn(
          'reg-corners reg-corners-active relative max-h-[88vh] w-full overflow-y-auto rounded-xl border border-line-strong bg-surface-1 p-5 shadow-pop animate-scale-in',
          wide ? 'max-w-3xl' : 'max-w-lg',
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-[15px] font-semibold tracking-tight text-white">{title}</h2>
            {subtitle && <p className="mt-1 text-xs leading-relaxed text-ink-muted">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}

// ---- Empty state / spinners ---------------------------------------------------

/** dashed hex-bolt drawing with dimension lines — the system's empty-state art */
export function BlueprintArt({ size = 96 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.72} viewBox="0 0 120 86" fill="none" className="opacity-80">
      <g stroke="#35C8EE" strokeOpacity="0.55" strokeWidth="1.1" strokeDasharray="4 3">
        <path d="M38 18 L60 8 L82 18 L82 42 L60 52 L38 42 Z" />
        <circle cx="60" cy="30" r="9" />
      </g>
      <g stroke="#54678A" strokeWidth="0.8">
        <path d="M38 60 H82" />
        <path d="M38 56 v8 M82 56 v8" />
        <path d="M92 18 V42" />
        <path d="M88 18 h8 M88 42 h8" />
      </g>
      <g fill="#54678A" fontFamily="'JetBrains Mono Variable', monospace" fontSize="6.5">
        <text x="53" y="70">44.00</text>
        <text x="97" y="32">24.0</text>
      </g>
      <circle cx="60" cy="30" r="1.6" fill="#35C8EE" fillOpacity="0.8" />
      <path d="M60 19 v22 M49 30 h22" stroke="#35C8EE" strokeOpacity="0.35" strokeWidth="0.7" />
    </svg>
  )
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  art = false,
}: {
  icon?: ReactNode
  title: string
  children?: ReactNode
  action?: ReactNode
  art?: boolean
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      {art ? (
        <BlueprintArt />
      ) : (
        icon && (
          <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-xl border border-line bg-surface-2 text-ink-muted">
            {icon}
          </div>
        )
      )}
      <p className={cn('text-sm font-medium text-ink-secondary', art && 'mt-2')}>{title}</p>
      {children && <p className="max-w-sm text-xs leading-relaxed text-ink-muted">{children}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

export function PageSpinner() {
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-3">
      <svg width="28" height="28" viewBox="0 0 28 28" className="animate-spin text-accent" style={{ animationDuration: '1.4s' }}>
        <circle cx="14" cy="14" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
        <path d="M14 1 v6 M14 21 v6 M1 14 h6 M21 14 h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <span className="microlabel animate-blink">Loading</span>
    </div>
  )
}

// ---- Confidence meter ----------------------------------------------------------

export function ConfidenceMeter({ value }: { value: number | null }) {
  if (value == null) return <span className="text-xs text-ink-muted">—</span>
  const pct = Math.round(value * 100)
  const tone = value >= 0.9 ? 'bg-good' : value >= 0.7 ? 'bg-warn' : 'bg-crit'
  return (
    <div className="flex items-center gap-2" title={`OCR confidence ${pct}%`}>
      <div className="h-1 w-12 overflow-hidden rounded-full bg-surface-3">
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 font-mono text-[11px] tabular-nums text-ink-secondary">{pct}%</span>
    </div>
  )
}
