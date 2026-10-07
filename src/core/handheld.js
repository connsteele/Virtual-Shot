// Procedural handheld camera: a deterministic shake added to the rig's pose, a pure function of (settings, t).
// cam.handheld = { on, amount (0..1+, scales everything), rot (degrees of yaw/pitch at amount 1), roll (degrees),
//                  pos (metres of drift at amount 1), freq (Hz of the main sway), seed }
// Smooth 1D value noise (quintic between hashed lattice values), two octaves per channel: a slow sway (breathing,
// balance) and a faster jitter (hands), like an operator holding a light camera. No state: scrubbing is exact.
import { hash } from './curves.js';
import { add, scl, cross, nrm, sub } from './vec.js';

const fade = x => x * x * x * (x * (x * 6 - 15) + 10);
/** Value noise in -1..1 at x for channel ch and seed. */
export function noise1(x, ch, seed = 0) {
  const i = Math.floor(x), f = x - i, a = hash(i, ch, 977 + seed) * 2 - 1, b = hash(i + 1, ch, 977 + seed) * 2 - 1;
  return a + (b - a) * fade(f);
}
const fbm = (t, ch, seed, freq) => noise1(t * freq, ch, seed) * 0.75 + noise1(t * freq * 4.3, ch + 50, seed) * 0.25;

export const HANDHELD_DEFAULTS = { on: false, amount: 1, rot: 0.6, roll: 0.35, pos: 0.004, freq: 0.7, seed: 1 };

/** Shake a pose { eye, target, up, ... } at time t. Rotations turn the view about the eye; returns a new pose. */
export function applyHandheld(pose, h, t) {
  if (!h || !h.on) return pose;
  const H = { ...HANDHELD_DEFAULTS, ...h }, A = H.amount, D2R = Math.PI / 180;
  const yaw = fbm(t, 1, H.seed, H.freq) * H.rot * A * D2R, pitch = fbm(t, 2, H.seed, H.freq) * H.rot * A * D2R;
  const roll = fbm(t, 3, H.seed, H.freq * 0.8) * H.roll * A * D2R;
  const dist = Math.hypot(...sub(pose.target, pose.eye));
  let f = nrm(sub(pose.target, pose.eye)), r = nrm(cross(f, pose.up)), u = cross(r, f);
  // yaw about u, pitch about r (small angles: compose by rotating the basis)
  const rot = (v, axis, a) => { const c = Math.cos(a), s = Math.sin(a), k = axis, d = v[0] * k[0] + v[1] * k[1] + v[2] * k[2], x = cross(k, v);
    return [0, 1, 2].map(i => v[i] * c + x[i] * s + k[i] * d * (1 - c)); };
  f = rot(f, u, -yaw); r = rot(r, u, -yaw); f = rot(f, r, pitch); u = cross(r, f); u = rot(u, f, roll); r = nrm(cross(f, u));
  const drift = [fbm(t, 4, H.seed, H.freq * 0.5), fbm(t, 5, H.seed, H.freq * 0.5), fbm(t, 6, H.seed, H.freq * 0.5)];
  const eye = add(pose.eye, add(add(scl(r, drift[0] * H.pos * A), scl(u, drift[1] * H.pos * A)), scl(f, drift[2] * H.pos * A)));
  return { ...pose, eye, target: add(eye, scl(f, dist)), up: u };
}
