#!/usr/bin/env python3
"""broca-machina STT warm server.

Loads the faster-whisper model ONCE and serves transcription requests over a
Unix-domain socket, so the per-utterance latency drops the ~1-2 s model-load
cost that `stt.py` pays every call.

Usage:
  stt_server.py [sock_path]
Socket path resolution: argv[1] > $VOICE_STT_SOCK > <repo>/.voice-tmp/stt.sock

Request  (JSON): {"wav": "/abs/path.wav"}
Response (JSON): {"ok": true, "text": "..."}  |  {"ok": false, "error": "..."}

Model/compute honor the same WHISPER_* env vars as stt.py.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _voicesock as vs  # noqa: E402
import stt  # noqa: E402


def _log(msg):
    sys.stderr.write(f"{time.strftime('%H:%M:%S')} [stt_server] {msg}\n")
    sys.stderr.flush()


def main() -> int:
    sock_path = (
        sys.argv[1] if len(sys.argv) > 1
        else os.environ.get("VOICE_STT_SOCK") or vs.default_sock_path(vs.DEFAULT_STT_SOCK)
    )
    _log(f"loading model {os.environ.get('WHISPER_MODEL', 'small.en')} ...")
    t0 = time.time()
    model = stt.load_model()
    # Warm the CTranslate2 graph on 0.5 s of silence so the FIRST real request
    # doesn't eat the one-time kernel/JIT init.
    try:
        import numpy as np

        segments, _ = model.transcribe(np.zeros(8000, dtype="float32"), language="en")
        list(segments)
    except Exception as exc:
        _log(f"warmup skipped: {exc}")
    _log(f"model loaded + warmed in {time.time() - t0:.2f}s")

    def handle(req):
        wav = req.get("wav")
        if not wav:
            return {"ok": False, "error": "missing 'wav'"}
        t = time.time()
        text = stt.transcribe(model, wav)
        _log(f"transcribed {os.path.basename(wav)} in {time.time() - t:.2f}s")
        return {"ok": True, "text": text}

    vs.serve(sock_path, handle, log=_log)
    return 0


if __name__ == "__main__":
    sys.exit(main())
