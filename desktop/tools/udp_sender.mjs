// A 60 Hz camera sender in the engine bridge's vsb/1 format: each datagram goes to every port given, with the same
// sender time `ts` (epoch ms, sub-millisecond), so two receivers can be compared on the same samples.
//   node desktop/tools/udp_sender.mjs <seconds> <port> [port...]
import dgram from 'node:dgram';
const [, , secs = '10', ...ports] = process.argv;
const sock = dgram.createSocket('udp4');
const now = () => performance.timeOrigin + performance.now();
const hello = Buffer.from(JSON.stringify({ type: 'hello', v: 1, role: 'source', name: 'udp-sender', conventions: 'gltf', rate: 60, fps: 60, timebase: 'fixed' }));
for (const p of ports) sock.send(hello, +p, '127.0.0.1');
const t0 = now(); let f = 0;
// Windows timers tick at ~15.6 ms: sleep coarsely, then spin on setImmediate to the exact 60 Hz slot (as sim_game.mjs)
const tick = () => {
  const due = t0 + f * 1000 / 60;
  if (now() < due) { (due - now() > 3 ? setTimeout : setImmediate)(tick, Math.max(0, due - now() - 2)); return; }
  const t = f / 60, msg = Buffer.from(JSON.stringify({ type: 'cam', f, ts: now(), p: [Math.sin(t) * 0.3, 1.2, 2 + Math.cos(t) * 0.2], q: [0, Math.sin(t * 0.1), 0, Math.cos(t * 0.1)], fov: 30 }));
  for (const p of ports) sock.send(msg, +p, '127.0.0.1');
  f++; if (t >= +secs) { sock.close(); console.log(JSON.stringify({ sent: f })); return; } setImmediate(tick);
};
tick();
