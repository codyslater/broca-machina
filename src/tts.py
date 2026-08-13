#!/usr/bin/env python3
"""broca-machina TTS: synthesize <text> to <out.wav>.

Engine selection (VOICE_TTS_ENGINE): "piper" (default, CPU) or "kokoro"
(Kokoro-82M via kokoro-onnx — synthesizes on an ONNX CUDA provider when one
is usable, CPU otherwise). Env:
  VOICE_TTS_ENGINE (piper | kokoro; default piper)
  PIPER_VOICE      (default en_US-amy-medium)
  PIPER_VOICE_DIR  (default ~/.cache/broca-machina/piper)
  KOKORO_MODEL     (default ~/.cache/broca-machina/kokoro/kokoro-v1.0.onnx)
  KOKORO_VOICES    (default voices-v1.0.bin next to KOKORO_MODEL)
  KOKORO_VOICE     (default af_heart)
  KOKORO_PROVIDERS (default CUDAExecutionProvider,CPUExecutionProvider —
                    onnxruntime falls back to CPU when CUDA isn't usable)
  VOICE_TTS_SPEED  (default 1.0; >1 faster. Piper applies it pitch-preserving
                    via ffmpeg atempo; kokoro applies it natively during
                    synthesis — better prosody — with atempo only for the
                    residual beyond its native 0.5-2.0 range)

For a cloned voice (e.g. Chatterbox), point the config's tts.cmd at your own
clone CLI instead — the loop only needs `<cmd> <text> <out.wav>`.

For warm reuse, `tts_server.py` loads the engine once and `tts_client.py`
sends over a socket — the functions below are shared by both paths so the
synthesis logic stays in one place.
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
    """Load the configured engine and synthesize in one shot (no warm reuse).

    Speed is NOT applied here — callers put it through write_out(), keeping
    this path engine-agnostic for the client's cold fallback.
    """
    pcm, sr, _ = load_engine().synth(text, 1.0)
    return pcm, sr


# --- engine seam -------------------------------------------------------------
# Both engines present the same surface: .name, and
#   .synth(text, speed) -> (pcm_int16_bytes, sample_rate, residual_speed)
# residual_speed is what write_out() still needs to apply via atempo: piper
# synthesizes at natural rate (residual = requested speed); kokoro applies
# speed natively during synthesis, so its residual is 1.0 within native range.

class PiperEngine:
    name = "piper"

    def __init__(self):
        self._voice = load_voice()

    def synth(self, text, speed=1.0):
        pcm, sr = synth(self._voice, text)
        return pcm, sr, speed


def kokoro_native_speed(speed):
    """Split a requested speed into (native, residual). Pure; selftested.

    Kokoro's supported native range is 0.5-2.0; anything beyond is applied
    as a pitch-preserving atempo residual by write_out().
    """
    s = min(max(speed, 0.5), 2.0)
    return s, (speed / s if abs(speed - s) > 1e-9 else 1.0)


def _ensure_espeak_data():
    """Point espeak-ng at usable phoneme data when the wheel's own is broken.

    Some espeakng-loader wheels ship a build-machine data path; the env var
    (respected by the loader) redirects to the system install. Only fires
    when the bundled path is actually missing, so a healthy wheel keeps its
    own (version-matched) data.
    """
    if os.environ.get("ESPEAK_DATA_PATH"):
        return
    try:
        import espeakng_loader
        if os.path.isdir(espeakng_loader.get_data_path()):
            return
    except Exception:
        pass
    for p in (
        "/usr/lib/x86_64-linux-gnu/espeak-ng-data",
        "/usr/share/espeak-ng-data",
        "/usr/local/share/espeak-ng-data",
        "/opt/homebrew/share/espeak-ng-data",
    ):
        if os.path.isdir(p):
            os.environ["ESPEAK_DATA_PATH"] = p
            return


def _preload_nvidia_libs():
    """Best-effort dlopen of pip-installed NVIDIA CUDA libs (RTLD_GLOBAL) so
    onnxruntime's CUDA provider finds them without LD_LIBRARY_PATH at launch.
    Failures are silent — onnxruntime just falls back to CPU."""
    import ctypes
    import glob
    import sysconfig
    roots = {sysconfig.get_paths().get("purelib"), sysconfig.get_paths().get("platlib")}
    for root in filter(None, roots):
        for name in ("cuda_runtime", "cublas", "cudnn", "curand", "cufft", "cuda_nvrtc"):
            for so in sorted(glob.glob(os.path.join(root, "nvidia", name, "lib", "*.so*"))):
                try:
                    ctypes.CDLL(so, mode=ctypes.RTLD_GLOBAL)
                except OSError:
                    pass


class KokoroEngine:
    name = "kokoro"

    def __init__(self):
        _ensure_espeak_data()
        model = os.environ.get("KOKORO_MODEL") or os.path.expanduser(
            "~/.cache/broca-machina/kokoro/kokoro-v1.0.onnx")
        voices = os.environ.get("KOKORO_VOICES") or os.path.join(
            os.path.dirname(model), "voices-v1.0.bin")
        self.voice = os.environ.get("KOKORO_VOICE", "af_heart")
        providers = [p.strip() for p in os.environ.get(
            "KOKORO_PROVIDERS", "CUDAExecutionProvider,CPUExecutionProvider").split(",") if p.strip()]
        if any("CUDA" in p for p in providers):
            _preload_nvidia_libs()
        import onnxruntime as ort
        from kokoro_onnx import Kokoro
        # HEURISTIC algo search: exhaustive search costs ~45s of one-time CUDA
        # warmup on first synth for no measurable steady-state win here.
        opts = [("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC"})
                if p == "CUDAExecutionProvider" else p for p in providers]
        sess = ort.InferenceSession(model, ort.SessionOptions(), providers=opts)
        self._k = Kokoro.from_session(sess, voices)
        self.providers = sess.get_providers()

    def synth(self, text, speed=1.0):
        import numpy as np
        native, residual = kokoro_native_speed(speed)
        audio, sr = self._k.create(text, voice=self.voice, speed=native)
        pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes()
        return pcm, sr, residual


def load_engine():
    """Instantiate the engine VOICE_TTS_ENGINE selects (default piper)."""
    eng = (os.environ.get("VOICE_TTS_ENGINE") or "piper").strip().lower()
    if eng == "kokoro":
        return KokoroEngine()
    if eng != "piper":
        sys.stderr.write(f"[tts] unknown VOICE_TTS_ENGINE '{eng}' — using piper\n")
    return PiperEngine()


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
    speed = parse_speed(os.environ.get("VOICE_TTS_SPEED", "1.0"))
    pcm, sr, residual = load_engine().synth(text, speed)
    write_out(pcm, sr, out, residual)
    return 0


if __name__ == "__main__":
    sys.exit(main())
