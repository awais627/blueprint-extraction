import { Braces, FileText, GitBranch, Rocket, TrendingDown, TrendingUp } from 'lucide-react'
import { useState } from 'react'

import { usePartTypes, usePromptPreview, usePromptVersions, usePublishVersion } from '../api/hooks'
import { Badge, Button, Modal, PageHeader, PageSpinner, Textarea } from '../components/ui'
import { cn, formatDate, formatPct } from '../lib/utils'

export default function PromptStudio() {
  const { data: partTypes } = usePartTypes()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const partTypeId = selectedId ?? partTypes?.[0]?.id
  const { data: preview, isLoading } = usePromptPreview(partTypeId)
  const { data: versions } = usePromptVersions()
  const publish = usePublishVersion()

  const [view, setView] = useState<'prompt' | 'schema'>('prompt')
  const [publishOpen, setPublishOpen] = useState(false)
  const [notes, setNotes] = useState('')

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
      <PageHeader
        eyebrow="Calibration"
        title="Prompt Studio"
        subtitle="The extraction prompt is assembled live from part-type fields, company standards and accumulated corrections."
        actions={
          <Button variant="primary" size="sm" onClick={() => { setNotes(''); setPublishOpen(true) }}>
            <Rocket size={13} /> Publish version
          </Button>
        }
      />

      <div className="flex flex-col gap-4 xl:flex-row">
        {/* assembled prompt */}
        <div className="card min-w-0 flex-[1.6] overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="led bg-accent animate-blink" />
              <h2 className="microlabel !text-[10px] !text-ink-secondary">Live assembled prompt</h2>
              {versions?.[0] && <Badge tone="accent">next: v{versions[0].version_number + 1}.0</Badge>}
            </div>
            <div className="flex items-center gap-2">
              <select
                className="h-7 cursor-pointer rounded-lg border border-line-strong bg-surface-2 px-2.5 pr-7 text-xs font-medium text-ink outline-none transition-colors hover:bg-surface-3 focus:ring-2 focus:ring-accent/30"
                value={partTypeId ?? ''}
                onChange={(e) => setSelectedId(Number(e.target.value))}
              >
                {partTypes?.map((pt) => (
                  <option key={pt.id} value={pt.id}>{pt.name}</option>
                ))}
              </select>
              <div className="flex overflow-hidden rounded-lg border border-line-strong">
                <button
                  className={cn(
                    'flex items-center gap-1 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.06em] transition-colors',
                    view === 'prompt' ? 'bg-accent/15 text-accent-bright' : 'text-ink-muted hover:text-ink',
                  )}
                  onClick={() => setView('prompt')}
                >
                  <FileText size={11} /> Prompt
                </button>
                <button
                  className={cn(
                    'flex items-center gap-1 border-l border-line-strong px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.06em] transition-colors',
                    view === 'schema' ? 'bg-accent/15 text-accent-bright' : 'text-ink-muted hover:text-ink',
                  )}
                  onClick={() => setView('schema')}
                >
                  <Braces size={11} /> Schema
                </button>
              </div>
            </div>
          </div>
          {isLoading || !preview ? (
            <PageSpinner />
          ) : (
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap p-4 font-mono text-[11.5px] leading-relaxed text-ink-secondary xl:max-h-[calc(100vh-240px)]">
              {view === 'prompt' ? preview.prompt_text : JSON.stringify(preview.page_schema, null, 2)}
            </pre>
          )}
        </div>

        {/* version history — a revision timeline */}
        <div className="w-full shrink-0 xl:w-[330px]">
          <div className="card overflow-hidden">
            <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
              <GitBranch size={13} className="text-accent/70" />
              <h2 className="microlabel !text-[10px] !text-ink-secondary">Revision history</h2>
            </div>
            <div className="max-h-[50vh] overflow-y-auto xl:max-h-[calc(100vh-240px)]">
              {versions?.map((v, i) => {
                const prev = versions[i + 1]
                const delta =
                  v.accuracy != null && prev?.accuracy != null ? v.accuracy - prev.accuracy : null
                const isActive = i === 0
                return (
                  <div key={v.id} className="relative border-b border-line/60 py-3 pl-10 pr-4 last:border-0">
                    {/* timeline rail */}
                    <span className="absolute bottom-0 left-[19px] top-0 w-px bg-line" />
                    <span
                      className={cn(
                        'absolute left-4 top-4 h-[7px] w-[7px] rounded-full border',
                        isActive
                          ? 'border-accent bg-accent shadow-beam-soft'
                          : 'border-line-strong bg-surface-3',
                      )}
                    />
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[13px] font-semibold tracking-tight text-ink">{v.label}</span>
                        {isActive && <Badge tone="accent">active</Badge>}
                      </div>
                      <span className="font-mono text-[10px] tabular-nums text-ink-muted">{formatDate(v.created_at)}</span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-3 text-[11.5px]">
                      <span
                        className={cn(
                          'font-mono font-semibold tabular-nums',
                          v.accuracy == null ? 'text-ink-muted' : v.accuracy >= 0.8 ? 'text-good' : 'text-warn',
                        )}
                      >
                        {v.accuracy == null ? 'no reviews yet' : formatPct(v.accuracy, 1)}
                      </span>
                      {delta != null && delta !== 0 && (
                        <span
                          className={cn(
                            'flex items-center gap-0.5 font-mono text-[10.5px]',
                            delta > 0 ? 'text-good' : 'text-crit',
                          )}
                        >
                          {delta > 0 ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                          {delta > 0 ? '+' : ''}{(delta * 100).toFixed(1)}pt
                        </span>
                      )}
                      <span className="ml-auto text-[10.5px] text-ink-muted">{v.fields_reviewed} reviewed</span>
                    </div>
                    {v.notes && <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-muted">{v.notes}</p>}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      <Modal
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        title="Publish prompt version"
        subtitle="Snapshots the current configuration. New extractions will be attributed to this version so accuracy can be compared across versions."
      >
        <div className="space-y-3">
          <div>
            <label className="label">What changed?</label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Added E8/E18 drive-size warning from 8 corrections; standardised material class format."
              autoFocus
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => setPublishOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={publish.isPending}
              onClick={() => publish.mutate({ notes }, { onSuccess: () => setPublishOpen(false) })}
            >
              <Rocket size={13} /> Publish
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
