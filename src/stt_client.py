#!/usr/bin/env python3
"""broca-machina STT client — drop-in for stt.py.

Same CLI:  stt_client.py <wav>   ->   transcript on stdout.
Also:      stt_client.py --speaker-score <wav>   ->   voiceprint score on
           stdout (warm server ONLY: a cold speaker-model load is far too
           slow for the duck decision this feeds; no server -> exit 1,
           empty stdout, and the loop dims playback as it always did).

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


def _speaker_score(wav):
    sock = os.environ.get("VOICE_STT_SOCK") or vs.default_sock_path(vs.DEFAULT_STT_SOCK)
    resp = vs.request(sock, {"wav": os.path.abspath(wav), "op": "speaker"}, timeout=5.0)
    if not resp.get("ok"):
        raise RuntimeError(resp.get("error", "server error"))
    return float(resp["score"])


def main() -> int:
    if len(sys.argv) >= 3 and sys.argv[1] == "--speaker-score":
        try:
            sys.stdout.write(f"{_speaker_score(sys.argv[2]):.4g}\n")
        except Exception as exc:  # noqa: BLE001 — unknown score, caller falls back
            sys.stderr.write(f"[stt_client] speaker score unavailable ({type(exc).__name__}: {exc})\n")
            return 1
        return 0
    if len(sys.argv) < 2:
        sys.stderr.write("usage: stt_client.py <wav> | --speaker-score <wav>\n")
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
