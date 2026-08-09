import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  USE_FIXTURES,
  downloadUrl,
  getResult,
  getTranscript,
  ingest,
  instruct,
  mediaUrl,
  subscribeEvents,
} from './api.js'
import { synthPeaks } from './utils/format.js'
import InstructionBar from './components/InstructionBar.jsx'
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
  const [ingestBusy, setIngestBusy] = useState(false)
  const [ingestError, setIngestError] = useState(null)
  const objectUrlRef = useRef(null)

  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playing, setPlaying] = useState(false)

  const [events, setEvents] = useState([])
  const [running, setRunning] = useState(false)
  const [jobId, setJobId] = useState(null)
  const [clips, setClips] = useState([])
  const [plan, setPlan] = useState(null)
  const [resultReady, setResultReady] = useState(false)
  const [toast, setToast] = useState(null)

  const unsubRef = useRef(null)

  // Lift playback state off the shared <video> element.
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onTime = () => setCurrentTime(v.currentTime)
    const onMeta = () => v.duration && setDuration(v.duration)
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    v.addEventListener('timeupdate', onTime)
    v.addEventListener('loadedmetadata', onMeta)
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    return () => {
      v.removeEventListener('timeupdate', onTime)
      v.removeEventListener('loadedmetadata', onMeta)
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
    }
  }, [transcript])

  useEffect(
    () => () => {
      unsubRef.current?.()
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    },
    [],
  )

  const segments = transcript?.segments ?? []
  const peaks = useMemo(
    () => transcript?.peaks ?? synthPeaks(duration || 1, segments),
    [transcript, duration, segments],
  )

  const handleIngest = useCallback(async ({ file, url }) => {
    setIngestBusy(true)
    setIngestError(null)
    try {
      const { media_id } = await ingest({ file, url })
      const t = await getTranscript(media_id)

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
        setToast(
          'Demo mode: fetching links needs the live backend — showing the bundled sample. Transcript is sample data.',
        )
      } else if (USE_FIXTURES && file) {
        setToast(
          'Demo mode: your file is playing locally, but the transcript is sample data until the backend is connected.',
        )
      }

      setMediaId(media_id)
      setMediaSrc(src)
      setTranscript(t)
      setDuration(t.duration || 0)
    } catch (err) {
      setIngestError(err.message || 'Failed to load media.')
    } finally {
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

  const runInstruction = useCallback(
    async (instruction) => {
      if (!mediaId) return
      unsubRef.current?.()
      setEvents([])
      setClips([])
      setPlan(null)
      setResultReady(false)
      setRunning(true)
      try {
        const { job_id } = await instruct(mediaId, instruction)
        setJobId(job_id)
        unsubRef.current = subscribeEvents(job_id, {
          onEvent: (evt) => setEvents((prev) => [...prev, evt]),
          onDone: async () => {
            try {
              const res = await getResult(job_id)
              setClips(res.clips || [])
              setPlan(res.plan || null)
              setResultReady(true)
            } catch (err) {
              setToast(err.message || 'Could not fetch result.')
            } finally {
              setRunning(false)
            }
          },
          onError: (err) => {
            setToast(err.message || 'Progress stream failed.')
            setRunning(false)
          },
        })
      } catch (err) {
        setToast(err.message || 'Failed to start the agent.')
        setRunning(false)
      }
    },
    [mediaId],
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
          message={toast}
          onDismiss={() => setToast(null)}
        />
      </div>
    )
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-zinc-950 text-zinc-200">
      <InstructionBar
        onRun={runInstruction}
        disabled={!transcript}
        running={running}
      />

      {/* Main editor area: player left, transcript + agent right */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 p-3 lg:grid-cols-[1.6fr_1fr]">
        <div className="min-h-0">
          <VideoPlayer
            videoRef={videoRef}
            src={mediaSrc}
            currentTime={currentTime}
            duration={duration}
            playing={playing}
            onTogglePlay={togglePlay}
          />
        </div>

        <div className="grid min-h-0 grid-rows-2 gap-3">
          <div className="min-h-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
            <TranscriptPanel
              segments={segments}
              currentTime={currentTime}
              onSeek={seek}
            />
          </div>
          <div className="min-h-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
            <AgentPanel
              events={events}
              reasoning={plan?.reasoning}
              running={running}
            />
          </div>
        </div>
      </div>

      {/* Timeline */}
      <div className="px-3">
        <Timeline
          videoRef={videoRef}
          src={mediaSrc}
          peaks={peaks}
          duration={duration || transcript?.duration || 0}
          clips={clips}
          currentTime={currentTime}
          onClipChange={onClipChange}
          onSeek={seek}
        />
      </div>

      {/* Footer: matches + export */}
      <div className="flex items-center justify-between gap-4 border-t border-zinc-800 bg-zinc-900/40 px-4 py-2.5">
        <ClipList clips={clips} onPreview={previewClip} />
        <ExportBar
          outputUrl={downloadUrl(jobId)}
          srtUrl={downloadUrl(jobId, 'srt')}
          ready={resultReady}
        />
      </div>

      <Toast message={toast} onDismiss={() => setToast(null)} />
    </div>
  )
}
