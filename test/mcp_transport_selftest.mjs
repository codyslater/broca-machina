// MCP-transport hooks selftest — tee, gateFile, replyFile — driven through the
// __test seam with no Discord gateway and no MCP client. Run under bun:
//   VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/mcp_transport_selftest.mjs
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-mcp-'));
const TX = path.join(dir, 'tee');
const GATE = path.join(dir, 'gate');
const REPLY = path.join(dir, 'say');
const LOGF = path.join(dir, 'loop.log');
// Pre-seed an oversized log so the boot-time rotation branch runs at require.
fs.writeFileSync(LOGF, 'x'.repeat(6 * 1024 * 1024));
const cfg = {
  discord: { guildId: 'g', channelId: 'c', allowedUserId: 'U1', tokenEnv: 'DISCORD_VOICE_BOT_TOKEN' },
  stt: { cmd: ['true'] },
  tts: { cmd: ['true'] },
  transport: { type: 'mcp', source: 'selftest', transcriptDir: TX, gateFile: GATE, replyFile: REPLY },
  tmpDir: path.join(dir, 'vtmp'),
  logFile: LOGF,
};
const cfgPath = path.join(dir, 'cfg.json');
fs.writeFileSync(cfgPath, JSON.stringify(cfg));
process.env.VOICE_CONFIG = cfgPath;
process.env.VOICE_NO_MAIN = '1';
process.env.DISCORD_VOICE_BOT_TOKEN = process.env.DISCORD_VOICE_BOT_TOKEN || 'dummy';

const T = require(path.join(ROOT, 'src', 'voice_loop.js')).__test;

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log('  ok:', name); } else { fail++; console.log('  FAIL:', name); } };
const teeFiles = () => fs.readdirSync(TX).filter((f) => f.endsWith('.txt')).sort();

// 1) boot made the tee dir even in mcp mode
ok(fs.existsSync(TX), 'mcp mode creates transcriptDir at boot');

// 2) ungated: tee written AND notify attempted. Under VOICE_NO_MAIN there is
// no mcp server, so the attempt throws internally -> ack cleared. The tee
// must survive the notify failure (tee-first contract).
T.ack.set(Date.now());
await T.sendTranscript('hello ungated');
ok(teeFiles().length === 1, 'ungated turn writes the tee file');
ok(fs.readFileSync(path.join(TX, teeFiles()[0]), 'utf8') === 'hello ungated', 'tee content matches');
ok(T.ack.get() === 0, 'ungated turn attempted notify (failed here -> ack cleared)');

// utcTs() is millisecond-resolution; keep turn filenames distinct.
await new Promise((r) => setTimeout(r, 5));

// 3) gated: tee written, notify skipped entirely (ack stays armed)
fs.writeFileSync(GATE, '');
const armed = Date.now();
T.ack.set(armed);
await T.sendTranscript('hello gated');
ok(teeFiles().length === 2, 'gated turn still writes the tee file');
ok(T.ack.get() === armed, 'gated turn skips notify and keeps the ack armed');
fs.unlinkSync(GATE);

// 4) replyFile is a voice source outside the file transport
fs.writeFileSync(REPLY, 'spoken reply');
ok(T.readReplyFile() === 'spoken reply', 'replyFile consumed in mcp mode');
ok(!fs.existsSync(REPLY), 'replyFile deleted after read');
ok(T.readReplyFile() === null, 'absent replyFile -> null');

// 5) logFile sink: oversized pre-boot log was rotated aside; log() lines from
// the turns above landed in a fresh file with full-date timestamps.
ok(fs.existsSync(LOGF + '.1'), 'oversized logFile rotated to .1 at boot');
const logged = fs.existsSync(LOGF) ? fs.readFileSync(LOGF, 'utf8') : '';
ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(logged), 'logFile lines carry full ISO timestamps');
ok(logged.length > 0 && !logged.startsWith('xxxx'), 'logFile is the fresh post-rotation file');

console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
