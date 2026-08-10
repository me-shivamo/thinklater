/**
 * Download the final render and the SRT the dub job returns for free.
 * URLs come straight from the backend result; in fixture mode they point at the
 * sample so the buttons still do something.
 */
export default function ExportBar({ outputUrl, srtUrl, ready }) {
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
          'flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-sm font-medium transition ' +
          (ready
            ? 'bg-indigo-500 text-white hover:bg-indigo-400'
            : 'pointer-events-none bg-zinc-800 text-zinc-600 opacity-60')
        }
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
          <path d="M7 1.5v7m0 0L4.3 5.8M7 8.5l2.7-2.7M2.5 10.5v1a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
        Export
      </a>
    </div>
  )
}
