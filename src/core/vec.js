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
