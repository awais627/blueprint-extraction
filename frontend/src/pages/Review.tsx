import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCheck,
  Crosshair,
  Loader2,
  MapPin,
  Pencil,
  RotateCcw,
  Sparkles,
  Undo2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import {
  useCreateCorrection,
  useDocument,
  useProcessDocument,
  useSetFieldStatus,
} from '../api/hooks'
import type { BBox, DocumentDetail, ExtractedField } from '../api/types'
import BlueprintViewer, { type ViewerHandle } from '../components/BlueprintViewer'
import { Badge, Button, ConfidenceMeter, Input, Kbd, PageSpinner, ProgressRing, Textarea } from '../components/ui'
import { cn, formatPct } from '../lib/utils'

const CATEGORY_SUGGESTIONS = [
  'ocr_misread',
  'format_mismatch',
  'wrong_location',
  'missing_value',
  'standards_violation',
]

// ---------------------------------------------------------------------------

function PipelineProgress({ doc }: { doc: DocumentDetail }) {
  const steps = [
    { key: 'queued', label: 'Queued' },
    { key: 'convert', label: 'OCR Pass' },
    { key: 'extract', label: 'AI Extraction' },
    { key: 'merge', label: 'Locating Values' },
  ]
  const idx = steps.findIndex((s) => s.key === doc.phase)
  const current = idx === -1 ? steps.length : idx

  return (
    <div className="flex h-full flex-col items-center justify-center gap-10 p-6">
      {/* ghost sheet being scanned */}
      <div className="blueprint-grid reg-corners reg-corners-active relative h-40 w-64 overflow-hidden rounded-lg border border-accent/25 bg-surface-2/60">
        <div className="absolute inset-x-6 top-7 h-1.5 rounded bg-line-strong/60" />
        <div className="absolute left-6 top-12 h-1.5 w-24 rounded bg-line/80" />
        <div className="absolute left-6 top-[66px] h-14 w-20 rounded border border-dashed border-line-strong/70" />
        <div className="absolute right-6 top-[66px] h-1.5 w-16 rounded bg-line/80" />
        <div className="absolute right-6 top-[82px] h-1.5 w-20 rounded bg-line/60" />
        <div className="absolute bottom-6 inset-x-6 h-5 rounded border border-line-strong/70" />
        {/* scan beam */}
        <div className="absolute inset-x-0 h-10 animate-scan bg-gradient-to-b from-transparent via-accent/25 to-transparent">
          <div className="absolute inset-x-0 top-1/2 h-px bg-accent shadow-beam-soft" />
        </div>
      </div>

      <div className="flex items-start">
        {steps.map((s, i) => (
          <div key={s.key} className="flex items-start">
            <div className="flex w-24 flex-col items-center gap-2">
              <div
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-full border font-mono text-xs font-semibold transition-colors',
                  i < current
                    ? 'border-good/40 bg-good/10 text-good'
                    : i === current
                      ? 'border-accent/50 bg-accent/10 text-accent-bright shadow-beam-soft'
                      : 'border-line-strong bg-surface-2 text-ink-muted',
                )}
              >
                {i < current ? <Check size={15} /> : i === current ? <Loader2 size={15} className="animate-spin" /> : i + 1}
              </div>
              <span className={cn('microlabel text-center !text-[9px]', i <= current ? '!text-ink-secondary' : '')}>
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className={cn('mt-[17px] h-px w-10 sm:w-16', i < current ? 'bg-good/50' : 'bg-line-strong')} />
            )}
          </div>
        ))}
      </div>
      <p className="text-xs text-ink-muted">Datalab is reading the blueprint — this usually takes under a minute.</p>
    </div>
  )
}

// ---------------------------------------------------------------------------

interface CorrectionDraft {
  value: string
  reason: string
  category: string
  region: BBox | null
  picking: boolean
}

const statusEdge: Record<string, string> = {
  unverified: 'bg-warn/70',
  verified: 'bg-good/70',
  corrected: 'bg-crit/70',
}

const matchGlyph: Record<string, { label: string; className: string }> = {
  word: { label: 'exact match', className: 'text-good/90' },
  line: { label: 'drawing match', className: 'text-good/70' },
  block: { label: 'region match', className: 'text-warn/80' },
  none: { label: 'no location', className: 'text-ink-muted' },
}

function FieldRow({
  field,
  index,
  active,
  documentId,
  onSelect,
  correcting,
  onStartCorrection,
  onCancelCorrection,
  draft,
  onDraftChange,
}: {
  field: ExtractedField
  index: number
  active: boolean
  documentId: string
  onSelect: (f: ExtractedField) => void
  correcting: boolean
  onStartCorrection: (f: ExtractedField) => void
  onCancelCorrection: () => void
  draft: CorrectionDraft
  onDraftChange: (d: Partial<CorrectionDraft>) => void
}) {
  const setStatus = useSetFieldStatus(documentId)
  const createCorrection = useCreateCorrection(documentId)

  const sourceDiffers =
    !!field.source_text &&
    !!field.value &&
    field.source_text.replace(/\W+/g, '').toLowerCase() !== field.value.replace(/\W+/g, '').toLowerCase()

  const match = matchGlyph[field.match_quality] ?? matchGlyph.none

  const statusBadge =
    field.status === 'verified' ? (
      <Badge tone="good"><Check size={11} /> Verified</Badge>
    ) : field.status === 'corrected' ? (
      <Badge tone="crit"><Pencil size={10} /> Corrected</Badge>
    ) : (
      <Badge tone="warn">Review</Badge>
    )

  const save = () => {
    if (!draft.value.trim()) return
    createCorrection.mutate(
      {
        field_id: field.id,
        corrected_value: draft.value.trim(),
        reason: draft.reason.trim(),
        category: draft.category.trim(),
        bbox: draft.region,
      },
      { onSuccess: onCancelCorrection },
    )
  }

  return (
    <div
      data-field-id={field.id}
      className={cn(
        'group relative border-b border-line/70 transition-colors',
        active ? 'bg-accent/[0.055]' : 'hover:bg-surface-2/50',
        correcting && 'bg-surface-2/70',
      )}
    >
      {/* status edge */}
      <span className={cn('absolute inset-y-0 left-0 w-[2.5px]', statusEdge[field.status])} />
      {active && <span className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_1px_rgba(53,200,238,0.22)]" />}

      <div className="flex cursor-pointer items-center gap-3 py-2.5 pl-4 pr-3" onClick={() => onSelect(field)}>
        <span className="w-5 shrink-0 font-mono text-[10px] tabular-nums text-ink-muted">
          {String(index + 1).padStart(2, '0')}
        </span>

        <div className="w-[104px] shrink-0">
          <p className="text-[11.5px] font-medium leading-tight text-ink-secondary">{field.label}</p>
          <p className={cn('mt-0.5 flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.06em]', match.className)}>
            <Crosshair size={9} strokeWidth={2.2} />
            {match.label}
          </p>
        </div>

        <div className="min-w-0 flex-1">
          {field.value ? (
            <p
              className={cn(
                'truncate font-mono text-[12.5px] tracking-tight',
                field.status === 'corrected' ? 'text-crit/70 line-through decoration-crit/50' : 'text-ink',
              )}
            >
              {field.value}
            </p>
          ) : (
            <p className="text-[12px] italic text-ink-muted">not found</p>
          )}
          {field.status === 'corrected' && field.corrected_value && (
            <p className="truncate font-mono text-[12.5px] tracking-tight text-good">{field.corrected_value}</p>
          )}
          {sourceDiffers && (
            <p className="mt-0.5 truncate text-[10.5px] text-ink-muted">
              read as <span className="font-mono text-accent/80">“{field.source_text}”</span>
            </p>
          )}
        </div>

        <div className="hidden shrink-0 xl:block">
          <ConfidenceMeter value={field.confidence} />
        </div>
        <div className="w-[84px] shrink-0 text-right">{statusBadge}</div>

        <div
          className={cn(
            'flex w-[54px] shrink-0 items-center justify-end gap-0.5',
            field.status === 'unverified' ? 'opacity-100' : 'opacity-0 transition-opacity group-hover:opacity-100',
          )}
        >
          {field.status === 'unverified' ? (
            <>
              <button
                title="Mark as correct (V)"
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-good/15 hover:text-good"
                onClick={(e) => {
                  e.stopPropagation()
                  setStatus.mutate({ fieldId: field.id, status: 'verified' })
                }}
              >
                <Check size={15} />
              </button>
              <button
                title="Correct this value (C)"
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-crit/15 hover:text-crit"
                onClick={(e) => {
                  e.stopPropagation()
                  onStartCorrection(field)
                }}
              >
                <Pencil size={13.5} />
              </button>
            </>
          ) : (
            <button
              title="Reset to unreviewed"
              className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
              onClick={(e) => {
                e.stopPropagation()
                setStatus.mutate({ fieldId: field.id, status: 'unverified' })
              }}
            >
              <Undo2 size={13.5} />
            </button>
          )}
        </div>
      </div>

      {/* AI reasoning for the selected field */}
      {active && !correcting && (field.ai_reasoning || sourceDiffers) && (
        <div className="flex items-start gap-2 border-t border-line/60 bg-surface-2/40 py-2.5 pl-4 pr-3.5 animate-fade-in">
          <Sparkles size={12} className="mt-0.5 shrink-0 text-accent/80" />
          <div className="min-w-0 text-[11.5px] leading-relaxed text-ink-secondary">
            {sourceDiffers && (
              <p>
                Found <span className="font-mono text-accent-bright/90">“{field.source_text}”</span> printed on the
                document and interpreted it as <span className="font-mono text-accent-bright/90">“{field.value}”</span>.
              </p>
            )}
            {field.ai_reasoning && <p className={cn(sourceDiffers && 'mt-1')}>{field.ai_reasoning}</p>}
          </div>
        </div>
      )}

      {/* inline correction editor — the redline */}
      {correcting && (
        <div className="space-y-3 border-t border-crit/20 bg-surface-1 py-3 pl-4 pr-3.5 animate-fade-in">
          <p className="microlabel flex items-center gap-1.5 !text-[9px] !text-crit/80">
            <Pencil size={10} /> Redline correction
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Correct value</label>
              <Input
                autoFocus
                value={draft.value}
                onChange={(e) => onDraftChange({ value: e.target.value })}
                placeholder="Enter the value as it should read"
                className="font-mono text-[12.5px]"
              />
            </div>
            <div>
              <label className="label">Error category</label>
              <Input
                list="category-suggestions"
                value={draft.category}
                onChange={(e) => onDraftChange({ category: e.target.value })}
                placeholder="e.g. ocr_misread"
                className="font-mono text-xs"
              />
              <datalist id="category-suggestions">
                {CATEGORY_SUGGESTIONS.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
          </div>
          <div>
            <label className="label">Why did the AI get it wrong?</label>
            <Textarea
              value={draft.reason}
              onChange={(e) => onDraftChange({ reason: e.target.value })}
              placeholder='e.g. "AI reads E18 instead of E8 because the 1 looks like scan noise" — this feeds back into the extraction prompt.'
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              size="sm"
              variant={draft.picking ? 'primary' : 'secondary'}
              onClick={() => onDraftChange({ picking: !draft.picking })}
            >
              <Crosshair size={13} />
              {draft.picking ? 'Drag on the drawing…' : draft.region ? 'Re-mark location' : 'Mark location on drawing'}
            </Button>
            <div className="flex items-center gap-2">
              {draft.region && (
                <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.08em] text-accent">
                  <MapPin size={11} /> marked
                </span>
              )}
              <Button size="sm" variant="ghost" onClick={onCancelCorrection}>
                <X size={13} /> Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!draft.value.trim()}
                loading={createCorrection.isPending}
                onClick={save}
              >
                <Check size={13} /> Save correction
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function TitleBlockCell({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col justify-center border-l border-line px-3.5 first:border-l-0 first:pl-0">
      <span className="microlabel !text-[8.5px]">{label}</span>
      <span className={cn('mt-0.5 truncate text-[11.5px] text-ink-secondary', mono && 'font-mono tabular-nums')}>
        {value}
      </span>
    </div>
  )
}

export default function Review() {
  const { id } = useParams<{ id: string }>()
  const { data: doc, isLoading } = useDocument(id)
  const processDoc = useProcessDocument()
  const setStatus = useSetFieldStatus(id ?? '')

  const viewerRef = useRef<ViewerHandle>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [activeFieldId, setActiveFieldId] = useState<number | null>(null)
  const [correctingId, setCorrectingId] = useState<number | null>(null)
  const [draft, setDraft] = useState<CorrectionDraft>({ value: '', reason: '', category: '', region: null, picking: false })

  const fields = useMemo(() => doc?.fields ?? [], [doc])
  const reviewed = fields.filter((f) => f.status !== 'unverified').length
  const fullyReviewed = fields.length > 0 && reviewed === fields.length

  // auto-select first located field once loaded
  useEffect(() => {
    if (doc?.status === 'completed' && activeFieldId === null && fields.length) {
      const first = fields.find((f) => f.bbox_x != null) ?? fields[0]
      setActiveFieldId(first.id)
    }
  }, [doc?.status, fields, activeFieldId])

  const selectField = useCallback((f: ExtractedField) => {
    setActiveFieldId(f.id)
    if (f.bbox_x != null) viewerRef.current?.zoomToField(f)
  }, [])

  const startCorrection = useCallback((f: ExtractedField) => {
    setActiveFieldId(f.id)
    setCorrectingId(f.id)
    setDraft({ value: f.value ?? '', reason: '', category: '', region: null, picking: false })
    if (f.bbox_x != null) viewerRef.current?.zoomToField(f)
  }, [])

  // keep the active row in view
  useEffect(() => {
    if (activeFieldId == null) return
    listRef.current
      ?.querySelector(`[data-field-id="${activeFieldId}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activeFieldId])

  // ---- keyboard-driven review ------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (typeof target?.closest === 'function' && target.closest('input, textarea, select, [contenteditable="true"]')) return
      if (correctingId != null) {
        if (e.key === 'Escape') setCorrectingId(null)
        return
      }
      if (!fields.length) return
      const idx = fields.findIndex((f) => f.id === activeFieldId)
      const activeField = idx >= 0 ? fields[idx] : null

      switch (e.key) {
        case 'ArrowDown':
        case 'j': {
          e.preventDefault()
          const next = fields[Math.min(fields.length - 1, idx + 1)] ?? fields[0]
          selectField(next)
          break
        }
        case 'ArrowUp':
        case 'k': {
          e.preventDefault()
          const prev = fields[Math.max(0, idx - 1)] ?? fields[0]
          selectField(prev)
          break
        }
        case 'v': {
          if (!activeField || activeField.status !== 'unverified') break
          e.preventDefault()
          setStatus.mutate({ fieldId: activeField.id, status: 'verified' })
          const nextUnverified =
            fields.slice(idx + 1).find((f) => f.status === 'unverified' && f.id !== activeField.id) ??
            fields.find((f) => f.status === 'unverified' && f.id !== activeField.id)
          if (nextUnverified) selectField(nextUnverified)
          break
        }
        case 'c': {
          if (!activeField) break
          e.preventDefault()
          startCorrection(activeField)
          break
        }
        case 'b': {
          e.preventDefault()
          viewerRef.current?.toggleBoxes()
          break
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fields, activeFieldId, correctingId, selectField, startCorrection, setStatus])

  if (isLoading || !doc) return <PageSpinner />

  const verifyAllRemaining = () => {
    fields.filter((f) => f.status === 'unverified').forEach((f) =>
      setStatus.mutate({ fieldId: f.id, status: 'verified' }),
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* title block */}
      <header className="flex items-center gap-3 border-b border-line bg-surface-1/80 px-3 py-2 backdrop-blur-sm sm:px-4">
        <Link
          to="/documents"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
        >
          <ArrowLeft size={16} />
        </Link>

        <div className="flex min-w-0 items-center gap-2.5">
          <h1 className="truncate font-mono text-[15px] font-semibold tracking-tight text-white">
            {doc.part_number ?? doc.filename}
          </h1>
          {fullyReviewed && (
            <Badge tone="good"><CheckCheck size={11} /> Reviewed</Badge>
          )}
        </div>

        <div className="ml-2 hidden h-10 min-w-0 flex-1 items-stretch overflow-hidden rounded-lg border border-line bg-surface-2/40 px-3.5 md:flex">
          <TitleBlockCell label="File" value={doc.filename} />
          <TitleBlockCell label="Part type" value={doc.part_type_name ?? '—'} />
          {doc.prompt_version_label && <TitleBlockCell label="Prompt rev" value={doc.prompt_version_label} mono />}
          {doc.avg_confidence != null && <TitleBlockCell label="OCR conf" value={formatPct(doc.avg_confidence)} mono />}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-3">
          {doc.status === 'completed' && fields.length > 0 && (
            <div className="flex items-center gap-2" title={`${reviewed} of ${fields.length} fields reviewed`}>
              <ProgressRing value={reviewed / fields.length} size={26} />
              <span className="font-mono text-[11px] tabular-nums text-ink-secondary">
                {reviewed}/{fields.length}
              </span>
            </div>
          )}
          {doc.status === 'completed' && !fullyReviewed && fields.length > 0 && (
            <Button size="sm" variant="good" onClick={verifyAllRemaining}>
              <CheckCheck size={13} /> Verify remaining
            </Button>
          )}
        </div>
      </header>

      {/* body */}
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 lg:flex-row">
        <div className="min-h-[42vh] min-w-0 flex-1 lg:min-h-0 lg:flex-[1.35]">
          {doc.status === 'processing' || doc.status === 'queued' ? (
            <div className="card h-full">
              <PipelineProgress doc={doc} />
            </div>
          ) : doc.status === 'failed' ? (
            <div className="card flex h-full flex-col items-center justify-center gap-3 p-8">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-crit/30 bg-crit/10 text-crit">
                <AlertTriangle size={22} />
              </div>
              <p className="font-display text-sm font-semibold text-crit">Extraction failed</p>
              <p className="max-w-md text-center text-xs leading-relaxed text-ink-muted">{doc.error}</p>
              <Button variant="primary" size="sm" loading={processDoc.isPending} onClick={() => processDoc.mutate(doc.id)}>
                <RotateCcw size={13} /> Retry extraction
              </Button>
            </div>
          ) : (
            <BlueprintViewer
              ref={viewerRef}
              fileUrl={`/api/documents/${doc.id}/file`}
              fields={fields}
              activeFieldId={activeFieldId}
              onFieldClick={selectField}
              selectMode={correctingId != null && draft.picking}
              selectedRegion={correctingId != null ? draft.region : null}
              onRegionSelect={(bbox) => setDraft((d) => ({ ...d, region: bbox, picking: false }))}
            />
          )}
        </div>

        {/* specification panel */}
        <div className="card flex min-h-0 w-full shrink-0 flex-col overflow-hidden lg:w-[500px] xl:w-[520px]">
          <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
            <h2 className="microlabel !text-[10px] !text-ink-secondary">Extracted Specification</h2>
            <div className="flex items-center gap-2.5 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-muted">
              <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-warn" /> review</span>
              <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-good" /> verified</span>
              <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-crit" /> redlined</span>
            </div>
          </div>

          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
            {doc.status !== 'completed' ? (
              <div className="flex h-40 items-center justify-center text-xs text-ink-muted">
                {doc.status === 'failed' ? 'No extraction available.' : 'Waiting for extraction to finish…'}
              </div>
            ) : (
              fields.map((f, i) => (
                <FieldRow
                  key={f.id}
                  field={f}
                  index={i}
                  active={f.id === activeFieldId}
                  documentId={doc.id}
                  onSelect={selectField}
                  correcting={f.id === correctingId}
                  onStartCorrection={startCorrection}
                  onCancelCorrection={() => setCorrectingId(null)}
                  draft={draft}
                  onDraftChange={(d) => setDraft((prev) => ({ ...prev, ...d }))}
                />
              ))
            )}
          </div>

          {doc.status === 'completed' && fields.length > 0 && (
            <div className="hidden items-center gap-3 border-t border-line bg-surface-2/40 px-3.5 py-2 lg:flex">
              <span className="flex items-center gap-1.5 text-[10.5px] text-ink-muted">
                <Kbd>↑</Kbd><Kbd>↓</Kbd> navigate
              </span>
              <span className="flex items-center gap-1.5 text-[10.5px] text-ink-muted">
                <Kbd>V</Kbd> verify
              </span>
              <span className="flex items-center gap-1.5 text-[10.5px] text-ink-muted">
                <Kbd>C</Kbd> correct
              </span>
              <span className="flex items-center gap-1.5 text-[10.5px] text-ink-muted">
                <Kbd>B</Kbd> boxes
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
