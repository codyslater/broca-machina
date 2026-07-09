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
const prism = require('prism-media');
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
const NOISE = new Set((CFG.sttNoiseDrop || ['', '.', 'you', 'thank you', 'thanks', 'bye', 'you.', 'thank you.']).map((s) => s.toLowerCase()));
const TMPDIR = CFG.tmpDir || path.join(path.dirname(path.resolve(CFG_PATH)), '.voice-tmp');
fs.mkdirSync(TMPDIR, { recursive: true });
// Sweep scratch WAVs orphaned by a previous crash (normal runs unlink as they
// go, so anything matching here is dead). Boot-time only — nothing is in
// flight yet — and best-effort: hygiene must never block a start.
try {
  for (const f of fs.readdirSync(TMPDIR)) {
    if (/^(utt_|reply_)\d{8}_\d{6}_\d{6}\.wav$/.test(f)) fs.unlinkSync(path.join(TMPDIR, f));
  }
} catch { /* */ }
if (T.type === 'file') fs.mkdirSync(T.transcriptDir, { recursive: true });

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

const MCP_MODE = (T.type === 'mcp');
// In mcp mode stdout is the JSON-RPC channel — every log line MUST go to stderr.
const log = (...a) => {
  const line = [new Date().toISOString().slice(11, 19), ...a].map(String).join(' ');
  if (MCP_MODE) process.stderr.write(line + '\n'); else console.log(line);
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
function cleanForTTS(t) {
  return t
    .replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1').replace(/\*([^*]*)\*/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '')
    .replace(/[#>_~|*`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CFG.maxReplyChars || 700);
}

// Presence marker — reflects whether the allowed user is currently connected to
// the voice channel (driven by voiceStateUpdate). Lets external tooling gate on
// "is the human actually here" without polling Discord.
function setPresence(present) {
  presenceActive = present;
  if (!PRESENCE_FILE) return;
  try {
    if (present) fs.writeFileSync(PRESENCE_FILE, String(Date.now()));
    else if (fs.existsSync(PRESENCE_FILE)) fs.unlinkSync(PRESENCE_FILE);
  } catch (e) { log('[presence] err', e.message); }
}

let botSpeaking = false, capturing = false, player;
let ackedThisTurn = false;
let ackArmedAt = 0;   // end-of-speech time of the current turn; arms the "still thinking" ack (0 = no turn)
let mcpServer = null;   // set in initMcp() when transport.type === 'mcp'
// Voice-channel connection lifecycle (presence-gated when AUTO_JOIN).
let conn = null;            // the live VoiceConnection, or null when not in the channel
let connected = false;      // true once joined + player wired
let connecting = false;     // guards against overlapping enterChannel() calls
let leaveTimer = null;      // pending idle-leave timer (armed when the user leaves)
let presenceActive = false; // is the allowed user currently in the channel

function handleUtterance(userId, opus) {
  capturing = true;
  // The user is talking again — cancel any ack still pending from the previous
  // turn, or it could fire mid-utterance and talk over them (no speaking.start
  // edge arrives during continuous speech, so barge-in couldn't stop it). This
  // turn's finalize() re-arms at its own end-of-speech. Safe for the command
  // transport: no new capture can start while its brain runs (capturing gate).
  ackArmedAt = 0;
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const chunks = [];
  let finalized = false;
  let monitor = null;

  // Single idempotent end-of-utterance path — fires from whichever endpointer
  // wins: the fixed-silence AfterSilence 'end' (default / fallback) or, when
  // enabled, an early VAD endpoint. The `finalized` guard makes double-fire a
  // no-op, so the two mechanisms coexist safely.
  const finalize = async (reason) => {
    if (finalized) return;
    finalized = true;
    if (monitor) { try { monitor.close(); } catch { /* */ } }
    // Only the VAD path ends early — free the subscription so the next utterance
    // can re-capture immediately rather than waiting out END_SILENCE. The natural
    // 'silence' end has already closed it.
    if (reason === 'vad') { try { opus.destroy(); } catch { /* */ } }
    try {
      const pcm = Buffer.concat(chunks);
      const secs = pcm.length / (48000 * 2 * 2);
      if (secs < MIN_SEC) { log(`[recv] ${secs.toFixed(2)}s too short`); return; }
      // Arm the "still thinking" ack at end-of-speech — BEFORE STT — so the quick
      // acknowledgement overlaps STT + brain time instead of waiting them out.
      if (ACK_AFTER_MS) { ackArmedAt = Date.now(); ackedThisTurn = false; }
      const wav = path.join(TMPDIR, `utt_${utcTs()}.wav`);
      await pcmToWav(pcm, wav);
      log(`[recv] ${secs.toFixed(1)}s -> STT (${reason})`);
      const text = (await runCmd([...STT_CMD, wav], (CFG.stt && CFG.stt.env) || {})).trim();
      fs.unlink(wav, () => {});
      // Dropped utterance -> no dispatch -> no reply will ever come. Disarm the
      // ack or it would fire and promise a reply that never arrives.
      if (!text || text.length < 3 || NOISE.has(text.toLowerCase())) { ackArmedAt = 0; log(`[stt] drop: "${text}"`); return; }
      log(`[stt] "${text}"`);
      await sendTranscript(text);
    } finally { capturing = false; }
  };

  if (vadClient) {
    try {
      monitor = vadClient.createVadMonitor({
        sock: VAD_SOCK,
        header: {
          sample_rate: 48000, channels: 2,
          threshold: (VAD.threshold != null ? VAD.threshold : 0.5),
          neg_threshold: (VAD.negThreshold != null ? VAD.negThreshold : null),
          min_silence_ms: (VAD.minSilenceMs != null ? VAD.minSilenceMs : 300),
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
}

// transport.out — deliver a transcript to the brain
async function sendTranscript(text) {
  if (T.type === 'command') {
    const reply = (await runCmd([...T.cmd], { VOICE_TRANSCRIPT: text })).trim();
    if (reply) enqueueReply(reply);
    else ackArmedAt = 0;   // the brain finished with silence — nothing is coming; don't ack a reply that won't
  } else if (T.type === 'mcp') {
    // Reply comes back via the `speak` tool (-> enqueueReply); the ack was
    // already armed at end-of-speech.
    try { await deliverInboundMcp(text); }
    catch (e) { log('[mcp] notify err', e.message); ackArmedAt = 0; }   // delivery failed -> no reply coming
  } else { // file
    fs.writeFileSync(path.join(T.transcriptDir, `${utcTs()}.txt`), text);
    log('[out] -> transcriptDir');
  }
}

// transport.in — a reply arrived; speak it. For 'file' transport we poll replyFile.
function enqueueReply(text) { pendingReply = text; }
let pendingReply = null;

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
    finally { botSpeaking = false; }
  } else {
    await speak(phrase);               // render failed earlier — synth on the fly (correct, just slower)
  }
}

// Pure predicate (exported for the selftest): is the "still thinking" ack due?
// afterMs<=0 disables it; armedAt is the end-of-speech time; acked one-shots it.
function ackDue(now, armedAt, acked, afterMs) {
  return afterMs > 0 && armedAt > 0 && !acked && (now - armedAt) >= afterMs;
}

async function speak(text) {
  if (!connected || !player) { log('[tts] not in channel — dropping reply'); return; }
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
  } finally { botSpeaking = false; }
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
  }
}
function playResource(stream) {
  return new Promise((resolve) => {
    const res = createAudioResource(stream, { inputType: StreamType.Arbitrary });
    let settled = false;
    const done = () => {
      if (settled) return; settled = true;
      clearTimeout(safety); player.off('stateChange', onState); player.off('error', onErr);
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

function pollReply() {
  try {
    if (!botSpeaking) {
      if (!connected) {
        // Not in the channel — nobody to hear a reply or an ack. Drain any queued
        // reply so it can't go stale and surface on a later join, but don't synthesize.
        ackArmedAt = 0;
        if (pendingReply) { log('[reply] dropped — not in channel'); pendingReply = null; }
        if (T.type === 'file' && fs.existsSync(T.replyFile)) { try { fs.unlinkSync(T.replyFile); } catch {} log('[reply] dropped file — not in channel'); }
        setTimeout(pollReply, 300); return;
      }
      if (pendingReply) { const t = cleanForTTS(pendingReply); pendingReply = null; ackArmedAt = 0; if (t) { speak(t).finally(() => setTimeout(pollReply, 200)); return; } }
      if (T.type === 'file' && fs.existsSync(T.replyFile)) {
        // The documented file-transport contract: whatever writes replyFile
        // becomes the voice — including unsolicited/proactive lines (a
        // long-running brain announcing something). The brain owns this file;
        // if it doesn't want text voiced, it doesn't write it here.
        const raw = fs.readFileSync(T.replyFile, 'utf8'); fs.unlinkSync(T.replyFile);
        ackArmedAt = 0;
        const t = cleanForTTS(raw); if (t) { speak(t).finally(() => setTimeout(pollReply, 200)); return; }
      }
      if (ackDue(Date.now(), ackArmedAt, ackedThisTurn, ACK_AFTER_MS)) {
        ackedThisTurn = true; speakAck().finally(() => setTimeout(pollReply, 200)); return;
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
      description: 'Speak a reply aloud in the Discord voice channel (text-to-speech). Use only to answer a voice-channel (spoken) turn.',
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
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

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
      conn = null; player = null; connected = false; botSpeaking = false; capturing = false; ackArmedAt = 0;
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
  if (ALLOWED && userId !== ALLOWED) return;
  if (!conn || !connected) return;   // a speaking event landed during teardown/reconnect
  if (botSpeaking && BARGE_IN) {
    // Barge-in: the user started talking while we were speaking. Stop playback
    // immediately so they never have to wait for the bot to finish a reply.
    log('[barge] user spoke during playback — interrupting');
    try { player.stop(true); } catch {}
    botSpeaking = false;
  }
  if (botSpeaking || capturing) {
    // One turn at a time: speech during an active capture (incl. a command
    // brain still computing) is dropped by design — say so, or a slow brain
    // reads as "the bot ignored me" with nothing in the log.
    if (capturing) log('[recv] busy — speech ignored (previous turn still processing)');
    return;
  }
  handleUtterance(userId, conn.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: END_SILENCE } }));
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
  connected = false; botSpeaking = false; capturing = false; ackArmedAt = 0; ackedThisTurn = false;
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
process.on('uncaughtException', (e) => log('[fatal] uncaughtException', (e && e.stack) || e));
process.on('unhandledRejection', (e) => log('[fatal] unhandledRejection', (e && e.stack) || e));

// Graceful shutdown: tear down the voice connection and clear the presence
// marker, so external tooling never reads a stale "user present" after we're
// gone. Deliberately does NOT fire onPresenceLeave — that hook means "the user
// left"; killing the bot is a different event, and the operator scripts
// (voice-down.sh / warm-servers.sh stop) own that lifecycle.
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return; shuttingDown = true;
  log(`[loop] ${sig} — shutting down`);
  try { setPresence(false); } catch { /* */ }
  try { if (conn) conn.destroy(); } catch { /* */ }
  try { client.destroy(); } catch { /* */ }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function main() {
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
  if (process.env.VOICE_NO_DISCORD) { log('[loop] discord disabled (VOICE_NO_DISCORD=1)'); return; }
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
    splitSentences, ackDue, pickAckIndex, cleanForTTS,
    state: () => ({ connected, connecting, hasLeaveTimer: !!leaveTimer, presenceActive }),
    cfg: { AUTO_JOIN, IDLE_LEAVE_MS, VAD: !!VAD, TTS_PIPE: !!TTS_PIPE },
  },
};
