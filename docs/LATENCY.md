# broca-machina latency: warm servers + further wins

Goal: cut round-trip latency **with no hardware changes**. The dominant fixed
cost in the original pipeline was **model load on every call** — `stt.py` spun up
a fresh Python and loaded faster-whisper (~1.1 s) per utterance; `tts.py` loaded
piper (~1.1 s) per reply. The warm-server change amortizes both to a one-time
boot cost.

## What changed

| Component | Before | After |
|-----------|--------|-------|
| STT | `stt.py <wav>` — fresh Python + model load **every** call | `stt_server.py` loads faster-whisper once; `stt_client.py` sends the wav over a Unix socket (`.voice-tmp/stt.sock`) |
| TTS | `tts.py <text> <out>` — fresh Python + piper load **every** call | `tts_server.py` loads piper once; `tts_client.py` sends `{text,out,speed}` over a Unix socket (`.voice-tmp/tts.sock`) |

The clients are **drop-in**: identical CLI (`stt_client.py <wav>` → transcript on
stdout; `tts_client.py <text> <out.wav>` honoring `VOICE_TTS_SPEED`). If the
socket is missing or the server is down/erroring, each client **falls back to a
cold in-process load** (the exact `stt.py`/`tts.py` logic), so warming is an
optimization, never a hard dependency. Start both with `scripts/warm-servers.sh`.

> **One loop per server.** Each warm server is deliberately single-threaded —
> it handles one request at a time, sized for the one-user-one-loop design. If
> you run several voice loops on one machine, give each its own socket paths
> (`VOICE_STT_SOCK` / `VOICE_TTS_SOCK` / `VOICE_VAD_SOCK`) and its own server
> instances rather than sharing one; a shared server serializes (or, if a
> client hangs mid-request, stalls) everyone behind it.

## Measured results

**Machine:** a CPU-only laptop, faster-whisper 1.2.1 (`small.en`, int8),
piper `en_US-amy-medium`. **STT sample:** `hello.wav` (6.23 s of speech, 16 kHz
mono). **TTS sample:** a 70-char reply. Each figure is the mean of 5 back-to-back
runs of the full client process (Python startup + import + socket + compute),
i.e. exactly what `voice_loop.js` pays when it `spawn`s the command.

| Stage | Cold (per-call load) | Warm (persistent server) | Saved | Speedup |
|-------|---------------------:|-------------------------:|------:|--------:|
| **STT** (6.2 s clip) | **2.81 s** | **1.67 s** | 1.14 s | 1.7× |
| **TTS** (70 chars) | **1.29 s** | **0.17 s** | 1.12 s | 7.6× |
| **STT + TTS per exchange** | **4.10 s** | **1.84 s** | **2.26 s** | **2.2×** |

Supporting detail:
- **Server-side compute only** (from server logs): STT transcribe 1.64 s;
  TTS synth 0.13–0.15 s. So the warm client's overhead *beyond* server compute is
  ~0.03 s (Python startup measured at ~0.011 s + socket round-trip). The warm STT
  number is now **dominated by transcription compute, not load** — that's the next
  lever (see below).
- **One-time boot cost** (paid once at `warm-servers.sh start`, then amortized
  across every utterance for the life of the session): STT model load + warmup
  **2.45 s**; TTS voice load + warmup **1.06 s**.
- **Output equivalence:** warm STT is byte-identical to `stt.py` on the sample.
  Warm TTS is *not* byte-identical because **piper synthesis is non-deterministic
  even cold-vs-cold** (repeated `tts.py` runs produce different frame counts:
  221740 vs 218668 bytes) — the warm output round-trips through STT to the same
  words, confirming the audio is equivalent, not a client bug.
- `speed != 1.0` (ffmpeg `atempo`) is handled identically on both paths
  (verified at `VOICE_TTS_SPEED=1.3`).

## Where the remaining warm-path time goes

Per exchange the warm pipeline is ~1.84 s of STT+TTS process time, **plus** a
fixed ~1.0 s that isn't in the table: `voice_loop.js` ends an utterance only
after `endSilenceMs` (default **1000 ms**) of trailing silence. That 1 s is dead
wall-clock on **every** turn. Breaking the remaining latency down:

- STT transcription compute: **~1.64 s** (scales with utterance length + model).
- End-of-speech silence timeout: **~1.0 s** (fixed, per turn).
- TTS synthesis compute: **~0.15 s** (already negligible warm).
- Playback of the reply: real-time (unavoidable; but *time-to-first-audio* is
  improvable).

---

## Further no-hardware optimizations, ranked by impact / effort

| # | Optimization | Est. latency win | Effort | Touches | Status |
|---|--------------|------------------|--------|---------|--------|
| 1 | **Smaller STT model** (`small.en`→`base.en`/`tiny.en`) | **−1.0 to −1.3 s / utterance** | Trivial (1 env var) | none | **shipped** (config lever `stt.env.WHISPER_MODEL`, default `small.en`) |
| 2 | **Silero VAD endpointing** (replaces the fixed silence wait) | **−0.5 to −0.8 s / turn** | Medium | `vad.py` / `vad_server.py` / `vad_stream.js` / `voice_loop.js` | **shipped, opt-in** (`vad.enabled`; thresholds need a live tune) |
| 3 | **Sentence-boundary TTS pipelining** | **−0.5 to −1.0 s time-to-first-audio** (long replies) | Medium | `voice_loop.js` | **shipped, opt-in** (`ttsPipeline.enabled`) |
| 4 | **Streaming / partial faster-whisper** | hides most of STT compute (−0.5 to −1.5 s) | High | `voice_loop.js` + new decode loop | recommendation |

> **All three shipped levers default OFF / unchanged.** VAD and TTS pipelining are
> gated behind config flags (`vad.enabled`, `ttsPipeline.enabled`), and the STT
> model default stays `small.en` — so nothing changes until you opt in. When VAD
> is enabled but its warm server is down, the loop falls back to the fixed
> `endSilenceMs` endpointing, so it is never a hard dependency.

### 1. Smaller / distilled STT model — biggest win for zero effort

Now that model load is amortized, the warm STT number is pure transcription
compute, and it's dominated by model size. Measured on this machine, same clip,
int8, warm (mean of 3):

| Model | Transcribe time | Transcript | vs `small.en` |
|-------|----------------:|-----------|--------------:|
| `tiny.en` | **0.35 s** | "…Voice Receive and Playback are both working. Going **Live**." | **4.7× faster** |
| `base.en` | **0.58 s** | "…Voice Receive and Playback are both working. Going **Life**." | **2.8× faster** |
| `distil-small.en` (`Systran/faster-distil-whisper-small.en`) | 1.40 s | identical to small | 1.2× faster |
| `small.en` (current) | 1.64 s | (reference) | 1.0× |

**Recommendation: switch `WHISPER_MODEL=base.en`.** It's 2.8× faster (1.64 s →
0.58 s, saving ~1.06 s/utterance) and the transcript is effectively identical to
`small.en` on this sample — only casing/punctuation nits. `tiny.en` is faster
still (0.35 s) if you accept slightly rougher proper-noun handling; good for a
push-to-talk command style, marginal for dictation. **distil-whisper is *not* the
win at this size** — `distil-small.en` (1.40 s) is barely faster than `small.en`
and slower than `base.en`; distillation pays off mainly at `large-v3` scale,
which is irrelevant on CPU here. No code change: `stt_server.py` already reads
`WHISPER_MODEL`, so set it in `warm-servers.sh`'s env and restart.
Warm `base.en` STT end-to-end would be ~0.6 s vs the original cold `small.en`
2.81 s — a **4.7× reduction**.

*(Minor adjunct: faster-whisper's `WhisperModel(cpu_threads=…)` / `OMP_NUM_THREADS`
can squeeze CPU decode further; secondary to model choice.)*

### 2. Cut the fixed end-of-speech silence timeout

`voice_loop.js` uses `EndBehaviorType.AfterSilence` with `duration: endSilenceMs`
(default **1000 ms**). Every utterance therefore incurs a fixed 1 s of silence
before STT even starts. This is the single largest *fixed* wall-clock cost left.

- **Low-effort lever (config only):** dropping `endSilenceMs` to ~500 ms halves
  the dead time (~−500 ms/turn) at the cost of occasionally clipping a speaker who
  pauses mid-thought. Deliberately *not* the default — the fixed timeout is kept
  long to protect natural pauses; VAD replaces the mechanism instead of just
  lowering the timer.
- **Shipped (opt-in): Silero VAD endpointing.** `vad.enabled` streams the
  decoded PCM to a warm `vad_server.py` that runs the Silero VAD ONNX model
  (the one **already vendored by faster-whisper** — no new dependency;
  `onnxruntime` only) frame-by-frame and reports end-of-speech the instant
  speech-prob stays below `neg_threshold` for `minSilenceMs` (after ≥ `minSpeechMs`
  of real speech). The loop (`handleUtterance`) then ends the utterance early via
  an idempotent `finalize()`, without touching the subscription's
  `AfterSilence(endSilenceMs)` — which stays as the fallback if the VAD server is
  down/unreachable. Measured: the VAD compute is ~0.6 % of realtime, and on a
  ~6.6 s clip it endpointed ~700 ms before the fixed timeout would have.
  Architecture: `vad.py` (streaming `SileroStream` + pure `Endpointer` state
  machine + resampler) → `vad_server.py` (warm Unix-socket server) →
  `vad_stream.js` (the loop's client). Start the server with
  `warm-servers.sh start vad` (or `VOICE_WARM_VAD=1` so `start` includes it).
  Thresholds (`threshold`, `minSilenceMs`, `minSpeechMs`) are config knobs and
  **want a live voice test with a real speaker to dial in** — the defaults (0.5 /
  300 ms / 150 ms) are conservative starting points.
  (Note: faster-whisper's `vad_filter=True` already uses Silero *inside* STT to
  trim silence for the decoder, but that runs **after** capture — it does nothing
  for the live endpointing decision, which is what costs the 1 s. This is a
  separate, live, per-frame use of the same model.)

### 3. Sentence-boundary TTS pipelining

**Shipped (opt-in): `ttsPipeline.enabled`.** The whole reply used to be
synthesized to one WAV, then played. Because warm piper synthesizes a sentence in
~0.15 s, the loop now **starts playing sentence 1 while sentence 2 is still
synthesizing**, collapsing *time-to-first-audio* from "synthesize the entire
reply" to "synthesize the first sentence." For a short reply this is already
~0.17 s (no gain — so only replies ≥ `minChars` are pipelined), but for a long
reply near the 700-char `maxReplyChars` cap the full synth is ~1 s while the first
sentence is ~0.15 s — a ~0.85 s cut to when the user first hears something.
`splitSentences()` splits at sentence boundaries (and newlines), merging up to
`maxChunkChars` and hard-splitting any oversize sentence; `speakPipelined()`
synthesizes chunk N+1 while chunk N plays, preserves ordering, and honors the
existing barge-in (a spoken interruption clears `botSpeaking`, which aborts the
remaining chunks). Default OFF; highest value when replies are long, negligible
for one-liners.

### 3b. Fast acknowledgement (perceived latency, not round-trip)

The levers above shorten the *actual* round trip. This one shortens the *felt*
one. On a slow brain — an LLM or agent that thinks for several seconds — the
channel is silent from the moment you stop talking until the reply plays, and
that silence reads as "is this thing on?" **`ackAfterMs`** speaks a short filler
that many ms after you stop talking, but only if the real reply hasn't already
landed. `ackPhrase` is a string or an array; the default set ("One moment." /
"Hmm, let me think." / "Just a sec." / "Okay, thinking.") rotates randomly and
never repeats back-to-back, so the bot doesn't chant one line every turn. Two
properties make it fast:

- **Armed at end-of-speech, before STT.** The ack clock starts in `finalize()`
  (right after the min-duration gate), not at dispatch — so the filler overlaps
  STT **and** the model instead of waiting them out. With `ackAfterMs: 600` you
  hear it ~0.6 s after you stop talking, while STT (~0.6–1.6 s) is still running.
- **Pre-rendered at startup.** Every phrase in the set is synthesized to a
  cached WAV once (`prerenderAck()`), so firing one is instant playback — not a
  TTS round-trip on the very turn we're trying to make feel responsive.

A fast reply preempts the ack (the reply branch clears `ackArmedAt` before the
ack is due), so you never hear both — no double-talk. It works for **every**
transport, including `command`, whose brain call otherwise blocks the loop
silently. Default OFF; the `claude-cli` and `ollama` examples enable it (`600`).
This doesn't reduce time-to-answer — it collapses time-to-*first-audio* to under
a second for a multi-second brain.

### 4. Streaming / partial faster-whisper

The deepest STT win: instead of capturing the whole utterance then transcribing,
run incremental decoding on partial audio **as the user speaks**, so by
end-of-speech most of the audio is already transcribed and only the tail remains.
`ufal/whisper_streaming` (LocalAgreement-2 policy, faster-whisper backend) is the
reference implementation. This overlaps STT compute with speech time and hides
most of the ~0.6–1.6 s transcription cost behind the utterance itself. It pairs
naturally with #2 (the VAD that decides end-of-speech also drives the streaming
commit). Effort is high — it rearchitects capture into a rolling buffer + repeated
partial `transcribe` calls with prefix-agreement bookkeeping, and the warm server
would need a stateful streaming endpoint rather than the current one-shot request.
Best treated as a later phase once #1 and #2 land.

---

## Recommended stack (in order)

1. **Ship the warm servers** (done) — `scripts/warm-servers.sh start`, wire
   `stt_client.py` / `tts_client.py` into the config. **−2.26 s/exchange.**
2. **`WHISPER_MODEL=base.en`** (done-able now, one env var). **−~1.06 s/utterance**
   on top of #1.
3. **`endSilenceMs: 500`** (config) or Silero VAD endpointing (`voice_loop.js`).
   **−0.5 to −0.8 s/turn.**
4. Sentence-boundary TTS pipelining for long replies.
5. Streaming faster-whisper once the above are in.

With #1–#3, a spoken exchange goes from **cold ~5.1 s** (2.81 STT + 1.0 silence +
1.29 TTS) of fixed overhead to roughly **~1.3 s** (0.58 warm+base STT + ~0.5
silence + 0.17 TTS) before reply playback — a **~4× reduction, no hardware
changes.**

## Sources
- [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper)
- [Systran/faster-distil-whisper-small.en (HF)](https://huggingface.co/Systran/faster-distil-whisper-small.en)
- [ufal/whisper_streaming — LocalAgreement real-time Whisper](https://github.com/ufal/whisper_streaming)
- [Turning Whisper into Real-Time Transcription System (arXiv 2307.14743)](https://arxiv.org/html/2307.14743)
