import { formatTime } from '../utils/format.js'

/**
 * Located matches as compact cards: time range, reason, confidence bar, and a
 * Preview that jumps the player to the clip. This is where the agent justifies
 * its choices — persuasive on stage.
 */
export default function ClipList({ clips = [], points = [], onPreview }) {
  if (clips.length === 0 && points.length === 0) {
    return (
      <span className="text-xs text-zinc-600">
        No matches yet — run an instruction.
      </span>
    )
  }

  return (
    <div className="flex items-center gap-2 overflow-x-auto">
      <span className="shrink-0 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
        {clips.length ? 'Matches' : 'Inserts'}
      </span>

      {/* Where the agent spliced in speech that was never in the source. */}
      {points.map((p, i) => (
        <button
          key={`p${i}`}
          type="button"
          title={p.reason}
          onClick={() => onPreview?.({ start: p.time, end: p.time })}
          className="group flex shrink-0 items-center gap-2 rounded-lg border border-emerald-600/50 bg-emerald-500/10 px-2.5 py-1.5 text-left transition hover:border-emerald-400/70"
        >
          <span className="text-emerald-300" aria-hidden="true">
            ➕
          </span>
          <span className="font-mono text-[11px] tabular-nums text-emerald-300">
            {formatTime(p.time)}
          </span>
          <span className="max-w-[180px] truncate text-xs text-zinc-400 group-hover:text-zinc-200">
            {p.anchor ? `after “${p.anchor}”` : p.reason}
          </span>
        </button>
      ))}
      {clips.map((c, i) => {
        const pct = Math.round((c.confidence ?? 0) * 100)
        return (
          <button
            key={i}
            type="button"
            title={c.reason}
            onClick={() => onPreview?.(c)}
            className="group flex shrink-0 items-center gap-2 rounded-lg border border-zinc-700/70 bg-zinc-800/40 px-2.5 py-1.5 text-left transition hover:border-indigo-500/50 hover:bg-zinc-800"
          >
            <span className="font-mono text-[11px] tabular-nums text-indigo-300">
              {formatTime(c.start)}–{formatTime(c.end)}
            </span>
            <span className="max-w-[180px] truncate text-xs text-zinc-400 group-hover:text-zinc-200">
              {c.reason}
            </span>
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-8 overflow-hidden rounded-full bg-zinc-700">
                <span
                  className="block h-full rounded-full bg-emerald-400"
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="text-[10px] tabular-nums text-zinc-500">
                {pct}%
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
