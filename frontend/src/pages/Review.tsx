import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
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
  useRegionSnippet,
  useSetFieldStatus,
} from '../api/hooks'
import { ApiError, BASE } from '../api/client'
import type { BBox, DocumentDetail, ExtractedField, FieldLocation } from '../api/types'
import BlueprintViewer, { type ViewerHandle } from '../components/BlueprintViewer'
import { Badge, BlueprintArt, Button, ConfidenceMeter, HoverFull, Input, Kbd, PageSpinner, ProgressRing, Textarea } from '../components/ui'
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
        <div className="absolute inset-x-6 top-7 h-1.5 rounded bg-line-strong" />
        <div className="absolute left-6 top-12 h-1.5 w-24 rounded bg-line" />
        <div className="absolute left-6 top-[66px] h-14 w-20 rounded border border-dashed border-line-strong" />
        <div className="absolute right-6 top-[66px] h-1.5 w-16 rounded bg-line" />
        <div className="absolute right-6 top-[82px] h-1.5 w-20 rounded bg-line" />
        <div className="absolute bottom-6 inset-x-6 h-5 rounded border border-line-strong" />
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
                {i < current ? <Check size={17} /> : i === current ? <Loader2 size={17} className="animate-spin" /> : i + 1}
              </div>
              <span className={cn('microlabel text-center !text-[11px]', i <= current ? '!text-ink-secondary' : '')}>
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
  /** OCR text under the marked box, once fetched — null while unmarked or loading */
  snippet: string | null
}

/** The reason auto-added to the extraction prompt when the engineer leaves the "why"
    field blank. Mirrors backend prompt_builder.get_correction_warnings — keep in sync. */
function defaultReasonPreview(field: ExtractedField, correctedValue: string, snippet: string | null): string {
  const original = (field.value ?? '').trim() || '(blank)'
  const corrected = correctedValue.trim()
  let sentence = `AI answered '${original}' here; the engineer corrected it to '${corrected}'`
  if (snippet) {
    sentence += ` [engineer marked where the correct value is printed; the text there reads: '${snippet}']`
  }
  return sentence
}

const statusEdge: Record<string, string> = {
  unverified: 'bg-warn/70',
  verified: 'bg-good/70',
  corrected: 'bg-crit/70',
}

/** every place the value occurs, primary first — falls back to the single bbox for
    documents processed before multi-location support */
const fieldLocations = (f: ExtractedField): FieldLocation[] => {
  if (f.locations?.length) return f.locations
  if (f.bbox_x != null && f.page != null) {
    return [{ page: f.page, x: f.bbox_x, y: f.bbox_y!, w: f.bbox_w!, h: f.bbox_h!, q: f.match_quality }]
  }
  return []
}

/** review-priority dot by OCR confidence (unverified fields only) — same tiers/colors as ConfidenceMeter */
function PriorityIcon({ confidence }: { confidence: number | null }) {
  const tier =
    confidence == null || confidence < 0.7
      ? { color: 'bg-crit', label: 'High priority — low confidence' }
      : confidence < 0.9
        ? { color: 'bg-warn', label: 'Medium priority' }
        : { color: 'bg-good', label: 'Low priority — likely correct' }
  return <span className={cn('led shrink-0', tier.color)} title={tier.label} aria-label={tier.label} />
}

const matchGlyph: Record<string, { label: string; className: string }> = {
  anchor: { label: 'engineer anchored', className: 'text-accent/90' },
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
  occIndex,
  onOccurrenceNav,
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
  occIndex: number
  onOccurrenceNav: (dir: -1 | 1) => void
}) {
  const setStatus = useSetFieldStatus(documentId)
  const createCorrection = useCreateCorrection(documentId)

  const sourceDiffers =
    !!field.source_text &&
    !!field.value &&
    field.source_text.replace(/\W+/g, '').toLowerCase() !== field.value.replace(/\W+/g, '').toLowerCase()

  const locations = fieldLocations(field)
  // the tag and confidence reflect the occurrence currently in view — each location was
  // matched at its own precision and carries its own OCR confidence
  const activeLoc = locations[occIndex]
  const shownQuality = activeLoc?.q ?? field.match_quality
  const match = matchGlyph[shownQuality] ?? matchGlyph.none
  const shownConfidence = activeLoc?.conf ?? field.confidence

  // an unverified field with no extracted value is the highest-priority thing to
  // look at (nothing was read from the drawing) — flag its Review tag red
  const isEmpty = !field.value
  const statusBadge =
    field.status === 'verified' ? (
      <Badge tone="good"><Check size={13} /> Verified</Badge>
    ) : field.status === 'corrected' ? (
      <Badge tone="crit"><Pencil size={12} /> Corrected</Badge>
    ) : (
      <Badge tone={isEmpty ? 'crit' : 'warn'}> Review</Badge>
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
        'group relative border-b border-line transition-colors',
        active ? 'bg-accent/[0.055]' : 'hover:bg-surface-2/50',
        correcting && 'bg-surface-2/70',
      )}
    >
      {/* status edge */}
      <span className={cn('absolute inset-y-0 left-0 w-[2.5px]', statusEdge[field.status])} />
      {active && <span className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-accent/25" />}

      <div className="flex cursor-pointer items-center gap-3 py-2.5 pl-4 pr-3" onClick={() => onSelect(field)}>
        <span className="w-6 shrink-0 font-mono text-[11.5px] tabular-nums text-ink-muted">
          {String(index + 1).padStart(2, '0')}
        </span>

        <div className="w-[128px] shrink-0">
          <p className="text-[13px] font-medium leading-tight text-ink-secondary">{field.label}</p>
          <p className={cn('mt-0.5 flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.06em]', match.className)}>
            <Crosshair size={11} strokeWidth={2.2} />
            {match.label}
          </p>
          {/* value appears in several places — step through the occurrences */}
          {active && locations.length > 1 && (
            <div
              className="mt-1 inline-flex items-center gap-0.5 rounded-md border border-accent/30 bg-accent/[0.07] px-0.5"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                title="Previous occurrence"
                className="flex h-6 w-6 items-center justify-center rounded text-accent-bright transition-colors hover:bg-accent/15"
                onClick={() => onOccurrenceNav(-1)}
              >
                <ChevronLeft size={14} />
              </button>
              <span className="font-mono text-[11px] tabular-nums text-accent-bright" title="Occurrence on the drawing">
                {occIndex + 1}/{locations.length}
              </span>
              <button
                title="Next occurrence"
                className="flex h-6 w-6 items-center justify-center rounded text-accent-bright transition-colors hover:bg-accent/15"
                onClick={() => onOccurrenceNav(1)}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          {field.value ? (
            <HoverFull
              title={field.value}
              className={cn(
                'font-mono text-[14px] tracking-tight',
                field.status === 'corrected' ? 'text-crit/70 line-through decoration-crit/50' : 'text-ink',
              )}
            >
              {field.value}
            </HoverFull>
          ) : (
            <p className="text-[13.5px] italic text-ink-muted">not found</p>
          )}
          {field.status === 'corrected' && field.corrected_value && (
            <HoverFull title={field.corrected_value} className="font-mono text-[14px] tracking-tight text-good">
              {field.corrected_value}
            </HoverFull>
          )}
          {sourceDiffers && (
            <HoverFull title={`read as “${field.source_text}”`} className="mt-0.5 text-[12px] text-ink-muted">
              read as <span className="font-mono text-accent/80">“{field.source_text}”</span>
            </HoverFull>
          )}
        </div>

        <div className="hidden shrink-0 xl:block">
          <ConfidenceMeter value={shownConfidence} />
        </div>
        <div className="w-[100px] shrink-0 text-right">{statusBadge}</div>

        <div
          className={cn(
            'flex w-[78px] shrink-0 items-center justify-end gap-0.5',
            field.status === 'unverified' ? 'opacity-100' : 'opacity-0 transition-opacity group-hover:opacity-100',
          )}
        >
          {field.status === 'unverified' ? (
            <>
              <button
                title="Mark as correct (V)"
                className="flex h-9 w-9 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-good/15 hover:text-good"
                onClick={(e) => {
                  e.stopPropagation()
                  setStatus.mutate({ fieldId: field.id, status: 'verified' })
                }}
              >
                <Check size={17} />
              </button>
              <button
                title="Correct this value (C)"
                className="flex h-9 w-9 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-crit/15 hover:text-crit"
                onClick={(e) => {
                  e.stopPropagation()
                  onStartCorrection(field)
                }}
              >
                <Pencil size={15.5} />
              </button>
            </>
          ) : (
            <button
              title="Reset to unreviewed"
              className="flex h-9 w-9 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
              onClick={(e) => {
                e.stopPropagation()
                setStatus.mutate({ fieldId: field.id, status: 'unverified' })
              }}
            >
              <Undo2 size={15.5} />
            </button>
          )}
        </div>
      </div>

      {/* AI reasoning for the selected field */}
      {active && !correcting && (field.ai_reasoning || sourceDiffers) && (
        <div className="flex items-start gap-2 border-t border-line bg-surface-2/40 py-2.5 pl-4 pr-3.5 animate-fade-in">
          <Sparkles size={14} className="mt-0.5 shrink-0 text-accent/80" />
          <div className="min-w-0 text-[13px] leading-relaxed text-ink-secondary">
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
          <p className="microlabel flex items-center gap-1.5 !text-[11px] !text-crit/80">
            <Pencil size={12} /> Redline correction
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Correct value</label>
              <Input
                autoFocus
                value={draft.value}
                onChange={(e) => onDraftChange({ value: e.target.value })}
                placeholder="Enter the value as it should read"
                className="font-mono text-[14px]"
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
              placeholder={
                draft.region
                  ? defaultReasonPreview(field, draft.value, draft.snippet)
                  : 'e.g. "AI reads E18 instead of E8 because the 1 looks like scan noise" — this feeds back into the extraction prompt.'
              }
            />
            {draft.region && !draft.reason.trim() && (
              <p className="mt-1 text-[11.5px] leading-relaxed text-ink-muted">
                Leave blank to feed the greyed-out sentence into the extraction prompt, or type your own to
                improve it.
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              size="sm"
              variant={draft.picking ? 'primary' : 'secondary'}
              onClick={() => onDraftChange({ picking: !draft.picking })}
            >
              <Crosshair size={15} />
              {draft.picking ? 'Drag on the drawing…' : draft.region ? 'Re-mark location' : 'Mark location on drawing'}
            </Button>
            <div className="flex items-center gap-2">
              {draft.region && (
                <span className="flex items-center gap-1 font-mono text-[11.5px] uppercase tracking-[0.08em] text-accent">
                  <MapPin size={13} /> marked
                </span>
              )}
              <Button size="sm" variant="ghost" onClick={onCancelCorrection}>
                <X size={15} /> Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!draft.value.trim()}
                loading={createCorrection.isPending}
                onClick={save}
              >
                <Check size={15} /> Save correction
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
      <span className="microlabel !text-[10px]">{label}</span>
      <span className={cn('mt-0.5 truncate text-[13px] text-ink-secondary', mono && 'font-mono tabular-nums')}>
        {value}
      </span>
    </div>
  )
}

function DocumentNotFound({ error }: { error: unknown }) {
  const notFound = error instanceof ApiError && error.status === 404
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="card reg-corners reg-corners-active flex max-w-md flex-col items-center gap-3 px-10 py-12 text-center">
        <BlueprintArt size={110} />
        <p className="mt-2 font-mono text-[28px] font-semibold tracking-tight text-ink-hi">
          {notFound ? '404' : 'Error'}
        </p>
        <p className="microlabel !text-[11.5px]">{notFound ? 'Sheet not on file' : 'Could not load sheet'}</p>
        <p className="max-w-xs text-xs leading-relaxed text-ink-muted">
          {notFound
            ? 'No document with this ID exists in the drawing register — it may have been deleted.'
            : String((error as Error)?.message ?? error)}
        </p>
        <Link to="/documents" className="mt-3">
          <Button variant="primary" size="sm">
            <ArrowLeft size={15} /> Back to documents
          </Button>
        </Link>
      </div>
    </div>
  )
}

export default function Review() {
  const { id } = useParams<{ id: string }>()
  const { data: doc, isLoading, error } = useDocument(id)
  const processDoc = useProcessDocument()
  const setStatus = useSetFieldStatus(id ?? '')

  const viewerRef = useRef<ViewerHandle>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const autoSelected = useRef(false)
  const [activeFieldId, setActiveFieldId] = useState<number | null>(null)
  const [correctingId, setCorrectingId] = useState<number | null>(null)
  // which occurrence of the active field's value is being viewed
  const [occIndex, setOccIndex] = useState(0)
  const [draft, setDraft] = useState<CorrectionDraft>({ value: '', reason: '', category: '', region: null, picking: false, snippet: null })
  const regionSnippet = useRegionSnippet()

  const fields = useMemo(() => doc?.fields ?? [], [doc])
  const reviewed = fields.filter((f) => f.status !== 'unverified').length
  const fullyReviewed = fields.length > 0 && reviewed === fields.length

  // auto-select first located field once loaded (only once — the user may deselect)
  useEffect(() => {
    if (!autoSelected.current && doc?.status === 'completed' && fields.length) {
      autoSelected.current = true
      const first = fields.find((f) => f.bbox_x != null) ?? fields[0]
      setActiveFieldId(first.id)
    }
  }, [doc?.status, fields])

  const selectField = useCallback(
    (f: ExtractedField) => {
      // clicking the already-selected field deselects it and zooms back out
      if (f.id === activeFieldId) {
        setActiveFieldId(null)
        setOccIndex(0)
        viewerRef.current?.fitPage()
        return
      }
      setActiveFieldId(f.id)
      setOccIndex(0)
      const loc = fieldLocations(f)[0]
      if (loc) viewerRef.current?.zoomToBBox({ x: loc.x, y: loc.y, w: loc.w, h: loc.h }, loc.page)
    },
    [activeFieldId],
  )

  const goToOccurrence = useCallback(
    (dir: -1 | 1) => {
      const f = fields.find((x) => x.id === activeFieldId)
      if (!f) return
      const locs = fieldLocations(f)
      if (locs.length < 2) return
      const next = (occIndex + dir + locs.length) % locs.length
      setOccIndex(next)
      const loc = locs[next]
      viewerRef.current?.zoomToBBox({ x: loc.x, y: loc.y, w: loc.w, h: loc.h }, loc.page)
    },
    [fields, activeFieldId, occIndex],
  )

  const startCorrection = useCallback((f: ExtractedField) => {
    setActiveFieldId(f.id)
    setOccIndex(0)
    setCorrectingId(f.id)
    setDraft({ value: f.value ?? '', reason: '', category: '', region: null, picking: false, snippet: null })
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
          if (next.id !== activeFieldId) selectField(next)
          break
        }
        case 'ArrowUp':
        case 'k': {
          e.preventDefault()
          const prev = fields[Math.max(0, idx - 1)] ?? fields[0]
          if (prev.id !== activeFieldId) selectField(prev)
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

  if (error) return <DocumentNotFound error={error} />
  if (isLoading || !doc) return <PageSpinner />

  const verifyAllRemaining = () => {
    fields.filter((f) => f.status === 'unverified').forEach((f) =>
      setStatus.mutate({ fieldId: f.id, status: 'verified' }),
    )
  }

  // dashed highlight at the alternate occurrence currently being viewed
  const activeField = fields.find((f) => f.id === activeFieldId)
  const activeLoc = activeField ? fieldLocations(activeField)[occIndex] : undefined
  const ghostRegion: BBox | null =
    occIndex > 0 && activeLoc
      ? { x: activeLoc.x, y: activeLoc.y, w: activeLoc.w, h: activeLoc.h, page: activeLoc.page }
      : null

  return (
    <div className="flex h-full flex-col">
      {/* title block */}
      <header className="flex items-center gap-3 border-b border-line bg-surface-1/80 px-3 py-2 backdrop-blur-sm sm:px-4">
        <Link
          to="/documents"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-3 hover:text-ink"
        >
          <ArrowLeft size={18} />
        </Link>

        <div className="flex min-w-0 items-center gap-2.5">
          <h1 className="truncate font-mono text-[17px] font-semibold tracking-tight text-ink-hi">
            {doc.part_number ?? doc.filename}
          </h1>
          {fullyReviewed && (
            <Badge tone="good"><CheckCheck size={13} /> Reviewed</Badge>
          )}
        </div>

        <div className="ml-2 hidden h-11 min-w-0 flex-1 items-stretch overflow-hidden rounded-lg border border-line bg-surface-2/40 px-3.5 md:flex">
          <TitleBlockCell label="File" value={doc.filename} />
          <TitleBlockCell label="Part type" value={doc.part_type_name ?? '—'} />
          {doc.prompt_version_label && <TitleBlockCell label="Prompt rev" value={doc.prompt_version_label} mono />}
          {doc.avg_confidence != null && <TitleBlockCell label="OCR conf" value={formatPct(doc.avg_confidence)} mono />}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-3">
          {doc.status === 'completed' && fields.length > 0 && (
            <div className="flex items-center gap-2" title={`${reviewed} of ${fields.length} fields reviewed`}>
              <ProgressRing value={reviewed / fields.length} size={32} />
              <span className="font-mono text-[12.5px] tabular-nums text-ink-secondary">
                {reviewed}/{fields.length}
              </span>
            </div>
          )}
          {doc.status === 'completed' && !fullyReviewed && fields.length > 0 && (
            <Button size="sm" variant="good" onClick={verifyAllRemaining}>
              <CheckCheck size={15} /> Verify remaining
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
                <AlertTriangle size={24} />
              </div>
              <p className="font-display text-sm font-semibold text-crit">Extraction failed</p>
              <p className="max-w-md text-center text-xs leading-relaxed text-ink-muted">{doc.error}</p>
              <Button variant="primary" size="sm" loading={processDoc.isPending} onClick={() => processDoc.mutate(doc.id)}>
                <RotateCcw size={15} /> Retry extraction
              </Button>
            </div>
          ) : (
            <BlueprintViewer
              ref={viewerRef}
              fileUrl={`${BASE}/api/documents/${doc.id}/file`}
              fields={fields}
              activeFieldId={activeFieldId}
              onFieldClick={selectField}
              selectMode={correctingId != null && draft.picking}
              selectedRegion={correctingId != null ? draft.region : null}
              ghostRegion={ghostRegion}
              onRegionSelect={(bbox) => {
                setDraft((d) => ({ ...d, region: bbox, picking: false, snippet: null }))
                if (correctingId != null) {
                  regionSnippet.mutate(
                    { fieldId: correctingId, bbox },
                    { onSuccess: (res) => setDraft((d) => ({ ...d, snippet: res.source_snippet })) },
                  )
                }
              }}
            />
          )}
        </div>

        {/* specification panel */}
        <div className="card flex min-h-0 w-full shrink-0 flex-col overflow-hidden lg:w-[560px] xl:w-[620px]">
          <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
            <h2 className="microlabel !text-[11.5px] !text-ink-secondary">Extracted Specification</h2>
            <div className="flex items-center gap-2.5 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">
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
                  occIndex={f.id === activeFieldId ? occIndex : 0}
                  onOccurrenceNav={goToOccurrence}
                />
              ))
            )}
          </div>

          {doc.status === 'completed' && fields.length > 0 && (
            <div className="hidden items-center gap-3 border-t border-line bg-surface-2/40 px-3.5 py-2 lg:flex">
              <span className="flex items-center gap-1.5 text-[12px] text-ink-muted">
                <Kbd>↑</Kbd><Kbd>↓</Kbd> navigate
              </span>
              <span className="flex items-center gap-1.5 text-[12px] text-ink-muted">
                <Kbd>V</Kbd> verify
              </span>
              <span className="flex items-center gap-1.5 text-[12px] text-ink-muted">
                <Kbd>C</Kbd> correct
              </span>
              <span className="flex items-center gap-1.5 text-[12px] text-ink-muted">
                <Kbd>B</Kbd> boxes
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
