#!/usr/bin/env bash
#
# Deploy ClipCraft to Railway with the Railway CLI: set the variables, push the
# build, expose a domain.
#
# One service on purpose — server.py serves web/dist at "/" below /api/*, so
# the editor and the engine share an origin and SSE + HTTP Range need no CORS.
#
# Reads SARVAM_API_KEY and TELEGRAM_BOT_TOKEN from the environment, falling
# back to .env in the repo root (which is gitignored). Refuses to deploy
# without SARVAM_API_KEY: a container that can't call Sarvam builds fine,
# starts fine, and fails on the first instruction — much worse than not
# deploying.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# .env is `KEY=value` with no `export`, so `set -a` is what makes it stick.
if [ -f "$ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$ROOT/.env"
    set +a
fi

: "${SARVAM_API_KEY:?Set SARVAM_API_KEY, or put it in .env}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"

DUB_ENGINE="${CLIPCRAFT_DUB_ENGINE:-auto}"
TTS_SPEAKER="${CLIPCRAFT_TTS_SPEAKER:-vijay}"
RUN_BOT="${CLIPCRAFT_RUN_BOT:-1}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

command -v railway >/dev/null 2>&1 || {
    echo "railway CLI not found. Install it:  npm i -g @railway/cli" >&2
    exit 1
}

# `railway status` is the cheapest check for "is this directory linked to a
# project" — it exits non-zero when it isn't.
if ! railway status >/dev/null 2>&1; then
    say "This directory isn't linked to a Railway project."
    echo "Run one of these first, then re-run this script:"
    echo "    railway init      # create a new project"
    echo "    railway link      # attach to an existing one"
    exit 1
fi

# ── Variables ───────────────────────────────────────────────────────────────
# PORT is deliberately absent: Railway injects it, and start.sh falls back to
# 8000. Setting it by hand is how you end up with a service whose health check
# talks to a port nothing is listening on.
say "Setting variables..."
set_args=(
    --set "SARVAM_API_KEY=$SARVAM_API_KEY"
    --set "CLIPCRAFT_DUB_ENGINE=$DUB_ENGINE"
    --set "CLIPCRAFT_TTS_SPEAKER=$TTS_SPEAKER"
    --set "CLIPCRAFT_RUN_BOT=$RUN_BOT"
    --set "PYTHONUNBUFFERED=1"
)
if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
    set_args+=(--set "TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN")
else
    echo "  TELEGRAM_BOT_TOKEN not set — deploying web + API only."
fi
railway variables "${set_args[@]}" --skip-deploys

# ── Build + deploy ──────────────────────────────────────────────────────────
# --detach so this script finishes; `railway logs` is the follow-along.
say "Building and deploying (first build takes ~5 min: apt + pip + npm)..."
railway up --detach

# ── Domain ──────────────────────────────────────────────────────────────────
# Idempotent: if a domain already exists, `railway domain` prints it.
say "Public domain"
railway domain || echo "  Generate one in Settings -> Networking if this failed."

say "Next"
cat <<'EOF'
  railway logs                       # watch it boot
  curl -s https://<domain>/api/health # {"ok":true,...}
  open https://<domain>/              # the editor

  Full notes, and what bites you on Railway: RAILWAY.md
EOF
