# ClipCraft — Web Video Editor (`web/`, Person B)

The React front-end for ClipCraft. It ingests a video (file or link), shows a
timestamped click-to-seek transcript, and drives a natural-language agent that
trims, dubs, and edits — all rendered against the Python engine's REST + SSE
contract.

> Scope: this folder is **only** the web editor. The Python engine, FastAPI
> `server.py`, all Sarvam/ffmpeg work, and the Telegram bot live in `clipcraft/`
> and are owned by Person A. This app never calls Sarvam directly.

## Stack

- React 19 + Vite
- Tailwind CSS v4 (`@tailwindcss/vite`)
- [wavesurfer.js v7](https://wavesurfer.xyz/) (Regions + Timeline plugins)

## Run

```bash
cd web
npm install
npm run dev        # http://localhost:5173
```

### Fixtures vs live backend

`src/api.js` is the **only** file that knows the backend exists. The mode is set
by `.env`:

```env
VITE_USE_FIXTURES=1          # run the whole UI on static fixtures (no backend)
VITE_BACKEND_ORIGIN=http://localhost:8000   # where server.py runs
```

- `VITE_USE_FIXTURES=1` (default): everything runs offline against
  `src/fixtures/*.json`. Great for building the UI and as a demo fallback.
- `VITE_USE_FIXTURES=0`: the dev server proxies `/api` to `VITE_BACKEND_ORIGIN`
  and the app talks to the real engine. Nothing else changes.

## API contract (frozen — see root `Plan.md` §5)

```
POST /api/ingest            {url} | multipart file  -> {job_id, media_id}
GET  /api/media/{media_id}  bytes (MUST support HTTP Range)
GET  /api/transcript/{id}   -> {language, duration, segments:[...]}
POST /api/instruct          {media_id, instruction} -> {job_id}
GET  /api/events/{job_id}   -> SSE stream of ProgressEvent
GET  /api/result/{job_id}   -> {clips, output_url, srt_url, plan}
GET  /api/download/{job_id} -> final file
```

Shapes: `Segment {id,start,end,text}`, `ProgressEvent {stage,status,message,pct}`,
`Clip {start,end,reason,confidence,segment_ids}`, `Plan {reasoning,ops[],unsupported_language}`.

The agent checklist is **data-driven** from the `stage` field, so new engine ops
(denoise, resize, music, thumbnail, …) appear automatically with no UI changes.

## Sample video

Playback needs `public/sample.mp4` (kept out of git by default). Without it the
waveform, transcript, and agent still work — only the `<video>` shows a
placeholder. Drop any short mp4 there, or let Person A commit the real one.

## Components

| File | Role |
|---|---|
| `App.jsx` | State hub: media, transcript, playback, job/events, clips |
| `api.js` | Backend adapter (fixtures/live switch, SSE + polling fallback) |
| `components/InstructionBar.jsx` | NL instruction input + example chips |
| `components/VideoPlayer.jsx` | Shared `<video>` + transport |
| `components/Timeline.jsx` | wavesurfer waveform + draggable match regions |
| `components/TranscriptPanel.jsx` | Click-to-seek transcript, active highlight |
| `components/AgentPanel.jsx` | Live op checklist from SSE + reasoning |
| `components/ClipList.jsx` | Match cards (range, reason, confidence, preview) |
| `components/ExportBar.jsx` | Download result + SRT |
| `components/IngestOverlay.jsx` | Upload / URL landing screen |
