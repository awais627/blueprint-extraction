import { ArrowRight, BookOpenCheck, FileCheck2, ListChecks, PencilRuler, Target } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { useDashboard } from '../api/hooks'
import { Badge, EmptyState, PageHeader, PageSpinner } from '../components/ui'
import { formatDateTime, formatPct } from '../lib/utils'

const SERIES = '#35C8EE'
const INK_MUTED = '#54678A'
const GRID = 'rgba(125,160,215,0.08)'

function StatTile({
  icon,
  label,
  value,
  hint,
}: {
  icon: ReactNode
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="card group relative overflow-hidden p-4 transition-colors hover:border-accent/25">
      <div className="absolute right-3 top-3 text-ink-muted/50 transition-colors group-hover:text-accent/60">{icon}</div>
      <p className="microlabel !text-[9px]">{label}</p>
      <p className="mt-2 font-mono text-[26px] font-semibold leading-8 tracking-tight text-white">{value}</p>
      {hint && <p className="mt-1 truncate text-[11px] text-ink-muted">{hint}</p>}
    </div>
  )
}

function ChartTooltip({ active, payload, label, formatter }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-line-strong bg-surface-1/95 px-3 py-2 text-xs shadow-pop backdrop-blur-sm">
      <p className="font-mono font-medium text-ink">{label}</p>
      {payload.map((p: any, i: number) => (
        <p key={i} className="mt-1 flex items-center gap-1.5 text-ink-secondary">
          <span className="h-2 w-2 rounded-sm" style={{ background: SERIES }} />
          {formatter ? formatter(p.value, p.payload) : p.value}
        </p>
      ))}
    </div>
  )
}

function ChartCard({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: ReactNode
}) {
  return (
    <div className="card p-4">
      <h2 className="font-display text-[13px] font-semibold tracking-tight text-ink">{title}</h2>
      <p className="mt-0.5 text-[11px] text-ink-muted">{subtitle}</p>
      {children}
    </div>
  )
}

export default function Dashboard() {
  const { data, isLoading } = useDashboard()
  if (isLoading || !data) return <PageSpinner />

  const { stats, error_patterns, version_accuracy, recent_corrections } = data
  const accuracySeries = version_accuracy.filter((v) => v.accuracy != null)

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <PageHeader
        eyebrow="Feedback loop"
        title="Learning Insights"
        subtitle="How extraction accuracy improves as your corrections feed back into the prompt."
      />

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatTile
          icon={<Target size={15} />}
          label="Extraction accuracy"
          value={formatPct(stats.overall_accuracy, 1)}
          hint={`${stats.fields_verified} verified · ${stats.fields_corrected} corrected`}
        />
        <StatTile
          icon={<FileCheck2 size={15} />}
          label="Documents processed"
          value={String(stats.documents_completed)}
          hint={stats.documents_failed ? `${stats.documents_failed} failed` : 'all succeeded'}
        />
        <StatTile
          icon={<ListChecks size={15} />}
          label="Fields extracted"
          value={String(stats.fields_total)}
          hint={`${stats.fields_unverified} awaiting review`}
        />
        <StatTile
          icon={<PencilRuler size={15} />}
          label="Corrections logged"
          value={String(stats.corrections_total)}
          hint="each one improves the prompt"
        />
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {/* accuracy by prompt version */}
        <ChartCard
          title="Accuracy by prompt version"
          subtitle="verified ÷ reviewed fields, per version of the extraction prompt"
        >
          {accuracySeries.length === 0 ? (
            <div className="flex h-56 items-center justify-center text-xs text-ink-muted">
              Review extracted fields to start measuring accuracy.
            </div>
          ) : (
            <div className="mt-3 h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={accuracySeries} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
                  <defs>
                    <linearGradient id="accuracyFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={SERIES} stopOpacity={0.28} />
                      <stop offset="100%" stopColor={SERIES} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: INK_MUTED, fontSize: 11, fontFamily: 'JetBrains Mono Variable' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    domain={[0, 1]}
                    tickFormatter={(v) => `${Math.round(v * 100)}%`}
                    tick={{ fill: INK_MUTED, fontSize: 11, fontFamily: 'JetBrains Mono Variable' }}
                    axisLine={false}
                    tickLine={false}
                    width={58}
                  />
                  <Tooltip
                    content={
                      <ChartTooltip
                        formatter={(v: number, row: any) =>
                          `${formatPct(v, 1)} accuracy · ${row.fields_reviewed} fields reviewed`
                        }
                      />
                    }
                    cursor={{ stroke: 'rgba(53,200,238,0.35)', strokeDasharray: '3 3' }}
                  />
                  <Area
                    type="monotone"
                    dataKey="accuracy"
                    stroke={SERIES}
                    strokeWidth={2}
                    fill="url(#accuracyFill)"
                    dot={{ r: 3.5, fill: '#080D16', stroke: SERIES, strokeWidth: 1.8 }}
                    activeDot={{ r: 5, fill: SERIES, stroke: '#080D16', strokeWidth: 2 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </ChartCard>

        {/* error patterns */}
        <ChartCard
          title="Error patterns"
          subtitle="corrections grouped by field — the next prompt fix goes to the top bar"
        >
          {error_patterns.length === 0 ? (
            <div className="flex h-56 items-center justify-center text-xs text-ink-muted">
              No corrections yet — errors you correct will cluster here.
            </div>
          ) : (
            <div className="mt-3 h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={error_patterns.slice(0, 8)}
                  layout="vertical"
                  margin={{ top: 0, right: 24, bottom: 0, left: 8 }}
                >
                  <defs>
                    <linearGradient id="barFill" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor={SERIES} stopOpacity={0.5} />
                      <stop offset="100%" stopColor={SERIES} stopOpacity={0.95} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={GRID} horizontal={false} />
                  <XAxis
                    type="number"
                    allowDecimals={false}
                    tick={{ fill: INK_MUTED, fontSize: 11, fontFamily: 'JetBrains Mono Variable' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="field_label"
                    width={110}
                    tick={{ fill: '#96A9C8', fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    content={
                      <ChartTooltip
                        formatter={(v: number, row: any) =>
                          `${v} correction${v === 1 ? '' : 's'}${row.last_reason ? ` — “${row.last_reason}”` : ''}`
                        }
                      />
                    }
                    cursor={{ fill: 'rgba(53,200,238,0.05)' }}
                  />
                  <Bar dataKey="count" fill="url(#barFill)" barSize={13} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </ChartCard>
      </div>

      {/* correction log */}
      <div className="card overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <BookOpenCheck size={14} className="text-accent/70" />
          <h2 className="font-display text-[13px] font-semibold tracking-tight text-ink">Correction log</h2>
          <span className="hidden text-[11px] text-ink-muted sm:inline">— the raw training signal for prompt improvements</span>
        </div>
        {recent_corrections.length === 0 ? (
          <EmptyState art title="No corrections yet">
            When the AI misreads a value, correct it in the review screen with a note on why — every note is injected
            into the next extraction prompt.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-line">
                  <th className="microlabel px-4 py-2 !text-[9px]">Field</th>
                  <th className="microlabel px-3 py-2 !text-[9px]">AI read</th>
                  <th className="px-1 py-2" />
                  <th className="microlabel px-3 py-2 !text-[9px]">Corrected to</th>
                  <th className="microlabel px-3 py-2 !text-[9px]">Why</th>
                  <th className="microlabel hidden px-3 py-2 !text-[9px] lg:table-cell">Document</th>
                  <th className="microlabel hidden px-3 py-2 !text-[9px] xl:table-cell">When</th>
                </tr>
              </thead>
              <tbody>
                {recent_corrections.map((c) => (
                  <tr key={c.id} className="border-b border-line/60 align-top transition-colors last:border-0 hover:bg-surface-2/40">
                    <td className="px-4 py-2.5">
                      <p className="text-[12px] font-medium text-ink">{c.field_label}</p>
                      {c.category && <Badge tone="neutral" className="mt-1">{c.category}</Badge>}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11.5px] text-crit/75 line-through decoration-crit/40">
                      {c.original_value ?? '—'}
                    </td>
                    <td className="px-1 py-3 text-ink-muted">
                      <ArrowRight size={11} />
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11.5px] text-good">{c.corrected_value}</td>
                    <td className="max-w-[280px] px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-secondary">
                      {c.reason || <span className="text-ink-muted">—</span>}
                    </td>
                    <td className="hidden px-3 py-2.5 text-[11.5px] text-ink-muted lg:table-cell">{c.document_name}</td>
                    <td className="hidden whitespace-nowrap px-3 py-2.5 font-mono text-[10.5px] tabular-nums text-ink-muted xl:table-cell">
                      {formatDateTime(c.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
