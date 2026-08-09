import { useState } from 'react'
import { USE_FIXTURES } from '../api.js'

const EXAMPLES = [
  'Trim the part where he talks about India and dub it in Hindi',
  'Remove background noise from this audio',
  'Dub the video to Hindi and send it back',
]

/**
 * The conversational surface: a text instruction + example chips + Run.
 * This is what turns a sentence into an edit plan on the backend.
 */
export default function InstructionBar({ onRun, disabled, running }) {
  const [text, setText] = useState('')

  const submit = (value) => {
    const instruction = (value ?? text).trim()
    if (!instruction || disabled || running) return
    onRun?.(instruction)
  }

  return (
    <div className="border-b border-zinc-800 bg-zinc-900/40">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex items-center gap-2 pr-1 text-indigo-400">
          <img src="/clapper.svg" alt="" className="h-6 w-6" />
          <span className="text-sm font-semibold tracking-tight text-zinc-100">
            ClipCraft
          </span>
          {USE_FIXTURES && (
            <span
              title="Running on sample data. Link download + real transcription require the live backend."
              className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-300"
            >
              Demo mode
            </span>
          )}
        </div>

        <form
          className="flex flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div className="relative flex-1">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={disabled}
              placeholder='Try: "trim where he talks about India, in Hindi"'
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950/60 px-3.5 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 outline-none transition focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
            />
          </div>
          <button
            type="submit"
            disabled={disabled || running || !text.trim()}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running ? (
              <>
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Running
              </>
            ) : (
              <>
                Run
                <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                  <path d="M3 2.5v9a.8.8 0 0 0 1.2.7l7.4-4.5a.8.8 0 0 0 0-1.4L4.2 1.8A.8.8 0 0 0 3 2.5z" />
                </svg>
              </>
            )}
          </button>
        </form>
      </div>

      <div className="flex flex-wrap gap-2 px-4 pb-3">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            type="button"
            disabled={disabled || running}
            onClick={() => {
              setText(ex)
              submit(ex)
            }}
            className="rounded-full border border-zinc-700/70 bg-zinc-800/40 px-3 py-1 text-xs text-zinc-400 transition hover:border-indigo-500/50 hover:text-zinc-200 disabled:opacity-40"
          >
            {ex}
          </button>
        ))}
      </div>
    </div>
  )
}
