#!/usr/bin/env bash
#
# Create the ClipCraft web service on Render via the REST API.
#
# Idempotent-ish: if a service named $SERVICE_NAME already exists it prints it
# and exits instead of creating a duplicate.
#
# Reads RENDER_API_KEY, SARVAM_API_KEY and TELEGRAM_BOT_TOKEN from the
# environment, falling back to .env in the repo root (which is gitignored).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="${SERVICE_NAME:-clipcraft}"
REPO_URL="${REPO_URL:-https://github.com/me-shivamo/thinklater}"
BRANCH="${BRANCH:-feat/web-on-master}"
REGION="${REGION:-singapore}"
PLAN="${PLAN:-free}"
API="https://api.render.com/v1"

# .env is `KEY=value` with no `export`, so source it in a subshell-safe way.
if [ -f "$ROOT/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$ROOT/.env"
    set +a
fi

: "${RENDER_API_KEY:?Set RENDER_API_KEY (Render -> Account Settings -> API Keys)}"
: "${SARVAM_API_KEY:?Set SARVAM_API_KEY, or put it in .env}"
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"

auth=(-H "Authorization: Bearer $RENDER_API_KEY" -H "Content-Type: application/json")

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# ── Owner ───────────────────────────────────────────────────────────────────
say "Resolving Render owner..."
owners=$(curl -sS "${auth[@]}" "$API/owners?limit=20")
OWNER_ID=$(printf '%s' "$owners" | python3 -c '
import json,sys
rows = json.load(sys.stdin)
if not rows:
    sys.exit("No owners on this API key — is the key valid?")
o = rows[0]["owner"]
print(o["id"])
sys.stderr.write(f"  owner: {o.get(\"name\")} ({o.get(\"type\")}) {o[\"id\"]}\n")
')

# ── Already there? ──────────────────────────────────────────────────────────
existing=$(curl -sS "${auth[@]}" "$API/services?name=$SERVICE_NAME&limit=20")
EXISTING_ID=$(printf '%s' "$existing" | python3 -c '
import json,sys,os
name = os.environ["SERVICE_NAME"]
for row in json.load(sys.stdin):
    s = row["service"]
    if s["name"] == name:
        print(s["id"]); break
' SERVICE_NAME="$SERVICE_NAME" 2>/dev/null || true)

if [ -n "$EXISTING_ID" ]; then
    say "Service '$SERVICE_NAME' already exists: $EXISTING_ID"
    echo "  dashboard: https://dashboard.render.com/web/$EXISTING_ID"
    echo
    echo "Trigger a redeploy with:"
    # Never interpolate "${auth[@]}" into printed text — it carries the bearer token.
    echo "  curl -X POST -H \"Authorization: Bearer \$RENDER_API_KEY\" \\"
    echo "       $API/services/$EXISTING_ID/deploys -d '{}'"
    exit 0
fi

# ── Create ──────────────────────────────────────────────────────────────────
say "Creating web service '$SERVICE_NAME' ($PLAN, $REGION, branch $BRANCH)..."

payload=$(python3 - <<'PY'
import json, os

env = [
    {"key": "SARVAM_API_KEY",     "value": os.environ["SARVAM_API_KEY"]},
    {"key": "CLIPCRAFT_DUB_ENGINE",  "value": "auto"},
    {"key": "CLIPCRAFT_TTS_SPEAKER", "value": "vijay"},
    {"key": "PYTHONUNBUFFERED",   "value": "1"},
]

token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
env.append({"key": "TELEGRAM_BOT_TOKEN", "value": token})
# No token -> start.sh skips the bot anyway, but be explicit about it.
env.append({"key": "CLIPCRAFT_RUN_BOT", "value": "1" if token else "0"})

print(json.dumps({
    "type": "web_service",
    "name": os.environ["SERVICE_NAME"],
    "ownerId": os.environ["OWNER_ID"],
    "repo": os.environ["REPO_URL"],
    "branch": os.environ["BRANCH"],
    "autoDeploy": "yes",
    "envVars": env,
    "serviceDetails": {
        "region": os.environ["REGION"],
        "plan": os.environ["PLAN"],
        "runtime": "image" if os.environ.get("USE_IMAGE") else "docker",
        "healthCheckPath": "/api/health",
        "envSpecificDetails": {
            "dockerfilePath": "./Dockerfile",
            "dockerContext": ".",
        },
    },
}))
PY
)

resp=$(curl -sS -X POST "${auth[@]}" "$API/services" -d "$payload")

SERVICE_ID=$(printf '%s' "$resp" | python3 -c '
import json,sys
d = json.load(sys.stdin)
svc = d.get("service") or d
if "id" not in svc:
    sys.exit("Render rejected the request:\n" + json.dumps(d, indent=2))
print(svc["id"])
')

URL=$(printf '%s' "$resp" | python3 -c '
import json,sys
d = json.load(sys.stdin)
svc = d.get("service") or d
print(svc.get("serviceDetails", {}).get("url", ""))
')

say "Created: $SERVICE_ID"
echo "  dashboard: https://dashboard.render.com/web/$SERVICE_ID"
[ -n "$URL" ] && echo "  url:       $URL"
echo
echo "First build takes ~5 min (apt + pip + npm). Watch it with:"
echo "  bash deploy/watch_render_deploy.sh $SERVICE_ID"
