#!/usr/bin/env bash
# brain.sh — talk to Claude Code (headless) in a Discord voice channel.
#
# The COMMAND transport runs this once per utterance: the transcript arrives in
# $VOICE_TRANSCRIPT, and whatever we print to STDOUT is spoken back. This script
# runs `claude -p "<transcript>"` (Claude Code's non-interactive/print mode) and
# passes its answer straight through.
#
# Requires Claude Code installed and on PATH (the `claude` command). See README.
#
# Env (all optional):
#   CLAUDE_BIN     path to the claude CLI      (default: claude)
#   CLAUDE_MODEL   model to use                (default: your CLI's default)
#   CLAUDE_SYSTEM  extra system instruction    (default: keep replies short + spoken)
set -uo pipefail

transcript="${VOICE_TRANSCRIPT:-}"

# Nothing said? Stay silent (the loop skips empty replies).
if [ -z "${transcript//[[:space:]]/}" ]; then
  exit 0
fi

bin="${CLAUDE_BIN:-claude}"
if ! command -v "$bin" >/dev/null 2>&1; then
  # Diagnostics go to STDERR (the loop ignores it); STDOUT stays empty so
  # nothing is spoken.
  echo "claude-cli brain: '$bin' not found on PATH — is Claude Code installed?" >&2
  exit 0
fi

system="${CLAUDE_SYSTEM:-Reply in one or two short, spoken-style sentences. No markdown, no code blocks, no lists.}"

args=(-p "$transcript" --append-system-prompt "$system")
if [ -n "${CLAUDE_MODEL:-}" ]; then
  args+=(--model "$CLAUDE_MODEL")
fi

"$bin" "${args[@]}"
