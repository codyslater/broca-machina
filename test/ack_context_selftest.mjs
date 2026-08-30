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
  check('bare: no background block', !/BACKGROUND/.test(lastBody.messages[0].content));

  // 2) history rides INSIDE the system message as a labelled BACKGROUND block,
  //    never as trailing chat turns: a 4B model treats the last chat turns as
  //    the thing to respond to, which is exactly how acks came out 1-2 turns
  //    stale (CS, live 2026-08-30). The newest utterance must be the ONLY
  //    user message in the request.
  T.clearTurns();
  T.recordTurn('user', 'how are the sessions doing');
  T.recordTurn('assistant', 'Two sessions active, both healthy.');
  await T.dispatchLocalAck('and the gpu one', 0);
  const m = lastBody.messages;
  check('history: still exactly 2 messages', m.length === 2);
  const sys = m[0].content;
  check('history: background block present', /BACKGROUND/.test(sys));
  check('history: user turn in block', sys.includes('User: how are the sessions doing'));
  check('history: assistant turn in block', sys.includes('Assistant: Two sessions active, both healthy.'));
  check('history: order preserved', sys.indexOf('how are the sessions') < sys.indexOf('Two sessions active'));
  check('history: newest is the only user message', m[1].role === 'user' && m[1].content === 'and the gpu one');
  check('history: newest-only instruction present', /ONLY the newest/i.test(sys));

  // 3) window caps at 6 — oldest dropped
  T.clearTurns();
  for (let i = 1; i <= 10; i++) T.recordTurn('user', `turn ${i}`);
  await T.dispatchLocalAck('now', 0);
  {
    const s3 = lastBody.messages[0].content;
    check('cap: 6 history entries', (s3.match(/User: turn /g) || []).length === 6);
    check('cap: oldest surviving is turn 5', !s3.includes('turn 4') && s3.includes('User: turn 5'));
    check('cap: newest is turn 10', s3.includes('User: turn 10'));
  }

  // 4) long turns truncate to 200 chars before entering the block
  T.clearTurns();
  T.recordTurn('assistant', 'x'.repeat(500));
  await T.dispatchLocalAck('ok', 0);
  check('truncate: 200 chars', /Assistant: x{200}(?!x)/.test(lastBody.messages[0].content));

  // 5) newest-only guidance rides only when history is present
  T.clearTurns();
  await T.dispatchLocalAck('ok', 0);
  check('sysprompt: bare prompt without history', !/ONLY the newest|BACKGROUND/i.test(lastBody.messages[0].content));

  // 6) wiring: sendTranscript records a user turn
  T.clearTurns();
  T.sendTranscript('hello from voice');
  await delay(20);
  await T.dispatchLocalAck('next', 0);
  check('wiring: transcript recorded as user turn',
    lastBody.messages.length === 2 && lastBody.messages[0].content.includes('User: hello from voice'));

  // 7) wiring: speak() records an assistant turn (fake player, dud TTS is fine)
  T.clearTurns();
  T.setPlayerForTest({ play: () => {}, on: () => {}, off: () => {}, stop: () => {} });
  await T.speak('Here is the answer.');
  await T.dispatchLocalAck('next', 0);
  check('wiring: spoken reply recorded as assistant turn',
    lastBody.messages.length === 2 && lastBody.messages[0].content.includes('Assistant: Here is the answer.'));

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
run();
