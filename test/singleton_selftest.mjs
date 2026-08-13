// Singleton-guard selftest — two voice_loop instances must never share a
// tmpDir: the second must refuse to boot, naming the holder pid. Run under bun:
//   VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/singleton_selftest.mjs
import { createRequire } from 'module';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-singleton-'));
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

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; }

async function run() {
  check('exports acquireSingleton', typeof T.acquireSingleton === 'function');
  if (typeof T.acquireSingleton !== 'function') { console.log('\n1 FAILED'); process.exit(1); }

  // 1) fresh dir -> acquires, writes our pid
  const d1 = path.join(dir, 'fresh'); fs.mkdirSync(d1);
  const r1 = T.acquireSingleton(d1);
  check('fresh: acquires', r1.ok === true);
  check('fresh: pidfile holds our pid', fs.readFileSync(path.join(d1, 'loop.pid'), 'utf8').trim() === String(process.pid));

  // 2) live holder whose cmdline contains voice_loop -> refuses, names holder
  const d2 = path.join(dir, 'held'); fs.mkdirSync(d2);
  const sleeper = path.join(dir, 'voice_loop.js');
  fs.writeFileSync(sleeper, 'setTimeout(() => {}, 30000);\n');
  const child = spawn('bun', [sleeper], { stdio: 'ignore' });
  await delay(150); // let exec land so /proc/<pid>/cmdline shows the script path
  fs.writeFileSync(path.join(d2, 'loop.pid'), String(child.pid));
  const r2 = T.acquireSingleton(d2);
  check('held: refuses', r2.ok === false);
  check('held: names holder pid', r2.holder === child.pid);
  check('held: pidfile untouched', fs.readFileSync(path.join(d2, 'loop.pid'), 'utf8').trim() === String(child.pid));
  child.kill('SIGKILL');

  // 3) stale pidfile (dead pid) -> reclaims
  const d3 = path.join(dir, 'stale'); fs.mkdirSync(d3);
  const dead = spawn('true', [], { stdio: 'ignore' });
  const deadPid = dead.pid;
  await new Promise((r) => dead.on('exit', r));
  await delay(20);
  fs.writeFileSync(path.join(d3, 'loop.pid'), String(deadPid));
  const r3 = T.acquireSingleton(d3);
  check('stale: reclaims', r3.ok === true);
  check('stale: pidfile now ours', fs.readFileSync(path.join(d3, 'loop.pid'), 'utf8').trim() === String(process.pid));

  // 4) our own pid in the file (restart-in-place / re-acquire) -> ok
  const d4 = path.join(dir, 'self'); fs.mkdirSync(d4);
  fs.writeFileSync(path.join(d4, 'loop.pid'), String(process.pid));
  const r4 = T.acquireSingleton(d4);
  check('self: re-acquire ok', r4.ok === true);

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
run();
