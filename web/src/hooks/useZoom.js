import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

const ZOOM_FACTOR = 1.4
const MAX_PX_PER_SEC = 600

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/**
 * Pixels-per-second zoom model for the timeline.
 *
 * Owns the horizontally-scrollable viewport (`scrollRef`) and derives a
 * `contentWidth = pxPerSec * duration` that every layer sizes to. "Fit" makes
 * the content exactly fill the viewport; zooming in/out and Ctrl/Cmd+wheel
 * scale `pxPerSec` around a focal point and adjust `scrollLeft` so the focused
 * time stays put.
 */
export function useZoom(duration) {
  const scrollRef = useRef(null)
  const [viewportW, setViewportW] = useState(0)
  const [pxPerSec, setPxPerSec] = useState(0)
  const userZoomed = useRef(false)
  // Pending scrollLeft to apply after a width change (focal-point zoom).
  const pendingScroll = useRef(null)

  // Track the viewport width.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width ?? el.clientWidth
      setViewportW(w)
    })
    ro.observe(el)
    setViewportW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const fitPxPerSec = duration > 0 && viewportW > 0 ? viewportW / duration : 0

  // Initialize / keep fitted until the user explicitly zooms.
  useEffect(() => {
    if (!fitPxPerSec) return
    if (!userZoomed.current || pxPerSec === 0) {
      setPxPerSec(fitPxPerSec)
    }
  }, [fitPxPerSec]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset zoom state when the media changes.
  useEffect(() => {
    userZoomed.current = false
    setPxPerSec(0)
  }, [duration])

  // Apply any pending focal scroll after the new width lands in the DOM.
  useLayoutEffect(() => {
    if (pendingScroll.current != null && scrollRef.current) {
      scrollRef.current.scrollLeft = pendingScroll.current
      pendingScroll.current = null
    }
  }, [pxPerSec])

  const effPxPerSec = pxPerSec || fitPxPerSec
  const contentWidth = effPxPerSec * (duration || 0)

  const timeToX = useCallback((t) => t * effPxPerSec, [effPxPerSec])
  const xToTime = useCallback(
    (x) => (effPxPerSec ? x / effPxPerSec : 0),
    [effPxPerSec],
  )

  const minPxPerSec = fitPxPerSec || 1

  // Zoom around a content-space focal x (px from content origin).
  const zoomAround = useCallback(
    (factor, focalContentX) => {
      const el = scrollRef.current
      const base = pxPerSec || fitPxPerSec
      if (!base || !el) return
      const next = clamp(base * factor, minPxPerSec, MAX_PX_PER_SEC)
      if (next === base) return
      userZoomed.current = true
      const timeAtFocal = focalContentX / base
      const viewportOffset = focalContentX - el.scrollLeft
      pendingScroll.current = Math.max(0, timeAtFocal * next - viewportOffset)
      setPxPerSec(next)
    },
    [pxPerSec, fitPxPerSec, minPxPerSec],
  )

  const zoomIn = useCallback(() => {
    const el = scrollRef.current
    const focal = el ? el.scrollLeft + el.clientWidth / 2 : 0
    zoomAround(ZOOM_FACTOR, focal)
  }, [zoomAround])

  const zoomOut = useCallback(() => {
    const el = scrollRef.current
    const focal = el ? el.scrollLeft + el.clientWidth / 2 : 0
    zoomAround(1 / ZOOM_FACTOR, focal)
  }, [zoomAround])

  const fit = useCallback(() => {
    userZoomed.current = false
    pendingScroll.current = 0
    setPxPerSec(fitPxPerSec)
  }, [fitPxPerSec])

  // React registers `wheel` as a passive listener, so preventDefault() from an
  // onWheel prop is ignored. Attach a native non-passive listener instead, and
  // route it through a ref so the handler always sees the latest zoom state.
  const wheelHandler = useRef(() => {})
  wheelHandler.current = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    const el = scrollRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const focal = e.clientX - rect.left + el.scrollLeft
    zoomAround(e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR, focal)
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const handler = (e) => wheelHandler.current(e)
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  const canZoomIn = effPxPerSec < MAX_PX_PER_SEC - 0.5
  const canZoomOut = effPxPerSec > minPxPerSec + 0.5

  return {
    scrollRef,
    pxPerSec: effPxPerSec,
    contentWidth,
    viewportW,
    timeToX,
    xToTime,
    zoomIn,
    zoomOut,
    fit,
    canZoomIn,
    canZoomOut,
  }
}
