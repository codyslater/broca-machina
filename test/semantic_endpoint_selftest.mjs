// Semantic-endpointing selftest — a transcript that sounds unfinished is HELD
// briefly instead of delivered; a continuation arriving inside the hold window
// is joined into one turn; no continuation -> flushed as-is. Complete
// utterances are unaffected. Run under bun:
//   VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/semantic_endpoint_selftest.mjs
import { createRequire } from 'module';
import { PassThrough } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-semantic-'));
const sttOut = path.join(dir, 'stt_out');
const cfg = {
  discord: { guildId: 'g', channelId: 'c', allowedUserId: 'U1', tokenEnv: 'DISCORD_VOICE_BOT_TOKEN' },
  stt: { cmd: ['bash', '-c', `cat ${sttOut} 2>/dev/null`] },
  tts: { cmd: ['true'] },
  transport: { type: 'file', transcriptDir: path.join(dir, 'tx'), replyFile: path.join(dir, 'reply.txt') },
  semanticEndpoint: { holdMs: 2500 },
  tmpDir: path.join(dir, 'vtmp'),
};
const cfgPath = path.join(dir, 'cfg.json');
fs.writeFileSync(cfgPath, JSON.stringify(cfg));
process.env.VOICE_CONFIG = cfgPath;
process.env.VOICE_NO_MAIN = '1';
process.env.DISCORD_VOICE_BOT_TOKEN = process.env.DISCORD_VOICE_BOT_TOKEN || 'dummy';

const mod = require(path.join(ROOT, 'src', 'voice_loop.js'));
const T = mod.__test;

const prism = require(path.join(ROOT, 'node_modules', 'prism-media'));
function feedSilence(pt, frames = 30) {
  const enc = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
  enc.on('data', (pkt) => pt.write(pkt));
  for (let i = 0; i < frames; i++) enc.write(Buffer.alloc(960 * 2 * 2));
  enc.end();
}
async function utter(text) {
  fs.writeFileSync(sttOut, text);
  const pt = new PassThrough();
  T.handleUtterance('U1', pt);
  feedSilence(pt);
  await new Promise((r) => setTimeout(r, 150)); pt.end();
  await new Promise((r) => setTimeout(r, 900));
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
function check(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; }
const txDir = path.join(dir, 'tx');
const txFiles = () => { try { return fs.readdirSync(txDir).sort(); } catch { return []; } };
const lastTx = () => { const f = txFiles(); return f.length ? fs.readFileSync(path.join(txDir, f[f.length - 1]), 'utf8') : null; };

async function run() {
  check('exports looksIncomplete', typeof T.looksIncomplete === 'function');
  if (typeof T.looksIncomplete !== 'function') { console.log('\n1 FAILED'); process.exit(1); }
  check('cfg exposes SEMANTIC', T.cfg.SEMANTIC === true);

  // heuristic battery — Whisper-punctuated inputs
  const inc = T.looksIncomplete;
  check('heuristic: dangling article', inc('So I was thinking about the') === true);
  check('heuristic: dangling article with period', inc('So I was thinking about the.') === true);
  check('heuristic: dangling conjunction', inc('and then we') === true);
  check('heuristic: trailing comma', inc('I went to the store,') === true);
  check('heuristic: complete sentence', inc('Give me the status.') === false);
  check('heuristic: question always complete', inc('what is this for?') === false);
  check('heuristic: short answer complete', inc('yes') === false);
  check('heuristic: empty is not held', inc('') === false);

  T.setPlayerForTest({ play: () => {}, on: () => {}, off: () => {}, stop: () => {} });

  // complete utterance: delivered immediately
  await utter('Give me the session status.');
  check('complete: delivered immediately', txFiles().length === 1);

  // incomplete + continuation: held, then joined into ONE delivery
  await utter('So I was thinking about the');
  check('incomplete: held (not delivered)', txFiles().length === 1);
  await utter('weekend camping trip itinerary.');
  check('continuation: delivered', txFiles().length === 2);
  check('continuation: texts joined', lastTx() === 'So I was thinking about the weekend camping trip itinerary.');

  // incomplete + silence: flushed as-is after holdMs
  await utter('and then we');
  check('flush: still held right after', txFiles().length === 2);
  await delay(2400);
  check('flush: delivered after hold window', txFiles().length === 3);
  check('flush: text as spoken', lastTx() === 'and then we');

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
run();
