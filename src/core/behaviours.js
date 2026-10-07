// Procedural behaviours: named motion and flicker programs whose parameters live in the document (an object's
// `behaviours` list), so a shot needs no code of its own. Each is a pure function of time, its parameters and a seed
// taken from stable ids (object id + behaviour id), never list positions (LEARNINGS §6).
// Every numeric parameter, and `weight` (0–1, scales the effect), is keyable as `behaviours.<id>.<param>`.
//
// A behaviour returns any of:
//   pos   [x, y, z] metres added to the object's local position (parent space)
//   rot   quaternion applied after the object's own rotation (local axes)
//   scale multiplier on the object's scale
//   mul   { prop: factor } multipliers on numeric properties (emission, intensity, ring.light ...)
import { hash } from './curves.js';
import { quatAxisAngle, quatFromEuler } from './vec.js';

/** Smooth 1D gradient noise in about [-1, 1]: value at x, from a seed and a channel. */
export function noise1(x, seed, ch = 0) {
  const i = Math.floor(x), f = x - i, g = k => hash(k, seed, ch) * 2 - 1;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  return 2 * (g(i) * f * (1 - u) + g(i + 1) * (f - 1) * u);
}
/** fBm: a few octaves of noise1, normalised. Gradient noise is 0 on its lattice, so each channel and octave is offset
 *  by a seeded phase and octaves use a lacunarity of 2.13: otherwise every axis rests at once, 'freq' times a second. */
const fbm = (x, seed, ch, oct = 3) => { let s = 0, a = 1, n = 0, f = 1;
  for (let o = 0; o < oct; o++) { s += a * noise1(x * f + 97 * hash(seed, ch, o), seed, ch * 8 + o); n += a; a *= 0.5; f *= 2.13; } return s / n; };
/** A stable integer seed from a string (FNV-1a). */
export const seedOf = s => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h | 0; };

const P = (def, unit, label, step = 0.01) => ({ def, unit, label, step });

export const BEHAVIOURS = {
  shake: {
    label: 'Shake', note: 'Smooth random jitter of position and rotation (handheld, rumble, impact).',
    params: { amp: P(0.002, 'm', 'Amplitude', 0.0005), rot: P(1, '°', 'Rotation', 0.1), freq: P(12, 'Hz', 'Frequency', 0.5) },
    apply: (p, t, seed) => { const x = t * p.freq;
      return { pos: [0, 1, 2].map(c => p.amp * fbm(x, seed, c)), rot: quatFromEuler([0, 1, 2].map(c => p.rot * fbm(x, seed, c + 3))) }; },
  },
  bob: {
    label: 'Bob', note: 'Sine motion along an axis (floating, breathing).',
    params: { amp: P(0.01, 'm', 'Amplitude', 0.001), freq: P(0.5, 'Hz', 'Frequency', 0.05), phase: P(0, 'cycles', 'Phase', 0.05),
      ax: P(0, '', 'Axis X', 0.1), ay: P(1, '', 'Axis Y', 0.1), az: P(0, '', 'Axis Z', 0.1) },
    apply: (p, t) => { const s = p.amp * Math.sin(2 * Math.PI * (p.freq * t + p.phase)), l = Math.hypot(p.ax, p.ay, p.az) || 1;
      return { pos: [p.ax / l * s, p.ay / l * s, p.az / l * s] }; },
  },
  spin: {
    label: 'Spin', note: 'Constant rotation about a local axis.',
    params: { rpm: P(10, 'rpm', 'Speed', 1), phase: P(0, '°', 'Start angle', 1), ax: P(0, '', 'Axis X', 0.1), ay: P(1, '', 'Axis Y', 0.1), az: P(0, '', 'Axis Z', 0.1) },
    apply: (p, t) => ({ rot: quatAxisAngle([p.ax, p.ay, p.az], p.phase + 360 * p.rpm / 60 * t) }),
  },
  flicker: {
    label: 'Flicker', note: 'Random steps in a property (a failing bulb, a CRT, a candle). Holds each level for 1/rate s.',
    params: { rate: P(20, 'Hz', 'Rate', 1), depth: P(0.5, '0–1', 'Depth'), dropout: P(0.1, '0–1', 'Dropout chance') },
    target: 'emission',
    apply: (p, t, seed, prop) => { const k = Math.floor(t * p.rate), r = hash(k, seed, 7), d = hash(k, seed, 8);
      return { mul: { [prop]: d < p.dropout ? 1 - Math.min(1, p.depth * 2) : 1 - p.depth * r } }; },
  },
  noise: {
    label: 'Noise', note: 'Smooth wander: of position (prop "transform") or of one numeric property.',
    params: { amp: P(0.01, 'm or ×', 'Amplitude', 0.001), freq: P(0.3, 'Hz', 'Frequency', 0.05), rot: P(0, '°', 'Rotation', 0.1) },
    target: 'transform',
    apply: (p, t, seed, prop) => { const x = t * p.freq;
      if (prop && prop !== 'transform') return { mul: { [prop]: Math.max(0, 1 + p.amp * fbm(x, seed, 0)) } };
      return { pos: [0, 1, 2].map(c => p.amp * fbm(x, seed, c)), rot: p.rot ? quatFromEuler([0, 1, 2].map(c => p.rot * fbm(x, seed, c + 3))) : null }; },
  },
};

/** Parameter defaults for a behaviour type. */
export const behaviourDefaults = type => Object.fromEntries(Object.entries(BEHAVIOURS[type].params).map(([k, d]) => [k, d.def]));
