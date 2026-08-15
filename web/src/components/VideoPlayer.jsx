import { useEffect, useState } from 'react'
import { formatTime } from '../utils/format.js'

/**
 * Owns the single <video> element. The same element is handed to the Timeline
 * (wavesurfer `media`) so waveform scrubbing and playback stay in sync with no
 * manual currentTime plumbing. currentTime/duration/playing are lifted to App.
 */
export default function VideoPlayer({
  videoRef,
  src,
  currentTime,
  duration,
  playing,
  onTogglePlay,
  preview = 'source',
  onPreviewChange,
  hasResult = false,
  zoomScale = 1,
}) {
  const [failed, setFailed] = useState(false)
  const zoomed = zoomScale > 1.001

  useEffect(() => {
    setFailed(false)
  }, [src])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative flex-1 min-h-0 overflow-hidden rounded-xl border border-zinc-800 bg-black">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={videoRef}
          src={src || undefined}
          className="h-full w-full object-contain"
          style={{
            transform: `scale(${zoomScale})`,
            transformOrigin: 'center center',
            transition: 'transform 120ms linear',
          }}
          onError={() => src && setFailed(true)}
          controls
          playsInline
        />

        {zoomed && (
          <div className="pointer-events-none absolute right-3 top-3 rounded-full border border-indigo-400/40 bg-indigo-500/20 px-2.5 py-1 text-xs font-medium text-indigo-100 backdrop-blur-sm">
            {zoomScale.toFixed(2)}x
          </div>
        )}

        {failed && (
          <div className="absolute inset-0 grid place-items-center bg-zinc-950/80 p-6 text-center">
            <div className="max-w-sm">
              <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-zinc-800 text-2xl">
                🎬
              </div>
              <p className="text-sm font-medium text-zinc-200">
                {preview === 'result'
                  ? "This render won't play in the browser"
                  : "This media won't play in the browser"}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                {preview === 'result'
                  ? 'The file is fine — the codec just is not one this browser decodes. Use Export to download it.'
                  : 'The transcript, waveform, and agent all still work. Try re-ingesting, or use a different source file.'}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Custom transport — waveform handles scrubbing, this is play/pause + time */}
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={onTogglePlay}
          className="grid h-10 w-10 place-items-center rounded-full bg-indigo-500 text-white transition hover:bg-indigo-400 active:scale-95"
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <rect x="3" y="2" width="4" height="12" rx="1" />
              <rect x="9" y="2" width="4" height="12" rx="1" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 2.5v11a1 1 0 0 0 1.5.87l9-5.5a1 1 0 0 0 0-1.74l-9-5.5A1 1 0 0 0 4 2.5z" />
            </svg>
          )}
        </button>
        <div className="font-mono text-sm tabular-nums text-zinc-400">
          <span className="text-zinc-200">{formatTime(currentTime)}</span>
          <span className="mx-1 text-zinc-600">/</span>
          <span>{formatTime(duration)}</span>
        </div>

        {/* A/B the original against what the agent produced. Enabled only once
            a render exists; the timeline below always stays on the source. */}
        <div className="ml-auto flex items-center rounded-lg border border-zinc-700 p-0.5">
          {['source', 'result'].map((mode) => {
            const isActive = preview === mode
            const isDisabled = mode === 'result' && !hasResult
            return (
              <button
                key={mode}
                type="button"
                disabled={isDisabled}
                onClick={() => onPreviewChange?.(mode)}
                title={
                  isDisabled
                    ? 'Run an instruction to produce a render'
                    : `Show the ${mode}`
                }
                className={
                  'rounded-md px-3 py-1 text-xs font-medium capitalize transition ' +
                  (isActive
                    ? 'bg-indigo-500 text-white'
                    : isDisabled
                      ? 'cursor-not-allowed text-zinc-600'
                      : 'text-zinc-400 hover:text-zinc-200')
                }
              >
                {mode}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
