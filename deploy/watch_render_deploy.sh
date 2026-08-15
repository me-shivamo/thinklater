#!/usr/bin/env bash
#
# Poll a Render service's latest deploy until it settles, then smoke-test it.
#   bash deploy/watch_render_deploy.sh <service-id>

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_ID="${1:?usage: watch_render_deploy.sh <service-id>}"
API="https://api.render.com/v1"

if [ -f "$ROOT/.env" ]; then
    set -a; . "$ROOT/.env"; set +a
fi
: "${RENDER_API_KEY:?Set RENDER_API_KEY}"

auth=(-H "Authorization: Bearer $RENDER_API_KEY" -H "Accept: application/json")

svc=$(curl -sS "${auth[@]}" "$API/services/$SERVICE_ID")
BASE=$(printf '%s' "$svc" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("serviceDetails",{}).get("url",""))')
echo "service: $SERVICE_ID"
echo "url:     ${BASE:-<pending>}"
echo

# live | build_in_progress | update_in_progress -> keep waiting.
# build_failed | update_failed | canceled | pre_deploy_failed -> stop.
while true; do
    deploy=$(curl -sS "${auth[@]}" "$API/services/$SERVICE_ID/deploys?limit=1")
    read -r STATUS DEPLOY_ID <<<"$(printf '%s' "$deploy" | python3 -c '
import json,sys
rows = json.load(sys.stdin)
if not rows: print("none none"); raise SystemExit
d = rows[0]["deploy"]
print(d.get("status","?"), d.get("id","?"))
')"

    printf '\r%s  %s          ' "$(date +%H:%M:%S)" "$STATUS"

    case "$STATUS" in
        live)
            echo; echo "Deploy $DEPLOY_ID is live."
            break ;;
        build_failed|update_failed|canceled|pre_deploy_failed|deactivated)
            echo; echo "Deploy $DEPLOY_ID ended: $STATUS" >&2
            echo "Logs: https://dashboard.render.com/web/$SERVICE_ID/logs" >&2
            exit 1 ;;
    esac
    sleep 10
done

[ -z "$BASE" ] && exit 0

echo
echo "Smoke test:"
# A free instance may still be waking; give the health check a few tries.
for i in 1 2 3 4 5 6; do
    code=$(curl -s -o /tmp/clipcraft_health.$$ -w '%{http_code}' --max-time 60 "$BASE/api/health" || echo 000)
    if [ "$code" = "200" ]; then
        echo "  /api/health  200  $(cat /tmp/clipcraft_health.$$)"
        rm -f /tmp/clipcraft_health.$$
        break
    fi
    echo "  /api/health  $code (attempt $i, instance may be cold)"
    sleep 10
done

spa=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "$BASE/" || echo 000)
echo "  /            $spa  (editor)"
echo
echo "Open: $BASE"
