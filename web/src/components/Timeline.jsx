import { useEffect, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'
import { formatTime } from '../utils/format.js'
import { useZoom } from '../hooks/useZoom.js'
import EditorToolbar from './EditorToolbar.jsx'

const REGION_COLOR = 'rgba(99, 102, 241, 0.26)'
const REGION_COLOR_ACTIVE = 'rgba(129, 140, 248, 0.42)'
const HEADER_W = 72 // px — track label column (V1 / A1)
const RULER_H = 24
const VIDEO_H = 64
const AUDIO_H = 96
const LANES_H = VIDEO_H + AUDIO_H
const FULL_H = RULER_H + LANES_H
const TOP_H = RULER_H + VIDEO_H // selection/seek interaction region
const FRAME_COUNT = 28

const NICE_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800]

/** Pick a ruler step whose on-screen spacing is at least ~64px. */
function rulerStep(pxPerSec) {
  const minPx = 64
  return NICE_STEPS.find((s) => s * pxPerSec >= minPx) ?? NICE_STEPS.at(-1)
}

/**
 * Extract a filmstrip of thumbnails by seeking an offscreen <video> and drawing
 * frames to a canvas. A fixed set of frames is later stretched to fill the
 * zoomed width, which keeps this cheap at any zoom level.
 */
function useFilmstrip(src, duration) {
  const [thumbs, setThumbs] = useState([])

  useEffect(() => {
    setThumbs([])
    if (!src || !duration) return
    let cancelled = false

    const video = document.createElement('video')
    video.src = src
    video.muted = true
    video.crossOrigin = 'anonymous'
    video.preload = 'auto'

    const canvas = document.createElement('canvas')
    canvas.width = 160
    canvas.height = 90
    const ctx = canvas.getContext('2d')
    const out = new Array(FRAME_COUNT).fill(null)

    const grab = (i) =>
      new Promise((resolve) => {
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked)
          try {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
            out[i] = canvas.toDataURL('image/jpeg', 0.5)
          } catch {
            /* tainted or not ready — leave as null placeholder */
          }
          resolve()
        }
        video.addEventListener('seeked', onSeeked)
        const t = ((i + 0.5) / FRAME_COUNT) * duration
        video.currentTime = Math.min(t, Math.max(0, duration - 0.05))
      })

    const run = async () => {
      await new Promise((res) => {
        if (video.readyState >= 1) res()
        else video.addEventListener('loadedmetadata', res, { once: true })
      })
      for (let i = 0; i < FRAME_COUNT; i++) {
        if (cancelled) return
        await grab(i)
        if (!cancelled) setThumbs([...out])
      }
    }
    run().catch(() => {})

    return () => {
      cancelled = true
      video.removeAttribute('src')
      video.load()
    }
  }, [src, duration])

  return thumbs
}

/**
 * Zoomable, horizontally-scrollable multi-track timeline. Every layer (ruler,
 * V1 filmstrip, A1 wavesurfer waveform, match regions, manual selection, EDL
 * removed-overlays and the playhead) aligns to the same content width
 * `pxPerSec * duration`. Editing is expressed through the `edl` API.
 */
export default function Timeline({
  videoRef,
  src,
  peaks,
  duration,
  clips = [],
  currentTime = 0,
  onClipChange,
  onSeek,
  edl,
}) {
  const waveRef = useRef(null)
  const wsRef = useRef(null)
  const regionsRef = useRef(null)
  const contentRef = useRef(null)

  const clipChangeRef = useRef(onClipChange)
  const seekRef = useRef(onSeek)
  clipChangeRef.current = onClipChange
  seekRef.current = onSeek

  const [selection, setSelection] = useState(null) // { start, end } | null
  const [activeClipIdx, setActiveClipIdx] = useState(null)
  const activeClipRef = useRef(setActiveClipIdx)

  const thumbs = useFilmstrip(src, duration)
  const {
    scrollRef,
    pxPerSec,
    contentWidth,
    viewportW,
    timeToX,
    zoomIn,
    zoomOut,
    fit,
    canZoomIn,
    canZoomOut,
  } = useZoom(duration)

  // Build wavesurfer on the audio lane, sized to the content width.
  useEffect(() => {
    if (!waveRef.current || !videoRef.current || !duration) return
    const regions = RegionsPlugin.create()
    const ws = WaveSurfer.create({
      container: waveRef.current,
      media: videoRef.current,
      height: AUDIO_H - 12,
      waveColor: '#4b5563',
      progressColor: '#6366f1',
      cursorWidth: 0,
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      autoCenter: false, // we own scrolling via the shared container
      hideScrollbar: true,
      fillParent: true, // fill the (content-width) container exactly
      peaks: peaks ? [peaks] : undefined,
      duration,
      plugins: [regions],
    })
    wsRef.current = ws
    regionsRef.current = regions

    regions.on('region-updated', (region) => {
      const idx = Number(region.id.replace('clip-', ''))
      clipChangeRef.current?.(idx, { start: region.start, end: region.end })
    })
    regions.on('region-clicked', (region, e) => {
      e.stopPropagation()
      const idx = Number(region.id.replace('clip-', ''))
      activeClipRef.current?.(idx)
      seekRef.current?.(region.start)
    })

    return () => {
      ws.destroy()
      wsRef.current = null
      regionsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoRef, duration, peaks])

  // Keep wavesurfer's render density in step with the zoom level. Its container
  // width already tracks contentWidth (so its ResizeObserver re-renders), but
  // nudging zoom() makes the bar density update crisply.
  useEffect(() => {
    const ws = wsRef.current
    if (ws && pxPerSec) {
      try {
        ws.zoom(pxPerSec)
      } catch {
        /* not ready yet — the ResizeObserver will still re-render */
      }
    }
  }, [pxPerSec, contentWidth])

  // Sync draggable match regions on the audio lane.
  useEffect(() => {
    const regions = regionsRef.current
    if (!regions) return
    regions.clearRegions()
    clips.forEach((c, i) => {
      regions.addRegion({
        id: `clip-${i}`,
        start: c.start,
        end: c.end,
        color: i === activeClipIdx ? REGION_COLOR_ACTIVE : REGION_COLOR,
        drag: true,
        resize: true,
      })
    })
  }, [clips, activeClipIdx])

  // ── Pointer interactions: click-to-seek + drag-to-select on the top region ──
  const clampTime = (t) => Math.max(0, Math.min(duration || 0, t))
  const timeAt = (clientX) => {
    const rect = contentRef.current?.getBoundingClientRect()
    if (!rect || !pxPerSec) return 0
    return clampTime((clientX - rect.left) / pxPerSec)
  }

  const beginDrag = (mode, e) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const startX = e.clientX
    const startSel = selection
    const anchorT = timeAt(e.clientX)
    let moved = false

    const onMove = (ev) => {
      if (Math.abs(ev.clientX - startX) > 3) moved = true
      const t = timeAt(ev.clientX)
      if (mode === 'create') {
        setSelection({ start: Math.min(anchorT, t), end: Math.max(anchorT, t) })
      } else if (mode === 'move' && startSel) {
        const len = startSel.end - startSel.start
        let s = clampTime(startSel.start + (t - anchorT))
        s = Math.min(s, (duration || 0) - len)
        s = Math.max(0, s)
        setSelection({ start: s, end: s + len })
      } else if (mode === 'l' && startSel) {
        setSelection({ start: Math.min(t, startSel.end), end: startSel.end })
      } else if (mode === 'r' && startSel) {
        setSelection({ start: startSel.start, end: Math.max(t, startSel.start) })
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (mode === 'create' && !moved) {
        setSelection(null)
        onSeek?.(anchorT)
      } else {
        // Drop a selection that ended up thinner than a few pixels.
        setSelection((sel) =>
          sel && (sel.end - sel.start) * pxPerSec < 4 ? null : sel,
        )
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // ── Edit actions (clear the selection after destructive ones) ──────────────
  const activeClip = activeClipIdx != null ? clips[activeClipIdx] : null
  const doTrim = () => {
    if (selection) edl?.trimTo(selection.start, selection.end)
  }
  const doDeleteSel = () => {
    if (selection) {
      edl?.deleteRange(selection.start, selection.end)
      setSelection(null)
    }
  }
  const doSplit = () => edl?.splitAt(currentTime)
  const doDeleteClip = () => {
    if (activeClip) {
      edl?.deleteRange(activeClip.start, activeClip.end)
      setActiveClipIdx(null)
    }
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e) => {
      const el = e.target
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) edl?.redo()
        else edl?.undo()
        return
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        edl?.redo()
        return
      }
      if (e.ctrlKey || e.metaKey) return
      switch (e.key) {
        case '+':
        case '=':
          e.preventDefault()
          zoomIn()
          break
        case '-':
        case '_':
          e.preventDefault()
          zoomOut()
          break
        case 's':
        case 'S':
          e.preventDefault()
          doSplit()
          break
        case 'Delete':
        case 'Backspace':
          if (selection) {
            e.preventDefault()
            doDeleteSel()
          }
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, currentTime, edl, zoomIn, zoomOut])

  const step = rulerStep(pxPerSec || 1)
  const ticks = []
  for (let t = 0; t <= (duration || 0) + 1e-6; t += step) ticks.push(t)

  const width = contentWidth || viewportW || 0
  const removed = edl?.removed ?? []

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50">
      <EditorToolbar
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onFit={fit}
        canZoomIn={canZoomIn}
        canZoomOut={canZoomOut}
        onTrim={doTrim}
        onDeleteSel={doDeleteSel}
        onSplit={doSplit}
        onDeleteClip={doDeleteClip}
        onUndo={() => edl?.undo()}
        onRedo={() => edl?.redo()}
        hasSelection={!!selection}
        hasActiveClip={!!activeClip}
        canUndo={!!edl?.canUndo}
        canRedo={!!edl?.canRedo}
        selection={selection}
        isEdited={!!edl?.isEdited}
        keptDuration={edl?.keptDuration ?? 0}
        duration={duration}
      />

      <div className="flex">
        {/* Track header column (fixed; does not scroll horizontally) */}
        <div
          className="shrink-0 border-r border-zinc-800 bg-zinc-950/40"
          style={{ width: HEADER_W }}
        >
          <div style={{ height: RULER_H }} className="border-b border-zinc-800/70" />
          <div
            style={{ height: VIDEO_H }}
            className="flex flex-col justify-center border-b border-zinc-800/70 px-2"
          >
            <span className="text-[11px] font-semibold text-zinc-300">V1</span>
            <span className="text-[9px] uppercase tracking-wider text-zinc-600">Video</span>
          </div>
          <div style={{ height: AUDIO_H }} className="flex flex-col justify-center px-2">
            <span className="text-[11px] font-semibold text-zinc-300">A1</span>
            <span className="text-[9px] uppercase tracking-wider text-zinc-600">Audio</span>
          </div>
        </div>

        {/* Scrollable viewport */}
        <div ref={scrollRef} className="relative flex-1 overflow-x-auto overflow-y-hidden">
          <div
            ref={contentRef}
            className="relative"
            style={{ width: width || '100%', height: FULL_H }}
          >
            {/* Ruler */}
            <div
              style={{ height: RULER_H }}
              className="relative select-none border-b border-zinc-800/70 bg-zinc-950/30"
            >
              {ticks.map((t) => (
                <div key={t} className="absolute top-0 h-full" style={{ left: timeToX(t) }}>
                  <div className="h-2 w-px bg-zinc-700" />
                  <span className="ml-1 font-mono text-[9px] tabular-nums text-zinc-500">
                    {formatTime(t)}
                  </span>
                </div>
              ))}
            </div>

            {/* V1 — video filmstrip (fixed frames stretched to fill width) */}
            <div
              style={{ height: VIDEO_H }}
              className="relative flex overflow-hidden border-b border-zinc-800/70 bg-black"
            >
              {(thumbs.length ? thumbs : new Array(FRAME_COUNT).fill(null)).map((thumb, i) => (
                <div
                  key={i}
                  className="h-full flex-1 border-r border-black/40 bg-zinc-800"
                  style={
                    thumb
                      ? {
                          backgroundImage: `url(${thumb})`,
                          backgroundSize: 'cover',
                          backgroundPosition: 'center',
                        }
                      : undefined
                  }
                />
              ))}
              {/* Match highlights on the video track */}
              {clips.map((c, i) => (
                <div
                  key={i}
                  className={
                    'pointer-events-none absolute top-0 h-full border-x bg-indigo-500/20 ' +
                    (i === activeClipIdx ? 'border-indigo-300' : 'border-indigo-400/50')
                  }
                  style={{ left: timeToX(c.start), width: timeToX(c.end - c.start) }}
                />
              ))}
            </div>

            {/* A1 — audio waveform (wavesurfer fills this content-width lane) */}
            <div style={{ height: AUDIO_H }} className="relative bg-zinc-900/60 py-1.5">
              <div ref={waveRef} className="h-full w-full" />
            </div>

            {/* EDL removed ranges — dim + hatch over the lanes below the ruler */}
            {removed.map((r, i) => (
              <div
                key={`rm-${i}`}
                className="pointer-events-none absolute z-[6]"
                style={{
                  left: timeToX(r.start),
                  width: timeToX(r.end - r.start),
                  top: RULER_H,
                  height: LANES_H,
                  background:
                    'repeating-linear-gradient(45deg, rgba(9,9,11,0.72) 0, rgba(9,9,11,0.72) 6px, rgba(244,63,94,0.20) 6px, rgba(244,63,94,0.20) 12px)',
                }}
              />
            ))}

            {/* Manual selection band + handles (top region only, to keep the
                waveform interactive underneath) */}
            {selection && (
              <>
                <div
                  className="pointer-events-none absolute z-[15] border-x border-emerald-400 bg-emerald-400/20"
                  style={{
                    left: timeToX(selection.start),
                    width: timeToX(selection.end - selection.start),
                    top: RULER_H,
                    height: LANES_H,
                  }}
                />
                {/* Move strip */}
                <div
                  onPointerDown={(e) => beginDrag('move', e)}
                  className="absolute z-[16] cursor-grab active:cursor-grabbing"
                  style={{
                    left: timeToX(selection.start),
                    width: timeToX(selection.end - selection.start),
                    top: 0,
                    height: TOP_H,
                  }}
                />
                {/* Resize handles */}
                <div
                  onPointerDown={(e) => beginDrag('l', e)}
                  className="absolute z-[17] w-2 -translate-x-1/2 cursor-ew-resize bg-emerald-400"
                  style={{ left: timeToX(selection.start), top: 0, height: TOP_H }}
                />
                <div
                  onPointerDown={(e) => beginDrag('r', e)}
                  className="absolute z-[17] w-2 -translate-x-1/2 cursor-ew-resize bg-emerald-400"
                  style={{ left: timeToX(selection.end), top: 0, height: TOP_H }}
                />
              </>
            )}

            {/* Seek + create-selection interaction layer (ruler + video only) */}
            <div
              onPointerDown={(e) => beginDrag('create', e)}
              className="absolute left-0 top-0 z-[10] cursor-crosshair"
              style={{ width: width || '100%', height: TOP_H }}
            />

            {/* Shared playhead across all lanes */}
            <div
              className="pointer-events-none absolute top-0 z-[30]"
              style={{ left: timeToX(currentTime), height: FULL_H }}
            >
              <div className="h-full w-px bg-red-500" />
              <div className="-ml-1.5 -mt-px h-0 w-0 border-x-[6px] border-t-[7px] border-x-transparent border-t-red-500" />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
