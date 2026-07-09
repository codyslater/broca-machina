# ollama — talk to a local model

Wire a Discord voice channel to a model running locally under
[Ollama](https://ollama.com). Everything stays on your machine.

```
you speak → Whisper STT → brain.sh → ollama → piper TTS → you hear the reply
```

## Set up Ollama

1. Install Ollama (see ollama.com) and start it — the daemon listens on
   `localhost:11434`.
2. Pull a small, fast model (voice replies want low latency):
   ```bash
   ollama pull llama3.2
   ```
3. Sanity check:
   ```bash
   echo "say hi in five words" | ollama run llama3.2
   ```

## Run it

1. Edit `config.json`: replace every `/ABS/PATH/TO/...` (the `stt`/`tts` Python +
   this repo's `src/stt.py` / `src/tts.py`, and `transport.cmd` → this folder's
   `brain.sh`), and fill in `discord.guildId` / `discord.channelId`.
2. Export the bot token:
   ```bash
   export DISCORD_VOICE_BOT_TOKEN=...
   ```
3. Launch from the repo root:
   ```bash
   bun src/voice_loop.js examples/ollama/config.json
   ```
4. Join the channel and start talking.

## Tuning (env vars)

`brain.sh` reads a few optional env vars — export them before launching
broca-machina (the brain command inherits its environment), or set them inside
`brain.sh` itself:

| Var | Default | Meaning |
|-----|---------|---------|
| `OLLAMA_MODEL` | `llama3.2` | which model to run |
| `OLLAMA_SYSTEM` | short "speak, don't format" prompt | system instruction |
| `OLLAMA_HTTP` | unset (CLI) | set `1` to use the HTTP endpoint instead of the CLI |
| `OLLAMA_URL` | `http://localhost:11434/v1/chat/completions` | endpoint for the HTTP path |

The **HTTP path** (`OLLAMA_HTTP=1`, needs `curl` + `jq`) hits Ollama's
OpenAI-compatible API, so the same `brain.sh` also works against any other local
OpenAI-compatible server (llama.cpp, LM Studio, vLLM, …) — just point
`OLLAMA_URL` at it.

## Notes

- Keep replies short. broca-machina truncates spoken replies to
  `maxReplyChars` (700 by default) and strips markdown, so the "reply in one or
  two sentences" system prompt matters.
- The model runs synchronously per turn — while it's thinking, the bot isn't
  listening. A snappy small model feels far more conversational than a big slow
  one. See [`../../docs/INTEGRATIONS.md`](../../docs/INTEGRATIONS.md) for why.
