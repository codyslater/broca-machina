// Presence-gated auto-join lifecycle selftest — drives the state machine in
// src/voice_loop.js with no live Discord gateway. Run under bun:
//   VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/lifecycle_selftest.mjs
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// --- build a throwaway config with a short idle-leave and recorder hooks ------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-lifecycle-'));
const REC = path.join(dir, 'hooks.log');
const PRESENCE = path.join(dir, 'present');
const cfg = {
  discord: { guildId: 'g', channelId: 'c', allowedUserId: 'U1', tokenEnv: 'DISCORD_VOICE_BOT_TOKEN' },
  stt: { cmd: ['true'] }, tts: { cmd: ['true'] },
  transport: { type: 'file', transcriptDir: path.join(dir, 'tx'), replyFile: path.join(dir, 'reply.txt') },
  presenceFile: PRESENCE,
  autoJoin: true,
  idleLeaveMs: 200,
  onPresenceEnter: { cmd: ['bash', '-c', `echo enter >> ${REC}`] },
  onPresenceLeave: { cmd: ['bash', '-c', `echo leave >> ${REC}`] },
  tmpDir: path.join(dir, 'vtmp'),
};
const cfgPath = path.join(dir, 'cfg.json');
fs.writeFileSync(cfgPath, JSON.stringify(cfg));
process.env.VOICE_CONFIG = cfgPath;
process.env.VOICE_NO_MAIN = '1';
process.env.DISCORD_VOICE_BOT_TOKEN = process.env.DISCORD_VOICE_BOT_TOKEN || 'dummy';

const mod = require(path.join(ROOT, 'src', 'voice_loop.js'));
const T = mod.__test;

// --- stub the Discord-touching seam: count calls, no real gateway ------------
let connectCalls = 0, disconnectCalls = 0;
T.io.connect = async () => { connectCalls++; };
T.io.disconnect = () => { disconnectCalls++; };

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const recCount = (w) => { try { return fs.readFileSync(REC, 'utf8').split('\n').filter((l) => l === w).length; } catch { return 0; } };

let failed = 0;
function check(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; }

async function run() {
  check('config: AUTO_JOIN true', T.cfg.AUTO_JOIN === true);
  check('config: idleLeaveMs=200', T.cfg.IDLE_LEAVE_MS === 200);
  check('start: not connected', T.state().connected === false && T.state().hasLeaveTimer === false);

  // 1) user joins -> enterChannel (async, not awaited by handler) -> settle
  T.handleVoiceState(true, false, 'U1');
  await delay(30);
  check('join: connected', T.state().connected === true);
  check('join: connect() called once', connectCalls === 1);
  check('join: onPresenceEnter fired', recCount('enter') === 1);
  check('join: presence marker written', fs.existsSync(PRESENCE));
  check('join: no leave timer', T.state().hasLeaveTimer === false);

  // 2) redundant join -> idempotent, no second connect
  T.handleVoiceState(true, false, 'U1');
  await delay(30);
  check('rejoin-while-connected: no double connect', connectCalls === 1);

  // 3) user leaves -> idle-leave timer armed, still connected
  T.handleVoiceState(false, true, 'U1');
  check('leave-edge: timer armed', T.state().hasLeaveTimer === true);
  check('leave-edge: still connected (grace)', T.state().connected === true);
  check('leave-edge: presence marker removed', !fs.existsSync(PRESENCE));

  // 4) quick rejoin BEFORE timeout -> timer canceled, no leave, no reconnect
  T.handleVoiceState(true, false, 'U1');
  await delay(30);
  check('quick-rejoin: leave timer canceled', T.state().hasLeaveTimer === false);
  check('quick-rejoin: still connected', T.state().connected === true);
  check('quick-rejoin: no leave hook yet', recCount('leave') === 0);
  check('quick-rejoin: no reconnect', connectCalls === 1);

  // 5) leave and let the idle timer fire -> leaveChannel + spin-down hook
  T.handleVoiceState(false, true, 'U1');
  check('leave-again: timer armed', T.state().hasLeaveTimer === true);
  await delay(320);
  check('idle-timeout: disconnected', T.state().connected === false);
  check('idle-timeout: disconnect() called once', disconnectCalls === 1);
  check('idle-timeout: onPresenceLeave fired', recCount('leave') === 1);
  check('idle-timeout: timer cleared', T.state().hasLeaveTimer === false);

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
run();
