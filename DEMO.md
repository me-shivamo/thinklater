# 🎬 ClipIt — Mentor Demo Script

Bot: **@clip_craft_sarvam_bot**

The whole demo runs on **two source files**. That's deliberate — reusing one file
proves the agent is *reading the sentence*, not pattern-matching a URL, and the
transcript cache makes every follow-up nearly instant.

**Before you start:** run Act 1 sample #1 once to warm the cache. Everything
after it is fast.

---

## Act 1 — Same file, three different sentences (~15-25s each)

This is the strongest part of the demo. One audio file, three instructions,
three completely different cuts. Paste the link once, then just change the words.

**Source (copy this line each time, changing only the instruction):**

```
https://storage.googleapis.com/eleven-public-cdn/documentation_assets/audio/stt-entity-detection-pii.mp3 trim the part where it tells the credit card number
```
→ **4.51s – 15.23s** · *"explicitly states 'my credit card number is'…"*

```
https://storage.googleapis.com/eleven-public-cdn/documentation_assets/audio/stt-entity-detection-pii.mp3 trim the part where she says her date of birth
```
→ **0.00s – 5.31s** · *"The speaker states their date of birth."*

```
https://storage.googleapis.com/eleven-public-cdn/documentation_assets/audio/stt-entity-detection-pii.mp3 trim the part where she introduces herself
```
→ **0.00s – 7.81s** · *"states 'My name is Jill' … a direct act of self-introduction."*

> **What to say:** "Same 15-second file, three sentences, three different cuts —
> and it tells me *why* it picked each one. Nobody wrote a rule for 'introduces
> herself'."

---

## Act 2 — Ops compose (~20s)

```
https://storage.googleapis.com/eleven-public-cdn/documentation_assets/audio/stt-entity-detection-pii.mp3 remove background noise from the part where she says the credit card number
```
→ plan becomes **denoise → find → trim**, returns **4.52s – 15.23s**, cleaned.

> **What to say:** "That's two operations from one sentence. And it denoises
> *before* transcribing — cleaner audio transcribes better, so one pass improves
> both the transcript and the output."

---

## Act 3 — Video + dubbing (the closer)

```
https://youtube.com/shorts/VehpmwRhJo4 trim the part where he speaks about Pandit ji and dub it to Tamil
```
→ finds **3.60s – 7.89s** in a Hindi Short, cuts it, returns Tamil video **+ SRT**.

> **What to say:** "Hindi in, Tamil out, and that's Sarvam Dub's voice cloning —
> the same speaker's voice, a different language. The subtitles came free."

**⚠️ Timing:** Sarvam Dub is a server-side job — allow **2–5 minutes**. The bot
streams `Transcribing 25% → Translating 50% → Completed 100%` so it never looks
frozen, but *talk over it*. Kick it off, then narrate Act 1's results while it
renders.

**If you can't afford the wait,** switch to the fast local dub (~24s, but no
voice cloning):
```bash
echo 'CLIPIT_DUB_ENGINE=manual' >> .env    # then restart bot.py
```

---

## Backup material

Second Short, if they want another: `https://youtube.com/shorts/Ao_DlIuWYtk`
(Hindi, 8s — *"अरे अरे गिर गया बेटा…"*). Try `trim the part where he asks about the bag`.

**Unsupported-language check** (shows we fail gracefully, not silently):
```
…stt-entity-detection-pii.mp3 dub this in Spanish
```
→ replies with the 12 languages Sarvam Dub actually supports.

---

## Timings (measured, not estimated)

| Instruction | Total |
|---|---|
| Trim (first run on a file — includes transcription) | ~14s |
| Trim (same file again — cache hit) | ~20s |
| Denoise + trim | ~20s |
| Trim + dub via Sarvam Dub | ~5 min |
| Trim + dub via local TTS | ~46s |

Where the time actually goes on a trim: planner LLM ~7s, locator LLM ~7s,
ingest ~2s, ffmpeg ~0.2s. On a dub, the Sarvam job is ~93% of the total.

---

## Questions mentors are likely to ask

**"How does it find the segment?"**
Sarvam STT gives a timestamped transcript. We hand `sarvam-105b` a numbered
transcript and the query; it returns id ranges, a reason and a confidence. Cuts
snap to segment boundaries so we never slice mid-word.

**"What if the quote is misspelled?"**
It still works — matching is semantic, not string equality. Try
`the part where he says "I am a moster"`.

**"Why not just use Whisper?"**
Both demo videos are Hindi. Sarvam's Saaras is built for Indic audio and
transcribed them cleanly, including code-mixed speech.

**"Is the whole thing Sarvam?"**
Five Sarvam APIs: Saaras (STT), sarvam-105b (planning + location), Translate,
Bulbul (TTS), and Sarvam Dub (voice cloning). ffmpeg does the cutting; nothing
else calls out.

**"How accurate are the timestamps?"**
Segment timestamps come from Saaras directly. Word-level timings are
interpolated within each segment — good enough to highlight words in the web UI,
and labelled as estimated in the API.
