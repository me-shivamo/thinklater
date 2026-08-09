# 🎬 ClipIt — Natural-Language Video Editor Agent

Tell it what you want in plain English. It finds the moment, cuts it, cleans it,
and dubs it into an Indian language — and tells you *why* it picked that segment.

> **"Trim the part where he talks about India and dub it in Hindi."**

Built on five Sarvam APIs: **Saaras** (speech-to-text), **sarvam-105b** (planning
and segment location), **Sarvam Translate**, **Bulbul** (TTS) and **Sarvam Dub**
(dubbing with speaker voice cloning).

---

## What it does

| Instruction | What happens |
|---|---|
| "Trim the part where it tells the credit card number" | find → trim |
| "Dub the audio in Hindi" | dub (transcription skipped entirely) |
| "Trim the credit card part and dub it in Hindi" | find → trim → dub |
| "Remove background noise from this audio" | denoise |
| "Remove the noise from the part where he says 'I am a moster'" | denoise → find → trim |
| "After he says Amazon, insert the word 'Sarvam'" | insert |
| "Insert 'Sarvam' after Amazon, then trim the company list" | insert → find → trim |

Ops compose freely — the agent decides the chain, you don't pick from a menu.

`insert` is the one op that *adds* rather than removes: it speaks the new words
with Bulbul and splices them in next to an anchor you name. On video the frame
at the insertion point is held for exactly the length of the new audio, so
everything after it stays in sync with the picture.

**Input:** YouTube link · direct audio/video URL · uploaded file
**Output:** trimmed / denoised / dubbed / augmented MP4 or MP3, plus an SRT when dubbing.

---

## Quick start

```bash
sudo apt install -y ffmpeg          # or: pip install static-ffmpeg
uv venv && source .venv/bin/activate
uv pip install -r requirements.txt

cp .env.example .env                # add SARVAM_API_KEY + TELEGRAM_BOT_TOKEN
```

**Telegram bot**
```bash
python bot.py
```
Send it a link or a file with an instruction. It edits one status message as it
works, then sends the result back with the reason it chose that segment.

**CLI** (faster dev loop, and the demo fallback)
```bash
python cli.py -i "https://youtu.be/…" -q "trim the part about India and dub it in Hindi"
python cli.py -i sample.mp3 --probe
python cli.py --dub-engine manual -i sample.mp3 -q "dub this in Tamil"   # ~10x faster
```

---

## How it works

```
instruction ──→ sarvam-105b (json_schema) ──→ Plan(ops)
media ──→ ingest ──→ probe ──→ [denoise] ──→ silence-aware chunks
                                    │
                          Saaras ×N in parallel ──→ segments on a global timeline
                                    │                        (cached by file hash)
              find → trim → denoise → concat → dub → export
                                    │
                          result.mp4 / .mp3 (+ .srt)
```

Three scheduling rules that matter:

1. **`denoise` is hoisted before transcription** when the plan also needs `find` —
   cleaner audio transcribes better, and one filter pass serves both.
2. **Transcription is skipped entirely** for whole-file dubs; Sarvam Dub
   transcribes internally.
3. **Trim always happens before dub** — dub cost and latency scale with output
   length.
4. **`insert` is hoisted ahead of everything** so it runs against the media the
   transcript actually describes. Later ops are re-timed through
   `_shift_for_inserts`, and segments the insertion lands inside are split at
   that point so a following dub doesn't talk over the new words.

---

## Notes from building this

Things that are true but not obvious from the docs:

- **Sarvam returns exactly one timestamp span per STT request** (both `saaras:v3`
  and `v4`). Chunk-level timestamps are *per request*, not per phrase — so your
  chunk size **is** your timestamp resolution. ClipIt sizes chunks adaptively
  (4–18s) for precision rather than packing them to the 30s API ceiling.
- **`chat.completions()` doesn't expose `response_format`** in `sarvamai` 0.1.30,
  though the API supports it. Inject it via
  `request_options={"additional_body_parameters": {...}}`.
- **`sarvam-translate:v1` accepts `mode="formal"` only**, and rejects
  `source_language_code="auto"` — pass a real code.
- **TTS takes `language_code`**, not `target_language_code`.
- **The `speaker` enum in `sarvamai` 0.1.30 is the bulbul:v2 list.** `abhilash`,
  `karun`, `hitesh`, `anushka`, `manisha`, `vidya` and `arya` are legal values
  of the SDK type and a hard 400 against `bulbul:v3`; v3 also serves voices the
  enum omits (`niharika`). `config.resolve_speaker()` gates every TTS call.
- **There is no standalone voice-cloning API.** Cloning exists only as
  `dubbing.create(voice_cloning=True)` over a whole file — `voice_id` is the
  *preset* used when cloning is off, not a handle to a voice you cloned. So
  `insert` speaks in a preset Bulbul voice, not the original speaker's.
- **`loudnorm` outputs at 192 kHz** unless you pin `-ar`, which quietly makes
  intermediate WAVs 4x larger than expected.
- **Odia is `or-IN` in the Dubbing API and `od-IN` everywhere else.** Assamese is
  dubbable but not TTS-able. Four APIs, four language sets — all mapped in
  `clipit/config.py`.
- **Dubbing exports finish *after* the job reports 100%** — poll `export-status`
  until the items carry `download_url`.
- `amix` halves every input's volume unless you pass `normalize=0`.

---

## Layout

```
clipit/config.py      model ids, per-API language tables, limits
clipit/sarvam.py      API wrappers, retry/backoff, JSON-schema chat
clipit/media.py       ingest (URL/yt-dlp/file), ffmpeg, silence chunking
clipit/transcribe.py  parallel STT, timeline stitching, disk cache
clipit/agent.py       planner + locator
clipit/dubbing.py     Sarvam Dub lifecycle + local TTS fallback
clipit/pipeline.py    orchestrator, streams ProgressEvent
bot.py                Telegram bot
cli.py                CLI
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SARVAM_API_KEY` | — | required |
| `TELEGRAM_BOT_TOKEN` | — | required for the bot |
| `CLIPIT_DUB_ENGINE` | `auto` | `auto` \| `sarvam` \| `manual` |
| `CLIPIT_STT_MODEL` | `saaras:v3` | or `saaras:v4` |
| `CLIPIT_REASONING_EFFORT` | `low` | LLM latency vs depth |
| `CLIPIT_TTS_SPEAKER` | `shubh` | Bulbul voice for manual dub |
