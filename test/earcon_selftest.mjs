// Thinking-earcon selftest — after the ack, if the reply still hasn't landed,
// a quiet ambient loop fills the silence and cuts INSTANTLY when a reply
// arrives. Opt-in via cfg.thinkingEarcon; never blocks replies (plays without
// claiming botSpeaking). Run under bun:
//   VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/earcon_selftest.mjs
import { createRequire } from 'module';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-earcon-'));
const earconWav = path.join(dir, 'thinking.wav');
const sttOut = path.join(dir, 'stt_out');
fs.writeFileSync(sttOut, '');
fs.writeFileSync(earconWav, Buffer.alloc(400));   // content never decoded by the fake player
const cfg = {
  discord: { guildId: 'g', channelId: 'c', allowedUserId: 'U1', tokenEnv: 'DISCORD_VOICE_BOT_TOKEN' },
  // Fake STT: prints whatever the test staged in stt_out (empty = phantom).
  stt: { cmd: ['bash', '-c', `cat ${sttOut} 2>/dev/null`] }, tts: { cmd: ['true'] },
  transport: { type: 'file', transcriptDir: path.join(dir, 'tx'), replyFile: path.join(dir, 'reply.txt') },
  ackAfterMs: 100,
  thinkingEarcon: { file: earconWav, afterMs: 100, volume: 0.15, maxMs: 2500 },
  tmpDir: path.join(dir, 'vtmp'),
};
const cfgPath = path.join(dir, 'cfg.json');
fs.writeFileSync(cfgPath, JSON.stringify(cfg));
process.env.VOICE_CONFIG = cfgPath;
process.env.VOICE_NO_MAIN = '1';
process.env.DISCORD_VOICE_BOT_TOKEN = process.env.DISCORD_VOICE_BOT_TOKEN || 'dummy';

const mod = require(path.join(ROOT, 'src', 'voice_loop.js'));
const T = mod.__test;

// Fake AudioPlayer: playback "finishes" quickly so the earcon loop iterates.
class FakePlayer extends EventEmitter {
  constructor() { super(); this.playCalls = 0; this.stopCalls = 0; this.delay = 15; }
  play(res) { this.playCalls++; this.lastRes = res; setTimeout(() => this.emit('stateChange', {}, { status: 'idle' }), this.delay); }
  stop() { this.stopCalls++; this.emit('stateChange', {}, { status: 'idle' }); }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
// Real opus silence for a fake subscription stream (the capture path decodes
// what it is fed; ~0.6s clears minUtteranceSec).
const prism = require(path.join(ROOT, 'node_modules', 'prism-media'));
function feedSilence(pt, frames = 30) {
  const enc = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
  enc.on('data', (pkt) => pt.write(pkt));
  for (let i = 0; i < frames; i++) enc.write(Buffer.alloc(960 * 2 * 2));
  enc.end();
}
let failed = 0;
function check(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; }

async function run() {
  check('exports earconDue', typeof T.earconDue === 'function');
  if (typeof T.earconDue !== 'function') { console.log('\n1 FAILED'); process.exit(1); }
  check('config: earcon enabled', T.cfg.EARCON === true);

  // pure predicate: due only after fire-point + afterMs, on an acked, armed turn
  check('due: not before window', T.earconDue(1000, 900, true, 100, 100) === false);
  check('due: after window', T.earconDue(1300, 1000, true, 100, 100) === true);
  check('due: never when unacked', T.earconDue(1300, 1000, false, 100, 100) === false);
  check('due: never when unarmed', T.earconDue(1300, 0, true, 100, 100) === false);

  // integration: armed + acked turn with no reply -> earcon starts looping
  const p = new FakePlayer();
  T.setPlayerForTest(p);
  T.ack.set(Date.now() - 1000);
  T.acked.set(true);
  T.pollReply();
  await delay(700);
  check('starts: earcon playing', T.state().earconActive === true && p.playCalls >= 2);
  check('starts: does not claim botSpeaking', T.state().botSpeaking === false);

  // a reply landing kills the earcon MID-PLAY and speaks: make the in-flight
  // earcon playback long so only an explicit player.stop() can cut it.
  p.delay = 5000;
  await delay(60);   // let a long playback start
  T.enqueueReply('Here is the real answer.');
  await delay(600);
  check('reply: earcon stopped', T.state().earconActive === false);
  check('reply: player stopped for handoff', p.stopCalls >= 1);
  check('reply: queue drained (reply spoken)', T.state().replyQueueLen === 0);

  // earcon does not restart after the reply on the same (now consumed) turn
  const callsAfter = p.playCalls;
  await delay(400);
  check('after: earcon stays off', T.state().earconActive === false);

  // maxMs: a reply that NEVER comes must not hum forever — the earcon gives
  // up after maxMs and disarms the turn so it cannot immediately re-trigger.
  p.delay = 15;
  T.ack.set(Date.now() - 1000);
  T.acked.set(true);
  T.pollReply();
  await delay(500);
  check('cap: earcon running before maxMs', T.state().earconActive === true);
  await delay(2400);
  check('cap: earcon gave up after maxMs', T.state().earconActive === false);
  check('cap: turn disarmed (no immediate retrigger)', T.ack.get() === 0);
  await delay(400);
  check('cap: stays off', T.state().earconActive === false);

  // Mute-don't-stop (confirm mode). Live since 2026-08-29: 244 earcon starts,
  // half under 3s — the capture path STOPPED the hum on every speaking edge
  // and an open mic fires edges constantly, so the hum flapped on and off.
  // Same principle as duck-don't-die: an edge MUTES the loop, a phantom
  // verdict unmutes it (the turn is still owed), confirmed speech stops it.
  {
    const p2 = new FakePlayer();
    T.setPlayerForTest(p2);
    T.ack.set(Date.now() - 1000); T.acked.set(true);
    T.pollReply();
    await delay(500);
    check('mute: earcon running before the edge', T.state().earconActive === true);
    let wentOff = false;
    const watch = setInterval(() => { if (!T.state().earconActive) wentOff = true; }, 20);
    fs.writeFileSync(sttOut, '');                 // phantom verdict
    const pt = new PassThrough();
    T.handleUtterance('U1', pt);
    await delay(60);
    check('mute: edge mutes instead of stopping', T.state().earconActive === true && T.state().earconMuted === true);
    check('mute: hum volume at zero while muted', !!(p2.lastRes && p2.lastRes.volume) && p2.lastRes.volume.volume === 0);
    feedSilence(pt); await delay(150); pt.end();
    await delay(1000);                            // phantom resolves
    clearInterval(watch);
    check('mute: phantom unmutes', T.state().earconMuted === false);
    check('mute: earcon never went off across the phantom', wentOff === false && T.state().earconActive === true);
    check('mute: hum volume restored', !!(p2.lastRes && p2.lastRes.volume) && p2.lastRes.volume.volume > 0);

    const stopsBefore = p2.stopCalls;
    fs.writeFileSync(sttOut, 'hello there friend');   // confirmed speech
    const pt2 = new PassThrough();
    T.handleUtterance('U1', pt2);
    await delay(60);
    check('mute: real speech also mutes first (verdict pending)', T.state().earconMuted === true && p2.stopCalls === stopsBefore);
    feedSilence(pt2); await delay(150); pt2.end();
    await delay(1000);
    check('mute: confirmed speech stops the hum', p2.stopCalls > stopsBefore && T.state().earconMuted === false);
    T.ack.set(0); T.acked.set(false);
    await delay(300);
  }

  // longWaitDue — pure predicate for the spoken "still working" notice on
  // long agent-brain waits (fires once per turn, between the earcon's start
  // and its give-up). firedFor is the armedAt value it last fired for.
  check('exports longWaitDue', typeof T.longWaitDue === 'function');
  if (typeof T.longWaitDue === 'function') {
    check('longwait: due after window', T.longWaitDue(2000, 1000, 0, 1000) === true);
    check('longwait: not before window', T.longWaitDue(1500, 1000, 0, 1000) === false);
    check('longwait: fires once per turn', T.longWaitDue(2500, 1000, 1000, 1000) === false);
    check('longwait: never when unarmed', T.longWaitDue(2000, 0, 0, 1000) === false);
    check('longwait: disabled at afterMs 0', T.longWaitDue(2000, 1000, 0, 0) === false);
  }
  // renderLongWaitPhrase — {who} templating so the notice can name the session
  // actually being waited on (CS, live 2026-08-30: the fixed line named the
  // default brain while the wait was on a routed remote session).
  check('exports renderLongWaitPhrase', typeof T.renderLongWaitPhrase === 'function');
  if (typeof T.renderLongWaitPhrase === 'function') {
    check('longwait: {who} substituted', T.renderLongWaitPhrase('Still waiting on {who}.', 'the remote session') === 'Still waiting on the remote session.');
    check('longwait: every {who} substituted', T.renderLongWaitPhrase('{who}? {who}!', 'x') === 'x? x!');
    check('longwait: no placeholder unchanged', T.renderLongWaitPhrase('Still working.', 'x') === 'Still working.');
  } else {
    for (const n of ['longwait: due after window', 'longwait: not before window',
      'longwait: fires once per turn', 'longwait: never when unarmed',
      'longwait: disabled at afterMs 0']) check(n, false);
  }

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
run();
