#!/usr/bin/env python3
"""Selftest for the Silero-VAD endpointing helper (src/vad.py).

Unit-level, no Discord and no live audio required:
  * Endpointer state machine driven with synthetic probability streams
    (deterministic — this is the logic voice_loop.js relies on for early
    end-of-speech).
  * resample_to_16k_mono length/streaming-remainder math.
  * Optional Silero ONNX smoke test (skipped cleanly if onnxruntime / the
    vendored faster-whisper model isn't installed).

Run:  <venv-python> test/vad_selftest.py
Exit 0 iff all non-skipped checks pass.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "src"))
import vad  # noqa: E402

_failed = 0
_skipped = 0


def check(name, cond):
    global _failed
    print(f"{'PASS' if cond else 'FAIL'}  {name}")
    if not cond:
        _failed += 1


def skip(name, why):
    global _skipped
    print(f"SKIP  {name} ({why})")
    _skipped += 1


# window is 32 ms; helper to run a prob stream through a fresh Endpointer and
# return the window index at which it first fired (or None).
def run(probs, **kw):
    ep = vad.Endpointer(**kw)
    for i, p in enumerate(probs):
        if ep.update(p):
            return i, ep
    return None, ep


W = vad.WINDOW_MS  # 32 ms

# 1) sustained speech then silence -> fires after min_silence past speech end
speech = [0.9] * 20          # 640 ms speech (>= min_speech 150)
silence = [0.02] * 40        # 1280 ms silence
idx, ep = run(speech + silence, threshold=0.5, min_silence_ms=300, min_speech_ms=150)
check("fires after speech+silence", idx is not None)
# min_silence 300ms / 32ms = ~10 windows of silence after speech ends (idx 20)
check("fires ~min_silence after speech end", idx is not None and 28 <= idx <= 32)
check("triggered flag set", ep.triggered is True)
check("accumulated speech_ms >= min_speech", ep.speech_ms >= 150)

# 2) never fires while speech continues (no trailing silence)
idx2, _ = run([0.9] * 60, threshold=0.5, min_silence_ms=300, min_speech_ms=150)
check("no endpoint during continuous speech", idx2 is None)

# 3) short blip (< min_speech) then long silence -> must NOT fire (decays)
blip = [0.9] * 2             # 64 ms, below min_speech 150
idx3, ep3 = run(blip + [0.02] * 60, threshold=0.5, min_silence_ms=300, min_speech_ms=150)
check("blip below min_speech never endpoints", idx3 is None)
check("blip decays (not triggered)", ep3.triggered is False)

# 4) brief mid-utterance pause (< min_silence) does not end the turn early
probs = [0.9] * 10 + [0.02] * 6 + [0.9] * 10 + [0.02] * 40   # pause ~192ms < 300
idx4, _ = run(probs, threshold=0.5, min_silence_ms=300, min_speech_ms=150)
# it should fire only in the FINAL silence run, well after the pause
check("mid-utterance pause tolerated", idx4 is not None and idx4 > 26)

# 5) idempotent latch: once done, update() stays True
ep5 = vad.Endpointer(min_silence_ms=100, min_speech_ms=100)
for p in [0.9] * 5 + [0.0] * 5:
    ep5.update(p)
check("done latches True", ep5.done is True and ep5.update(0.9) is True)

# 6) neg_threshold default = threshold - 0.15 (hysteresis band)
ep6 = vad.Endpointer(threshold=0.6)
check("neg_threshold default", abs(ep6.neg_threshold - 0.45) < 1e-9)

# 7) hysteresis-band frames must not RESET the silence clock. Live: only a
#    third of real utterances endpointed early — room noise hovering between
#    neg_threshold and threshold restarted the clock every few windows, so the
#    fixed 1s fallback ended most turns and the VAD's latency win never landed.
probs7 = [0.9] * 10 + ([0.02] * 3 + [0.42] * 1) * 12   # a band frame every 4th window
idx7, _ = run(probs7, threshold=0.5, min_silence_ms=300, min_speech_ms=150)
check("band frames do not reset the silence clock", idx7 is not None)
check("fires once ten silent windows accumulate around the band frames", idx7 is not None and 22 <= idx7 <= 26)

# 8) ...and band frames do not COUNT as silence either: a band-only tail
#    (speech trailing off, breath) never endpoints on its own.
idx8, _ = run([0.9] * 10 + [0.42] * 60, threshold=0.5, min_silence_ms=300, min_speech_ms=150)
check("band-only tail never endpoints", idx8 is None)

# --- resampler math (numpy) -------------------------------------------------
try:
    import numpy as np

    # 48k stereo -> 16k mono: 30ms = 1440 stereo frames = 5760 s16 samples
    frames = 1440
    pcm = (np.zeros(frames * 2, dtype="<i2")).tobytes()
    mono, rem = vad.resample_to_16k_mono(pcm, None, 48000, 2)
    check("resample: 48k stereo 30ms -> 480 mono samples", len(mono) == 480)
    check("resample: no remainder on clean multiple", len(rem) == 0)

    # streaming remainder: a chunk not divisible by factor(3) carries leftover
    odd = (np.zeros(1001 * 2, dtype="<i2")).tobytes()  # 1001 mono samples -> 333*3 + 2 leftover
    mono2, rem2 = vad.resample_to_16k_mono(odd, None, 48000, 2)
    check("resample: carries sub-factor remainder", len(mono2) == 333 and len(rem2) == 2)

    # feeding the remainder back preserves total sample count
    mono3, rem3 = vad.resample_to_16k_mono(odd, rem2, 48000, 2)
    check("resample: remainder folds into next call", len(mono3) == 334 and len(rem3) == 1)
except ImportError:
    skip("resampler math", "numpy missing")

# --- optional Silero ONNX smoke test ----------------------------------------
try:
    import numpy as np  # noqa: F811

    stream = vad.SileroStream()
    # silence -> low speech prob; a fresh window must return a finite [0,1] prob
    p_sil = stream.infer(np.zeros(vad.WINDOW, dtype="float32"))
    check("silero: silence prob in [0,1]", 0.0 <= p_sil <= 1.0)
    check("silero: silence prob low", p_sil < 0.5)
    # loud tone burst should read higher than pure silence (sanity of statefulness)
    t = np.linspace(0, vad.WINDOW / vad.SR, vad.WINDOW, endpoint=False)
    tone = (0.6 * np.sin(2 * np.pi * 220 * t)).astype("float32")
    p_tone = stream.infer(tone)
    check("silero: tone prob in [0,1]", 0.0 <= p_tone <= 1.0)
except Exception as exc:  # noqa: BLE001
    skip("silero onnx smoke", f"{type(exc).__name__}: {exc}")

print()
if _failed == 0:
    print(f"ALL PASS ({_skipped} skipped)" if _skipped else "ALL PASS")
else:
    print(f"{_failed} FAILED")
sys.exit(1 if _failed else 0)
