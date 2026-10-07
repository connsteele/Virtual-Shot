// The simulated game's camera path (canonical: glTF metres, Y up), as a pure function of game time tau (seconds).
// A third-person-style camera drifting around the Black Page desk: a slow orbit in front of the CRT, a height bob, a
// dolly in and out and a FOV breath, always looking at a point that wanders around the screen. Used by
// tools/sim_game.mjs to send, and by the latency tests as the ground truth to measure rendered poses against.
import { qLook } from './protocol.js';

const CTR = [0, 0.3086, 0.1599];   // the CRT glass centre in the Black Page scene
export function simPath(tau) {
  const az = 0.55 * Math.sin(tau * 0.45) + 0.12 * Math.sin(tau * 1.7), r = 0.85 + 0.25 * Math.sin(tau * 0.31 + 1);
  const p = [CTR[0] + r * Math.sin(az), CTR[1] + 0.06 + 0.07 * Math.sin(tau * 0.83), CTR[2] + r * Math.cos(az)];
  const look = [CTR[0] + 0.08 * Math.sin(tau * 0.6), CTR[1] - 0.03 + 0.04 * Math.sin(tau * 0.9 + 2), CTR[2]];
  const f = look.map((v, i) => v - p[i]), l = Math.hypot(...f);
  const roll = 2.5 * Math.sin(tau * 0.7) * Math.PI / 180, upW = [Math.sin(roll) * Math.cos(az), Math.cos(roll), -Math.sin(roll) * Math.sin(az)];
  return { p, q: qLook(f.map(v => v / l), upW), fov: 34 + 6 * Math.sin(tau * 0.37) };
}
