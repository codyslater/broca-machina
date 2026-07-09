# broca-machina — Setup

A start-to-finish walkthrough: create a Discord bot, invite it with voice permissions, install the
prerequisites, fill out the config, and run. Every command is copy-pasteable. Total time: ~15
minutes.

If you just want the short version, see the [Quickstart in the README](README.md#quickstart).

---

## 1. Create a Discord application + bot

> **Already run a text bot on this account?** Discord allows **one gateway connection per bot**, so
> your existing bot can't also do voice here. Create a **new, separate** application/bot just for
> broca-machina and use *its* token below.

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New
   Application**. Name it (e.g. `broca-machina`).
2. Open the **Bot** tab → **Add Bot**.
3. Under **Privileged Gateway Intents**, broca-machina only needs the standard **Guilds** and
   **Guild Voice States** intents — these are *not* privileged, so there's nothing to toggle here.
   You do **not** need Message Content or Presence intents. (If you enabled anything extra, it's
   harmless.)
4. Click **Reset Token** → **Copy**. This is your **bot token** — treat it like a password. You'll
   put it in an environment variable, never in the config file.

The loop requests exactly these gateway intents in code:

```
GatewayIntentBits.Guilds
GatewayIntentBits.GuildVoiceStates
```

---

## 2. Invite the bot with Connect + Speak

The bot needs two voice permissions: **Connect** (join the channel) and **Speak** (play audio).

**Easiest — OAuth URL Generator:** in the Developer Portal → **OAuth2** → **URL Generator**:

- **Scopes:** check `bot`
- **Bot Permissions:** check **Connect** and **Speak**
- Copy the generated URL, open it, and pick your server.

**Or build the URL by hand.** The shape is:

```
https://discord.com/api/oauth2/authorize?client_id=<YOUR_APPLICATION_ID>&scope=bot&permissions=3145728
```

- `client_id` — your application's **Application ID** (General Information tab).
- `permissions=3145728` — Connect (`1 << 20` = `1048576`) + Speak (`1 << 21` = `2097152`) =
  `3145728`. (Adding more permissions is fine; these two are the minimum.)

Open the URL, authorize it into your server, and confirm the bot appears in the member list.

---

## 3. Find your guild and channel IDs

Enable Discord **Developer Mode** (User Settings → Advanced → Developer Mode). Then:

- **Guild ID:** right-click the server icon → **Copy Server ID**.
- **Channel ID:** right-click the target **voice** channel → **Copy Channel ID**.

Keep both — they go into `discord.guildId` and `discord.channelId`.

To restrict transcription to only yourself (**recommended** — see the
[Security section](README.md#security)), right-click your own name → **Copy User ID** and use it for
`discord.allowedUserId`. broca-machina **fails closed**: it won't start unless you set `allowedUserId`
or explicitly set `discord.allowAnySpeaker: true` to accept anyone in the channel.

---

## 4. Install prerequisites

### bun (the runtime — required)

broca-machina must run under **bun**, not `npm`/Node. `@discordjs/voice` 0.19.2 (which carries the
DAVE E2EE support Discord now requires) needs Node ≥ 22.12; `npm install` on an older Node silently
installs the broken pre-DAVE 0.18.0.

```bash
curl -fsSL https://bun.sh/install | bash    # then restart your shell, or: source ~/.bashrc
bun --version                                # confirm it's on PATH
```

Install the JS dependencies from the repo root:

```bash
cd broca-machina
bun install
# sanity check: this should print 0.19.2
cat node_modules/@discordjs/voice/package.json | grep '"version"'
```

### ffmpeg (required)

Used to downsample received audio to 16 kHz mono and for pitch-preserved TTS speed changes.

```bash
# Debian/Ubuntu
sudo apt-get install -y ffmpeg
# macOS
brew install ffmpeg

ffmpeg -version    # confirm it's on PATH
```

### Python env with faster-whisper + piper-tts (default STT/TTS)

Any Python 3.9+ environment works. A dedicated venv keeps it clean:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install faster-whisper piper-tts
```

Note the **absolute path** to that interpreter — you'll reference it in the config:

```bash
echo "$(pwd)/.venv/bin/python"
```

The Whisper model downloads on first transcription; the Piper voice (`en_US-amy-medium` by default)
downloads on first synthesis into `~/.cache/broca-machina/piper`. First run is slower while those
fetch.

> Prefer a different STT/TTS engine? You don't need this venv at all — point `stt.cmd` / `tts.cmd`
> at any binary that satisfies the contract (STT: `<cmd> <wav>` → transcript on stdout; TTS:
> `<cmd> <text> <out.wav>` → WAV written).

---

## 5. Fill out config.json

```bash
cp config.example.json config.json
```

Edit `config.json` (replace `/abs/path/to/venv/bin/python` with the interpreter from step 4):

```json
{
  "discord": {
    "guildId": "YOUR_GUILD_ID",
    "channelId": "YOUR_VOICE_CHANNEL_ID",
    "allowedUserId": "YOUR_DISCORD_USER_ID",
    "tokenEnv": "DISCORD_VOICE_BOT_TOKEN"
  },
  "stt": {
    "cmd": ["/abs/path/to/venv/bin/python", "src/stt.py"]
  },
  "tts": {
    "cmd": ["/abs/path/to/venv/bin/python", "src/tts.py"],
    "speedFile": null
  },
  "transport": {
    "type": "file",
    "transcriptDir": "/abs/path/to/transcripts_out",
    "replyFile": "/abs/path/to/reply_in.txt"
  },
  "playWavFile": null,
  "endSilenceMs": 1000,
  "minUtteranceSec": 0.4,
  "maxReplyChars": 700
}
```

- `stt.cmd` / `tts.cmd` — the loop appends the WAV path (STT) or `<text> <out.wav>` (TTS), so leave
  those off; just give the interpreter + script.
- With the **`file`** transport above, transcripts appear in `transcriptDir` and you speak by
  writing text into `replyFile`. To have a command produce replies instead, use the `command`
  transport — see [Transports](README.md#transports).
- `config.json` is gitignored, so your local paths won't be committed. The full field-by-field table
  is in the [README Config reference](README.md#config-reference).

---

## 6. Set the token and run

The token goes in the environment variable named by `discord.tokenEnv` (default
`DISCORD_VOICE_BOT_TOKEN`) — **not** in the config file.

```bash
export DISCORD_VOICE_BOT_TOKEN='paste-your-bot-token'
scripts/voice-up.sh config.json
```

`voice-up.sh` backgrounds the loop, writes a PID file and a log under `.voice-tmp/`, and waits for
startup, printing `LIVE` on success or `FAILED` with a log tail on error. Prefer to keep
the token out of your shell history? Put it in a file and point the script at it:

```bash
printf 'DISCORD_VOICE_BOT_TOKEN=paste-your-bot-token\n' > .env
VOICE_TOKEN_ENVFILE=.env scripts/voice-up.sh config.json
```

To run in the foreground instead (logs straight to your terminal):

```bash
export DISCORD_VOICE_BOT_TOKEN='paste-your-bot-token'
bun src/voice_loop.js config.json
```

A healthy start looks like:

```
=== BOOT 2026-07-04T12:00:00Z ===
12:00:01 [loop] logged in as broca-machina#1234
12:00:02 [conn] signalling->connecting
12:00:02 [loop] joined voice channel <your-channel-id> (startup)
12:00:02 [loop] LIVE
```

Join the same voice channel and start talking. To stop:

```bash
scripts/voice-down.sh
```

---

## Troubleshooting

Hit a wall? The common failures — DAVE / close-code-4017, bun vs. npm, the second-bot requirement,
missing ffmpeg, CPU latency — are covered in the
[README Troubleshooting section](README.md#troubleshooting).
