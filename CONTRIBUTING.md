# Contributing

Thanks for wanting to make broca-machina better. It's a small, focused project — a Discord voice
channel bridged to any text brain — and contributions that keep it small and sharp are very welcome:
new transports, new STT/TTS engines, docs, and bug fixes especially.

## Dev setup

```bash
bun install                              # NOT npm — broca-machina must run under bun (see below)
cp config.example.json config.json       # edit guildId / channelId / allowedUserId / stt.cmd / tts.cmd / transport
export DISCORD_VOICE_BOT_TOKEN=...        # your voice bot token
bun src/voice_loop.js config.json        # foreground, logs to the terminal
```

For the default engines you'll also want ffmpeg on `PATH` and a Python env with `faster-whisper` +
`piper-tts`. Full walkthrough — Discord bot, intents, invite URL, Python env — in
[SETUP.md](SETUP.md); the design is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Always develop and run under `bun`, never `npm`/Node.** `@discordjs/voice` 0.19.2 (the version with
DAVE E2EE support) requires Node ≥ 22.12; `npm install` on an older Node silently pulls the broken
pre-DAVE 0.18.0. After `bun install`, confirm:

```bash
cat node_modules/@discordjs/voice/package.json | grep '"version"'   # → 0.19.2
```

## How to add a transport

A transport is the seam between the loop and the brain. There are two touch points in
`src/voice_loop.js`:

1. **out** — `sendTranscript(text)`: deliver a transcript to your brain. Branch on `T.type` and add
   your case (the existing `command` and `file` cases are the template).
2. **in** — `pollReply()`: get a reply back and hand it to `enqueueReply()` / let it be spoken. Add
   the polling or callback for your transport type here.

Keep the contract identical to the existing ones: transcript text goes out, plain reply text comes
back; `cleanForTTS` handles sanitization downstream, so don't pre-format for speech. Document the new
`transport.*` config fields in the [README config table](README.md#config-reference) and the
[transport table in ARCHITECTURE.md](docs/ARCHITECTURE.md#the-transport-abstraction).

## How to add a TTS / STT engine

You usually **don't need to touch `src/`** — engines are external commands with a fixed contract:

- **STT:** invoked as `[...stt.cmd, <wav>]`, print the transcript to **stdout**.
- **TTS:** invoked as `[...tts.cmd, <text>, <out.wav>]`, write a **WAV** to `<out.wav>`.

Point `stt.cmd` / `tts.cmd` at any binary satisfying that contract, in any language. Pass engine
config through `stt.env` / `tts.env`. If you're contributing a *bundled* engine alongside `src/stt.py`
/ `src/tts.py`, mirror their shape: a small script, env-var-configured, that honors the argument
contract (and, for TTS, respects `VOICE_TTS_SPEED`).

## Code style

- **JS core** (`src/voice_loop.js`): CommonJS, dependency-light, small pure helpers, terse
  `log()`-tagged tracing (`[recv]`, `[stt]`, `[tts]`, `[conn]`). Keep the core generic — **no
  app-specific IDs or paths** ever land in `src/`; host specifics go in a config under `adapters/`.
- **Python engines** (`src/stt.py`, `src/tts.py`): standard-library-first, env-var-configured,
  read args / write files per the contract above.
- Match the surrounding style rather than reformatting; keep diffs minimal and focused.

## PR expectations

- **One change per PR**, with a clear description of the problem and the approach.
- **Run the selftests** (CI runs them on every PR, but locally is faster):
  ```bash
  VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/lifecycle_selftest.mjs
  VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/tts_pipeline_selftest.mjs
  python3 test/vad_selftest.py
  ```
- **Test it against a real Discord voice channel** before opening the PR — this is a live-audio tool,
  so "it joins, transcribes, and speaks back" is the bar. Note what you ran in the PR description.
- **Update the docs** in the same PR when you change behavior or config: README config table,
  ARCHITECTURE.md, SETUP.md as applicable. Docs accuracy is a feature here.
- **Don't commit secrets or local paths.** `config.json` is gitignored; keep tokens in the env var
  named by `discord.tokenEnv`.
- Be kind in review. Small project, friendly bar — ask questions, propose alternatives, iterate.

By contributing you agree your work is licensed under the project's [MIT License](LICENSE).
