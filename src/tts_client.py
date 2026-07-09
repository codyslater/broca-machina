#!/usr/bin/env python3
"""broca-machina TTS client — drop-in for tts.py.

Same CLI:  tts_client.py <text> <out.wav>   ->   writes a mono WAV.
Honors VOICE_TTS_SPEED exactly like tts.py.

Sends the request to the warm `tts_server.py` over its Unix socket. If the
socket is missing or the server is down/erroring, falls back to a cold
in-process piper load (identical to tts.py) so it never hard-fails.

Socket path: $VOICE_TTS_SOCK > <repo>/.voice-tmp/tts.sock
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _voicesock as vs  # noqa: E402
import tts  # noqa: E402


def _warm(text, out, speed):
    sock = os.environ.get("VOICE_TTS_SOCK") or vs.default_sock_path(vs.DEFAULT_TTS_SOCK)
    resp = vs.request(sock, {"text": text, "out_wav": os.path.abspath(out), "speed": speed})
    if not resp.get("ok"):
        raise RuntimeError(resp.get("error", "server error"))


def _cold(text, out, speed):
    pcm, sr = tts.synth_cold(text)
    tts.write_out(pcm, sr, out, speed)


def main() -> int:
    if len(sys.argv) < 3:
        sys.stderr.write("usage: tts_client.py <text> <out.wav>\n")
        return 2
    text, out = sys.argv[1], sys.argv[2]
    if not text.strip():
        return 1
    speed = tts.parse_speed(os.environ.get("VOICE_TTS_SPEED", "1.0"))
    try:
        _warm(text, out, speed)
    except Exception as exc:
        sys.stderr.write(f"[tts_client] warm path failed ({type(exc).__name__}: {exc}); cold fallback\n")
        _cold(text, out, speed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
