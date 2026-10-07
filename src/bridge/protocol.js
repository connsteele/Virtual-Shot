// Virtual Shot engine bridge, message format "vsb/1" (see docs/engine-bridge.md for the full description).
// Isomorphic ES module: the bridge server (Node), the senders and the editor (browser) all import it, so the coordinate
// conversions and the sample buffer are one piece of code.
//
// Canonical frame (what the editor gets): glTF conventions. Metres, right-handed, +Y up; a camera looks down its local
// -Z with +Y up and +X right; p is the camera position, q its rotation [x, y, z, w] (camera local -> world), fov the
// VERTICAL field of view in degrees. Times are milliseconds on the sender's clock (epoch based: Date.now() resolution
// or better). Every sender declares its own conventions in its hello; the bridge converts cam messages to canonical on
// the way in and to each receiver's declared conventions on the way out, so the format works in both directions
// (a game into Virtual Shot, or Virtual Shot's camera out to Blender or Unreal).

export const VERSION = 1;

// ---- small vector / quaternion helpers (plain arrays)
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nrm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const mv = (M, v) => [M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2], M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2], M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2]];
const T = M => [[M[0][0], M[1][0], M[2][0]], [M[0][1], M[1][1], M[2][1]], [M[0][2], M[1][2], M[2][2]]];
export const qrot = (q, v) => { const [x, y, z, w] = q, u = [x, y, z], t = cross(u, v).map(c => 2 * c);
  const c2 = cross(u, t); return [v[0] + w * t[0] + c2[0], v[1] + w * t[1] + c2[1], v[2] + w * t[2] + c2[2]]; };
export const qmul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
export const qaxis = (axis, deg) => { const h = deg * Math.PI / 360, s = Math.sin(h), a = nrm(axis); return [a[0] * s, a[1] * s, a[2] * s, Math.cos(h)]; };
/** Rotation matrix (rows) -> quaternion [x, y, z, w]. */
export function qFromMatrix(m) {
  const [[m00, m01, m02], [m10, m11, m12], [m20, m21, m22]] = m, tr = m00 + m11 + m22; let x, y, z, w;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4; }
  const l = Math.hypot(x, y, z, w); return [x / l, y / l, z / l, w / l];
}
/** The rotation taking local axes (fL, uL) to world axes (fW, uW); both pairs orthonormal-ish (re-orthogonalised). */
function rotBetweenFrames(fL, uL, fW, uW) {
  const fl = nrm(fL), ul = nrm(cross(cross(fl, uL), fl)), sl = cross(fl, ul);
  const fw = nrm(fW), uw = nrm(cross(cross(fw, uW), fw)), sw = cross(fw, uw);
  // R = W * L^T, with W and L having the frames as columns
  const W = [[fw[0], uw[0], sw[0]], [fw[1], uw[1], sw[1]], [fw[2], uw[2], sw[2]]], L = [[fl[0], ul[0], sl[0]], [fl[1], ul[1], sl[1]], [fl[2], ul[2], sl[2]]];
  const LT = T(L), R = [0, 1, 2].map(i => [0, 1, 2].map(j => W[i][0] * LT[0][j] + W[i][1] * LT[1][j] + W[i][2] * LT[2][j]));
  return qFromMatrix(R);
}
export const camForward = q => qrot(q, [0, 0, -1]);
export const camUp = q => qrot(q, [0, 1, 0]);
/** Canonical camera rotation from a forward and an up direction (world, canonical). */
export const qLook = (f, u) => rotBetweenFrames([0, 0, -1], [0, 1, 0], f, u);

// ---- conventions. basis: rows map source world coordinates to canonical (may flip handedness); units: metres per unit;
// fwd/up: the camera's look and up axes in its own local frame; fov: which axis the field of view is measured on;
// rot: 'quat' ([x, y, z, w] in the source's own coordinates) or 'ue' (Unreal FRotator [pitch, yaw, roll] degrees).
export const CONVENTIONS = {
  gltf:    { basis: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], units: 1, fwd: [0, 0, -1], up: [0, 1, 0], fov: 'vertical', rot: 'quat', note: 'glTF / three.js / Virtual Shot: metres, Y up, right-handed, camera looks -Z' },
  blender: { basis: [[1, 0, 0], [0, 0, 1], [0, -1, 0]], units: 1, fwd: [0, 0, -1], up: [0, 1, 0], fov: 'vertical', rot: 'quat', note: 'Blender: metres (unit scale 1), Z up, right-handed, camera looks -Z local (matrix_world)' },
  unreal:  { basis: [[0, 1, 0], [0, 0, 1], [-1, 0, 0]], units: 0.01, fwd: [1, 0, 0], up: [0, 0, 1], fov: 'horizontal', rot: 'ue', note: 'Unreal: centimetres, Z up, left-handed, X forward, FRotator pitch/yaw/roll in degrees, horizontal FOV' },
  unity:   { basis: [[1, 0, 0], [0, 1, 0], [0, 0, -1]], units: 1, fwd: [0, 0, 1], up: [0, 1, 0], fov: 'vertical', rot: 'quat', note: 'Unity: metres, Y up, left-handed, camera looks +Z, Camera.fieldOfView is vertical' },
};
/** A hello's conventions: a preset name, or a preset name plus overrides ({ preset: 'unreal', units: 0.0254 }), or a full object. */
export function resolveConventions(c) {
  if (!c) return CONVENTIONS.gltf;
  if (typeof c === 'string') { if (!CONVENTIONS[c]) throw new Error(`unknown conventions "${c}"`); return CONVENTIONS[c]; }
  const base = CONVENTIONS[c.preset || 'gltf'] || CONVENTIONS.gltf; return { ...base, ...c };
}

// Unreal FRotator <-> forward/up (UE's FRotationMatrix: X = forward, Z = up)
const D2R = Math.PI / 180;
function ueAxes([pitch, yaw, roll]) {
  const sp = Math.sin(pitch * D2R), cp = Math.cos(pitch * D2R), sy = Math.sin(yaw * D2R), cy = Math.cos(yaw * D2R), sr = Math.sin(roll * D2R), cr = Math.cos(roll * D2R);
  return { f: [cp * cy, cp * sy, sp], u: [-(cr * sp * cy + sr * sy), cy * sr - cr * sp * sy, cr * cp] };
}
function ueRotator(f, u) {
  const pitch = Math.asin(Math.max(-1, Math.min(1, f[2]))) / D2R, yaw = Math.atan2(f[1], f[0]) / D2R;
  const sp = Math.sin(pitch * D2R), cy = Math.cos(yaw * D2R), sy = Math.sin(yaw * D2R), cp = Math.cos(pitch * D2R);
  const up0 = [-sp * cy, -sp * sy, cp], right0 = [-sy, cy, 0];
  return [pitch, yaw, Math.atan2(dot(u, right0), dot(u, up0)) / D2R];
}
const vfovFrom = (fov, axis, aspect) => axis === 'horizontal' ? 2 * Math.atan(Math.tan(fov * D2R / 2) / aspect) / D2R : fov;
const fovTo = (vfov, axis, aspect) => axis === 'horizontal' ? 2 * Math.atan(Math.tan(vfov * D2R / 2) * aspect) / D2R : vfov;

/** A cam message in the source's conventions -> canonical { p, q, fov (vertical), ... }. Other fields pass through. */
export function toCanonical(m, conv, aspectDefault = 16 / 9) {
  const C = resolveConventions(conv), A = C.basis, aspect = m.aspect || aspectDefault;
  let fS, uS;
  if (C.rot === 'ue' && m.r) ({ f: fS, u: uS } = ueAxes(m.r));
  else { const q = m.q || [0, 0, 0, 1]; fS = qrot(q, C.fwd); uS = qrot(q, C.up); }
  const out = { ...m, p: mv(A, m.p || [0, 0, 0]).map(v => v * C.units), q: qLook(mv(A, fS), mv(A, uS)) };
  delete out.r;
  let fov = m.fov;
  if (fov == null && m.lens && m.lens.mm) { const sh = m.lens.sensor ? m.lens.sensor[1] : (m.lens.sensorH || 24); fov = 2 * Math.atan(sh / 2 / m.lens.mm) / D2R; }
  else if (fov != null) fov = vfovFrom(fov, C.fov, aspect);
  if (fov != null) out.fov = fov;
  return out;
}
/** Canonical cam message -> a receiver's conventions (the reverse direction: Virtual Shot out to Blender or Unreal). */
export function fromCanonical(m, conv, aspectDefault = 16 / 9) {
  const C = resolveConventions(conv), AT = T(C.basis), aspect = m.aspect || aspectDefault;   // basis is orthonormal: inverse = transpose
  const f = mv(AT, camForward(m.q)), u = mv(AT, camUp(m.q));
  const out = { ...m, p: mv(AT, m.p).map(v => v / C.units) };
  if (C.rot === 'ue') { out.r = ueRotator(f, u); delete out.q; } else out.q = rotBetweenFrames(C.fwd, C.up, f, u);
  if (m.fov != null) out.fov = fovTo(m.fov, C.fov, aspect);
  return out;
}

// ---- interpolation of canonical samples
export const lerp = (a, b, u) => a + (b - a) * u;
export function slerp(a, b, u) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3], s = 1; if (d < 0) { d = -d; s = -1; }
  if (d > 0.9995) { const q = a.map((v, i) => v + (s * b[i] - v) * u), l = Math.hypot(...q); return q.map(v => v / l); }
  const th = Math.acos(d), sa = Math.sin((1 - u) * th) / Math.sin(th), sb = s * Math.sin(u * th) / Math.sin(th);
  return a.map((v, i) => v * sa + b[i] * sb);
}
/** Pose between two canonical samples at sender time t (u may go past 1 to extrapolate). */
export function blend(a, b, t) {
  const u = b.ts > a.ts ? (t - a.ts) / (b.ts - a.ts) : 1;
  return { ts: t, p: a.p.map((v, i) => lerp(v, b.p[i], u)), q: slerp(a.q, b.q, u), fov: lerp(a.fov ?? b.fov, b.fov ?? a.fov, u), f: b.f, src: b.src, id: b.id, lens: b.lens };
}

/** A play-out buffer for one camera stream. push() canonical samples as they arrive (with the local receive time);
 *  pose(now) gives the pose to draw at local time `now` in the chosen mode:
 *    'latest'  the newest sample as is (lowest latency; judders when sample and display clocks beat)
 *    'interp'  the sender's pose `delay` ms ago, interpolated between the two samples around it (smooth; adds delay)
 *    'extrap'  the sender's pose now, predicted from the last two samples (low latency; overshoots on stops and hitches),
 *              never more than maxExtrap ms past the newest sample
 *  The sender clock is mapped to the local one by the smallest (receive - sent) offset seen in the last few seconds, the
 *  usual jitter-buffer estimate: it needs no clock sync and stays right when both run on the same machine. */
export class SampleBuffer {
  constructor({ keepMs = 3000, maxExtrap = 50 } = {}) { this.s = []; this.keepMs = keepMs; this.maxExtrap = maxExtrap; this.off = []; this.dropped = 0; this.lastF = null; }
  push(m, rxLocal) {
    if (this.s.length && m.ts <= this.s[this.s.length - 1].ts) return false;   // out of order or repeated: ignore
    if (this.lastF != null && m.f != null && m.f > this.lastF + 1) this.dropped += m.f - this.lastF - 1;
    this.lastF = m.f ?? this.lastF;
    const s = { ...m, rx: rxLocal }; this.s.push(s); this.off.push([rxLocal, rxLocal - m.ts]);
    while (this.s.length > 2 && this.s[0].ts < m.ts - this.keepMs) this.s.shift();
    while (this.off.length && this.off[0][0] < rxLocal - 2000) this.off.shift();
    return true;
  }
  get offset() { let o = Infinity; for (const [, d] of this.off) if (d < o) o = d; return o; }
  get latest() { return this.s[this.s.length - 1] || null; }
  /** Sample-time pose at sender time t (interpolated; clamped to the buffer unless extrapolating). */
  at(t, extrap = false) {
    const S = this.s; if (!S.length) return null;
    if (t <= S[0].ts) return { ...S[0], ts: S[0].ts };
    const L = S[S.length - 1];
    if (t >= L.ts) { if (!extrap || S.length < 2) return { ...L, held: t - L.ts };
      return { ...blend(S[S.length - 2], L, Math.min(t, L.ts + this.maxExtrap)), ahead: Math.min(t - L.ts, this.maxExtrap) }; }
    let i = S.length - 1; while (i > 0 && S[i - 1].ts > t) i--;
    return blend(S[i - 1], S[i], t);
  }
  pose(now, mode = 'interp', delay = 50) {
    if (!this.s.length) return null;
    if (mode === 'latest') return this.latest;
    const senderNow = now - this.offset;
    return mode === 'extrap' ? this.at(senderNow, true) : this.at(senderNow - delay, false);
  }
}

/** Alignment of a source's world onto the scene (the game's origin is not the scene's): canonical pose -> scene pose.
 *  align = { p: [x, y, z] metres, yaw: degrees about +Y, s: scale }. */
export function applyAlign(pose, align) {
  if (!align) return pose;
  const s = align.s ?? 1, qy = qaxis([0, 1, 0], align.yaw || 0), o = align.p || [0, 0, 0];
  const p = qrot(qy, pose.p.map(v => v * s));
  return { ...pose, p: [p[0] + o[0], p[1] + o[1], p[2] + o[2]], q: qmul(qy, pose.q) };
}
/** The yaw + offset alignment that puts a stream pose exactly where a target pose is (keeps the source's scale). */
export function alignTo(pose, target, s = 1) {
  const fs = camForward(pose.q), ft = camForward(target.q);
  const yaw = (Math.atan2(-ft[0], -ft[2]) - Math.atan2(-fs[0], -fs[2])) / D2R;
  const p = qrot(qaxis([0, 1, 0], yaw), pose.p.map(v => v * s));
  return { p: target.p.map((v, i) => v - p[i]), yaw, s };
}

/** Validate an incoming message (returns an error string or null). */
export function check(m) {
  if (!m || typeof m !== 'object') return 'not an object';
  if (m.type === 'cam') {
    if (!Array.isArray(m.p) || m.p.length !== 3 || m.p.some(v => !Number.isFinite(v))) return 'cam.p must be [x, y, z]';
    if (!(Array.isArray(m.q) && m.q.length === 4) && !(Array.isArray(m.r) && m.r.length === 3)) return 'cam needs q [x, y, z, w] or r [pitch, yaw, roll]';
    if (!Number.isFinite(m.ts)) return 'cam.ts (sender milliseconds) is required';
  }
  return null;
}
