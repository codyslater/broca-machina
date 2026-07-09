// broca-machina — VAD endpointing client (streams an utterance's PCM to the warm
// vad_server.py over a Unix socket and reports the moment speech ends).
//
// Used only when `vad.enabled` is set in the config. The loop's receiver feeds
// decoded PCM chunks to `feed()`; when the server detects end-of-speech it sends
// one `{event:"endpoint"}` frame and `onEndpoint()` fires — the loop then ends
// the utterance early instead of waiting the fixed `endSilenceMs`.
//
// Fully fail-safe: if the socket can't connect (server down) or never fires,
// `onEndpoint` simply never runs and the loop's fixed-silence AfterSilence path
// still ends the utterance. Nothing here can wedge capture.
//
// Wire format matches vad_server.py: 4-byte big-endian length + payload.
// Frame 0 is the JSON header; subsequent frames are raw s16le PCM; a zero-length
// frame signals end-of-utterance.
const net = require('net');

function frame(payload) {
  const h = Buffer.allocUnsafe(4);
  h.writeUInt32BE(payload.length, 0);
  return Buffer.concat([h, payload]);
}

// opts: { sock, header, onEndpoint, log, connectTimeoutMs=500, maxPreConnectChunks=256 }
// returns { feed(buf), close() } — both no-throw.
function createVadMonitor(opts) {
  const { sock, header, onEndpoint, log } = opts;
  const connectTimeoutMs = opts.connectTimeoutMs || 500;
  const maxPreConnect = opts.maxPreConnectChunks || 256;
  const noop = { feed() {}, close() {} };

  let socket;
  let connected = false;
  let closed = false;
  let fired = false;
  let pending = [];            // PCM chunks captured before the socket connected
  let rbuf = Buffer.alloc(0);  // accumulator for server->client frames

  const say = (...a) => { if (log) log('[vad]', ...a); };

  try {
    socket = net.createConnection(sock);
  } catch (e) {
    say('connect throw:', e.message);
    return noop;
  }
  socket.setNoDelay(true);
  socket.on('connect', () => {
    connected = true;
    try {
      socket.write(frame(Buffer.from(JSON.stringify(header || {}))));
      for (const b of pending) socket.write(frame(b));
    } catch (e) { say('header/flush write err:', e.message); }
    pending = [];
  });
  socket.on('data', (d) => {
    rbuf = Buffer.concat([rbuf, d]);
    while (rbuf.length >= 4) {
      const n = rbuf.readUInt32BE(0);
      if (n > 64 * 1024 * 1024) { say('oversize frame — dropping'); rbuf = Buffer.alloc(0); break; }
      if (rbuf.length < 4 + n) break;
      const payload = rbuf.subarray(4, 4 + n);
      rbuf = rbuf.subarray(4 + n);
      if (fired) continue;
      try {
        const msg = JSON.parse(payload.toString('utf8'));
        if (msg && msg.event === 'endpoint') { fired = true; if (onEndpoint) onEndpoint(msg); }
      } catch { /* ignore malformed frame */ }
    }
  });
  socket.on('error', (e) => { say('sock err:', e.message); });
  // If the server never accepts within the window, give up on VAD for this
  // utterance and let the fixed-silence fallback end it.
  socket.setTimeout(connectTimeoutMs, () => {
    if (!connected && !closed) { say('connect timeout — falling back to endSilenceMs'); try { socket.destroy(); } catch { /* */ } }
  });

  return {
    feed(buf) {
      if (closed) return;
      if (connected) { try { socket.write(frame(buf)); } catch (e) { say('feed err:', e.message); } }
      else if (pending.length < maxPreConnect) pending.push(buf);
    },
    close() {
      if (closed) return;
      closed = true;
      try { socket.write(frame(Buffer.alloc(0))); } catch { /* */ }
      try { socket.end(); } catch { /* */ }
      // Hard-close shortly after in case end() stalls behind the drain.
      setTimeout(() => { try { socket.destroy(); } catch { /* */ } }, 250).unref?.();
    },
  };
}

module.exports = { createVadMonitor };
