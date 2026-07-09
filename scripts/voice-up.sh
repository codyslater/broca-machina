#!/usr/bin/env bash
# Start the broca-machina loop. Usage: voice-up.sh <config.json>
# Optional env: VOICE_TOKEN_ENVFILE (a .env sourced for the bot token), VOICE_LOG.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CFG="${1:-${VOICE_CONFIG:-}}"
[ -n "$CFG" ] || { echo "usage: voice-up.sh <config.json>"; exit 2; }

if [ -n "${VOICE_TOKEN_ENVFILE:-}" ] && [ -f "$VOICE_TOKEN_ENVFILE" ]; then
  set -a; . "$VOICE_TOKEN_ENVFILE"; set +a
fi

mkdir -p "$HERE/.voice-tmp"
LOG="${VOICE_LOG:-$HERE/.voice-tmp/loop.log}"
echo "=== BOOT $(date -u +%FT%TZ) ===" > "$LOG"
nohup bun "$HERE/src/voice_loop.js" "$CFG" >> "$LOG" 2>&1 &
echo $! > "$HERE/.voice-tmp/loop.pid"
echo "broca-machina started (pid $(cat "$HERE/.voice-tmp/loop.pid")); log: $LOG"

# The loop prints "[loop] LIVE" once it's up in every mode (in presence-gated
# mode it goes LIVE without joining until the user enters voice), so gate on that
# — not the join line, which the old check grepped for and never matched.
for i in $(seq 1 60); do
  grep -q '\[loop\] LIVE' "$LOG" 2>/dev/null && { echo "LIVE"; exit 0; }
  grep -qE '\[login\] FAILED|no bot token|refusing to start|invalid config|cannot read config|ffmpeg not found' "$LOG" 2>/dev/null && { echo "FAILED"; tail -6 "$LOG"; exit 1; }
  sleep 0.5
done
echo "TIMEOUT (still starting); tail:"; tail -4 "$LOG"
