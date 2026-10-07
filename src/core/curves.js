// Interpolation shapes and small math shared by the time core and the 2D layers.
// Ported verbatim from Black Page engine v4.8.1 (source/engine.html) so frames match.

export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const lerp = (a, b, k) => a + (b - a) * k;
export const easeOut = x => 1 - Math.pow(1 - x, 3);
export const easeInOut = x => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

/** Deterministic hash in [0,1): the engine's per-glyph / per-frame noise. */
export function hash(a, b, c) {
  let h = 2166136261 ^ a; h = Math.imul(h, 16777619) ^ b; h = Math.imul(h, 16777619) ^ c;
  h ^= h >>> 13; h = Math.imul(h, 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296;
}

/** Preset curves. A key's `curve` shapes the segment INTO that key (After Effects convention). */
export const CURVES = {
  linear: u => u, smooth: easeInOut, 'ease-in': u => u * u * u, 'ease-out': easeOut, exp: u => u,
  back: u => 1 + 2.4 * Math.pow(u - 1, 3) + 1.4 * Math.pow(u - 1, 2),
  'soft-back': u => 1 + 1.5 * Math.pow(u - 1, 3) + 0.5 * Math.pow(u - 1, 2),
  settle: u => {
    const z = .75, w = 6.5, wd = w * Math.sqrt(1 - z * z), sp = x => 1 - Math.exp(-z * w * x) * (Math.cos(wd * x) + z * w / wd * Math.sin(wd * x));
    const v = u * u * (3 - 2 * u) * .35 + u * .65;
    return sp(v) + (1 - sp(1)) * v * v * v * (v * (v * 6 - 15) + 10);
  },
};

export const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
