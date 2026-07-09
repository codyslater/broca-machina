#!/usr/bin/env python3
"""broca-machina TTS: synthesize <text> to <out.wav>.

Default engine: piper (fast, CPU). Env:
  PIPER_VOICE      (default en_US-amy-medium)
  PIPER_VOICE_DIR  (default ~/.cache/broca-machina/piper)
  VOICE_TTS_SPEED  (default 1.0; >1 faster, pitch preserved via ffmpeg atempo)

For a cloned voice (e.g. Chatterbox), point the config's tts.cmd at your own
clone CLI instead — the loop only needs `<cmd> <text> <out.wav>`.

For warm reuse, `tts_server.py` loads the voice once and `tts_client.py` sends
over a socket — the functions below are shared by both paths so the synthesis
logic stays in one place.
"""
import os
import subprocess
import sys
import tempfile
import wave


def load_voice():
    """Load the piper voice model (downloading it once if missing)."""
    from piper import PiperVoice
    from piper.download_voices import download_voice

    voice_name = os.environ.get("PIPER_VOICE", "en_US-amy-medium")
    cache = os.environ.get("PIPER_VOICE_DIR") or os.path.expanduser("~/.cache/broca-machina/piper")
    os.makedirs(cache, exist_ok=True)
    model = os.path.join(cache, f"{voice_name}.onnx")
    if not os.path.exists(model):
        download_voice(voice_name, cache)
    return PiperVoice.load(model)


def synth(voice, text):
    """Synthesize text with a loaded voice -> (pcm_bytes, sample_rate)."""
    pcm = b"".join(c.audio_int16_bytes for c in voice.synthesize(text))
    return pcm, getattr(voice.config, "sample_rate", 22050)


def synth_cold(text):
    """Load the voice and synthesize in one shot (per-call, no warm reuse)."""
    return synth(load_voice(), text)


def wrap_wav(pcm, sr, path):
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm)


def parse_speed(raw):
    """Parse a VOICE_TTS_SPEED-style value, clamped to [0.25, 4.0].

    The clamp is load-bearing: write_out's atempo staging loop assumes a
    positive finite factor — 0, a negative, or NaN would spin it forever (and
    permanently wedge the single-threaded warm tts_server). Unparseable or
    NaN input falls back to 1.0.
    """
    try:
        speed = float(raw or "1.0")
    except (TypeError, ValueError):
        return 1.0
    if speed != speed:  # NaN
        return 1.0
    return min(max(speed, 0.25), 4.0)


def write_out(pcm, sr, out, speed=1.0):
    """Write PCM to `out` as a mono WAV, applying pitch-preserving speedup."""
    if abs(speed - 1.0) < 0.01:
        wrap_wav(pcm, sr, out)
        return
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        wrap_wav(pcm, sr, tf.name)
        tmp = tf.name
    factor, stages = speed, []
    while factor > 2.0:
        stages.append("atempo=2.0")
        factor /= 2.0
    while factor < 0.5:
        stages.append("atempo=0.5")
        factor *= 2.0
    stages.append(f"atempo={factor:.3f}")
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", tmp, "-filter:a", ",".join(stages), out],
        check=False,
    )
    os.unlink(tmp)


def main() -> int:
    if len(sys.argv) < 3:
        sys.stderr.write("usage: tts.py <text> <out.wav>\n")
        return 2
    text, out = sys.argv[1], sys.argv[2]
    if not text.strip():
        return 1
    pcm, sr = synth_cold(text)
    write_out(pcm, sr, out, parse_speed(os.environ.get("VOICE_TTS_SPEED", "1.0")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
