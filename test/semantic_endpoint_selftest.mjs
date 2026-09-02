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
  // Observed live 2026-08-16: "Tell me what we're working on." held 4s because
  // "on" sat in the connective list. Prepositions are SOFT — English sentences
  // end on them constantly, so Whisper's own terminal period marks a real end;
  // hard connectives ("and.", "the.") stay held even with a period.
  check('heuristic: preposition-final sentence with period complete', inc("Tell me what we're working on.") === false);
  check('heuristic: preposition-final command with period complete', inc('Turn it on.') === false);
  check('heuristic: dangling preposition without period still held', inc('tell me what we are working on') === true);
  check('heuristic: hard connective with period still held', inc('I went there and.') === true);
  // Live 2026-08-13..29: 26 holds, 0 joins — every trigger was a sentence-
  // final object pronoun ("start it.", "do that.", "Thank you.") sitting in
  // the HARD set, so Whisper's own terminal period was ignored and each turn
  // paid holdMs for nothing. Object pronouns are SOFT like prepositions:
  // complete with a period, held without one. Subject pronouns stay hard.
  check('heuristic: object pronoun with period complete', inc('Oh, go ahead and start it.') === false);
  check('heuristic: demonstrative with period complete', inc("No, you don't need to do that.") === false);
  check('heuristic: thank you complete', inc('Okay, fantastic work. Thank you.') === false);
  check('heuristic: revisit it complete', inc('So we need to revisit it.') === false);
  check('heuristic: object pronoun without period still held', inc('so I was going to do it') === true);
  check('heuristic: subject pronoun with period still held', inc('and then we.') === true);

  // isNoise — the phantom filter, per SENTENCE. Live 2026-08-25: "Thank you.
  // Thank you." (two repeats dodge the >=3 repetition filter in stt.py and the
  // whole-text noise list) was held 4s, then DELIVERED to the brain and fired
  // a filler — seven times across the log. A transcript whose every sentence
  // is a noise phrase or a sub-3-char fragment is a hallucination.
  check('exports isNoise', typeof T.isNoise === 'function');
  if (typeof T.isNoise === 'function') {
    check('noise: whole-text list entry', T.isNoise('Thank you.') === true);
    check('noise: repeated stock phrase', T.isNoise('Thank you.  Thank you.') === true);
    check('noise: stock phrase plus one-letter fragment', T.isNoise('Thank you.  I.  Thank you.') === true);
    check('noise: real sentence before thanks is speech', T.isNoise('Okay, fantastic work. Thank you.') === false);
    check('noise: short real answer is speech', T.isNoise('Yes.') === false);
    check('noise: under three chars', T.isNoise('ok') === true);
  } else {
    for (const n of ['noise: whole-text list entry', 'noise: repeated stock phrase',
      'noise: stock phrase plus one-letter fragment', 'noise: real sentence before thanks is speech',
      'noise: short real answer is speech', 'noise: under three chars']) check(n, false);
  }

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

  // e2e: a repeated stock phrase is dropped outright — neither held (no 4s
  // wait, no filler) nor delivered after the hold window.
  await utter('Thank you.  Thank you.');
  check('noise e2e: not delivered', txFiles().length === 3);
  await delay(2600);
  check('noise e2e: not delivered after hold window either', txFiles().length === 3);

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
run();
