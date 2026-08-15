# 🚂 Deploying ClipCraft to Railway

**One service. Frontend and backend both.**

`server.py` mounts the built React bundle (`web/dist`) at `/` *below* every
`/api/*` route, so a single container serves the editor and the engine from one
origin. That is deliberate: SSE (`/api/events/{job_id}`) and HTTP Range
(`/api/media/{id}`, `/api/download/{id}`) then work with **no CORS config, no
second service, and no `VITE_BACKEND_ORIGIN` to keep in sync**. Splitting the UI
onto a static host would buy nothing and cost you both of those.

| Surface | Where it lives | URL |
|---|---|---|
| React editor | `web/dist`, mounted by `server.py` at `/` | `https://<service>.up.railway.app/` |
| FastAPI engine | `server.py` | `https://<service>.up.railway.app/api/*` |
| Telegram bot | `bot.py`, background process in the same container | Telegram |

---

## Files Railway reads

| File | Does what |
|---|---|
| `railway.json` | Tells Railway to build the `Dockerfile` (not Nixpacks), health-check `/api/health`, restart on failure, and stay at **1 replica** |
| `Dockerfile` | Stage 1 builds the Vite bundle with Node 22; stage 2 is Python 3.12 + `ffmpeg` and copies `dist` in |
| `deploy/start.sh` | Entrypoint: bot in the background, `uvicorn` in the foreground on `$PORT` |
| `.dockerignore` | Keeps `.env`, `work/` and `node_modules` out of the build context |
| `deploy/railway.env.example` | Paste into Railway's **Raw Editor** variables box |

`render.yaml` and `DEPLOY.md` are the Render path. Railway ignores them; they
can stay.

---

## Deploy it

### Option A — Dashboard

1. Push this branch to GitHub.
2. Railway → **New Project** → **Deploy from GitHub repo** → pick this repo.
3. Railway finds `railway.json`, sees `builder: DOCKERFILE`, and builds. First
   build takes ~5 min (apt + pip + npm).
4. **Variables** → **Raw Editor** → paste `deploy/railway.env.example` and fill
   in the two secrets.
5. **Settings** → **Networking** → **Generate Domain**. Railway detects the
   listening port from the running container; if it asks, the target port is
   whatever `$PORT` it injected (leave it on automatic).

### Option B — CLI

```bash
npm i -g @railway/cli
railway login
railway init                      # or: railway link  (existing project)

railway variables \
  --set "SARVAM_API_KEY=sk_xxx" \
  --set "TELEGRAM_BOT_TOKEN=123456:ABCdef" \
  --set "CLIPCRAFT_DUB_ENGINE=auto" \
  --set "CLIPCRAFT_TTS_SPEAKER=vijay" \
  --set "CLIPCRAFT_RUN_BOT=1" \
  --set "PYTHONUNBUFFERED=1"

railway up                        # build + deploy from the local directory
railway domain                    # generate the public URL
railway logs                      # watch it come up
```

Or use the wrapper, which does the same thing and refuses to run with a missing
key rather than deploying a container that can't call Sarvam:

```bash
SARVAM_API_KEY=sk_xxx TELEGRAM_BOT_TOKEN=123456:ABC ./deploy/railway_deploy.sh
```

---

## Environment variables

| Key | Value | Why |
|---|---|---|
| `SARVAM_API_KEY` | *(secret)* | Required. All five Sarvam APIs. |
| `TELEGRAM_BOT_TOKEN` | *(secret)* | Only for the bot. Web + API run fine without it — `start.sh` just logs that the bot is disabled. |
| `CLIPCRAFT_DUB_ENGINE` | `auto` | Sarvam Dub, real voice cloning. The 2–5 min wait is Sarvam's, not this container's; `manual` does translate + TTS + atempo *locally* and is slower on a small instance. |
| `CLIPCRAFT_TTS_SPEAKER` | `vijay` | Tighter than `shubh` on single-word inserts. |
| `CLIPCRAFT_RUN_BOT` | `1` | Set `0` to keep the bot on your laptop — see the conflict note below. |
| `PORT` | *(injected)* | Railway sets it; `start.sh` falls back to `8000`. Don't hardcode it. |

---

## What will bite you on Railway

**Don't scale past one replica.** `MEDIA` and `JOBS` in `server.py` are plain
in-process dicts. A second replica would round-robin `/api/result/{job_id}` into
a process that never saw the job, and `--workers 1` inside the container exists
for the same reason. `railway.json` pins `numReplicas: 1`; leave it there until
that state moves to Redis or SQLite.

**Redeploys wipe job state.** Rendered files live in `work/` on the container's
ephemeral filesystem, and the registries are in memory — so every deploy,
restart, or crash 404s anything ingested before it. Reload the page and
re-ingest. If you want renders to survive, attach a Railway **Volume** mounted
at `/app/work` (Service → Settings → Volumes); nothing in the code needs to
change, but the in-memory `MEDIA`/`JOBS` dicts still reset, so it only helps for
files you already have URLs for.

**YouTube links will probably fail.** `yt-dlp` from a datacenter IP hits Google's
bot detection far more aggressively than a home connection does. The RUNTHIS.md
YouTube examples are the ones at risk. `media.py` fails gracefully ("send me the
file directly"), and **file uploads and direct media URLs are unaffected** — the
`storage.googleapis.com` MP3s and the Sintel trailer are the safe demo material.
Fix if you need YouTube: pass cookies to `yt-dlp`.

**Memory and CPU.** Audio is comfortable anywhere. Video ffmpeg — especially the
insert op's slow-motion filter — wants real headroom; if a job gets OOM-killed,
raise the service's memory limit in Railway rather than trimming the pipeline.

**One Telegram poller per token.** If the deployed bot and a local `python
bot.py` are both alive they fight over `getUpdates` and one crash-loops on 409.
Either `pkill -f "python bot.py"` locally, or set `CLIPCRAFT_RUN_BOT=0`.

**Long dubs vs. proxy timeouts.** A Sarvam Dub job runs 2–5 minutes. `server.py`
sends SSE keepalives and `start.sh` runs uvicorn with `--timeout-keep-alive 75`
to hold the connection open. If a dub ever drops mid-stream, the UI's polling
fallback (`GET /api/jobs/{job_id}`) is what recovers it.

---

## Checks after it goes live

```bash
BASE=https://<service>.up.railway.app

curl -s $BASE/api/health                          # {"ok":true,"media":0,"jobs":0}
curl -s -o /dev/null -w '%{http_code}\n' $BASE/   # 200 — the editor

# End-to-end, no YouTube involved:
curl -s -X POST $BASE/api/ingest \
     -H 'Content-Type: application/json' \
     -d '{"url":"https://storage.googleapis.com/eleven-public-cdn/documentation_assets/audio/stt-entity-detection-pii.mp3"}'
```

In `railway logs` you want `[start.sh] starting uvicorn on 0.0.0.0:<port>` and,
if the bot is on, `ClipCraft bot is up.`

Open `/` in a browser: if the editor loads but shows a **fixtures** badge, the
bundle was built with `VITE_USE_FIXTURES=1`. The `Dockerfile` pins it to `0`, so
that only happens if someone overrode it as a build arg.

---

## Redeploying

Railway auto-deploys on push to the connected branch. To deploy without pushing,
`railway up` from the working directory.
