#!/usr/bin/env python3
"""Engine-seam selftest — pure logic only (no model loads, no GPU).

Covers kokoro_native_speed's native/residual split, load_engine dispatch
(via class stubs — constructing real engines loads models), and
_ensure_espeak_data's respect for an explicit env override.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))
import tts  # noqa: E402

PASS = FAIL = 0


def ok(cond, name):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  ok:", name)
    else:
        FAIL += 1
        print("  FAIL:", name)


# --- kokoro_native_speed: native range 0.5-2.0, atempo residual beyond ---
ok(tts.kokoro_native_speed(1.0) == (1.0, 1.0), "speed 1.0 -> native, no residual")
ok(tts.kokoro_native_speed(1.7) == (1.7, 1.0), "speed 1.7 -> native, no residual")
n, r = tts.kokoro_native_speed(3.0)
ok(n == 2.0 and abs(r - 1.5) < 1e-9, "speed 3.0 -> native 2.0 + atempo 1.5")
n, r = tts.kokoro_native_speed(0.25)
ok(n == 0.5 and abs(r - 0.5) < 1e-9, "speed 0.25 -> native 0.5 + atempo 0.5")

# --- load_engine dispatch (stub the classes; real ctors load models) ---
tts.PiperEngine = lambda: "piper-stub"
tts.KokoroEngine = lambda: "kokoro-stub"
os.environ.pop("VOICE_TTS_ENGINE", None)
ok(tts.load_engine() == "piper-stub", "default engine is piper")
os.environ["VOICE_TTS_ENGINE"] = "kokoro"
ok(tts.load_engine() == "kokoro-stub", "VOICE_TTS_ENGINE=kokoro selects kokoro")
os.environ["VOICE_TTS_ENGINE"] = "KoKoRo "
ok(tts.load_engine() == "kokoro-stub", "engine name is case/space tolerant")
os.environ["VOICE_TTS_ENGINE"] = "bogus"
ok(tts.load_engine() == "piper-stub", "unknown engine falls back to piper")
os.environ.pop("VOICE_TTS_ENGINE", None)

# --- _ensure_espeak_data: an explicit override is never touched ---
os.environ["ESPEAK_DATA_PATH"] = "/nonexistent/but/explicit"
tts._ensure_espeak_data()
ok(os.environ["ESPEAK_DATA_PATH"] == "/nonexistent/but/explicit",
   "explicit ESPEAK_DATA_PATH wins")
os.environ.pop("ESPEAK_DATA_PATH", None)

print(f"PASS={PASS} FAIL={FAIL}")
sys.exit(1 if FAIL else 0)
