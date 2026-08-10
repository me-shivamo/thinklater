import { useEffect, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'
import { formatTime } from '../utils/format.js'

const REGION_COLOR = 'rgba(99, 102, 241, 0.26)'
const REGION_COLOR_ACTIVE = 'rgba(129, 140, 248, 0.40)'
const HEADER_W = 72 // px — track label column (V1 / A1)
const RULER_H = 24
const VIDEO_H = 64
const AUDIO_H = 96
const FRAME_COUNT = 28

/** Pick a "nice" ruler step so we get ~8-12 labels across the duration. */
function niceStep(duration) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800]
  const target = duration / 10
  return steps.find((s) => s >= target) ?? steps[steps.length - 1]
}

/**
 * Extract a filmstrip of thumbnails from the video by seeking an offscreen
 * <video> and drawing frames to a canvas. Progressive: fills in as it goes.
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
 * DaVinci-Resolve-style multi-track timeline: a V1 video track (thumbnail
 * filmstrip) over an A1 audio track (wavesurfer waveform bound to the same
 * <video>), with a timecode ruler, a shared playhead, and draggable match
 * regions.
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
}) {
  const waveRef = useRef(null)
  const wsRef = useRef(null)
  const regionsRef = useRef(null)
  const laneRef = useRef(null)
  const clipChangeRef = useRef(onClipChange)
  const seekRef = useRef(onSeek)
  clipChangeRef.current = onClipChange
  seekRef.current = onSeek

  const thumbs = useFilmstrip(src, duration)

  // Build wavesurfer on the audio lane.
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
      seekRef.current?.(region.start)
    })

    return () => {
      ws.destroy()
      wsRef.current = null
      regionsRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoRef, duration, peaks])

  // Sync draggable regions on the audio lane.
  useEffect(() => {
    const regions = regionsRef.current
    if (!regions) return
    regions.clearRegions()
    clips.forEach((c, i) => {
      regions.addRegion({
        id: `clip-${i}`,
        start: c.start,
        end: c.end,
        color: i === 0 ? REGION_COLOR_ACTIVE : REGION_COLOR,
        drag: true,
        resize: true,
      })
    })
  }, [clips])

  const seekFromEvent = (e) => {
    const lane = laneRef.current
    if (!lane || !duration) return
    const rect = lane.getBoundingClientRect()
    const x = e.clientX - rect.left
    onSeek?.(Math.max(0, Math.min(1, x / rect.width)) * duration)
  }

  const pct = (t) => (duration ? (t / duration) * 100 : 0)
  const step = niceStep(duration || 1)
  const ticks = []
  for (let t = 0; t <= (duration || 0); t += step) ticks.push(t)

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/50">
      <div className="flex">
        {/* Track header column (V1 / A1), Resolve-style */}
        <div className="shrink-0 border-r border-zinc-800 bg-zinc-950/40" style={{ width: HEADER_W }}>
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

        {/* Tracks lane */}
        <div ref={laneRef} className="relative flex-1">
          {/* Ruler */}
          <div
            style={{ height: RULER_H }}
            onClick={seekFromEvent}
            className="relative cursor-pointer select-none border-b border-zinc-800/70 bg-zinc-950/30"
          >
            {ticks.map((t) => (
              <div
                key={t}
                className="absolute top-0 h-full"
                style={{ left: `${pct(t)}%` }}
              >
                <div className="h-2 w-px bg-zinc-700" />
                <span className="ml-1 font-mono text-[9px] tabular-nums text-zinc-500">
                  {formatTime(t)}
                </span>
              </div>
            ))}
          </div>

          {/* V1 — video filmstrip */}
          <div
            style={{ height: VIDEO_H }}
            onClick={seekFromEvent}
            className="relative flex cursor-pointer overflow-hidden border-b border-zinc-800/70 bg-black"
          >
            {(thumbs.length ? thumbs : new Array(FRAME_COUNT).fill(null)).map(
              (thumb, i) => (
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
              ),
            )}
            {/* Match highlights on the video track */}
            {clips.map((c, i) => (
              <div
                key={i}
                className="pointer-events-none absolute top-0 h-full border-x border-indigo-400/50 bg-indigo-500/20"
                style={{ left: `${pct(c.start)}%`, width: `${pct(c.end - c.start)}%` }}
              />
            ))}
          </div>

          {/* A1 — audio waveform */}
          <div style={{ height: AUDIO_H }} className="relative bg-zinc-900/60 px-0 py-1.5">
            <div ref={waveRef} className="h-full w-full" />
          </div>

          {/* Shared playhead across all lanes */}
          <div
            className="pointer-events-none absolute top-0 z-10"
            style={{ left: `${pct(currentTime)}%`, height: RULER_H + VIDEO_H + AUDIO_H }}
          >
            <div className="h-full w-px bg-red-500" />
            <div className="-ml-1.5 -mt-px h-0 w-0 border-x-[6px] border-t-[7px] border-x-transparent border-t-red-500" />
          </div>
        </div>
      </div>
    </div>
  )
}
