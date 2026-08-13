// Thinking-earcon selftest — after the ack, if the reply still hasn't landed,
// a quiet ambient loop fills the silence and cuts INSTANTLY when a reply
// arrives. Opt-in via cfg.thinkingEarcon; never blocks replies (plays without
// claiming botSpeaking). Run under bun:
//   VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/earcon_selftest.mjs
import { createRequire } from 'module';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-earcon-'));
const earconWav = path.join(dir, 'thinking.wav');
fs.writeFileSync(earconWav, Buffer.alloc(400));   // content never decoded by the fake player
const cfg = {
  discord: { guildId: 'g', channelId: 'c', allowedUserId: 'U1', tokenEnv: 'DISCORD_VOICE_BOT_TOKEN' },
  stt: { cmd: ['true'] }, tts: { cmd: ['true'] },
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
  play() { this.playCalls++; setTimeout(() => this.emit('stateChange', {}, { status: 'idle' }), this.delay); }
  stop() { this.stopCalls++; this.emit('stateChange', {}, { status: 'idle' }); }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
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

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
run();
