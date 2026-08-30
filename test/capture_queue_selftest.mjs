// Capture-queue selftest — Discord sends ONE speaking edge per utterance, so
// an edge landing while a previous turn is still in STT/judge/delivery used to
// be ignored WHOLE (observed live 2026-08-16: session-start utterances lost
// behind junk-blob processing — "trouble queuing at start"). The fix splits
// capture (pure buffering, frees at the endpoint) from processing (serialized
// FIFO): a new edge opens a new capture immediately; delivery order holds.
// Run under bun:
//   VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/capture_queue_selftest.mjs
import { createRequire } from 'module';
import { PassThrough } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-capq-'));
const queueFile = path.join(dir, 'stt_lines');
fs.writeFileSync(queueFile, '');
const cfg = {
  discord: { guildId: 'g', channelId: 'c', allowedUserId: 'U1', tokenEnv: 'DISCORD_VOICE_BOT_TOKEN' },
  // Slow STT that pops one queued line per call — overlap-friendly and ordered.
  stt: { cmd: ['bash', '-c', `sleep 0.6; head -1 ${queueFile}; sed -i 1d ${queueFile}`] },
  tts: { cmd: ['true'] },
  transport: { type: 'file', transcriptDir: path.join(dir, 'tx'), replyFile: path.join(dir, 'reply.txt') },
  ackAfterMs: 60000,   // arms ackArmedAt (what the test reads) but never fires playback
  semanticEndpoint: { enabled: false },
  tmpDir: path.join(dir, 'vtmp'),
};
const cfgPath = path.join(dir, 'cfg.json');
fs.writeFileSync(cfgPath, JSON.stringify(cfg));
process.env.VOICE_CONFIG = cfgPath;
process.env.VOICE_NO_MAIN = '1';
process.env.DISCORD_VOICE_BOT_TOKEN = process.env.DISCORD_VOICE_BOT_TOKEN || 'dummy';

const mod = require(path.join(ROOT, 'src', 'voice_loop.js'));
const T = mod.__test;

let failed = 0;
function check(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; }
const txDir = path.join(dir, 'tx');
const delivered = () => { try { return fs.readdirSync(txDir).filter((f) => f.endsWith('.txt')).sort(); } catch { return []; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const prism = require(path.join(ROOT, 'node_modules', 'prism-media'));
function feedSpeech(pt, frames = 40) {
  const enc = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
  enc.on('data', (pkt) => pt.write(pkt));
  for (let i = 0; i < frames; i++) enc.write(Buffer.alloc(960 * 2 * 2));
  enc.end();
}
function queueLine(text) { fs.appendFileSync(queueFile, `${text}\n`); }

// Fake connection: onSpeakingStart subscribes through this, so the test walks
// the REAL edge-handling path (busy check included), not handleUtterance direct.
let subscribed = [];
const fakeConn = {
  receiver: {
    subscribe: () => { const pt = new PassThrough(); subscribed.push(pt); return pt; },
    speaking: { users: new Map(), on: () => {} },
  },
};

async function run() {
  check('exports onSpeakingStart', typeof T.onSpeakingStart === 'function');
  check('exports setConnForTest', typeof T.setConnForTest === 'function');
  if (typeof T.onSpeakingStart !== 'function' || typeof T.setConnForTest !== 'function') {
    console.log(`\n${failed} FAILED`); process.exit(1);
  }
  T.setConnForTest(fakeConn);
  T.setPlayerForTest({ play: () => {}, on: () => {}, off: () => {}, stop: () => {} });

  // Turn 1: capture ends, slow STT starts. The capture slot must free at the
  // ENDPOINT, not after delivery — that closed window is what ate live speech.
  queueLine('first question for the queue test.');
  T.onSpeakingStart('U1');
  check('edge 1 opened a capture', subscribed.length === 1);
  feedSpeech(subscribed[0]);
  await sleep(150); subscribed[0].end();
  await sleep(250);   // finalize entered; STT sleeping
  check('capture slot free during STT', T.state().capturing === false);

  // Turn 2 edge arrives while turn 1 is still in its STT — must open a new
  // capture instead of being ignored.
  queueLine('second question for the queue test.');
  T.onSpeakingStart('U1');
  check('edge 2 opened a capture during processing', subscribed.length === 2);
  if (subscribed.length === 2) { feedSpeech(subscribed[1]); await sleep(150); subscribed[1].end(); }

  await sleep(2200);  // both STT sleeps + delivery
  const files = delivered();
  check('both turns delivered', files.length === 2);
  if (files.length === 2) {
    const a = fs.readFileSync(path.join(txDir, files[0]), 'utf8');
    const b = fs.readFileSync(path.join(txDir, files[1]), 'utf8');
    check('delivery kept arrival order', a.includes('first question') && b.includes('second question'));
  } else {
    check('delivery kept arrival order', false);
  }

  // A turn finishing while the user is ALREADY talking again must not arm the
  // "still thinking" ack — a filler would fire over their speech.
  queueLine('third question for the queue test.');
  T.onSpeakingStart('U1');
  if (!subscribed[2]) {
    check('turn finishing under an open capture does not arm the ack', false);
    check('queued turn still delivered after ack-skip', false);
    console.log(`\n${failed} FAILED`); process.exit(1);
  }
  feedSpeech(subscribed[2]);
  await sleep(150); subscribed[2].end();
  await sleep(200);
  T.onSpeakingStart('U1');           // user talking again mid-processing…
  check('edge 4 opened a capture', subscribed.length === 4);
  feedSpeech(subscribed[3] || new PassThrough(), 60);
  await sleep(900);                  // turn 3 finished processing; capture 4 still open
  check('turn finishing under an open capture does not arm the ack', T.ack.get() === 0);
  queueLine('fourth question for the queue test.');
  if (subscribed[3]) subscribed[3].end();
  await sleep(1800);
  check('queued turn still delivered after ack-skip', delivered().length === 4);

  // Barge hardening end-to-end: a short transcript during DUCKED playback
  // delivers but must NOT stop the player (hallucinated stock phrases killed
  // playback live); a stop-phrase or long transcript still interrupts.
  const stops = [];
  T.setPlayerForTest({ play: () => {}, on: () => {}, off: () => {}, stop: () => stops.push(1) });
  const res = { _base: 1, volume: { setVolume: () => {} } };
  T.setResourceForTest(res);
  T.duckPlayback();
  queueLine("I don't know.");
  T.onSpeakingStart('U1');
  feedSpeech(subscribed[4]); await sleep(150); subscribed[4].end();
  await sleep(1300);
  check('short transcript: delivered', delivered().length === 5);
  check('short transcript: playback not interrupted', stops.length === 0);
  check('short transcript: duck restored', T.state().ducked === false);
  T.setResourceForTest(res);
  T.duckPlayback();
  queueLine('okay please stop reading that.');
  T.onSpeakingStart('U1');
  feedSpeech(subscribed[5]); await sleep(150); subscribed[5].end();
  await sleep(1300);
  check('long transcript: delivered', delivered().length === 6);
  check('long transcript: playback interrupted', stops.length >= 1);

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
run();
