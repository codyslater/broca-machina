#!/usr/bin/env python3
"""broca-machina speaker gate — voiceprint embedding and verification.

Embeds utterance WAVs with a sherpa-onnx speaker-embedding model and compares
them (cosine) against an enrolled centroid, so the loop can respond to ONE
enrolled voice and ignore background speakers reaching the same microphone.

The centroid file is plain JSON ({model, samples, centroid}) built from a
directory of enrollment WAVs. Enrollment audio and the centroid are biometric
data: keep them OUTSIDE the repository (the default model/centroid location
is ~/.cache/broca-machina/speaker/).

Env:
  VOICE_SPEAKER_MODEL      embedding model path (default: the wespeaker
                           CAM++ voxceleb model under ~/.cache/broca-machina/speaker/)
  VOICE_SPEAKER_THRESHOLD  cosine acceptance threshold (default 0.5)

CLI:
  speaker.py build <enroll_dir> <ref.json>   -> prints sample count
  speaker.py score <wav> <ref.json>          -> prints cosine score
"""
import glob
import json
import os
import sys
import wave

import numpy as np

DEFAULT_THRESHOLD = 0.5


def default_model_path():
    return os.environ.get("VOICE_SPEAKER_MODEL") or os.path.expanduser(
        "~/.cache/broca-machina/speaker/wespeaker_en_voxceleb_CAMplus.onnx")


def threshold():
    try:
        return float(os.environ.get("VOICE_SPEAKER_THRESHOLD", DEFAULT_THRESHOLD))
    except ValueError:
        return DEFAULT_THRESHOLD


_extractor = None


def _get_extractor():
    global _extractor
    if _extractor is None:
        import sherpa_onnx
        _extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
            sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=default_model_path(), num_threads=2))
    return _extractor


def _read_wav(path):
    """WAV -> (float32 mono samples in [-1,1], sample rate)."""
    with wave.open(path, "rb") as w:
        rate, ch = w.getframerate(), w.getnchannels()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    if ch > 1:
        pcm = pcm.reshape(-1, ch).mean(axis=1).astype(np.int16)
    return pcm.astype(np.float32) / 32768.0, rate


def embed(wav_path):
    """L2-normalized embedding vector for one utterance WAV."""
    ex = _get_extractor()
    samples, rate = _read_wav(wav_path)
    st = ex.create_stream()
    st.accept_waveform(rate, samples)
    st.input_finished()
    v = np.asarray(ex.compute(st), dtype=np.float32)
    n = float(np.linalg.norm(v))
    return v / n if n else v


def build(enroll_dir, ref_path):
    """Average the enrollment WAVs into a centroid file; returns sample count."""
    wavs = sorted(glob.glob(os.path.join(enroll_dir, "*.wav")))
    if not wavs:
        raise SystemExit(f"speaker: no enrollment wavs in {enroll_dir}")
    centroid = np.mean([embed(w) for w in wavs], axis=0)
    n = float(np.linalg.norm(centroid))
    if n:
        centroid = centroid / n
    with open(ref_path, "w") as f:
        json.dump({"model": os.path.basename(default_model_path()),
                   "samples": len(wavs), "centroid": centroid.tolist()}, f)
    return len(wavs)


def score(wav_path, ref_path):
    """Cosine similarity between one utterance and the enrolled centroid."""
    ref = json.load(open(ref_path))
    centroid = np.asarray(ref["centroid"], dtype=np.float32)
    return float(np.dot(embed(wav_path), centroid))


def main():
    if len(sys.argv) == 4 and sys.argv[1] == "build":
        print(build(sys.argv[2], sys.argv[3]))
    elif len(sys.argv) == 4 and sys.argv[1] == "score":
        print(f"{score(sys.argv[2], sys.argv[3]):.4f}")
    else:
        sys.exit("usage: speaker.py build <enroll_dir> <ref.json> | score <wav> <ref.json>")


if __name__ == "__main__":
    main()
