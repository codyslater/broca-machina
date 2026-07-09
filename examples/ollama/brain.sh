#!/usr/bin/env bash
# brain.sh — a broca-machina "brain" backed by a local Ollama model.
#
# The COMMAND transport runs this once per utterance: the transcript arrives in
# $VOICE_TRANSCRIPT, and whatever we print to STDOUT becomes the spoken reply.
#
# Two backends, pick with $OLLAMA_HTTP:
#   unset / 0 : `ollama run <model>`                      (needs the `ollama` CLI)
#   1         : POST to the OpenAI-compatible /v1 endpoint (needs `curl` + `jq`)
#
# Env (all optional):
#   OLLAMA_MODEL   model name         (default: llama3.2)
#   OLLAMA_HTTP    1 = use HTTP+curl  (default: unset -> CLI)
#   OLLAMA_URL     chat endpoint      (default: http://localhost:11434/v1/chat/completions)
#   OLLAMA_SYSTEM  system prompt      (default: a short "speak, don't format" instruction)
set -uo pipefail

transcript="${VOICE_TRANSCRIPT:-}"

# Nothing said? Stay silent (the loop skips empty replies).
if [ -z "${transcript//[[:space:]]/}" ]; then
  exit 0
fi

model="${OLLAMA_MODEL:-llama3.2}"
system="${OLLAMA_SYSTEM:-You are a voice assistant. Reply in one or two short, spoken sentences. No markdown, no lists, no code blocks.}"

if [ "${OLLAMA_HTTP:-0}" = "1" ]; then
  # OpenAI-compatible HTTP path — works with any local endpoint that speaks it.
  url="${OLLAMA_URL:-http://localhost:11434/v1/chat/completions}"
  payload="$(jq -n \
    --arg m "$model" \
    --arg s "$system" \
    --arg u "$transcript" \
    '{model: $m, stream: false, messages: [
        {role: "system", content: $s},
        {role: "user",   content: $u}
      ]}')"
  curl -fsS "$url" \
    -H 'Content-Type: application/json' \
    -d "$payload" \
    | jq -r '.choices[0].message.content // empty'
else
  # CLI path — prompt is fed on STDIN so quotes/newlines can't break anything.
  # The system line is prepended to the prompt (plain `ollama run` has no
  # separate system flag).
  printf '%s\n\n%s\n' "$system" "$transcript" | ollama run "$model" 2>/dev/null
fi
