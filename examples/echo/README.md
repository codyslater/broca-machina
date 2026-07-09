# echo — verify the audio loop

The smallest possible brain. It repeats whatever you say back to you, so you can
confirm the entire pipeline works **before** wiring up a real LLM:

```
you speak → Discord → Whisper STT → echo_brain.sh → piper TTS → Discord → you hear "You said: ..."
```

If the echo comes back, your token, voice channel, STT, and TTS are all good and
any of the other examples will just work.

## How it works

This uses the **command** transport. For each utterance, broca-machina runs
`echo_brain.sh` with the transcript in the `$VOICE_TRANSCRIPT` environment
variable and speaks whatever the script prints to **STDOUT**. `echo_brain.sh`
prints `You said: <transcript>`.

## Run it

1. Edit `config.json` and replace every `/ABS/PATH/TO/...` with real absolute
   paths:
   - the two `stt`/`tts` entries → your Python interpreter (a venv with
     `faster-whisper` + `piper-tts`, or `python3` if those are installed
     globally) and this repo's `src/stt.py` / `src/tts.py`.
   - `transport.cmd` → the absolute path to `echo_brain.sh` in this folder.
2. Fill in `discord.guildId` and `discord.channelId` (the voice channel to join).
3. Export the bot token named by `discord.tokenEnv`:
   ```bash
   export DISCORD_VOICE_BOT_TOKEN=...
   ```
4. Launch from the repo root:
   ```bash
   bun src/voice_loop.js examples/echo/config.json
   ```
5. Join the voice channel and say something. You should hear it echoed back.

## Next

Once the echo works, copy this config, point `transport.cmd` at a real brain
(see `../ollama/` or `../claude-cli/`), and you're done. Full guide:
[`../../docs/INTEGRATIONS.md`](../../docs/INTEGRATIONS.md).
