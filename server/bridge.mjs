// Virtual Shot engine bridge: a local relay between camera sources (a game mod, Blender, the simulated game) and
// receivers (the Virtual Shot editor, or Blender/Unreal for the reverse direction). No dependencies: a minimal
// RFC 6455 WebSocket server on top of node:http, plus a UDP JSON port for senders that can't do WebSocket easily
// (a Python script, a C++ mod: one JSON message per datagram).
//   node server/bridge.mjs [port=8799] [--log=<file.jsonl>] [--quiet]
//   ws://127.0.0.1:<port>/       WebSocket, any role (send a hello first; see docs/engine-bridge.md)
//   udp 127.0.0.1:<port>         JSON datagrams (hello optional; a datagram source without one is assumed glTF)
//   GET http://127.0.0.1:<port>/status   clients, message counts, rates
// What it does with each message: stamps `rx` (bridge receive time, epoch ms), converts cam messages from the
// sender's declared conventions to canonical (glTF), then forwards to every other client in that client's own declared
// conventions (canonical unless its hello asked for another). Listens on 127.0.0.1 only.
import http from 'node:http';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { toCanonical, fromCanonical, resolveConventions, check, VERSION } from '../src/bridge/protocol.js';

const args = process.argv.slice(2), PORT = +(args.find(a => /^\d+$/.test(a)) || 8799);
const LOG = args.find(a => a.startsWith('--log='))?.slice(6), QUIET = args.includes('--quiet');
const log = LOG ? fs.createWriteStream(LOG, { flags: 'a' }) : null;
const now = () => performance.timeOrigin + performance.now();   // epoch ms with sub-ms resolution
const say = (...a) => { if (!QUIET) console.log(new Date().toISOString().slice(11, 23), ...a); };

let nextId = 1;
const clients = new Map();   // id -> { id, kind: 'ws'|'udp', name, role, conv, convName, send(obj), stats }
const counts = { in: 0, out: 0, bad: 0 };

function handle(c, text) {
  let m; try { m = JSON.parse(text); } catch { counts.bad++; return; }
  const rx = now(); counts.in++; c.stats.in++; c.stats.last = rx;
  if (m.type === 'hello') {
    c.name = String(m.name || c.name); c.role = m.role || 'source';
    try { c.conv = resolveConventions(m.conventions); c.convName = typeof m.conventions === 'string' ? m.conventions : m.conventions ? (m.conventions.preset ? m.conventions.preset + '+' : 'custom') : 'gltf'; }
    catch (e) { c.send({ type: 'error', error: e.message }); return; }
    c.aspect = m.aspect || 16 / 9; c.subscribe = m.subscribe || null; c.hello = m;
    say(`hello from #${c.id} ${c.name} (${c.role}, ${c.convName}${m.rate ? `, ${m.rate} Hz` : ''})`);
    c.send({ type: 'welcome', v: VERSION, id: c.id, bridge: 'virtual-shot-bridge', tb: rx, conventions: c.convName });
    // tell the others who joined, and the newcomer who is already here (a receiver that joins late still learns each
    // source's name, conventions and extras such as the simulated game's clock origin)
    const { type, role, name, conventions, ...extra } = m;
    c.announce = { ...extra, type: 'hello', v: m.v ?? VERSION, src: c.name, role: c.role, conventions: c.convName, rx };
    broadcast(c, c.announce);
    for (const o of clients.values()) if (o !== c && o.announce && (!c.subscribe || c.subscribe.includes('hello'))) c.send(o.announce);
    return;
  }
  if (m.type === 'ping') { c.send({ type: 'pong', t0: m.t0, tb: rx }); return; }
  const err = check(m); if (err) { counts.bad++; c.send({ type: 'error', error: err }); return; }
  let out = { ...m, src: m.src || c.name, rx };
  if (m.type === 'cam') { try { out = toCanonical(out, c.conv, m.aspect || c.aspect); } catch (e) { counts.bad++; return; } }
  if (log) log.write(JSON.stringify(out) + '\n');
  broadcast(c, out);
}
function broadcast(from, m) {
  for (const c of clients.values()) {
    if (c === from || !c.hello) continue;
    if (c.subscribe && !c.subscribe.includes(m.type)) continue;
    const o = m.type === 'cam' && c.conv && c.convName !== 'gltf' ? fromCanonical(m, c.conv, c.aspect) : m;
    c.send(o); counts.out++; c.stats.out++;
  }
}

// ---- WebSocket (RFC 6455): text frames, ping/pong, close; fragmented messages reassembled
function wsFrame(op, payload) {
  const n = payload.length, h = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  return Buffer.concat([h, payload]);
}
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/status')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ port: PORT, counts, clients: [...clients.values()].map(c => ({ id: c.id, kind: c.kind, name: c.name, role: c.role, conventions: c.convName, ...c.stats })) }, null, 1));
  }
  res.writeHead(426); res.end('Virtual Shot bridge: connect with a WebSocket (see docs/engine-bridge.md)');
});
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sock.setNoDelay(true);   // Nagle would hold small camera messages back by up to ~40 ms
  const c = { id: nextId++, kind: 'ws', name: `ws#${nextId - 1}`, role: null, conv: null, convName: 'gltf', stats: { in: 0, out: 0 },
    send: o => { if (!sock.destroyed) sock.write(wsFrame(1, Buffer.from(JSON.stringify(o)))); } };
  clients.set(c.id, c); say(`ws #${c.id} connected from ${req.socket.remoteAddress}`);
  let buf = Buffer.alloc(0), frag = [];
  sock.on('data', d => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 15, masked = buf[1] & 0x80; let n = buf[1] & 127, o = 2;
      if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); o = 4; } else if (n === 127) { if (buf.length < 10) return; n = Number(buf.readBigUInt64BE(2)); o = 10; }
      if (buf.length < o + (masked ? 4 : 0) + n) return;
      const mask = masked ? buf.subarray(o, o + 4) : null; o += masked ? 4 : 0;
      const p = Buffer.from(buf.subarray(o, o + n)); if (mask) for (let i = 0; i < n; i++) p[i] ^= mask[i & 3];
      buf = buf.subarray(o + n);
      if (op === 8) { sock.end(wsFrame(8, Buffer.alloc(0))); return; }
      if (op === 9) { sock.write(wsFrame(10, p)); continue; }
      if (op === 10) continue;
      frag.push(p); if (!fin) continue;
      const msg = Buffer.concat(frag).toString('utf8'); frag = [];
      handle(c, msg);
    }
  });
  const gone = () => { if (clients.delete(c.id)) { say(`ws #${c.id} ${c.name} left`); broadcast(c, { type: 'bye', src: c.name, rx: now() }); } };
  sock.on('close', gone); sock.on('error', gone);
});

// ---- UDP JSON: one message per datagram; replies (welcome, pong, errors, forwarded messages) go back to the sender
const udp = dgram.createSocket('udp4'), udpPeers = new Map();
udp.on('message', (msg, rinfo) => {
  const k = `${rinfo.address}:${rinfo.port}`; let c = udpPeers.get(k);
  if (!c) { c = { id: nextId++, kind: 'udp', name: `udp:${k}`, role: 'source', conv: resolveConventions('gltf'), convName: 'gltf', stats: { in: 0, out: 0 }, hello: null,   // a datagram sender with no hello is a pure source: it gets nothing back
     
      send: o => { const b = Buffer.from(JSON.stringify(o)); if (b.length < 60000) udp.send(b, rinfo.port, rinfo.address); } };
    udpPeers.set(k, c); clients.set(c.id, c); say(`udp #${c.id} from ${k}`); }
  handle(c, msg.toString('utf8'));
});
udp.bind(PORT, '127.0.0.1');
server.listen(PORT, '127.0.0.1', () => say(`Virtual Shot bridge on ws://127.0.0.1:${PORT}/ and udp 127.0.0.1:${PORT}${LOG ? `, logging to ${LOG}` : ''}`));
// UDP peers have no disconnect: forget the ones that went quiet (they are re-added by their next datagram)
setInterval(() => { const t = now(); for (const [k, c] of udpPeers) if (t - (c.stats.last || 0) > 10000) { udpPeers.delete(k); clients.delete(c.id); } }, 5000).unref();
