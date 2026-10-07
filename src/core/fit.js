// Thinning sampled values (a recorded camera take) into Bézier keys the graph editor can edit.
// fitKeys(samples, tol): samples [{t, v}] (evenly spaced, one per frame) -> keys [{t, v, curve:'bezier', hi, ho}] whose
// curve stays within tol of every sample. Recursive split at the worst sample (Ramer-Douglas-Peucker on curves, as in
// Schneider's "fitCubic"). Tangents at each key come from the samples (centred differences over a small window), so
// neighbouring segments join smoothly and keys stay on the recorded path. Uses segVal from tracks.js to measure the
// error, so the error is measured on exactly the curve the time core will evaluate.
import { segVal } from './tracks.js';

const slopeAt = (S, i, w = 2) => { const a = S[Math.max(0, i - w)], b = S[Math.min(S.length - 1, i + w)]; return (b.v - a.v) / Math.max(1e-9, b.t - a.t); };
const keyAt = (S, i) => ({ t: S[i].t, v: S[i].v, m: slopeAt(S, i) });
const toKey = (k, prev, next) => ({ t: +k.t.toFixed(6), v: k.v, curve: prev ? 'bezier' : 'linear',
  ...(prev ? { hi: [-(k.t - prev.t) / 3, -k.m * (k.t - prev.t) / 3] } : {}), ...(next ? { ho: [(next.t - k.t) / 3, k.m * (next.t - k.t) / 3] } : {}) });

export function fitKeys(S, tol) {
  if (S.length < 2) return S.map(s => ({ t: s.t, v: s.v, curve: 'linear' }));
  const idx = new Set([0, S.length - 1]);
  const build = () => { const ks = [...idx].sort((a, b) => a - b).map(i => keyAt(S, i)); return ks.map((k, j) => toKey(k, ks[j - 1], ks[j + 1])); };
  const refine = (i0, i1) => {
    if (i1 - i0 < 2) return;
    const a = toKey(keyAt(S, i0), null, keyAt(S, i1)), b = toKey(keyAt(S, i1), keyAt(S, i0), null);
    let worst = -1, err = 0;
    for (let i = i0 + 1; i < i1; i++) { const e = Math.abs(segVal(a, { ...b, curve: 'bezier' }, S[i].t, false) - S[i].v); if (e > err) { err = e; worst = i; } }
    if (err > tol) { idx.add(worst); refine(i0, worst); refine(worst, i1); }
  };
  refine(0, S.length - 1);
  return build();
}
/** Largest |curve - sample| of fitted keys over the samples (a check). */
export function fitError(keys, S) {
  let e = 0; for (const s of S) { let i = 1; while (i < keys.length - 1 && keys[i].t < s.t) i++; e = Math.max(e, Math.abs(segVal(keys[i - 1], keys[i], s.t, false) - s.v)); } return e;
}
