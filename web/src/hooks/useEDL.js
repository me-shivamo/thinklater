import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fullRange,
  intersectRange,
  rangesEqual,
  removedRanges,
  splitAt,
  subtractRange,
  totalKept,
} from '../utils/edl.js'

/**
 * Client-side Edit Decision List with an undo/redo history.
 *
 * The EDL is an ordered list of KEPT ranges over the ORIGINAL timeline. Every
 * edit action produces a fresh range list which is pushed onto a history stack
 * so undo/redo is just an index move. When `duration` changes (new media) the
 * EDL resets to the full range.
 */
export function useEDL(duration) {
  // history: { stack: Array<Range[]>, index: number }
  const [history, setHistory] = useState(() => ({
    stack: [fullRange(duration)],
    index: 0,
  }))

  // Reset whenever the media duration changes (i.e. a different source loaded).
  const lastDuration = useRef(duration)
  useEffect(() => {
    if (lastDuration.current !== duration) {
      lastDuration.current = duration
      setHistory({ stack: [fullRange(duration)], index: 0 })
    }
  }, [duration])

  const keepRanges = history.stack[history.index]

  const commit = useCallback((next) => {
    setHistory((h) => {
      const current = h.stack[h.index]
      if (rangesEqual(current, next)) return h // nothing changed — skip
      const stack = h.stack.slice(0, h.index + 1)
      stack.push(next)
      return { stack, index: stack.length - 1 }
    })
  }, [])

  const trimTo = useCallback(
    (start, end) => commit(intersectRange(keepRanges, start, end)),
    [commit, keepRanges],
  )
  const deleteRange = useCallback(
    (start, end) => commit(subtractRange(keepRanges, start, end)),
    [commit, keepRanges],
  )
  const splitAtTime = useCallback(
    (t) => commit(splitAt(keepRanges, t)),
    [commit, keepRanges],
  )
  const reset = useCallback(
    () => setHistory({ stack: [fullRange(duration)], index: 0 }),
    [duration],
  )

  const undo = useCallback(
    () => setHistory((h) => (h.index > 0 ? { ...h, index: h.index - 1 } : h)),
    [],
  )
  const redo = useCallback(
    () =>
      setHistory((h) =>
        h.index < h.stack.length - 1 ? { ...h, index: h.index + 1 } : h,
      ),
    [],
  )

  const canUndo = history.index > 0
  const canRedo = history.index < history.stack.length - 1
  const isEdited = useMemo(
    () => !rangesEqual(keepRanges, fullRange(duration)),
    [keepRanges, duration],
  )
  const removed = useMemo(
    () => removedRanges(keepRanges, duration),
    [keepRanges, duration],
  )
  const keptDuration = useMemo(() => totalKept(keepRanges), [keepRanges])

  return {
    keepRanges,
    removed,
    keptDuration,
    isEdited,
    canUndo,
    canRedo,
    trimTo,
    deleteRange,
    splitAt: splitAtTime,
    reset,
    undo,
    redo,
  }
}
