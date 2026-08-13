// Speaker-enrollment selftest — with speakerGate configured but no voiceprint
// on disk, the loop runs a scripted enrollment conversation: collects N
// utterance samples (NEVER forwarding their transcripts to the brain), runs
// the build command, then resumes normal delivery once the voiceprint exists.
// Run under bun:
//   VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/enroll_selftest.mjs
import { createRequire } from 'module';
import { PassThrough } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-enroll-'));
const sttOut = path.join(dir, 'stt_out');
const refFile = path.join(dir, 'voiceprint.json');
const enrollDir = path.join(dir, 'enroll');
const cfg = {
  discord: { guildId: 'g', channelId: 'c', allowedUserId: 'U1', tokenEnv: 'DISCORD_VOICE_BOT_TOKEN' },
  stt: { cmd: ['bash', '-c', `cat ${sttOut} 2>/dev/null`] },
  tts: { cmd: ['true'] },
  transport: { type: 'file', transcriptDir: path.join(dir, 'tx'), replyFile: path.join(dir, 'reply.txt') },
  speakerGate: {
    refFile,
    enrollDir,
    enrollUtterances: 2,
    buildCmd: ['bash', '-c', `echo '{"samples":2}' > ${refFile}`],
  },
  tmpDir: path.join(dir, 'vtmp'),
};
const cfgPath = path.join(dir, 'cfg.json');
fs.writeFileSync(cfgPath, JSON.stringify(cfg));
process.env.VOICE_CONFIG = cfgPath;
process.env.VOICE_NO_MAIN = '1';
process.env.DISCORD_VOICE_BOT_TOKEN = process.env.DISCORD_VOICE_BOT_TOKEN || 'dummy';

const mod = require(path.join(ROOT, 'src', 'voice_loop.js'));
const T = mod.__test;

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
  await new Promise((r) => setTimeout(r, 1000));
}

let failed = 0;
function check(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; }
const txCount = () => { try { return fs.readdirSync(path.join(dir, 'tx')).length; } catch { return 0; } };
const sampleCount = () => { try { return fs.readdirSync(enrollDir).filter((f) => f.endsWith('.wav')).length; } catch { return 0; } };

async function run() {
  check('cfg exposes SPEAKER_ENROLL', T.cfg.SPEAKER_ENROLL === true);
  check('enrollment needed with no voiceprint', typeof T.enrollNeeded === 'function' && T.enrollNeeded() === true);
  if (typeof T.enrollNeeded !== 'function') { console.log('\n2 FAILED'); process.exit(1); }

  T.setPlayerForTest({ play: () => {}, on: () => {}, off: () => {}, stop: () => {} });

  // sample 1: collected, NOT delivered, a prompt spoken
  T.clearTurns();
  await utter('I had toast and coffee this morning');
  check('sample 1: wav collected', sampleCount() === 1);
  check('sample 1: transcript NOT delivered', txCount() === 0);
  const turns1 = T.getTurns();
  check('sample 1: prompt spoken', turns1.length > 0 && turns1[turns1.length - 1].role === 'assistant');

  // enrollment-aware endpointing: reflective answers include thinking pauses,
  // so BOTH endpointers wait longer while enrolling (checked mid-enrollment),
  // and drop back to command-tuned values once the voiceprint exists.
  check('endpointing: patient during enrollment (fixed-silence)',
    typeof T.endSilenceMs === 'function' && T.endSilenceMs() >= 1500);
  check('endpointing: patient during enrollment (vad)',
    typeof T.vadMinSilenceMs === 'function' && T.vadMinSilenceMs() >= 1500);

  // sample 2: reaches the target -> build runs -> voiceprint exists
  await utter('The weather is cold and clear today');
  check('sample 2: wav collected', sampleCount() === 2);
  check('sample 2: transcript NOT delivered', txCount() === 0);
  check('build ran: voiceprint exists', fs.existsSync(refFile));
  check('enrollment complete', T.enrollNeeded() === false);

  // post-enrollment: utterances flow to the brain again
  await utter('now give me the session status');
  check('post-enroll: transcript delivered', txCount() === 1);
  check('post-enroll: no extra samples collected', sampleCount() === 2);
  check('endpointing: back to command-tuned after enrollment', T.endSilenceMs() < 1500 && T.vadMinSilenceMs() < 1500);

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
run();
