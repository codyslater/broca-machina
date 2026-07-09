#!/usr/bin/env python3
"""broca-machina TTS warm server.

Loads the piper voice ONCE and serves synthesis requests over a Unix-domain
socket, so per-reply latency drops the cold piper load that `tts.py` pays.

Usage:
  tts_server.py [sock_path]
Socket path resolution: argv[1] > $VOICE_TTS_SOCK > <repo>/.voice-tmp/tts.sock

Request  (JSON): {"text": "...", "out_wav": "/abs/out.wav", "speed": 1.0}
Response (JSON): {"ok": true}  |  {"ok": false, "error": "..."}

Voice/dir honor the same PIPER_* env vars as tts.py. `speed` uses the same
ffmpeg atempo (pitch-preserving) path.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _voicesock as vs  # noqa: E402
import tts  # noqa: E402


def _log(msg):
    sys.stderr.write(f"{time.strftime('%H:%M:%S')} [tts_server] {msg}\n")
    sys.stderr.flush()


def main() -> int:
    sock_path = (
        sys.argv[1] if len(sys.argv) > 1
        else os.environ.get("VOICE_TTS_SOCK") or vs.default_sock_path(vs.DEFAULT_TTS_SOCK)
    )
    _log(f"loading voice {os.environ.get('PIPER_VOICE', 'en_US-amy-medium')} ...")
    t0 = time.time()
    voice = tts.load_voice()
    try:
        tts.synth(voice, "warm up")  # prime onnxruntime kernels
    except Exception as exc:
        _log(f"warmup skipped: {exc}")
    _log(f"voice loaded + warmed in {time.time() - t0:.2f}s")

    def handle(req):
        text = (req.get("text") or "").strip()
        out = req.get("out_wav")
        if not text:
            return {"ok": False, "error": "empty text"}
        if not out:
            return {"ok": False, "error": "missing 'out_wav'"}
        speed = tts.parse_speed(req.get("speed", 1.0))
        t = time.time()
        pcm, sr = tts.synth(voice, text)
        tts.write_out(pcm, sr, out, speed)
        _log(f"synth {len(text)} chars @ speed {speed:g} in {time.time() - t:.2f}s")
        return {"ok": True}

    vs.serve(sock_path, handle, log=_log)
    return 0


if __name__ == "__main__":
    sys.exit(main())
