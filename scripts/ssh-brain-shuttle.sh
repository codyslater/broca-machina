#!/usr/bin/env bash
# ssh-brain-shuttle.sh — bridge a file-transport voice loop to a brain that
# lives in a tmux session on an SSH host.
#
# The voice loop's file transport (docs/INTEGRATIONS.md) is two paths:
# transcripts out, one reply file in. This script carries both over SSH so the
# brain can be a session on another machine:
#
#   deliver <file>  paste a transcript into the remote tmux target + Enter.
#   pull-loop       persistent channel supervisor (see below); also the
#                   reply path: remote say-file content lands atomically in
#                   the local replyFile. Content equal to $SHUTTLE_SENTINEL
#                   runs $SHUTTLE_ON_HANDBACK instead of being spoken.
#   ensure-pull     start pull-loop in the background iff not already running.
#   stop            stop the running pull-loop.
#   status          exit 0 if pull-loop is running, 1 otherwise.
#   purge-say       remove the remote say file (+ .claim residue) — run before
#                   starting a new pull-loop so a stale reply is never spoken.
#
# v2 — persistent channel. Some remote sshds (HPC login nodes with heavy PAM
# session stacks) charge seconds of setup for EVERY exec channel, making
# one-ssh-per-operation unusable (measured ~3.6s/op where the network RTT was
# 50ms). The pull-loop therefore holds ONE long-lived ssh session carrying
# both directions:
#   stdin  ->  "D <seq> <base64>" lines: the remote end decodes and pastes
#              into the tmux target, answering "OK <seq>" / "ERR <seq>".
#   stdout ->  those ACKs, plus "R <base64>" lines streamed by a remote
#              watcher whenever the say file has content (claim-with-mv, the
#              same guarded idiom as v1).
# `deliver` rides this channel when it is up and bound to the caller's
# host+tmux — a sub-second round trip — and falls back to a one-shot ssh exec
# (the v1 path, always correct, just slow) when it isn't. The channel
# supervisor respawns the session with backoff if it drops, draining stale
# queued requests first (their senders have already fallen back). ACK-per-
# message keeps deliver's exit code meaningful, so callers' failure counters
# and auto-revert logic behave exactly as with one-shot delivery.
#
# Config (env — placeholders, nothing here is machine-specific):
#   SHUTTLE_HOST         ssh alias (required). Point aliases at jump hosts in
#                        ~/.ssh/config (ProxyJump) for brains behind a bastion.
#   SHUTTLE_TMUX         remote tmux target (required for deliver)
#   SHUTTLE_REMOTE_SAY   remote reply path; leading ~ expands remotely
#   SHUTTLE_LOCAL_REPLY  the voice loop's replyFile
#   SHUTTLE_STATE_DIR    pidfile/lock dir       (default /tmp/ssh-brain-shuttle)
#   SHUTTLE_SENTINEL     handback marker        (default <<HANDBACK>>)
#   SHUTTLE_ON_HANDBACK  command run on sentinel (optional)
#   SHUTTLE_REPLY_GATE   command evaluated before forwarding each pulled
#                        reply; nonzero exit drops it (optional — lets a
#                        router veto replies from a stale route)
#   SHUTTLE_POLL_S       remote say poll interval seconds (default 0.5)
#   SHUTTLE_SSH_OPTS     extra ssh options      (optional)
#   SHUTTLE_PERSISTENT   1 (default) = channel mode; 0 = pure v1 one-shot ops
#   SHUTTLE_DELIVER_TIMEOUT_S  channel ACK wait before one-shot fallback
#                        (default 8)
#
# Remote requirements: GNU coreutils base64 (any Linux box; v1 had no such
# dependency — the channel framing needs it).
#
# Keep-alive: ServerAliveInterval=5 and ServerAliveCountMax=2 detect and drop
# stalled connections after ~10 seconds, so a wedged session is respawned
# rather than trusted forever.
#
# ControlMaster (ssh_config) still helps the FALLBACK path and channel
# respawns; it cannot help per-exec session-setup cost, which is exactly what
# the persistent channel exists to avoid.
#
# Known limitation (v1 and v2): deliver does not check whether the remote
# composer has unsent text before pasting; keep the remote session dedicated
# while routed.
set -u

STATE_DIR="${SHUTTLE_STATE_DIR:-/tmp/ssh-brain-shuttle}"
SENTINEL="${SHUTTLE_SENTINEL:-<<HANDBACK>>}"
POLL_S="${SHUTTLE_POLL_S:-0.5}"
PERSISTENT="${SHUTTLE_PERSISTENT:-1}"
DELIVER_TIMEOUT_S="${SHUTTLE_DELIVER_TIMEOUT_S:-8}"
PIDFILE="$STATE_DIR/pull.pid"
LOCKFILE="$STATE_DIR/pull.lock"
REQ_FIFO="$STATE_DIR/req.fifo"
RESP_STATE="$STATE_DIR/resp.state"
SEQ_FILE="$STATE_DIR/chan.seq"
CHAN_TMUX="$STATE_DIR/chan.tmux"
DELIVER_LOCK="$STATE_DIR/deliver.lock"

die()  { echo "ssh-brain-shuttle: $*" >&2; exit 2; }
need() { [ -n "${!1:-}" ] || die "env $1 is required"; }

_ssh() {
  # shellcheck disable=SC2086
  ssh -o BatchMode=yes -o ConnectTimeout=5 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 ${SHUTTLE_SSH_OPTS:-} "$SHUTTLE_HOST" "$@"
}

# Leading ~ can't expand locally for a remote path; hand it to the remote shell
# as $HOME instead.
_remote_path() { printf '%s' "${1/#\~/\$HOME}"; }

_pull_id() { printf '%s|%s' "$SHUTTLE_HOST" "$(_remote_path "$SHUTTLE_REMOTE_SAY")"; }

# --- deliver ------------------------------------------------------------------

_deliver_oneshot() {  # $1 file — the v1 path: one ssh exec, rc = paste success
  # One round trip: stdin → remote buffer → bracketed paste → settle → Enter.
  # The sleep keeps the paste-close sequence ahead of the Enter on fast links.
  _ssh "tmux load-buffer -b broca-shuttle - \
     && tmux paste-buffer -p -d -b broca-shuttle -t '$SHUTTLE_TMUX' \
     && sleep 0.05 \
     && tmux send-keys -t '$SHUTTLE_TMUX' Enter" < "$1"
}

_channel_matches() {
  # The channel delivers into the tmux target it was STARTED with, on the host
  # it was started for. A caller with different env (e.g. a teardown notice to
  # the PREVIOUS host while a new route's channel is up) must not ride it.
  [ "$PERSISTENT" = 1 ] || return 1
  cmd_status || return 1
  [ "$(cat "$STATE_DIR/pull.id" 2>/dev/null)" = "$(_pull_id)" ] || return 1
  [ "$(cat "$CHAN_TMUX" 2>/dev/null)" = "$SHUTTLE_TMUX" ] || return 1
  [ -p "$REQ_FIFO" ]
}

_deliver_channel() {  # $1 file -> 0 on remote-ACKed paste, 1 otherwise
  local seq b64 deadline resp
  b64=$(base64 -w0 "$1") || return 1
  # One outstanding request at a time: seq allocation and the ACK wait are
  # serialized, so resp.state only ever answers the current caller.
  exec 8>"$DELIVER_LOCK"
  flock -w 5 8 || return 1
  seq=$(( $(cat "$SEQ_FILE" 2>/dev/null || echo 0) + 1 ))
  echo "$seq" > "$SEQ_FILE"
  rm -f "$RESP_STATE"
  # The open of a fifo write end blocks if the supervisor (which holds the
  # read end) died between our status check and now — bound it.
  timeout 2 bash -c "printf 'D %s %s\n' '$seq' '$b64' >> '$REQ_FIFO'" || return 1
  deadline=$(( SECONDS + DELIVER_TIMEOUT_S ))
  while [ "$SECONDS" -lt "$deadline" ]; do
    resp="$(cat "$RESP_STATE" 2>/dev/null || true)"
    case "$resp" in
      "OK $seq")  return 0;;
      "ERR $seq") return 1;;
    esac
    sleep 0.05
  done
  return 1
}

cmd_deliver() {
  need SHUTTLE_HOST; need SHUTTLE_TMUX
  local f="${1:-}"
  [ -n "$f" ] && [ -s "$f" ] || die "deliver: missing or empty file: ${f:-<none>}"
  if _channel_matches; then
    _deliver_channel "$f" && return 0
    # Channel refused/timed out — the supervisor will notice a dead session
    # itself; this call still owes the caller a correct delivery + rc.
  fi
  _deliver_oneshot "$f"
}

# --- reply path ---------------------------------------------------------------

_squash() { printf '%s' "$1" | tr -d '[:space:]'; }

# $1 claimed text -> sentinel triggers SHUTTLE_ON_HANDBACK (not forwarded),
# anything else lands in SHUTTLE_LOCAL_REPLY via tmp+mv (same FS) — unless the
# route is over or the router vetoes:
#   - post-handback: once the sentinel is consumed, this loop forwards NOTHING
#     more. The handback hook's stop races the next claim; a remote streaming
#     a tail after <<HANDBACK>> (or a teardown-notice-provoked goodbye) leaked
#     into the voice channel through that race (observed live 2026-08-13).
#   - SHUTTLE_REPLY_GATE (optional): evaluated before each forward; nonzero
#     drops the reply. Lets a router refuse replies from a host the route no
#     longer points at, whatever the timing.
_deliver_text() {
  local text="$1" tmp
  if [ "$(_squash "$text")" = "$(_squash "$SENTINEL")" ]; then
    HANDBACK_SEEN=1
    [ -n "${SHUTTLE_ON_HANDBACK:-}" ] && eval "$SHUTTLE_ON_HANDBACK" || true
  elif [ -n "${HANDBACK_SEEN:-}" ]; then
    echo "$(date -Is) post-handback reply suppressed (${#text} chars)"
  elif [ -n "${SHUTTLE_REPLY_GATE:-}" ] && ! eval "$SHUTTLE_REPLY_GATE"; then
    echo "$(date -Is) reply gate rejected pulled reply (${#text} chars)"
  else
    tmp="${SHUTTLE_LOCAL_REPLY}.shuttle.$$"
    printf '%s' "$text" > "$tmp" && mv "$tmp" "$SHUTTLE_LOCAL_REPLY"
  fi
}

# The remote end of the channel: a background watcher streams say-file
# content out as "R <base64>" lines (recovering a stranded .claim first —
# a previous run may have died between claiming and consuming); the
# foreground loop pastes "D <seq> <base64>" deliveries and ACKs each one.
_remote_channel_script() {
  local say; say="$(_remote_path "$SHUTTLE_REMOTE_SAY")"
  cat <<EOF
say="$say"; tgt="$SHUTTLE_TMUX"; m=\$\$
( if [ -s "\$say.claim" ]; then printf 'R %s\n' "\$(base64 -w0 "\$say.claim")" && rm -f "\$say.claim"; fi
  # The parent-liveness condition (not 'while :') is load-bearing: a watcher
  # that outlives its session becomes a zombie that STEALS the say file from
  # the next session's watcher — replies vanish into a closed pipe.
  while kill -0 "\$m" 2>/dev/null; do
    if [ -s "\$say" ]; then
      mv "\$say" "\$say.claim" \\
        && printf 'R %s\n' "\$(base64 -w0 "\$say.claim")" \\
        && rm -f "\$say.claim"
    fi
    sleep $POLL_S
  done ) &
w=\$!
trap 'kill \$w 2>/dev/null' EXIT HUP TERM
while read -r tag seq b64; do
  [ "\$tag" = D ] || continue
  if printf '%s' "\$b64" | base64 -d | tmux load-buffer -b broca-shuttle - \\
     && tmux paste-buffer -p -d -b broca-shuttle -t "\$tgt" \\
     && sleep 0.05 \\
     && tmux send-keys -t "\$tgt" Enter; then
    echo "OK \$seq"
  else
    echo "ERR \$seq"
  fi
done
EOF
}

# v1 fallback pull loop — one ssh exec per poll. Kept for SHUTTLE_PERSISTENT=0
# and as the documented reference for the claim idiom the channel script uses.
_pull_loop_oneshot() {
  local say text
  say="$(_remote_path "$SHUTTLE_REMOTE_SAY")"
  text=$(_ssh "if [ -s \"$say.claim\" ]; then cat \"$say.claim\" && rm -f \"$say.claim\"; fi" 2>/dev/null) || text=""
  [ -n "$text" ] && _deliver_text "$text"
  while :; do
    text=$(_ssh "if [ -s \"$say\" ]; then mv \"$say\" \"$say.claim\" \
                 && cat \"$say.claim\" && rm -f \"$say.claim\"; fi" 2>/dev/null) || text=""
    [ -n "$text" ] && _deliver_text "$text"
    sleep "$POLL_S"
  done
}

_drain_fifo() {
  # After a session dies, requests still queued in the fifo belong to callers
  # that have already timed out into the one-shot fallback — delivering them
  # on respawn would paste duplicates. Throw them away.
  local junk
  while IFS= read -r -t 0.1 junk <&3; do :; done 2>/dev/null || true
}

cmd_pull_loop() {
  need SHUTTLE_HOST; need SHUTTLE_REMOTE_SAY; need SHUTTLE_LOCAL_REPLY
  mkdir -p "$STATE_DIR"
  exec 9>"$LOCKFILE"
  flock -n 9 || die "pull-loop already running"
  echo $$ > "$PIDFILE"
  # Identity of this loop instance — which host/say-path it's bound to.
  # cmd_ensure_pull compares this against the caller's current env before
  # deciding a running loop is still the right one (F1: an ssh->ssh route
  # switch must not leave the pull-loop polling the old host).
  _pull_id > "$STATE_DIR/pull.id"
  printf '%s\n' "${SHUTTLE_TMUX:-}" > "$CHAN_TMUX"
  if [ "$PERSISTENT" != 1 ]; then
    _pull_loop_oneshot   # never returns
    return
  fi
  [ -p "$REQ_FIFO" ] || { rm -f "$REQ_FIFO"; mkfifo "$REQ_FIFO"; }
  # Hold BOTH ends open: writes never see EOF-less blocking across session
  # respawns, and reads (the drain) never block.
  exec 3<>"$REQ_FIFO"
  local backoff=2 started line rs
  rs="$(_remote_channel_script)"
  while :; do
    started=$SECONDS
    rm -f "$RESP_STATE"
    _ssh "$rs" <&3 2>>"$STATE_DIR/chan.err" | while IFS= read -r line; do
      case "$line" in
        "R "*)
          local_text=$(printf '%s' "${line#R }" | base64 -d 2>/dev/null) || local_text=""
          [ -n "$local_text" ] && _deliver_text "$local_text"
          ;;
        "OK "*|"ERR "*)
          printf '%s' "$line" > "$RESP_STATE.tmp" && mv "$RESP_STATE.tmp" "$RESP_STATE"
          ;;
      esac
    done
    _drain_fifo
    if [ $(( SECONDS - started )) -ge 30 ]; then backoff=2; fi
    echo "$(date -Is 2>/dev/null || date) channel session ended; respawn in ${backoff}s" >> "$STATE_DIR/chan.err"
    sleep "$backoff"
    backoff=$(( backoff * 2 )); [ "$backoff" -gt 15 ] && backoff=15
  done
}

# $1 pid -> 0 if it's alive AND looks like one of our own pull-loops. Guards
# against PID reuse: a stale pidfile pointing at a recycled PID that now
# belongs to an unrelated process must not be treated as our loop (F3).
_pid_is_ours() {
  [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null && grep -q 'ssh-brain-shuttle' "/proc/$1/cmdline" 2>/dev/null
}

cmd_status() {
  [ -f "$PIDFILE" ] && _pid_is_ours "$(cat "$PIDFILE" 2>/dev/null)"
}

cmd_ensure_pull() {
  need SHUTTLE_HOST; need SHUTTLE_REMOTE_SAY
  if cmd_status; then
    local want cur
    want="$(_pull_id)"
    cur="$(cat "$STATE_DIR/pull.id" 2>/dev/null)"
    if [ "$cur" = "$want" ]; then
      # Same host/say — but a channel bound to a different tmux target can't
      # carry this caller's deliveries; restart it bound to the new target.
      if [ -z "${SHUTTLE_TMUX:-}" ]; then return 0; fi
      if [ "$(cat "$CHAN_TMUX" 2>/dev/null)" = "$SHUTTLE_TMUX" ]; then return 0; fi
    fi
    # Running, but bound to a different identity than the caller wants now —
    # an ssh->ssh route switch. Stop the stale loop before starting a fresh
    # one bound to the new identity (F1).
    cmd_stop
  fi
  mkdir -p "$STATE_DIR"
  # setsid: the supervisor leads its own process group, so stop can kill the
  # WHOLE tree (pipeline subshells + the ssh client, which is a grandchild
  # pkill -P can't see). An orphaned ssh client keeps the remote session — and
  # its say-file watcher — alive as a reply-stealing zombie.
  if command -v setsid >/dev/null; then
    nohup setsid "$0" pull-loop >> "$STATE_DIR/pull.log" 2>&1 &
  else
    nohup "$0" pull-loop >> "$STATE_DIR/pull.log" 2>&1 &
  fi
  disown
  # Give it a beat to take the lock so back-to-back ensure-pull is stable.
  sleep 0.2
}

cmd_stop() {
  if [ -f "$PIDFILE" ]; then
    local pid; pid="$(cat "$PIDFILE" 2>/dev/null)"
    if _pid_is_ours "$pid"; then
      # An in-flight `_ssh` call inherits our flock fd across exec (opened
      # via `exec 9>...`, no close-on-exec), so it can keep holding
      # LOCKFILE for a moment even after the parent pull-loop is killed.
      # Nudge any such child directly, then poll for the lock to actually
      # free — not just for the tracked pid to die — before returning: a
      # caller that immediately starts a fresh loop (F1: ssh->ssh route
      # switch) needs the lock free, not merely the parent reaped.
      # Process-GROUP kill first (supervisor is a setsid leader): reaches the
      # pipeline subshells AND the ssh client — an orphaned ssh keeps the
      # remote watcher alive to steal the next session's replies. The -P/-pid
      # pair stays as the fallback for a non-setsid launch.
      kill -TERM -- "-$pid" 2>/dev/null
      pkill -TERM -P "$pid" 2>/dev/null
      kill "$pid" 2>/dev/null
      local i
      for i in $(seq 1 50); do
        ( exec 8>"$LOCKFILE"; flock -n 8 ) 2>/dev/null && break
        sleep 0.1
      done
    fi
    rm -f "$PIDFILE"
  fi
  rm -f "$STATE_DIR/pull.id" "$CHAN_TMUX" "$RESP_STATE"
}

cmd_purge_say() {
  # Ghost-reply hygiene for route switches: an aborted earlier route can leave
  # a written-but-never-pulled remote say (or a crashed pull's .claim) that a
  # fresh pull-loop would immediately speak. Callers run this before starting
  # a new pull-loop for the host.
  need SHUTTLE_HOST; need SHUTTLE_REMOTE_SAY
  local rsay; rsay="$(_remote_path "$SHUTTLE_REMOTE_SAY")"
  # Quotes survive to the remote shell (same idiom as the channel script): a
  # say path with a space or glob char must neither word-split nor expand.
  _ssh "rm -f -- \"$rsay\" \"$rsay.claim\""
}

case "${1:-}" in
  deliver)     shift; cmd_deliver "$@";;
  pull-loop)   cmd_pull_loop;;
  ensure-pull) cmd_ensure_pull;;
  stop)        cmd_stop;;
  status)      cmd_status;;
  purge-say)   cmd_purge_say;;
  *) die "usage: $0 deliver <file> | pull-loop | ensure-pull | stop | status | purge-say";;
esac
