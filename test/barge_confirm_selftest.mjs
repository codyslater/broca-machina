// Duck-don't-die barge-in selftest — a speaking-start during bot playback
// DUCKS the audio instead of killing it; only an utterance that survives STT
// (real speech) interrupts and drops the queue, and a phantom (noise blob,
// empty STT) just restores the volume. Run under bun:
//   VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/barge_confirm_selftest.mjs
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-barge-'));
const cfg = {
  discord: { guildId: 'g', channelId: 'c', allowedUserId: 'U1', tokenEnv: 'DISCORD_VOICE_BOT_TOKEN' },
  stt: { cmd: ['true'] }, tts: { cmd: ['true'] },
  transport: { type: 'file', transcriptDir: path.join(dir, 'tx'), replyFile: path.join(dir, 'reply.txt') },
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

function fakeResource(base) {
  const calls = [];
  return { calls, _base: base, volume: { setVolume: (v) => calls.push(v) } };
}

async function run() {
  check('exports duck/restore/confirm', typeof T.duckPlayback === 'function'
    && typeof T.restorePlayback === 'function' && typeof T.confirmBarge === 'function'
    && typeof T.setResourceForTest === 'function');
  if (typeof T.duckPlayback !== 'function') { console.log('\n1 FAILED'); process.exit(1); }

  check('config: confirm mode on by default', T.cfg.BARGE_CONFIRM === true);

  // duck with no active resource: harmless no-op
  T.setResourceForTest(null);
  T.duckPlayback();
  check('no resource: not ducked', T.state().ducked === false);

  // duck drops volume to 30% of the resource's base; restore brings it back
  const r = fakeResource(1);
  T.setResourceForTest(r);
  T.duckPlayback();
  check('duck: state flagged', T.state().ducked === true);
  check('duck: volume reduced', r.calls.length === 1 && Math.abs(r.calls[0] - 0.3) < 1e-9);
  T.restorePlayback();
  check('restore: state cleared', T.state().ducked === false);
  check('restore: volume back to base', r.calls.length === 2 && r.calls[1] === 1);

  // ducking respects a quieter base (the earcon's 0.15)
  const r2 = fakeResource(0.15);
  T.setResourceForTest(r2);
  T.duckPlayback();
  check('duck: scales quiet base', Math.abs(r2.calls[0] - 0.045) < 1e-9);
  T.restorePlayback();

  // confirm: real speech -> player stopped, queue dropped, duck cleared
  const stops = [];
  T.setPlayerForTest({ play: () => {}, on: () => {}, off: () => {}, stop: () => stops.push(1) });
  const r3 = fakeResource(1);
  T.setResourceForTest(r3);
  T.duckPlayback();
  T.enqueueReply('unspoken tail');
  T.confirmBarge();
  check('confirm: duck cleared', T.state().ducked === false);
  check('confirm: player stopped', stops.length >= 1);
  check('confirm: queue dropped', T.state().replyQueueLen === 0);
  check('confirm: botSpeaking cleared', T.state().botSpeaking === false);

  // confirm with nothing playing and empty queue: quiet no-op (no stray stop)
  const stopsBefore = stops.length;
  T.setResourceForTest(null);
  T.confirmBarge();
  check('confirm idle: no stray player.stop', stops.length === stopsBefore);

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
run();
