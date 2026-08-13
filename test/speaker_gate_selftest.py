#!/usr/bin/env python3
"""Speaker-gate selftest — the voiceprint gate must accept the enrolled voice
and reject a different one. Uses two synthesized Kokoro voices (no real user
audio ever enters the repo): voice A enrolls, more voice-A utterances must
pass, voice-B utterances must fail.

Run:  .venv/python test/speaker_gate_selftest.py
Skips (exit 0) when the embedding model or kokoro assets are unavailable.
"""
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))

PASS = FAIL = 0


def check(name, cond):
    global PASS, FAIL
    print(("PASS  " if cond else "FAIL  ") + name)
    if cond:
        PASS += 1
    else:
        FAIL += 1


def synth(text, voice, out):
    env = dict(os.environ, VOICE_TTS_ENGINE="kokoro", KOKORO_VOICE=voice)
    r = subprocess.run([sys.executable, os.path.join(ROOT, "src", "tts.py"), text, out],
                       env=env, capture_output=True, timeout=120)
    return r.returncode == 0 and os.path.exists(out) and os.path.getsize(out) > 1000


def main():
    try:
        import speaker
    except Exception as exc:
        print(f"FAIL  import speaker ({exc})")
        sys.exit(1)

    if not os.path.exists(speaker.default_model_path()):
        print("SKIP: embedding model not downloaded")
        return

    d = tempfile.mkdtemp(prefix="vt-speaker-")
    enroll_dir = os.path.join(d, "enroll")
    os.makedirs(enroll_dir)
    ref = os.path.join(d, "voiceprint.json")

    texts = [
        "The quick brown fox jumps over the lazy dog.",
        "I would like to check the status of my sessions.",
        "Testing one two three, can you hear me clearly?",
        "Please give me a summary of the training run.",
    ]
    ok = True
    for i, t in enumerate(texts):
        ok = ok and synth(t, "am_michael", os.path.join(enroll_dir, f"e{i}.wav"))
    a1 = os.path.join(d, "same1.wav"); a2 = os.path.join(d, "same2.wav")
    b1 = os.path.join(d, "other1.wav"); b2 = os.path.join(d, "other2.wav")
    # Impostor probes use texts that appear NOWHERE else: same-text pairs
    # across two voices from one synth model share enough content/vocoder
    # signal to inflate similarity by ~0.3 — and real background speech does
    # not recite the enrolled speaker's sentences.
    ok = ok and synth("How is the weather looking for tomorrow?", "am_michael", a1)
    ok = ok and synth("Switch me over to the development session.", "am_michael", a2)
    ok = ok and synth("The restaurant closes at nine on weekdays.", "af_heart", b1)
    ok = ok and synth("Nobody watered the plants while we were away.", "af_heart", b2)
    if not ok:
        print("SKIP: kokoro synth unavailable")
        return

    # build: enrollment wavs -> centroid file
    n = speaker.build(enroll_dir, ref)
    check("build: returns sample count", n == 4)
    check("build: writes centroid json", os.path.exists(ref))
    meta = json.load(open(ref))
    check("build: centroid + count recorded", len(meta.get("centroid", [])) > 50 and meta.get("samples") == 4)

    # scores: the enrolled voice must rank strictly above the other voice.
    # NOTE: two voices from ONE synth model share vocoder signal and
    # under-separate vs. real speakers, so no absolute threshold is asserted
    # here — the live threshold is an operating point tuned from the gate's
    # logged scores after real enrollment.
    s_same = min(speaker.score(a1, ref), speaker.score(a2, ref))
    s_other = max(speaker.score(b1, ref), speaker.score(b2, ref))
    print(f"      separation: same>={s_same:.3f} other<={s_other:.3f}")
    check("score: same voice above default threshold", s_same >= speaker.DEFAULT_THRESHOLD)
    check("score: enrolled voice ranks above other voice", s_same > s_other)

    # stt integration at the measured midpoint: gate rejects to "" below the
    # threshold, passes above it, and disappears when unset.
    import stt
    midpoint = (s_same + s_other) / 2
    os.environ["VOICE_SPEAKER_REF"] = ref
    os.environ["VOICE_SPEAKER_THRESHOLD"] = f"{midpoint:.4f}"
    os.environ["WHISPER_MODEL"] = "tiny.en"
    model = stt.load_model()
    check("stt gate: enrolled voice passes through", stt.transcribe(model, a1).strip() != "")
    check("stt gate: other voice rejected to empty", stt.transcribe(model, b1) == "")
    os.environ.pop("VOICE_SPEAKER_REF")
    os.environ.pop("VOICE_SPEAKER_THRESHOLD")
    check("stt gate: unset ref disables gate", stt.transcribe(model, b1).strip() != "")

    print(f"PASS={PASS} FAIL={FAIL}")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
