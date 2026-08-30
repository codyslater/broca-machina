// Voice-absence fallback selftest — a reply must never be spoken into an empty room.
//
// CS 20260829: "i had to go away from pc mid convo and left voice channel can you make sure
// if i leave and [the assistant] is expecting to use voice it makes the switch if im not there" ...
// "and rhen when i rejoin voice can switch back from discord to speaking".
//
// speak() used to log "not in channel — dropping reply" and return, so the answer was
// synthesized into nothing and lost with no record anywhere.
//
// BOTH DIRECTIONS, and the second is the one CS asked for explicitly: when they come back,
// speech must resume with no mode to unstick. That works by CONSTRUCTION here — presence is
// read per call, never stored — and this test is what keeps it that way.
//   VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/voice_fallback_selftest.mjs
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-fb-'));
const cfg = {
  discord: { guildId: 'g', channelId: 'c', allowedUserId: 'U1', tokenEnv: 'DISCORD_VOICE_BOT_TOKEN' },
  stt: { cmd: ['true'] }, tts: { cmd: ['true'] },
  transport: { type: 'file', transcriptDir: path.join(dir, 'tx'), replyFile: path.join(dir, 'reply.txt') },
  tmpDir: path.join(dir, 'vtmp'),
  presenceFile: path.join(dir, 'presence'),
  voiceFallback: { channelId: '100000000000000001',
    speakerRouteFiles: [path.join(dir, 'rc-route'), path.join(dir, 'route')] },
};
fs.writeFileSync(path.join(dir, 'cfg.json'), JSON.stringify(cfg));
process.env.VOICE_CONFIG = path.join(dir, 'cfg.json');
process.env.VOICE_NO_MAIN = '1';
process.env.DISCORD_VOICE_BOT_TOKEN = process.env.DISCORD_VOICE_BOT_TOKEN || 'dummy';

const T = require(path.join(ROOT, 'src', 'voice_loop.js')).__test;
let failed = 0;
const check = (n, c) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) failed++; };

const sent = [];
T.setClientForTest({ channels: { fetch: async (id) => ({ send: async (m) => sent.push({ id, m }) }) } });

async function run() {
  check('fallbackPost is exported', typeof T.fallbackPost === 'function');

  // --- ALLOW: absence redirects, and says why ---
  sent.length = 0;
  check('redirect reports success', (await T.fallbackPost('the titer came out at 3e11', 'test')) === true);
  check('it reached the configured channel', sent.length === 1 && sent[0].id === '100000000000000001');
  check('it carries the words', sent[0].m.includes('the titer came out at 3e11'));
  check('and says why it is here', /voice channel/i.test(sent[0].m));

  // --- attribution: the banner names the routed session, read per POST ---
  check('routedSpeakerName exported', typeof T.routedSpeakerName === 'function');
  check('no route files -> null', T.routedSpeakerName() === null);
  fs.writeFileSync(path.join(dir, 'route'), JSON.stringify({ type: 'ssh', name: 'lab-remote' }));
  check('name field read', T.routedSpeakerName() === 'lab-remote');
  fs.writeFileSync(path.join(dir, 'rc-route'), JSON.stringify({ type: 'rc', rc_name: 'clone-a' }));
  check('first file wins', T.routedSpeakerName() === 'clone-a');
  fs.writeFileSync(path.join(dir, 'rc-route'), 'not json');
  check('malformed falls through to next file', T.routedSpeakerName() === 'lab-remote');
  sent.length = 0;
  await T.fallbackPost('routed answer', 'test');
  check('banner credits the routed session', sent[0].m.includes('from **lab-remote**'));
  fs.rmSync(path.join(dir, 'route'), { force: true }); fs.rmSync(path.join(dir, 'rc-route'), { force: true });

  // --- a long reply is chunked under Discord's cap, not truncated or refused ---
  sent.length = 0;
  await T.fallbackPost('x'.repeat(4200), 'test');
  check('a long reply is split, not dropped', sent.length >= 3);
  check('every chunk is under the hard cap', sent.every((s) => s.m.length <= 2000));

  // --- DENY: with no channel configured it must not pretend it delivered ---
  sent.length = 0;
  T.setFallbackChannelForTest(null);
  check('unconfigured -> reports FAILURE, never a silent true',
    (await T.fallbackPost('lost words', 'test')) === false && sent.length === 0);
  T.setFallbackChannelForTest('100000000000000001');

  // --- DENY: a send that throws is reported, not swallowed as success ---
  sent.length = 0;
  T.setClientForTest({ channels: { fetch: async () => { throw new Error('boom'); } } });
  check('a failing send reports false', (await T.fallbackPost('x', 'test')) === false);
  T.setClientForTest({ channels: { fetch: async (id) => ({ send: async (m) => sent.push({ id, m }) }) } });

  // --- the switch BACK is stateless: presence is read per call, never stored ---
  T.setPresence(false);
  check('absent: presence flag is off', fs.existsSync(cfg.presenceFile) === false);
  T.setPresence(true);
  check('rejoined: presence flag is back on, no mode to unstick',
    fs.existsSync(cfg.presenceFile) === true);
  T.setPresence(false);

  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
}
run();
