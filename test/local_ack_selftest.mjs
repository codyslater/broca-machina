// Tier-1 local-ack sequencing selftest (GPU Phase-2). Drives the REAL
// pollReply()/playResource() code in src/voice_loop.js against a fake
// AudioPlayer — no live Discord gateway, no live Ollama call (the network
// call in dispatchLocalAck() is bypassed via enqueueAckForTest, which sets
// the exact same `pendingAck` slot dispatchLocalAck() would on success — so
// this exercises the real consumer-side logic, not a reimplementation).
//
// This is the empirical check for: "does a Claude reply arriving mid-
// playback of the tier-1 local ack cause double-talk (overlapping audio), or
// does it queue safely?" CS's working hypothesis going in was that
// AudioPlayer.play() replacing the current resource is what prevents
// overlap; reading the real pollReply() code shows the ACTUAL mechanism is
// simpler and doesn't depend on that at all: pollReply() only ever starts a
// NEW speak/ack when `!botSpeaking`, so nothing new is ever dispatched while
// something is already playing — a reply arriving mid-ack just waits in
// pendingReply until the ack's playback naturally finishes, then plays on
// the very next poll tick. This test proves that empirically against the
// real code (not the assumed mechanism), and also proves the "two-clear":
// a reply landing before a not-yet-played ack starts must silently drop
// the ack, never voicing it after the real answer already arrived.
//
//   VOICE_NO_MAIN=1 DISCORD_VOICE_BOT_TOKEN=dummy bun test/local_ack_selftest.mjs
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-localack-'));
// synthWav() (used by the REAL speak() reply path) checks the output file
// actually exists and is >=100 bytes — a no-op `true` stub (as the other
// selftests use, since they don't exercise playback) would make speak()
// silently no-op with "[tts] empty wav" and never call player.play(), which
// would make this test unable to observe the reply's play() call at all. So
// this stub, unlike the other selftests', actually writes a dummy wav: args
// land as $1=text $2=outwav (bash -c's own $0 is the FIRST arg after the
// script string).
const ttsStub = path.join(dir, 'tts_stub.sh');
fs.writeFileSync(ttsStub, '#!/usr/bin/env bash\nhead -c 200 /dev/zero > "$2" 2>/dev/null || true\n');
fs.chmodSync(ttsStub, 0o755);
const cfg = {
  discord: { guildId: 'g', channelId: 'c', allowedUserId: 'U1', tokenEnv: 'DISCORD_VOICE_BOT_TOKEN' },
  stt: { cmd: ['true'] }, tts: { cmd: ['bash', ttsStub] },
  transport: { type: 'file', transcriptDir: path.join(dir, 'tx'), replyFile: path.join(dir, 'reply.txt') },
  // fireAfterMs is set far out so tests control "due" explicitly via
  // T.ack.set(): arming in the past makes the ack due NOW, arming at now
  // holds it (nothing fires for 60s — longer than any test).
  localAck: { enabled: true, fireAfterMs: 60000 },
  tmpDir: path.join(dir, 'vtmp'),
};
const cfgPath = path.join(dir, 'cfg.json');
fs.writeFileSync(cfgPath, JSON.stringify(cfg));
process.env.VOICE_CONFIG = cfgPath;
process.env.VOICE_NO_MAIN = '1';
process.env.DISCORD_VOICE_BOT_TOKEN = process.env.DISCORD_VOICE_BOT_TOKEN || 'dummy';

const mod = require(path.join(ROOT, 'src', 'voice_loop.js'));
const T = mod.__test;

let failed = 0;
function check(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; }
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function dummyWav(dirp, name) {
  const p = path.join(dirp, name);
  fs.writeFileSync(p, Buffer.alloc(200));   // >=100 bytes, matches synthWav()'s own size check
  return p;
}

// Fake AudioPlayer: records every play() call (with timestamp) and, after
// `durationMs`, fires the same stateChange({status:'idle'}) event
// playResource() listens for — mirroring @discordjs/voice's real playback
// lifecycle closely enough to exercise playResource()'s promise resolution
// for real, without a live voice connection.
function makeFakePlayer(durationMs) {
  const listeners = { stateChange: [], error: [] };
  const calls = [];   // { t: Date.now() } per play()
  return {
    calls,
    on(ev, cb) { (listeners[ev] || (listeners[ev] = [])).push(cb); },
    off(ev, cb) { if (listeners[ev]) listeners[ev] = listeners[ev].filter((f) => f !== cb); },
    play(_res) {
      calls.push({ t: Date.now() });
      setTimeout(() => { for (const cb of listeners.stateChange.slice()) cb({ status: 'playing' }, { status: 'idle' }); }, durationMs);
    },
  };
}

async function run() {
  check('config: LOCAL_ACK enabled', T.cfg.LOCAL_ACK === true);
  check('config: fireAfterMs plumbed through', T.cfg.ACK_FIRE_MS === 60000);

  // --- Test 1: two-clear — reply + not-yet-played ack both pending at once
  // -> the reply wins immediately, the ack is discarded (never plays).
  {
    const fake = makeFakePlayer(80);
    T.setPlayerForTest(fake);
    const ackWav = dummyWav(dir, 'ack1.wav');
    T.enqueueAckForTest(ackWav, 'let me check that for you');
    T.enqueueReply('the real answer');
    check('t1: both pending before first poll tick', T.state().hasPendingAck && T.state().hasPendingReply);
    T.pollReply();   // starts the (self-rescheduling) poll loop
    // The very first synchronous pass (before any subprocess/await yields)
    // should fire the REPLY branch (checked first) and, per the two-clear,
    // drop the ack in the same tick — before any playback has even started.
    check('t1: reply branch wins synchronously (pendingReply cleared)', T.state().hasPendingReply === false);
    check('t1: two-clear — ack was dropped, not queued behind the reply', T.state().hasPendingAck === false);
    check('t1: ack wav file was cleaned up (unlinked), not left as an orphan', !fs.existsSync(ackWav));
    // speak() -> synthWav() spawns a real subprocess (the tts stub) to
    // produce the reply's wav before playResource()/player.play() runs, so
    // give that a moment before checking play() was actually reached.
    await delay(80);
    check('t1: exactly one play() call (the reply — the ack never played)', fake.calls.length === 1);
    await delay(150);   // let the reply's fake playback finish before test 2
    check('t1: botSpeaking settles back to false after playback ends', T.state().botSpeaking === false);
  }

  // --- Test 2: the empirical barge-in/double-talk check. An ack is already
  // PLAYING when the real reply arrives mid-playback — does a second play()
  // fire immediately (double-talk / overlap), or does it wait?
  {
    const ACK_DURATION = 150;
    const fake = makeFakePlayer(ACK_DURATION);
    T.setPlayerForTest(fake);
    const ackWav = dummyWav(dir, 'ack2.wav');
    T.enqueueAckForTest(ackWav, 'checking on that job for you');
    T.ack.set(Date.now() - 60010);   // armed past fireAfterMs -> due NOW
    T.acked.set(false);
    T.pollReply();   // fires the ack synchronously (due, nothing else pending)
    await delay(20);   // ack is now definitely "playing" (play() called, not yet idle)
    check('t2: ack is playing (botSpeaking=true) before the reply arrives', T.state().botSpeaking === true);
    check('t2: exactly one play() call so far (the ack)', fake.calls.length === 1);
    const ackPlayAt = fake.calls[0].t;

    T.enqueueReply('the job finished at 3am');   // simulates the `speak` MCP tool firing mid-ack
    await delay(20);   // still well inside the ack's 150ms fake playback window
    check('t2: NO second play() call while the ack is still audibly playing (no overlap)', fake.calls.length === 1);
    check('t2: bot is still "speaking" the ack (not cut off)', T.state().botSpeaking === true);

    await delay(ACK_DURATION);   // let the ack's fake playback finish naturally
    // Give the poll loop a couple of 200-300ms ticks to notice botSpeaking
    // flipped false and dispatch the now-queued reply.
    await delay(350);
    check('t2: reply eventually played — second play() call fired', fake.calls.length === 2);
    if (fake.calls.length === 2) {
      const replyPlayAt = fake.calls[1].t;
      check('t2: reply\'s play() happened AFTER the ack finished (serialized, not overlapping)',
        replyPlayAt >= ackPlayAt + ACK_DURATION);
    }
    check('t2: pendingReply consumed', T.state().hasPendingReply === false);
  }

  // --- Test 3: fire gate — an ack that is READY but not yet DUE holds, and a
  // reply arriving inside the window silently retires it (CS's "it doesn't
  // have to fire every time, just if you anticipate a long wait").
  {
    const fake = makeFakePlayer(80);
    T.setPlayerForTest(fake);
    T.ack.set(Date.now());   // armed NOW -> not due for 60s
    T.acked.set(false);
    const ackWav = dummyWav(dir, 'ack3.wav');
    T.enqueueAckForTest(ackWav, 'looking at the deploy for you');
    await delay(400);   // several poll ticks inside the hold window
    check('t3: held ack has not played (no play() call)', fake.calls.length === 0);
    check('t3: ack still pending while held', T.state().hasPendingAck === true);
    T.enqueueReply('deploy finished clean');
    await delay(300);
    check('t3: fast reply retires the held ack (no filler this turn)', T.state().hasPendingAck === false);
    check('t3: held ack wav cleaned up', !fs.existsSync(ackWav));
    check('t3: only the reply played', fake.calls.length === 1);
    await delay(150);
  }

  // --- Test 4: one-filler latch — the canned tier already fired this turn, so
  // a late local ack is dropped, never stacked behind it.
  {
    const fake = makeFakePlayer(80);
    T.setPlayerForTest(fake);
    T.ack.set(Date.now() - 60010);   // due
    T.acked.set(true);               // canned ack already fired this turn
    const ackWav = dummyWav(dir, 'ack4.wav');
    T.enqueueAckForTest(ackWav, 'still on that question');
    await delay(400);
    check('t4: latched turn drops the late local ack', T.state().hasPendingAck === false);
    check('t4: dropped ack wav cleaned up', !fs.existsSync(ackWav));
    check('t4: nothing played', fake.calls.length === 0);
  }

  // --- Test 5: replyFile two-clear — a ROUTED reply (replyFile, not the
  // speak tool) landing with an unplayed ack pending retires the ack too;
  // before the fire-gate redesign this branch leaked the ack + wav.
  {
    const fake = makeFakePlayer(80);
    T.setPlayerForTest(fake);
    T.ack.set(Date.now());   // held (not due)
    T.acked.set(false);
    const ackWav = dummyWav(dir, 'ack5.wav');
    T.enqueueAckForTest(ackWav, 'checking with the remote session');
    fs.writeFileSync(cfg.transport.replyFile, 'the remote run is at epoch forty');
    await delay(400);
    check('t5: routed reply retires the held ack', T.state().hasPendingAck === false);
    check('t5: retired ack wav cleaned up', !fs.existsSync(ackWav));
    check('t5: the routed reply played (exactly one play())', fake.calls.length === 1);
  }

  // --- Test 6: multi-speak FIFO — several speak calls queue and play one per
  // poll pass, strictly serialized on botSpeaking, and the queue drains.
  {
    const fake = makeFakePlayer(60);
    T.setPlayerForTest(fake);
    T.ack.set(0); T.acked.set(false);
    T.enqueueReply('first paragraph of the answer');
    T.enqueueReply('second paragraph, composed later');
    T.enqueueReply('third and final part');
    check('t6: three items queued', T.state().replyQueueLen === 3);
    await delay(1600);   // 3 x (synth subprocess + 60ms playback + poll ticks)
    check('t6: all three played', fake.calls.length === 3);
    check('t6: queue drained', T.state().replyQueueLen === 0);
    check('t6: playback serialized (no overlapping starts)',
      fake.calls.every((c, i) => i === 0 || c.t >= fake.calls[i - 1].t + 60));
    check('t6: botSpeaking settled', T.state().botSpeaking === false);
  }

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
run();
