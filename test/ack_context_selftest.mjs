// localAck context-window selftest — the instant-ack model must see a rolling
// window of recent turns so fillers continue the thread instead of cold-opening.
// Run under bun:
//   VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/ack_context_selftest.mjs
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-ackctx-'));
const cfg = {
  discord: { guildId: 'g', channelId: 'c', allowedUserId: 'U1', tokenEnv: 'DISCORD_VOICE_BOT_TOKEN' },
  stt: { cmd: ['true'] }, tts: { cmd: ['true'] },
  transport: { type: 'file', transcriptDir: path.join(dir, 'tx'), replyFile: path.join(dir, 'reply.txt') },
  localAck: { enabled: true, ollamaHost: 'http://stub.invalid' },
  tmpDir: path.join(dir, 'vtmp'),
};
const cfgPath = path.join(dir, 'cfg.json');
fs.writeFileSync(cfgPath, JSON.stringify(cfg));
process.env.VOICE_CONFIG = cfgPath;
process.env.VOICE_NO_MAIN = '1';
process.env.DISCORD_VOICE_BOT_TOKEN = process.env.DISCORD_VOICE_BOT_TOKEN || 'dummy';

const mod = require(path.join(ROOT, 'src', 'voice_loop.js'));
const T = mod.__test;

// Stub the Ollama HTTP seam: capture each request body, return empty content
// (dispatch bails after the capture — no TTS, no queueing, exactly what we want).
let lastBody = null;
globalThis.fetch = async (url, opts) => {
  lastBody = JSON.parse(opts.body);
  return { ok: true, json: async () => ({ message: { content: '' } }) };
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; }

async function run() {
  check('exports recordTurn + clearTurns', typeof T.recordTurn === 'function' && typeof T.clearTurns === 'function');
  if (typeof T.recordTurn !== 'function') { console.log('\n1 FAILED'); process.exit(1); }

  // 1) no history -> [system, current user] (baseline shape unchanged)
  T.clearTurns();
  await T.dispatchLocalAck('what is the plan', 0);
  check('bare: 2 messages', lastBody.messages.length === 2);
  check('bare: current utterance last', lastBody.messages[1].role === 'user' && lastBody.messages[1].content === 'what is the plan');

  // 2) recorded turns ride the request, in order, between system and current
  T.clearTurns();
  T.recordTurn('user', 'how are the sessions doing');
  T.recordTurn('assistant', 'Two sessions active, both healthy.');
  await T.dispatchLocalAck('and the gpu one', 0);
  const m = lastBody.messages;
  check('history: 4 messages', m.length === 4);
  check('history: user turn first', m[1].role === 'user' && m[1].content === 'how are the sessions doing');
  check('history: assistant turn second', m[2].role === 'assistant' && m[2].content === 'Two sessions active, both healthy.');
  check('history: current last', m[3].role === 'user' && m[3].content === 'and the gpu one');

  // 3) window caps at 6 — oldest dropped
  T.clearTurns();
  for (let i = 1; i <= 10; i++) T.recordTurn('user', `turn ${i}`);
  await T.dispatchLocalAck('now', 0);
  const hist = lastBody.messages.slice(1, -1);
  check('cap: 6 history entries', hist.length === 6);
  check('cap: oldest surviving is turn 5', hist[0].content === 'turn 5');
  check('cap: newest is turn 10', hist[5].content === 'turn 10');

  // 4) long turns truncate to 200 chars
  T.clearTurns();
  T.recordTurn('assistant', 'x'.repeat(500));
  await T.dispatchLocalAck('ok', 0);
  check('truncate: 200 chars', lastBody.messages[1].content.length === 200);

  // 5) system prompt teaches thread continuation only when history present
  check('sysprompt: continuation line present', /continue.*thread/i.test(lastBody.messages[0].content));
  T.clearTurns();
  await T.dispatchLocalAck('ok', 0);
  check('sysprompt: bare prompt without history', !/continue.*thread/i.test(lastBody.messages[0].content));

  // 6) wiring: sendTranscript records a user turn
  T.clearTurns();
  T.sendTranscript('hello from voice');
  await delay(20);
  await T.dispatchLocalAck('next', 0);
  check('wiring: transcript recorded as user turn',
    lastBody.messages.length === 3 && lastBody.messages[1].role === 'user' && lastBody.messages[1].content === 'hello from voice');

  // 7) wiring: speak() records an assistant turn (fake player, dud TTS is fine)
  T.clearTurns();
  T.setPlayerForTest({ play: () => {}, on: () => {}, off: () => {}, stop: () => {} });
  await T.speak('Here is the answer.');
  await T.dispatchLocalAck('next', 0);
  check('wiring: spoken reply recorded as assistant turn',
    lastBody.messages.length === 3 && lastBody.messages[1].role === 'assistant' && lastBody.messages[1].content === 'Here is the answer.');

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
run();
