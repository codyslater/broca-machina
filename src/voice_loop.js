// broca-machina — a self-contained Discord voice-channel <-> text-brain bridge.
//
// Generic core, no app-specific IDs/paths. Configure via a JSON file whose path
// is given in $VOICE_CONFIG or argv[2]. The "brain" (whatever produces replies
// from transcripts) is decoupled behind a transport:
//   - file:    write each transcript to transcriptDir/<ts>.txt; read reply text
//              from replyFile (whatever writes replyFile becomes the voice).
//   - command: pipe each transcript to a shell command; its stdout is the reply.
//
// Flow: receive Discord audio -> ffmpeg 16k mono wav -> STT cmd -> transport.out
//       transport.in (reply text) -> TTS cmd -> play into the channel.
//
// DAVE E2EE note: requires @discordjs/voice >=0.19 (ships @snazzah/davey) on a
// Node>=22 runtime — run under `bun` if the host Node is older. See README.
const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel, EndBehaviorType, VoiceConnectionStatus, entersState,
  createAudioPlayer, createAudioResource, StreamType,
} = require('@discordjs/voice');
let prism = require('prism-media');   // `let`: reloadOpus() swaps in a fresh module after WASM heap corruption
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CFG_PATH = process.env.VOICE_CONFIG || process.argv[2];
if (!CFG_PATH) { console.error('usage: bun src/voice_loop.js <config.json>  (or set $VOICE_CONFIG)'); process.exit(2); }
let CFG;
try { CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); }
catch (e) { console.error(`broca-machina: cannot read config ${CFG_PATH}: ${e.message}`); process.exit(2); }

// Fail fast on an unusable config with messages that name the field, instead of
// a stack trace from wherever the hole is first dereferenced mid-flight.
{
  const errs = [];
  const d = CFG.discord;
  if (!d || typeof d !== 'object') errs.push('discord{} block missing');
  else {
    for (const k of ['guildId', 'channelId']) {
      if (!d[k]) errs.push(`discord.${k} missing`);
      else if (/^YOUR_/.test(String(d[k]))) errs.push(`discord.${k} is still the "${d[k]}" placeholder — fill in the real ID`);
    }
    // A placeholder allowedUserId passes the fail-closed gate but matches no real
    // speaker: the bot joins yet never hears anyone. Catch it here instead.
    if (d.allowedUserId && /^YOUR_/.test(String(d.allowedUserId))) {
      errs.push(`discord.allowedUserId is still the "${d.allowedUserId}" placeholder — set your real Discord user ID`);
    }
  }
  for (const k of ['stt', 'tts']) {
    if (!CFG[k] || !Array.isArray(CFG[k].cmd) || !CFG[k].cmd.length) errs.push(`${k}.cmd missing (array: command + args)`);
  }
  let t = CFG.transport || { type: 'file' };
  if (typeof t !== 'object' || Array.isArray(t)) { errs.push('transport must be an object, e.g. {"type":"file", ...}'); t = {}; }
  if (t.type == null) t.type = 'file';   // normalize: a typeless transport block IS the file transport
  if (t.type === 'file') {
    if (!t.transcriptDir) errs.push('transport.transcriptDir missing (required for type "file")');
    if (!t.replyFile) errs.push('transport.replyFile missing (required for type "file")');
  } else if (t.type === 'command') {
    if (!Array.isArray(t.cmd) || !t.cmd.length) errs.push('transport.cmd missing (required for type "command")');
  } else if (t.type !== 'mcp') {
    errs.push(`transport.type "${t.type}" unknown (file | command | mcp)`);
  }
  if (errs.length) {
    console.error(`broca-machina: invalid config ${CFG_PATH}:\n  - ${errs.join('\n  - ')}`);
    process.exit(2);
  }
}

const TOKEN_ENV = (CFG.discord && CFG.discord.tokenEnv) || 'DISCORD_VOICE_BOT_TOKEN';
let token = process.env[TOKEN_ENV];
if (!token && CFG.discord && CFG.discord.tokenFile) {
  // Fallback: read the token from an env-format file (KEY=value). Lets a launcher
  // that can't source a .env (e.g. an MCP host reading .mcp.json) authenticate
  // without putting the secret in the launch config.
  try {
    const tf = CFG.discord.tokenFile.replace(/^~/, process.env.HOME || '~');
    const envKey = TOKEN_ENV.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');   // tokenEnv is config text, not a regex
    const m = fs.readFileSync(tf, 'utf8').match(new RegExp('^' + envKey + '=(.+)$', 'm'));
    if (m) token = m[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* fall through to the error below */ }
}
if (!token) { console.error(`broca-machina: no bot token in $${TOKEN_ENV}`); process.exit(2); }

const GUILD = CFG.discord.guildId;
const CHANNEL = CFG.discord.channelId;
const ALLOWED = CFG.discord.allowedUserId || null;   // null = accept any speaker
const T = CFG.transport || { type: 'file' };

// Fail closed on speaker access: an open mic wired to a command/mcp/agent brain
// lets any speaker in the channel drive the brain with its full privileges (a
// spoken prompt injection -> possible RCE). Require an explicit allowed user, or
// an explicit allowAnySpeaker opt-in.
const ALLOW_ANY = !!(CFG.discord && CFG.discord.allowAnySpeaker === true);
if (!ALLOWED && !ALLOW_ANY) {
  console.error('broca-machina: refusing to start — no discord.allowedUserId set.\n' +
    '  Set discord.allowedUserId to restrict the bot to one speaker (recommended),\n' +
    '  or set discord.allowAnySpeaker: true to explicitly accept ANY speaker.\n' +
    '  Accepted speech reaches your brain directly; with a command/mcp brain every\n' +
    "  speaker inherits the brain's privileges — treat transcripts as untrusted.");
  process.exit(2);
}
if (ALLOW_ANY && !ALLOWED && (T.type === 'command' || T.type === 'mcp')) {
  console.error(`broca-machina [security] OPEN MIC: allowAnySpeaker=true with transport="${T.type}" — ` +
    'ANY speaker in the channel reaches the brain; treat every transcript as UNTRUSTED (prompt injection).');
}
const STT_CMD = CFG.stt.cmd;                          // array; wav path appended
const TTS_CMD = CFG.tts.cmd;                          // array; [text, outwav] appended
const SPEEDFILE = (CFG.tts && CFG.tts.speedFile) || null;
const PLAYWAV = CFG.playWavFile || null;              // optional: file holding a wav path to play
const PRESENCE_FILE = CFG.presenceFile || null;       // optional: exists while the allowed user is in the channel
const AUTO_JOIN = CFG.autoJoin === true;              // presence-gated: join VC only while the user is in it
const IDLE_LEAVE_MS = CFG.idleLeaveMs || 600000;      // after the user leaves, wait this long before leaving the VC (10 min)
const END_SILENCE = CFG.endSilenceMs || 1000;
const MIN_SEC = CFG.minUtteranceSec || 0.4;
const BARGE_IN = CFG.bargeIn !== false;            // interrupt playback when the user speaks
// Confirm-before-kill barge-in (default on): a speaking-start during playback
// DUCKS the audio and lets STT decide — real speech interrupts exactly like
// classic barge-in; a noise blob (breath, mic bump, the bot's own audio
// leaking back into the mic) just restores the volume. Observed live: phantom
// half-second "utterances" with empty STT killing multi-chunk replies
// mid-sentence. bargeInConfirm:false restores the instant behavior.
const BARGE_CONFIRM = BARGE_IN && CFG.bargeInConfirm !== false;
// An interrupt must be EARNED. Whisper hallucinates short stock phrases on
// ducked noise blobs ("I don't know." cut live playback three times
// 2026-08-16), and the model's own confidence can't separate them from real
// speech (measured inside the real-speech band). So confirm mode only KILLS
// playback for a transcript of >= bargeMinWords words, a wake word, or an
// explicit stop phrase — anything shorter still delivers as a normal turn,
// it just can't cut audio. bargeMinWords:0 disables the bar.
const BARGE_MIN_WORDS = CFG.bargeMinWords != null ? CFG.bargeMinWords : 4;
const BARGE_STOP_PHRASES = new Set(['stop', 'wait', 'hold on', 'shut up', 'quiet', 'be quiet',
  'pause', 'stop talking', 'never mind', 'nevermind', 'no stop', 'okay stop']);
function bargeWorthy(text) {
  if (!BARGE_MIN_WORDS) return true;
  const norm = String(text).toLowerCase().replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (BARGE_STOP_PHRASES.has(norm)) return true;
  if (ADDRESS_GATE && hasWakeWord(text)) return true;
  return norm.split(' ').filter(Boolean).length >= BARGE_MIN_WORDS;
}
// Speaker gate / first-run enrollment (opt-in): cfg.speakerGate.refFile is
// the enrolled voiceprint (built by src/speaker.py; the STT layer enforces
// the gate via VOICE_SPEAKER_REF in stt.env — a rejected voice surfaces as an
// empty transcript and rides the existing phantom handling, no logic here).
// The LOOP owns enrollment: refFile configured but absent -> a short scripted
// conversation collects clean utterance samples, builds the voiceprint, then
// normal flow resumes. During enrollment NOTHING the user says is forwarded
// to any brain — the content is throwaway by design; only the audio matters.
// Samples + voiceprint are biometric data: point refFile OUTSIDE the repo
// (docs default to ~/.cache/broca-machina/speaker/).
const SPEAKER_ENROLL = (() => {
  const s = CFG.speakerGate;
  if (!s || !s.refFile) return null;
  const home = process.env.HOME || '~';
  const ref = String(s.refFile).replace(/^~/, home);
  const enrollDir = s.enrollDir ? String(s.enrollDir).replace(/^~/, home)
    : path.join(path.dirname(ref), 'enroll');
  return {
    refFile: ref, enrollDir,
    utterances: s.enrollUtterances || 8,
    buildCmd: (Array.isArray(s.buildCmd) && s.buildCmd.length) ? s.buildCmd
      : ['python3', path.join(__dirname, 'speaker.py'), 'build', enrollDir, ref],
  };
})();
function enrollNeeded() { return !!SPEAKER_ENROLL && !fs.existsSync(SPEAKER_ENROLL.refFile); }
// Enrollment-aware endpointing: reflective answers include thinking pauses
// that command-tuned endpointing reads as end-of-utterance — cutting the
// speaker off mid-answer and letting the next prompt talk over the rest
// (observed live: one sample captured two answers run together). While
// enrolling, BOTH endpointers wait substantially longer.
const ENROLL_SILENCE_MS = (CFG.speakerGate && CFG.speakerGate.enrollMinSilenceMs) || 1500;
function endSilenceMs() { return enrollNeeded() ? Math.max(END_SILENCE, ENROLL_SILENCE_MS) : END_SILENCE; }
function vadMinSilenceMs() {
  const base = (VAD && VAD.minSilenceMs != null) ? VAD.minSilenceMs : 300;
  return enrollNeeded() ? Math.max(base, ENROLL_SILENCE_MS) : base;
}
// Deliberately innocuous prompts — they elicit natural speech without asking
// for anything personal, and the answers are discarded unheard by any brain.
const ENROLL_PROMPTS = [
  'Nice. What is the weather like where you are today?',
  'Tell me about something you are looking forward to this week.',
  'Count slowly from one to ten for me.',
  'What is your favorite way to spend a free afternoon?',
  'Describe the room you are in right now.',
  'Say this for me: the quick brown fox jumps over the lazy dog.',
  'Almost done. Tell me about a movie or a book you enjoyed recently.',
  'Last one. Read me any sentence from something nearby, or just say hello in a few different ways.',
];
const ENROLL_INTRO = 'Before we start, I do not have your voiceprint yet, so let me learn your voice. '
  + 'I will ask a few easy questions; just answer naturally. First: what did you eat today?';
function countEnrollSamples() {
  try { return fs.readdirSync(SPEAKER_ENROLL.enrollDir).filter((f) => f.endsWith('.wav')).length; }
  catch { return 0; }
}
async function enrollTurn() {
  const n = countEnrollSamples();
  if (n >= SPEAKER_ENROLL.utterances) {
    log(`[enroll] ${n} samples — building voiceprint`);
    await speak('Perfect, that is everything I need. One moment while I learn your voice.');
    const out = await runCmd([...SPEAKER_ENROLL.buildCmd], {}, 120000);
    if (!enrollNeeded()) {
      log('[enroll] voiceprint built');
      await speak('Done. From now on I only respond to your voice. If you ever want to redo this, delete the voiceprint file and rejoin.');
    } else {
      log('[enroll] build FAILED:', String(out).slice(0, 200));
      await speak('Something went wrong learning your voice. I will keep listening normally for now.');
    }
  } else {
    await speak(ENROLL_PROMPTS[Math.min(n - 1, ENROLL_PROMPTS.length - 1)]);
  }
}

// Semantic endpointing (default on, semanticEndpoint.enabled=false disables):
// endpointers cut at silence, but a pause is not always the end of a thought.
// Instead of holding the mic open longer (latency for every turn), let the
// cut happen FAST and judge the transcript: one that sounds unfinished is
// HELD briefly rather than delivered — a continuation arriving inside the
// hold window is joined into one turn; none coming, it flushes as-is. Wrong
// hold costs holdMs of delay on that turn; wrong cut costs nothing new (it
// is exactly the old behavior). Completeness reads Whisper's own punctuation
// plus a dangling-connective check — deterministic, no extra model.
const SEMANTIC = (() => {
  const s = CFG.semanticEndpoint || {};
  return s.enabled === false ? null : { holdMs: s.holdMs || 4000 };
})();
// Hard connectives never end a thought — a Whisper period after "and." or
// "the." is punctuation noise, not a sentence end. Prepositions and OBJECT
// pronouns are SOFT: English sentences end on them constantly ("what we're
// working on.", "turn it on.", "go ahead and start it.", "thank you."), so
// Whisper's terminal period is trusted there; without one a trailing
// preposition or object pronoun still reads as mid-thought and holds. (Live
// 2026-08-13..29: 26 holds, 0 joins — every trigger was "it."/"that."/"you."
// sitting in the hard set, each costing holdMs for nothing.)
const HARD_CONNECTIVES = new Set(('and or but because since although though if when while which who ' +
  'the a an my your his its our their ' +
  'is are was were be being been am has have had do does did will would could should can may might must ' +
  'i we they he she um uh like plus versus than as not very really just').split(' '));
const SOFT_CONNECTIVES = new Set(('to of in on at with for from by about into onto over under between ' +
  'during before after ' +
  'it that this these those you them me him her us so then also too').split(' '));
function looksIncomplete(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/[?!]$/.test(t)) return false;          // questions/exclamations are finished thoughts
  if (/,$/.test(t)) return true;              // Whisper heard a clause boundary, not an end
  const hasPeriod = /\.$/.test(t);
  const last = (t.replace(/[.\s]+$/, '').split(/\s+/).pop() || '').toLowerCase().replace(/[^a-z']/g, '');
  if (HARD_CONNECTIVES.has(last)) return true;   // dangling connective — even a trailing period doesn't save it
  return SOFT_CONNECTIVES.has(last) && !hasPeriod;  // preposition: hold only when Whisper heard no sentence end
}
let pendingUtterance = null;   // { text, timer } — a held, unfinished-sounding transcript

// Address gate (opt-in): the microphone catches everything the enrolled
// speaker says — including things said to OTHER PEOPLE in the room. A wake
// word anywhere in the utterance delivers instantly; everything else is
// judged by a warm local LLM (with the recent-turns ring as context) as
// ADDRESSED or ASIDE. Asides are dropped: logged, teed with an .aside suffix
// (never silently lost), no ack fired — the room conversation should not
// hear "let me check on that". FAIL-OPEN everywhere: a judge timeout, HTTP
// error, or unreachable model delivers normally — the voice lifeline must
// never depend on the judge. Cost: ~judge-latency before delivery on every
// wake-word-less turn; that is the price of catching mid-convo asides.
const ADDRESS_GATE = (() => {
  const a = CFG.addressGate;
  if (!a || a.enabled !== true) return null;
  return {
    wakeWords: (Array.isArray(a.wakeWords) && a.wakeWords.length ? a.wakeWords : ['assistant'])
      .map((w) => String(w).toLowerCase()),
    ollamaHost: a.ollamaHost || (CFG.localAck && CFG.localAck.ollamaHost) || 'http://localhost:11434',
    model: a.model || (CFG.localAck && CFG.localAck.model) || 'gemma4:e4b',
    timeoutMs: a.timeoutMs || 2500,
    // 5 min, not 60s. The window is measured from the moment the assistant
    // STOPPED TALKING, and an agentic assistant then works in silence for
    // minutes — so the user's answer to its own question routinely arrives
    // "cold" and reaches the judge stripped of the exchange that produced it.
    // Live 2026-08-29 17:51: "Yeah, you can go ahead and discard those. And I
    // think you're out of date on the other items." — a direct instruction,
    // 2.8 min after the last reply, judged ASIDE and dropped; the user had to
    // say it twice. 60s measured a conversation's rhythm; this measures a
    // WORKING assistant's.
    hotWindowMs: a.hotWindowMs ?? 300000,
    // STT mangles a short name constantly ("Juno" -> "Juneau", "June"), and a
    // missed wake word sends a directly-addressed turn to the judge, which is
    // where it dies. Live 2026-08-29: a directly-addressed "hey <mangled
    // name>, give me an update" — dropped. The costs are asymmetric: a fuzzy false
    // positive delivers one aside, a false negative loses an instruction.
    fuzzy: a.fuzzy !== false,
  };
})();
// Common words within one edit of a short wake word. Without this, a
// 4-letter wake word matches `that`/`than` and the gate is disabled by
// accident rather than by decision.
const WAKE_STOPWORDS = new Set([
  'that', 'than', 'thai', 'thaw', 'the', 'this', 'they', 'them', 'then', 'there',
  'tall', 'hall', 'call', 'fall', 'wall', 'ball', 'half', 'halt', 'hail', 'tail',
  'talk', 'thanks', 'thank', 'shall', 'echoes',
]);
// True iff `a` and `b` differ by at most one edit (sub/ins/del). Early-exit,
// no matrix — these are single words called once per utterance.
function withinOneEdit(a, b) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la === lb) { i++; j++; }
    else if (la > lb) i++;
    else j++;
  }
  return edits + (la - i) + (lb - j) <= 1;
}
// Speech landing within hotWindowMs of the assistant FINISHING talking is a
// reply to it — addressed by construction, no judge needed. The LLM judge only
// sees cold turns, where a genuine room-directed aside is actually plausible.
// (Live failure mode this kills: short "Yeah, …" replies to the assistant,
// stripped of context, read as asides to the judge and were dropped.)
let lastBotSpeechEndedAt = 0;
// Was a reply still owed the instant the user started this utterance? Set at capture
// start, because `ackArmedAt` is cleared there and is 0 by delivery time.
let replyOwedAtCaptureStart = 0;
// The assistant finished speaking: the reply landed, so the owed-reply latch clears and
// the wall clock takes over from here. One function so the two can never drift apart —
// a latch that outlives its reply would pin the channel hot forever, which is the gate
// disabled by accident rather than by decision.
function markBotSpoke() { lastBotSpeechEndedAt = Date.now(); replyOwedAtCaptureStart = 0; }
function hasWakeWord(text) {
  if (!ADDRESS_GATE) return false;
  const t = String(text || '').toLowerCase();
  if (ADDRESS_GATE.wakeWords.some((w) =>
    new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t))) return true;
  if (!ADDRESS_GATE.fuzzy) return false;
  // Exact match failed. Try the transcriber's near-misses, but only for wake
  // words long enough that one edit still identifies them (>=4 chars: at 3, a
  // single edit reaches most of the language).
  const tokens = t.split(/[^a-z]+/).filter(Boolean);
  return ADDRESS_GATE.wakeWords.some((w) => w.length >= 4 && tokens.some(
    (tok) => !WAKE_STOPWORDS.has(tok) && tok !== w && withinOneEdit(tok, w)));
}
async function judgeAddressed(text) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ADDRESS_GATE.timeoutMs);
  try {
    const resp = await fetch(`${ADDRESS_GATE.ollamaHost}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({
        model: ADDRESS_GATE.model,
        messages: [
          { role: 'system', content: 'You watch a voice channel where one user talks to a voice '
            + 'assistant, but the microphone also catches things the user says to other people in '
            + 'the room. Given the recent conversation and a new utterance, decide whether the new '
            + 'utterance is addressed to the assistant or is an aside to someone else. Short '
            + 'agreements, answers, instructions, and continuations that plausibly respond to the '
            + 'assistant\'s most recent message are ADDRESSED. The user narrating their own '
            + 'actions or plans in the ongoing task ("I\'m going to...", "I just did...") is '
            + 'keeping the assistant informed — that is ADDRESSED. An aside is only speech clearly '
            + 'meant for another person: it names someone else, or is about room/domestic matters '
            + 'unrelated to the conversation. Reply with exactly one word: ADDRESSED or ASIDE. '
            + 'When unsure, reply ADDRESSED.' },
          ...recentTurns.map((t) => ({ role: t.role, content: t.text })),
          { role: 'user', content: `New utterance: "${text}"` },
        ],
        stream: false,
        think: false,
        options: { num_predict: 5 },
      }),
    });
    if (!resp.ok) { log('[address] judge http', resp.status, '— allowing'); return true; }
    const body = await resp.json();
    const out = ((body && body.message && body.message.content) || '').trim().toUpperCase();
    return !out.includes('ASIDE');
  } catch (e) {
    log('[address] judge err — allowing:', (e && e.message) || String(e));
    return true;
  } finally { clearTimeout(timer); }
}
// The judge is for a genuinely COLD channel. Three things make it hot, and
// only the third is a clock: the assistant is talking (they are talking over
// it, which is what barge-in is for), the assistant owes a reply to a turn
// already sent (`ackArmedAt` — the user waiting through a long tool run is
// still in the same exchange), or it spoke recently. The middle one is the
// case a wall-clock window cannot express: silence during work looks exactly
// like silence after the conversation ended.
function channelIsHot() {
  if (botSpeaking) return true;
  if (ackArmedAt > 0 || replyOwedAtCaptureStart > 0) return true;
  return Date.now() - lastBotSpeechEndedAt < ADDRESS_GATE.hotWindowMs;
}
async function deliverTranscript(text) {
  if (ADDRESS_GATE && !hasWakeWord(text) && !channelIsHot()
      && !(await judgeAddressed(text))) {
    log(`[address] aside dropped: "${text.slice(0, 60)}"`);
    cancelAck();   // no reply is coming and none should be promised
    if (T.transcriptDir) {
      try { fs.writeFileSync(path.join(T.transcriptDir, `${utcTs()}.aside`), text); }
      catch (e) { log('[address] aside tee err', e.message); }
    }
    return;
  }
  if (LOCAL_ACK) dispatchLocalAck(text, ackGeneration);   // fire-and-forget, races the real reply
  return sendTranscript(text);
}

// Capture watchdog: a capture that outlives this is force-finalized — a
// decoder crash or a stream that never ends must cost one utterance, not the
// session (observed live: a WASM opus-decoder crash mid-capture left
// capturing=true forever → deaf loop until restart). 0 disables.
const MAX_CAPTURE_MS = (CFG.maxCaptureSec != null ? CFG.maxCaptureSec : 60) * 1000;
const ACK_AFTER_MS = CFG.ackAfterMs || 0;          // 0 = off; else speak an ack phrase this long AFTER end-of-speech
// ackPhrase: string OR array of strings. With several phrases the ack rotates
// randomly (never the same one twice in a row) so a slow brain doesn't chant
// the identical filler every turn. Each phrase is pre-rendered at boot.
const ACK_PHRASES = (() => {
  const raw = CFG.ackPhrase;
  const list = (Array.isArray(raw) ? raw : (raw ? [raw] : []))
    .map((s) => String(s).trim()).filter(Boolean);
  return list.length ? list : ['One moment.', 'Hmm, let me think.', 'Just a sec.', 'Okay, thinking.'];
})();
const CMD_TIMEOUT_MS = CFG.cmdTimeoutMs || 60000;   // hard cap on an STT/TTS/brain subprocess; kill + empty on expiry
const PLAY_TIMEOUT_MS = CFG.playTimeoutMs || 60000; // safety cap so a single playback can't wedge the loop forever
// Thinking earcon (opt-in): a quiet ambient loop that fills the silence AFTER
// the turn's ack while the reply is still cooking, cut instantly by a reply,
// a new utterance, or barge-in. Non-verbal on purpose — more spoken filler
// fatigues on long waits; a low ambient cue reads as "still working" without
// demanding attention.
const EARCON = (() => {
  const e = CFG.thinkingEarcon;
  if (!e || !e.file) return null;
  const f = String(e.file).replace(/^~/, process.env.HOME || '~');
  if (!fs.existsSync(f)) { console.error(`broca-machina: thinkingEarcon.file not found: ${f} — earcon disabled`); return null; }
  return { file: f, afterMs: e.afterMs || 4000, volume: e.volume || 0.15, maxMs: e.maxMs || 45000 };
})();
// Long-wait spoken notice (opt-in): afterMs into a turn with no reply, say ONE
// short phrase. The earcon is the ambient "working" signal, but an agent brain
// can take minutes and at some point a human wants words, not a hum.
const LONG_WAIT = (() => {
  const c = CFG.longWaitNotice;
  if (!c || !c.afterMs) return null;
  const raw = c.phrase || 'Still working on it — the reply is taking a while.';
  // phrase: string or array (rotates like ackPhrase — the same line twice in a
  // row reads as a stuck bot). {who} names the session actually being waited
  // on, read from the live route at fire time: a fixed "the assistant has not
  // replied" is wrong exactly when the wait is longest — a routed session
  // (CS, 2026-08-30 live test against a remote session). No route -> `who`.
  return { afterMs: c.afterMs, phrases: Array.isArray(raw) ? raw : [raw], who: c.who || 'the brain' };
})();
let longWaitLastIdx = -1;
function renderLongWaitPhrase(tpl, who) { return String(tpl).split('{who}').join(who); }
const NOISE = new Set((CFG.sttNoiseDrop || ['', '.', 'you', 'thank you', 'thanks', 'bye', 'you.', 'thank you.']).map((s) => s.toLowerCase()));
// Per-SENTENCE noise: Whisper's noise-loop signature is a stock phrase
// repeated — "Thank you.  Thank you." — which dodges the whole-text list and
// the >=3 repetition filter in stt.py (live 2026-08-25: held, then delivered
// to the brain, seven times). A transcript whose every sentence is a noise
// phrase or a sub-3-char fragment ("I.") is a hallucination, not a turn.
function normNoise(s) { return String(s).toLowerCase().replace(/[\s.!?,;:]+$/, '').trim(); }
const NOISE_NORM = new Set([...NOISE].map(normNoise).filter(Boolean));
function isNoise(text) {
  const t = String(text || '').trim();
  if (t.length < 3 || NOISE.has(t.toLowerCase())) return true;
  const sentences = t.split(/[.!?]+/).map(normNoise).filter(Boolean);
  return sentences.length > 0 && sentences.every((x) => x.length < 3 || NOISE_NORM.has(x));
}
const TMPDIR = CFG.tmpDir || path.join(path.dirname(path.resolve(CFG_PATH)), '.voice-tmp');
fs.mkdirSync(TMPDIR, { recursive: true });
// Singleton guard: instances sharing a tmpDir share sockets AND the voice
// channel — duplicates race the join, and the loser's failure mode is silent
// wrongness (transcripts delivered to whichever host spawned the winner), not
// a crash. Leaked launcher orphans made this bite live. First boot owns the
// dir via loop.pid; later boots must refuse loudly, naming the holder.
const LOOP_PIDFILE = path.join(TMPDIR, 'loop.pid');
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!e && e.code === 'EPERM'; }
}
function acquireSingleton(dir) {
  const pf = path.join(dir, 'loop.pid');
  try {
    const prev = parseInt(fs.readFileSync(pf, 'utf8').trim(), 10);
    if (Number.isFinite(prev) && prev > 0 && prev !== process.pid && pidAlive(prev)) {
      // /proc cmdline guards against PID reuse claiming to be a holder; where
      // /proc is unreadable (non-Linux), any live pid in the file wins.
      let cmd = null;
      try { cmd = fs.readFileSync(`/proc/${prev}/cmdline`, 'utf8'); } catch { /* non-Linux */ }
      if (cmd === null || cmd.includes('voice_loop')) return { ok: false, holder: prev };
    }
  } catch { /* no pidfile yet — ours to take */ }
  fs.writeFileSync(pf, String(process.pid));
  return { ok: true, holder: process.pid };
}
// Sweep scratch WAVs orphaned by a previous crash (normal runs unlink as they
// go, so anything matching here is dead). Boot-time only — nothing is in
// flight yet — and best-effort: hygiene must never block a start.
try {
  for (const f of fs.readdirSync(TMPDIR)) {
    if (/^(utt_|reply_)\d{8}_\d{6}_\d{6}\.wav$/.test(f)) fs.unlinkSync(path.join(TMPDIR, f));
  }
} catch { /* */ }
if (T.transcriptDir) fs.mkdirSync(T.transcriptDir, { recursive: true });

// Silero-VAD endpointing (opt-in). When enabled, decoded PCM is streamed to a
// warm vad_server.py that reports end-of-speech the instant the speaker stops,
// so the loop ends the utterance early instead of waiting the fixed END_SILENCE.
// Default OFF -> the receiver path is byte-for-byte the fixed-timeout behavior.
// If enabled but the server is down/unreachable, capture falls back to the same
// fixed END_SILENCE AfterSilence end (so VAD is an optimization, never required).
const VAD = (CFG.vad && CFG.vad.enabled === true) ? CFG.vad : null;
const VAD_SOCK = VAD
  ? (process.env.VOICE_VAD_SOCK || VAD.socket || path.resolve(__dirname, '..', '.voice-tmp', 'vad.sock'))
  : null;

// TTS sentence-boundary pipelining (opt-in). When enabled, a long reply is split
// at sentence boundaries and each chunk is synthesized/played incrementally
// (synthesizing chunk N+1 while chunk N plays), dropping time-to-first-audio.
// Default OFF -> replies are synthesized whole then played, exactly as before.
const TTS_PIPE = (CFG.ttsPipeline === true)
  ? { enabled: true }
  : (CFG.ttsPipeline && typeof CFG.ttsPipeline === 'object' && CFG.ttsPipeline.enabled === true ? CFG.ttsPipeline : null);
const TTS_PIPE_MIN_CHARS = (TTS_PIPE && TTS_PIPE.minChars) || 120;   // shorter replies stay one-shot
const TTS_PIPE_MAX_CHUNK = (TTS_PIPE && TTS_PIPE.maxChunkChars) || 240;

// Local-LLM instant ack (opt-in, GPU Phase-2 tier-1 — additive, NOT a
// replacement for the fixed ackPhrase pool above or the real reply). When
// enabled, a warm local Ollama model generates a short, CONTENT-CONNECTED
// holding phrase right after STT resolves (in parallel with delivering the
// transcript to the real brain — see dispatchLocalAck() + its call site in
// finalize()), but it only PLAYS at fireAfterMs if the real reply hasn't
// landed by then — a fast answer means no filler at all, and the canned
// ackPhrase tier becomes the same-moment fallback (one filler per turn, see
// pollReply()). Default OFF -> the loop is byte-for-byte unchanged.
// Fail-open by construction: any Ollama/network/TTS failure just means no
// local ack plays for that turn — the fixed ackPhrase (tier-0) and the real
// reply (tier-2) are completely unaffected either way. Pairs with
// docs/LATENCY.md's existing ack-tier writeup; the local model is one a
// deployment typically already keeps warm for other jobs (Ollama
// persistence), so the ack rides existing infrastructure.
const LOCAL_ACK = (CFG.localAck && CFG.localAck.enabled === true) ? {
  ollamaHost: CFG.localAck.ollamaHost || 'http://localhost:11434',
  model: CFG.localAck.model || 'gemma4:e4b',
  numPredict: CFG.localAck.numPredict || 30,
  systemPrompt: CFG.localAck.systemPrompt ||
    'You are the instant spoken acknowledgment layer of a voice assistant. A slower main ' +
    'model is preparing the real answer; your one line plays only when that answer is taking ' +
    'a while, right before it. Acknowledge THIS specific question so the wait feels attended ' +
    'to: name what it\'s about naturally, in a casual spoken register, 4-10 words. Reusing ' +
    'the key term the user said (a name, a task, a thing) is good — "let me check on those ' +
    'logs", "having a look at the deploy" — but never repeat their whole sentence, and NEVER ' +
    'answer, guess, preview, or add facts: anything substantive will duplicate or contradict ' +
    'the real answer. Plain spoken prose; no lists, no questions back.',
  timeoutMs: CFG.localAck.timeoutMs || 4000,
  fireAfterMs: CFG.localAck.fireAfterMs || 2000,
  contextTurns: CFG.localAck.contextTurns || 6,
} : null;
// Rolling window of recent HEARD turns (user transcripts + replies that were
// actually spoken) for the tier-1 ack: without it the local model sees four
// words and invents a connection; with it the filler continues the live
// thread. Hard-truncated per turn — the warm model's prompt must stay tiny
// (the whole tier lives on a sub-second budget).
const recentTurns = [];
function recordTurn(role, text) {
  const t = String(text || '').trim().slice(0, 200);
  if (!t) return;
  recentTurns.push({ role, text: t });
  const cap = (LOCAL_ACK && LOCAL_ACK.contextTurns) || 6;
  while (recentTurns.length > cap) recentTurns.shift();
}
// One filler per turn, fired only on a real wait: with LOCAL_ACK enabled the
// single fire point for BOTH ack tiers moves to fireAfterMs — a reply landing
// before it means no filler at all ("it doesn't have to fire every time").
// The content-aware ack still GENERATES right after STT (so it's ready in
// time); it just doesn't PLAY before the fire point. Without LOCAL_ACK the
// canned tier keeps its own ackAfterMs, byte-for-byte the old behavior.
const ACK_FIRE_MS = LOCAL_ACK ? LOCAL_ACK.fireAfterMs : 0;   // 0 = use ACK_AFTER_MS

const MCP_MODE = (T.type === 'mcp');
// A dead stdio pipe (the launching host exited, or a log consumer went away)
// must never take the loop down — and CRITICALLY must never feed the crash
// guards: an unswallowed EPIPE becomes uncaughtException -> our guard log()s ->
// EPIPE again -> a 100%-CPU crash loop that starves signal dispatch and makes
// the process unkillable except SIGKILL (observed under bun). Swallow at the
// stream, and keep log() itself throw-proof.
process.stdout.on('error', () => { /* */ });
process.stderr.on('error', () => { /* */ });
// Persistent sink (cfg.logFile): in mcp mode stderr belongs to the launching
// host, which may retain it only sporadically — without a file the loop owns,
// a live incident is undebuggable after the fact. Append-mode fd + sync line
// writes (ordered, throw-proof); boot-time rotation caps growth.
let LOG_FD = null;
if (CFG.logFile) {
  try {
    const lf = String(CFG.logFile).replace(/^~/, process.env.HOME || '~');
    try { if (fs.statSync(lf).size > 5 * 1024 * 1024) fs.renameSync(lf, lf + '.1'); }
    catch { /* no file yet */ }
    fs.mkdirSync(path.dirname(lf), { recursive: true });
    LOG_FD = fs.openSync(lf, 'a');
  } catch (e) { console.error(`broca-machina: cannot open logFile ${CFG.logFile}: ${e.message}`); }
}
// In mcp mode stdout is the JSON-RPC channel — every log line MUST go to stderr.
const log = (...a) => {
  try {
    const iso = new Date().toISOString();
    const line = [iso.slice(11, 19), ...a].map(String).join(' ');
    if (MCP_MODE) process.stderr.write(line + '\n'); else console.log(line);
    if (LOG_FD != null) {
      // Full date in the file — it spans days; stderr stays short-form.
      try { fs.writeSync(LOG_FD, iso + ' ' + a.map(String).join(' ') + '\n'); }
      catch { LOG_FD = null; }   // dead disk/fd: stop paying for it, keep stderr
    }
  } catch { /* logging must never throw */ }
};
function utcTs() {
  const d = new Date(), p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}_${p(d.getUTCMilliseconds() * 1000, 6)}`;
}
function runCmd(argv, extraEnv, timeoutMs) {
  return new Promise((resolve) => {
    const pr = spawn(argv[0], argv.slice(1), { env: { ...process.env, ...(extraEnv || {}) } });
    let out = '', done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    // A hung child (a warm server that accepts but never replies, a wedged model
    // load, a stuck ffmpeg) must not strand the caller forever — kill it, resolve ''.
    const timer = setTimeout(() => { log('[cmd] timeout — killing', argv[0]); try { pr.kill('SIGKILL'); } catch {} finish(''); }, timeoutMs || CMD_TIMEOUT_MS);
    pr.stdout.on('data', (d) => (out += d)); pr.stderr.on('data', () => {});
    pr.on('close', () => finish(out));
    pr.on('error', (e) => { log('[cmd] spawn err', e.message); finish(''); });
  });
}

// Lazily load the VAD client only when endpointing is enabled — a fault in the
// helper (or the config being off) must never touch the default receiver path.
let vadClient = null;
if (VAD) {
  try { vadClient = require('./vad_stream.js'); log(`[vad] endpointing enabled (sock ${VAD_SOCK})`); }
  catch (e) { log('[vad] disabled — helper load failed:', e.message); vadClient = null; }
}
function pcmToWav(pcm, outPath) {
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0', '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', outPath]);
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { log('[ffmpeg] timeout — killing'); try { ff.kill('SIGKILL'); } catch {} finish(); }, CMD_TIMEOUT_MS);
    ff.on('close', finish); ff.on('error', (e) => { log('[ffmpeg] err', e.message); finish(); });
    ff.stdin.on('error', () => {});   // swallow EPIPE if ffmpeg died before we finished writing
    ff.stdin.write(pcm); ff.stdin.end();
  });
}
// Cap enforcement that never stops mid-sentence: a raw slice at the cap
// sounds like the bot died mid-thought (live finding, 2026-08-10 — two
// replies landed at 697 and 696 of a 700 cap, each cut inside a sentence).
// Prefer the last completed sentence inside the cap; fall back to a word
// boundary only when the last sentence end is unusably early.
function truncateSpoken(t, cap) {
  if (t.length <= cap) return t;
  const cut = t.slice(0, cap);
  const s = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '),
    cut.endsWith('.') || cut.endsWith('!') || cut.endsWith('?') ? cap - 1 : -1);
  if (s >= cap * 0.5) return cut.slice(0, s + 1).trim();
  const w = cut.lastIndexOf(' ');
  return (w > 0 ? cut.slice(0, w) : cut).trim();
}
function cleanForTTS(t) {
  const cleaned = t
    .replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1').replace(/\*([^*]*)\*/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '')
    .replace(/[#>_~|*`]/g, ' ').replace(/\s+/g, ' ').trim();
  return truncateSpoken(cleaned, CFG.maxReplyChars || 700);
}

// Presence marker — reflects whether the allowed user is currently connected to
// the voice channel (driven by voiceStateUpdate). Lets external tooling gate on
// "is the human actually here" without polling Discord.
function setPresence(present) {
  presenceActive = present;
  if (present) {
    presenceSince = Date.now(); presenceUtterances = 0; presenceEdges = 0;
  } else if (presenceSince) {
    const secs = Math.round((Date.now() - presenceSince) / 1000);
    const deaf = secs >= DEAF_MIN_SEC && presenceEdges === 0;
    log(`[session] user present ${secs}s — ${presenceEdges} speaking edge(s), `
      + `${presenceUtterances} utterance(s) received`
      + (deaf ? '  ** DEAF — Discord delivered no speaking events; restart the loop **' : ''));
    presenceSince = 0;
  }
  if (!PRESENCE_FILE) return;
  try {
    if (present) fs.writeFileSync(PRESENCE_FILE, String(Date.now()));
    else if (fs.existsSync(PRESENCE_FILE)) fs.unlinkSync(PRESENCE_FILE);
  } catch (e) { log('[presence] err', e.message); }
}

let botSpeaking = false, capturing = false, player;
let ackedThisTurn = false;
let ackArmedAt = 0;   // end-of-speech time of the current turn; arms the "still thinking" ack (0 = no turn)
// Authoritative "no reply is coming / the promise is settled" disarm. Every
// site that MEANS that must go through here (not a bare `ackArmedAt = 0`):
// the counter lets a capture's phantom/too-short restore detect that the wait
// state it saved was cancelled mid-capture and must stay dead — restoring it
// would fire a filler (and start the earcon) for a turn that no longer exists.
let ackCancels = 0;
function cancelAck() { ackArmedAt = 0; ackCancels++; }
// Serializes post-capture processing (STT -> judge -> deliver) in arrival
// order. Capture itself is NOT serialized: `capturing` frees at the endpoint
// so a new speaking edge can open the next capture while this chain works —
// Discord sends one edge per utterance, so a closed window loses it whole.
let turnChain = Promise.resolve();
let mcpServer = null;   // set in initMcp() when transport.type === 'mcp'
// Voice-channel connection lifecycle (presence-gated when AUTO_JOIN).
let conn = null;            // the live VoiceConnection, or null when not in the channel
let connected = false;      // true once joined + player wired
let connecting = false;     // guards against overlapping enterChannel() calls
let leaveTimer = null;      // pending idle-leave timer (armed when the user leaves)
let presenceActive = false; // is the allowed user currently in the channel
// Deaf-loop instrumentation (20260831). A wedged loop joins cleanly, reports
// Ready, and receives NOTHING with no error logged — and the log cannot tell
// that apart from "the user was in the channel but never spoke", because both
// look like zero [recv] lines. These three counters make the distinction
// explicit: `presenceEdges` counts what DISCORD delivered, `presenceUtterances`
// counts what we finished capturing. Edges 0 while the user sat there for a
// while = Discord never told us they spoke, which is the actual failure.
const DEAF_MIN_SEC = 45;    // below this, "no edges" is just a short quiet visit
let presenceSince = 0;      // ms ts the allowed user entered the channel (0 = absent)
let presenceUtterances = 0; // utterances fully captured since they entered
let presenceEdges = 0;      // speaking.start edges Discord delivered since they entered
const gateDropLast = {};    // reason -> last-logged ms, throttles the gate-drop lines

// A speaking edge we deliberately ignored. Throttled per reason: in a healthy
// session these fire constantly and would drown the log; what matters is that
// the reason appears AT ALL, so once every 30s per reason is enough to name it.
function gateDrop(reason) {
  const now = Date.now();
  if (now - (gateDropLast[reason] || 0) < 30000) return;
  gateDropLast[reason] = now;
  log(`[recv] edge dropped — ${reason}`);
}

function handleUtterance(userId, opus) {
  capturing = true;
  // The user is (maybe) talking — mute the pending-ack timer so a filler
  // can't fire mid-utterance and talk over them (no speaking.start edge
  // arrives during continuous speech, so barge-in couldn't stop it). In
  // confirm mode that mute is the ONLY reset taken on faith: a capture must
  // not destroy wait-state it can't give back, so the generation bump, the
  // pending content-ack drop, and the queued-reply drop all wait for
  // finalize()'s STT verdict — a phantom (empty STT) restores the arm and
  // the earcon gate; confirmed speech commits everything. Legacy mode keeps
  // the original instant resets.
  const priorArmedAt = ackArmedAt, priorAcked = ackedThisTurn, priorCancels = ackCancels;
  // Capture START is the moment that decides whether the channel was hot, and the
  // next line clears the flag that says so — so stash it. Reading `ackArmedAt` in
  // deliverTranscript() instead always sees 0: the utterance being judged is the one
  // that reset it. (Caught by the selftest, which passed on the predicate and failed
  // on the delivery.)
  replyOwedAtCaptureStart = priorArmedAt;
  ackArmedAt = 0;
  // Ambient "working" over (possible) speech reads as not listening — but
  // the open mic fires edges constantly (live: 244 hum starts in three days,
  // half under 3s), so in confirm mode the edge only MUTES the loop; the STT
  // verdict unmutes (phantom) or stops (speech). Legacy mode keeps the cut.
  if (BARGE_CONFIRM) muteEarcon(); else stopEarcon();
  if (!BARGE_CONFIRM) {
    ackGeneration++;
    if (pendingAck) { try { fs.unlinkSync(pendingAck.wav); } catch { /* */ } pendingAck = null; }
    // Multi-speak: the user talking over a queued monologue means they've
    // moved on — its unspoken tail must not resume after their new question.
    if (replyQueue.length) { log(`[reply] dropped ${replyQueue.length} queued — user is speaking`); replyQueue = []; }
  }
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const chunks = [];
  let finalized = false;
  let monitor = null;
  let captureWatchdog = null;

  // Single idempotent end-of-utterance path — fires from whichever endpointer
  // wins: the fixed-silence AfterSilence 'end' (default / fallback) or, when
  // enabled, an early VAD endpoint. The `finalized` guard makes double-fire a
  // no-op, so the two mechanisms coexist safely.
  const finalize = async (reason) => {
    if (finalized) return;
    finalized = true;
    if (captureWatchdog) clearTimeout(captureWatchdog);
    if (monitor) { try { monitor.close(); } catch { /* */ } }
    // The VAD path ends early and the watchdog ends a stream that may never
    // end on its own — both must free the subscription so the next utterance
    // can re-capture immediately. The natural 'silence' end has already
    // closed it.
    if (reason === 'vad' || reason === 'watchdog') { try { opus.destroy(); } catch { /* */ } }
    // Capture ends at the ENDPOINT, not after delivery. While `capturing`
    // held through STT+judge+delivery, a speaking edge landing in that
    // window was ignored and nothing re-fired when it cleared — the whole
    // utterance was lost (live 2026-08-16: session-start turns eaten behind
    // junk-blob processing). Only the pipeline needs one-at-a-time
    // semantics; turnChain runs it in arrival order with the mic free.
    capturing = false;
    const pcm = Buffer.concat(chunks);
    const run = turnChain.then(() => processTurn(pcm, reason));
    turnChain = run.catch((e) => log('[turn] process err', e.message));
    return run;
  };

  const processTurn = async (pcm, reason) => {
    {
      const secs = pcm.length / (48000 * 2 * 2);
      if (secs < MIN_SEC) {
        log(`[recv] ${secs.toFixed(2)}s too short`);
        if (BARGE_CONFIRM && ackCancels === priorCancels && !capturing) { ackArmedAt = priorArmedAt; ackedThisTurn = priorAcked; unmuteEarcon(); }
        else if (!capturing) stopEarcon();   // turn cancelled mid-capture: nothing is owed
        restorePlayback(); return;
      }
      // Arm the "still thinking" ack at end-of-speech — BEFORE STT — so the quick
      // acknowledgement overlaps STT + brain time instead of waiting them out.
      // LOCAL_ACK arms too: its fire gate reads ackArmedAt even when the canned
      // tier is configured off.
      // Never arm while a NEW capture is rolling: the user is already talking
      // again, so there is no dead air for a filler to cover — firing one
      // would talk over them (entry-mute already happened; this arm would
      // undo it).
      if ((ACK_AFTER_MS || LOCAL_ACK) && !capturing) { ackArmedAt = Date.now(); ackedThisTurn = false; }
      const wav = path.join(TMPDIR, `utt_${utcTs()}.wav`);
      await pcmToWav(pcm, wav);
      presenceUtterances++;
      log(`[recv] ${secs.toFixed(1)}s -> STT (${reason})`);
      const text = (await runCmd([...STT_CMD, wav], (CFG.stt && CFG.stt.env) || {})).trim();
      // Enrollment collects the AUDIO of utterances that pass the same
      // quality checks as real turns (non-empty STT = actual speech).
      const enrolling = SPEAKER_ENROLL && enrollNeeded();
      if (enrolling && text && !isNoise(text)) {
        try {
          fs.mkdirSync(SPEAKER_ENROLL.enrollDir, { recursive: true });
          fs.copyFileSync(wav, path.join(SPEAKER_ENROLL.enrollDir, `sample_${utcTs()}.wav`));
        } catch (e) { log('[enroll] sample copy err', e.message); }
      }
      fs.unlink(wav, () => {});
      // Dropped utterance -> no dispatch -> no reply will ever come. Disarm the
      // ack or it would fire and promise a reply that never arrives.
      if (!text || isNoise(text)) {
        // Phantom: give back the wait state this capture muted at start — the
        // previous turn's promise (ack arm + earcon gate) is still owed —
        // UNLESS an authoritative cancel landed mid-capture (aside verdict,
        // reply played, delivery failure): that promise is settled, stay dead.
        if (BARGE_CONFIRM && ackCancels === priorCancels && !capturing) { ackArmedAt = priorArmedAt; ackedThisTurn = priorAcked; unmuteEarcon(); }
        else { ackArmedAt = 0; if (!capturing) stopEarcon(); }
        log(`[stt] drop: "${text}"`); restorePlayback(); return;
      }
      log(`[stt] "${text}"`);
      stopEarcon();   // a real turn arrived — the previous turn's hum is over
      // Real speech: NOW commit the turn-boundary resets deferred at capture
      // start — interrupt playback and queued tail, invalidate the previous
      // turn's in-flight ack, drop any held content-ack as stale.
      if (BARGE_CONFIRM) {
        if ((botSpeaking || ducked) && !bargeWorthy(text)) {
          // Deliver it, but a hallucination-length transcript can't cut
          // audio: restore the duck and keep the queued tail playing.
          log('[barge] transcript too short to confirm — playback continues');
          restorePlayback();
        } else {
          confirmBarge();
        }
        ackGeneration++;
        if (pendingAck) { try { fs.unlinkSync(pendingAck.wav); } catch { /* */ } pendingAck = null; }
      }
      if (enrolling) {
        // Enrollment turns never reach a brain — content is discarded.
        log(`[enroll] sample ${countEnrollSamples()}/${SPEAKER_ENROLL.utterances}`);
        cancelAck();   // no reply is coming; a "still thinking" filler would lie
        enrollTurn().catch((e) => log('[enroll] err', e.message));
        return;
      }
      if (SEMANTIC) {
        let full = text;
        if (pendingUtterance) {   // this utterance continues a held one
          clearTimeout(pendingUtterance.timer);
          full = `${pendingUtterance.text} ${text}`;
          pendingUtterance = null;
          log(`[semantic] joined continuation -> "${full.slice(0, 70)}"`);
        }
        if (looksIncomplete(full)) {
          log(`[semantic] holding — sounds unfinished: "...${full.slice(-40)}"`);
          const held = full;
          pendingUtterance = {
            text: held,
            timer: setTimeout(() => {
              if (!pendingUtterance || pendingUtterance.text !== held) return;
              pendingUtterance = null;
              log('[semantic] flush — no continuation came');
              deliverTranscript(held);
            }, SEMANTIC.holdMs),
          };
          return;
        }
        await deliverTranscript(full);
      } else {
        await deliverTranscript(text);
      }
    }
  };

  if (vadClient) {
    try {
      monitor = vadClient.createVadMonitor({
        sock: VAD_SOCK,
        header: {
          sample_rate: 48000, channels: 2,
          threshold: (VAD.threshold != null ? VAD.threshold : 0.5),
          neg_threshold: (VAD.negThreshold != null ? VAD.negThreshold : null),
          min_silence_ms: vadMinSilenceMs(),
          min_speech_ms: (VAD.minSpeechMs != null ? VAD.minSpeechMs : 150),
        },
        connectTimeoutMs: (VAD.connectTimeoutMs != null ? VAD.connectTimeoutMs : 500),
        onEndpoint: () => { log('[vad] endpoint -> ending utterance early'); finalize('vad'); },
        log,
      });
    } catch (e) { log('[vad] monitor init err', e.message); monitor = null; }
  }

  decoder.on('data', (c) => { if (finalized) return; chunks.push(c); if (monitor) monitor.feed(c); });
  opus.on('error', (e) => log('[recv] opus err', e.message));
  opus.pipe(decoder);
  opus.on('end', () => finalize('silence'));
  if (MAX_CAPTURE_MS > 0) {
    captureWatchdog = setTimeout(() => {
      log('[watchdog] capture exceeded max — force-finalizing');
      finalize('watchdog');
    }, MAX_CAPTURE_MS);
  }
}

// transport.out — deliver a transcript to the brain
async function sendTranscript(text) {
  recordTurn('user', text);
  if (T.type === 'command') {
    const reply = (await runCmd([...T.cmd], { VOICE_TRANSCRIPT: text })).trim();
    if (reply) enqueueReply(reply);
    else cancelAck();   // the brain finished with silence — nothing is coming; don't ack a reply that won't
  } else if (T.type === 'mcp') {
    // Tee first: when a router owns delivery (gateFile present) this file is
    // the ONLY copy of the utterance, and even ungated a notify failure must
    // not lose it.
    if (T.transcriptDir) {
      try { fs.writeFileSync(path.join(T.transcriptDir, `${utcTs()}.txt`), text); log('[out] -> transcriptDir (tee)'); }
      catch (e) { log('[tee] err', e.message); }
    }
    if (T.gateFile && fs.existsSync(T.gateFile)) {
      // A router owns this turn; its reply is expected via replyFile, so the
      // ack stays armed to cover the round trip.
      log('[mcp] gated — transcript teed only');
      return;
    }
    // Reply comes back via the `speak` tool (-> enqueueReply); the ack was
    // already armed at end-of-speech.
    try { await deliverInboundMcp(text); }
    catch (e) { log('[mcp] notify err', e.message); cancelAck(); }   // delivery failed -> no reply coming
  } else { // file
    fs.writeFileSync(path.join(T.transcriptDir, `${utcTs()}.txt`), text);
    log('[out] -> transcriptDir');
  }
}

// transport.in — a reply arrived; speak it. For 'file' transport we poll replyFile.
// Multi-speak FIFO: each speak-tool call (or transport reply) queues; the
// poller voices them strictly in order, one per poll pass. This is what lets
// a brain start talking before it has finished composing — send the first
// paragraph as its own speak call, keep composing, send the next. A new
// utterance from the user drops whatever is still queued (an interrupted
// monologue's tail must not resume after their next question).
function enqueueReply(text) { replyQueue.push(text); }
let replyQueue = [];
// Tier-1 local ack (see LOCAL_ACK): { wav, text } once dispatchLocalAck()
// succeeds, else null. Consumed by pollReply() exactly like pendingReply,
// just lower priority (see the two-clear there).
let pendingAck = null;
// Bumped on every new utterance (handleUtterance) so a dispatchLocalAck()
// call still in flight from a PREVIOUS turn can detect it's stale and
// discard its result instead of setting pendingAck late.
let ackGeneration = 0;

// Split a reply into speakable chunks at sentence boundaries, merged up to
// `max` chars (and hard-split if a single sentence still exceeds it). Pure +
// exported for the selftest; input order is preserved.
function splitSentences(text, max) {
  const cap = max || 240;
  const sentences = String(text)
    .replace(/([.!?])\s+/g, '$1\n')   // mark sentence enders
    .split(/[\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const parts = [];
  let cur = '';
  const flushOversize = () => {
    while (cur.length > cap) {
      let bp = cur.lastIndexOf(' ', cap);
      if (bp <= 0) bp = cap;
      parts.push(cur.slice(0, bp).trim());
      cur = cur.slice(bp).trim();
    }
  };
  for (const s of sentences) {
    if (!cur) cur = s;
    else if (cur.length + 1 + s.length <= cap) cur += ' ' + s;
    else { flushOversize(); parts.push(cur); cur = s; }
    flushOversize();
  }
  if (cur) parts.push(cur);
  return parts.filter(Boolean);
}

function ttsEnv() {
  const env = { ...((CFG.tts && CFG.tts.env) || {}) };
  if (SPEEDFILE) { try { env.VOICE_TTS_SPEED = fs.readFileSync(SPEEDFILE, 'utf8').trim(); } catch {} }
  return env;
}
async function synthWav(text) {
  const wav = path.join(TMPDIR, `reply_${utcTs()}.wav`);
  await runCmd([...TTS_CMD, text, wav], ttsEnv());
  if (!fs.existsSync(wav) || fs.statSync(wav).size < 100) return null;
  return wav;
}

// Tier-1 local ack (GPU Phase-2, opt-in via LOCAL_ACK). Calls a warm local
// Ollama model for a short, CONTENT-AWARE holding phrase, then synthesizes it
// via the same Piper path as every other reply (synthWav). Fire-and-forget
// from finalize() — NEVER awaited by the STT/transport path, and NEVER
// throws: any failure (Ollama unreachable/timeout, empty content, TTS
// failure) just means no local ack for this turn. Sets `pendingAck` only on
// full success; pollReply() picks it up on its next tick exactly like any
// other queued item (see the two-clear in pollReply's pendingReply branch).
//
// think:false is load-bearing, not cosmetic: Gemma 4 emits a hidden
// "thinking" field before "content" on /api/chat, and a bounded num_predict
// without think:false truncates mid-thinking, silently producing an EMPTY
// content string (found + fixed while benchmarking the local model on GPU;
// symptom: acks that synthesize zero-length audio).
async function dispatchLocalAck(text, myGeneration) {
  if (!LOCAL_ACK) return;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), LOCAL_ACK.timeoutMs);
  try {
    const resp = await fetch(`${LOCAL_ACK.ollamaHost}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({
        model: LOCAL_ACK.model,
        // History rides INSIDE the system message as labelled background, and
        // the newest utterance is the ONLY user message. As trailing chat
        // turns, the history IS what a 4B model responds to — acks came out
        // anchored on the topic from 1-2 turns earlier (CS, live 2026-08-30:
        // "sometimes gives me out of date info from 1-2 turns before").
        messages: [
          { role: 'system', content: LOCAL_ACK.systemPrompt + (recentTurns.length
            ? '\n\nBACKGROUND — earlier turns, oldest first. Topics here may already be'
              + ' finished; use them only to resolve references in the newest message, never'
              + ' as the thing to acknowledge, and never repeat an earlier filler.\n'
              + recentTurns.map((t) => `${t.role === 'assistant' ? 'Assistant' : 'User'}: ${t.text}`).join('\n')
              + '\n\nAcknowledge ONLY the newest user message — the next message is the one being answered.'
            : '') },
          { role: 'user', content: text },
        ],
        stream: false,
        think: false,
        options: { num_predict: LOCAL_ACK.numPredict },
      }),
    });
    if (!resp.ok) { log('[localAck] ollama http', resp.status); return; }
    const body = await resp.json();
    const ackText = ((body && body.message && body.message.content) || '').trim();
    if (!ackText) { log('[localAck] empty content'); return; }
    // Stale-turn guard: the user may have started a new utterance (generation
    // bumped, see handleUtterance) while this call was in flight — a late ack
    // for an old turn must never queue.
    if (myGeneration !== ackGeneration) { log('[localAck] discarded — stale turn'); return; }
    const wav = await synthWav(ackText);
    if (!wav) { log('[localAck] tts failed'); return; }
    // Re-check after the (also async) TTS step — the turn went stale, the real
    // reply already landed while we were synthesizing (voicing "let me check
    // that" AFTER the real answer arrived would read as broken), or the canned
    // tier already fired this turn's one allowed filler.
    if (myGeneration !== ackGeneration || replyQueue.length || ackedThisTurn) {
      try { fs.unlinkSync(wav); } catch { /* */ }
      log('[localAck] discarded — stale turn, reply pending, or ack already fired');
      return;
    }
    pendingAck = { wav, text: ackText };
    log(`[localAck] "${ackText}"`);
  } catch (e) {
    log('[localAck] err', (e && e.message) || String(e));
  } finally {
    clearTimeout(timer);
  }
}

// Plays a tier-1 local-ack WAV exactly like speakAck() plays a tier-0 fixed
// one — same botSpeaking discipline, same barge-in exposure (onSpeakingStart
// already stops whatever `player` is doing, so this inherits that for free).
async function speakLocalAck(ack) {
  if (!connected || !player) { try { fs.unlinkSync(ack.wav); } catch { /* */ } return; }
  botSpeaking = true;
  try { log(`[localAck] speaking "${ack.text}"`); await playResource(fs.createReadStream(ack.wav)); }
  finally { botSpeaking = false; markBotSpoke(); fs.unlink(ack.wav, () => {}); }
}

// Pre-render every ack phrase ONCE so firing the "still thinking" ack is an
// instant WAV playback, not a TTS round-trip on the very turn we're trying to
// make feel responsive. Kicked off at boot (sequentially — sub-second synths
// warm; possibly seconds each cold). Per-phrase readiness, deliberately NOT one
// batch promise: speakAck() must never block the reply poller waiting on
// still-rendering phrases (a reply could sit unread behind a stale filler).
// Slots: undefined = still rendering, string = ready wav, null = render failed.
let ackWavs = null;    // Array, index-aligned with ACK_PHRASES (null until prerenderAck runs)
let lastAckIdx = -1;   // last phrase spoken, so rotation never repeats back-to-back
function prerenderAck() {
  if (!ACK_AFTER_MS || ackWavs) return;
  ackWavs = new Array(ACK_PHRASES.length);
  (async () => {
    for (let i = 0; i < ACK_PHRASES.length; i++) {
      const out = path.join(TMPDIR, `ack_${i}.wav`);
      // Remove any previous boot's render FIRST — if this render fails, a stale
      // wav (possibly of a since-edited phrase) must not pass the check below.
      try { fs.unlinkSync(out); } catch { /* */ }
      try {
        await runCmd([...TTS_CMD, ACK_PHRASES[i], out], ttsEnv());
        ackWavs[i] = (fs.existsSync(out) && fs.statSync(out).size >= 100) ? out : null;
      } catch { ackWavs[i] = null; }
    }
    log(`[ack] pre-rendered ${ackWavs.filter(Boolean).length}/${ACK_PHRASES.length} phrases`);
  })();
}
// Pure (exported for the selftest): pick the next ack phrase index given a
// uniform random r in [0,1). Never returns lastIdx when there's a choice.
function pickAckIndex(count, lastIdx, r) {
  if (count <= 0) return -1;
  if (count === 1) return 0;
  if (lastIdx == null || lastIdx < 0 || lastIdx >= count) return Math.min(Math.floor(r * count), count - 1);
  let i = Math.min(Math.floor(r * (count - 1)), count - 2);   // draw from the others…
  if (i >= lastIdx) i++;                                       // …skipping over lastIdx
  return i;
}
async function speakAck() {
  if (!connected || !player) return;
  const idx = pickAckIndex(ACK_PHRASES.length, lastAckIdx, Math.random());
  if (idx < 0) return;
  const wav = ackWavs ? ackWavs[idx] : null;
  if (wav === undefined) { log('[ack] skipped — pre-render still warming'); return; }   // never stall the poller for a filler
  lastAckIdx = idx;
  const phrase = ACK_PHRASES[idx];
  if (wav && fs.existsSync(wav)) {
    botSpeaking = true;
    try { log(`[ack] "${phrase}"`); await playResource(fs.createReadStream(wav)); }
    finally { botSpeaking = false; markBotSpoke(); }
  } else {
    await speak(phrase);               // render failed earlier — synth on the fly (correct, just slower)
  }
}

// Pure predicate (exported for the selftest): is the "still thinking" ack due?
// afterMs<=0 disables it; armedAt is the end-of-speech time; acked one-shots it.
function ackDue(now, armedAt, acked, afterMs) {
  return afterMs > 0 && armedAt > 0 && !acked && (now - armedAt) >= afterMs;
}

// Pure predicate (exported): is the thinking earcon due? Only on a turn that
// already got its one ack (the earcon EXTENDS the ack, never replaces it),
// after the ack fire-point plus the earcon's own delay.
function earconDue(now, armedAt, acked, fireMs, afterMs) {
  return armedAt > 0 && acked && (now - armedAt) >= fireMs + afterMs;
}

// Pure predicate (exported): is the long-wait spoken notice due? Fires once
// per turn — firedFor remembers the armedAt value it last fired for.
function longWaitDue(now, armedAt, firedFor, afterMs) {
  return afterMs > 0 && armedAt > 0 && firedFor !== armedAt && (now - armedAt) >= afterMs;
}
let longWaitFiredFor = 0;

// The earcon deliberately does NOT claim botSpeaking: pollReply must keep
// accepting replies while it plays, and a landing reply (or ack of the next
// turn) preempts it via stopEarcon() + the player handoff. The loop replays
// the file until any exit condition trips; stopEarcon()'s player.stop()
// settles the in-flight playResource so the cut is immediate, not
// end-of-file.
let earconActive = false;
let earconMuted = false;   // confirm mode: a speaking edge silences the loop until STT's verdict
async function playEarconLoop() {
  if (earconActive || !EARCON) return;
  earconActive = true;
  const armedAtStart = ackArmedAt;
  const startedAt = Date.now();
  log('[earcon] start');
  try {
    // While muted the turn's arm is 0 (capture start clears it); keep looping
    // silently — the verdict either restores the arm or stops the loop.
    while (earconActive && connected && player && !botSpeaking
           && !replyQueue.length && (ackArmedAt === armedAtStart || earconMuted)) {
      if (Date.now() - startedAt >= EARCON.maxMs) {
        // A reply that never comes must not hum forever. Disarm the turn too,
        // or the due-check would restart the loop on the next poll tick.
        log(`[earcon] gave up — no reply after ${Math.round(EARCON.maxMs / 1000)}s`);
        cancelAck();
        break;
      }
      await playResource(fs.createReadStream(EARCON.file), EARCON.volume, { earcon: true });
    }
  } catch (e) { log('[earcon] err', e.message);
  } finally { earconActive = false; earconMuted = false; }
}
function stopEarcon() {
  earconMuted = false;
  if (!earconActive) return;
  earconActive = false;
  try { if (player) player.stop(); } catch { /* */ }
  log('[earcon] stop');
}
function muteEarcon() {
  if (!earconActive || earconMuted) return;
  earconMuted = true;
  try { if (currentRes && currentRes._earcon && currentRes.volume) currentRes.volume.setVolume(0); } catch { /* */ }
  log('[earcon] muted — speaking edge, verdict pending');
}
function unmuteEarcon() {
  if (!earconMuted) return;
  earconMuted = false;
  try {
    if (currentRes && currentRes._earcon && currentRes.volume) currentRes.volume.setVolume((currentRes._base || 1) * (ducked ? DUCK_FACTOR : 1));
  } catch { /* */ }
  log('[earcon] unmuted — phantom');
}

// WHERE A REPLY GOES WHEN NOBODY IS LISTENING (CS 20260829).
// "i had to go away from pc mid convo and left voice channel can you make sure if i leave
// and [the assistant] is expecting to use voice it makes the switch if im not there".
// Until now speak() logged "dropping reply" and returned — the answer was synthesized into
// an empty room and lost, with nothing anywhere saying so. Discord is the fallback because
// it is the channel CS actually reads when away from the machine.
//
// THE LOOP DOES THE REDIRECT, not its caller. Returning "nobody heard that" would make
// delivery depend on the caller noticing and acting — which is precisely the pattern that
// left ten RC envelopes unclaimed for five days in the sibling system.
let VOICE_FALLBACK_CHANNEL = (CFG.voiceFallback && CFG.voiceFallback.channelId) || null;

// Files that name the session voice is currently routed to, newest wins. Read at POST
// time, never cached: a route can be set, switched or cleared between two replies, and a
// stale name is worse than none -- it credits the wrong session.
// Best-effort by construction: any failure yields null and the unattributed banner, which
// is exactly today's behaviour. This must never be able to block a fallback post, because
// the fallback IS the last resort ([[a gate on the only channel is a mute button]]).
const SPEAKER_ROUTE_FILES = (CFG.voiceFallback && CFG.voiceFallback.speakerRouteFiles) || [];
function routedSpeakerName() {
  for (const f of SPEAKER_ROUTE_FILES) {
    try {
      const r = JSON.parse(fs.readFileSync(f, 'utf8'));
      const n = r && (r.name || r.rc_name || r.tmux);
      if (n) return String(n).slice(0, 64);
    } catch { /* absent or malformed -> no attribution, never an error */ }
  }
  return null;
}
const DISCORD_MAX = 1900;   // 2000 hard cap; leave room for the prefix
async function fallbackPost(text, why) {
  if (!VOICE_FALLBACK_CHANNEL) { log(`[tts] ${why} — dropping reply (no voiceFallback.channelId configured)`); return false; }
  try {
    const ch = await client.channels.fetch(VOICE_FALLBACK_CHANNEL);
    if (!ch || typeof ch.send !== 'function') { log('[tts] fallback channel not sendable'); return false; }
    // Attribute the reply to whoever actually produced it. When CS has routed voice to
    // another session, main is only RELAYING — a bare redirect reads as if the default
    // assistant said it,
    // and with several sessions reachable CS cannot tell who answered (CS 20260829: "and
    // replies as the session that made the response?"). Speech does not need this: CS
    // knows who they asked. Only the text path, which they read later out of context, does.
    const who = routedSpeakerName();
    const banner = who
      ? `🔇 *(from **${who}** — you were not in the voice channel, so this is here instead)*`
      : '🔇 *(you were not in the voice channel, so this is here instead)*';
    const body = `${banner}\n${text}`;
    for (let i = 0; i < body.length; i += DISCORD_MAX) {
      // eslint-disable-next-line no-await-in-loop
      await ch.send(body.slice(i, i + DISCORD_MAX));
    }
    log(`[tts] ${why} — redirected reply to Discord ${VOICE_FALLBACK_CHANNEL}`);
    return true;
  } catch (e) {
    log('[tts] fallback post FAILED', e && e.message);
    return false;
  }
}

async function speak(text) {
  // Two distinct "nobody is listening" states, both of which used to drop silently: the bot
  // is not in the channel at all, and the bot is in it but CS has left.
  if (!connected || !player) { recordTurn('assistant', text); await fallbackPost(text, 'not in channel'); return; }
  if (PRESENCE_FILE !== null && !presenceActive) { recordTurn('assistant', text); await fallbackPost(text, 'user not in channel'); return; }
  recordTurn('assistant', text);
  if (TTS_PIPE && text.length >= TTS_PIPE_MIN_CHARS) {
    const parts = splitSentences(text, TTS_PIPE_MAX_CHUNK);
    if (parts.length > 1) return speakPipelined(parts);
  }
  return speakSingle(text);
}

async function speakSingle(text) {
  botSpeaking = true;
  try {
    log(`[tts] "${text.slice(0, 70)}"`);
    const wav = await synthWav(text);
    if (!wav) { log('[tts] empty wav'); return; }
    await playResource(fs.createReadStream(wav));
    fs.unlink(wav, () => {});
  } finally { botSpeaking = false; markBotSpoke(); }
}

// Synthesize chunk N+1 while chunk N plays, then play chunks in order — so
// time-to-first-audio is one sentence, not the whole reply. Barge-in (which
// clears botSpeaking and stops the player) aborts the remaining chunks; any
// already-started synth is drained + cleaned up in the finally.
async function speakPipelined(parts) {
  botSpeaking = true;
  log(`[tts] pipelined ${parts.length} chunks: "${parts[0].slice(0, 50)}"`);
  let nextSynth = synthWav(parts[0]);
  try {
    for (let i = 0; i < parts.length; i++) {
      const wav = await nextSynth;
      nextSynth = (i + 1 < parts.length) ? synthWav(parts[i + 1]) : null;
      if (!botSpeaking) { if (wav) fs.unlink(wav, () => {}); break; }   // barge-in before this chunk
      if (wav) { await playResource(fs.createReadStream(wav)); fs.unlink(wav, () => {}); }
      if (!botSpeaking) break;                                          // barge-in during this chunk
    }
  } finally {
    if (nextSynth) { try { const w = await nextSynth; if (w) fs.unlink(w, () => {}); } catch { /* */ } }
    botSpeaking = false;
    markBotSpoke();
  }
}
// Playback ducking (BARGE_CONFIRM) — currentRes tracks whatever is playing so
// a duck lands mid-chunk, and a NEW resource inherits the duck (a phantom can
// straddle a pipelined chunk boundary; the volume must not pop back between
// chunks while a verdict is pending).
let currentRes = null, ducked = false, duckTimer = null;
// How far the duck drops playback. 0.3 (a 70% cut) makes a FALSE duck genuinely hard to
// listen through, and in a noisy room false ducks are the common case, not the rare one —
// CS, 20260829, working in the lab: "it's kind of dimming the speaking voice, it makes it
// hard to hear". The duck only has to be enough to hear over; it is not a mute.
const DUCK_FACTOR = CFG.duckFactor != null ? CFG.duckFactor : 0.3;
// SUSTAIN GATE (CS 20260829). The duck used to fire on the speaking-start EDGE — Discord's
// event, which trips on any mic activity including a door, a centrifuge or a chair. The
// speaker gate and the >=bargeMinWords test both reject that noise correctly, but only
// AFTER the audio has already dimmed, so the reject is silent and the dimming is not.
// Requiring the speech to persist costs a real interrupt this many ms of full-volume
// overlap and costs a noise blob nothing at all, because short blobs never reach the timer.
// 0 restores the old edge-triggered behaviour.
const DUCK_AFTER_MS = CFG.duckAfterMs != null ? CFG.duckAfterMs : 350;
function duckPlayback() {
  if (ducked || !currentRes || !currentRes.volume) return;
  ducked = true;
  try { currentRes.volume.setVolume((currentRes._base || 1) * DUCK_FACTOR); } catch { /* */ }
  log('[barge] duck — confirming speech before interrupting');
}
// Arm the duck behind the sustain gate. `capturing` is the evidence that the speech is still
// going when the timer fires; a blob that already ended never ducks at all.
function armDuck() {
  if (ducked || duckTimer) return;
  if (!DUCK_AFTER_MS) { duckPlayback(); return; }
  duckTimer = setTimeout(() => {
    duckTimer = null;
    if (capturing && botSpeaking) duckPlayback();
    else log('[barge] speech did not sustain — no duck');
  }, DUCK_AFTER_MS);
}
function cancelArmedDuck() {
  if (duckTimer) { clearTimeout(duckTimer); duckTimer = null; }
}
function restorePlayback() {
  cancelArmedDuck();
  if (!ducked) return;
  ducked = false;
  try { if (currentRes && currentRes.volume) currentRes.volume.setVolume(currentRes._base || 1); } catch { /* */ }
  log('[barge] false alarm — volume restored');
}
function confirmBarge() {
  cancelArmedDuck();
  const hadPlayback = botSpeaking || ducked;
  ducked = false;
  if (hadPlayback) {
    log('[barge] confirmed — interrupting playback');
    try { if (player) player.stop(true); } catch { /* */ }
    botSpeaking = false;
    // Interrupted speech still counts as recent assistant speech: the very
    // utterance that confirmed this barge is addressed to the assistant, and
    // it reaches the address gate AFTER this — the stamp keeps it hot.
    markBotSpoke();
  }
  if (replyQueue.length) { log(`[reply] dropped ${replyQueue.length} queued — user is speaking`); replyQueue = []; }
}
function playResource(stream, volume, opts) {
  return new Promise((resolve) => {
    const res = createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
    res._base = volume || 1;
    res._earcon = !!(opts && opts.earcon);
    const gain = res._base * (ducked ? DUCK_FACTOR : 1) * (res._earcon && earconMuted ? 0 : 1);
    try { if (res.volume) res.volume.setVolume(gain); } catch { /* */ }
    currentRes = res;
    let settled = false;
    const done = () => {
      if (settled) return; settled = true;
      clearTimeout(safety); player.off('stateChange', onState); player.off('error', onErr);
      if (currentRes === res) currentRes = null;
      resolve();
    };
    // Settle on ANY arrival at a terminal state — not just the playing->idle edge.
    // Barge-in stop during buffering, a decode error on a bad WAV, or a connection
    // autopause would otherwise never resolve this promise and would wedge
    // botSpeaking=true forever (bot goes deaf + mute until restart).
    const onState = (o, n) => { if (n.status === 'idle' || n.status === 'autopaused') done(); };
    const onErr = (e) => { log('[player] err', e.message); done(); };
    const safety = setTimeout(() => { log('[tts] playback safety timeout'); done(); }, PLAY_TIMEOUT_MS);
    player.on('stateChange', onState); player.on('error', onErr);
    player.play(res);
  });
}

// A configured replyFile is a voice source on ANY transport: whatever writes
// it becomes the voice (the file transport's documented contract, and in mcp
// deployments the seam a router or ssh-brain-shuttle pull-loop speaks
// through). Returns the raw text, or null when unconfigured/absent/unreadable.
function readReplyFile() {
  if (!T.replyFile) return null;
  try {
    if (!fs.existsSync(T.replyFile)) return null;
    const raw = fs.readFileSync(T.replyFile, 'utf8');
    fs.unlinkSync(T.replyFile);
    return raw;
  } catch (e) { log('[reply] file err', e.message); return null; }
}

function pollReply() {
  try {
    if (!botSpeaking) {
      if (!connected) {
        // Not in the channel — nobody to hear a reply, a local ack, or a fixed
        // ack. Drain anything queued so it can't go stale and surface on a
        // later join, but don't synthesize.
        cancelAck();
        stopEarcon();
        if (replyQueue.length) { log(`[reply] dropped ${replyQueue.length} queued — not in channel`); replyQueue = []; }
        if (pendingAck) { try { fs.unlinkSync(pendingAck.wav); } catch {} log('[localAck] dropped — not in channel'); pendingAck = null; }
        if (readReplyFile() !== null) log('[reply] dropped file — not in channel');
        setTimeout(pollReply, 300); return;
      }
      if (replyQueue.length) {
        // One queue item per pass: playback serializes on botSpeaking, and
        // draining here would re-batch what multi-speak deliberately split.
        stopEarcon();   // instant cut — the real answer preempts the ambient loop
        const t = cleanForTTS(replyQueue.shift()); cancelAck();
        // Two-clear: a real reply landing means any not-yet-played tier-1
        // local ack is now stale (voicing "let me check that" AFTER the real
        // answer already arrived would read as broken) — drop it same as the
        // fixed-ack arm just above.
        if (pendingAck) { try { fs.unlinkSync(pendingAck.wav); } catch {} pendingAck = null; }
        if (t) { speak(t).finally(() => setTimeout(pollReply, 200)); return; }
      }
      if (pendingAck) {
        if (ackedThisTurn) {
          // One filler per turn: the canned tier already fired — a late local
          // ack must not stack a second one behind it.
          try { fs.unlinkSync(pendingAck.wav); } catch { /* */ } pendingAck = null;
        } else if (ackDue(Date.now(), ackArmedAt, ackedThisTurn, ACK_FIRE_MS || ACK_AFTER_MS)) {
          const ack = pendingAck; pendingAck = null; ackedThisTurn = true;
          speakLocalAck(ack).finally(() => setTimeout(pollReply, 200)); return;
        }
        // Ready but not yet due: hold it — a fast reply may still make it moot.
      }
      {
        // Whatever writes replyFile becomes the voice — including unsolicited
        // lines (a router announcing a route change, a shuttle-pulled remote
        // reply). The writer owns the file; if it doesn't want text voiced,
        // it doesn't write it here. `speak`-tool replies (pendingReply, above)
        // win a same-pass race, which is the right priority unrouted.
        const raw = readReplyFile();
        if (raw !== null) {
          stopEarcon();
          cancelAck();
          // Same two-clear as the pendingReply branch: a routed reply landing
          // makes an unplayed local ack stale (and orphaned its wav before
          // this was added — see the fire-gate redesign).
          if (pendingAck) { try { fs.unlinkSync(pendingAck.wav); } catch { /* */ } pendingAck = null; }
          const t = cleanForTTS(raw); if (t) { speak(t).finally(() => setTimeout(pollReply, 200)); return; }
        }
      }
      // With LOCAL_ACK on, the canned tier shares the fire point and runs as
      // the fallback: the pendingAck branch above is checked first in the same
      // pass, so a ready content-aware ack always wins the moment.
      if (ackDue(Date.now(), ackArmedAt, ackedThisTurn, ACK_FIRE_MS || ACK_AFTER_MS)) {
        ackedThisTurn = true; speakAck().finally(() => setTimeout(pollReply, 200)); return;
      }
      // Reply STILL cooking after the notice window — say so, once per turn.
      // speak() claims botSpeaking and stamps lastBotSpeechEndedAt itself;
      // the earcon due-check below resumes the hum on a later pass.
      if (LONG_WAIT && longWaitDue(Date.now(), ackArmedAt, longWaitFiredFor, LONG_WAIT.afterMs)) {
        longWaitFiredFor = ackArmedAt;
        stopEarcon();
        const who = routedSpeakerName() || LONG_WAIT.who;
        const li = pickAckIndex(LONG_WAIT.phrases.length, longWaitLastIdx, Math.random());
        longWaitLastIdx = li;
        log(`[longwait] notice — reply still pending (waiting on ${who})`);
        speak(renderLongWaitPhrase(LONG_WAIT.phrases[li], who)).finally(() => setTimeout(pollReply, 200)); return;
      }
      // Ack fired, reply still cooking — fill the silence with the ambient
      // loop (fire-and-forget: the poller keeps ticking, and any reply branch
      // above cuts it on its next pass).
      if (EARCON && !earconActive
          && earconDue(Date.now(), ackArmedAt, ackedThisTurn, ACK_FIRE_MS || ACK_AFTER_MS, EARCON.afterMs)) {
        playEarconLoop();
      }
    }
  } catch (e) { log('[reply] err', e.message); }
  setTimeout(pollReply, 300);
}
function pollPlayWav() {
  if (!PLAYWAV) return;
  try {
    if (connected && player && !botSpeaking && fs.existsSync(PLAYWAV)) {
      const wav = fs.readFileSync(PLAYWAV, 'utf8').trim(); fs.unlinkSync(PLAYWAV);
      if (wav && fs.existsSync(wav)) { botSpeaking = true; playResource(fs.createReadStream(wav)).finally(() => { botSpeaking = false; setTimeout(pollPlayWav, 200); }); return; }
    }
  } catch (e) { log('[playwav] err', e.message); }
  setTimeout(pollPlayWav, 400);
}

// MCP inbound delivery — how a spoken turn reaches the brain. v1 implements the
// 'channel' mode (Claude Code / channel-aware hosts get a notifications/claude/
// channel event). This switch is the seam for GENERIC MCP-host support: a future
// 'tool'/'sampling' mode plugs in here (see docs/ARCHITECTURE.md "Extending to
// generic MCP hosts") without touching the rest of the loop. Unimplemented modes
// fail loudly rather than silently no-op.
async function deliverInboundMcp(text) {
  const mode = (T.deliver || 'channel');
  if (mode === 'channel') {
    await mcpServer.notification({
      method: 'notifications/claude/channel',
      params: { content: text, meta: { source: T.source || 'voice', ts: new Date().toISOString() } },
    });
    log('[out] -> mcp channel');
    return;
  }
  // --- extension point: any-host inbound delivery (not implemented in v1) ---
  throw new Error(`transport.deliver='${mode}' not implemented (v1 supports 'channel')`);
}

// transport.type === 'mcp': stand up an MCP stdio server so the loop IS the
// bridge to the brain. Speech -> `notifications/claude/channel` (arrives as
// <channel source="...">); reply <- `speak` tool -> enqueueReply -> playback.
// SDK is ESM-only; import dynamically (this file is CommonJS under bun).
async function initMcp() {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
  const source = T.source || 'voice';
  mcpServer = new Server(
    { name: source, version: require('../package.json').version },
    {
      capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
      instructions:
        `Events from \`${source}\` are the user speaking in a Discord voice channel, arriving ` +
        `as <channel source="${source}" ...>. Reply by calling the \`speak\` tool with your reply ` +
        `text — that voices it back in the channel. ONLY call speak in response to a ${source} ` +
        `channel message (a spoken turn); never voice terminal- or other-channel turns.`,
    }
  );
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
      name: 'speak',
      description: 'Speak a reply aloud in the Discord voice channel (text-to-speech). Use only to answer a voice-channel (spoken) turn. Calls queue and play in order, so for a long answer call speak with the first paragraph IMMEDIATELY and keep composing — speech starts while you write the rest. If the user speaks again before a queued part plays, it is dropped (they moved on).',
      inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'The reply text to voice.' } }, required: ['text'] },
    }],
  }));
  mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== 'speak') return { isError: true, content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }] };
    const text = String((req.params.arguments && req.params.arguments.text) || '').trim();
    if (!text) return { isError: true, content: [{ type: 'text', text: 'speak: empty text' }] };
    enqueueReply(text);
    return { content: [{ type: 'text', text: 'queued for speech' }] };
  });
  await mcpServer.connect(new StdioServerTransport());
  log('[mcp] server connected (stdio), source=' + source);
  // THE HOST DYING IS A SHUTDOWN SIGNAL. Our stdin is the host's end of the
  // stdio pair; when the host exits — cleanly or not — it closes, and we read
  // EOF. The SDK transport listens for 'data' and 'error' only, never 'end',
  // so nothing reacted: the orphan kept the singleton pidfile AND the voice
  // gateway, and every replacement spawn from the host's successor was refused
  // as a duplicate (live 2026-08-30 — the voice channel was unreachable
  // until the orphan was killed by hand). Treat EOF exactly like SIGTERM.
  process.stdin.on('end', () => shutdown('stdin EOF (host gone)'));
  process.stdin.on('close', () => shutdown('stdin closed (host gone)'));
}

let client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

// Fire a config-defined side-effect command (e.g. warm/spin-down the STT/TTS
// servers) DETACHED and non-blocking. Presence-gating's whole payoff is that
// model warm-up overlaps the human gap between joining voice and the first
// word — so this must never block the join.
function runHook(hook, label) {
  if (!hook || !Array.isArray(hook.cmd) || !hook.cmd.length) return;
  try {
    const child = spawn(hook.cmd[0], hook.cmd.slice(1), { env: { ...process.env, ...(hook.env || {}) }, stdio: 'ignore', detached: true });
    child.on('error', (e) => log(`[hook:${label}] err`, e.message));
    child.unref();
    log(`[hook:${label}]`, hook.cmd.join(' '));
  } catch (e) { log(`[hook:${label}] spawn err`, e.message); }
}

// The Discord-touching half of the lifecycle, isolated behind `io` so the
// join/leave/idle-timer state machine can be exercised without a live gateway.
async function realConnect() {
  const guild = await client.guilds.fetch(GUILD);
  conn = joinVoiceChannel({ channelId: CHANNEL, guildId: GUILD, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
  conn.on('stateChange', (o, n) => log(`[conn] ${o.status}->${n.status}`));
  // A mid-session voice drop (region move, brief net blip) otherwise leaves a dead
  // connection with connected=true — replies synthesize into a player that never
  // plays and playback hangs. Try to ride out the drop; if it doesn't resume, tear
  // down so presence-gating (or the next start) can rejoin cleanly.
  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(conn, VoiceConnectionStatus.Signalling, 5000),
        entersState(conn, VoiceConnectionStatus.Connecting, 5000),
      ]);
      log('[conn] disconnected — resuming');
    } catch {
      log('[conn] disconnected — tearing down');
      try { conn.destroy(); } catch {}
      conn = null; player = null; connected = false; botSpeaking = false; capturing = false; cancelAck();
      // If the user is still sitting in the channel, no new join edge will ever
      // arrive to re-trigger presence-gated entry — attempt one rejoin ourselves.
      // Legacy (autoJoin=false) sessions are expected to stay in channel, so they
      // always retry. A failed attempt logs and waits for the next presence edge.
      if (presenceActive || !AUTO_JOIN) {
        setTimeout(() => { enterChannel('reconnect after drop').catch(() => {}); }, 2000);
      }
    }
  });
  await entersState(conn, VoiceConnectionStatus.Ready, 20000);
  player = createAudioPlayer(); player.on('error', (e) => log('[player] err', e.message));
  conn.subscribe(player);
  conn.receiver.speaking.on('start', onSpeakingStart);
}
function realDisconnect() {
  if (conn) { try { conn.destroy(); } catch (e) { log('[conn] destroy err', e.message); } }
  conn = null; player = null;
}
const io = { connect: realConnect, disconnect: realDisconnect };

function onSpeakingStart(userId) {
  if (ALLOWED && userId !== ALLOWED) return gateDrop('speaker is not the allowed user');
  presenceEdges++;                   // Discord DID tell us they spoke — count before any gate
  if (!conn || !connected) return gateDrop('no live connection (teardown/reconnect)');
  if (botSpeaking && BARGE_IN) {
    if (BARGE_CONFIRM) {
      // Duck, don't die: keep playing quietly and capture in parallel —
      // finalize()'s STT verdict either confirms (real interrupt) or
      // restores the volume (phantom). Armed behind the sustain gate so a
      // noise blob never dims the reply in the first place.
      armDuck();
    } else {
      // Classic barge-in: the user started talking while we were speaking.
      // Stop playback immediately.
      log('[barge] user spoke during playback — interrupting');
      try { player.stop(true); } catch {}
      botSpeaking = false;
    }
  }
  if (capturing) {
    // A speaking edge during an ACTIVE capture is redundant — the open
    // subscription is already receiving this audio. (Edges during
    // post-capture processing no longer land here: `capturing` frees at the
    // endpoint and the new capture queues behind turnChain.)
    log('[recv] busy — edge during active capture (audio already flowing)');
    return;
  }
  if (botSpeaking && !BARGE_CONFIRM) return gateDrop('bot speaking, barge-in off');
  handleUtterance(userId, conn.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: endSilenceMs() } }));
}

// Join the voice channel (idempotent). Fires the presence-enter hook first so
// model warm-up runs concurrently with the seconds-long voice handshake.
async function enterChannel(reason) {
  clearLeaveTimer();                    // a (re)join always cancels a pending idle-leave
  if (connected || connecting) return;
  connecting = true;
  runHook(CFG.onPresenceEnter, 'enter');
  try {
    await io.connect();
    connected = true;
    log(`[loop] joined voice channel ${CHANNEL} (${reason})`);
    if (enrollNeeded()) {
      // First-run (or resumed) enrollment: greet once the join settles.
      setTimeout(() => {
        if (!connected || !enrollNeeded()) return;
        const n = countEnrollSamples();
        speak(n ? `Let us keep setting up your voiceprint. ${ENROLL_PROMPTS[Math.min(n - 1, ENROLL_PROMPTS.length - 1)]}` : ENROLL_INTRO)
          .catch((e) => log('[enroll] intro err', e.message));
      }, 1200);
    }
  } catch (e) {
    // Stay alive on a failed join — in mcp mode this process is the session's
    // MCP server, so a transient voice hiccup must not take it (and the tool) down.
    log('[enter] join failed:', e.message);
    io.disconnect(); connected = false; botSpeaking = false; capturing = false;
  } finally { connecting = false; }
}

// Leave the voice channel and fire the presence-leave hook (e.g. reclaim warm-
// server RAM). Resets transient speaking/capturing state.
function leaveChannel(reason) {
  clearLeaveTimer();
  io.disconnect();
  connected = false; botSpeaking = false; capturing = false; cancelAck(); ackedThisTurn = false;
  log(`[loop] left voice channel (${reason})`);
  runHook(CFG.onPresenceLeave, 'leave');
}

function clearLeaveTimer() { if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; } }
// Arm the idle-leave timer: after the user leaves, wait IDLE_LEAVE_MS, then
// leave only if they haven't come back (a quick rejoin cancels it, so we don't
// thrash the connection or the warm servers).
function scheduleLeave() {
  clearLeaveTimer();
  leaveTimer = setTimeout(() => {
    leaveTimer = null;
    if (presenceActive) { log('[leave] canceled — user present at timeout'); return; }
    leaveChannel('idle timeout');
  }, IDLE_LEAVE_MS);
  log(`[leave] scheduled in ${Math.round(IDLE_LEAVE_MS / 1000)}s`);
}

// Presence transition -> lifecycle action (extracted so it's directly drivable
// in the selftest without a gateway).
function handleVoiceState(nowIn, wasIn, uid) {
  if (nowIn && !wasIn) {
    setPresence(true); log(`[presence] ${uid} joined`);
    if (AUTO_JOIN) enterChannel('user joined');
  } else if (!nowIn && wasIn) {
    setPresence(false); log(`[presence] ${uid} left`);
    if (AUTO_JOIN) scheduleLeave();
  }
}

client.on('voiceStateUpdate', (oldS, newS) => {
  const uid = (newS && newS.id) || (oldS && oldS.id);
  if (ALLOWED && uid !== ALLOWED) return;   // track only the allowed user
  const nowIn = !!(newS && newS.channelId === CHANNEL);
  const wasIn = !!(oldS && oldS.channelId === CHANNEL);
  handleVoiceState(nowIn, wasIn, uid);
});

async function onReady() {
  log(`[loop] logged in as ${client.user.tag}`);
  // Initialize presence from who's already in the channel at startup, so a
  // restart while the user is connected doesn't lose their presence.
  let presentAtStart = false;
  try {
    const ch = await client.channels.fetch(CHANNEL);
    presentAtStart = !!(ch && ch.members && (ALLOWED ? ch.members.has(ALLOWED) : ch.members.some((m) => !m.user.bot)));
  } catch (e) { log('[presence] init err', e.message); }
  setPresence(presentAtStart);
  log(`[presence] init: allowed user ${presentAtStart ? 'PRESENT' : 'absent'}`);

  // Reply/playback pollers run regardless of connection — they self-gate on
  // `connected`, so they're safe to start before (or without) a join.
  pollReply(); pollPlayWav();
  prerenderAck();   // warm the fixed ack phrase now so the first one is instant

  if (!AUTO_JOIN) {
    await enterChannel('startup');                    // legacy: sit in the channel all session
  } else if (presentAtStart) {
    await enterChannel('present at startup');          // presence-gated, but user already here
  } else {
    log('[loop] idle — gateway listening, will join when the user enters voice');
  }
  log('[loop] LIVE');
}
let started = false;
const boot = () => { if (started) return; started = true; onReady().catch((e) => log('[ready] err', e.message)); };
client.once('clientReady', boot); client.once('ready', boot);
client.on('error', (e) => log('[client] err', e.message));
// Last-resort guards: in mcp mode this process IS the session's MCP server, so an
// uncaught throw must not silently kill the `speak` tool. Log (to stderr in mcp
// mode via log()) and keep running.
// Opus WASM heap corruption: one bad decode poisons opusscript's shared WASM
// instance and EVERY later decode throws "Out of bounds memory access" — the
// loop is deaf until process restart (live 2026-08-13 and 2026-08-16, a
// 143-crash storm). Recovery: drop the poisoned modules from the require
// cache and re-require — a fresh WASM instance with a clean heap. Decoders
// are created per capture, so the next capture picks up the new module.
let opusCrashTimes = [];
function noteOpusCrash(err) {
  const msg = String((err && err.message) || err);
  if (!/out of bounds|memory access|unreachable/i.test(msg)) return false;
  if (!/opus/i.test(msg + String((err && err.stack) || ''))) return false;
  const now = Date.now();
  opusCrashTimes = opusCrashTimes.filter((t) => now - t < 60000);
  opusCrashTimes.push(now);
  if (opusCrashTimes.length < 3) return false;
  opusCrashTimes = [];
  reloadOpus();
  return true;
}
function reloadOpus() {
  for (const k of Object.keys(require.cache || {})) {
    if (/prism-media|opusscript/.test(k)) delete require.cache[k];
  }
  prism = require('prism-media');
  log('[fatal] opus WASM heap corrupted — reloaded decoder module (fresh WASM instance)');
}
process.on('uncaughtException', (e) => {
  log('[fatal] uncaughtException', (e && e.stack) || e);
  // Bound the blast radius: a crash mid-capture or mid-playback must not
  // leave the loop deaf (capturing stuck) or mute (botSpeaking stuck) — the
  // watchdog would eventually clear a capture, but a crash we SAW deserves an
  // immediate reset.
  capturing = false; botSpeaking = false; stopEarcon();
  noteOpusCrash(e);
});
process.on('unhandledRejection', (e) => log('[fatal] unhandledRejection', (e && e.stack) || e));

// Graceful shutdown: tear down the voice connection and clear the presence
// marker, so external tooling never reads a stale "user present" after we're
// gone. Deliberately does NOT fire onPresenceLeave — that hook means "the user
// left"; killing the bot is a different event, and the operator scripts
// (voice-down.sh / warm-servers.sh stop) own that lifecycle.
let shuttingDown = false;
function shutdown(sig) {
  // A second signal exits unconditionally — if the first attempt died mid-way
  // (see below), the latch must not make the process unkillable.
  if (shuttingDown) process.exit(0);
  shuttingDown = true;
  // Everything before exit is best-effort inside one try: with our stdout/stderr
  // pipe reader gone (host died first), even the log write can throw — and an
  // exception here would skip process.exit, leaving a zombie that ignores
  // SIGTERM. The finally guarantees we always exit.
  try {
    log(`[loop] ${sig} — shutting down`);
    setPresence(false);
    if (conn) conn.destroy();
    client.destroy();
    // Release the singleton pidfile only if it's ours — a refused duplicate
    // signaled mid-boot must not delete the real holder's claim.
    try { if (fs.readFileSync(LOOP_PIDFILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(LOOP_PIDFILE); } catch { /* */ }
  } catch { /* */ } finally { process.exit(0); }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function main() {
  // Refuse duplicates before ANY side effect (onStart hooks, MCP handshake,
  // gateway login) — a second instance must change nothing but the log.
  const single = acquireSingleton(TMPDIR);
  if (!single.ok) {
    const msg = `duplicate instance refused — voice_loop pid ${single.holder} already owns ${TMPDIR}`;
    log('[singleton]', msg);
    console.error(`broca-machina: ${msg} (kill it, or point this instance at a different tmpDir)`);
    process.exit(3);
  }
  // ffmpeg is a hard dependency of the capture path (PCM -> 16k WAV for STT).
  // Probe once at boot: a clear error now beats every utterance silently
  // converting to nothing later.
  try { require('child_process').execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); }
  catch {
    console.error('broca-machina: ffmpeg not found on PATH — install it (e.g. apt install ffmpeg / brew install ffmpeg).');
    process.exit(2);
  }
  // Optional boot hook (e.g. start warm STT/TTS servers) — runs once before connecting.
  if (CFG.onStart && Array.isArray(CFG.onStart.cmd)) {
    try {
      require('child_process').spawnSync(CFG.onStart.cmd[0], CFG.onStart.cmd.slice(1),
        { env: { ...process.env, ...(CFG.onStart.env || {}) }, stdio: 'ignore', timeout: CFG.onStart.timeoutMs || 90000 });
      log('[onstart] ran', CFG.onStart.cmd.join(' '));
    } catch (e) { log('[onstart] err', e.message); }
  }
  // In mcp mode, connect the stdio server FIRST so the host's initialize
  // handshake succeeds immediately, independent of the (slower) Discord connect.
  if (MCP_MODE) {
    try { await initMcp(); }
    catch (e) { console.error('[mcp] init FAILED', e && e.message); process.exit(1); }
  }
  // VOICE_NO_DISCORD skips the gateway login (validation/CI: exercise the MCP
  // bridge without joining the channel or colliding with a live bot session).
  if (process.env.VOICE_NO_DISCORD) {
    log('[loop] discord disabled (VOICE_NO_DISCORD=1)');
    // Match production lifetime: the gateway socket normally holds the event
    // loop open, so without it the process would exit the moment stdin drains
    // — and a validation harness could never observe the EOF->shutdown path
    // (or keep talking MCP to us). A ref'd idle timer stands in for the socket.
    setInterval(() => {}, 1 << 30);
    return;
  }
  client.login(token).catch((e) => log('[login] FAILED', e.message));
}
if (!process.env.VOICE_NO_MAIN) main();

// Test seam — the lifecycle selftest requires this module with VOICE_NO_MAIN=1
// and drives the state machine through these handles (no live gateway). Assigning
// module.exports is inert in production (nothing requires this file).
module.exports = {
  __test: {
    io, runHook, setPresence,
    enterChannel, leaveChannel, scheduleLeave, clearLeaveTimer, handleVoiceState,
    handleUtterance, setCapturingForTest: (v) => { capturing = v; },
    onSpeakingStart, setConnForTest: (c) => { conn = c; connected = !!c; },
    splitSentences, ackDue, earconDue, longWaitDue, pickAckIndex, cleanForTTS, truncateSpoken,
    fallbackPost, routedSpeakerName, renderLongWaitPhrase,
    setClientForTest: (c) => { client = c; },
    setFallbackChannelForTest: (id) => { VOICE_FALLBACK_CHANNEL = id; },
    bargeWorthy, noteOpusCrash, reloadOpus, getPrismForTest: () => prism,
    sendTranscript, readReplyFile, acquireSingleton, speak,
    recordTurn, clearTurns: () => { recentTurns.length = 0; },
    withinOneEdit, wakeStopwords: WAKE_STOPWORDS, channelIsHot,
    setReplyOwedForTest: (v) => { replyOwedAtCaptureStart = v; },
    enrollNeeded, getTurns: () => recentTurns.slice(), endSilenceMs, vadMinSilenceMs,
    looksIncomplete, hasWakeWord, isNoise,
    setBotSpeechEndedForTest: (v) => { lastBotSpeechEndedAt = v; },
    duckPlayback, restorePlayback, confirmBarge, armDuck, cancelArmedDuck,
    setResourceForTest: (r) => { currentRes = r; },
    setBotSpeakingForTest: (v) => { botSpeaking = v; },
    ack: { get: () => ackArmedAt, set: (v) => { ackArmedAt = v; } },
    cancelAck,
    acked: { get: () => ackedThisTurn, set: (v) => { ackedThisTurn = v; } },
    state: () => ({
      connected, connecting, hasLeaveTimer: !!leaveTimer, presenceActive,
      botSpeaking, capturing, hasPendingReply: replyQueue.length > 0, replyQueueLen: replyQueue.length,
      hasPendingAck: !!pendingAck, earconActive, earconMuted, ducked,
    }),
    cfg: { AUTO_JOIN, IDLE_LEAVE_MS, VAD: !!VAD, TTS_PIPE: !!TTS_PIPE, LOCAL_ACK: !!LOCAL_ACK, ACK_FIRE_MS, EARCON: !!EARCON, BARGE_CONFIRM, DUCK_AFTER_MS, DUCK_FACTOR, MAX_CAPTURE_MS, SPEAKER_ENROLL: !!SPEAKER_ENROLL, SEMANTIC: !!SEMANTIC, ADDRESS_GATE: !!ADDRESS_GATE },
    // TEST-ONLY seams for the local-ack sequencing selftest (never touched by
    // any production code path). setPlayerForTest injects a fake AudioPlayer
    // without a live Discord connection so pollReply()/playResource() run for
    // real against it; enqueueReply/enqueueAckForTest drive the exact same
    // pendingReply/pendingAck slots pollReply() itself reads, so the test
    // exercises the real queueing/two-clear logic, not a reimplementation.
    setPlayerForTest: (p) => { player = p; connected = true; },
    enqueueReply,
    enqueueAckForTest: (wav, text) => { pendingAck = { wav, text }; },
    pollReply,
    // Exposes the real dispatchLocalAck() (live Ollama HTTP call + real TTS
    // synth) for an end-to-end latency/correctness probe, distinct from the
    // enqueueAckForTest bypass the sequencing selftest uses.
    dispatchLocalAck,
    getPendingAck: () => pendingAck,
  },
};
