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
  WHISPER_HOTWORDS        comma-separated words faster-whisper biases toward
                          at decode time (its `hotwords` option) — stronger
                          than the prompt for a short name the model keeps
                          guessing at (a wake word, a project); needs
                          faster-whisper >= 1.0
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
    # Speaker gate (VOICE_SPEAKER_REF -> centroid json, see speaker.py): an
    # utterance whose voice doesn't match the enrolled centroid transcribes to
    # "" — upstream already treats an empty transcript as a phantom (wait
    # state restored, nothing forwarded), so rejection needs no caller logic.
    # Fail-OPEN on gate errors: a broken model file must degrade to "no gate",
    # never to a mute voice channel.
    ref = os.environ.get("VOICE_SPEAKER_REF", "").strip()
    if ref and os.path.exists(ref):
        try:
            import speaker
            s = speaker.score(wav_path, ref)
            if s < speaker.threshold():
                print(f"[speaker] rejected (score {s:.2f})", file=sys.stderr)
                return ""
            # Accepted scores log too: threshold tuning needs the full
            # distribution, not just the tail that fell below the line.
            print(f"[speaker] ok (score {s:.2f})", file=sys.stderr)
        except Exception as exc:  # noqa: BLE001 — any gate fault means "allow"
            print(f"[speaker] gate error — allowing: {exc}", file=sys.stderr)
    # WHISPER_VAD_FILTER=0 disables Whisper's internal energy-based VAD. With a
    # speaker gate deciding who reaches Whisper, the internal VAD is redundant —
    # and harmful: quiet speech passes the (volume-normalized) speaker gate but
    # gets stripped to "" here. Default stays on for gateless deployments.
    vad = os.environ.get("WHISPER_VAD_FILTER", "1").strip() != "0"
    kwargs = {"language": "en", "vad_filter": vad}
    prompt = os.environ.get("WHISPER_INITIAL_PROMPT", "").strip()
    if prompt:
        kwargs["initial_prompt"] = prompt
    hotwords = os.environ.get("WHISPER_HOTWORDS", "").strip()
    if hotwords:
        kwargs["hotwords"] = hotwords
    segments, _ = model.transcribe(wav_path, **kwargs)
    segs = list(segments)
    if segs:
        # Per-utterance confidence stats: with vad_filter off, hallucination
        # filtering is threshold work, and thresholds need the live
        # distribution — same reason accepted speaker scores log above.
        ns_max = max(getattr(s, "no_speech_prob", 0.0) or 0.0 for s in segs)
        lp_min = min(getattr(s, "avg_logprob", 0.0) or 0.0 for s in segs)
        print(
            f"[whisper] segs={len(segs)} no_speech_max={ns_max:.2f} logprob_min={lp_min:.2f}",
            file=sys.stderr,
        )
    cap = os.environ.get("WHISPER_NO_SPEECH_MAX", "").strip()
    if cap:
        # WHISPER_NO_SPEECH_MAX=<float> drops segments the model itself rates
        # likely-non-speech. Whisper's built-in skip needs BOTH high
        # no_speech_prob AND low avg_logprob — stock-phrase hallucinations
        # ("I don't know.") decode confidently, so the pair never fires.
        try:
            cap_f = float(cap)
            kept = [s for s in segs if (getattr(s, "no_speech_prob", 0.0) or 0.0) <= cap_f]
            if len(kept) < len(segs):
                print(
                    f"[whisper] dropped {len(segs) - len(kept)} segment(s) over no_speech cap {cap_f}",
                    file=sys.stderr,
                )
            segs = kept
        except ValueError:
            pass
    text = " ".join(s.text for s in segs).strip()
    repeated = _repeated_sentence(text)
    if repeated:
        # The same sentence >=3 times in one utterance is Whisper's
        # noise-loop signature (seen live: "Thank you. I. Thank you. Thank
        # you." from a 13.7s silence blob) — never how people talk.
        print(f'[whisper] hallucination — repeated sentence: "{repeated}"', file=sys.stderr)
        return ""
    return _apply_fixups(text)


def _repeated_sentence(text):
    """Return the sentence repeated >=3 times in text (normalized), else None."""
    counts = {}
    for raw in re.split(r"[.!?]+", text):
        norm = " ".join(re.sub(r"[^a-z0-9 ]", "", raw.lower()).split())
        if not norm:
            continue
        counts[norm] = counts.get(norm, 0) + 1
        if counts[norm] >= 3:
            return norm
    return None


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
