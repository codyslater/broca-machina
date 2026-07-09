#!/usr/bin/env python3
"""broca-machina streaming VAD: Silero-VAD speech endpointing helper.

The core latency win over the fixed ``endSilenceMs`` timeout in ``voice_loop.js``:
detect end-of-speech from an actual voice-activity model as soon as the speaker
stops, instead of always waiting a fixed trailing-silence window.

Reuses the Silero VAD ONNX model **vendored by faster-whisper** (the default STT
dependency), so this adds NO new package. ``onnxruntime`` + ``numpy`` only. A
standalone model can be pointed at with ``VOICE_VAD_ONNX=/path/to/silero.onnx``.

Three small, independently testable pieces:
  * ``resample_to_16k_mono`` — turn the loop's 48 kHz stereo s16le PCM into the
    16 kHz mono float32 Silero wants, streaming-safe (carries a <factor-sample
    remainder between calls).
  * ``SileroStream``          — stateful per-window (512 samples / 32 ms @ 16 kHz)
    speech-probability model; carries the h/c LSTM state + 64-sample context.
  * ``Endpointer``            — pure state machine mapping a probability stream to
    a single end-of-speech decision (threshold to enter speech, ``neg_threshold``
    hysteresis to leave, ``min_speech_ms`` to arm, ``min_silence_ms`` to fire).

``vad_server.py`` wires these over a Unix socket; the loop never imports this
directly. If anything here is unavailable the loop keeps its fixed-timeout path,
so VAD is always an optimization, never a hard dependency.
"""
import os

WINDOW = 512          # Silero v6 window @ 16 kHz (32 ms)
CONTEXT = 64          # samples of previous-window context the model expects
SR = 16000
WINDOW_MS = WINDOW / SR * 1000.0   # 32.0 ms


def _vad_onnx_path():
    """Resolve the Silero ONNX model: explicit override, else faster-whisper's."""
    override = os.environ.get("VOICE_VAD_ONNX", "").strip()
    if override:
        return override
    from faster_whisper.utils import get_assets_path

    return os.path.join(get_assets_path(), "silero_vad_v6.onnx")


def resample_to_16k_mono(pcm_bytes, remainder=None, in_rate=48000, channels=2):
    """Stream-safe downmix+decimate of interleaved s16le PCM to 16 kHz mono float32.

    ``in_rate`` must be an integer multiple of 16 kHz (48 kHz -> factor 3, the
    loop's ffmpeg-free receiver format). Averages stereo to mono, then averages
    ``factor``-sample groups (a cheap anti-alias box decimation — plenty for a
    speech/silence gate). Returns ``(mono16, remainder)`` where ``remainder`` is
    the <factor leftover mono samples to prepend to the next call.
    """
    import numpy as np

    a = np.frombuffer(pcm_bytes, dtype="<i2").astype("float32") / 32768.0
    if channels and channels > 1:
        a = a[: (len(a) // channels) * channels].reshape(-1, channels).mean(axis=1)
    if remainder is not None and len(remainder):
        a = np.concatenate([remainder, a])
    factor = max(1, in_rate // SR)
    n = (len(a) // factor) * factor
    rem = a[n:].copy()
    if n == 0:
        return np.zeros(0, dtype="float32"), rem
    mono16 = a[:n].reshape(-1, factor).mean(axis=1).astype("float32")
    return mono16, rem


class SileroStream:
    """Stateful, one-window-at-a-time Silero VAD (no torch; onnxruntime only)."""

    def __init__(self, model_path=None):
        import numpy as np
        import onnxruntime

        opts = onnxruntime.SessionOptions()
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        opts.enable_cpu_mem_arena = False
        opts.log_severity_level = 4
        self.session = onnxruntime.InferenceSession(
            model_path or _vad_onnx_path(),
            providers=["CPUExecutionProvider"],
            sess_options=opts,
        )
        self._np = np
        self.reset()

    def reset(self):
        np = self._np
        self._h = np.zeros((1, 1, 128), dtype="float32")
        self._c = np.zeros((1, 1, 128), dtype="float32")
        self._ctx = np.zeros((CONTEXT,), dtype="float32")

    def infer(self, window):
        """window: float32 array of exactly WINDOW samples -> speech prob (float)."""
        np = self._np
        w = np.asarray(window, dtype="float32")
        inp = np.concatenate([self._ctx, w]).reshape(1, WINDOW + CONTEXT).astype("float32")
        out, self._h, self._c = self.session.run(None, {"input": inp, "h": self._h, "c": self._c})
        self._ctx = w[-CONTEXT:].astype("float32")
        return float(np.asarray(out).reshape(-1)[-1])


class Endpointer:
    """Pure end-of-speech state machine over per-window speech probabilities.

    Fires ONCE (``update`` returns True and stays True) when at least
    ``min_speech_ms`` of speech has been seen and then probability stays below
    ``neg_threshold`` continuously for ``min_silence_ms``. A short pre-speech
    blip decays instead of latching, so it can't wedge endpointing off.
    """

    def __init__(self, threshold=0.5, neg_threshold=None, min_silence_ms=300,
                 min_speech_ms=150, window_ms=WINDOW_MS):
        self.threshold = float(threshold)
        self.neg_threshold = (
            float(neg_threshold) if neg_threshold is not None
            else max(self.threshold - 0.15, 0.01)
        )
        self.min_silence_ms = float(min_silence_ms)
        self.min_speech_ms = float(min_speech_ms)
        self.window_ms = float(window_ms)
        self.triggered = False
        self.speech_ms = 0.0
        self._silence_ms = 0.0
        self.done = False

    def update(self, prob):
        if self.done:
            return True
        w = self.window_ms
        if prob >= self.threshold:
            self.speech_ms += w
            self._silence_ms = 0.0
            if self.speech_ms >= self.min_speech_ms:
                self.triggered = True
        elif prob < self.neg_threshold:
            self._silence_ms += w
            if self.triggered:
                if self._silence_ms >= self.min_silence_ms:
                    self.done = True
            elif self._silence_ms >= self.min_silence_ms:
                # never reached real speech — decay a spurious blip and re-arm
                self.speech_ms = 0.0
                self._silence_ms = 0.0
        else:
            # hysteresis band: treat as continuation of the current state
            self._silence_ms = 0.0
        return self.done
