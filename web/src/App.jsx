import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  USE_FIXTURES,
  applyEdit,
  downloadUrl,
  getResult,
  getTranscript,
  ingest,
  instruct,
  mediaUrl,
  outputStreamUrl,
  runLocalInstruction,
  subscribeEvents,
} from './api.js'
import { formatTime, synthPeaks } from './utils/format.js'
import { isKept, mapToOutputTime, nextKeptTime } from './utils/edl.js'
import { parseCommand, zoomScaleAt } from './utils/commands.js'
import { useEDL } from './hooks/useEDL.js'
import TopBar from './components/TopBar.jsx'
import CommandBar from './components/CommandBar.jsx'
import VideoPlayer from './components/VideoPlayer.jsx'
import Timeline from './components/Timeline.jsx'
import TranscriptPanel from './components/TranscriptPanel.jsx'
import AgentPanel from './components/AgentPanel.jsx'
import ClipList from './components/ClipList.jsx'
import ExportBar from './components/ExportBar.jsx'
import IngestOverlay from './components/IngestOverlay.jsx'
import Toast from './components/Toast.jsx'

export default function App() {
  const videoRef = useRef(null)

  const [mediaId, setMediaId] = useState(null)
  const [mediaSrc, setMediaSrc] = useState(null)
  const [transcript, setTranscript] = useState(null)
  const [transcribing, setTranscribing] = useState(false)
  const [ingestBusy, setIngestBusy] = useState(false)
  const [ingestError, setIngestError] = useState(null)
  const objectUrlRef = useRef(null)

  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  // Kept separate from `duration` so the Timeline never rescales when the
  // player is showing the (much shorter) render.
  const [sourceDuration, setSourceDuration] = useState(0)
  const [playing, setPlaying] = useState(false)

  const [events, setEvents] = useState([])
  const [running, setRunning] = useState(false)
  const [jobId, setJobId] = useState(null)
  const [clips, setClips] = useState([])
  const [points, setPoints] = useState([])
  const [plan, setPlan] = useState(null)
  const [notes, setNotes] = useState([])
  const [outputUrl, setOutputUrl] = useState(null)
  const [srtUrl, setSrtUrl] = useState(null)
  // Mirrors the bot's caption: which dub engine ran, and whether the speaker's
  // own voice was cloned. Judges ask about this, so it has to be on screen.
  const [dubInfo, setDubInfo] = useState(null)
  const [resultReady, setResultReady] = useState(false)
  const [preview, setPreview] = useState('source')
  const [toast, setToast] = useState(null)

  // Manual-edit (EDL) render state.
  const [editing, setEditing] = useState(false)
  const [editReady, setEditReady] = useState(false)
  const [editUrl, setEditUrl] = useState(null)

  // Zoom effects applied via the timestamp command bar. Each is
  // { id, type: 'in'|'out', start, end, scale } over the ORIGINAL timeline.
  const [effects, setEffects] = useState([])

  const unsubRef = useRef(null)
  // The loadedmetadata listener below is registered once per transcript, so it
  // would otherwise close over a stale `preview`.
  const previewRef = useRef('source')
  previewRef.current = preview

  // The editor's timeline basis. Always the SOURCE duration, never the player's
  // — the EDL and the zoom windows are both expressed over the original
  // timeline, so previewing a (much shorter) render must not rescale the
  // Timeline or reset the edit history.
  const timelineDuration = sourceDuration || transcript?.duration || duration || 0
  const edl = useEDL(timelineDuration)

  // Lift playback state off the shared <video> element. Subscribe when the
  // element/source is ready (not when the transcript arrives) so the readout
  // reflects real playback immediately, and seed from the element in case
  // metadata already loaded before we attached.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onTime = () => setCurrentTime(v.currentTime)
    const onMeta = () => {
      if (!Number.isFinite(v.duration) || !v.duration) return
      setDuration(v.duration)
      if (previewRef.current === 'source') setSourceDuration(v.duration)
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    v.addEventListener('timeupdate', onTime)
    v.addEventListener('loadedmetadata', onMeta)
    v.addEventListener('durationchange', onMeta)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    setCurrentTime(v.currentTime)
    if (Number.isFinite(v.duration)) setDuration(v.duration)
    setPlaying(!v.paused)
    return () => {
      v.removeEventListener('timeupdate', onTime)
      v.removeEventListener('loadedmetadata', onMeta)
      v.removeEventListener('durationchange', onMeta)
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
    }
  }, [mediaSrc])

  useEffect(
    () => () => {
      unsubRef.current?.()
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    },
    [],
  )

  const segments = transcript?.segments ?? []
  // Pinned to the source: recomputing these while previewing the render would
  // tear down and rebuild wavesurfer, losing the clip regions.
  const peaks = useMemo(
    () => transcript?.peaks ?? synthPeaks(sourceDuration || 1, segments),
    [transcript, sourceDuration, segments],
  )
  const playerSrc = preview === 'result' && outputUrl ? outputStreamUrl(jobId) : mediaSrc

  const handleIngest = useCallback(async ({ file, url }) => {
    setIngestBusy(true)
    setIngestError(null)

    try {
      const { media_id } = await ingest({ file, url })

      // Choose the playback source. In demo mode we can't fetch remote links
      // (that needs the backend's yt-dlp), but an uploaded file can play
      // locally via an object URL so you at least see your own video.
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = null
      }
      let src
      if (USE_FIXTURES && file) {
        src = URL.createObjectURL(file)
        objectUrlRef.current = src
      } else {
        src = mediaUrl(media_id)
      }

      if (USE_FIXTURES && url) {
        setToast({
          text: 'Demo mode: fetching links needs the live backend — showing the bundled sample. Transcript is sample data.',
          kind: 'info',
        })
      } else if (USE_FIXTURES && file) {
        setToast({
          text: 'Demo mode: your file is playing locally, but the transcript is sample data until the backend is connected.',
          kind: 'info',
        })
      }

      // Show the editor as soon as the media is playable. Transcription is a
      // full STT run — awaiting it here would park the user on a dead spinner
      // for minutes. The agent input stays disabled until it lands, which also
      // stops a second transcribe() racing the first.
      setEffects([])
      setMediaId(media_id)
      setMediaSrc(src)
      setIngestBusy(false)

      setTranscribing(true)
      getTranscript(media_id)
        .then((t) => {
          setTranscript(t)
          if (t.duration) {
            setDuration((d) => d || t.duration)
            setSourceDuration((d) => d || t.duration)
          }
        })
        .catch((err) =>
          setToast({
            text: err.message || 'Could not transcribe this media.',
            kind: 'error',
          }),
        )
        .finally(() => setTranscribing(false))
    } catch (err) {
      setIngestError(err.message || 'Failed to load media.')
      setIngestBusy(false)
    }
  }, [])

  const seek = useCallback((t) => {
    const v = videoRef.current
    if (v && Number.isFinite(t)) {
      v.currentTime = t
      setCurrentTime(t)
    }
  }, [])

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) v.play().catch(() => {})
    else v.pause()
  }, [])

  const previewClip = useCallback(
    (clip) => {
      seek(clip.start)
      videoRef.current?.play().catch(() => {})
    },
    [seek],
  )

  const onClipChange = useCallback((idx, next) => {
    setClips((prev) =>
      prev.map((c, i) => (i === idx ? { ...c, ...next } : c)),
    )
  }, [])

  // Playback preview honors the EDL: while playing, skip over removed ranges by
  // seeking across the gap; pause at the end once nothing kept remains.
  useEffect(() => {
    if (!playing || !edl.isEdited) return
    const v = videoRef.current
    if (!v) return
    if (isKept(edl.keepRanges, currentTime)) return
    const next = nextKeptTime(edl.keepRanges, currentTime)
    if (next != null && next > currentTime + 0.01) {
      v.currentTime = next
      setCurrentTime(next)
    } else if (next == null) {
      v.pause()
      const last = edl.keepRanges[edl.keepRanges.length - 1]
      if (last) {
        v.currentTime = last.end
        setCurrentTime(last.end)
      }
    }
  }, [currentTime, playing, edl.isEdited, edl.keepRanges])

  // A fresh set of edits invalidates any previously rendered trimmed file.
  useEffect(() => {
    setEditReady(false)
    setEditUrl(null)
  }, [edl.keepRanges, effects])

  const hasEdits = edl.isEdited || effects.length > 0

  const onRenderEdit = useCallback(async () => {
    if (!hasEdits || !mediaId) return
    setEditing(true)
    try {
      // Zoom windows are stored over the ORIGINAL timeline; reposition them onto
      // the trimmed output so ffmpeg applies them at the right moment.
      const mappedEffects = effects
        .map((fx) => ({
          scale: fx.scale,
          start: mapToOutputTime(edl.keepRanges, fx.start),
          end: mapToOutputTime(edl.keepRanges, fx.end),
        }))
        .filter((fx) => fx.end - fx.start > 0.05)
      const { job_id } = await applyEdit(mediaId, edl.keepRanges, mappedEffects)
      setEditUrl(downloadUrl(job_id))
      setEditReady(true)
      if (USE_FIXTURES) {
        setToast({
          text: 'Demo mode: the edit is simulated — the bundled sample stands in for the trimmed render.',
          kind: 'info',
        })
      }
    } catch (err) {
      setToast({ text: err.message || 'Failed to render the edit.', kind: 'error' })
    } finally {
      setEditing(false)
    }
  }, [hasEdits, edl.keepRanges, effects, mediaId])

  const runInstruction = useCallback(
    async (instruction) => {
      if (!mediaId) return
      unsubRef.current?.()
      setEvents([])
      setClips([])
      setPoints([])
      setPlan(null)
      setNotes([])
      setOutputUrl(null)
      setSrtUrl(null)
      setDubInfo(null)
      setResultReady(false)
      setPreview('source')
      setRunning(true)

      // Offline mode: run a transcript-aware client agent so instructions act on
      // the loaded transcript instead of replaying a canned result.
      if (USE_FIXTURES) {
        unsubRef.current = runLocalInstruction(
          { instruction, segments, duration: timelineDuration },
          {
            onEvent: (evt) => setEvents((prev) => [...prev, evt]),
            onDone: ({ clips: found, plan: builtPlan }) => {
              setClips(found || [])
              setPlan(builtPlan || null)
              setResultReady(true)
              setRunning(false)
              if (builtPlan?.note) setToast(builtPlan.note)
            },
            onError: (err) => {
              setToast(err.message || 'Could not run that instruction.')
              setRunning(false)
            },
          },
        )
        return
      }

      try {
        const { job_id } = await instruct(mediaId, instruction)
        setJobId(job_id)
        unsubRef.current = subscribeEvents(job_id, {
          onEvent: (evt) => setEvents((prev) => [...prev, evt]),
          onDone: async () => {
            try {
              const res = await getResult(job_id)
              setClips(res.clips || [])
              setPoints(res.points || [])
              setPlan(res.plan || null)
              setNotes(res.notes || [])
              setOutputUrl(res.output_url || null)
              setSrtUrl(res.srt_url || null)
              setDubInfo(
                res.dub_engine
                  ? { engine: res.dub_engine, cloned: !!res.voice_cloned }
                  : null,
              )

              // A job can finish "successfully" with nothing to show — e.g. the
              // locator found no match. Gate Export on a real output so the
              // button never dangles, and say why instead.
              const ok = res.status !== 'error' && !!res.output_url
              setResultReady(ok)
              if (!ok) {
                setToast({
                  text:
                    res.error ||
                    (res.notes || []).join(' · ') ||
                    'The agent could not finish this edit.',
                  kind: 'error',
                })
              } else {
                setPreview('result')
                if (res.notes?.length) {
                  setToast({ text: res.notes.join(' · '), kind: 'info' })
                }
              }
            } catch (err) {
              setToast({ text: err.message || 'Could not fetch result.', kind: 'error' })
            } finally {
              setRunning(false)
            }
          },
          onError: (err) => {
            setToast({ text: err.message || 'Progress stream failed.', kind: 'error' })
            setRunning(false)
          },
        })
      } catch (err) {
        setToast({ text: err.message || 'Failed to start the agent.', kind: 'error' })
        setRunning(false)
      }
    },
    [mediaId, segments, timelineDuration],
  )

  // Timestamp + instruction command: cuts feed the EDL, zooms become live
  // preview effects. Returns an error string on failure (shown inline), or
  // null on success so the CommandBar can clear its input.
  const handleCommand = useCallback(
    (text) => {
      const res = parseCommand(text, { currentTime, duration: timelineDuration })
      if (!res.ok) return res.error

      if (res.action === 'cut') {
        edl.deleteRange(res.start, res.end)
        seek(res.start)
        setToast({
          text: `Cut ${formatTime(res.start)}–${formatTime(res.end)} — render to export the trim.`,
          kind: 'info',
        })
        return null
      }

      // zoom
      setEffects((prev) => [
        ...prev,
        {
          id: `fx_${Date.now().toString(36)}`,
          type: res.type,
          start: res.start,
          end: res.end,
          scale: res.scale,
        },
      ])
      seek(res.start)
      setToast({
        text: `${res.label} ${res.scale.toFixed(1)}x from ${formatTime(res.start)} to ${formatTime(res.end)} — press play to preview.`,
        kind: 'info',
      })
      return null
    },
    [currentTime, timelineDuration, edl, seek],
  )

  const removeEffect = useCallback((id) => {
    setEffects((prev) => prev.filter((fx) => fx.id !== id))
  }, [])

  // Live zoom for the player: the strongest active effect at the playhead.
  const zoomScale = useMemo(
    () => zoomScaleAt(effects, currentTime),
    [effects, currentTime],
  )

  if (!mediaId) {
    return (
      <div className="h-screen w-screen">
        <IngestOverlay
          onIngest={handleIngest}
          busy={ingestBusy}
          error={ingestError}
        />
        <Toast
          message={toast?.text}
          kind={toast?.kind}
          onDismiss={() => setToast(null)}
        />
      </div>
    )
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-zinc-950 text-zinc-200">
      <TopBar />

      {/* Main editor area: player left, transcript + agent right */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-[1.6fr_1fr]">
        <div className="min-h-0">
          <VideoPlayer
            videoRef={videoRef}
            src={playerSrc}
            currentTime={currentTime}
            duration={duration}
            playing={playing}
            onTogglePlay={togglePlay}
            preview={preview}
            onPreviewChange={setPreview}
            hasResult={!!outputUrl}
            zoomScale={zoomScale}
          />
        </div>

        <div className="grid min-h-0 grid-rows-2 gap-3">
          <div className="min-h-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
            <TranscriptPanel
              segments={segments}
              currentTime={currentTime}
              onSeek={seek}
              loading={transcribing}
            />
          </div>
          <div className="min-h-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
            <AgentPanel
              events={events}
              reasoning={plan?.reasoning}
              running={running}
              notes={notes}
              onRun={runInstruction}
              disabled={!transcript}
            />
          </div>
        </div>
      </div>

      {/* Timestamp + instruction command bar */}
      <div className="px-3 pb-2">
        <CommandBar
          onCommand={handleCommand}
          disabled={!mediaId}
          effects={effects}
          onRemoveEffect={removeEffect}
        />
      </div>

      {/* Timeline */}
      <div className="px-3">
        {/* Always the source, even while the player previews the render — the
            matched regions only mean anything against the original timeline. */}
        <Timeline
          videoRef={videoRef}
          src={mediaSrc}
          peaks={peaks}
          duration={timelineDuration}
          clips={clips}
          currentTime={currentTime}
          onClipChange={onClipChange}
          onSeek={seek}
          edl={edl}
        />
      </div>

      {/* Footer: matches + export */}
      <div className="flex items-center justify-between gap-4 border-t border-zinc-800 bg-zinc-900/40 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <ClipList clips={clips} points={points} onPreview={previewClip} />
          {dubInfo && (
            <span
              title={`Dubbed via the ${dubInfo.engine} engine`}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-fuchsia-500/40 bg-fuchsia-500/10 px-2.5 py-1 text-[11px] font-medium text-fuchsia-200"
            >
              🎙 Dubbed{dubInfo.cloned ? ' · voice cloned' : ''}
            </span>
          )}
        </div>
        <ExportBar
          outputUrl={outputUrl ? downloadUrl(jobId) : null}
          srtUrl={srtUrl ? downloadUrl(jobId, 'srt') : null}
          ready={resultReady}
          edited={hasEdits}
          editing={editing}
          editReady={editReady}
          editUrl={editUrl}
          onRenderEdit={onRenderEdit}
        />
      </div>

      <Toast
        message={toast?.text}
        kind={toast?.kind}
        onDismiss={() => setToast(null)}
      />
    </div>
  )
}
