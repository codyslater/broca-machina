"""Tiny length-prefixed JSON framing over a Unix-domain socket.

Shared by the STT/TTS warm servers and their clients. Wire format is a
4-byte big-endian unsigned length followed by that many bytes of UTF-8 JSON.
One request, one response, then the connection closes.
"""
import json
import os
import socket
import struct

DEFAULT_STT_SOCK = "stt.sock"
DEFAULT_TTS_SOCK = "tts.sock"
MAX_FRAME = 64 * 1024 * 1024  # refuse absurd length prefixes (local memory-exhaustion guard)


def repo_root():
    """The broca-machina repo root (parent of this src/ dir)."""
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def default_sock_path(name):
    """`.voice-tmp/<name>` under the repo root."""
    return os.path.join(repo_root(), ".voice-tmp", name)


def _recv_all(conn, n):
    buf = b""
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("socket closed mid-message")
        buf += chunk
    return buf


def send_msg(conn, obj):
    data = json.dumps(obj).encode("utf-8")
    conn.sendall(struct.pack(">I", len(data)) + data)


def recv_msg(conn):
    (n,) = struct.unpack(">I", _recv_all(conn, 4))
    if n > MAX_FRAME:
        raise ValueError(f"frame too large: {n} bytes")
    return json.loads(_recv_all(conn, n).decode("utf-8"))


def request(sock_path, obj, timeout=120.0):
    """Connect, send one request, return the decoded response. Raises on any
    connection/socket problem so callers can fall back to a cold in-process load.
    """
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    conn.settimeout(timeout)
    try:
        conn.connect(sock_path)
        send_msg(conn, obj)
        return recv_msg(conn)
    finally:
        conn.close()


def serve(sock_path, handler, log=None):
    """Bind `sock_path` and serve one request at a time forever. `handler`
    takes the decoded request dict and returns a response dict.
    """
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
        os.chmod(sock_path, 0o600)  # owner-only: don't let same-group locals drive the server
    except OSError:
        pass
    srv.listen(8)
    if log:
        log(f"listening on {sock_path}")
    try:
        while True:
            conn, _ = srv.accept()
            try:
                req = recv_msg(conn)
                try:
                    resp = handler(req)
                except Exception as exc:  # never let one bad request kill the server
                    resp = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
                    if log:
                        log(f"handler error: {resp['error']}")
                send_msg(conn, resp)
            except Exception as exc:
                if log:
                    log(f"connection error: {type(exc).__name__}: {exc}")
            finally:
                conn.close()
    finally:
        try:
            os.unlink(sock_path)
        except OSError:
            pass
