// Interrupt-context selftest — when the user talks over a reply, the queued
// tail is dropped and playback stops, but the brain never learns that: it
// believes the whole answer was heard and continues from there. The very
// next transcript now opens with a bracketed note naming what was being said
// when the user cut in, on every transport, one-shot. Run under bun:
//   VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/interrupt_context_selftest.mjs
import { createRequire } from 'module';
import { PassThrough } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-interrupt-'));
const queueFile = path.join(dir, 'stt_lines');
fs.writeFileSync(queueFile, '');
const ttsStub = path.join(dir, 'tts_stub.sh');
const holdFile = path.join(dir, 'HOLD');   // while present, synthesis blocks
fs.writeFileSync(ttsStub, `#!/usr/bin/env bash\nwhile [ -f "${holdFile}" ]; do sleep 0.05; done\nhead -c 200 /dev/zero > "$2" 2>/dev/null || true\n`);
fs.chmodSync(ttsStub, 0o755);
const cfg = {
  discord: { guildId: 'g', channelId: 'c', allowedUserId: 'U1', tokenEnv: 'DISCORD_VOICE_BOT_TOKEN' },
  stt: { cmd: ['bash', '-c', `sleep 0.2; head -1 ${queueFile}; sed -i 1d ${queueFile}`] },
  tts: { cmd: ['bash', ttsStub] },
  transport: { type: 'file', transcriptDir: path.join(dir, 'tx'), replyFile: path.join(dir, 'reply.txt') },
  duckAfterMs: 50,
  // pipelined so the note quotes the CHUNK being spoken; two-sentence replies
  // split deterministically at the sentence boundary under a 50-char cap
  ttsPipeline: { enabled: true, minChars: 40, maxChunkChars: 50 },
  semanticEndpoint: { enabled: false },
  tmpDir: path.join(dir, 'vtmp'),
};
const cfgPath = path.join(dir, 'cfg.json');
fs.writeFileSync(cfgPath, JSON.stringify(cfg));
process.env.VOICE_CONFIG = cfgPath;
process.env.VOICE_NO_MAIN = '1';
process.env.DISCORD_VOICE_BOT_TOKEN = process.env.DISCORD_VOICE_BOT_TOKEN || 'dummy';

const T = require(path.join(ROOT, 'src', 'voice_loop.js')).__test;

let failed = 0;
function check(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; }
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const txDir = path.join(dir, 'tx');
const delivered = () => { try { return fs.readdirSync(txDir).filter((f) => f.endsWith('.txt')).sort(); } catch { return []; } };
const lastTx = () => { const f = delivered(); return f.length ? fs.readFileSync(path.join(txDir, f[f.length - 1]), 'utf8') : null; };

const prism = require(path.join(ROOT, 'node_modules', 'prism-media'));
function feedSpeech(pt, frames = 40) {
  const enc = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
  enc.on('data', (pkt) => pt.write(pkt));
  for (let i = 0; i < frames; i++) enc.write(Buffer.alloc(960 * 2 * 2));
  enc.end();
}
let subscribed = [];
const fakeConn = { subscribe: () => {}, destroy: () => {},
  receiver: { subscribe: () => { const pt = new PassThrough(); subscribed.push(pt); return pt; }, speaking: { on: () => {} } } };
// A player whose playback only ends when it is STOPPED (a long reply).
function longPlayer() {
  const ls = [];
  return {
    plays: 0, stops: 0,
    on(ev, cb) { if (ev === 'stateChange') ls.push(cb); },
    off(ev, cb) { const i = ls.indexOf(cb); if (i >= 0) ls.splice(i, 1); },
    play() { this.plays++; },
    stop() { this.stops++; for (const cb of ls.slice()) cb({ status: 'playing' }, { status: 'idle' }); },
  };
}
async function utter(text) {
  fs.appendFileSync(queueFile, `${text}\n`);
  const n = subscribed.length;
  T.onSpeakingStart('U1');
  feedSpeech(subscribed[n]);
  await delay(150); subscribed[n].end();
  await delay(1200);
}

async function run() {
  T.setConnForTest(fakeConn);
  const p = longPlayer();
  T.setPlayerForTest(p);
  T.setPresence(true);

  // A reply is being voiced...
  const first = 'First sentence of the reply, spoken first.';
  T.enqueueReply(`${first} Second sentence of the reply follows after that.`);
  T.pollReply();
  await delay(300);
  check('reply is playing', p.plays === 1 && T.state().botSpeaking === true);

  // ...and the user talks over it with something that earns an interrupt.
  await utter('okay please stop reading that now');
  check('barge: playback interrupted', p.stops >= 1 && T.state().botSpeaking === false);
  check('barge: transcript delivered', delivered().length === 1);
  const tx1 = lastTx() || '';
  check('barge: transcript opens with the interrupt note', /^\[You were interrupted while saying: "/.test(tx1));
  check('barge: note quotes the chunk being spoken', tx1.includes(`"${first}"`));
  check('barge: the utterance itself follows the note', tx1.endsWith('okay please stop reading that now'));

  // The note is one-shot: the next turn is plain.
  await utter('and now a normal follow up question');
  check('next turn: plain transcript, no note', lastTx() === 'and now a normal follow up question');

  // Live 2026-09-03 23:35:20Z: the verdict landed while the pipelined reply's
  // FIRST chunk was still synthesizing — botSpeaking was already true, the
  // barge was confirmed, but nothing had been marked as "being said" yet, so
  // the brain got a bare transcript. Hold synthesis, interrupt, release.
  fs.writeFileSync(holdFile, '');
  const held = 'Held reply that never reaches the speaker.';
  T.enqueueReply(`${held} Its second sentence would have followed.`);
  await delay(400);                                  // picked up, stuck in synth
  check('held: reply claimed the floor before any audio', T.state().botSpeaking === true && p.plays === 1);
  await utter('please stop talking right now');
  fs.unlinkSync(holdFile);
  await delay(400);
  const tx3 = lastTx() || '';
  check('held: interruption during synthesis still produces the note', tx3.includes(`"${held}"`));
  check('held: nothing played after the interrupt', p.plays === 1 && T.state().botSpeaking === false);

  // A phantom edge over playback that STT rejects is not an interruption.
  T.enqueueReply('Another reply the user does not interrupt.');
  await delay(300);
  await utter('');                                   // empty STT -> phantom, volume restored
  check('phantom: playback untouched', T.state().botSpeaking === true);
  p.stop(); await delay(300);                        // let it finish naturally
  await utter('what did that last one say');
  check('after an uninterrupted reply: no note', lastTx() === 'what did that last one say');

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
run();
