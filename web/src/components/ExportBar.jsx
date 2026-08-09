/**
 * Export controls.
 *
 * Two modes:
 *  - AI result: download the agent's render + the SRT the dub returns for free.
 *  - Manual edit (EDL): when the user has trimmed/deleted on the timeline, the
 *    primary action first *renders* the edit (backend ffmpeg cut+concat) and
 *    then turns into a download link for the trimmed file.
 *
 * In fixtures/demo mode the render is simulated and the buttons point at the
 * bundled sample so everything still does something.
 */
function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <path
        d="M7 1.5v7m0 0L4.3 5.8M7 8.5l2.7-2.7M2.5 10.5v1a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  )
}

export default function ExportBar({
  outputUrl,
  srtUrl,
  ready,
  edited,
  editing,
  editReady,
  editUrl,
  onRenderEdit,
}) {
  const primary =
    'flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium transition'

  // Manual-edit export flow takes precedence when the user has edits.
  if (edited) {
    if (editReady && editUrl) {
      return (
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[11px] text-amber-300">Trimmed edit ready</span>
          <a href={editUrl} download className={primary + ' bg-indigo-500 text-white hover:bg-indigo-400'}>
            <DownloadIcon />
            Export edit
          </a>
        </div>
      )
    }
    return (
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onRenderEdit}
          disabled={editing}
          className={
            primary +
            (editing
              ? ' cursor-wait bg-zinc-800 text-zinc-400'
              : ' bg-emerald-500 text-white hover:bg-emerald-400')
          }
        >
          {editing ? (
            <>
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              Rendering…
            </>
          ) : (
            <>
              <DownloadIcon />
              Render edit
            </>
          )}
        </button>
      </div>
    )
  }

  // Default: AI result export.
  return (
    <div className="flex shrink-0 items-center gap-2">
      {srtUrl && (
        <a
          href={ready ? srtUrl : undefined}
          download
          className={
            'rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-medium transition ' +
            (ready
              ? 'text-zinc-300 hover:border-zinc-500 hover:text-zinc-100'
              : 'pointer-events-none text-zinc-600 opacity-50')
          }
        >
          SRT
        </a>
      )}
      <a
        href={ready ? outputUrl : undefined}
        download
        className={
          primary +
          (ready
            ? ' bg-indigo-500 text-white hover:bg-indigo-400'
            : ' pointer-events-none bg-zinc-800 text-zinc-600 opacity-60')
        }
      >
        <DownloadIcon />
        Export
      </a>
    </div>
  )
}
