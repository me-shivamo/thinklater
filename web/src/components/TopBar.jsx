import { USE_FIXTURES } from '../api.js'

/**
 * Slim application header: branding and the demo-mode badge. The natural-language
 * agent input now lives in the AgentPanel so there is a single place to talk to
 * the agent, right above the plan it drives.
 */
export default function TopBar() {
  return (
    <div className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-900/40 px-4 py-3">
      <div className="flex items-center gap-2 text-indigo-400">
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
      <span className="hidden text-xs text-zinc-500 sm:block">
        Web video editor
      </span>
    </div>
  )
}
