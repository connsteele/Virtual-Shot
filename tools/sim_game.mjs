// A simulated game sending its camera to the Virtual Shot bridge, with a game loop's real timing problems:
// frame times jitter around 1/rate, the camera is sampled at the start of a frame and sent at its end (2-6 ms of
// "work"), and every few seconds a hitch (a shader compile or a GC pause) stalls the loop for 50-120 ms. It sends in
// UNREAL conventions (centimetres, Z up, left-handed, FRotator, horizontal FOV) to exercise the bridge's conversion;
// the path itself is src/bridge/sim_path.js (canonical), so tests can compare what Virtual Shot drew with the truth.
//   node tools/sim_game.mjs [--url=ws://127.0.0.1:8799/] [--udp=8799] [--rate=60] [--jitter=1.2] [--hitch=4]
//                           [--secs=0 (forever)] [--conv=unreal|gltf|blender|unity] [--events]
import dgram from 'node:dgram';
import { fromCanonical } from '../src/bridge/protocol.js';
import { simPath } from '../src/bridge/sim_path.js';

const A = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const RATE = +(A.rate || 60), JIT = +(A.jitter ?? 1.2), HITCH = +(A.hitch ?? 4), SECS = +(A.secs || 0), CONV = A.conv || 'unreal';
const now = () => performance.timeOrigin + performance.now();
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
let send;
if (A.udp) { const s = dgram.createSocket('udp4'), port = +A.udp === 1 || A.udp === true ? 8799 : +A.udp; send = o => s.send(JSON.stringify(o), port, '127.0.0.1'); }
else { const ws = new WebSocket(A.url || 'ws://127.0.0.1:8799/'); await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.type === 'error') console.error('bridge:', m.error); };
  send = o => ws.send(JSON.stringify(o)); }

const t0 = now();
send({ type: 'hello', v: 1, role: 'source', name: 'sim-game', app: 'Virtual Shot simulated game', conventions: CONV, rate: RATE, aspect: 16 / 9, sim: { t0 } });
let f = 0, nextHitch = t0 + HITCH * 1000 * (0.5 + Math.random()), sent = 0;
// Windows timers tick at ~15.6 ms, so setTimeout alone can't keep a 60 Hz loop: sleep coarsely, then yield with
// setImmediate (I/O still runs, so sends go out) until the exact time.
const sleepUntil = async t => { const d = t - now(); if (d > 20) await new Promise(r => setTimeout(r, d - 17)); while (now() < t) await new Promise(r => setImmediate(r)); };
let tick = t0;
for (;;) {
  const ts = now(), tau = (ts - t0) / 1000, pose = simPath(tau);
  const work = 2 + Math.random() * 4; await sleepUntil(ts + work);   // the frame's work, then send at its end
  send(fromCanonical({ type: 'cam', id: 'main', f, ts, ...pose, aspect: 16 / 9 }, CONV)); sent++;
  if (A.events && f % RATE === 0) send({ type: 'event', ts, f, name: f % (RATE * 4) === 0 ? 'hit' : 'beat', data: { n: f / RATE } });
  f++;
  let dt = 1000 / RATE + gauss() * JIT; if (now() > nextHitch && HITCH > 0) { dt += 50 + Math.random() * 70; nextHitch = now() + HITCH * 1000 * (0.5 + Math.random()); }
  tick += Math.max(4, dt); if (tick < now()) tick = now();   // a late frame starts straight away, like a real loop
  await sleepUntil(tick);
  if (SECS && now() - t0 > SECS * 1000) break;
}
console.log(`sim-game: sent ${sent} camera samples in ${((now() - t0) / 1000).toFixed(1)} s`); process.exit(0);
