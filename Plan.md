# ClipCraft — Natural-Language Video Editor Agent

> **Sarvam × HackCulture Hackathon, Bangalore**
> Team of 2. This document is the single source of truth.

---

## 1. Context

**Problem statement:** An AI video-editing agent that understands natural-language instructions and automatically finds, trims, denoises, translates, and dubs the relevant part of any audio or video — delivered through a real editor UI.

**The demo sentence:** *"Trim the part where he talks about India and dub it in Hindi."*

**Three surfaces, one engine:**

| Surface | Role | Owner |
|---|---|---|
| **Python engine** | All Sarvam calls, ffmpeg, the agent | **You** (Person A) |
| **Telegram bot** | Conversational surface — instruction in, media out | **You** (Person A) |
| **Web video editor** | Primary demo. Timeline + transcript + agent panel. | **Teammate** (Person B) |

Mentor feedback made the web editor the primary demo surface. Both surfaces are first-class deliverables and both sit on the *same* engine — the Telegram bot and the FastAPI backend are two thin adapters over one `pipeline.run()`. Building both is genuinely cheap once the engine exists, and having two independent surfaces is also the best insurance in the room: if one fails on stage, the other still tells the whole story.

### Target instructions (the test matrix)

| # | Instruction | Source | Ops |
|---|---|---|---|
| 1 | "Trim the part where it tells the credit card number" | mp3 URL | find → trim |
| 2 | "Dub the audio in Hindi" | mp3 URL | dub |
| 3 | ⭐ "Trim the credit card part **and** dub it in Hindi" | mp3 URL | find → trim → dub |
| 4 | "Remove background noise from this audio" | mp3 URL | denoise |
| 5 | "Dub the video to Hindi and send it back" | mp4 URL | dub |
| 6 | "Trim where it speaks about Anderson and dub to Hindi" | YouTube Shorts | find → trim → dub |
| 7 | "Remove background noise from the part where he says 'I am a moster'" | mp4 URL | denoise → find → trim |

Examples, not a fixed list — the goal is arbitrary op composition. Case 7's typo ("moster") matters: quote matching must be fuzzy, which is why location is done by LLM, not string search.

### Locked decisions
- **Sarvam-only languages.** Spanish dropped; unsupported requests reply with the supported list.
- **Case 7 returns just that clip, denoised.**
- Web editor is the primary demo surface; Telegram bot is the second surface.
- Time budget can extend past 6 hours.

---

## 2. Verified API facts

Everything below was confirmed by downloading and unpacking the `sarvamai` wheel (v0.1.30) and reading client source — **not** from docs prose, which is wrong in several places.

### 🔑 The big find: Sarvam has a Dubbing API with voice cloning

Sarvam Dub is documented only as a Studio *web UI* product, so it's easy to miss — but `sarvamai.dubbing` is a fully callable SDK namespace. It does transcription, translation, synthesis, **speaker voice cloning**, and timeline alignment in one job, and exports SRT for free.

```python
job = client.dubbing.create(
    source_language_code="en-IN",
    target_language_codes=["hi-IN"],      # takes a LIST — multi-language in one job
    export_options=["video", "audio", "srt"],
    voice_cloning=True,        # dubbed voice sounds like the original speaker
    num_speakers=1,
    pace_preset="normal",      # slow | moderate | normal | fast
    register="auto",           # formal | common-indic | classic-colloquial
                               # | modern-colloquial | academic | auto
    disable_watermark=True,    # may need a paid plan — retry False on 4xx
    job_name="clipcraft-<id>",
)
# → job.data.job_id, job.data.upload_url
```
Then **`PUT` raw bytes to `upload_url`** with `Content-Type: <mime>` **and `x-ms-blob-type: BlockBlob`** (Azure blob — mandatory, easy to miss) → `dubbing.start(job_id)` → poll `dubbing.get_live_status(job_id)` → `dubbing.get_export_status(job_id)`.

Status values: `queued | in_progress | completed | failed | partial_failure | deleted`.
Live status carries `progress` (int 0-100) and `current_step_label` — pipe both to the UI.
Each export item has `export_type` and `download_url`.

### 🔴 Bug caught in review — before any code was written

`chat.completions()` in `sarvamai` 0.1.30 **does not accept `response_format`**. Zero occurrences in `sarvamai/chat/client.py`. The planner would have crashed on its first call. The API *does* support it (the SDK ships a complete `ResponseFormat_JsonSchema` type with a `json_schema: JsonSchemaDefinition` field) — Fern generated the types but never wired the method parameter.

**Fix — the SDK's own escape hatch:**
```python
client.chat.completions(
    model="sarvam-105b",
    messages=[...],
    request_options={"additional_body_parameters": {
        "response_format": {"type": "json_schema", "json_schema": {...}}
    }},
)
```
**Plan B:** `{"type": "json_object"}` + schema described in the system prompt.
**Plan C:** raw `requests.post` to `https://api.sarvam.ai/v1/chat/completions` (OpenAI-compatible, accepts `Authorization: Bearer`).

### Verified correct

| Claim | Result |
|---|---|
| STT response shape | ✅ Flat — `.transcript`, `.timestamps.{words,start_time_seconds,end_time_seconds}`, `.language_code`, `.language_probability`. No `.data` wrapper. |
| `language_code="unknown"` auto-detect | ✅ In the 24-value enum |
| STT `mode` enum | ✅ `transcribe, translate, verbatim, translit, codemix` |
| STT model enum | ✅ `"saaras:v3" \| "saaras:v4"` — v4 *is* selectable |
| Chat model enum | ⚠️ `SarvamModelIds = Literal["sarvam-105b"]` — the **only** one. No `-conversations`, no `sarvam-30b` (deprecated). |
| TTS | ✅ `bulbul:v3`, speaker `shubh` (44 speakers) |
| Translate | ✅ `sarvam-translate:v1`, mode `modern-colloquial` |
| ffmpeg | ✅ `7:6.1.1-3ubuntu5` in apt — has `arnndn`, `afftdn`, `silencedetect`, `atempo`, `adelay`, `amix` |
| rnnoise model URL | ✅ HTTP 200, 297 KB |
| Packages | ✅ `python-telegram-bot` 22.8, `yt-dlp` 2026.7.4, `sarvamai` 0.1.30 |

### ⚠️ Four different language sets — a guaranteed bug source

| API | Count | Notable |
|---|---|---|
| STT (Saaras) | 24 | incl. `unknown`; **`od-IN`** |
| Translate | 23 | **`od-IN`** |
| TTS (Bulbul) | 11 | **`od-IN`**; **no `as-IN`** |
| **Dubbing** | 12 | **`or-IN`** ⚠️; **has `as-IN`** |

Odia is `or-IN` for dubbing, `od-IN` everywhere else. Assamese is dubbable but not TTS-able. `config.py` holds one canonical table with per-API mapping; the planner validates against the **intersection** of the ops in the chain.

Also: **`timestamps.words` contains phrases, not words.** Misleading name, will cost 20 minutes if trusted.

### Other constraints
- **STT REST caps at 30s per request.** Longer media must be chunked locally and stitched onto a global timeline. This is the hardest part of the engine.
- **Noise removal is not a Sarvam API** — ffmpeg `arnndn` (neural, needs model file) / `afftdn` (FFT, no model).
- **Telegram bots**: download ≤20MB, upload ≤50MB. Server-side URL fetches are unlimited.
- **Rate limits**: 60 req/min most APIs, 40 for sarvam-105b. Free ₹100 credits.
- Pricing: STT ₹30/hr · translate ₹20/10K chars · TTS ₹30/10K chars · 105b ₹29.28/₹73.2 per 1M tok · dubbing ~80 credits/min output. A full run ≈ ₹6-8.

### ❌ Unverifiable offline — this is what smoke test #0 is for
`SARVAM_API_KEY` was not set, so **zero live calls were made**. Still unknown: is dubbing enabled on the key; is `disable_watermark=True` permitted; does `mode` work with `saaras:v4`; real dubbing latency; does the server honour the injected `response_format`.

### Environment status
- `python3.12`, `uv`, `node v22` present. **`ffmpeg` NOT installed** — first command.
- Both ElevenLabs mp3 test URLs → **200** (~16s, ~40s).
- YouTube Shorts URL → reachable.
- ⚠️ The **entire** `gtv-videos-bucket` is 403 (BigBuckBunny too); w3schools 403. Don't hunt hotlinks — `yt-dlp` one CC video and **commit `assets/sample.mp4`**.

### Handy during the build
Sarvam ships a docs **MCP server: `https://docs.sarvam.ai/_mcp/server`** — connect Claude Code to it for live API reference.

---

## 3. Prior art: `akdeepankar/Clip-It`

Read in full (572-line `scripts/clip.py` + `SKILL.md`). An **OpenClaw skill on ElevenLabs Scribe + OpenAI gpt-4o-mini**, built for the *ElevenLabs* hackathon — a different event, demoed via Telegram.

Flow: `download → extract audio → Scribe (whole file, word-level) → gpt-4o-mini returns one {start,end} → ffmpeg cut → optional Isolation → optional Dubbing`.

> ⚠️ **No LICENSE** (`license: null`) → default copyright. Borrow ideas freely; ask before lifting code. Little transfers anyway — different provider stack.

**Adopt:**
1. `extractor_args={'youtube': {'player_client': ['android','web']}}` — sidesteps most 403s (independently confirmed).
2. Extension sniffing from `Content-Type` via `mimetypes.guess_extension()` for URLs without extensions.
3. `OUTPUT_FILE: /path` stdout sentinel — clean script→caller contract.
4. Sentence-boundary backtracking in the locator prompt.
5. Retry-with-degraded-params on 4xx — maps directly onto `disable_watermark`.

**Where we differ (= our differentiation):**

| Theirs | Ours |
|---|---|
| No planner — flags only, NL parsing delegated to the host agent | Planner LLM **inside** the app |
| One segment only | **Multi-clip supercut** |
| Re-transcribes every run | **Hash-keyed transcript cache** |
| Dumps entire word list into the prompt | Indexed phrase segments |
| `cut → isolate → dub` — denoises *after* transcribing | **Denoise hoisted before STT** |
| stdout prints | **Live progress + a real editor UI** |
| CLI only | **Timeline UI, waveform, clickable transcript** |

**Honest gap:** ElevenLabs Audio Isolation is true source separation and beats `arnndn` on messy audio. Demucs is our stretch option.

---

## 4. Architecture

```
┌─────────────────┐   ┌──────────────┐
│  Web Editor     │   │ Telegram Bot │      ← surfaces
│  (React/Vite)   │   │              │
│      ▸ B        │   │      ▸ A     │
└────────┬────────┘   └──────┬───────┘
         │  REST + SSE       │
         └─────────┬─────────┘
                   ▼
         ┌───────────────────┐
         │  FastAPI backend  │              ← A
         └─────────┬─────────┘
                   ▼
         ┌───────────────────┐
         │  pipeline.run()   │  yields ProgressEvent
         └─────────┬─────────┘
                   ▼
   ingest → probe → [denoise] → chunk → STT ×N ∥ → segments[]  ⟵ CACHED
                                            │
   instruction → [sarvam-105b json_schema] ─┴→ Plan(ops[])
                                            │
              ┌─────────────── Executor ────────────────┐
              │ find → trim → denoise → concat          │
              │      → dub (Sarvam Dub) → export        │
              └─────────────────┬───────────────────────┘
                                ▼
                     result.mp4 / .mp3 (+ .srt)
```

**Three executor rules worth hard-coding:**
- **Skip transcription entirely** when the plan has no `find` and no `denoise` (cases 2, 5) — Sarvam Dub transcribes internally. Big latency win.
- **Hoist `denoise` before transcription** when a plan has both `denoise` and `find` — cleaner audio transcribes better *and* the output is clean. One pass, two benefits. Fixes the reference implementation's ordering bug.
- **Always trim before dubbing** — dub cost and latency scale with output minutes.

**Why a plan object, not a tool-calling loop:** one structured call, renders as a checklist that ticks off live, every op is deterministic Python. A bad LLM response degrades into a fixable plan, not a hung loop.

---

## 5. 🔗 API contract — the interface between A and B

**Agree on this in the first 30 minutes, together, before splitting.** She builds entirely against static fixtures until the backend is live, then swaps one base URL. This is the single most important coordination decision in the project — get it wrong and one of you blocks the other for hours.

```
POST /api/ingest            {url} | multipart file  → {job_id, media_id}
GET  /api/media/{media_id}  → the video/audio bytes (MUST support HTTP Range)
GET  /api/transcript/{media_id} → {language, duration, segments:[...]}
POST /api/instruct          {media_id, instruction}  → {job_id}
GET  /api/events/{job_id}   → SSE stream of ProgressEvent
GET  /api/result/{job_id}   → {clips:[...], output_url, srt_url, plan}
GET  /api/download/{job_id} → final file
```

**Core shapes — freeze these early:**
```jsonc
// Segment
{"id": 12, "start": 83.4, "end": 91.2, "text": "So when I visited India..."}

// ProgressEvent (SSE `data:` payload)
{"stage": "transcribe", "status": "done", "message": "14 segments, en-IN", "pct": 40}

// Clip (a located match)
{"start": 83.0, "end": 99.6, "reason": "Speaker describes his India trip",
 "confidence": 0.91, "segment_ids": [12, 13, 14]}

// Plan
{"reasoning": "...", "ops": [{"op":"find","args":{...}}, ...],
 "unsupported_language": null}
```

**Fixtures she works against from minute 30:** `fixtures/transcript.json`, `fixtures/result.json`, `fixtures/events.jsonl`, plus `public/sample.mp4`. A generates real versions as soon as the engine runs and drops them in the same place — she changes nothing but the base URL.

> ⚠️ **HTTP Range support is mandatory** on `/api/media/`. Without it the `<video>` element cannot seek, and seeking *is* the demo. Starlette's `FileResponse` handles Range in current versions — verify explicitly with `curl -r 0-100 -D -`. If it fails, mount the media dir with `StaticFiles` or hand-roll a 206 response.

---

## 6. Repo layout

```
ClipCraft/
├── Plan.md                     ← this document
├── .env.example                # SARVAM_API_KEY, TELEGRAM_BOT_TOKEN
├── requirements.txt
│
├── server.py                   # FastAPI app + SSE            ▸ A
├── cli.py                      # dev loop + demo fallback     ▸ A
├── bot.py                      # Telegram bot                 ▸ A
├── smoke_test.py               # hour-0 API verification      ▸ A
│
├── clipcraft/                                                    ▸ A
│   ├── config.py               # models, per-API lang tables, paths
│   ├── sarvam.py               # STT/chat/translate/TTS + retry
│   ├── dubbing.py              # Sarvam Dub job lifecycle
│   ├── media.py                # ingest, ffmpeg, ffprobe, chunking
│   ├── transcribe.py           # parallel STT + timeline stitch + cache
│   ├── agent.py                # planner + locator
│   ├── ops.py                  # op registry
│   └── pipeline.py             # orchestrator → ProgressEvent
│
├── web/                                                       ▸ B
│   ├── index.html
│   ├── src/
│   │   ├── main.jsx
│   │   ├── App.jsx
│   │   ├── api.js              # ONLY file that knows about the backend
│   │   ├── components/
│   │   │   ├── VideoPlayer.jsx
│   │   │   ├── Timeline.jsx        # wavesurfer + regions
│   │   │   ├── TranscriptPanel.jsx
│   │   │   ├── InstructionBar.jsx
│   │   │   ├── AgentPanel.jsx
│   │   │   ├── ClipList.jsx
│   │   │   └── ExportBar.jsx
│   │   └── fixtures/           # static JSON — her dev harness
│   └── package.json
│
├── assets/  sh.rnnn · sample.mp4 · sample.mp3   (COMMIT ALL)
└── cache/   transcript JSON by file hash        (COMMIT demo ones)
```

**The file split is the merge-conflict strategy.** A never touches `web/`, B never touches `clipcraft/`. Only `Plan.md` and the API contract are shared, and those get frozen early. Work on `main`, push often, no branches needed.

---

## 7. 👥 Work division

### 🅰️ You — Engine + Backend + Telegram
> Owns: `clipcraft/`, `server.py`, `cli.py`, `bot.py`, `smoke_test.py`
> Never touches `web/`.

| # | Task | Detail |
|---|---|---|
| A0 | **`smoke_test.py`** | 🔥 First thing. Blocks both of you. See §8. |
| A1 | `media.py` ingest | URL / yt-dlp / upload; probe kind+duration; extract 16k mono wav |
| A2 | `media.py` chunking | `silencedetect` → ≤28s chunks. **The hardest single function.** |
| A3 | `transcribe.py` | Parallel STT + **offset stitching** + hash cache |
| A4 | **Emit real fixtures** | Hand her a real `transcript.json` + `sample.mp4` — this unblocks her |
| A5 | `agent.py` | Planner + locator, both JSON-schema'd |
| A6 | `ops.py` + `pipeline.py` | Op registry, executor rules, ProgressEvent generator |
| A7 | `server.py` | FastAPI + **Range-capable media serving** + SSE — this is what *her* UI talks to |
| A8 | `bot.py` — **Telegram** | Your demo surface. See §10a. |
| A9 | `dubbing.py` | Sarvam Dub lifecycle + watermark retry + manual fallback |

**Ordering note:** `server.py` ships *before* you polish the bot. She is blocked on the backend; nobody is blocked on Telegram. Get her unblocked first, then make your own surface nice.

### 🅱️ Teammate — Web Video Editor
> Owns: `web/` entirely. Never touches `clipcraft/`.
> Full spec in §10 — layout diagram, wavesurfer code, component notes, fallback ladder.

| # | Task | Detail |
|---|---|---|
| B0 | Scaffold | `npm create vite@latest web -- --template react` + Tailwind + `npm i wavesurfer.js` |
| B1 | Layout shell | Editor chrome: player left, transcript right, timeline bottom, instruction bar top |
| B2 | `VideoPlayer` | HTML5 `<video>`, play/pause/seek, current-time lifted to `App` |
| B3 | `Timeline` | **wavesurfer.js v7** + Regions + Timeline plugins. 🔥 **The centrepiece — start here after the shell.** |
| B4 | `TranscriptPanel` | Click line → seek. Active line highlights + auto-scrolls. |
| B5 | `InstructionBar` | Text input + 3 example chips + Run button |
| B6 | `AgentPanel` | Consume SSE, render ops as a checklist ticking off live |
| B7 | `ClipList` | Match cards: time range, reason, confidence, "preview" button |
| B8 | `ExportBar` | Download result + SRT; result `<video>` preview |
| B9 | Polish | Loading skeletons, error toasts, empty states, dark theme |

**She works entirely against `web/src/fixtures/*.json` + `public/sample.mp4` from minute 30.** She should not wait for the backend, and should not make live Sarvam calls at all. When `server.py` lands, she flips one constant in `api.js` and everything should just work — that's the whole point of freezing the contract first.

**Her highest-value 90 minutes are B3 (wavesurfer timeline) + B4 (clickable transcript).** Those two together are what make it read as a real video editor rather than a form with a video on it. If she runs short on time, B9 polish goes before B3/B4 ever do.

### Shared / together
- **First 30 min:** freeze the API contract in §5. Both read it aloud. Write the fixture files together — this is the highest-leverage half hour of the day.
- **Integration checkpoints at hour 3 and hour 5.** Point her `api.js` at `localhost:8000`, fix mismatches, revert to fixtures if the backend isn't ready. Timebox each to 20 minutes.
- **Last hour:** rehearse the demo twice, end to end, on the venue network — *both* surfaces.

### Coordination rules
1. **One Sarvam API key, 60 req/min shared.** If you both hammer STT you'll hit 429s. She uses fixtures, not live calls — a second reason for fixture-first. *(Two keys would remove this constraint entirely — worth asking the organisers.)*
2. **She never blocks on you.** Fixtures always work. If the backend dies mid-demo, her UI still runs — that's itself a fallback demo.
3. `api.js` is the **only** file that knows the backend exists. One-line switch between fixture and live mode.
4. Disjoint file ownership means near-zero merge conflicts. Work on `main`, push every ~45 min, small commits.
5. Agree the **language codes and op names** once (§2, §9) — those strings appear in both codebases and a silent mismatch there is the classic 2am integration bug.

---

## 8. Step 0 — Setup (both, ~20 min)

```bash
sudo apt update && sudo apt install -y ffmpeg
uv venv && source .venv/bin/activate
uv pip install sarvamai fastapi "uvicorn[standard]" python-multipart \
               yt-dlp requests python-dotenv "python-telegram-bot[job-queue]"
curl -Lo assets/sh.rnnn https://raw.githubusercontent.com/GregorR/rnnoise-models/master/somnolent-hogwash-2018-09-01/sh.rnnn
cd web && npm create vite@latest . -- --template react && npm i wavesurfer.js
```
No sudo? `uv pip install static-ffmpeg`.

### `smoke_test.py` — resolve the five unknowns 🔥
Nothing else gets built until these are green:

1. **Chat + injected `response_format`** — does the server honour `json_schema` via `additional_body_parameters`? If no → `json_object`.
2. **A real dubbing job on a 5-second clip** — is dubbing enabled, is `disable_watermark=True` allowed, **how long does a job take?** Highest-value test in the build; the whole dub op design depends on it.
3. **`saaras:v4` vs `v3`** on the actual test mp3 — quality, and whether v4 accepts `mode` (docs contradict themselves).
4. **`with_timestamps=True`** — is `timestamps.start_time_seconds` populated and chunk-aligned?
5. Translate + TTS round-trip.

---

## 9. Engine specs (A)

### `media.py`
**Ingest, dispatched by inspection:**
- Local path / upload → use directly
- URL with media extension, or `audio/*`/`video/*` on HEAD → `requests` stream; sniff extension from `Content-Type`
- Otherwise (YouTube/Shorts) → `yt-dlp` with the android player_client
- Reject >15 min up front

**`plan_chunks(wav) -> [(start, end)]` — the hardest function in the project.**
Run `ffmpeg -i a.wav -af silencedetect=noise=-30dB:d=0.4 -f null -`, parse `silence_start`/`silence_end` from **stderr**, greedily accumulate to **28s**, cut at the silence midpoint nearest the limit, hard-cut at 28s where no silence exists. Fixed 30s cuts slice words in half and wreck accuracy *and* timestamps.

**Cutting** (accurate, re-encoded, ≤720p CRF 24 → stays under Telegram's 50MB):
```bash
ffmpeg -y -ss START -to END -i in.mp4 -c:v libx264 -preset veryfast -crf 24 -c:a aac clip.mp4
```
**Concat** (identical codec params → stream copy is safe):
```bash
ffmpeg -f concat -safe 0 -i list.txt -c copy supercut.mp4
```
**Denoise:** `arnndn=m=assets/sh.rnnn`; fallback `afftdn=nr=20:nf=-25`.

### `transcribe.py`
1. **Hash file → return `cache/<hash>.json` if present.** Do this first. Test cases 1-3 share one mp3, so cases 2 and 3 become instant — and judges can throw live instructions at an already-transcribed file with zero wait.
2. `plan_chunks()` → slice
3. `ThreadPoolExecutor(max_workers=6)` — stays under 60 req/min
4. **Add each chunk's offset to every timestamp.** ⚠️ *The #1 place bugs hide. If timestamps look like they reset to zero, it's this line.*
5. Flatten → `Segment(id, start, end, text)`, re-index, cache

Sarvam timestamps are phrase-level, which is *better* than word-level here: cuts land on phrase boundaries natively, so the reference implementation's whole "backtrack to sentence start" step mostly disappears.

### `agent.py`
**Planner** (via `additional_body_parameters`):
```json
{
  "reasoning": "Isolate the credit-card mention, then dub to Hindi.",
  "ops": [
    {"op":"find","args":{"query":"reads out a credit card number","max_clips":3}},
    {"op":"trim","args":{"padding_seconds":0.4}},
    {"op":"dub","args":{"target_language_code":"hi-IN","voice_cloning":true}},
    {"op":"export","args":{}}
  ],
  "unsupported_language": null
}
```
System prompt carries the op vocabulary + the 12 dubbable codes. Validate ops against the registry, drop unknown ones — **never `eval` the plan**.

**Locator** over the numbered transcript:
```
[12] 01:23→01:31  So when I visited India last year...
```
→ `{"clips":[{"start_id":12,"end_id":15,"reason":"...","confidence":0.9}]}`. IDs → timestamps, clamped. One call handles semantic queries *and* misspelled quotes.

### `dubbing.py`
`create` → `PUT` bytes (with `x-ms-blob-type: BlockBlob`) → `start` → poll `get_live_status` every 3s (hard timeout ~5 min, surface `progress` + `current_step_label`) → `get_export_status` → fetch `download_url`. On 4xx mentioning watermark, retry once with `disable_watermark=False`.

**Fallback engine (`--dub-engine manual`):** per-segment `translate()` + `bulbul:v3` TTS, tempo-fitted with `atempo` **clamped to 1.6** (beyond that it's chipmunk), assembled via `adelay` + `amix=normalize=0` (**the default halves every input's volume**). Worse quality, no voice cloning, but fully synchronous. One-word switch on stage.

---

## 10. Frontend spec (B)

### The layout
```
┌────────────────────────────────────────────────────────────┐
│  ClipCraft   [ "trim where he talks about India, in Hindi" ] ▶ │
├──────────────────────────────────┬─────────────────────────┤
│                                  │  TRANSCRIPT             │
│                                  │  ▸ 00:12 So when I...   │
│         VIDEO PLAYER             │  ▸ 00:19 the scale of.. │  ← click = seek
│                                  │  ▸ 00:27 ...           │  ← active highlights
│                                  ├─────────────────────────┤
│                                  │  AGENT                  │
│                                  │  ✅ Transcribed (14)    │
│                                  │  ✅ Plan: find→trim→dub │
│                                  │  ⏳ Dubbing… 60%        │
├──────────────────────────────────┴─────────────────────────┤
│  ═══▓▓▓▓▓═════════▓▓▓▓▓▓▓═══════════════  waveform         │  ← matches
│  0:00        0:30        1:00        1:30                   │     glow here
├────────────────────────────────────────────────────────────┤
│  MATCHES   [0:12-0:19  "reads card number"  91%]  [Export] │
└────────────────────────────────────────────────────────────┘
```

### The centrepiece: `Timeline` with wavesurfer.js v7
This is what makes it read as a *video editor* rather than a dashboard.

```js
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'
import TimelinePlugin from 'wavesurfer.js/dist/plugins/timeline.esm.js'

const regions = RegionsPlugin.create()
const ws = WaveSurfer.create({
  container: '#wave',
  media: videoRef.current,     // ⭐ drives the SAME <video> element
  waveColor: '#3f3f46', progressColor: '#6366f1',
  height: 96,
  plugins: [regions, TimelinePlugin.create()],
})
// when clips arrive from the agent:
clips.forEach(c => regions.addRegion({
  start: c.start, end: c.end, color: 'rgba(99,102,241,.28)', drag: true, resize: true,
}))
```

**Passing `media: videoElement` is the key trick** — waveform scrubbing and the video stay in sync automatically, with no manual `currentTime` plumbing.

**Regions are draggable/resizable**, which means the human can *correct the AI's cut* before exporting. Say that out loud in the demo: *"and if the agent is slightly off, you just drag it."* That single sentence is what turns "AI toy" into "editing tool" for a judge.

**Perf note:** decoding a large video's audio in-browser is slow. If it lags, have A return pre-computed peaks and pass `peaks: [...]` + `duration` to skip decoding entirely.

### Component notes
- **`TranscriptPanel`** — active line from `currentTime` via binary search over segments. Auto-scroll with `scrollIntoView({block:'center'})`, but **suppress auto-scroll for ~1s after a manual scroll** or it fights the user. Clicking a line seeks.
- **`AgentPanel`** — `new EventSource('/api/events/'+jobId)`. Render each op as a row: pending → spinner → ✅. Show `reasoning` in a collapsible.
- **`ClipList`** — cards with time range, `reason`, and a confidence bar. "Preview" sets the player to that range. This is where the agent *justifies itself*, and it's very persuasive on stage.
- **`InstructionBar`** — three clickable example chips so a judge can try it without typing.

### Frontend fallback ladder
1. React + Vite + Tailwind + wavesurfer *(target)*
2. Drop Tailwind → plain CSS, keep wavesurfer
3. Drop wavesurfer → CSS-gradient timeline with absolutely-positioned match blocks (no waveform, still reads as a timeline; ~40 min)
4. Drop React → single `index.html` + vanilla JS
5. Streamlit page over `pipeline.run()` — dashboard, not editor, but works

---

## 10a. Telegram bot spec (A)

`python-telegram-bot` v22.8, asyncio. **The pipeline is blocking — run it via `asyncio.to_thread` and never block the event loop.** One bot, one `pipeline.run()`, same engine the web editor uses.

Token from **@BotFather** → `/newbot` → `.env`.

**Handlers:**
- `/start`, `/help` — three copy-pasteable example instructions
- **Text containing a URL** → instruction is the rest of the message
- **Attachment** (audio / video / voice / document) → instruction is the caption
- **Attachment with no caption** → stash in `context.user_data`, reply *"what should I do with it?"*, use the next text message
- **Attachment >20MB** → *"that's over Telegram's bot limit — send me a link instead"*

**Live progress is your demo.** Post one status message and `edit_message_text` it as `ProgressEvent`s arrive:
```
🎬 ClipCraft
✅ Downloaded (0:38 audio)
✅ Transcribed — 14 segments, detected en-IN
✅ Plan: find → trim → dub
✅ Found 1 match (0:12–0:19) — "reads out the card number"
⏳ Dubbing to Hindi (voice cloning)… translating 60%
```
Wire the dub job's `progress` and `current_step_label` straight into that line so it never looks frozen.

Then `send_video` / `send_audio`, captioned with what was done and *why that segment was chosen*, plus the SRT as a second attachment.

**Limits to respect:** bots download ≤20MB, upload ≤50MB. Encoding at ≤720p/CRF 24 keeps clips at ~3-5MB for 30s, comfortably under. URL-first ingestion sidesteps the download cap entirely — and every instruction in the test matrix is a URL, so this isn't a compromise.

**Why this is worth building even though the web editor is primary:** it's a completely independent path to the same result. Different transport, different failure modes, same engine. On stage it also lands a point the web app can't — *"and it works from my phone, in the chat app I already use."*

---

## 11. Milestones

Each is independently demoable — stop anywhere and you still have something.

| Hr | 🅰️ You | 🅱️ Teammate | Joint |
|---|---|---|---|
| 0.0 | — | — | **Freeze API contract §5, write fixtures together** |
| 0.5 | `smoke_test.py` 🔥 | Vite scaffold + layout shell | |
| 1.5 | ingest + chunking | Player + **wavesurfer timeline** | |
| 2.5 | **transcript + cache working** → hand her real fixtures | Transcript panel + click-to-seek | |
| 3.0 | | | **⭐ Integration checkpoint 1** *(20 min, timeboxed)* |
| 3.5 | planner + locator | Instruction bar + agent panel | |
| 4.5 | **find→trim→export end-to-end** | Clip list + export bar | |
| 5.0 | **`server.py` — unblocks her** | | **⭐ Integration checkpoint 2 — full loop** |
| 6.0 | **`bot.py` Telegram** | polish, dark theme, errors | |
| 7.0 | dubbing wired into both surfaces | loading/empty states | |
| 7.5 | denoise + supercut | final polish | |
| 8.0 | | | **Rehearse twice on the venue network — both surfaces** |

**Hard rule: full loop (ingest → transcript → instruct → clip → export) by hour 5.** Dubbing is upside. If you're behind, cut dubbing before cutting the loop — an editor that trims by voice command is already a complete product.

**Second hard rule: `server.py` ships before `bot.py` is polished.** She is blocked on the backend; nobody is blocked on Telegram. Unblock her first — a teammate idle at hour 5 costs far more than a rough bot.

---

## 12. B-plans

| If this breaks | Do this |
|---|---|
| Dubbing gated/watermarked/slow | `--dub-engine manual` (translate + Bulbul + atempo) |
| `response_format` rejected | `json_object` + prompt schema → raw `requests` to `/v1/chat/completions` |
| `saaras:v4` misbehaves | `saaras:v3` (smoke test decides at hour 0) |
| Chunking produces bad timestamps | Fall back to fixed 28s chunks; accept mid-word cuts |
| STT too slow / rate-limited | Drop to 3 workers; pre-cache demo transcripts |
| YouTube blocked | Upload + direct-URL paths unaffected; `assets/sample.mp4` |
| ffmpeg concat glitches | concat *filter* with re-encode instead of demuxer copy |
| `arnndn` sounds bad | `afftdn=nr=20:nf=-25` + `highpass=200,lowpass=3000` |
| wavesurfer too slow | Server-computed peaks → fallback ladder §10 |
| SSE flaky | Poll `GET /api/jobs/{id}` every 1s instead |
| Backend down at demo | Her UI runs on fixtures — **rehearse this path too** |
| Venue wifi dies | Committed `assets/` + `cache/*.json` → zero network demo |
| Everything on fire | `cli.py` + pre-rendered output files + screen recording |

**Record a screen capture of a full successful run the moment one works.** Cheapest insurance in the building.

---

## 13. Experiments worth running

Small, timeboxed, each answers a real question:

1. **`saaras:v3` vs `v4`** on the ElevenLabs test mp3 — WER by eye, and does v4 accept `mode`? *(hour 0, 10 min)*
2. **Dubbing latency vs clip length** — 5s / 30s / 2min. Determines whether we always trim first. *(hour 0, 15 min)*
3. **`voice_cloning=True` vs `False`** — is cloning good enough to be the headline, or does it sound worse? *(hour 6)*
4. **`silencedetect` thresholds** — `-30dB/0.4s` vs `-35dB/0.25s` on speech vs noisy audio. *(hour 1)*
5. **Locator prompt: phrase list vs full text + index** — which finds "I am a moster" more reliably? *(hour 3)*
6. **`register` presets** — does `modern-colloquial` beat `formal` for Hindi dubs on casual content? *(hour 6, free A/B)*
7. **Multi-language in one dub job** — `target_language_codes=["hi-IN","ta-IN","te-IN"]`. If it works, it's a great closing flourish. *(hour 7)*
8. **`num_speakers` > 1** on the multi-speaker test clip — does diarization improve the dub? *(stretch)*

---

## 14. Risks

| Risk | Mitigation |
|---|---|
| ffmpeg missing (**confirmed**) | `apt install ffmpeg` first; `static-ffmpeg` if no sudo |
| Sample mp4 403 (**confirmed, whole bucket**) | `yt-dlp` a CC video once, **commit `assets/sample.mp4`** |
| `response_format` unsupported by SDK (**confirmed**) | `additional_body_parameters`; `json_object` fallback |
| `or-IN`/`od-IN` mismatch (**confirmed**) | Canonical table in `config.py`; validate against op-chain intersection |
| Timestamp offset stitching | The known bug hotspot — assert `last.end ≈ duration` |
| No Range support on media endpoint | Video can't seek = no demo. Verify with `curl -r 0-100 -D -` |
| Two people, one API key, 60 req/min | She uses fixtures, not live calls |
| Merge conflicts | Disjoint file ownership; only `Plan.md` shared |
| Integration left to the end | Two mandatory checkpoints, hours 3 and 5 |
| Dubbing too slow live | Always trim first; pre-run one dub before presenting |
| Telegram 20MB download cap | URL-first flow; explicit message on oversized uploads |
| Malformed plan from LLM | Validate against registry; default plan fallback |
| Scope creep | Hour-5 hard rule: full loop before dubbing |

---

## 15. Verification

**Engine (A):**
1. `smoke_test.py` → 5 green, dubbing job time printed
2. `cli.py -i <mp3 url> --probe` → `AUDIO`, ~16s
3. Chunks all ≤28s, contiguous, covering full duration
4. Timestamps monotonic; **`segments[-1].end ≈ duration`**
5. All 7 matrix instructions (Spanish→Hindi) return playable files — open each in a real player
6. Case 1 by ear: does the clip start at the card number?
7. Case 3: is the dubbed voice recognisably the original speaker?
8. Case 7: right segment *and* audibly cleaner?
9. Unsupported language → supported list, no crash
10. Re-run same mp3 → cache hit, zero STT calls
11. Cases 2, 5 → transcription skipped entirely
12. `--dub-engine manual` → still produces valid output
13. `curl -r 0-100 -D - localhost:8000/api/media/<id>` → **206 Partial Content**

**Frontend (B):**
14. Video seeks by clicking the waveform
15. Clicking a transcript line seeks; active line highlights and auto-scrolls
16. Agent panel ticks off ops live from SSE
17. Match regions render on the timeline and are draggable
18. Export downloads a file that plays
19. Works in Chrome *and* whatever is on the presentation machine
20. Runs entirely on fixtures with the backend stopped

**Joint:**
21. Full loop on the real venue network, twice, timed

---

## 16. Demo script (~3 min)

1. **Hook** *(15s)* — "Editing video means scrubbing timelines. We made it a sentence."
2. Paste the YouTube Shorts URL → waveform + transcript populate. *(20s)*
3. Type **"trim the part where he speaks about Anderson and dub it to Hindi"** → hit Run. *(10s)*
4. **The moment:** agent panel ticks off `find → trim → dub`, and the matched region lights up on the timeline. Point at it. *(30s)*
5. Show the match card — *"it tells you why it picked this"*. *(15s)*
6. **Drag the region edge** — *"and if it's slightly off, you just fix it. It's a real editor."* *(15s)*
7. Play the Hindi dub. *"That's Sarvam's voice cloning — same speaker, different language."* *(25s)*
8. Export. Show the SRT came free. *(10s)*
9. **Closer** — send the same instruction from Telegram on your phone, result comes back in chat. *(20s)*
10. One line on the stack: five Sarvam APIs — Saaras, sarvam-105b, Translate, Bulbul, Dub.

**Pre-flight:** transcript pre-cached · one dub pre-run · sample committed · screen recording ready · backend AND fixture mode both rehearsed.

---

## 17. Stretch (only after the matrix passes)

- **Multi-language dub in one job** — `target_language_codes` takes a list; return Hindi + Tamil + Telugu together. Great closer, nearly free.
- Burned-in subtitles from the SRT the dub job already returns
- Multi-clip **supercut** across the whole video
- Editable transcript → re-cut from text (the Descript move)
- Demucs vocal isolation to match ElevenLabs quality (heavy: torch, slow on CPU)
- Speaker diarization via `speech_to_text_job` so *"where **he** says"* resolves to a real speaker
- Undo/redo stack on the regions
- Shareable result link

---

## 18. Open questions

1. Is dubbing enabled on the hackathon key, and is `disable_watermark` allowed? → **smoke test #0**
2. Does the server honour injected `response_format`? → **smoke test #0**
3. `saaras:v4` or `v3`? → **smoke test #0**
4. **Does your teammate know React?** If not, drop to fallback ladder rung 4 (vanilla JS + Tailwind CDN) immediately — decide this at hour 0, not hour 4. The wavesurfer timeline works identically either way, and it's the part that matters.
5. Is there a submission format (repo link, video, live demo)? Confirm with organisers early; it changes what "done" means.
6. One API key or two? Two would remove the shared rate-limit constraint entirely.
