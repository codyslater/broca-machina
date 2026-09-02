// speak-tool result selftest — the tool used to answer "queued for speech"
// no matter what happened to the text. When nobody is in the voice channel
// the loop posts it to the fallback TEXT channel (or drops it), and the
// brain writing the reply should know that: a reply someone will read can
// be fuller than one they will hear. Run under bun:
//   VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/speak_result_selftest.mjs
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-speakres-'));
const cfg = {
  discord: { guildId: 'g', channelId: 'c', allowedUserId: 'U1', tokenEnv: 'DISCORD_VOICE_BOT_TOKEN' },
  stt: { cmd: ['true'] }, tts: { cmd: ['true'] },
  transport: { type: 'mcp', source: 'selftest' },
  presenceFile: path.join(dir, 'present'),
  voiceFallback: { channelId: '123456' },
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
const text = (r) => (r && r.content && r.content[0] && r.content[0].text) || '';

check('exports handleSpeakCall', typeof T.handleSpeakCall === 'function');
if (typeof T.handleSpeakCall !== 'function') { console.log(`\n${failed} FAILED`); process.exit(1); }

// not in the channel at all (no player under VOICE_NO_MAIN), fallback configured
let r = await T.handleSpeakCall({ text: 'first reply' });
check('absent + fallback: text still queued', T.state().replyQueueLen === 1);
check('absent + fallback: result says it will be posted, not spoken', /posted/i.test(text(r)) && !/^queued for speech$/.test(text(r)));

// not in the channel, no fallback: the brain is told it will be dropped
T.setFallbackChannelForTest(null);
r = await T.handleSpeakCall({ text: 'second reply' });
check('absent, no fallback: result says dropped', /dropped/i.test(text(r)));
T.setFallbackChannelForTest('123456');

// in the channel, but the allowed user has left
T.setPlayerForTest({ play: () => {}, on: () => {}, off: () => {}, stop: () => {} });
T.setPresence(false);
r = await T.handleSpeakCall({ text: 'third reply' });
check('user gone: result says it will be posted', /posted/i.test(text(r)));

// in the channel with the user present: plain speech
T.setPresence(true);
r = await T.handleSpeakCall({ text: 'fourth reply' });
check('present: result is queued for speech', text(r) === 'queued for speech');
check('present: no error flag', !r.isError);

// empty text is still an error, not a queue entry
const before = T.state().replyQueueLen;
r = await T.handleSpeakCall({ text: '   ' });
check('empty text: error result', r.isError === true);
check('empty text: nothing queued', T.state().replyQueueLen === before);
T.setPresence(false);

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
