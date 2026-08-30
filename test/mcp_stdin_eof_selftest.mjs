// MCP host-death selftest — when the MCP host that launched the loop dies, the loop
// must die with it. Run under bun:
//   VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/mcp_stdin_eof_selftest.mjs
//
// Live 2026-08-30: a host session launched from a terminal tab spawned
// voice_loop.js as its MCP server and then died without signalling it. The SDK's
// StdioServerTransport listens for 'data' and 'error' on stdin, never 'end', so
// the orphan ignored the EOF, kept the singleton pidfile and the Discord voice
// gateway, and every replacement spawn from the host's successor was refused as
// a duplicate. The voice channel was unreachable until the orphan was killed
// by hand. Stdin EOF in mcp mode IS the host dying — treat it as SIGTERM.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-stdin-eof-'));
const tmpDir = path.join(dir, 'vtmp');
const cfg = {
  discord: { guildId: 'g', channelId: 'c', allowedUserId: 'U1', tokenEnv: 'DISCORD_VOICE_BOT_TOKEN' },
  stt: { cmd: ['true'] }, tts: { cmd: ['true'] },
  transport: { type: 'mcp', source: 'eoftest', transcriptDir: path.join(dir, 'tx') },
  tmpDir,
};
const cfgPath = path.join(dir, 'cfg.json');
fs.writeFileSync(cfgPath, JSON.stringify(cfg));

let failed = 0;
function check(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; }
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve when `pred(bufferSoFar)` holds, or reject after `ms`.
function waitFor(stream, pred, ms, label) {
  let buf = '';
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
    stream.on('data', (d) => { buf += d; if (pred(buf)) { clearTimeout(t); resolve(buf); } });
  });
}

async function run() {
  const env = { ...process.env, DISCORD_VOICE_BOT_TOKEN: 'dummy', VOICE_NO_DISCORD: '1' };
  delete env.VOICE_NO_MAIN;   // we want main() to run: singleton -> initMcp -> return
  const child = spawn('bun', [path.join(ROOT, 'src', 'voice_loop.js'), cfgPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let exitCode = null;
  child.on('exit', (code) => { exitCode = code; });

  // 1) the MCP server comes up and owns the singleton
  try {
    await waitFor(child.stderr, (b) => b.includes('[mcp] server connected'), 15000, 'mcp connect');
    check('mcp server connected', true);
  } catch (e) { check(`mcp server connected (${e.message})`, false); }
  const pidfile = path.join(tmpDir, 'loop.pid');
  check('singleton pidfile is the child', fs.existsSync(pidfile) && fs.readFileSync(pidfile, 'utf8').trim() === String(child.pid));

  // 2) the transport is genuinely live: an initialize round-trips over stdio
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'eoftest', version: '0' } } };
  const reply = waitFor(child.stdout, (b) => b.includes('"id":1'), 5000, 'initialize reply');
  child.stdin.write(JSON.stringify(init) + '\n');
  try { const b = await reply; check('initialize answered', /"serverInfo"/.test(b)); }
  catch (e) { check(`initialize answered (${e.message})`, false); }

  // 3) the host dies: its end of the stdio pair closes -> our stdin hits EOF.
  //    The loop must exit on its own, promptly, and release the pidfile.
  child.stdin.end();
  const deadline = Date.now() + 4000;
  while (exitCode === null && Date.now() < deadline) await delay(50);   // eslint-disable-line no-await-in-loop
  check('exits on stdin EOF (within 4s)', exitCode !== null);
  check('exit code 0 (clean shutdown, not a crash)', exitCode === 0);
  await delay(100);
  check('pidfile released', !fs.existsSync(pidfile));

  if (exitCode === null) { child.kill('SIGKILL'); }
  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
run();
