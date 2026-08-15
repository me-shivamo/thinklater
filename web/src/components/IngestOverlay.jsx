import { useRef, useState } from 'react'
import { USE_FIXTURES } from '../api.js'

/**
 * Landing surface: upload a file or paste a URL to ingest. In fixture mode a
 * one-click "Load sample" gets straight to the editor.
 */
export default function IngestOverlay({ onIngest, busy, error }) {
  const [url, setUrl] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef(null)

  const pickFile = (file) => file && onIngest({ file })

  // Live mode: upload the bundled sample as a real file so the backend gets a
  // genuine media_id and the ffmpeg render/export path works end-to-end.
  const loadSample = async () => {
    try {
      const blob = await (await fetch('/sample.mp4')).blob()
      const file = new File([blob], 'sample.mp4', { type: 'video/mp4' })
      onIngest({ file })
    } catch {
      onIngest({}) // fall back to the fixtures path if the asset is missing
    }
  }

  return (
    <div className="grid h-full place-items-center p-6">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <img src="/clapper.svg" alt="" className="mx-auto mb-3 h-12 w-12" />
          <h1 className="text-xl font-semibold tracking-tight text-zinc-100">
            ClipCraft
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Edit video by typing a sentence.
          </p>
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            pickFile(e.dataTransfer.files?.[0])
          }}
          className={
            'rounded-xl border-2 border-dashed p-8 text-center transition ' +
            (dragOver
              ? 'border-indigo-500 bg-indigo-500/5'
              : 'border-zinc-700 bg-zinc-900/40')
          }
        >
          <p className="text-sm text-zinc-400">
            Drag a video here, or{' '}
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="text-indigo-400 hover:text-indigo-300"
            >
              browse
            </button>
          </p>
          <input
            ref={fileRef}
            type="file"
            accept="video/*,audio/*"
            className="hidden"
            onChange={(e) => pickFile(e.target.files?.[0])}
          />
        </div>

        <div className="my-4 flex items-center gap-3 text-xs text-zinc-600">
          <span className="h-px flex-1 bg-zinc-800" />
          or paste a link
          <span className="h-px flex-1 bg-zinc-800" />
        </div>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (url.trim()) onIngest({ url: url.trim() })
          }}
        >
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://… or a YouTube link"
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          />
          <button
            type="submit"
            disabled={busy || !url.trim()}
            className="rounded-lg bg-indigo-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-400 disabled:opacity-40"
          >
            Load
          </button>
        </form>

        <button
          type="button"
          onClick={USE_FIXTURES ? () => onIngest({}) : loadSample}
          disabled={busy}
          className="mt-4 w-full rounded-lg border border-zinc-700 py-2.5 text-sm text-zinc-300 transition hover:border-indigo-500/50 hover:text-zinc-100 disabled:opacity-40"
        >
          {busy ? 'Loading…' : USE_FIXTURES ? 'Load sample (demo)' : 'Load sample'}
        </button>

        {error && (
          <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
