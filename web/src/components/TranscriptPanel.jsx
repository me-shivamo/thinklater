import { useEffect, useRef } from 'react'
import { activeSegmentIndex, formatTime } from '../utils/format.js'

/**
 * Timestamped "frame" transcript. Clicking a line seeks the player; the active
 * line highlights and auto-scrolls into view. Auto-scroll is suppressed for a
 * moment after a manual scroll so it never fights the user.
 */
export default function TranscriptPanel({ segments = [], currentTime, onSeek }) {
  const listRef = useRef(null)
  const activeRef = useRef(null)
  const suppressUntil = useRef(0)

  const active = activeSegmentIndex(segments, currentTime)

  useEffect(() => {
    if (active < 0 || !activeRef.current) return
    if (Date.now() < suppressUntil.current) return
    activeRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [active])

  const onManualScroll = () => {
    suppressUntil.current = Date.now() + 1200
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
          Transcript
        </span>
        <span className="text-[11px] text-zinc-600">
          {segments.length} segments
        </span>
      </div>

      <div
        ref={listRef}
        onWheel={onManualScroll}
        onTouchMove={onManualScroll}
        className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5"
      >
        {segments.length === 0 && (
          <p className="px-2 py-6 text-center text-sm text-zinc-600">
            Transcript will appear here once the media is transcribed.
          </p>
        )}

        {segments.map((seg, i) => {
          const isActive = i === active
          return (
            <button
              key={seg.id}
              ref={isActive ? activeRef : null}
              type="button"
              onClick={() => onSeek?.(seg.start)}
              className={
                'group flex w-full gap-2.5 rounded-lg px-2 py-1.5 text-left transition ' +
                (isActive
                  ? 'bg-indigo-500/15 ring-1 ring-inset ring-indigo-500/30'
                  : 'hover:bg-zinc-800/60')
              }
            >
              <span
                className={
                  'mt-0.5 shrink-0 font-mono text-[11px] tabular-nums ' +
                  (isActive
                    ? 'text-indigo-300'
                    : 'text-zinc-500 group-hover:text-zinc-400')
                }
              >
                {formatTime(seg.start)}
              </span>
              <span
                className={
                  'text-sm leading-snug ' +
                  (isActive ? 'text-zinc-100' : 'text-zinc-400')
                }
              >
                {seg.text}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
