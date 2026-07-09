#!/usr/bin/env python3
"""broca-machina STT: transcribe a WAV to text on stdout.

faster-whisper, CPU-friendly. Model/compute overridable via env:
  WHISPER_MODEL   (default small.en)   WHISPER_COMPUTE (default int8)
  WHISPER_DEVICE  (default cpu)

Two optional, env-driven recognition-biasing levers (both empty by default, so
the core stays generic — set them per-deployment via the adapter config stt.env):
  WHISPER_INITIAL_PROMPT  seed text biasing the decoder toward your domain
                          vocabulary / rare names (e.g. a project or assistant
                          name the model would otherwise guess at)
  VOICE_STT_FIXUPS        JSON {mis-hearing: correction} — whole-word,
                          case-insensitive substitutions applied AFTER
                          transcription, the safety net for names that still
                          slip through the prompt bias

Loads the model per call (simple). For warm reuse, `stt_server.py` loads the
model once and `stt_client.py` sends over a socket — the functions below are
shared by both paths so the transcription logic stays in one place.
"""
import json
import os
import re
import sys


def load_model():
    """Load the faster-whisper model per the WHISPER_* env vars."""
    from faster_whisper import WhisperModel

    return WhisperModel(
        os.environ.get("WHISPER_MODEL", "small.en"),
        device=os.environ.get("WHISPER_DEVICE", "cpu"),
        compute_type=os.environ.get("WHISPER_COMPUTE", "int8"),
    )


def transcribe(model, wav_path):
    """Transcribe a WAV to a stripped transcript string using a loaded model.

    Applies WHISPER_INITIAL_PROMPT (decoder bias) and VOICE_STT_FIXUPS
    (post-hoc word corrections) when set — see module docstring.
    """
    kwargs = {"language": "en", "vad_filter": True}
    prompt = os.environ.get("WHISPER_INITIAL_PROMPT", "").strip()
    if prompt:
        kwargs["initial_prompt"] = prompt
    segments, _ = model.transcribe(wav_path, **kwargs)
    text = " ".join(s.text for s in segments).strip()
    return _apply_fixups(text)


def _apply_fixups(text):
    """Whole-word, case-insensitive corrections from VOICE_STT_FIXUPS (JSON dict).

    For names the recognizer reliably mis-hears (e.g. 'jason' -> 'JSON'). Returns
    text unchanged if the env var is unset or not valid JSON.
    """
    raw = os.environ.get("VOICE_STT_FIXUPS", "").strip()
    if not raw:
        return text
    try:
        fixups = json.loads(raw)
    except (ValueError, TypeError):
        return text
    for wrong, right in fixups.items():
        text = re.sub(rf"\b{re.escape(str(wrong))}\b", str(right), text, flags=re.IGNORECASE)
    return text


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: stt.py <wav>\n")
        return 2
    model = load_model()
    sys.stdout.write(transcribe(model, sys.argv[1]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
