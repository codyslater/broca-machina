# Wire broca-machina to ANY brain in 5 minutes

broca-machina handles the hard part — joining a Discord voice channel under
DAVE E2EE, receiving and decrypting audio, running speech-to-text, and speaking
replies back. Your "brain" only has to do one thing:

> **take a line of text (what the user said) and return a line of text (what to
> say back).**

That's it. An echo command, a local LLM, `claude -p`, a 2000-line agent — if it
turns text into text, it plugs in. This guide shows the three ways to connect it.

```
you speak → Discord → decrypt → Whisper STT ─┐
                                             ├─ TRANSPORT ─→ your brain
you hear it ← Discord ← play ← piper TTS ─────┘   (text in, text out)
```

---

## The three transports

You pick one in `config.json` under the `transport` key. They differ only in
*how the text gets to your brain and back*.

### 1. `command` — run a command per utterance (simplest)

broca-machina runs a command you specify, once per thing you say:

- The transcript is handed to the command in the **`$VOICE_TRANSCRIPT`**
  environment variable (not argv, not stdin).
- Whatever the command prints to **STDOUT** becomes the spoken reply.
- STDERR is ignored. Exit code is ignored. Empty stdout = nothing spoken.

```json
"transport": {
  "type": "command",
  "cmd": ["bash", "/abs/path/to/brain.sh"]
}
```

Minimal brain:

```bash
#!/usr/bin/env bash
set -uo pipefail
[ -n "${VOICE_TRANSCRIPT//[[:space:]]/}" ] || exit 0   # nothing said
echo "You said: $VOICE_TRANSCRIPT"
```

`cmd` is an argv array — `["bash", "/abs/brain.sh"]` is the robust form (no
executable bit or shebang dependency), but `["/abs/brain.sh"]`, a Python script,
a compiled binary, anything works. **Use absolute paths** — `cmd` resolves
against broca-machina's launch directory, not the config file's location.

**Use `command` when** your brain is a run-once "text in, text out" step: a CLI,
a curl to an API, a short script. This is the right default for almost everyone.

### 2. `file` — hand off through the filesystem

For a **long-running** brain (a persistent agent, a stateful chat session) that
you'd rather drive on its own schedule, broca-machina talks through two paths on
disk:

```json
"transport": {
  "type": "file",
  "transcriptDir": "/abs/transcripts_out",
  "replyFile":     "/abs/reply_in.txt"
}
```

- **IN:** each utterance is written to `transcriptDir/<utc-timestamp>.txt`.
  Timestamp names sort chronologically. broca-machina never deletes them —
  *you* consume and delete.
- **OUT:** write your reply text to `replyFile`. broca-machina polls it
  (~3×/sec), reads it, **deletes it**, and speaks it. Write **atomically**
  (temp file + `mv`) so the poller never catches a half-written file.

Whatever writes `replyFile` becomes the voice — it doesn't have to be the same
process that reads the transcripts. That decoupling is the whole point: it lets
an existing assistant that already has its own event loop treat voice as just
another inbox and outbox.

**Use `file` when** your brain is already a running process, needs conversation
state across turns, or you want broca-machina and the brain to live on separate
schedules.

## Routing between multiple brains

The `file` transport doesn't care who consumes `transcriptDir` and writes
`replyFile` — which means the *brain* can be switched at runtime without
touching broca-machina. The pattern (used by real deployments; ship your own
variant):

- **Route file** — your inbox consumer reads a small JSON file each tick,
  e.g. `{"type":"pane","target":"other-session","name":"dive"}` for another
  local tmux session, or
  `{"type":"ssh","host":"your-brain-host","tmux":"main","say":"~/.voice/say","name":"remote"}`
  for a brain on another machine. File absent → your default brain. Malformed
  → treat as absent (never wedge the channel on bad JSON).
- **Control phrases** — check each transcript against a small normalized
  phrase set *before* delivering it ("go back to ...", "connect me to ...").
  Handling these in the router means the speaker can always escape, even if
  the routed brain hangs.
- **Remote brains** — `scripts/ssh-brain-shuttle.sh` carries both streams
  over SSH to a brain in a tmux session on another host: `deliver <file>`
  pastes a transcript into the remote pane; `pull-loop` moves the remote
  reply file into your local `replyFile` atomically. Configure via
  `SHUTTLE_HOST/SHUTTLE_TMUX/SHUTTLE_REMOTE_SAY/SHUTTLE_LOCAL_REPLY` (see the
  script header; `ensure-pull`/`stop`/`status` manage the loop). Brains
  behind a bastion: point the ssh alias at a `ProxyJump` entry in
  `~/.ssh/config`. Use `ControlMaster` for ~tens-of-ms operations.
- **Handback** — a routed brain returns the channel by replying with exactly
  `<<HANDBACK>>` (configurable `SHUTTLE_SENTINEL`); the shuttle runs
  `SHUTTLE_ON_HANDBACK` instead of speaking it.
- **MCP deployments** — the `mcp` transport joins the same pattern via three
  optional keys: `transport.transcriptDir` tees every utterance to a file for
  your router; `transport.gateFile` (point it at your route file) suppresses
  the MCP channel notification while it exists, so an active route makes the
  default brain structurally deaf; `transport.replyFile` is polled as an
  additional voice source — your router or the shuttle's `pull-loop` writes
  replies there. One deployment can converse over MCP by default and hand the
  channel to another brain at runtime.

**Security:** the route file and your routes registry are trusted local
input — whoever holds the mic inherits the routed brain's privileges.
`allowedUserId` still gates whose speech is transcribed, and transcripts
remain untrusted text (see the prompt-injection note in the config example).
See `examples/file-transport/remote-brain.md` for a walkthrough.

### 3. `mcp` — the loop becomes an MCP server

For an **agent host that speaks MCP** (e.g. Claude Code), broca-machina can run
*as* an MCP server: it advertises a `speak(text)` tool and delivers each spoken
turn to the host as a channel event. The host replies by calling `speak`, which
voices the text back.

```json
"transport": { "type": "mcp", "source": "voice", "deliver": "channel" }
```

Register it by copying `.mcp.json.example` → `.mcp.json` and pointing it at
`adapters/mcp.config.example.json` (see the [README](../README.md#transports)).
Inbound delivery today targets Claude Code / channel-aware hosts; the `speak`
tool works for any host.

**Use `mcp` when** your brain is an MCP host and you want voice as a first-class
tool rather than a shell-out.

---

## Which one?

| | `command` | `file` | `mcp` |
|---|---|---|---|
| Brain shape | run-once command / script | long-running process | an MCP host (agent runtime) |
| Wiring | one `cmd` array | two paths + your own loop | `.mcp.json` + adapter config |
| Conversation state | stateless per turn (unless your command keeps it) | naturally stateful | the host's session |
| Who drives timing | broca-machina (blocks per turn) | you (independent) | the host |
| Best for | CLIs, API calls, quick scripts | agents, persistent sessions | Claude Code / MCP agents |

When in doubt, start with `command`. Move to `file` only when you specifically
need a persistent, self-scheduled brain.

---

## 5-minute quickstart

1. **Install prerequisites** (see the top-level `README.md`): `bun`, `ffmpeg`,
   and a Python env with `faster-whisper` (STT) + `piper-tts` (TTS).
2. **Make a second Discord bot** and get its token. (One gateway per bot — if you
   already run a text bot, the voice bot needs its own.)
3. **Copy the echo example and edit it:**
   ```bash
   cp examples/echo/config.json config.json
   ```
   In `config.json`, replace every `/ABS/PATH/TO/...` with real absolute paths
   (your Python interpreter + this repo's `src/stt.py` / `src/tts.py`, and the
   path to `examples/echo/echo_brain.sh`) and fill in `discord.guildId` /
   `discord.channelId`.
4. **Export the token and launch:**
   ```bash
   export DISCORD_VOICE_BOT_TOKEN=...
   bun src/voice_loop.js config.json
   ```
5. **Join the voice channel and talk.** You should hear your words echoed back.

If the echo works, swap `transport.cmd` for a real brain — you're done. Working
examples:

- [`examples/echo/`](../examples/echo/) — verify the loop
- [`examples/ollama/`](../examples/ollama/) — local model
- [`examples/claude-cli/`](../examples/claude-cli/) — `claude -p`
- [`examples/file-transport/`](../examples/file-transport/) — your own event loop

---

## Good to know (a few real behaviors)

- **STDOUT only.** For the `command` transport, only STDOUT is spoken. Print your
  reply there; send logs/errors to STDERR (they're discarded). If your command
  errors and prints nothing to STDOUT, nothing is spoken and nothing surfaces —
  test your brain standalone first:
  ```bash
  VOICE_TRANSCRIPT="hello there" bash /abs/path/to/brain.sh
  ```
- **One turn at a time.** While your `command` brain is running (computing a
  reply), broca-machina ignores new speech — so a slow brain is a window where
  you can't be heard. Keep replies fast, or set **`ackAfterMs`** (below) to speak
  a quick "still thinking" filler in that window. During *playback*, though, **barge-in**
  is on by default (`bargeIn`): start talking and the bot stops speaking
  immediately, so you never have to wait for it to finish a reply. Set
  `"bargeIn": false` to make replies always play to the end.
- **Replies are cleaned and truncated** before speaking: markdown, emoji, and
  URLs are stripped, and the text is cut to `maxReplyChars` (700 by default). So
  you don't need to strip formatting yourself — but ask your model for short,
  plain, spoken-style answers, or the tail gets cut off.
- **Empty/whitespace replies are skipped**, so returning nothing is a valid "say
  nothing." All the example scripts guard against empty `$VOICE_TRANSCRIPT` this
  way.
- **Absolute paths everywhere.** `stt.cmd`, `tts.cmd`, and `transport.cmd`
  resolve against the launch directory, not the config file. Absolute paths save
  you a confusing "command not found."
- **`file` transport wants atomic writes.** Write `replyFile` via temp file +
  `mv`; a plain `>` can be read mid-write. There's one reply slot (last-write
  wins), so pace writes to roughly one per spoken turn.

---

## Beyond text: optional hooks

These are set in `config.json` and are independent of the transport:

- **`tts.env`** — extra environment for the TTS process (e.g. a voice-model
  directory). **`tts.speedFile`** — a file holding a float; playback speed,
  pitch preserved.
- **`stt.env`** — extra environment for the STT process (model, device, compute
  type — see `src/stt.py`).
- **`playWavFile`** — write a path to a `.wav` here and broca-machina plays it
  into the channel. Handy for a pre-rendered greeting or a cloned-voice clip,
  independent of the text path.
- **`allowedUserId`** — restrict who the bot listens to. Required: the loop
  **fails closed** and refuses to start without it, unless you explicitly set
  `allowAnySpeaker: true` to accept anyone in the channel (see SECURITY.md —
  with an agent brain, every accepted speaker inherits its privileges).
- **`bargeIn`** (default `true`) — let the user interrupt playback by speaking.
  Set `false` to make every reply play to the end.
- **`ackAfterMs` / `ackPhrase`** — if the brain's reply hasn't arrived within
  `ackAfterMs` ms of you finishing speaking, speak a short filler once so a slow
  brain doesn't feel dead. `ackPhrase` is a string or an array — the default set
  (`"One moment."` / `"Hmm, let me think."` / …) rotates randomly, never
  repeating back-to-back, so the bot doesn't chant one line every turn. All
  phrases are pre-rendered at startup (so firing one is instant), it works for
  **every** transport, and a fast reply preempts it (no double-talk). `0` (the
  default) disables it. Best for slow LLM/agent brains — the `claude-cli` and
  `ollama` examples enable it (`600`); leave off for a fast echo.

To use a **custom or cloned voice**, point `tts.cmd` at your own synth CLI — the
loop only needs `<cmd> <text> <out.wav>`. Same for STT: any command that takes a
wav path and prints the transcript works in `stt.cmd`.
