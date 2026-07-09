#!/usr/bin/env python3
"""broca-machina VAD warm server — streaming Silero endpointing over a socket.

Loads the Silero VAD model ONCE (vendored by faster-whisper; see ``vad.py``) and
serves live end-of-speech detection so ``voice_loop.js`` can end an utterance the
moment the speaker stops, instead of always waiting the fixed ``endSilenceMs``.

One TCP-of-Unix connection == one utterance. Wire format is length-prefixed
frames (4-byte big-endian length + payload), same framing family as the STT/TTS
servers:

  client -> server:
    frame 0    JSON header  {sample_rate, channels, threshold, neg_threshold,
                             min_silence_ms, min_speech_ms}  (all optional)
    frame 1..  raw interleaved s16le PCM at header's rate/channels
    a zero-length frame OR EOF ends the utterance
  server -> client:
    one JSON frame {"event":"endpoint","speech_ms":N} the instant end-of-speech
    is detected; then the server just drains input until the client closes.

Usage:  vad_server.py [sock_path]
Socket path resolution: argv[1] > $VOICE_VAD_SOCK > <repo>/.voice-tmp/vad.sock

Falls back safely: if this server is down or never fires, the loop keeps its
fixed-timeout endpointing, so VAD is an optimization and never required.
"""
import json
import os
import socket
import struct
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _voicesock as vs  # noqa: E402  (socket-path helpers only)
import vad  # noqa: E402

DEFAULT_VAD_SOCK = "vad.sock"


def _log(msg):
    sys.stderr.write(f"{time.strftime('%H:%M:%S')} [vad_server] {msg}\n")
    sys.stderr.flush()


def _recv_exact(conn, n):
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            return None  # clean EOF
        buf += chunk
    return buf


def _read_frame(conn):
    """Return the next frame's raw payload bytes, b'' for a zero-length frame,
    or None on EOF at a frame boundary."""
    hdr = _recv_exact(conn, 4)
    if hdr is None:
        return None
    (n,) = struct.unpack(">I", hdr)
    if n == 0:
        return b""
    if n > vs.MAX_FRAME:
        raise ValueError(f"frame too large: {n} bytes")
    return _recv_exact(conn, n)


def _send_json(conn, obj):
    data = json.dumps(obj).encode("utf-8")
    conn.sendall(struct.pack(">I", len(data)) + data)


def _handle(conn, stream):
    import numpy as np

    raw = _read_frame(conn)
    if not raw:
        return
    try:
        hdr = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        hdr = {}
    in_rate = int(hdr.get("sample_rate", 48000))
    channels = int(hdr.get("channels", 2))
    ep = vad.Endpointer(
        threshold=hdr.get("threshold", 0.5),
        neg_threshold=hdr.get("neg_threshold", None),
        min_silence_ms=hdr.get("min_silence_ms", 300),
        min_speech_ms=hdr.get("min_speech_ms", 150),
    )
    stream.reset()
    remainder = None
    buf = np.zeros(0, dtype="float32")
    fired = False
    windows = 0
    t0 = time.time()
    while True:
        payload = _read_frame(conn)
        if not payload:  # EOF or explicit zero-length end
            break
        if fired:
            continue  # keep draining input; decision already sent
        mono16, remainder = vad.resample_to_16k_mono(payload, remainder, in_rate, channels)
        if len(mono16):
            buf = np.concatenate([buf, mono16])
        while len(buf) >= vad.WINDOW and not fired:
            win = buf[: vad.WINDOW]
            buf = buf[vad.WINDOW :]
            windows += 1
            if ep.update(stream.infer(win)):
                _send_json(conn, {"event": "endpoint", "speech_ms": round(ep.speech_ms)})
                fired = True
                _log(f"endpoint after {windows} windows / {ep.speech_ms:.0f}ms speech, {(time.time()-t0)*1000:.0f}ms elapsed")
    if not fired:
        _log(f"utterance drained without endpoint ({windows} windows)")


def main() -> int:
    sock_path = (
        sys.argv[1] if len(sys.argv) > 1
        else os.environ.get("VOICE_VAD_SOCK") or vs.default_sock_path(DEFAULT_VAD_SOCK)
    )
    _log("loading Silero VAD model ...")
    t0 = time.time()
    try:
        stream = vad.SileroStream()
        # Prime the graph on one window of silence so the first real window is fast.
        import numpy as np

        stream.infer(np.zeros(vad.WINDOW, dtype="float32"))
        stream.reset()
    except Exception as exc:  # noqa: BLE001
        _log(f"FATAL: could not load VAD model ({type(exc).__name__}: {exc})")
        return 1
    _log(f"model loaded + warmed in {time.time() - t0:.2f}s")

    sock_dir = os.path.dirname(os.path.abspath(sock_path))
    os.makedirs(sock_dir, exist_ok=True)
    try:
        os.chmod(sock_dir, 0o700)
    except OSError:
        pass
    if os.path.exists(sock_path):
        os.unlink(sock_path)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(sock_path)
    try:
        os.chmod(sock_path, 0o600)
    except OSError:
        pass
    srv.listen(8)
    _log(f"listening on {sock_path}")
    try:
        while True:
            conn, _ = srv.accept()
            try:
                _handle(conn, stream)
            except Exception as exc:  # noqa: BLE001  — never let one utterance kill the server
                _log(f"connection error: {type(exc).__name__}: {exc}")
            finally:
                conn.close()
    finally:
        try:
            os.unlink(sock_path)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
