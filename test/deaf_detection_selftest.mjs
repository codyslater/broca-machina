// Deaf-loop detection selftest — the loop can join cleanly, report Ready and
// receive NOTHING with no error logged (live 20260831). The log could not tell
// that apart from "the user was here but never spoke", because both are zero
// [recv] lines. These cases pin the distinction: `[session]` must report the
// speaking edges DISCORD delivered, and must say DEAF only when the user sat
// there long enough for zero edges to actually mean something.
//   VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/deaf_detection_selftest.mjs
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-deaf-'));
const cfg = {
  discord: { guildId: 'g', channelId: 'c', allowedUserId: 'U1', tokenEnv: 'DISCORD_VOICE_BOT_TOKEN' },
  stt: { cmd: ['true'] }, tts: { cmd: ['true'] },
  transport: { type: 'file', transcriptDir: path.join(dir, 'tx'), replyFile: path.join(dir, 'reply.txt') },
  autoJoin: true, idleLeaveMs: 200, tmpDir: path.join(dir, 'vtmp'),
};
const cfgPath = path.join(dir, 'cfg.json');
fs.writeFileSync(cfgPath, JSON.stringify(cfg));
process.env.VOICE_CONFIG = cfgPath;
process.env.VOICE_NO_MAIN = '1';
process.env.DISCORD_VOICE_BOT_TOKEN = process.env.DISCORD_VOICE_BOT_TOKEN || 'dummy';

const mod = require(path.join(ROOT, 'src', 'voice_loop.js'));
const T = mod.__test;

// Capture the loop's own log lines; drive the clock so a 45s threshold is testable.
let lines = [];
const realLog = console.log;
console.log = (...a) => { lines.push(a.map(String).join(' ')); };
let clock = 1_000_000;
const realNow = Date.now;
Date.now = () => clock;

const done = [];
function check(name, cond) {
  done.push([name, !!cond]);
  if (!cond) { console.log = realLog; Date.now = realNow; realLog(`FAIL: ${name}`); realLog(lines.join('\n')); process.exit(1); }
}
const sess = () => lines.filter((l) => l.includes('[session]')).pop() || '';

// --- 1. present a long time, zero edges -> DEAF ------------------------------
lines = []; clock = 1_000_000;
T.setPresence(true);
clock += 300_000;                       // five minutes, the 20260831 window
T.setPresence(false);
check('long visit with no speaking edges is reported DEAF', /\*\* DEAF/.test(sess()));
check('DEAF line reports 0 edges', /0 speaking edge\(s\)/.test(sess()));
check('DEAF line reports the duration', /present 300s/.test(sess()));

// --- 2. same silence, but SHORT -> not deaf (nothing can be concluded) -------
lines = []; clock = 2_000_000;
T.setPresence(true);
clock += 10_000;                        // under DEAF_MIN_SEC
T.setPresence(false);
check('a short quiet visit is NOT called deaf', !/DEAF/.test(sess()));
check('short visit still emits a session line', /\[session\]/.test(sess()));

// --- 3. edges delivered -> not deaf, even with nothing captured -------------
// This is the case the old zero-[recv] metric got WRONG: Discord was talking to
// us fine, the utterances just never completed. That is a different fault.
lines = []; clock = 3_000_000;
T.setPresence(true);
T.onSpeakingStart('U1');
clock += 60_000;
T.onSpeakingStart('U1');
clock += 300_000;
T.setPresence(false);
check('edges seen -> not deaf', !/DEAF/.test(sess()));
check('edges are counted', /2 speaking edge\(s\)/.test(sess()));
check('utterances counted separately from edges', /0 utterance\(s\) received/.test(sess()));

// --- 4. a foreign speaker is not counted as one of OUR edges ----------------
lines = []; clock = 4_000_000;
T.setPresence(true);
T.onSpeakingStart('SOMEONE-ELSE');
clock += 300_000;
T.setPresence(false);
check('another user speaking does not mask a deaf loop', /\*\* DEAF/.test(sess()));

// --- 5. the silent gates now name themselves --------------------------------
lines = []; clock = 5_000_000;
T.setPresence(true);
T.setConnForTest(null);                 // no live connection
T.onSpeakingStart('U1');
check('a dropped edge names its reason', lines.some((l) => /edge dropped — no live connection/.test(l)));
const before = lines.length;
T.onSpeakingStart('U1');                // immediate repeat
check('gate-drop logging is throttled', lines.length === before);
clock += 31_000;                        // past the 30s throttle
T.onSpeakingStart('U1');
check('gate-drop logs again after the throttle window', lines.length > before);

console.log = realLog; Date.now = realNow;
for (const [n, ok] of done) console.log(`  ${ok ? 'ok' : 'FAIL'}  ${n}`);
console.log(`\ndeaf_detection_selftest: ${done.length}/${done.length} passed`);
