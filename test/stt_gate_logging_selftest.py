#!/usr/bin/env python3
"""Selftest: speaker-gate score logging in stt.transcribe.

Every gated utterance must log its score — rejections AND accepts — so a
deployment can tune VOICE_SPEAKER_THRESHOLD from real data. Pure-python:
the speaker module and whisper model are stubbed, no model downloads.

Run: python3 test/stt_gate_logging_selftest.py
"""
import io
import os
import sys
import types

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

PASS = 0
FAIL = 0


def check(name, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"PASS  {name}")
    else:
        FAIL += 1
        print(f"FAIL  {name}")


def seg(text, no_speech=0.1, logprob=-0.3):
    return types.SimpleNamespace(text=text, no_speech_prob=no_speech, avg_logprob=logprob)


class FakeModel:
    def __init__(self, segments=None):
        self.kwargs = None
        self.segments = segments if segments is not None else [seg("hello there")]

    def transcribe(self, wav_path, **kwargs):
        self.kwargs = kwargs
        return self.segments, None


def run_transcribe(score, threshold, ref_set=True, segments=None):
    """Call stt.transcribe with a stubbed speaker module; return (text, stderr, model)."""
    fake = types.ModuleType("speaker")
    fake.score = lambda wav, ref: score
    fake.threshold = lambda: threshold
    sys.modules["speaker"] = fake
    if ref_set:
        os.environ["VOICE_SPEAKER_REF"] = __file__  # any existing file
    else:
        os.environ.pop("VOICE_SPEAKER_REF", None)
    import stt
    model = FakeModel(segments)
    err, old = io.StringIO(), sys.stderr
    sys.stderr = err
    try:
        text = stt.transcribe(model, "/nonexistent.wav")
    finally:
        sys.stderr = old
    return text, err.getvalue(), model


# --- accept path logs its score ---
text, err, model = run_transcribe(score=0.77, threshold=0.5)
check("accepted utterance transcribes", text == "hello there")
check("accepted utterance logs score", "[speaker] ok (score 0.77)" in err)

# --- reject path unchanged ---
text, err, model = run_transcribe(score=0.31, threshold=0.5)
check("rejected utterance returns empty", text == "")
check("rejected utterance logs score", "[speaker] rejected (score 0.31)" in err)
check("reject logs no ok line", "[speaker] ok" not in err)

# --- gate off -> no speaker lines at all ---
text, err, model = run_transcribe(score=0.77, threshold=0.5, ref_set=False)
check("no ref: transcribes", text == "hello there")
check("no ref: no speaker log lines", "[speaker]" not in err)

# --- WHISPER_VAD_FILTER env controls whisper's internal VAD ---
# Observed live 2026-08-16: quiet speech PASSED the speaker gate (volume-
# normalized embeddings) then vad_filter stripped it to "" (energy-based).
# With a speaker gate enforcing who reaches Whisper, the internal VAD is
# redundant and must be switchable off; default stays on for gateless setups.
os.environ.pop("WHISPER_VAD_FILTER", None)
text, err, model = run_transcribe(score=0.77, threshold=0.5)
check("vad_filter defaults on", model.kwargs.get("vad_filter") is True)
os.environ["WHISPER_VAD_FILTER"] = "0"
text, err, model = run_transcribe(score=0.77, threshold=0.5)
check("WHISPER_VAD_FILTER=0 disables it", model.kwargs.get("vad_filter") is False)
os.environ["WHISPER_VAD_FILTER"] = "1"
text, err, model = run_transcribe(score=0.77, threshold=0.5)
check("WHISPER_VAD_FILTER=1 keeps it on", model.kwargs.get("vad_filter") is True)
os.environ.pop("WHISPER_VAD_FILTER", None)

# --- repetition-hallucination drop ---
# Observed live 2026-08-16 18:55Z: with vad_filter off, a 13.7s noise blob
# decoded to "Thank you.  I.  Thank you.  Thank you." — passed the speaker
# gate, dodged the exact-match noise-drop list, CONFIRMED a barge (killing
# playback) and reached the brain. The same sentence >= 3 times in one
# utterance is Whisper's noise-loop signature, never real speech.
text, err, model = run_transcribe(score=0.77, threshold=0.5, segments=[
    seg("Thank you."), seg("I."), seg("Thank you."), seg("Thank you.")])
check("repetition x3 drops to empty", text == "")
check("repetition drop logs", "[whisper] hallucination" in err)
text, err, model = run_transcribe(score=0.77, threshold=0.5, segments=[
    seg("Okay."), seg("Okay."), seg("Let's run it today.")])
check("repetition x2 passes (real speech can double up)", text == "Okay. Okay. Let's run it today.")

# --- WHISPER_NO_SPEECH_MAX segment filter (default off) ---
os.environ.pop("WHISPER_NO_SPEECH_MAX", None)
text, err, model = run_transcribe(score=0.77, threshold=0.5, segments=[
    seg("I don't know.", no_speech=0.9)])
check("no_speech cap defaults off", text == "I don't know.")
os.environ["WHISPER_NO_SPEECH_MAX"] = "0.5"
text, err, model = run_transcribe(score=0.77, threshold=0.5, segments=[
    seg("I don't know.", no_speech=0.9), seg("real words here", no_speech=0.2)])
check("cap drops high-no_speech segment, keeps the rest", text == "real words here")
check("cap logs the drop", "no_speech" in err and "dropped" in err)
os.environ.pop("WHISPER_NO_SPEECH_MAX", None)

# --- per-utterance confidence stats logged (threshold tuning needs data) ---
text, err, model = run_transcribe(score=0.77, threshold=0.5, segments=[
    seg("hello", no_speech=0.42, logprob=-0.61), seg("there", no_speech=0.15, logprob=-0.20)])
check("confidence stats logged", "no_speech_max=0.42" in err and "logprob_min=-0.61" in err)

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
