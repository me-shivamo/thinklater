# ▶️ RUN THIS

Everything you need to start ClipIt and demo it. Copy-paste, top to bottom.

Bot: **@clip_craft_sarvam_bot**

---

## 1. Start it

```bash
cd ~/Sarvam/ClipIt
source .venv/bin/activate
python bot.py
```

Wait for `ClipIt bot is up. Talk to it on Telegram.` — then open Telegram.

**Keep it running after you close the terminal:**
```bash
setsid nohup .venv/bin/python bot.py > work/bot.log 2>&1 < /dev/null &
tail -f work/bot.log        # watch it
```

**Stop it:**
```bash
pkill -f "python bot.py"
```

---

## 2. Copy-paste these into Telegram

Paste the whole line — link and instruction together, in one message.

### ✅ Audio — all verified working

**Trim by description**
```
https://storage.googleapis.com/eleven-public-cdn/documentation_assets/audio/stt-entity-detection-pii.mp3 trim the part where it tells the credit card number
```
→ `4.51s – 15.23s` · ~14s

**Same file, different sentence** — this is the one that sells it
```
https://storage.googleapis.com/eleven-public-cdn/documentation_assets/audio/stt-entity-detection-pii.mp3 trim the part where she says her date of birth
```
→ `0.00s – 5.31s` · ~21s

```
https://storage.googleapis.com/eleven-public-cdn/documentation_assets/audio/stt-entity-detection-pii.mp3 trim the part where she introduces herself
```
→ `0.00s – 7.81s` · ~25s

**Two ops from one sentence**
```
https://storage.googleapis.com/eleven-public-cdn/documentation_assets/audio/stt-entity-detection-pii.mp3 remove background noise from the part where she says the credit card number
```
→ plan = `denoise → find → trim` · ~20s

**Denoise only**
```
https://eleven-public-cdn.elevenlabs.io/audio/voice-isolator/voice-isolator-promo-original.mp3 remove background noise from this audio
```
→ ~15s

**Dub whole file** — skips transcription entirely
```
https://storage.googleapis.com/eleven-public-cdn/documentation_assets/audio/stt-entity-detection-pii.mp3 dub the audio in Hindi language
```
→ ⚠️ 2–5 min (Sarvam Dub job)

**Trim + dub**
```
https://storage.googleapis.com/eleven-public-cdn/documentation_assets/audio/stt-entity-detection-pii.mp3 trim the part where it tells the credit card number and dub it in Hindi
```
→ ⚠️ 2–5 min

### ✅ Video — all verified working

**Anderson news clip** (English, 33s) — best video demo
```
https://www.youtube.com/shorts/uBiTZttuFG4 trim the part where it speaks about Anderson
```
→ `15.81s – 26.46s` · *"Mentions Anderson's status."* · ~25s

```
https://www.youtube.com/shorts/uBiTZttuFG4 trim the part where it speaks about Anderson and dub it to Hindi
```
→ ⚠️ 2–5 min

**Hindi Short → Tamil** (the voice-cloning closer)
```
https://youtube.com/shorts/VehpmwRhJo4 trim the part where he speaks about Pandit ji and dub it to Tamil
```
→ `3.60s – 7.89s` · Tamil video + SRT · ⚠️ 2–5 min

### ✅ Insert — adding words that were never spoken

**The Sarvam name-drop** — verified end to end
```
https://www.youtube.com/shorts/ASXSN4IUBDY after he says Amazon, insert the word "Sarvam" and keep the rest of the video
```
→ lands at `6.29s`, adds ~1.1s · ~27s · video grows 59.44s → 60.6s

**Insert then cut to just that moment**
```
https://www.youtube.com/shorts/ASXSN4IUBDY insert the word "Sarvam" after Amazon, then trim just the part where he lists the big tech companies
```
→ `2.10s – 7.27s` on the original timeline, re-timed around the insert · ~6.1s clip

**Insert then dub** — the new word gets translated and spoken too
```
https://www.youtube.com/shorts/ASXSN4IUBDY insert the word "Sarvam" after Amazon and dub it to Hindi
```
→ SRT reads `गूगल, माइक्रोसॉफ्ट, अमेज़ॅन,` → `सर्वम` → `वे सब।` · ⚠️ 2–5 min on `auto`

**Works on audio too**
```
https://storage.googleapis.com/eleven-public-cdn/documentation_assets/audio/stt-entity-detection-pii.mp3 insert the words "verified by Sarvam" after she says her credit card number
```
→ anchors on "my credit card number" despite the pronoun swap · `6.66s`

> The inserted word is a **preset Bulbul voice**, not the speaker's — Sarvam has
> no standalone cloning API. It reads as a deliberate edit, not a seamless one.
> Pick the voice with `--speaker` (CLI) or `CLIPIT_TTS_SPEAKER` (bot); `vijay`
> is tighter than the `shubh` default for single words.

**Sintel trailer** (English, 52s)
```
https://media.w3.org/2010/05/sintel/trailer.mp4 trim the part where he asks what brings you to the land of the gatekeepers
```

**Graceful failure** — worth showing on purpose
```
https://storage.googleapis.com/eleven-public-cdn/documentation_assets/audio/stt-entity-detection-pii.mp3 dub this in Spanish
```
→ replies with the 12 languages Sarvam Dub actually supports, instead of failing silently.

### ❌ Do not use

| Link | Why |
|---|---|
| `commondatastorage.googleapis.com/gtv-videos-bucket/…` | **403** — the whole bucket is blocked (this killed original test cases 5 and 7) |
| `filesamples.com/samples/video/mp4/sample_640x360.mp4` | no audio track |

---

## 3. Make dubbing fast (if you can't wait 5 minutes)

Sarvam Dub is a server-side job: **~285s**, but real speaker voice cloning.
Local TTS is **~24s**, no cloning.

```bash
echo 'CLIPIT_DUB_ENGINE=manual' >> .env
pkill -f "python bot.py" && setsid nohup .venv/bin/python bot.py > work/bot.log 2>&1 < /dev/null &
```

Switch back by deleting that line from `.env` (or setting it to `auto`).

**Better play for a live audience:** leave it on `auto`, start the dub *first*, then
talk through the trim examples while it renders. The bot streams
`Transcribing 25% → Translating 50% → Completed 100%`, so it never looks frozen.

---

## 4. CLI (faster to iterate, and your demo fallback)

```bash
# check a source without processing it
python cli.py -i "<url>" --probe

# full run, saves the result where you want it
python cli.py -i "<url>" -q "trim the part about X and dub it in Hindi" -o out/result.mp4

# fast dub
python cli.py --dub-engine manual -i "<url>" -q "dub this in Tamil" -o out/fast.mp3

# see the plan and API calls
python cli.py -v -i "<url>" -q "..."
```

Every run prints a **Where the time went** breakdown, so you can answer
"why is it slow?" with numbers instead of a guess.

---

## 5. If something breaks

| Symptom | Fix |
|---|---|
| Bot doesn't respond | `tail -20 work/bot.log`; check the process is alive with `pgrep -f "python bot.py"` |
| "no audio track" | The source has no speech — use one of the verified links above |
| YouTube download fails | Bot-detection. `uv pip install -U yt-dlp`, or send the file directly |
| Dub hangs past 5 min | It times out at 10 min and falls back to local TTS automatically |
| `ReadTimeout` in the log | Sarvam being slow; the retry handles it, just adds 10–20s |
| Everything is slow | Check the timing breakdown — dubbing is ~93% of any run that dubs |
| Wrong segment picked | Rephrase more specifically; the match `reason` tells you what it latched onto |

**Nuclear option:** pre-rendered results are in `out/`. Play those.

---

## 6. Facts worth having ready

- **Five Sarvam APIs:** Saaras (STT), sarvam-105b (planning + segment location),
  Sarvam Translate, Bulbul (TTS), Sarvam Dub (voice cloning).
- **Cost:** roughly ₹6–8 per full run. ₹100 free credit covers a day of demoing.
- **Speed:** trim ~14–25s · denoise ~15s · dub ~5 min (Sarvam) or ~24s (local).
- **Timestamps:** segment-level come straight from Saaras; word-level are
  interpolated within each segment and labelled as estimated.
- **Why not Whisper:** both Hindi Shorts transcribed cleanly on Saaras — it's
  built for Indic audio, including code-mixed speech.





  RUN THIS 



https://www.youtube.com/shorts/uBiTZttuFG4 trim the part where it speaks about Anderson and dub it to Hindi


https://www.youtube.com/shorts/uBiTZttuFG4 remove the background noise from this


KNOWN_OPS = ("find", "trim", "denoise", "insert", "translate", "dub", "concat", "export")
