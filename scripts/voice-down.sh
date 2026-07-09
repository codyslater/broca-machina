#!/usr/bin/env bash
# Stop the broca-machina loop started by voice-up.sh.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDF="$HERE/.voice-tmp/loop.pid"
if [ -f "$PIDF" ]; then
  PID="$(cat "$PIDF")"
  kill "$PID" 2>/dev/null && echo "stopped pid $PID" || echo "pid $PID not running"
  rm -f "$PIDF"
else
  echo "no pid file at $PIDF; nothing to stop"
fi
