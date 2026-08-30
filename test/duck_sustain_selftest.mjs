// Duck sustain-gate selftest — a noise blob must never dim the reply.
//
// CS 20260829, working in a noisy lab: "it's kind of dimming the speaking voice, it makes it
// hard to hear ... so it thinks something is coming through, it's accurately rejecting it,
// but it's kind of dimming". The rejection was correct and INAUDIBLE; the ducking was
// incorrect and audible. The duck fired on Discord's speaking-start EDGE — any mic activity
// — while the speaker gate and the >=bargeMinWords bar only rejected the noise afterwards.
//
// BOTH DIRECTIONS. A test that only proves a blob does not duck passes against a build that
// never ducks at all, which silently removes barge-in — the more expensive failure.
//   VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/duck_sustain_selftest.mjs
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-duck-'));
const cfg = {
  discord: { guildId: 'g', channelId: 'c', allowedUserId: 'U1', tokenEnv: 'DISCORD_VOICE_BOT_TOKEN' },
  stt: { cmd: ['true'] }, tts: { cmd: ['true'] },
  transport: { type: 'file', transcriptDir: path.join(dir, 'tx'), replyFile: path.join(dir, 'reply.txt') },
  tmpDir: path.join(dir, 'vtmp'),
  duckAfterMs: 60,      // short so the test is fast; production default is 350
  duckFactor: 0.55,
};
fs.writeFileSync(path.join(dir, 'cfg.json'), JSON.stringify(cfg));
process.env.VOICE_CONFIG = path.join(dir, 'cfg.json');
process.env.VOICE_NO_MAIN = '1';
process.env.DISCORD_VOICE_BOT_TOKEN = process.env.DISCORD_VOICE_BOT_TOKEN || 'dummy';

const T = require(path.join(ROOT, 'src', 'voice_loop.js')).__test;
let failed = 0;
const check = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeResource = (base) => {
  const calls = [];
  return { calls, _base: base, volume: { setVolume: (v) => calls.push(v) } };
};

async function run() {
  check('config is read, not hardcoded', T.cfg.DUCK_AFTER_MS === 60 && Math.abs(T.cfg.DUCK_FACTOR - 0.55) < 1e-9);
  check('armDuck/cancelArmedDuck are exported',
    typeof T.armDuck === 'function' && typeof T.cancelArmedDuck === 'function');

  // --- DENY: a blob that stops before the gate elapses never ducks ---
  let r = fakeResource(1);
  T.setResourceForTest(r); T.setBotSpeakingForTest(true); T.setCapturingForTest(true);
  T.armDuck();
  check('arming alone does not dim', r.calls.length === 0 && T.state().ducked === false);
  T.setCapturingForTest(false);          // the blob ended — this is the lab noise case
  await sleep(120);
  check('a blob that ended never ducks', r.calls.length === 0 && T.state().ducked === false);

  // --- ALLOW: speech still going when the gate elapses DOES duck ---
  r = fakeResource(1);
  T.setResourceForTest(r); T.setBotSpeakingForTest(true); T.setCapturingForTest(true);
  T.armDuck();
  await sleep(120);
  check('sustained speech ducks', T.state().ducked === true && r.calls.length === 1);
  check('and ducks to the configured depth', Math.abs(r.calls[0] - 0.55) < 1e-9);
  T.restorePlayback();
  check('restore clears it', T.state().ducked === false && r.calls[1] === 1);

  // --- playback that ended must not be ducked by a stale timer ---
  r = fakeResource(1);
  T.setResourceForTest(r); T.setBotSpeakingForTest(true); T.setCapturingForTest(true);
  T.armDuck();
  T.setBotSpeakingForTest(false);        // reply finished while the timer was pending
  await sleep(120);
  check('a finished reply is not ducked late', r.calls.length === 0);

  // --- cancel is honoured ---
  r = fakeResource(1);
  T.setResourceForTest(r); T.setBotSpeakingForTest(true); T.setCapturingForTest(true);
  T.armDuck(); T.cancelArmedDuck();
  await sleep(120);
  check('cancelArmedDuck disarms it', r.calls.length === 0);

  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
}
run();
