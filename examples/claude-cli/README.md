# claude-cli — talk to Claude Code

Speak to [Claude Code](https://docs.claude.com/en/docs/claude-code) in a Discord
voice channel. Each thing you say becomes a headless `claude -p` prompt and the
answer is spoken back.

```
you speak → Whisper STT → brain.sh → claude -p → piper TTS → you hear the reply
```

## Requirements

- **Claude Code installed and on PATH** — the `claude` command must run from
  your shell. Check with:
  ```bash
  claude -p "say hi in five words"
  ```
- You must be logged in / authenticated the same way you normally use Claude
  Code (the CLI uses your existing credentials — this script adds nothing).

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
   bun src/voice_loop.js examples/claude-cli/config.json
   ```
4. Join the channel and talk to Claude.

## Tuning (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `CLAUDE_BIN` | `claude` | path to the CLI, if not on PATH |
| `CLAUDE_MODEL` | your CLI default | pass a specific model |
| `CLAUDE_SYSTEM` | short "speak, don't format" prompt | appended system instruction |

If your installed Claude Code version doesn't accept `--append-system-prompt` or
`--model`, trim those from `brain.sh` — the only line that matters is
`claude -p "$transcript"`.

## Notes

- Each turn is a **fresh, stateless** `claude -p` call — there's no conversation
  memory across utterances. For a persistent, stateful assistant, use the
  **file** transport and drive your own long-lived session. See
  [`../file-transport/`](../file-transport/) and
  [`../../docs/INTEGRATIONS.md`](../../docs/INTEGRATIONS.md).
- Keep replies short — spoken output is truncated to `maxReplyChars` (700 by
  default) and markdown is stripped, which is why the default system prompt asks
  for one or two plain sentences.
- Claude may take a few seconds per turn. This example sets `ackAfterMs: 600`, so
  ~0.6 s after you finish speaking you'll hear a short filler ("One moment.",
  "Hmm, let me think.", …) while Claude works instead of dead air — the real
  answer follows (a fast reply preempts the filler). While it's working the bot
  isn't listening (see INTEGRATIONS.md).
