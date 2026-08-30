// Address-gate selftest — utterances without a wake word are judged by a
// local LLM (with conversation context) as ADDRESSED or ASIDE; asides are
// dropped (logged + teed, no ack, no delivery), wake-word turns skip the
// judge entirely, and any judge failure fails OPEN. Run under bun:
//   VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/address_gate_selftest.mjs
import { createRequire } from 'module';
import { PassThrough } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-address-'));
const sttOut = path.join(dir, 'stt_out');
const cfg = {
  discord: { guildId: 'g', channelId: 'c', allowedUserId: 'U1', tokenEnv: 'DISCORD_VOICE_BOT_TOKEN' },
  stt: { cmd: ['bash', '-c', `cat ${sttOut} 2>/dev/null`] },
  tts: { cmd: ['true'] },
  transport: { type: 'file', transcriptDir: path.join(dir, 'tx'), replyFile: path.join(dir, 'reply.txt') },
  addressGate: { enabled: true, wakeWords: ['echo'], ollamaHost: 'http://stub.invalid', timeoutMs: 1000 },
  semanticEndpoint: { enabled: false },
  tmpDir: path.join(dir, 'vtmp'),
};
const cfgPath = path.join(dir, 'cfg.json');
fs.writeFileSync(cfgPath, JSON.stringify(cfg));
process.env.VOICE_CONFIG = cfgPath;
process.env.VOICE_NO_MAIN = '1';
process.env.DISCORD_VOICE_BOT_TOKEN = process.env.DISCORD_VOICE_BOT_TOKEN || 'dummy';

const mod = require(path.join(ROOT, 'src', 'voice_loop.js'));
const T = mod.__test;

// Stub the judge's Ollama call: scripted verdicts + capture of request bodies.
let verdict = 'ADDRESSED';
let judgeCalls = [];
let judgeMode = 'ok';   // ok | http-error | throw
globalThis.fetch = async (url, opts) => {
  judgeCalls.push(JSON.parse(opts.body));
  if (judgeMode === 'throw') throw new Error('connection refused');
  if (judgeMode === 'http-error') return { ok: false, status: 500 };
  return { ok: true, json: async () => ({ message: { content: verdict } }) };
};

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

let failed = 0;
function check(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; }
const txDir = path.join(dir, 'tx');
const txAll = () => { try { return fs.readdirSync(txDir); } catch { return []; } };
const delivered = () => txAll().filter((f) => f.endsWith('.txt')).length;
const asides = () => txAll().filter((f) => f.endsWith('.aside')).length;

async function run() {
  check('exports hasWakeWord', typeof T.hasWakeWord === 'function');
  if (typeof T.hasWakeWord !== 'function') { console.log('\n1 FAILED'); process.exit(1); }
  check('cfg exposes ADDRESS_GATE', T.cfg.ADDRESS_GATE === true);

  // wake word detection: word-boundary, case-insensitive, punctuation-proof
  check('wake: plain', T.hasWakeWord('echo give me the status') === true);
  check('wake: capitalized + comma', T.hasWakeWord('Echo, what time is it?') === true);
  check('wake: absent', T.hasWakeWord('please give me the status') === false);
  check('wake: substring does not count', T.hasWakeWord('the echoes were loud') === false);

  // FUZZY WAKE WORD (2026-08-29). STT mangles a short name every session; a
  // missed wake word routes a directly-addressed turn to the judge, which is
  // where it dies. Live loss: a directly-addressed "hey <mangled name>, give me an update".
  check('fuzzy: one-edit substitution', T.hasWakeWord('ecko give me the status') === true);
  check('fuzzy: one-edit deletion', T.hasWakeWord('eco give me the status') === true);
  check('fuzzy: two edits do NOT match', T.hasWakeWord('the eckoo was loud') === false);
  check('fuzzy: helper is symmetric on one edit', T.withinOneEdit('junk', 'juno') === true
        && T.withinOneEdit('jun', 'juno') === true && T.withinOneEdit('junos', 'juno') === true);
  check('fuzzy: helper rejects two edits', T.withinOneEdit('echoes', 'echo') === false);
  // The stoplist is what keeps fuzziness from disabling the gate outright:
  // a 4-letter wake word is one edit from `that`, which appears in half of all speech.
  check('fuzzy: common words are stoplisted', T.wakeStopwords.has('that')
        && T.wakeStopwords.has('than') && T.wakeStopwords.has('the'));

  T.setPlayerForTest({ play: () => {}, on: () => {}, off: () => {}, stop: () => {} });

  // wake word -> delivered instantly, judge never consulted
  await utter('echo give me the session status.');
  check('wakeword: delivered', delivered() === 1);
  check('wakeword: judge not consulted', judgeCalls.length === 0);

  // no wake word, judge says ADDRESSED -> delivered
  verdict = 'ADDRESSED';
  await utter('and how is the training run going?');
  check('addressed: delivered', delivered() === 2);
  check('addressed: judge consulted once', judgeCalls.length === 1);

  // judge sees recent conversation context in its request
  const msgs = judgeCalls[0].messages;
  check('judge: carries conversation context', msgs.length >= 3 && msgs.some((m) => m.role === 'assistant' || m.role === 'user'));

  // no wake word, judge says ASIDE -> dropped: no delivery, teed as aside, no ack armed
  verdict = 'ASIDE';
  T.acked.set(false);
  await utter('yeah just put it on the counter, thanks.');
  check('aside: not delivered', delivered() === 2);
  check('aside: teed for the record', asides() === 1);
  check('aside: ack disarmed', T.ack.get() === 0);

  // hot window: speech landing shortly after the assistant finished talking is
  // a reply to it — delivered WITHOUT consulting the judge, even when the
  // judge would have said ASIDE. (Observed live 2026-08-13..16: four "Yeah, …"
  // replies to the assistant judged ASIDE and dropped.)
  check('exports setBotSpeechEndedForTest', typeof T.setBotSpeechEndedForTest === 'function');
  if (typeof T.setBotSpeechEndedForTest === 'function') {
    verdict = 'ASIDE';
    const callsBefore = judgeCalls.length;
    T.setBotSpeechEndedForTest(Date.now());
    await utter('yeah go ahead and make it live.');
    check('hot window: delivered despite ASIDE verdict', delivered() === 3);
    check('hot window: judge not consulted', judgeCalls.length === callsBefore);
    T.setBotSpeechEndedForTest(0);   // cold again for the sections below
  } else {
    check('hot window: delivered despite ASIDE verdict', false);
    check('hot window: judge not consulted', false);
  }

  // HOT WHILE WORKING (2026-08-29). A wall-clock window is measured from the
  // assistant's last WORD, so a long silent tool run makes the channel read
  // cold while the exchange is plainly still open. `ackArmedAt > 0` means a
  // turn was sent and no reply has landed — the user waiting through that is
  // in the same conversation, whatever the clock says.
  check('exports channelIsHot', typeof T.channelIsHot === 'function');
  {
    verdict = 'ASIDE';
    const callsBefore = judgeCalls.length;
    const deliveredBefore = delivered();
    T.setBotSpeechEndedForTest(Date.now() - 3600000);   // last spoke an hour ago
    check('hot: clock alone reads COLD', T.channelIsHot() === false);
    T.ack.set(Date.now());                              // ...but a reply is owed
    check('hot: an owed reply reads HOT', T.channelIsHot() === true);
    await utter('yeah go ahead and discard those.');
    check('hot: owed reply delivers despite ASIDE verdict', delivered() === deliveredBefore + 1);
    check('hot: owed reply skips the judge', judgeCalls.length === callsBefore);
    // The latch must not outlive its reply: markBotSpoke() clears it wherever the
    // assistant finishes speaking, so a settled channel goes cold again on its own.
    T.ack.set(0);
    T.setReplyOwedForTest(0);
    T.setBotSpeechEndedForTest(0);
    check('hot: cold again once the reply is settled', T.channelIsHot() === false);
  }

  // judge prompt explicitly marks continuations/agreements as ADDRESSED
  check('judge: prompt marks continuations as ADDRESSED', judgeCalls[0].messages[0].content.includes('continuation'));
  // ...and first-person task narration ("I'm going to go ahead and sack one
  // zero zero three" — live FP 2026-08-16 21:26, dropped a lab-record turn).
  check('judge: prompt marks first-person narration as ADDRESSED', judgeCalls[0].messages[0].content.includes('narrat'));

  // judge failure fails OPEN — connection refused and http-500 both deliver
  judgeMode = 'throw';
  let before = delivered();
  await utter('what about the second checkpoint file?');
  check('fail-open: connection error delivers', delivered() === before + 1);
  judgeMode = 'http-error';
  before = delivered();
  await utter('did the export finish overnight?');
  check('fail-open: http error delivers', delivered() === before + 1);

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
run();
