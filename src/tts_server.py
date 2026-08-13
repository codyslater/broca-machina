#!/usr/bin/env python3
"""broca-machina TTS warm server.

Loads the configured engine ONCE (VOICE_TTS_ENGINE: piper or kokoro — see
tts.py) and serves synthesis requests over a Unix-domain socket, so per-reply
latency drops the cold engine load that `tts.py` pays.

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
from _ttscache import WavCache  # noqa: E402


def _log(msg):
    sys.stderr.write(f"{time.strftime('%H:%M:%S')} [tts_server] {msg}\n")
    sys.stderr.flush()


def main() -> int:
    sock_path = (
        sys.argv[1] if len(sys.argv) > 1
        else os.environ.get("VOICE_TTS_SOCK") or vs.default_sock_path(vs.DEFAULT_TTS_SOCK)
    )
    t0 = time.time()
    engine = tts.load_engine()
    _log(f"engine {engine.name} loaded"
         + (f" (providers: {', '.join(engine.providers)})" if getattr(engine, "providers", None) else ""))
    try:
        engine.synth("warm up", 1.0)  # prime onnxruntime kernels
    except Exception as exc:
        _log(f"warmup skipped: {exc}")
    _log(f"engine loaded + warmed in {time.time() - t0:.2f}s")
    cache = WavCache()

    def handle(req):
        text = (req.get("text") or "").strip()
        out = req.get("out_wav")
        if not text:
            return {"ok": False, "error": "empty text"}
        if not out:
            return {"ok": False, "error": "missing 'out_wav'"}
        speed = tts.parse_speed(req.get("speed", 1.0))
        key = (text, speed)
        wav = cache.get(key)
        if wav is not None:
            try:
                with open(out, "wb") as fh:
                    fh.write(wav)
            except OSError as exc:
                return {"ok": False, "error": str(exc)}
            _log(f"cache hit {len(text)} chars @ speed {speed:g} ({cache.hits}h/{cache.misses}m)")
            return {"ok": True, "cached": True}
        t = time.time()
        pcm, sr, residual = engine.synth(text, speed)
        tts.write_out(pcm, sr, out, residual)
        try:
            with open(out, "rb") as fh:
                cache.put(key, fh.read())
        except OSError:
            pass  # caching is an optimization; the reply on disk is what matters
        _log(f"synth {len(text)} chars @ speed {speed:g} in {time.time() - t:.2f}s")
        return {"ok": True, "cached": False}

    vs.serve(sock_path, handle, log=_log)
    return 0


if __name__ == "__main__":
    sys.exit(main())
