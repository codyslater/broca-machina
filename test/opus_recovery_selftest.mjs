// Opus WASM auto-recovery selftest — one corrupted decode poisons opusscript's
// shared WASM heap and every later decode throws "Out of bounds memory access":
// the loop goes deaf until process restart (live 2026-08-13 and 2026-08-16,
// 143-crash storm). Recovery drops the poisoned modules from the require cache
// and re-requires prism-media — a fresh WASM instance with a clean heap. The
// crash guard triggers it after 3 opus-shaped crashes inside 60s. Run:
//   VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/opus_recovery_selftest.mjs
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-opusrec-'));
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

function opusCrash() {
  const e = new Error('Out of bounds memory access');
  e.stack = `RuntimeError: Out of bounds memory access
    at OpusScriptHandler$_decode (${ROOT}/node_modules/opusscript/build/opusscript_native_wasm.js:11:17)
    at decode (${ROOT}/node_modules/prism-media/src/opus/Opus.js:204:22)`;
  return e;
}

async function run() {
  check('exports noteOpusCrash/getPrismForTest', typeof T.noteOpusCrash === 'function'
    && typeof T.getPrismForTest === 'function');
  if (typeof T.noteOpusCrash !== 'function') { console.log(`\n${failed} FAILED`); process.exit(1); }

  // Unrelated crashes never trigger recovery, however many arrive.
  const boring = new Error('write EPIPE');
  check('unrelated crash ignored', T.noteOpusCrash(boring) === false
    && T.noteOpusCrash(boring) === false && T.noteOpusCrash(boring) === false);

  // Opus-shaped crashes: 1st and 2nd tolerated, 3rd inside the window reloads.
  const before = T.getPrismForTest();
  check('opus crash 1: tolerated', T.noteOpusCrash(opusCrash()) === false);
  check('opus crash 2: tolerated', T.noteOpusCrash(opusCrash()) === false);
  check('opus crash 3: triggers reload', T.noteOpusCrash(opusCrash()) === true);
  const after = T.getPrismForTest();
  check('reload: fresh prism-media module', after !== before && !!after && !!after.opus);

  // Counter resets after a reload — the next opus crash starts a new window.
  check('post-reload: counter reset', T.noteOpusCrash(opusCrash()) === false);

  // The reloaded module actually works: encode one silence frame, decode it
  // back to PCM. This is the deaf-until-restart failure exercised for real.
  const enc = new after.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
  const packets = [];
  enc.on('data', (p) => packets.push(p));
  enc.write(Buffer.alloc(960 * 2 * 2));
  await new Promise((r) => setTimeout(r, 200));
  check('reload: encoder produces packets', packets.length >= 1);
  const dec = new after.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const pcm = [];
  dec.on('data', (d) => pcm.push(d));
  if (packets.length) dec.write(packets[0]);
  await new Promise((r) => setTimeout(r, 200));
  check('reload: decoder round-trips PCM', pcm.length >= 1 && pcm[0].length === 960 * 2 * 2);

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
run();
