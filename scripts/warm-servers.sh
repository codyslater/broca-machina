#!/usr/bin/env bash
# Start the warm STT + TTS model servers in the background.
#
# These keep faster-whisper and piper loaded so per-utterance / per-reply
# latency drops the model-load cost. The stt_client.py / tts_client.py CLIs
# talk to them over Unix sockets in .voice-tmp/ and fall back to a cold
# in-process load if a server is down — so this script is an optimization,
# not a hard dependency.
#
# Usage:   scripts/warm-servers.sh [start|stop|status|restart] [stt|tts]
#          (the optional 2nd arg targets a single engine; default = both)
# Env:
#   VOICE_PY          python interpreter (must have faster-whisper + piper-tts)
#   VOICE_CONFIG      adapter config JSON — if set, each server inherits its
#                     .stt.env / .tts.env (model, vocab bias, voice dir) so the
#                     warm path transcribes/synthesizes identically to the cold
#                     client. Keeps deployment-specific values out of this script.
#   PIPER_VOICE_DIR   piper voices dir (default ~/.cache/broca-machina/piper)
#   WHISPER_MODEL     faster-whisper model (default small.en)
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$HERE/.voice-tmp"
mkdir -p "$TMP"
PY="${VOICE_PY:-python3}"
STT_SOCK="${VOICE_STT_SOCK:-$TMP/stt.sock}"
TTS_SOCK="${VOICE_TTS_SOCK:-$TMP/tts.sock}"
VAD_SOCK="${VOICE_VAD_SOCK:-$TMP/vad.sock}"

_cfg_env() {  # jsonpath (e.g. .stt.env) -> emits shell-quoted `export K=V` lines
  [ -n "${VOICE_CONFIG:-}" ] && [ -f "${VOICE_CONFIG:-}" ] || return 0
  "$PY" - "$1" "$VOICE_CONFIG" <<'PYEOF'
import json, sys, shlex
key, path = sys.argv[1], sys.argv[2]
try:
    node = json.load(open(path))
    for part in key.strip(".").split("."):
        node = node.get(part, {}) if isinstance(node, dict) else {}
    for k, v in (node or {}).items():
        print(f"export {k}={shlex.quote(str(v))}")
except Exception:
    pass
PYEOF
}

_start_one() {  # name script sock
  local name="$1" script="$2" sock="$3"
  local pidf="$TMP/$name.pid" log="$TMP/$name.log"
  if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then
    echo "$name already running (pid $(cat "$pidf"))"; return 0
  fi
  local kind="${name%%_*}"                       # stt | tts
  local cfg_env; cfg_env="$(_cfg_env ".$kind.env")"
  echo "=== BOOT $(date -u +%FT%TZ) ===" > "$log"
  # Subshell applies the adapter's per-engine env, then nohup-backgrounds the
  # server and records ITS pid (the subshell exits immediately; the nohup'd
  # child survives, reparented to init).
  ( eval "$cfg_env"; nohup "$PY" "$HERE/src/$script" "$sock" >> "$log" 2>&1 & echo $! > "$pidf" )
  echo "$name starting (pid $(cat "$pidf")); log: $log"
}

_wait_ready() {  # name sock
  local name="$1" sock="$2"
  for _ in $(seq 1 120); do
    [ -S "$sock" ] && { echo "$name READY ($sock)"; return 0; }
    grep -q 'loaded + warmed' "$TMP/$name.log" 2>/dev/null && { echo "$name READY"; return 0; }
    sleep 0.5
  done
  echo "$name TIMEOUT; tail:"; tail -3 "$TMP/$name.log"; return 1
}

_stop_one() {  # name
  local name="$1"; local pidf="$TMP/$name.pid"
  if [ -f "$pidf" ]; then
    kill "$(cat "$pidf")" 2>/dev/null && echo "stopped $name (pid $(cat "$pidf"))" || echo "$name not running"
    rm -f "$pidf"
  else
    echo "no pid file for $name"
  fi
}

_status_one() {  # name sock
  local name="$1" sock="$2"; local pidf="$TMP/$name.pid"
  if [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null; then
    echo "$name: running (pid $(cat "$pidf")), socket $([ -S "$sock" ] && echo up || echo MISSING)"
  else
    echo "$name: down"
  fi
}

# Which engines a subcommand acts on (2nd arg: stt|tts|vad, default both STT+TTS).
# VAD (Silero endpointing) is OFF by default so the standard start/onPresenceEnter
# path is unchanged; opt in per-run with `... vad` or globally with VOICE_WARM_VAD=1.
_targets() {
  case "${1:-all}" in
    stt) echo "stt" ;;
    tts) echo "tts" ;;
    vad) echo "vad" ;;
    *)   local t="stt tts"; [ -n "${VOICE_WARM_VAD:-}" ] && t="$t vad"; echo "$t" ;;
  esac
}

_do() {  # verb target
  local verb="$1"
  for t in $(_targets "${2:-all}"); do
    case "$t:$verb" in
      stt:start)   _start_one stt_server stt_server.py "$STT_SOCK" ;;
      tts:start)   _start_one tts_server tts_server.py "$TTS_SOCK" ;;
      vad:start)   _start_one vad_server vad_server.py "$VAD_SOCK" ;;
      stt:stop)    _stop_one stt_server ;;
      tts:stop)    _stop_one tts_server ;;
      vad:stop)    _stop_one vad_server ;;
      stt:status)  _status_one stt_server "$STT_SOCK" ;;
      tts:status)  _status_one tts_server "$TTS_SOCK" ;;
      vad:status)  _status_one vad_server "$VAD_SOCK" ;;
    esac
  done
}

case "${1:-start}" in
  start)
    _do start "${2:-all}"
    for t in $(_targets "${2:-all}"); do
      [ "$t" = stt ] && _wait_ready stt_server "$STT_SOCK"
      [ "$t" = tts ] && _wait_ready tts_server "$TTS_SOCK"
      [ "$t" = vad ] && _wait_ready vad_server "$VAD_SOCK"
    done
    ;;
  stop)
    _do stop "${2:-all}" ;;
  restart)
    _do stop "${2:-all}"; sleep 1; exec "$0" start "${2:-all}" ;;
  status)
    _do status "${2:-all}" ;;
  *)
    echo "usage: warm-servers.sh [start|stop|status|restart] [stt|tts|vad]"; exit 2 ;;
esac
