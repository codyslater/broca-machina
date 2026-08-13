#!/usr/bin/env bash
# Selftest for scripts/ssh-brain-shuttle.sh. Needs passwordless `ssh localhost`
# and tmux; SKIPs cleanly (exit 0, "SKIP") when either is missing so CI/dev
# boxes without loopback SSH don't fail.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHUTTLE="$HERE/scripts/ssh-brain-shuttle.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

ssh -o BatchMode=yes -o ConnectTimeout=3 localhost true 2>/dev/null \
  || { echo "SKIP: no passwordless ssh localhost"; exit 0; }
command -v tmux >/dev/null || { echo "SKIP: no tmux"; exit 0; }

T="shuttletest$$"
D="$(mktemp -d)"
tmux new-session -d -s "$T" "bash -c 'while IFS= read -r l; do echo \"GOT:\$l\" >> $D/pane.log; done'"
trap 'tmux kill-session -t "$T" 2>/dev/null; "$SHUTTLE" stop 2>/dev/null; rm -rf "$D"' EXIT

export SHUTTLE_HOST=localhost SHUTTLE_TMUX="$T" \
       SHUTTLE_REMOTE_SAY="$D/say" SHUTTLE_LOCAL_REPLY="$D/reply" \
       SHUTTLE_STATE_DIR="$D/state" SHUTTLE_POLL_S=0.2 \
       SHUTTLE_ON_HANDBACK="touch $D/handback"

# 1. deliver pastes a transcript into the remote pane and submits it.
printf 'hello brain' > "$D/t1.txt"
"$SHUTTLE" deliver "$D/t1.txt" && sleep 1
grep -q 'GOT:hello brain' "$D/pane.log" 2>/dev/null \
  && ok "deliver reaches remote pane" || bad "deliver reaches remote pane"

# 2. deliver fails nonzero when the tmux target is missing.
SHUTTLE_TMUX="nosuch$$" "$SHUTTLE" deliver "$D/t1.txt" 2>/dev/null \
  && bad "deliver errors on missing target" || ok "deliver errors on missing target"

# 3. PID reuse guard (F3): a pidfile pointing at a live-but-unrelated process
#    (the test's own $$, alive, wrong cmdline) must not be treated as our
#    pull-loop — status must say "not running" and stop must not kill it.
mkdir -p "$D/state-reuse"
echo $$ > "$D/state-reuse/pull.pid"
SHUTTLE_STATE_DIR="$D/state-reuse" "$SHUTTLE" status \
  && bad "status rejects pid with unrelated cmdline" || ok "status rejects pid with unrelated cmdline"
SHUTTLE_STATE_DIR="$D/state-reuse" "$SHUTTLE" stop
kill -0 $$ 2>/dev/null && ok "stop does not kill unrelated live pid" || bad "stop does not kill unrelated live pid"
[ ! -f "$D/state-reuse/pull.pid" ] && ok "stop removes stale pidfile despite identity mismatch" \
  || bad "stop removes stale pidfile despite identity mismatch"

# 4. pull-loop moves remote say → local reply atomically.
"$SHUTTLE" ensure-pull; sleep 0.5
"$SHUTTLE" status || bad "pull-loop running after ensure-pull"
printf 'spoken reply' > "$D/say.tmp" && mv "$D/say.tmp" "$D/say"
for i in $(seq 1 20); do [ -f "$D/reply" ] && break; sleep 0.2; done
[ "$(cat "$D/reply" 2>/dev/null)" = "spoken reply" ] \
  && ok "pull-loop forwards reply" || bad "pull-loop forwards reply"
rm -f "$D/reply"

# 5. ensure-pull is idempotent (same pid).
P1="$(cat "$D/state/pull.pid")"; "$SHUTTLE" ensure-pull; P2="$(cat "$D/state/pull.pid")"
[ "$P1" = "$P2" ] && ok "ensure-pull idempotent" || bad "ensure-pull idempotent"

# 6. host switch (F1): ensure-pull with a different say path — simulating an
#    ssh->ssh route switch — must stop the stale loop and start a fresh one
#    bound to the new identity; only the new say path's replies come through.
P_OLD="$(cat "$D/state/pull.pid" 2>/dev/null)"
SAYB="$D/sayB"
SHUTTLE_REMOTE_SAY="$SAYB" "$SHUTTLE" ensure-pull; sleep 0.5
P_NEW="$(cat "$D/state/pull.pid" 2>/dev/null)"
[ -n "$P_OLD" ] && [ -n "$P_NEW" ] && [ "$P_OLD" != "$P_NEW" ] \
  && ok "host switch restarts pull-loop (pid changed)" || bad "host switch restarts pull-loop (pid changed)"
printf 'reply for stale say' > "$D/say.tmp" && mv "$D/say.tmp" "$D/say"
sleep 0.5
[ ! -f "$D/reply" ] && ok "host switch: stale say path no longer polled" || bad "host switch: stale say path no longer polled"
printf 'reply for new say' > "$SAYB.tmp" && mv "$SAYB.tmp" "$SAYB"
for i in $(seq 1 20); do [ -f "$D/reply" ] && break; sleep 0.2; done
[ "$(cat "$D/reply" 2>/dev/null)" = "reply for new say" ] \
  && ok "host switch: reply on new say path reaches local reply" || bad "host switch: reply on new say path reaches local reply"
rm -f "$D/reply" "$D/say"

# 7. sentinel triggers SHUTTLE_ON_HANDBACK and is NOT forwarded. (Loop from
#    test 6 is bound to SAYB — write the sentinel there.)
printf '<<HANDBACK>>' > "$SAYB.tmp" && mv "$SAYB.tmp" "$SAYB"
for i in $(seq 1 20); do [ -f "$D/handback" ] && break; sleep 0.2; done
[ -f "$D/handback" ] && ok "sentinel runs handback hook" || bad "sentinel runs handback hook"
[ ! -f "$D/reply" ] && ok "sentinel not forwarded" || bad "sentinel not forwarded"

# 7b. post-handback suppression: once the sentinel is consumed, the SAME
#     pull-loop must never forward anything further — a session streaming a
#     tail after <<HANDBACK>> races the handback hook's stop and would leak
#     into the voice channel (observed live 2026-08-13).
printf 'tail after handback' > "$SAYB.tmp" && mv "$SAYB.tmp" "$SAYB"
sleep 1.2
[ ! -f "$D/reply" ] && ok "post-handback tail suppressed" || bad "post-handback tail suppressed"
rm -f "$SAYB" "$D/reply"

# 8. stop terminates the loop.
"$SHUTTLE" stop; sleep 0.3
"$SHUTTLE" status 2>/dev/null && bad "stop kills pull-loop" || ok "stop kills pull-loop"
[ ! -f "$D/state/pull.id" ] && ok "stop removes pull.id" || bad "stop removes pull.id"

# 9. stranded-claim recovery (F5): a .claim file left behind by a previous
#    run that died mid-claim is recovered and forwarded the next time the
#    loop starts, instead of being lost forever.
printf 'stranded reply' > "$D/say.claim"
"$SHUTTLE" ensure-pull
for i in $(seq 1 20); do [ -f "$D/reply" ] && break; sleep 0.2; done
[ "$(cat "$D/reply" 2>/dev/null)" = "stranded reply" ] \
  && ok "stranded claim recovered on loop start" || bad "stranded claim recovered on loop start"
rm -f "$D/reply"   # later tests wait on this path — a stale file short-circuits their polls
"$SHUTTLE" stop

# 10. purge-say removes remote say + claim residue from an aborted route.
printf 'ghost reply' > "$D/say"
printf 'ghost claim' > "$D/say.claim"
"$SHUTTLE" purge-say \
  && ok "purge-say exits 0" || bad "purge-say exits 0"
[ ! -e "$D/say" ] && [ ! -e "$D/say.claim" ] \
  && ok "purge-say removes say and claim" || bad "purge-say removes say and claim"

# 11. purge-say survives a say path containing a space (remote quoting).
mkdir -p "$D/say dir"
printf 'ghost reply' > "$D/say dir/say"
printf 'ghost claim' > "$D/say dir/say.claim"
SHUTTLE_REMOTE_SAY="$D/say dir/say" "$SHUTTLE" purge-say \
  && ok "purge-say exits 0 on spaced path" || bad "purge-say exits 0 on spaced path"
[ ! -e "$D/say dir/say" ] && [ ! -e "$D/say dir/say.claim" ] \
  && ok "purge-say removes spaced-path say and claim" || bad "purge-say removes spaced-path say and claim"

# --- v2: persistent channel -------------------------------------------------

# 12. with the channel up, deliver rides it: ACKed rc 0, transcript lands.
"$SHUTTLE" ensure-pull; sleep 0.7
printf 'channel hello' > "$D/t12.txt"
t0=$SECONDS
"$SHUTTLE" deliver "$D/t12.txt"; rc=$?
CH_T=$((SECONDS - t0))
[ "$rc" -eq 0 ] && ok "channel deliver rc 0" || bad "channel deliver rc 0 (rc=$rc)"
dl=$((SECONDS+5)); while [ "$SECONDS" -lt "$dl" ]; do grep -q 'GOT:channel hello' "$D/pane.log" 2>/dev/null && break; sleep 0.2; done
grep -q 'GOT:channel hello' "$D/pane.log" 2>/dev/null \
  && ok "channel deliver reaches remote pane" || bad "channel deliver reaches remote pane"

# 13. channel replies still stream while deliveries flow (both directions on
#     one session).
printf 'reply over channel' > "$D/say.tmp" && mv "$D/say.tmp" "$D/say"
for i in $(seq 1 20); do [ -f "$D/reply" ] && break; sleep 0.2; done
[ "$(cat "$D/reply" 2>/dev/null)" = "reply over channel" ] \
  && ok "channel streams replies" || bad "channel streams replies"
rm -f "$D/reply"

# 14. identity guard: a deliver aimed at a DIFFERENT tmux target (e.g. the
#     teardown notice to a previous route's host) must not ride this channel —
#     one-shot fallback delivers it to ITS target.
T2="shuttletest2$$"
tmux new-session -d -s "$T2" "bash -c 'while IFS= read -r l; do echo \"GOT2:\$l\" >> $D/pane2.log; done'"
printf 'other target' > "$D/t14.txt"
SHUTTLE_TMUX="$T2" "$SHUTTLE" deliver "$D/t14.txt"; rc=$?
[ "$rc" -eq 0 ] && ok "mismatched-target deliver falls back cleanly" || bad "mismatched-target deliver falls back cleanly (rc=$rc)"
dl=$((SECONDS+5)); while [ "$SECONDS" -lt "$dl" ]; do grep -q 'GOT2:other target' "$D/pane2.log" 2>/dev/null && break; sleep 0.2; done
grep -q 'GOT2:other target' "$D/pane2.log" 2>/dev/null \
  && ok "fallback lands in ITS tmux target" || bad "fallback lands in ITS tmux target"
grep -q 'GOT:other target' "$D/pane.log" 2>/dev/null \
  && bad "mismatched deliver never leaks into the channel's target" || ok "mismatched deliver never leaks into the channel's target"
tmux kill-session -t "$T2" 2>/dev/null

# 15. channel respawn: kill the ssh session out from under the supervisor;
#     a deliver during the gap still succeeds (fallback), and after respawn
#     the channel carries replies again.
SUP="$(cat "$D/state/pull.pid")"
pkill -TERM -g "$SUP" -x ssh 2>/dev/null   # the session dies; the supervisor survives to respawn it
sleep 0.3
printf 'during gap' > "$D/t15.txt"
"$SHUTTLE" deliver "$D/t15.txt" \
  && ok "deliver during channel gap still succeeds" || bad "deliver during channel gap still succeeds"
sleep 3   # supervisor backoff (2s) + session start
printf 'post respawn reply' > "$D/say.tmp" && mv "$D/say.tmp" "$D/say"
for i in $(seq 1 40); do [ -f "$D/reply" ] && break; sleep 0.2; done
[ "$(cat "$D/reply" 2>/dev/null)" = "post respawn reply" ] \
  && ok "replies resume after channel respawn" || bad "replies resume after channel respawn"
rm -f "$D/reply"
"$SHUTTLE" stop

# 16. SHUTTLE_PERSISTENT=0 keeps pure v1 behavior (poll loop, one-shot ops).
SHUTTLE_PERSISTENT=0 "$SHUTTLE" ensure-pull; sleep 0.5
printf 'v1 mode reply' > "$D/say.tmp" && mv "$D/say.tmp" "$D/say"
for i in $(seq 1 20); do [ -f "$D/reply" ] && break; sleep 0.2; done
[ "$(cat "$D/reply" 2>/dev/null)" = "v1 mode reply" ] \
  && ok "PERSISTENT=0 pull works (v1 mode)" || bad "PERSISTENT=0 pull works (v1 mode)"
printf 'v1 mode deliver' > "$D/t16.txt"
SHUTTLE_PERSISTENT=0 "$SHUTTLE" deliver "$D/t16.txt" \
  && ok "PERSISTENT=0 deliver works (one-shot)" || bad "PERSISTENT=0 deliver works (one-shot)"
"$SHUTTLE" stop
rm -f "$D/reply"

# 17. SHUTTLE_REPLY_GATE: a router-owned veto evaluated before forwarding
#     each pulled reply. Nonzero -> dropped (e.g. "route no longer points at
#     this host" — the teardown notice provokes the old host's goodbye and it
#     must not be voiced); zero -> forwards normally.
SHUTTLE_REPLY_GATE=false "$SHUTTLE" ensure-pull; sleep 0.7
printf 'gated reply' > "$D/say.tmp" && mv "$D/say.tmp" "$D/say"
sleep 1.2
[ ! -f "$D/reply" ] && ok "reply gate: nonzero gate suppresses" || bad "reply gate: nonzero gate suppresses"
"$SHUTTLE" stop
SHUTTLE_REPLY_GATE=true "$SHUTTLE" ensure-pull; sleep 0.7
printf 'ungated reply' > "$D/say.tmp" && mv "$D/say.tmp" "$D/say"
for i in $(seq 1 20); do [ -f "$D/reply" ] && break; sleep 0.2; done
[ "$(cat "$D/reply" 2>/dev/null)" = "ungated reply" ] \
  && ok "reply gate: zero gate forwards" || bad "reply gate: zero gate forwards"
"$SHUTTLE" stop
rm -f "$D/reply"

echo "PASS=$PASS FAIL=$FAIL"; [ "$FAIL" -eq 0 ]
