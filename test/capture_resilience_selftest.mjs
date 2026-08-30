// Capture-resilience selftest — two failure modes observed live 2026-08-13:
// (1) a decoder crash mid-capture left `capturing` stuck true (deaf loop) —
//     the watchdog force-finalizes an over-long capture and the crash guard
//     resets capture state;
// (2) a phantom capture (empty STT) destroyed the pending-wait state (ack
//     arm + earcon gate + pending content-ack) it had no right to touch —
//     in confirm mode only confirmed speech commits those resets.
// Run under bun:
//   VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/capture_resilience_selftest.mjs
import { createRequire } from 'module';
import { PassThrough } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-resilience-'));
const sttOut = path.join(dir, 'stt_out');
const cfg = {
  discord: { guildId: 'g', channelId: 'c', allowedUserId: 'U1', tokenEnv: 'DISCORD_VOICE_BOT_TOKEN' },
  // Fake STT: prints whatever the test staged in stt_out (ignores the wav arg).
  stt: { cmd: ['bash', '-c', `cat ${sttOut} 2>/dev/null`] },
  tts: { cmd: ['true'] },
  transport: { type: 'file', transcriptDir: path.join(dir, 'tx'), replyFile: path.join(dir, 'reply.txt') },
  maxCaptureSec: 0.3,       // watchdog fires fast in the test
  ackAfterMs: 100,
  tmpDir: path.join(dir, 'vtmp'),
};
const cfgPath = path.join(dir, 'cfg.json');
fs.writeFileSync(cfgPath, JSON.stringify(cfg));
process.env.VOICE_CONFIG = cfgPath;
process.env.VOICE_NO_MAIN = '1';
process.env.DISCORD_VOICE_BOT_TOKEN = process.env.DISCORD_VOICE_BOT_TOKEN || 'dummy';

const mod = require(path.join(ROOT, 'src', 'voice_loop.js'));
const T = mod.__test;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; }
const fakeWav = () => { const w = path.join(dir, `ack_${Math.floor(performance.now() * 1000)}.wav`); fs.writeFileSync(w, Buffer.alloc(200)); return w; };

// Real opus silence for the fake subscription stream: the capture path decodes
// what we feed it, so the utterance must be genuine opus packets (~0.6s of
// silence clears the default minUtteranceSec of 0.4).
const prism = require(path.join(ROOT, 'node_modules', 'prism-media'));
function feedSilence(pt, frames = 30) {
  const enc = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
  enc.on('data', (pkt) => pt.write(pkt));
  for (let i = 0; i < frames; i++) enc.write(Buffer.alloc(960 * 2 * 2));
  enc.end();
}

async function run() {
  check('exports handleUtterance + setCapturingForTest', typeof T.handleUtterance === 'function' && typeof T.setCapturingForTest === 'function');
  if (typeof T.handleUtterance !== 'function') { console.log('\n1 FAILED'); process.exit(1); }
  check('cfg: watchdog configured', T.cfg.MAX_CAPTURE_MS === 300);
  check('state exposes capturing', typeof T.state().capturing === 'boolean');

  // --- (2a) phantom capture: wait state fully restored -----------------------
  fs.writeFileSync(sttOut, '');                    // STT verdict: nothing
  T.ack.set(777111); T.acked.set(true);
  T.enqueueAckForTest(fakeWav(), 'held content ack');
  let pt = new PassThrough();
  T.handleUtterance('U1', pt);
  check('phantom: ack muted during capture', T.ack.get() === 0);
  feedSilence(pt);
  await delay(150); pt.end();
  await delay(1000);
  check('phantom: capturing cleared', T.state().capturing === false);
  check('phantom: ack arm restored', T.ack.get() === 777111);
  check('phantom: acked flag restored', T.acked.get() === true);
  check('phantom: pending content-ack survives', T.getPendingAck() !== null);

  // --- (2c) authoritative cancel during capture is NOT resurrected -----------
  // Observed live 2026-08-13 23:18Z: an aside verdict landed (ackArmedAt=0,
  // "no reply is coming") while a phantom capture was open; the phantom's
  // restore blindly re-applied the pre-capture arm, resurrecting a dead turn —
  // a filler fired and the earcon hummed for a reply that could never come.
  // Restores must yield to any authoritative disarm that happened mid-capture.
  check('exports cancelAck (authoritative disarm)', typeof T.cancelAck === 'function');
  if (typeof T.cancelAck === 'function') {
    fs.writeFileSync(sttOut, '');                  // phantom verdict
    T.ack.set(888111); T.acked.set(false);
    pt = new PassThrough();
    T.handleUtterance('U1', pt);
    T.cancelAck();                                 // aside/reply landed mid-capture
    feedSilence(pt);
    await delay(150); pt.end();
    await delay(1000);
    check('cancel-race: phantom does not resurrect cancelled ack', T.ack.get() === 0);

    fs.writeFileSync(sttOut, '');
    T.ack.set(888222); T.acked.set(false);
    pt = new PassThrough();
    T.handleUtterance('U1', pt);
    T.cancelAck();
    feedSilence(pt, 5);                            // 0.1s -> too-short path
    await delay(150); pt.end();
    await delay(1000);
    check('cancel-race: too-short does not resurrect cancelled ack', T.ack.get() === 0);
  } else {
    check('cancel-race: phantom does not resurrect cancelled ack', false);
    check('cancel-race: too-short does not resurrect cancelled ack', false);
  }

  // --- (2b) confirmed speech: resets commit, transcript delivered ------------
  fs.writeFileSync(sttOut, 'hello there friend');
  T.ack.set(777222); T.acked.set(true);
  pt = new PassThrough();
  T.handleUtterance('U1', pt);
  feedSilence(pt);
  await delay(150); pt.end();
  await delay(1000);
  check('real: capturing cleared', T.state().capturing === false);
  check('real: ack re-armed fresh (not restored)', T.ack.get() > 0 && T.ack.get() !== 777222);
  check('real: acked reset for the new turn', T.acked.get() === false);
  check('real: stale pending ack dropped', T.getPendingAck() === null);
  const delivered = fs.readdirSync(path.join(dir, 'tx')).length > 0;
  check('real: transcript delivered', delivered);

  // --- (1a) watchdog: never-ending capture force-finalizes -------------------
  fs.writeFileSync(sttOut, '');
  pt = new PassThrough();                          // never ended, never destroyed
  T.handleUtterance('U1', pt);
  check('watchdog: capture open', T.state().capturing === true);
  await delay(900);                                // maxCaptureSec 0.3 + STT roundtrip
  check('watchdog: capture force-cleared', T.state().capturing === false);

  // ...and the loop still takes the NEXT utterance (not wedged)
  fs.writeFileSync(sttOut, 'still alive');
  T.ack.set(0); T.acked.set(false);
  pt = new PassThrough();
  T.handleUtterance('U1', pt);
  feedSilence(pt);
  await delay(150); pt.end();
  await delay(1000);
  const nextTx = fs.readdirSync(path.join(dir, 'tx')).length;
  check('watchdog: next capture works (real transcript delivered)', T.state().capturing === false && nextTx >= 2);

  // --- (1b) crash guard resets capture state ---------------------------------
  T.setCapturingForTest(true);
  process.emit('uncaughtException', new Error('synthetic decoder crash'));
  await delay(50);
  check('crash guard: capturing reset', T.state().capturing === false);
  check('crash guard: botSpeaking reset', T.state().botSpeaking === false);

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
run();
