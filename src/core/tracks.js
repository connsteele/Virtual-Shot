// Tracks: keys on one property of one object. Ported from Black Page's graph editor (v4.8 channels) so values match.
// Key: { t (seconds), v, curve, ho:[dt,dv], hi:[dt,dv], brk }
//   curve shapes the segment INTO the key: 'bezier' (prev.ho + this.hi), 'linear', 'hold', or a preset from CURVES.
//   track.interp === 'geometric' makes 'exp' segments interpolate geometrically (distance, FOV).
import { CURVES, clamp, lerp, easeInOut } from './curves.js';

const cub = (p0, p1, p2, p3, s) => { const m = 1 - s; return m * m * m * p0 + 3 * m * m * s * p1 + 3 * m * s * s * p2 + s * s * s * p3; };

export function bzCtrl(a, b) {
  const T = b.t - a.t, ho = a.ho || [T / 3, 0], hi = b.hi || [-T / 3, 0];
  const so = ho[0] > 1e-9 ? ho[1] / ho[0] : 0, si = hi[0] < -1e-9 ? hi[1] / hi[0] : 0, o = clamp(ho[0], 0, T), i = clamp(-hi[0], 0, T);
  return [[a.t + o, a.v + so * o], [b.t - i, b.v - si * i]];
}

export function segVal(a, b, time, geometric) {
  const T = Math.max(1e-6, b.t - a.t), cv = b.curve || 'bezier';
  if (cv === 'hold') return a.v;
  if (cv === 'linear') return lerp(a.v, b.v, clamp((time - a.t) / T, 0, 1));
  if (cv === 'bezier') {
    const [p1, p2] = bzCtrl(a, b); let lo = 0, hi = 1;
    for (let k = 0; k < 32; k++) { const m = (lo + hi) / 2; if (cub(a.t, p1[0], p2[0], b.t, m) < time) lo = m; else hi = m; }
    return cub(a.v, p1[1], p2[1], b.v, (lo + hi) / 2);
  }
  const u = (CURVES[cv] || easeInOut)(clamp((time - a.t) / T, 0, 1));
  return (cv === 'exp' && geometric && a.v > 0 && b.v > 0) ? a.v * Math.pow(b.v / a.v, u) : lerp(a.v, b.v, u);
}

/** Value of a numeric track at time t. Holds the first/last key outside the keyed range. */
export function trackValue(track, t) {
  const K = track.keys;
  if (!K || !K.length) return track.default;
  if (t <= K[0].t) return K[0].v;
  const L = K[K.length - 1]; if (t >= L.t) return L.v;
  let i = 1; while (K[i].t < t) i++;
  return segVal(K[i - 1], K[i], t, track.interp === 'geometric');
}

/** Segment lookup for tracks whose values are records (focus keys): returns {a, b, u} with u already shaped. */
export function trackSegment(track, t) {
  const K = track.keys;
  if (t >= K[K.length - 1].t) return { a: K[K.length - 1], b: K[K.length - 1], u: 0 };
  if (t <= K[0].t) return { a: K[0], b: K[0], u: 0 };
  for (let i = 1; i < K.length; i++) if (t <= K[i].t) {
    const a = K[i - 1], b = K[i];
    return { a, b, u: (CURVES[b.curve || 'smooth'] || easeInOut)(clamp((t - a.t) / Math.max(1e-4, b.t - a.t), 0, 1)) };
  }
}

/** Value of a typed track at time t. type: 'number' (default), 'bool' (steps: each key holds until the next) or
 *  'color' ('#rrggbb', blended in display RGB along the key's curve). Records (focus) use trackSegment instead. */
export function typedValue(track, t) {
  const K = track.keys, type = track.type || 'number';
  if (type === 'number') return trackValue(track, t);
  if (!K || !K.length) return track.default;
  if (t <= K[0].t) return K[0].v;
  let i = 0; while (i + 1 < K.length && K[i + 1].t <= t) i++;
  if (type === 'bool' || i === K.length - 1) return K[i].v;
  const a = K[i], b = K[i + 1], u = segVal({ t: a.t, v: 0 }, { t: b.t, v: 1, curve: b.curve === 'bezier' ? 'smooth' : b.curve }, t, false);
  const ca = hexRGB(a.v), cb = hexRGB(b.v);
  return '#' + ca.map((x, c) => Math.round(clamp(lerp(x, cb[c], u), 0, 255)).toString(16).padStart(2, '0')).join('');
}
const hexRGB = h => [1, 3, 5].map(i => parseInt(String(h).slice(i, i + 2), 16) || 0);
