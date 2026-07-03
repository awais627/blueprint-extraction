import {
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Eye,
  EyeOff,
  Maximize,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'

import type { BBox, ExtractedField } from '../api/types'
import { cn } from '../lib/utils'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

// ---------------------------------------------------------------------------
// Types & math helpers
// ---------------------------------------------------------------------------

interface View {
  s: number
  tx: number
  ty: number
  r: 0 | 90 | 180 | 270
}

export interface ViewerHandle {
  zoomToField: (field: ExtractedField) => void
  zoomToBBox: (bbox: BBox, page: number) => void
  toggleBoxes: () => void
}

/** rotate page-space point about origin by r degrees */
const rot = (x: number, y: number, r: number): [number, number] => {
  switch (((r % 360) + 360) % 360) {
    case 90:
      return [-y, x]
    case 180:
      return [-x, -y]
    case 270:
      return [y, -x]
    default:
      return [x, y]
  }
}

const unrot = (x: number, y: number, r: number): [number, number] => rot(x, y, (360 - r) % 360)

// tuned for visibility on white paper
const fieldTone = {
  verified: { border: '#0FA45C', fill: 'rgba(18,161,80,0.13)', chip: 'bg-[#0E7A46]' },
  corrected: { border: '#E5484D', fill: 'rgba(229,72,77,0.13)', chip: 'bg-[#C03538]' },
  unverified: { border: '#C98A0B', fill: 'rgba(218,158,39,0.15)', chip: 'bg-[#96690A]' },
}
const SELECT_CYAN = '#0891B2'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  fileUrl: string
  fields: ExtractedField[]
  activeFieldId: number | null
  onFieldClick: (field: ExtractedField) => void
  selectMode: boolean
  onRegionSelect: (bbox: BBox) => void
  selectedRegion: BBox | null
}

const BlueprintViewer = forwardRef<ViewerHandle, Props>(function BlueprintViewer(
  { fileUrl, fields, activeFieldId, onFieldClick, selectMode, onRegionSelect, selectedRegion },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null)

  const [pdf, setPdf] = useState<pdfjs.PDFDocumentProxy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<{ w: number; h: number } | null>(null)
  const [view, setView] = useState<View>({ s: 1, tx: 0, ty: 0, r: 0 })
  const [animate, setAnimate] = useState(false)
  const [rendering, setRendering] = useState(true)
  const [showBoxes, setShowBoxes] = useState(true)
  const [hoveredId, setHoveredId] = useState<number | null>(null)
  const [renderScale, setRenderScale] = useState(2)
  const [dragSel, setDragSel] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [cursor, setCursor] = useState<{ px: number; py: number; x: number; y: number } | null>(null)

  const pendingZoom = useRef<{ bbox: BBox; page: number } | null>(null)
  const cursorRaf = useRef(0)
  const viewRef = useRef(view)
  viewRef.current = view
  const pageSizeRef = useRef(pageSize)
  pageSizeRef.current = pageSize

  // ---- document loading ----------------------------------------------------

  useEffect(() => {
    let cancelled = false
    setPdf(null)
    setError(null)
    const task = pdfjs.getDocument(fileUrl)
    task.promise
      .then((doc) => !cancelled && setPdf(doc))
      .catch((e) => !cancelled && setError(String(e?.message ?? e)))
    return () => {
      cancelled = true
      task.destroy().catch(() => {})
    }
  }, [fileUrl])

  // ---- page rendering --------------------------------------------------------

  useEffect(() => {
    if (!pdf) return
    let cancelled = false
    setRendering(true)
    pdf
      .getPage(page)
      .then((p) => {
        if (cancelled) return
        const vp1 = p.getViewport({ scale: 1 })
        setPageSize((prev) =>
          prev && prev.w === vp1.width && prev.h === vp1.height ? prev : { w: vp1.width, h: vp1.height },
        )
        const dpr = window.devicePixelRatio || 1
        const vp = p.getViewport({ scale: renderScale * dpr })
        const canvas = canvasRef.current
        if (!canvas) return // canvas mounts once pageSize is known; the pageSize dep re-runs this effect
        renderTaskRef.current?.cancel()
        const ctx = canvas.getContext('2d')!
        canvas.width = Math.floor(vp.width)
        canvas.height = Math.floor(vp.height)
        const task = p.render({ canvasContext: ctx, viewport: vp })
        renderTaskRef.current = task
        task.promise
          .then(() => !cancelled && setRendering(false))
          .catch(() => {}) // cancelled renders are fine
      })
      .catch(() => !cancelled && setRendering(false))
    return () => {
      cancelled = true
    }
  }, [pdf, page, renderScale, pageSize])

  // ---- fit / view helpers ------------------------------------------------------

  const fitView = useCallback((r: View['r'] = viewRef.current.r, doAnimate = false) => {
    const el = containerRef.current
    const ps = pageSizeRef.current
    if (!el || !ps) return
    const cw = el.clientWidth
    const ch = el.clientHeight
    const rotated = r === 90 || r === 270
    const pw = rotated ? ps.h : ps.w
    const ph = rotated ? ps.w : ps.h
    const s = Math.min((cw - 48) / pw, (ch - 48) / ph)
    // bounding box of rotated page starts at negative offsets; compute min corner
    const corners: [number, number][] = [
      rot(0, 0, r),
      rot(ps.w, 0, r),
      rot(0, ps.h, r),
      rot(ps.w, ps.h, r),
    ]
    const minX = Math.min(...corners.map((c) => c[0]))
    const minY = Math.min(...corners.map((c) => c[1]))
    const tx = (cw - pw * s) / 2 - minX * s
    const ty = (ch - ph * s) / 2 - minY * s
    setAnimate(doAnimate)
    setView({ s, tx, ty, r })
  }, [])

  // refit when page geometry first becomes known or page changes
  useEffect(() => {
    if (pageSize) fitView(viewRef.current.r, false)
  }, [pageSize, page, fitView])

  // execute pending zoom-to-bbox once the right page is mounted
  useEffect(() => {
    if (!pendingZoom.current || !pageSize) return
    const { bbox, page: targetPage } = pendingZoom.current
    if (targetPage !== page - 1) return
    pendingZoom.current = null
    zoomToBBoxInternal(bbox)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSize, page])

  const zoomToBBoxInternal = useCallback((bbox: BBox) => {
    const el = containerRef.current
    const ps = pageSizeRef.current
    if (!el || !ps) return
    const { r } = viewRef.current
    const bw = Math.max(bbox.w * ps.w, 8)
    const bh = Math.max(bbox.h * ps.h, 8)
    const rotated = r === 90 || r === 270
    const targetW = rotated ? bh : bw
    const targetH = rotated ? bw : bh
    const cw = el.clientWidth
    const ch = el.clientHeight
    const s = Math.min(Math.min((cw * 0.55) / targetW, (ch * 0.45) / targetH), 9)
    const cx = (bbox.x + bbox.w / 2) * ps.w
    const cy = (bbox.y + bbox.h / 2) * ps.h
    const [rx, ry] = rot(cx, cy, r)
    setAnimate(true)
    setView({ s, tx: cw / 2 - rx * s, ty: ch / 2 - ry * s, r })
  }, [])

  const zoomToBBox = useCallback(
    (bbox: BBox, targetPage: number) => {
      if (targetPage !== page - 1) {
        pendingZoom.current = { bbox, page: targetPage }
        setPage(targetPage + 1)
      } else {
        zoomToBBoxInternal(bbox)
      }
    },
    [page, zoomToBBoxInternal],
  )

  useImperativeHandle(ref, () => ({
    zoomToBBox,
    zoomToField: (field: ExtractedField) => {
      if (field.bbox_x == null || field.page == null) return
      zoomToBBox(
        { x: field.bbox_x, y: field.bbox_y!, w: field.bbox_w!, h: field.bbox_h! },
        field.page,
      )
    },
    toggleBoxes: () => setShowBoxes((v) => !v),
  }))

  // ---- adaptive render quality ---------------------------------------------------

  useEffect(() => {
    const t = setTimeout(() => {
      const target = Math.min(4, Math.max(2, Math.ceil(view.s)))
      setRenderScale((prev) => (target > prev ? target : prev))
    }, 350)
    return () => clearTimeout(t)
  }, [view.s])

  // ---- interaction: wheel zoom (native listener for preventDefault) ---------------

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const { s, tx, ty, r } = viewRef.current
      const factor = Math.exp(-e.deltaY * 0.0016)
      const ns = Math.min(Math.max(s * factor, 0.05), 12)
      setAnimate(false)
      setView({
        s: ns,
        tx: px - ((px - tx) * ns) / s,
        ty: py - ((py - ty) * ns) / s,
        r,
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ---- interaction: pan & region select --------------------------------------------

  const screenToPage = useCallback((clientX: number, clientY: number): [number, number] | null => {
    const el = containerRef.current
    const ps = pageSizeRef.current
    if (!el || !ps) return null
    const rect = el.getBoundingClientRect()
    const { s, tx, ty, r } = viewRef.current
    const sx = (clientX - rect.left - tx) / s
    const sy = (clientY - rect.top - ty) / s
    const [x, y] = unrot(sx, sy, r)
    return [x, y]
  }, [])

  const dragState = useRef<{ mode: 'pan' | 'select'; startX: number; startY: number; tx0: number; ty0: number } | null>(null)

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    if (selectMode) {
      const pt = screenToPage(e.clientX, e.clientY)
      if (!pt) return
      dragState.current = { mode: 'select', startX: pt[0], startY: pt[1], tx0: 0, ty0: 0 }
      setDragSel({ x0: pt[0], y0: pt[1], x1: pt[0], y1: pt[1] })
    } else {
      dragState.current = {
        mode: 'pan',
        startX: e.clientX,
        startY: e.clientY,
        tx0: viewRef.current.tx,
        ty0: viewRef.current.ty,
      }
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    // status-bar coordinate readout + crosshair (rAF-throttled)
    const cx = e.clientX
    const cy = e.clientY
    if (!cursorRaf.current) {
      cursorRaf.current = requestAnimationFrame(() => {
        cursorRaf.current = 0
        const el = containerRef.current
        const ps = pageSizeRef.current
        if (!el || !ps) return
        const rect = el.getBoundingClientRect()
        const pt = screenToPage(cx, cy)
        if (!pt) return
        setCursor({
          px: cx - rect.left,
          py: cy - rect.top,
          x: pt[0] / ps.w,
          y: pt[1] / ps.h,
        })
      })
    }

    const d = dragState.current
    if (!d) return
    if (d.mode === 'pan') {
      setAnimate(false)
      setView((v) => ({ ...v, tx: d.tx0 + (e.clientX - d.startX), ty: d.ty0 + (e.clientY - d.startY) }))
    } else {
      const pt = screenToPage(e.clientX, e.clientY)
      if (pt) setDragSel({ x0: d.startX, y0: d.startY, x1: pt[0], y1: pt[1] })
    }
  }

  const onPointerUp = () => {
    const d = dragState.current
    dragState.current = null
    if (d?.mode === 'select' && dragSel && pageSize) {
      const x = Math.min(dragSel.x0, dragSel.x1)
      const y = Math.min(dragSel.y0, dragSel.y1)
      const w = Math.abs(dragSel.x1 - dragSel.x0)
      const h = Math.abs(dragSel.y1 - dragSel.y0)
      setDragSel(null)
      if (w > 6 && h > 6) {
        onRegionSelect({
          x: Math.max(0, x / pageSize.w),
          y: Math.max(0, y / pageSize.h),
          w: Math.min(1, w / pageSize.w),
          h: Math.min(1, h / pageSize.h),
          page: page - 1,
        })
      }
    }
  }

  // ---- derived -------------------------------------------------------------------

  const pageFields = useMemo(
    () => fields.filter((f) => f.bbox_x != null && f.page === page - 1),
    [fields, page],
  )
  const pageCount = pdf?.numPages ?? 1

  const zoomBy = (factor: number) => {
    const el = containerRef.current
    if (!el) return
    const { s, tx, ty, r } = viewRef.current
    const cx = el.clientWidth / 2
    const cy = el.clientHeight / 2
    const ns = Math.min(Math.max(s * factor, 0.05), 12)
    setAnimate(true)
    setView({ s: ns, tx: cx - ((cx - tx) * ns) / s, ty: cy - ((cy - ty) * ns) / s, r })
  }

  const rotate = () => {
    const next = ((view.r + 90) % 360) as View['r']
    fitView(next, true)
  }

  const inPage = cursor && cursor.x >= 0 && cursor.x <= 1 && cursor.y >= 0 && cursor.y <= 1

  // ---- render ---------------------------------------------------------------------

  const toolBtn =
    'flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary transition-colors hover:bg-surface-3 hover:text-ink disabled:opacity-40 disabled:pointer-events-none'

  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-xl border border-line bg-[#05090F]">
      {/* toolbar */}
      <div className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-line-strong bg-surface-1/90 px-1.5 py-1 shadow-pop backdrop-blur-md">
        <button className={toolBtn} onClick={() => zoomBy(1.4)} title="Zoom in">
          <ZoomIn size={14.5} />
        </button>
        <button className={toolBtn} onClick={() => zoomBy(1 / 1.4)} title="Zoom out">
          <ZoomOut size={14.5} />
        </button>
        <button className={toolBtn} onClick={() => fitView(view.r, true)} title="Fit to screen">
          <Maximize size={13.5} />
        </button>
        <button className={toolBtn} onClick={rotate} title="Rotate 90°">
          <RotateCw size={13.5} />
        </button>
        <div className="mx-1 h-4 w-px bg-line-strong" />
        <button
          className={cn(toolBtn, showBoxes && 'bg-accent/15 text-accent-bright')}
          onClick={() => setShowBoxes((v) => !v)}
          title={showBoxes ? 'Hide bounding boxes (B)' : 'Show bounding boxes (B)'}
        >
          {showBoxes ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
        {pageCount > 1 && (
          <>
            <div className="mx-1 h-4 w-px bg-line-strong" />
            <button className={toolBtn} disabled={page <= 1} onClick={() => setPage((p) => p - 1)} title="Previous page">
              <ChevronLeft size={15} />
            </button>
            <span className="px-1 font-mono text-[11px] tabular-nums text-ink-secondary">
              {page}/{pageCount}
            </span>
            <button
              className={toolBtn}
              disabled={page >= pageCount}
              onClick={() => setPage((p) => p + 1)}
              title="Next page"
            >
              <ChevronRight size={15} />
            </button>
          </>
        )}
      </div>

      {/* select-mode hint */}
      {selectMode && (
        <div className="absolute left-1/2 top-14 z-20 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs text-accent-bright shadow-pop backdrop-blur-md animate-fade-in">
          <Crosshair size={13} />
          Drag a box around the correct value on the drawing
        </div>
      )}

      {/* canvas stage */}
      <div
        ref={containerRef}
        className={cn(
          'blueprint-grid relative flex-1 touch-none overflow-hidden',
          selectMode ? 'cursor-crosshair' : dragState.current ? 'cursor-grabbing' : 'cursor-grab',
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          onPointerUp()
          setCursor(null)
        }}
        onDoubleClick={(e) => {
          if (!selectMode) {
            const rect = containerRef.current!.getBoundingClientRect()
            const px = e.clientX - rect.left
            const py = e.clientY - rect.top
            const { s, tx, ty, r } = viewRef.current
            const ns = Math.min(s * 2, 12)
            setAnimate(true)
            setView({ s: ns, tx: px - ((px - tx) * ns) / s, ty: py - ((py - ty) * ns) / s, r })
          }
        }}
      >
        {error ? (
          <div className="flex h-full items-center justify-center text-sm text-crit">{error}</div>
        ) : !pdf || !pageSize ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-ink-muted">
            <svg width="26" height="26" viewBox="0 0 28 28" className="animate-spin text-accent" style={{ animationDuration: '1.4s' }}>
              <circle cx="14" cy="14" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
              <path d="M14 1 v6 M14 21 v6 M1 14 h6 M21 14 h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span className="microlabel animate-blink">Loading blueprint</span>
          </div>
        ) : null}

        {pageSize && (
          <div
            className="absolute left-0 top-0"
            style={{
              width: pageSize.w,
              height: pageSize.h,
              transformOrigin: '0 0',
              transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.s}) rotate(${view.r}deg)`,
              transition: animate ? 'transform 0.55s cubic-bezier(0.22, 1, 0.36, 1)' : 'none',
            }}
          >
            <canvas
              ref={canvasRef}
              className="block bg-white shadow-[0_0_0_1px_rgba(53,200,238,0.2),0_0_40px_-8px_rgba(53,200,238,0.15),0_24px_80px_-24px_rgba(0,0,0,0.9)]"
              style={{ width: pageSize.w, height: pageSize.h }}
            />
            {rendering && (
              <div className="absolute inset-0 flex items-center justify-center bg-white/40">
                <svg width="24" height="24" viewBox="0 0 28 28" className="animate-spin text-slate-500" style={{ animationDuration: '1.4s' }}>
                  <circle cx="14" cy="14" r="9" fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.5" />
                  <path d="M14 1 v6 M14 21 v6 M1 14 h6 M21 14 h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </div>
            )}

            {/* field bounding boxes */}
            {showBoxes &&
              pageFields.map((f) => {
                const tone = fieldTone[f.status]
                const active = f.id === activeFieldId
                const hovered = f.id === hoveredId
                const pad = 3 / view.s
                const w = f.bbox_w! * pageSize.w + pad * 2
                const h = f.bbox_h! * pageSize.h + pad * 2
                const bracket = Math.max(Math.min(w, h) * 0.28, 7 / view.s)
                const bStroke = Math.max(2.2 / view.s, 0.7)
                return (
                  <div
                    key={f.id}
                    className={cn('absolute cursor-pointer', active && 'bbox-pulse z-10')}
                    style={{
                      left: f.bbox_x! * pageSize.w - pad,
                      top: f.bbox_y! * pageSize.h - pad,
                      width: w,
                      height: h,
                      border: `${active || hovered ? Math.max(1.6 / view.s, 0.5) : Math.max(1.1 / view.s, 0.35)}px solid ${tone.border}`,
                      background: active || hovered ? tone.fill : 'transparent',
                      borderRadius: 2.5 / view.s,
                    }}
                    onPointerDown={(e) => {
                      if (!selectMode) {
                        e.stopPropagation()
                        onFieldClick(f)
                      }
                    }}
                    onMouseEnter={() => setHoveredId(f.id)}
                    onMouseLeave={() => setHoveredId(null)}
                  >
                    {/* CAD corner brackets on the active selection */}
                    {active &&
                      (['tl', 'tr', 'bl', 'br'] as const).map((corner) => (
                        <span
                          key={corner}
                          className="absolute block"
                          style={{
                            width: bracket,
                            height: bracket,
                            ...(corner[0] === 't' ? { top: -bStroke * 1.6 } : { bottom: -bStroke * 1.6 }),
                            ...(corner[1] === 'l' ? { left: -bStroke * 1.6 } : { right: -bStroke * 1.6 }),
                            borderStyle: 'solid',
                            borderColor: SELECT_CYAN,
                            borderWidth: `${corner[0] === 't' ? bStroke : 0}px ${corner[1] === 'r' ? bStroke : 0}px ${
                              corner[0] === 'b' ? bStroke : 0
                            }px ${corner[1] === 'l' ? bStroke : 0}px`,
                          }}
                        />
                      ))}

                    {(active || hovered) && (
                      <span
                        className={cn(
                          'absolute left-0 whitespace-nowrap rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.06em] text-white shadow-md',
                          tone.chip,
                        )}
                        style={{
                          bottom: '100%',
                          marginBottom: 5 / view.s,
                          transformOrigin: 'bottom left',
                          transform: `rotate(${-view.r}deg) scale(${1 / view.s})`,
                        }}
                      >
                        {f.label}
                        {f.confidence != null && (
                          <span className="ml-1.5 opacity-70">{Math.round(f.confidence * 100)}%</span>
                        )}
                      </span>
                    )}
                  </div>
                )
              })}

            {/* saved corrected-location region */}
            {selectedRegion && selectedRegion.page === page - 1 && (
              <div
                className="absolute"
                style={{
                  left: selectedRegion.x * pageSize.w,
                  top: selectedRegion.y * pageSize.h,
                  width: selectedRegion.w * pageSize.w,
                  height: selectedRegion.h * pageSize.h,
                  border: `${Math.max(1.5 / view.s, 0.5)}px dashed ${SELECT_CYAN}`,
                  background: 'rgba(8,145,178,0.12)',
                  borderRadius: 3 / view.s,
                }}
              />
            )}

            {/* live drag selection */}
            {dragSel && (
              <div
                className="absolute"
                style={{
                  left: Math.min(dragSel.x0, dragSel.x1),
                  top: Math.min(dragSel.y0, dragSel.y1),
                  width: Math.abs(dragSel.x1 - dragSel.x0),
                  height: Math.abs(dragSel.y1 - dragSel.y0),
                  border: `${Math.max(1.5 / view.s, 0.5)}px solid ${SELECT_CYAN}`,
                  background: 'rgba(8,145,178,0.15)',
                }}
              />
            )}
          </div>
        )}

        {/* crosshair hairlines while marking a region */}
        {selectMode && cursor && (
          <div className="pointer-events-none absolute inset-0 z-10">
            <div className="absolute inset-y-0 w-px bg-accent/40" style={{ left: cursor.px }} />
            <div className="absolute inset-x-0 h-px bg-accent/40" style={{ top: cursor.py }} />
          </div>
        )}
      </div>

      {/* CAD status bar */}
      <div className="flex h-7 shrink-0 items-center gap-4 border-t border-line bg-surface-1/90 px-3 font-mono text-[10px] tabular-nums text-ink-muted backdrop-blur-sm">
        <span className="w-36 shrink-0">
          {inPage ? (
            <>
              <span className="text-ink-muted">X</span>{' '}
              <span className="text-ink-secondary">{cursor!.x.toFixed(3)}</span>
              <span className="ml-2.5 text-ink-muted">Y</span>{' '}
              <span className="text-ink-secondary">{cursor!.y.toFixed(3)}</span>
            </>
          ) : (
            <span className="opacity-50">X — · Y —</span>
          )}
        </span>
        <span className="hidden uppercase tracking-[0.08em] sm:inline">
          {pageFields.length} value{pageFields.length === 1 ? '' : 's'} located
          {pageCount > 1 && ` · sheet ${page}/${pageCount}`}
        </span>
        <span className="ml-auto uppercase tracking-[0.08em]">
          {selectMode ? <span className="text-accent animate-blink">◉ marking region</span> : `zoom ${Math.round(view.s * 100)}%`}
        </span>
      </div>
    </div>
  )
})

export default BlueprintViewer
