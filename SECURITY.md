# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Open a private GitHub security advisory
(the repo's **Security → Report a vulnerability**) or contact the maintainer directly. Include repro
steps and impact; you'll get an acknowledgement within a few days.

## Threat model (what broca-machina assumes)

broca-machina bridges *audio in a Discord voice channel* to a *brain* you configure. Its safety
rests on a few assumptions — know them before deploying:

- **Single-user host.** The STT/TTS/VAD helpers talk over Unix sockets in `.voice-tmp/`; a local
  peer on the same machine (and, depending on umask, the same group) can reach them. Run it on a
  host you control.
- **Trusted brain.** Whatever you wire as the brain runs with your privileges. broca-machina does
  not sandbox it.
- **Untrusted speakers.** *Anyone you let speak* can drive the brain — see below.

## The one thing to get right: who may speak

An accepted utterance is transcribed and handed to your brain verbatim. With a `command` or `mcp`
brain — above all a tool-enabled agent (`claude -p`, an MCP agent) — that transcript is an
**untrusted prompt**, and a hostile or careless speaker can attempt prompt injection.

- The loop is **fail-closed**: it refuses to start unless you set `discord.allowedUserId` (only that
  user is transcribed) or explicitly set `discord.allowAnySpeaker: true`.
- **Keep `allowedUserId` set for any real brain.** Only open the mic for a harmless brain (the
  `echo` demo).
- Treat every transcript as untrusted input to your agent, exactly as you would text from a stranger.

## What is *not* exposed

- No network listener — all IPC is local Unix sockets; nothing binds a TCP port.
- The MCP `speak` tool voices text and nothing else: a connected host cannot run commands or touch
  files through it.
- The bot token is never stored in config; it comes from an env var or an out-of-repo token file.
