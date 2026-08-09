import { useMemo, useState } from 'react'

// Pretty labels for known stages; unknown stages fall back to a title-cased
// version so new engine ops (denoise, resize, music, thumbnail, …) show up
// automatically with zero frontend changes.
const STAGE_LABELS = {
  transcribe: 'Transcribe',
  plan: 'Plan',
  find: 'Find',
  trim: 'Trim',
  denoise: 'Denoise',
  dub: 'Dub',
  music: 'Add music',
  resize: 'Resize',
  thumbnail: 'Thumbnail',
  export: 'Export',
  result: 'Finish',
}

const EXAMPLES = [
  'Trim the part where he talks about India and dub it in Hindi',
  'Remove background noise from this audio',
  'Dub the video to Hindi and send it back',
]

const titleCase = (s) =>
  s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/[_-]/g, ' ') : s

function StatusIcon({ status }) {
  if (status === 'done')
    return (
      <span className="grid h-5 w-5 place-items-center rounded-full bg-emerald-500/20 text-emerald-400">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path
            d="M2.5 6.2l2.2 2.2 4.8-5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    )
  if (status === 'running')
    return (
      <span className="grid h-5 w-5 place-items-center">
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-indigo-400/30 border-t-indigo-400" />
      </span>
    )
  if (status === 'error')
    return (
      <span className="grid h-5 w-5 place-items-center rounded-full bg-red-500/20 text-red-400 text-xs">
        !
      </span>
    )
  return (
    <span className="grid h-5 w-5 place-items-center">
      <span className="h-2 w-2 rounded-full bg-zinc-600" />
    </span>
  )
}

/**
 * The single AI-agent surface: a natural-language instruction input plus a live
 * checklist of the agent's progress. This is the one conversational entry point
 * — typing here turns a sentence into an edit plan (find → trim → dub → export)
 * on the backend. The checklist is data-driven from the ProgressEvent stream.
 */
export default function AgentPanel({
  events = [],
  reasoning,
  note,
  running,
  onRun,
  disabled,
}) {
  const [showReasoning, setShowReasoning] = useState(false)
  const [text, setText] = useState('')

  const submit = (value) => {
    const instruction = (value ?? text).trim()
    if (!instruction || disabled || running) return
    onRun?.(instruction)
  }

  // Collapse the event stream into one row per stage, in first-seen order.
  const steps = useMemo(() => {
    const order = []
    const byStage = new Map()
    for (const evt of events) {
      if (!byStage.has(evt.stage)) {
        order.push(evt.stage)
        byStage.set(evt.stage, { ...evt })
      } else {
        const cur = byStage.get(evt.stage)
        // 'done' wins; otherwise take the latest message/status.
        byStage.set(evt.stage, {
          ...evt,
          status: cur.status === 'done' ? 'done' : evt.status,
        })
      }
    }
    return order
      .filter((s) => s !== 'result')
      .map((s) => byStage.get(s))
  }, [events])

  const pct = events.length ? events[events.length - 1].pct ?? 0 : 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-2 border-b border-zinc-800 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md bg-indigo-500/15 text-indigo-400">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1l1.3 3.2L12.5 5l-2.4 2.1.7 3.4L8 8.9 5.2 10.5l.7-3.4L3.5 5l3.2-.8L8 1zM3 11l.6 1.6L5 13l-1.4.6L3 15l-.6-1.4L1 13l1.4-.4L3 11zM13 10l.5 1.3 1.5.5-1.5.5-.5 1.3-.5-1.3-1.5-.5 1.5-.5.5-1.3z" />
            </svg>
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-zinc-100">
                AI Agent
              </span>
              {running && (
                <span className="text-[11px] text-indigo-300/80">{pct}%</span>
              )}
            </div>
            <p className="text-[11px] leading-tight text-zinc-500">
              Natural language edits — find a spoken part, trim, dub, denoise.
              {' '}Needs the backend.
            </p>
          </div>
        </div>
      </div>

      <div className="border-b border-zinc-800 px-3 py-2.5">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={disabled || running}
            placeholder='Ask: "trim where he talks about India, in Hindi"'
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none transition focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={disabled || running || !text.trim()}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-indigo-500 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running ? (
              <>
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Running
              </>
            ) : (
              'Ask'
            )}
          </button>
        </form>

        <div className="mt-2 flex flex-wrap gap-1.5">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              disabled={disabled || running}
              onClick={() => {
                setText(ex)
                submit(ex)
              }}
              className="rounded-full border border-zinc-700/70 bg-zinc-800/40 px-2.5 py-0.5 text-[11px] text-zinc-400 transition hover:border-indigo-500/50 hover:text-zinc-200 disabled:opacity-40"
            >
              {ex}
            </button>
          ))}
        </div>

        {disabled && (
          <p className="mt-2 text-[11px] text-zinc-600">
            Load media with a transcript to use the agent.
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {steps.length === 0 && (
          <p className="py-6 text-center text-sm text-zinc-600">
            Type an instruction and the agent's plan will tick off here.
          </p>
        )}

        <ul className="space-y-2.5">
          {steps.map((step) => (
            <li key={step.stage} className="flex items-start gap-2.5">
              <StatusIcon status={step.status} />
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-200">
                  {STAGE_LABELS[step.stage] || titleCase(step.stage)}
                </p>
                {step.message && (
                  <p className="truncate text-xs text-zinc-500">
                    {step.message}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>

        {note && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-200/90">
            <span className="mt-px shrink-0">ⓘ</span>
            <span>{note}</span>
          </div>
        )}

        {reasoning && (
          <div className="mt-4 border-t border-zinc-800 pt-3">
            <button
              type="button"
              onClick={() => setShowReasoning((v) => !v)}
              className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
            >
              <span
                className={
                  'transition-transform ' + (showReasoning ? 'rotate-90' : '')
                }
              >
                ▸
              </span>
              Why this plan
            </button>
            {showReasoning && (
              <p className="mt-2 text-xs leading-relaxed text-zinc-400">
                {reasoning}
              </p>
            )}
          </div>
        )}
      </div>

      {running && (
        <div className="border-t border-zinc-800 px-3 py-2">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-indigo-500 transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}
    </div>
  )
}
