// Unit selftest for the TTS sentence-boundary splitter (task 2 pipelining).
// Drives src/voice_loop.js's pure splitSentences() with no Discord/TTS — the
// module is loaded with VOICE_NO_MAIN=1 exactly like the lifecycle selftest.
//   VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/tts_pipeline_selftest.mjs
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-tts-'));
const cfg = {
  discord: { guildId: 'g', channelId: 'c', allowedUserId: 'U1', tokenEnv: 'DISCORD_VOICE_BOT_TOKEN' },
  stt: { cmd: ['true'] }, tts: { cmd: ['true'] },
  transport: { type: 'file', transcriptDir: path.join(dir, 'tx'), replyFile: path.join(dir, 'reply.txt') },
  // enable pipelining so the exported config flag reflects it
  ttsPipeline: { enabled: true, minChars: 120, maxChunkChars: 240 },
  tmpDir: path.join(dir, 'vtmp'),
};
const cfgPath = path.join(dir, 'cfg.json');
fs.writeFileSync(cfgPath, JSON.stringify(cfg));
process.env.VOICE_CONFIG = cfgPath;
process.env.VOICE_NO_MAIN = '1';
process.env.DISCORD_VOICE_BOT_TOKEN = process.env.DISCORD_VOICE_BOT_TOKEN || 'dummy';

const mod = require(path.join(ROOT, 'src', 'voice_loop.js'));
const T = mod.__test;
const split = T.splitSentences;

let failed = 0;
function check(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; }

// 1) config flag wired
check('config: TTS_PIPE enabled', T.cfg.TTS_PIPE === true);

// 2) multi-sentence reply: a small cap forces >1 ordered chunk that rejoins to
//    the source words (barge-in ordering guarantee rests on this)
const reply = 'First sentence here. Second sentence follows! And a third one? Then a final clause.';
const parts = split(reply, 40);
check('multi-sentence: splits into >1 chunk (cap 40)', parts.length > 1);
check('multi-sentence: order preserved (rejoin == source words)',
  parts.join(' ').replace(/\s+/g, ' ').trim() === reply.replace(/\s+/g, ' ').trim());
check('multi-sentence: first chunk starts the reply', reply.startsWith(parts[0]));

// 2b) same reply under a generous cap stays ONE chunk (short replies don't pipeline)
check('multi-sentence: merges under a large cap', split(reply, 240).length === 1);

// 3) single short sentence -> single chunk (would stay one-shot in speak())
const one = split('Just one short sentence.', 240);
check('single sentence: one chunk', one.length === 1);

// 4) chunk cap respected + merges small sentences up to the cap
const many = split('A. B. C. D. E. F. G. H. I. J. K. L. M.', 10);
check('cap: no chunk exceeds max', many.every((p) => p.length <= 10));
check('cap: merges tiny sentences (fewer chunks than sentences)', many.length < 13 && many.length > 1);

// 5) a single oversize sentence (no boundaries) is hard-split, still within cap
const longWord = 'word '.repeat(120).trim();     // 600 chars, no . ! ?
const hard = split(longWord, 100);
check('oversize: hard-split into multiple chunks', hard.length > 1);
check('oversize: every chunk within cap', hard.every((p) => p.length <= 100));
check('oversize: no content dropped', hard.join(' ').replace(/\s+/g, ' ').trim() === longWord);

// 6) newlines act as boundaries (small cap so the two lines can't merge)
const nl = split('Line one is fairly long here.\nLine two is also here.', 30);
check('newline: splits on newline', nl.length === 2);

// 7) ackDue() — the "still thinking" ack predicate (fires afterMs past end-of-speech)
const ackDue = T.ackDue;
check('ack: disabled when afterMs<=0', ackDue(10_000, 5_000, false, 0) === false);
check('ack: not due before the window', ackDue(5_400, 5_000, false, 600) === false);
check('ack: due at the window boundary (>=)', ackDue(5_600, 5_000, false, 600) === true);
check('ack: due past the window', ackDue(9_000, 5_000, false, 600) === true);
check('ack: one-shot — not due once acked', ackDue(9_000, 5_000, true, 600) === false);
check('ack: not due with no turn armed (armedAt=0)', ackDue(9_000, 0, false, 600) === false);

// 8) pickAckIndex() — phrase rotation (random, never the same twice in a row)
const pick = T.pickAckIndex;
check('ackpick: no phrases -> -1', pick(0, -1, 0.5) === -1);
check('ackpick: single phrase always 0 (repeat allowed)', pick(1, 0, 0.99) === 0);
{
  // sweep r across [0,1): always in bounds, never returns lastIdx when count>1
  let inBounds = true, noRepeat = true, seen = new Set();
  for (const last of [-1, 0, 1, 3]) {
    for (let k = 0; k < 100; k++) {
      const i = pick(4, last, k / 100);
      if (i < 0 || i > 3) inBounds = false;
      if (last >= 0 && i === last) noRepeat = false;
      if (last === 0) seen.add(i);
    }
  }
  check('ackpick: always in bounds (incl. r→1 edge)', inBounds && pick(4, -1, 0.9999) === 3);
  check('ackpick: never repeats the last phrase (count>1)', noRepeat);
  check('ackpick: still reaches every other phrase', seen.size === 3);
}

// 9) cleanForTTS() — the sanitizer every spoken reply passes through
const clean = T.cleanForTTS;
check('clean: code fence stripped', clean('before ```js\ncode();\n``` after') === 'before after');
check('clean: inline code unwrapped', clean('run `ls -la` now') === 'run ls -la now');
check('clean: bold/italic unwrapped', clean('**bold** and *ital* text') === 'bold and ital text');
check('clean: URL becomes "a link"', clean('see https://example.com/x?y=1 ok') === 'see a link ok');
check('clean: emoji stripped', clean('done 🎉✅ next') === 'done next');
check('clean: md chars stripped + whitespace collapsed', clean('# head > quote _u_ ~s~ |t|') === 'head quote u s t');
check('clean: truncated to maxReplyChars (700 default)', clean('x'.repeat(800)).length === 700);
check('clean: plain speech untouched', clean('Just a plain sentence.') === 'Just a plain sentence.');

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
