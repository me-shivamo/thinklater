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

//  Fixtures are OPT-IN. The failure modes are asymmetric: with fixtures on the
//  app looks flawless while every byte of it is fake, and the only tell is a
//  small badge. Live-by-default fails loudly and obviously instead. Note Vite
//  inlines import.meta.env at BUILD time, so a bundle built without web/.env
//  bakes this in permanently.
export const USE_FIXTURES =
  String(import.meta.env.VITE_USE_FIXTURES ?? '0') === '1'

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

// ── Download URL for the final file / SRT ────────────────────────────────────
// dl=1 asks the backend for Content-Disposition: attachment, so the Export
// button saves with a sensible filename.
export function downloadUrl(jobId, type) {
  if (USE_FIXTURES) return '/sample.mp4'
  const q = type ? `?type=${encodeURIComponent(type)}&dl=1` : '?dl=1'
  return `${API_BASE}/download/${encodeURIComponent(jobId)}${q}`
}

// ── Same file, but streamable ────────────────────────────────────────────────
// No dl=1, so it comes back inline with Range support and the <video> element
// can play and seek within the render.
export function outputStreamUrl(jobId) {
  if (USE_FIXTURES) return '/sample.mp4'
  return `${API_BASE}/download/${encodeURIComponent(jobId)}`
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
