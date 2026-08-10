# ClipIt — web editor design prompt

Paste the block below into Claude Code (in this repo) to generate the screen design.
Output is a single self-contained HTML mock, published as an Artifact.
Person B then ports it to React components under `web/src/`.

---

Design the primary screen for **ClipIt**, a natural-language video editor. Load the
`artifact-design` skill first, then build a single self-contained HTML page at
`web/design/editor-mock.html` and publish it as an Artifact.

This is a **visual design deliverable**, not the production app. It is a
pixel-accurate, interactive mock that my teammate will port to React + Vite +
Tailwind + wavesurfer.js. Every piece of data is hardcoded — no network calls.

## The product in one sentence

You type "trim the part where he speaks about Anderson and dub it to Hindi", and an
agent finds that moment in the video, cuts it, dubs it into Hindi with the original
speaker's cloned voice, and hands you the file — inside a real editor UI where you
can drag the cut if the AI was slightly off.

The design job: make it read as a **real video editor**, not a form with a video on
it. That distinction is the whole point. Judges see this on a projector for 3 minutes.

## Layout

```
┌─────────────────────────────────────────────────────────────┐
│  ClipIt                    sample.mp4 · 1:47 · en-IN        │
├──────────────────────────────────┬──────────────────────────┤
│                                  │  TRANSCRIPT              │
│                                  │  ▸ 00:12 So when I...    │ ← click = seek
│         VIDEO PLAYER             │  ▸ 00:19 the scale of..  │ ← active line
│                                  ├──────────────────────────┤
│                                  │  CHAT                    │
│                                  │        ┌───────────────┐ │
│                                  │        │ trim where he │ │ ← you
│                                  │        │ talks about…  │ │
│                                  │        └───────────────┘ │
│                                  │  ┌───────────────────┐   │
│                                  │  │ ✅ Transcribed —  │   │ ← agent,
│                                  │  │  14 segments      │   │   one
│                                  │  └───────────────────┘   │   message
│                                  │  ┌───────────────────┐   │   at a
│                                  │  │ ✅ find→trim→dub  │   │   time
│                                  │  └───────────────────┘   │
│                                  │  ⏳ Dubbing to Hindi…    │
│                                  ├──────────────────────────┤
│                                  │ [ ask for another edit ]▶│ ← composer
├──────────────────────────────────┴──────────────────────────┤
│  ═══▓▓▓▓▓═════════▓▓▓▓▓▓▓═══════════════  waveform          │ ← matches glow
│  0:00        0:30        1:00        1:30                   │
├─────────────────────────────────────────────────────────────┤
│  MATCHES   [0:12-0:19  "reads card number"  91%]  [Export]  │
└─────────────────────────────────────────────────────────────┘
```

Treat this as the intended information hierarchy, not a pixel spec — improve the
proportions, spacing and grouping. Target a 1440×900 projector. The video player and
the waveform are the two things a judge's eye should land on first.

## Components to design

1. **Top bar** — thin. Wordmark, and a chip for the loaded media (filename, duration,
   detected language). No instruction input up here: the chat composer is the input.
2. **Video player** — 16:9, transport controls, current time / duration.
3. **Transcript panel** — scrollable list of timestamped lines. Show all three line
   states: default, hovered (clickable → seeks), and active (currently playing,
   highlighted). Lines that fall inside a matched clip need a distinct marker so the
   transcript and timeline visibly agree with each other.
4. **Chat panel** — the heart of the interaction. A conversation, not a checklist.
   Full spec in the next section; it is the most important part of this design.
5. **Timeline / waveform** — the centrepiece. Full-width waveform, time ruler with
   labels, playhead, and matched clips as translucent highlighted regions with
   **visible drag handles on both edges**. The handles must look grabbable — during
   the demo we drag one and say "if the agent is slightly off, you just fix it."
6. **Match cards** — for each located clip: time range, the agent's `reason` text, a
   confidence bar, and a Preview button. This is where the agent justifies itself.
7. **Export bar** — download result + download SRT, plus a small preview of the
   result video. This is the persistent handle on the latest output; the chat also
   surfaces each result inline as it happens. Keep the duplication — the bar is what
   someone reaches for after scrolling the chat up.

## Chat behaviour — the most important part of this design

ClipIt has a second surface: a Telegram bot running the same engine. The web chat
should feel like the same product. Design it as a **conversation that builds
sequentially** — messages arriving one after another as the pipeline runs, never a
single panel that mutates in place.

**Message flow**

- The user's instruction is a message: right-aligned, accent-tinted.
- Every `ProgressEvent` from the engine becomes its own agent message, left-aligned,
  neutral, **appended in arrival order**. Earlier messages are never reordered or
  removed — the chat is the log of what happened.
- One exception to append-only: a message that arrives with `status: "running"`
  renders with a spinner and resolves **in place** to ✅ when its matching `done`
  event lands. So "⏳ Dubbing to Hindi…" becomes "✅ Dubbed to Hindi" without adding
  a second bubble.
- `status: "info"` is a quieter, secondary style — e.g. *"Sarvam Dub unavailable,
  falling back to TTS."* It should read as an aside, not a step.
- `status: "error"` is a red message with a retry affordance.
- The final result is a **rich message**, not a link: an inline preview card with the
  clip, its duration, and Download / Download SRT buttons — mirroring the bot sending
  the file back into the chat.
- Any clip or timestamp mentioned inside a chat message is clickable: it seeks the
  player and highlights the matching region on the timeline.

**Copy — mirror the bot's, so the two surfaces read as one product**

```
✅ Downloaded — 1:47 video
✅ Transcribed — 14 segments, detected en-IN
✅ Plan: find → trim → dub
✅ Found 1 match (0:12–0:19) — "reads out the card number"
⏳ Dubbing to Hindi (voice cloning)…
```

Show the plan's `reasoning` as a collapsible detail under the "Plan:" message.
**There is no percentage available** — progress is status text only. Design the
running state so a 90-second dub never looks frozen without a progress bar.

**Motion and reveal**

- Stagger message appearance by ~150–250ms with a short rise/fade so the sequence
  visibly *builds*. A wall of messages appearing at once loses the whole effect.
- Show a working indicator (pulsing dots) in the agent's slot while a step is running
  and nothing new has arrived.
- Auto-scroll to the newest message, but suppress auto-scroll for ~1s after a manual
  scroll so it never fights someone reading back.
- In the mock, drive this from a hardcoded timed script triggered by Run or by
  clicking an example chip.

**Multi-turn**

The composer stays live after a run finishes. A follow-up like *"now also dub it to
Tamil"* or *"extend the clip 2 seconds earlier"* starts a new turn against the same
media, appended below the previous one. Show at least one completed turn plus a
second turn in progress in the "done" state, so the multi-turn nature is visible in
the design rather than assumed.

**Empty state**

Before any media is loaded, the chat shows a short greeting and three clickable
example chips — a judge should be able to run the demo without typing:

- "Trim the part where it tells the credit card number"
- "Remove background noise and dub it in Hindi"
- "Trim where he speaks about Anderson and dub to Hindi"

## Real data shapes (use these verbatim in the mock)

```jsonc
// Transcript — GET /api/transcript/{media_id}
{"language": "en-IN", "duration": 107.4, "segments": [
  {"id": 12, "start": 83.4, "end": 91.2, "text": "So when I visited India...",
   "words": [{"text": "So", "start": 83.4, "end": 83.6}]}
]}

// Clip (a located match)
{"start": 83.0, "end": 99.6, "reason": "Speaker describes his India trip",
 "confidence": 0.91, "segment_ids": [12, 13, 14]}

// Plan
{"reasoning": "Isolate the Anderson mention, then dub to Hindi.",
 "ops": [{"op": "find", "args": {"query": "...", "max_clips": 3}},
         {"op": "trim", "args": {}},
         {"op": "dub", "args": {"target_language_code": "hi-IN", "voice_cloning": true}},
         {"op": "export", "args": {}}],
 "unsupported_language": null}

// ProgressEvent (SSE payload) — note: NO pct field
{"stage": "transcribe", "status": "done", "message": "14 segments, en-IN"}
```

Op vocabulary: `find · trim · denoise · translate · dub · concat · export`
Event stages: `plan · ingest · denoise · transcribe · find · trim · concat · dub · export · done · error`
Event statuses: `running · done · error · info`

Populate the mock with a plausible ~1:47 video transcript of 14 segments and **two**
matched clips (one high confidence ~0.91, one lower ~0.64) so the confidence bar and
the multi-clip supercut case are both visible in the design.

## Three states, one page

Put a small unobtrusive state switcher in a corner (it is a design tool, not part of
the product) that flips the whole screen between:

1. **Empty** — no media loaded. URL / drag-drop ingest affordance, transcript and
   timeline in empty state, chat showing its greeting and the three example chips.
2. **Running** — media loaded, transcript populated, chat mid-stream: the user
   message plus the ingest / transcribe / plan / find messages settled, and the `dub`
   message spinning at the bottom with the working indicator.
3. **Done** — one full turn in the chat ending in a result card, matches on the
   timeline, match cards populated, export bar active — plus a second follow-up turn
   just starting, to show multi-turn.

Also include the two states that will otherwise be forgotten: **error** (a failed
step as a red message plus a toast) and **unsupported language** (the agent replies
in chat with the supported language list instead of running the plan).

## Hard constraints

- **Single file, fully self-contained.** Inline all CSS and JS. No CDN, no external
  fonts, no remote images — a strict CSP blocks every external request.
- **Do not try to import wavesurfer.js.** It cannot load in an artifact. Hand-draw
  the waveform as inline SVG or canvas from a hardcoded peaks array — it only needs
  to look right. Leave a comment marking where real wavesurfer regions plug in.
- **No video file either.** Use a CSS-rendered poster frame placeholder in the player.
- Dark editor theme is the target (this is a video tool). Suggested starting palette
  from the wavesurfer config we'll use in production: waveform `#3f3f46`, progress /
  accent `#6366f1`, region fill `rgba(99,102,241,.28)`. Refine as you see fit, but
  keep the accent consistent between the timeline regions, the active transcript
  line, and the confidence bars — that visual link is what makes the three panels
  read as one instrument.
- Follow the artifact theme rules: define the full palette on bare `:root`, redefine
  under both `@media (prefers-color-scheme: dark)` guarded with
  `:root:not([data-theme="light"])` and `:root[data-theme="dark"]`, and give `body`
  an explicit token background.
- Nothing may scroll the page horizontally; the waveform scrolls inside its own
  `overflow-x: auto` container.
- Make it demonstrably interactive where it costs little: clicking a transcript line
  moves the playhead, hovering a region shows the handles, the state switcher works,
  and — most importantly — clicking an example chip or pressing Run plays the whole
  scripted chat sequence on a timer, messages arriving one after another.

Publish with `favicon: "🎬"` and a one-sentence description. Give me the URL, plus a
short note on which design decisions you made deliberately so I can brief my teammate.
