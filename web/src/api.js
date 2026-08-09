// ─────────────────────────────────────────────────────────────────────────────
//  The ONLY file that knows the backend exists.
//
//  Person A's FastAPI engine (server.py) exposes the frozen §5 contract:
//    POST /api/ingest             {url} | multipart file  -> {job_id, media_id}
//    GET  /api/media/{media_id}   bytes (HTTP Range)       -> <video> source
//    GET  /api/transcript/{id}    -> {language, duration, segments:[...]}
//    POST /api/instruct           {media_id, instruction}  -> {job_id}
//    GET  /api/events/{job_id}    -> SSE stream of ProgressEvent
//    GET  /api/result/{job_id}    -> {clips, output_url, srt_url, plan}
//    GET  /api/download/{job_id}  -> final file
//
//  Flip USE_FIXTURES (via .env VITE_USE_FIXTURES) to run the whole UI offline
//  against static fixtures — the rest of the app never changes.
// ─────────────────────────────────────────────────────────────────────────────

import transcriptFixture from './fixtures/transcript.json'
import resultFixture from './fixtures/result.json'
import eventsRaw from './fixtures/events.jsonl?raw'
import { planInstruction } from './utils/agent.js'

export const USE_FIXTURES =
  String(import.meta.env.VITE_USE_FIXTURES ?? '1') !== '0'

const API_BASE = '/api' // Vite proxies this to VITE_BACKEND_ORIGIN.

const FIXTURE_EVENTS = eventsRaw
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function jsonFetch(url, options) {
  const res = await fetch(url, options)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText} — ${body}`.trim())
  }
  return res.json()
}

// ── Ingest: file upload or URL ──────────────────────────────────────────────
export async function ingest({ file, url }) {
  if (USE_FIXTURES) {
    await sleep(500)
    return { job_id: 'job_demo', media_id: 'sample' }
  }
  if (file) {
    const form = new FormData()
    form.append('file', file)
    return jsonFetch(`${API_BASE}/ingest`, { method: 'POST', body: form })
  }
  return jsonFetch(`${API_BASE}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
}

// ── Media URL for the <video> element (must support Range for seeking) ───────
export function mediaUrl(mediaId) {
  if (USE_FIXTURES) return '/sample.mp4'
  return `${API_BASE}/media/${encodeURIComponent(mediaId)}`
}

// ── Transcript ───────────────────────────────────────────────────────────────
export async function getTranscript(mediaId) {
  if (USE_FIXTURES) {
    await sleep(400)
    return transcriptFixture
  }
  return jsonFetch(`${API_BASE}/transcript/${encodeURIComponent(mediaId)}`)
}

// ── Send a natural-language instruction to the agent ─────────────────────────
export async function instruct(mediaId, instruction) {
  if (USE_FIXTURES) {
    await sleep(300)
    return { job_id: 'job_demo' }
  }
  return jsonFetch(`${API_BASE}/instruct`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_id: mediaId, instruction }),
  })
}

// ── Result (clips + plan + output) ───────────────────────────────────────────
export async function getResult(jobId) {
  if (USE_FIXTURES) {
    await sleep(200)
    return resultFixture
  }
  return jsonFetch(`${API_BASE}/result/${encodeURIComponent(jobId)}`)
}

// ── Apply a manual edit (EDL) — pure ffmpeg cut+concat on the backend ────────
// keepRanges is an ordered list of { start, end } (seconds) over the original
// timeline. Returns { job_id }; the trimmed file is served by downloadUrl(job_id).
// `effects` (optional) is a list of zoom windows already mapped onto the edited
// output timeline: { start, end, scale } (seconds). The backend bakes them into
// the render via ffmpeg after the cut+concat.
export async function applyEdit(mediaId, keepRanges, effects = []) {
  const keep_ranges = (keepRanges || []).map((r) => [r.start, r.end])
  const fx = (effects || []).map((e) => ({
    start: e.start,
    end: e.end,
    scale: e.scale,
  }))
  if (USE_FIXTURES) {
    // No backend in demo mode — simulate a render and reuse the sample file.
    await sleep(700)
    return { job_id: 'edit_demo' }
  }
  return jsonFetch(`${API_BASE}/edit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_id: mediaId, keep_ranges, effects: fx }),
  })
}

// ── Download URL for the final file / SRT ────────────────────────────────────
export function downloadUrl(jobId, type) {
  if (USE_FIXTURES) return '/sample.mp4'
  const q = type ? `?type=${encodeURIComponent(type)}` : ''
  return `${API_BASE}/download/${encodeURIComponent(jobId)}${q}`
}

// ── Live progress: SSE with a polling fallback ───────────────────────────────
// Returns an unsubscribe() function. Calls onEvent(evt) per ProgressEvent,
// onDone() when the stream completes, onError(err) on failure.
export function subscribeEvents(jobId, { onEvent, onDone, onError }) {
  if (USE_FIXTURES) return replayFixtureEvents({ onEvent, onDone })

  // Prefer SSE.
  if (typeof EventSource !== 'undefined') {
    let closed = false
    const es = new EventSource(`${API_BASE}/events/${encodeURIComponent(jobId)}`)
    es.onmessage = (e) => {
      if (!e.data) return
      let evt
      try {
        evt = JSON.parse(e.data)
      } catch {
        return
      }
      onEvent?.(evt)
      if (evt.stage === 'result' || evt.pct >= 100) {
        closed = true
        es.close()
        onDone?.()
      }
    }
    es.onerror = () => {
      if (closed) return
      es.close()
      // Fall back to polling if the SSE connection drops.
      pollJob(jobId, { onEvent, onDone, onError })
    }
    return () => {
      closed = true
      es.close()
    }
  }

  return pollJob(jobId, { onEvent, onDone, onError })
}

// Polling fallback: GET /api/jobs/{id} every second.
function pollJob(jobId, { onEvent, onDone, onError }) {
  let stop = false
  ;(async () => {
    let lastPct = -1
    while (!stop) {
      try {
        const j = await jsonFetch(`${API_BASE}/jobs/${encodeURIComponent(jobId)}`)
        if (j.event && j.event.pct !== lastPct) {
          lastPct = j.event.pct
          onEvent?.(j.event)
        }
        if (j.status === 'done' || (j.event && j.event.pct >= 100)) {
          onDone?.()
          return
        }
      } catch (err) {
        onError?.(err)
        return
      }
      await sleep(1000)
    }
  })()
  return () => {
    stop = true
  }
}

// ── Offline agent: run an instruction against the loaded transcript ──────────
// Fixtures mode only. Parses the instruction, searches the transcript, and
// replays a synthesized ProgressEvent stream — then hands back the located
// { clips, plan } via onDone so the UI behaves like a live run. Returns an
// unsubscribe() function. onError(err) fires (before any events) when the
// instruction can't be satisfied, e.g. no match in the transcript.
export function runLocalInstruction({ instruction, segments, duration }, { onEvent, onDone, onError }) {
  const spec = planInstruction({ instruction, segments, duration })
  if (!spec.ok) {
    onError?.(new Error(spec.error))
    return () => {}
  }
  let cancelled = false
  ;(async () => {
    await sleep(300)
    for (const evt of spec.events) {
      if (cancelled) return
      onEvent?.(evt)
      await sleep(evt.stage === 'dub' ? 750 : 500)
    }
    if (!cancelled) onDone?.({ clips: spec.clips, plan: spec.plan })
  })()
  return () => {
    cancelled = true
  }
}

// Fixture replay: emit each ProgressEvent on a timer so the agent panel and
// timeline animate exactly like a live run.
function replayFixtureEvents({ onEvent, onDone }) {
  let cancelled = false
  ;(async () => {
    await sleep(500)
    for (const evt of FIXTURE_EVENTS) {
      if (cancelled) return
      onEvent?.(evt)
      // Dubbing steps feel weightier — stagger them a touch more.
      await sleep(evt.stage === 'dub' ? 900 : 650)
    }
    if (!cancelled) onDone?.()
  })()
  return () => {
    cancelled = true
  }
}
