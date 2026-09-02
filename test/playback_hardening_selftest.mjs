// Playback-hardening selftest — three live findings from 2026-08-29:
//  (1) idle-leave nulled `player` while a playback promise was pending; its
//      settle path dereferenced the global and threw (uncaughtException), and
//      the promise never resolved;
//  (2) the safety timeout is a flat 60s, so a wedged player costs a full
//      minute of dead air PER playback (four in a row that evening);
//  (3) nothing ever recovered the wedged player — every later playback wedged
//      too until the user left.
// Run under bun:
//   VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/playback_hardening_selftest.mjs
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-playhard-'));
// TTS stub writes a small but VALID wav (0.25s @ 8kHz mono) so duration
// parsing has something real to read: $1=text $2=outwav.
const ttsStub = path.join(dir, 'tts_stub.sh');
fs.writeFileSync(ttsStub, `#!/usr/bin/env bash\ncp "${path.join(dir, 'quarter.wav')}" "$2"\n`);
fs.chmodSync(ttsStub, 0o755);
const cfg = {
  discord: { guildId: 'g', channelId: 'c', allowedUserId: 'U1', tokenEnv: 'DISCORD_VOICE_BOT_TOKEN' },
  stt: { cmd: ['true'] }, tts: { cmd: ['bash', ttsStub] },
  transport: { type: 'file', transcriptDir: path.join(dir, 'tx'), replyFile: path.join(dir, 'reply.txt') },
  playTimeoutMs: 400,   // the CAP; a short wav's safety window is min(cap, ...) so the test stays fast
  tmpDir: path.join(dir, 'vtmp'),
};
const cfgPath = path.join(dir, 'cfg.json');
fs.writeFileSync(cfgPath, JSON.stringify(cfg));
process.env.VOICE_CONFIG = cfgPath;
process.env.VOICE_NO_MAIN = '1';
process.env.DISCORD_VOICE_BOT_TOKEN = process.env.DISCORD_VOICE_BOT_TOKEN || 'dummy';

// Hand-built PCM wav writer (no code under test involved).
function writeWav(file, { rate, channels, seconds, extraChunk }) {
  const frames = Math.round(rate * seconds);
  const data = Buffer.alloc(frames * channels * 2);
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12); fmt.writeUInt32LE(rate * channels * 2, 16); fmt.writeUInt16LE(channels * 2, 20); fmt.writeUInt16LE(16, 22);
  const extra = extraChunk ? Buffer.concat([Buffer.from('LIST'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(extraChunk.length, 0); return b; })(), extraChunk]) : Buffer.alloc(0);
  const dh = Buffer.alloc(8); dh.write('data', 0); dh.writeUInt32LE(data.length, 4);
  const body = Buffer.concat([Buffer.from('WAVE'), fmt, extra, dh, data]);
  const riff = Buffer.alloc(8); riff.write('RIFF', 0); riff.writeUInt32LE(body.length, 4);
  fs.writeFileSync(file, Buffer.concat([riff, body]));
}
writeWav(path.join(dir, 'quarter.wav'), { rate: 8000, channels: 1, seconds: 0.25 });

const mod = require(path.join(ROOT, 'src', 'voice_loop.js'));
const T = mod.__test;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; }

// Fake AudioPlayer that NEVER reaches idle (a wedged player), with the
// listener plumbing playResource() uses.
function wedgedPlayer() {
  const listeners = {};
  return {
    plays: 0, stops: 0, state: { status: 'buffering' },
    on(ev, cb) { (listeners[ev] || (listeners[ev] = [])).push(cb); },
    off(ev, cb) { if (listeners[ev]) listeners[ev] = listeners[ev].filter((f) => f !== cb); },
    play() { this.plays++; },
    stop() { this.stops++; },
  };
}
function idlePlayer(ms) {
  const p = wedgedPlayer();
  const listeners = [];
  p.on = (ev, cb) => { if (ev === 'stateChange') listeners.push(cb); };
  p.off = (ev, cb) => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
  p.play = () => { p.plays++; setTimeout(() => { for (const cb of listeners.slice()) cb({ status: 'playing' }, { status: 'idle' }); }, ms); };
  return p;
}

async function run() {
  // --- wavDurationMs: RIFF header math, hand-derived expectations ------------
  check('exports wavDurationMs + playSafetyMs', typeof T.wavDurationMs === 'function' && typeof T.playSafetyMs === 'function');
  if (typeof T.wavDurationMs !== 'function') { console.log(`\n${failed} FAILED`); process.exit(1); }
  const w1 = path.join(dir, 'w1.wav'); writeWav(w1, { rate: 24000, channels: 1, seconds: 1.25 });
  const w2 = path.join(dir, 'w2.wav'); writeWav(w2, { rate: 48000, channels: 2, seconds: 3.2, extraChunk: Buffer.alloc(30) });
  check('duration: 24k mono 1.25s', Math.abs(T.wavDurationMs(w1) - 1250) < 2);
  check('duration: 48k stereo 3.2s with a LIST chunk before data', Math.abs(T.wavDurationMs(w2) - 3200) < 2);
  const junk = path.join(dir, 'junk.wav'); fs.writeFileSync(junk, Buffer.alloc(300));
  check('duration: non-wav -> null', T.wavDurationMs(junk) === null);
  check('duration: missing file -> null', T.wavDurationMs(path.join(dir, 'nope.wav')) === null);

  // --- playSafetyMs: duration + margin, floored, capped ----------------------
  check('safety: short clip gets the floor', T.playSafetyMs(500, 60000) === 5000);
  check('safety: long clip gets duration + margin', T.playSafetyMs(10000, 60000) === 13000);
  check('safety: never above the cap', T.playSafetyMs(90000, 60000) === 60000);
  check('safety: unknown duration -> cap', T.playSafetyMs(null, 60000) === 60000);
  check('safety: cap below the floor wins', T.playSafetyMs(500, 300) === 300);

  // --- (2) wedged player costs the sized window, not a minute ---------------
  let subs = 0;
  T.setConnForTest({ subscribe: () => { subs++; }, destroy: () => {}, receiver: { subscribe: () => null, speaking: { on: () => {} } } });
  const p1 = wedgedPlayer();
  T.setPlayerForTest(p1);
  const t0 = Date.now();
  T.enqueueReply('first reply');
  T.pollReply();
  await delay(120);
  check('wedge: playback started', p1.plays === 1 && T.state().botSpeaking === true);
  await delay(600);   // cap 400ms + synth + poll slack
  check('wedge: settled by the safety window (~cap), not 60s', T.state().botSpeaking === false && Date.now() - t0 < 1500);
  check('wedge: one timeout counted', T.state().playbackTimeouts === 1);
  check('wedge: player kept after a single timeout', subs === 0);

  // --- (3) second consecutive timeout recreates the player -------------------
  T.enqueueReply('second reply');
  await delay(900);
  check('recreate: second timeout counted', T.state().playbackTimeouts >= 2);
  check('recreate: fresh player subscribed to the connection', subs === 1);
  check('recreate: old wedged player stopped', p1.stops >= 1);

  // a healthy playback resets the streak
  const p2 = idlePlayer(30);
  T.setPlayerForTest(p2);
  T.enqueueReply('third reply');
  await delay(700);
  check('reset: healthy playback clears the timeout streak', p2.plays === 1 && T.state().playbackTimeouts === 0);

  // --- (1) player nulled mid-playback must neither throw nor hang -----------
  let uncaught = null;
  const onUncaught = (e) => { uncaught = e; };
  process.on('uncaughtException', onUncaught);
  const p3 = wedgedPlayer();
  T.setPlayerForTest(p3);
  const spoke = T.speak('reply that outlives the channel');
  await delay(120);
  check('null: playback in flight', p3.plays === 1);
  T.leaveChannel('selftest');           // realDisconnect(): player = null
  let settled = false;
  spoke.then(() => { settled = true; });
  await delay(800);                      // safety window elapses with player === null
  process.off('uncaughtException', onUncaught);
  check('null: settle path did not throw', uncaught === null);
  check('null: speak() promise resolved', settled === true);
  check('null: botSpeaking cleared', T.state().botSpeaking === false);

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
run();
