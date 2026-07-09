#!/usr/bin/env bash
# echo_brain.sh — the simplest possible broca-machina "brain".
#
# The COMMAND transport runs this script once per utterance. The transcript of
# what you said arrives in the $VOICE_TRANSCRIPT environment variable. Whatever
# this script prints to STDOUT becomes the spoken reply. That's the whole
# contract — no arguments, no stdin.
#
# Use it to prove out the full audio loop (mic -> STT -> brain -> TTS -> speaker)
# before you wire in a real LLM. Swap this script for ollama/brain.sh,
# claude-cli/brain.sh, or anything of your own once you hear it echo back.
set -uo pipefail

transcript="${VOICE_TRANSCRIPT:-}"

# Nothing said (empty or whitespace-only)? Print nothing — the loop skips
# empty replies and stays silent.
if [ -z "${transcript//[[:space:]]/}" ]; then
  exit 0
fi

printf 'You said: %s\n' "$transcript"
