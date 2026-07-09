#!/usr/bin/env python3
"""broca-machina STT client — drop-in for stt.py.

Same CLI:  stt_client.py <wav>   ->   transcript on stdout.

Sends the wav path to the warm `stt_server.py` over its Unix socket. If the
socket is missing or the server is down/erroring, falls back to a cold
in-process model load (identical to stt.py) so it never hard-fails.

Socket path: $VOICE_STT_SOCK > <repo>/.voice-tmp/stt.sock
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _voicesock as vs  # noqa: E402


def _warm(wav):
    sock = os.environ.get("VOICE_STT_SOCK") or vs.default_sock_path(vs.DEFAULT_STT_SOCK)
    resp = vs.request(sock, {"wav": os.path.abspath(wav)})
    if not resp.get("ok"):
        raise RuntimeError(resp.get("error", "server error"))
    return resp.get("text", "")


def _cold(wav):
    import stt

    return stt.transcribe(stt.load_model(), wav)


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: stt_client.py <wav>\n")
        return 2
    wav = sys.argv[1]
    try:
        text = _warm(wav)
    except Exception as exc:
        sys.stderr.write(f"[stt_client] warm path failed ({type(exc).__name__}: {exc}); cold fallback\n")
        text = _cold(wav)
    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
