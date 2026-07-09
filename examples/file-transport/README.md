# file-transport — bring your own event loop

Use this when your brain is a **long-running process** rather than a
run-once command — a persistent agent, a stateful assistant, a chat session you
want to keep alive across turns. Instead of broca-machina calling you, the two
sides talk through the filesystem, and each side runs on its own schedule.

This is a common way to integrate an existing assistant: transcripts drop into
an inbox the assistant already watches, and the assistant writes replies to a
file broca-machina is polling — neither side imports the other.

## The contract

Two paths, set in `config.json` under `transport`:

```json
"transport": {
  "type": "file",
  "transcriptDir": "/abs/transcripts_out",
  "replyFile":     "/abs/reply_in.txt"
}
```

**IN — transcripts (broca-machina → you).** For every utterance, broca-machina
writes one file to `transcriptDir`:

- Filename is a UTC timestamp, e.g. `20260704_142530_004000.txt` — so a
  lexical sort is chronological.
- Contents are the raw transcript text (no trailing newline guaranteed).
- broca-machina never deletes these. **You** consume and delete them.

**OUT — replies (you → broca-machina).** To speak something, write the text to
`replyFile`:

- broca-machina polls `replyFile` (~3×/sec). When it exists, it reads it,
  **deletes it**, cleans it (strips markdown/emoji/URLs, truncates to
  `maxReplyChars`), and speaks it.
- **Write atomically** — build a temp file and `mv` it into place. A plain
  `>` redirect can be read mid-write and get truncated. `mv` within the same
  filesystem is atomic.
- One reply slot, last-write-wins. If you write two replies faster than the
  poller reads (~300 ms), the first can be overwritten. Pace your writes, or let
  each reply finish speaking before queuing the next.
- There is **no request/response correlation** built in: transcripts are a
  stream in, replies are a stream out. If you want strict turn-taking, only
  write the next reply after you've consumed the next transcript.
- **Slow brain?** Set `"ackAfterMs": 600` in the config — if the reply hasn't
  landed within that many ms of you finishing speaking, broca-machina speaks a
  short "still thinking" filler (pre-rendered, so it fires instantly; the
  default `ackPhrase` set rotates a few phrases so it never chants one line) so
  the channel doesn't feel dead while you think. A fast reply preempts it, so
  you never get both.

## Try it

`file_brain.sh` in this folder is a ready-to-run reference host loop — it watches
`transcriptDir`, echoes each transcript, and writes replies atomically to
`replyFile`. Use it to see the transport work end to end.

1. Edit `config.json`: replace every `/ABS/PATH/TO/...` and fill in the
   `discord` IDs. The example points `transcriptDir`/`replyFile` at
   `transcripts_out/` and `reply_in.txt` in this folder.
2. Start broca-machina (repo root):
   ```bash
   export DISCORD_VOICE_BOT_TOKEN=...
   bun src/voice_loop.js examples/file-transport/config.json
   ```
3. In a second terminal, start the reference host loop with the **same two
   paths** you put in the config:
   ```bash
   bash examples/file-transport/file_brain.sh \
     examples/file-transport/transcripts_out \
     examples/file-transport/reply_in.txt
   ```
4. Join the channel and talk — you'll hear the echo, produced entirely by the
   separate `file_brain.sh` process.

Then replace the "your brain goes here" block in `file_brain.sh` with a real
call, or delete it entirely and drive `replyFile` from your own process.

## file vs command

If your brain is a simple "text in, text out" command, the **command** transport
is less plumbing — see [`../echo/`](../echo/), [`../ollama/`](../ollama/),
[`../claude-cli/`](../claude-cli/). Full comparison:
[`../../docs/INTEGRATIONS.md`](../../docs/INTEGRATIONS.md).
