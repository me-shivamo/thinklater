#!/usr/bin/env bash
#
# Container entrypoint: the FastAPI engine in the foreground, the Telegram bot
# beside it in the background.
#
# Render only health-checks the web port, so uvicorn is the process that must
# own the foreground — if it dies the container dies and Render restarts it.
# The bot is deliberately *not* allowed that power: it is a polling client with
# its own failure modes (network blips, a second poller holding the token), and
# none of those should be able to take the editor down with it.

set -uo pipefail

PORT="${PORT:-8000}"

# ---------------------------------------------------------------------------
# Telegram bot — optional, supervised, never fatal
# ---------------------------------------------------------------------------
# Telegram allows exactly ONE getUpdates poller per token. If you are also
# running `python bot.py` on your laptop, the two will fight and this one will
# crash-loop on 409 Conflict. Set CLIPIT_RUN_BOT=0 to keep the container's bot
# switched off and leave the token to your local process.
run_bot() {
    local delay=5
    while true; do
        echo "[start.sh] starting Telegram bot"
        python -u bot.py
        echo "[start.sh] bot exited (code $?); restarting in ${delay}s" >&2
        sleep "$delay"
        # Back off toward a minute so a token conflict logs once a minute
        # rather than twelve times. bot.py's own exit code can't distinguish a
        # config error from a crash — both are 1 — so the backoff, not the code,
        # is what keeps a permanent failure cheap.
        delay=$(( delay * 2 ))
        [ "$delay" -gt 60 ] && delay=60
    done
}

# The two hard preconditions from bot.py's main(). Checking them here rather
# than letting bot.py SystemExit keeps a misconfigured deploy from crash-looping
# on something no amount of retrying will fix.
if [ "${CLIPIT_RUN_BOT:-1}" = "0" ]; then
    echo "[start.sh] CLIPIT_RUN_BOT=0 — Telegram bot disabled"
elif [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
    echo "[start.sh] TELEGRAM_BOT_TOKEN not set — Telegram bot disabled"
elif [ -z "${SARVAM_API_KEY:-}" ]; then
    echo "[start.sh] SARVAM_API_KEY not set — Telegram bot disabled" >&2
else
    run_bot &
fi

# ---------------------------------------------------------------------------
# FastAPI engine + built React bundle
# ---------------------------------------------------------------------------
# One worker on purpose. MEDIA and JOBS in server.py are plain in-process
# dicts, so a second worker would serve /api/result from a process that never
# saw the job. Concurrency comes from the threads the pipeline already uses.
echo "[start.sh] starting uvicorn on 0.0.0.0:${PORT}"
exec uvicorn server:app \
    --host 0.0.0.0 \
    --port "$PORT" \
    --workers 1 \
    --timeout-keep-alive 75 \
    --log-level info
