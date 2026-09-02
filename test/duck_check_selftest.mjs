// Echo-aware duck selftest. Live since the sustain gate: 93 ducks -> 7 real
// interrupts. The bot's own audio bleeding back into an open mic is still
// "capturing" at 350ms, so the sustain gate cannot tell it from speech and
// nearly every reply dims for nothing. With speakerGate.duckCheckMs set, the
// loop scores the first slice of the capture against the enrolled voiceprint
// (warm STT server, op=speaker) BEFORE dimming: the enrolled voice ducks,
// anything else leaves playback alone, and an unavailable score ducks as
// before (fail-open). Run under bun:
//   VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/duck_check_selftest.mjs
import { createRequire } from 'module';
import { PassThrough } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-duckcheck-'));
const sttOut = path.join(dir, 'stt_out');
const scoreOut = path.join(dir, 'score_out');
const voiceprint = path.join(dir, 'voiceprint.json');
fs.writeFileSync(sttOut, '');                 // every capture is a phantom here
fs.writeFileSync(voiceprint, '{}');           // present -> the gate is armed, no enrollment
// One stub for both calls the loop makes: `<cmd> <wav>` transcribes,
// `<cmd> --speaker-score <wav>` scores. bash -c's $0 is the first appended arg.
const cfg = {
  discord: { guildId: 'g', channelId: 'c', allowedUserId: 'U1', tokenEnv: 'DISCORD_VOICE_BOT_TOKEN' },
  stt: { cmd: ['bash', '-c', `if [ "$0" = --speaker-score ]; then cat ${scoreOut} 2>/dev/null; else cat ${sttOut} 2>/dev/null; fi`],
    env: { VOICE_SPEAKER_THRESHOLD: '0.5' } },
  tts: { cmd: ['true'] },
  transport: { type: 'file', transcriptDir: path.join(dir, 'tx'), replyFile: path.join(dir, 'reply.txt') },
  speakerGate: { refFile: voiceprint, duckCheckMs: 150 },
  duckAfterMs: 50,
  semanticEndpoint: { enabled: false },
  tmpDir: path.join(dir, 'vtmp'),
};
const cfgPath = path.join(dir, 'cfg.json');
fs.writeFileSync(cfgPath, JSON.stringify(cfg));
process.env.VOICE_CONFIG = cfgPath;
process.env.VOICE_NO_MAIN = '1';
process.env.DISCORD_VOICE_BOT_TOKEN = process.env.DISCORD_VOICE_BOT_TOKEN || 'dummy';

const T = require(path.join(ROOT, 'src', 'voice_loop.js')).__test;

let failed = 0;
function check(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; }
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const prism = require(path.join(ROOT, 'node_modules', 'prism-media'));
// Keep a capture alive: real opus silence, one frame every 20ms until stopped.
function streamSilence(pt) {
  const enc = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
  enc.on('data', (pkt) => { try { pt.write(pkt); } catch { /* */ } });
  const iv = setInterval(() => enc.write(Buffer.alloc(960 * 2 * 2)), 20);
  return () => { clearInterval(iv); enc.end(); pt.end(); };
}
let subscribed = [];
const fakeConn = { subscribe: () => {}, destroy: () => {},
  receiver: { subscribe: () => { const pt = new PassThrough(); subscribed.push(pt); return pt; }, speaking: { on: () => {} } } };
function fakeResource() { const calls = []; return { calls, _base: 1, volume: { setVolume: (v) => calls.push(v) } }; }

async function scenario(name, scoreText) {
  if (scoreText === null) { try { fs.unlinkSync(scoreOut); } catch { /* */ } } else fs.writeFileSync(scoreOut, scoreText);
  const res = fakeResource();
  T.setResourceForTest(res);
  T.setBotSpeakingForTest(true);
  const n = subscribed.length;
  T.onSpeakingStart('U1');
  const stop = streamSilence(subscribed[n]);
  await delay(700);                       // sustain gate + score window + a scoring round trip
  const ducked = T.state().ducked;
  const dimmed = res.calls.some((v) => v < 1);
  stop();
  await delay(900);                       // phantom verdict settles the capture
  T.setBotSpeakingForTest(false);
  T.restorePlayback();
  return { ducked, dimmed };
}

async function run() {
  check('cfg exposes DUCK_CHECK', T.cfg.DUCK_CHECK === true);
  if (T.cfg.DUCK_CHECK !== true) { console.log(`\n${failed} FAILED`); process.exit(1); }
  T.setConnForTest(fakeConn);
  T.setPlayerForTest({ play: () => {}, on: () => {}, off: () => {}, stop: () => {} });

  let r = await scenario('echo', '0.08');
  check('echo (score below threshold): playback NOT ducked', r.ducked === false);
  check('echo: volume never dimmed', r.dimmed === false);

  r = await scenario('voice', '0.83');
  check('enrolled voice (score above threshold): playback ducked', r.ducked === true);
  check('enrolled voice: volume dimmed', r.dimmed === true);

  r = await scenario('unknown', null);
  check('score unavailable: ducks as before (fail-open)', r.ducked === true);

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
run();
