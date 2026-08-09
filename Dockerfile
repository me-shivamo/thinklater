# ClipIt — one image, both surfaces.
#
# server.py already mounts web/dist at "/" below every /api route, so a single
# container serves the React editor and the FastAPI engine from one origin.
# That is what makes SSE and HTTP Range work on Render with no CORS config and
# no second service: the browser only ever talks to itself.
#
# deploy/start.sh then runs the Telegram bot alongside uvicorn in this same
# container, so all three surfaces cost one free web service.

# ── Stage 1: build the React bundle ─────────────────────────────────────────
FROM node:22-slim AS web

WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./

# Vite inlines import.meta.env at BUILD time. web/.env is gitignored and
# .dockerignore'd, so without this the bundle would be built with the variable
# undefined. api.js defaults undefined to live-mode, but pin it explicitly —
# shipping a fixtures build to production is a silent, convincing failure.
ENV VITE_USE_FIXTURES=0
RUN npm run build


# ── Stage 2: python runtime ─────────────────────────────────────────────────
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# ffmpeg + ffprobe are the hard requirement — every trim, denoise, concat and
# mux shells out to them. config._resolve_ffmpeg() finds them on PATH here and
# never reaches its static-ffmpeg fallback.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY clipit/ ./clipit/
COPY assets/ ./assets/
COPY server.py bot.py cli.py ./
COPY deploy/start.sh ./deploy/start.sh
RUN chmod +x ./deploy/start.sh

# The built bundle lands exactly where server.py looks for it (_DIST).
COPY --from=web /web/dist ./web/dist

# config.py creates work/ and cache/ at import, but do it here too so the
# layout is correct even if something reads them before clipit is imported.
RUN mkdir -p work cache out

EXPOSE 8000

CMD ["./deploy/start.sh"]
