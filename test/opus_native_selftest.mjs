// Native-opus selftest — the WASM opusscript codec corrupts its shared heap
// under a loud-room edge storm ("Out of bounds memory access"; live
// 2026-08-13, -16, -25). The loop can reload its own decoder module, but
// @discordjs/voice's ENCODER keeps the poisoned instance, so playback dies
// too (2,460 player errors in seven minutes on 2026-08-25). prism-media
// prefers a native '@discordjs/opus' when one resolves; package.json now
// aliases that name to mediaplex (napi, ABI-stable under bun). This proves
// the native slot is what loads, and that the loop's exact encode/decode
// framing round-trips through it. Run under bun:
//   bun test/opus_native_selftest.mjs
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

let failed = 0;
function check(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; }

const prism = require(path.join(ROOT, 'node_modules', 'prism-media'));

// prism names its backend by the package slot it loaded (resolved lazily on
// the first construction); opusscript is the WASM fallback we are moving off.
new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
const backend = prism.opus.Encoder.type;
check('backend: native slot loaded, not opusscript', backend === '@discordjs/opus');

let native = null;
try { native = require('@discordjs/opus'); } catch { /* unresolved */ }
check('backend: the native slot is a napi build (no WASM heap)', !!native && typeof native.OpusEncoder === 'function'
  && typeof native.getOpusVersion === 'function');

// The loop's framing: 48k stereo, 960-frame packets, through prism's streams
// (Encoder for playback transcoding, Decoder for the receiver).
const enc = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
const packets = [];
enc.on('data', (p) => packets.push(p));
const tone = Buffer.alloc(960 * 2 * 2);
for (let i = 0; i < 960; i++) { const v = Math.round(Math.sin(i / 8) * 8000); tone.writeInt16LE(v, i * 4); tone.writeInt16LE(v, i * 4 + 2); }
// two tone frames, then three of silence: the codec's lookahead smears the
// tone's tail into the first silent frame, so only the LAST frame is judged.
enc.write(tone); enc.write(tone);
for (let i = 0; i < 3; i++) enc.write(Buffer.alloc(960 * 2 * 2));
await new Promise((r) => setTimeout(r, 100));
check('encode: five frames -> five packets', packets.length === 5);
check('encode: packets are opus-sized (tone > silence, under the 1276 max)',
  packets.length === 5 && packets[0].length > packets[4].length && packets.every((p) => p.length > 0 && p.length <= 1276));

const dec = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
const pcm = [];
dec.on('data', (d) => pcm.push(d));
for (const p of packets) dec.write(p);
await new Promise((r) => setTimeout(r, 100));
const rms = (b) => { let s = 0; for (let i = 0; i < 960; i++) { const v = b.readInt16LE(i * 4); s += v * v; } return Math.sqrt(s / 960); };
check('decode: every packet -> one 960-frame PCM block', pcm.length === 5 && pcm.every((b) => b.length === 960 * 2 * 2));
check('decode: tone frame carries signal, trailing silence is quiet', pcm.length === 5 && rms(pcm[1]) > 1000 && rms(pcm[4]) < 300);

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
