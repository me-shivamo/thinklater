import { useState } from 'react'
import { formatTime } from '../utils/format.js'

const EXAMPLES = ['zoom in at 0:03', 'zoom out 0:05 - 0:08', 'cut 0:10 - 0:14']

/**
 * Timestamp + instruction surface. The user types something like
 * "zoom in at 1:20" or "cut 0:30 - 0:45" and it is applied instantly:
 * cuts feed the EDL, zooms become live preview effects on the player.
 */
export default function CommandBar({ onCommand, disabled, effects = [], onRemoveEffect }) {
  const [text, setText] = useState('')
  const [error, setError] = useState(null)

  const submit = (value) => {
    const cmd = (value ?? text).trim()
    if (!cmd || disabled) return
    const err = onCommand?.(cmd)
    if (err) {
      setError(err)
    } else {
      setError(null)
      setText('')
    }
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
      <div className="mb-2 flex items-center gap-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-sky-500/15 text-sky-400">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <circle cx="8" cy="8" r="6" />
            <path d="M8 5v3l2 1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <div className="min-w-0">
          <span className="text-sm font-semibold text-zinc-100">
            Manual edit
          </span>
          <p className="text-[11px] leading-tight text-zinc-500">
            Precise edits by timestamp — zoom or cut at exact times. Works offline.
          </p>
        </div>
      </div>

      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            if (error) setError(null)
          }}
          disabled={disabled}
          placeholder='e.g. "zoom in at 1:20" or "cut 0:30 - 0:45"'
          className="w-full rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none transition focus:border-sky-500 focus:ring-1 focus:ring-sky-500 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={disabled || !text.trim()}
          className="shrink-0 rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Apply
        </button>
      </form>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            disabled={disabled}
            onClick={() => {
              setText(ex)
              submit(ex)
            }}
            className="rounded-full border border-zinc-700/70 bg-zinc-800/40 px-2.5 py-0.5 text-[11px] text-zinc-400 transition hover:border-sky-500/50 hover:text-zinc-200 disabled:opacity-40"
          >
            {ex}
          </button>
        ))}
      </div>

      {error && (
        <p className="mt-2 text-xs text-rose-400">{error}</p>
      )}

      {effects.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-zinc-800 pt-2.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            Zooms
          </span>
          {effects.map((fx) => (
            <span
              key={fx.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/40 bg-sky-500/10 px-2.5 py-0.5 text-[11px] text-sky-200"
            >
              {fx.type === 'in' ? 'In' : 'Out'} {fx.scale.toFixed(1)}x ·{' '}
              {formatTime(fx.start)}–{formatTime(fx.end)}
              <button
                type="button"
                onClick={() => onRemoveEffect?.(fx.id)}
                className="grid h-3.5 w-3.5 place-items-center rounded-full text-sky-300 transition hover:bg-sky-500/30 hover:text-white"
                aria-label="Remove zoom"
              >
                <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor">
                  <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
