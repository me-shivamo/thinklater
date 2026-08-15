# ClipCraft — Submission Copy

## Tagline

**Edit audio and video by describing the scene. Never touch a timestamp.**

---

## Short version (~90 words — for character-limited fields)

Video editing still forces creators to think in timestamps: scrub, find the
moment, mark in, mark out, repeat. ClipCraft removes that step entirely. You
describe the scene in plain language — *"trim the part where he talks about
India and dub it in Hindi"* — and the agent locates the moment, cuts it,
cleans it, dubs it into an Indian language, and tells you **why** it chose that
segment. Built on five Sarvam APIs, delivered as a real web video editor and a
Telegram bot running on one shared engine.

---

## Full description

### The problem

Every editing tool, from Premiere to the simplest trimmer, asks the same thing
of a creator: *where?* Answering it means scrubbing a timeline, hunting for a
moment you already remember perfectly well, and translating it into two
numbers. The creative intent — "the bit where she says her card number" — is
clear from the start; the timestamps are pure friction. For Indian creators the
friction compounds: the same clip has to ship in four languages, and dubbing is
a separate tool, a separate workflow, and usually a separate voice.

### What we built

ClipCraft is a natural-language video editing agent. You give it a YouTube link, a
media URL, or a file, and one sentence describing what you want. It plans the
edit, performs it, and hands back a finished MP4 or MP3 — plus subtitles when
it dubs, and a written reason for every cut it made.

Four operations, composed freely by the agent rather than picked from a menu:

| You say | It does |
|---|---|
| "Trim the part where it tells the credit card number" | find → trim |
| "Dub the audio in Hindi" | dub |
| "Trim the credit card part and dub it in Hindi" | find → trim → dub |
| "Remove noise from the part where he says 'I am a moster'" | denoise → find → trim |
| "After he says Amazon, insert the word 'Sarvam'" | insert |

Nothing is keyword-matched. Ask for "the part where she introduces herself" and
it finds it, because no rule was ever written for *introduces herself* — the
model reads a timestamped transcript and reasons about it. The misspelling in
that fourth example is deliberate: matching is semantic, so *"moster"* still
lands on *"monster"*.

### How it works

The instruction goes to **sarvam-105b** under a JSON schema, which returns an
ordered plan of operations. In parallel, the media is ingested, probed,
optionally denoised, and split into silence-aware chunks that are transcribed by
**Saaras** concurrently and stitched onto a single global timeline (cached by
file hash, so every follow-up edit on the same file is near-instant). A second
LLM pass locates the requested moment against the numbered transcript and
returns segment ranges, a confidence score, and a plain-English reason. ffmpeg
executes the cut. **Sarvam Dub** handles translation, voice cloning, and SRT
export; **Bulbul** and **Sarvam Translate** power the fast local dub path and
the `insert` operation, which speaks new words and splices them in beside an
anchor phrase you name, stretching the picture across the insertion so audio and
video stay in sync.

The scheduling is where the agent earns its keep. Denoise is hoisted *before*
transcription when the plan also needs to find something, so one filter pass
improves both the transcript and the output. Transcription is skipped entirely
for whole-file dubs, since Sarvam Dub transcribes internally. Trim always
precedes dub, because dubbing cost and latency scale with output length. Cuts
snap to segment boundaries, so a clip never opens mid-word.

### Two surfaces, one engine

- **Web video editor** — waveform timeline with draggable match regions,
  click-to-seek transcript, a live agent panel that streams each stage as it
  runs, match cards showing range/reason/confidence, and one-click export.
- **Telegram bot** — send a link and a sentence, get the edited file back.

Both are thin adapters over the same `pipeline.run()`. The web app's op
checklist is data-driven from the engine's progress stream, so a new operation
appears in the UI with no front-end changes.

### Built entirely on Sarvam

Five APIs: **Saaras** (speech-to-text), **sarvam-105b** (planning and segment
location), **Sarvam Translate**, **Bulbul** (TTS), and **Sarvam Dub** (dubbing
with speaker voice cloning). ffmpeg does the cutting. Nothing else calls out.

Language coverage differs across all four APIs — Odia is `or-IN` in Dubbing and
`od-IN` everywhere else, Assamese can be dubbed but not synthesized — so every
supported set is mapped explicitly and unsupported requests fail with the list
of languages that *would* work, rather than silently.

### Measured results

| Instruction | Total |
|---|---|
| Trim (first run, includes transcription) | ~14s |
| Denoise + trim | ~20s |
| Trim + dub (local TTS path) | ~46s |
| Trim + dub (Sarvam Dub, voice-cloned) | ~5 min |

On a trim, the two LLM calls are ~14s of the total and ffmpeg is 0.2s. On a dub,
the Sarvam Dub job is ~93% of wall time.

### Why it matters

A creator who wants a 10-second clip in four Indian languages currently opens
three tools and spends an afternoon. With ClipCraft it is one sentence, and the
dubbed voice is still recognisably theirs. The timestamp was never the point —
it was just the price of admission. We removed it.
