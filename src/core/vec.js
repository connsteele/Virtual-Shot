// Tiny vector / column-major matrix helpers (same conventions as the Black Page engine and glTF).
export const sub = (a, b) => a.map((v, i) => v - b[i]);
export const add = (a, b) => a.map((v, i) => v + b[i]);
export const scl = (a, s) => a.map(v => v * s);
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const nrm = a => { const l = Math.hypot(...a); return a.map(v => v / l); };
export const xf = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];

export const M4 = {
  mul(a, b) { const o = new Float64Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k]; o[i * 4 + j] = s; } return o; },
  id() { return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); },
  trs(t = [0, 0, 0], r = [0, 0, 0, 1], s = [1, 1, 1]) {
    const [x, y, z, w] = r;
    return new Float64Array([(1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0, 2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0, 2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0, t[0], t[1], t[2], 1]);
  },
  persp(f, a, n, fa) { const t = 1 / Math.tan(f / 2); return new Float64Array([t / a, 0, 0, 0, 0, t, 0, 0, 0, 0, (fa + n) / (n - fa), -1, 0, 0, 2 * fa * n / (n - fa), 0]); },
  look(e, c, u) { const z = nrm(sub(e, c)), x = nrm(cross(u, z)), y = cross(z, x); return new Float64Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, e), -dot(y, e), -dot(z, e), 1]); },
};

/** Column-major matrix from a {position, quaternion, scale} transform record. */
export const trsOf = o => M4.trs(o.position || [0, 0, 0], o.quaternion || [0, 0, 0, 1], o.scale || [1, 1, 1]);
/** Basis vectors (columns 0..2, normalised) and origin of a transform record. */
export function frameOf(o) {
  const m = trsOf(o);
  return { r: nrm([m[0], m[1], m[2]]), u: nrm([m[4], m[5], m[6]]), n: nrm([m[8], m[9], m[10]]), ctr: [m[12], m[13], m[14]] };
}

// ---- rotations and matrix decomposition (object animation). Euler angles are degrees in three.js's 'XYZ' order,
// the order the inspector shows; quaternions are [x, y, z, w].
const D2R = Math.PI / 180;
export function quatFromEuler([ex, ey, ez]) {
  const c1 = Math.cos(ex * D2R / 2), c2 = Math.cos(ey * D2R / 2), c3 = Math.cos(ez * D2R / 2), s1 = Math.sin(ex * D2R / 2), s2 = Math.sin(ey * D2R / 2), s3 = Math.sin(ez * D2R / 2);
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
}
export function eulerFromQuat(q) {
  const m = M4.trs([0, 0, 0], q), m13 = Math.max(-1, Math.min(1, m[8])), y = Math.asin(m13);
  const [x, z] = Math.abs(m13) < 0.9999999 ? [Math.atan2(-m[9], m[10]), Math.atan2(-m[4], m[0])] : [Math.atan2(m[6], m[5]), 0];
  return [x / D2R, y / D2R, z / D2R];
}
export const quatMul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
export const quatAxisAngle = (axis, deg) => { const n = nrm(axis), s = Math.sin(deg * D2R / 2); return [n[0] * s, n[1] * s, n[2] * s, Math.cos(deg * D2R / 2)]; };
export function slerp(a, b, k) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3], bb = b; if (d < 0) { d = -d; bb = b.map(v => -v); }
  if (d > 0.9995) return nrm4(a.map((v, i) => v + (bb[i] - v) * k));
  const th = Math.acos(d), s = Math.sin(th), wa = Math.sin((1 - k) * th) / s, wb = Math.sin(k * th) / s;
  return a.map((v, i) => v * wa + bb[i] * wb);
}
const nrm4 = q => { const l = Math.hypot(...q) || 1; return q.map(v => v / l); };
/** Rotation matrix (columns x, y, z) -> quaternion (three.js's method). */
export function quatFromBasis(x, y, z) {
  const [m11, m21, m31] = x, [m12, m22, m32] = y, [m13, m23, m33] = z, tr = m11 + m22 + m33;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); return [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s]; }
  if (m11 > m22 && m11 > m33) { const s = 2 * Math.sqrt(1 + m11 - m22 - m33); return [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s]; }
  if (m22 > m33) { const s = 2 * Math.sqrt(1 + m22 - m11 - m33); return [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s]; }
  const s = 2 * Math.sqrt(1 + m33 - m11 - m22); return [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
}
/** Column-major matrix -> {position, quaternion, scale} (no shear). */
export function decompose(m) {
  const cx = [m[0], m[1], m[2]], cy = [m[4], m[5], m[6]], cz = [m[8], m[9], m[10]];
  let sx = Math.hypot(...cx); const sy = Math.hypot(...cy), sz = Math.hypot(...cz);
  if (dot(cross(cx, cy), cz) < 0) sx = -sx;
  return { position: [m[12], m[13], m[14]], quaternion: quatFromBasis(scl(cx, 1 / sx), scl(cy, 1 / sy), scl(cz, 1 / sz)), scale: [sx, sy, sz] };
}
/** Inverse of an affine (TRS) column-major matrix. */
export function invAffine(m) {
  const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const c00 = a[4] * a[8] - a[5] * a[7], c01 = a[5] * a[6] - a[3] * a[8], c02 = a[3] * a[7] - a[4] * a[6], det = a[0] * c00 + a[1] * c01 + a[2] * c02;
  const i = [c00, a[2] * a[7] - a[1] * a[8], a[1] * a[5] - a[2] * a[4], c01, a[0] * a[8] - a[2] * a[6], a[2] * a[3] - a[0] * a[5], c02, a[1] * a[6] - a[0] * a[7], a[0] * a[4] - a[1] * a[3]].map(v => v / det);
  const t = [m[12], m[13], m[14]], it = [0, 1, 2].map(r => -(i[r] * t[0] + i[3 + r] * t[1] + i[6 + r] * t[2]));
  return new Float64Array([i[0], i[1], i[2], 0, i[3], i[4], i[5], 0, i[6], i[7], i[8], 0, it[0], it[1], it[2], 1]);
}
