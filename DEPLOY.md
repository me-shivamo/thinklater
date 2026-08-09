# 🚀 Deploying ClipIt to Render

One Docker web service runs all three surfaces:

| Surface | Where it lives | URL |
|---|---|---|
| React editor | `web/dist`, mounted by `server.py` at `/` | `https://<service>.onrender.com/` |
| FastAPI engine | `server.py` | `https://<service>.onrender.com/api/*` |
| Telegram bot | `bot.py`, background process in the same container | Telegram |

Frontend and backend share one origin, which is the point: SSE and HTTP Range
work with no CORS config and no second service. The bot rides along because
Render's Background Workers are a paid product — `deploy/start.sh` supervises it
with backoff, and it can never take the web service down.

---

## Files

| File | Does what |
|---|---|
| `Dockerfile` | Stage 1 builds the Vite bundle with Node 22; stage 2 is Python 3.12 + `ffmpeg` and copies `dist` in |
| `deploy/start.sh` | Entrypoint: bot in the background, `uvicorn` in the foreground on `$PORT` |
| `render.yaml` | Blueprint, if you'd rather create the service that way than through the API |
| `.dockerignore` | Keeps `.env`, `work/` and `node_modules` out of the build context |

---

## Deploy it

### Option A — Blueprint (no API key)

1. Push this branch.
2. Render → **New** → **Blueprint** → pick `me-shivamo/thinklater`.
3. It reads `render.yaml` and prompts for `SARVAM_API_KEY` and
   `TELEGRAM_BOT_TOKEN`.
4. Apply. First build takes ~5 min (apt + pip + npm).

### Option B — REST API

```bash
export RENDER_API_KEY=rnd_xxxxxxxx      # Render → Account Settings → API Keys
```

Then the service is created from `render.yaml`'s settings against the
`feat/web-on-master` branch. Don't do **both** options — you'll get two services
deploying the same repo.

---

## Environment variables

| Key | Value | Why |
|---|---|---|
| `SARVAM_API_KEY` | *(secret)* | Required. All five Sarvam APIs. |
| `TELEGRAM_BOT_TOKEN` | *(secret)* | Required only for the bot; the web service runs fine without it. |
| `CLIPIT_DUB_ENGINE` | `auto` | Sarvam Dub. The 2–5 min wait is Sarvam's, not this instance's — `manual` does translate + TTS + atempo *locally* and is the slower choice on 0.1 CPU. |
| `CLIPIT_TTS_SPEAKER` | `vijay` | Tighter than `shubh` on single-word inserts. |
| `CLIPIT_RUN_BOT` | `1` | Set `0` to keep the bot local — see the conflict note below. |

---

## What will bite you on the free tier

These are real, and worth knowing before the demo rather than during it.

**YouTube links will probably fail.** `yt-dlp` from a datacenter IP hits Google's
bot detection far more aggressively than from a home connection. The RUNTHIS.md
YouTube examples are the ones at risk. `media.py` already fails gracefully
("send me the file directly"), and **file uploads and direct media URLs are
unaffected** — the `storage.googleapis.com` MP3s and the Sintel trailer are the
safe demo material. Fix if you need YouTube: pass cookies to `yt-dlp`.

**Spin-down wipes job state.** Free services sleep after 15 min idle and cold-start
in ~50s. `MEDIA` and `JOBS` in `server.py` are in-process dicts, so anything
ingested before a sleep 404s afterwards. Reload the page and re-ingest. Renders
in `work/` are on ephemeral disk and go the same way.

**512 MB RAM, 0.1 CPU.** Audio is comfortable. Video ffmpeg — especially the
insert op's slow-motion filter — is tight and may be slow or get OOM-killed. If
video is central to the demo, Starter ($7) removes the spin-down and Standard
($25, 2 GB) is what the pipeline actually wants.

**One Telegram poller per token.** If the deployed bot and your laptop's
`python bot.py` are both alive, they fight over `getUpdates` and one crash-loops.
Either `pkill -f "python bot.py"` locally, or set `CLIPIT_RUN_BOT=0` on Render.

---

## Checks after it goes live

```bash
BASE=https://<service>.onrender.com

curl -s $BASE/api/health                       # {"ok":true,...}
curl -s -o /dev/null -w '%{http_code}\n' $BASE/  # 200, the editor

# End-to-end, no YouTube involved:
curl -s -X POST $BASE/api/ingest \
     -H 'Content-Type: application/json' \
     -d '{"url":"https://storage.googleapis.com/eleven-public-cdn/documentation_assets/audio/stt-entity-detection-pii.mp3"}'
```

In the Render log you want `[start.sh] starting uvicorn on 0.0.0.0:10000` and,
if the bot is on, `ClipCraft bot is up.`

---

## Redeploying

`autoDeployTrigger: commit` — push to `feat/web-on-master` and Render rebuilds.
To change the branch, edit `render.yaml` and the service's settings.
