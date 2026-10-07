// Object animation: keyable object properties, parenting, constraints, procedural behaviours and glTF clips, all
// evaluated as a pure function of (document, assets, t). Objects that use none of these are left alone: they keep the
// renderer's static path, so shots that don't animate objects render exactly as before.
//
// Document additions (all optional, per object):
//   tracks with target = object id and prop = a path below (keys as for any track: {t, v, curve, hi, ho})
//   parent: "<id>"                       the object's transform is local to that object's world matrix
//   constraints: [{ id, type, on, ... }] applied in order after parenting:
//     attach    { target, offset?: transform }   snap to target's world (× offset): pick up / put down with influence
//     lookAt    { target, axis?: '+z'|'-z'|'+x'|..., up?: [x,y,z] }   turn so `axis` points at the target
//     followPath{ path, orient?: bool }          ride a path object's rail at progress u (0–1, by arc length)
//   behaviours: [{ id, type, on, params, prop? }] (see behaviours.js)
//   clips: [{ id, name, start, speed?, offset?, loop?: 'repeat'|'once'|'pingpong', fadeIn?, end? }] baked glTF animations
// Keyable: constraints.<id>.influence and .u (followPath), behaviours.<id>.<param> and .weight, clips.<id>.weight.
// A `path` object is { type: 'path', transform, points: [[x,y,z], ...], closed? }: a Catmull-Rom rail in its local space.
import { typedValue } from './tracks.js';
import { add, sub, scl, cross, nrm, xf, M4, trsOf, quatFromEuler, eulerFromQuat, quatMul, slerp, quatFromBasis, decompose } from './vec.js';
import { BEHAVIOURS, behaviourDefaults, seedOf } from './behaviours.js';

/** Keyable object properties. `types` limits a property to object types; `when` to objects that have something. */
export const PROPS = {
  'position.x': { label: 'Position X', unit: 'm', step: 0.001, dec: 4, group: 'Transform' },
  'position.y': { label: 'Position Y', unit: 'm', step: 0.001, dec: 4, group: 'Transform' },
  'position.z': { label: 'Position Z', unit: 'm', step: 0.001, dec: 4, group: 'Transform' },
  'rotation.x': { label: 'Rotation X', unit: '° (XYZ)', step: 0.1, dec: 2, group: 'Transform' },
  'rotation.y': { label: 'Rotation Y', unit: '° (XYZ)', step: 0.1, dec: 2, group: 'Transform' },
  'rotation.z': { label: 'Rotation Z', unit: '° (XYZ)', step: 0.1, dec: 2, group: 'Transform' },
  'scale.x': { label: 'Scale X', unit: '×', step: 0.001, dec: 4, group: 'Transform' },
  'scale.y': { label: 'Scale Y', unit: '×', step: 0.001, dec: 4, group: 'Transform' },
  'scale.z': { label: 'Scale Z', unit: '×', step: 0.001, dec: 4, group: 'Transform' },
  visible: { label: 'Visible', type: 'bool', group: 'Visibility', def: true },
  gain: { label: 'Brightness ×', unit: '×', step: 0.05, dec: 3, group: 'Material', types: ['model', 'card'], def: 1 },
  emission: { label: 'Emission', unit: '×', step: 0.05, dec: 3, group: 'Material', types: ['model'], when: o => o.emission !== undefined || o.ring },
  brightness: { label: 'Card brightness', unit: '×', step: 0.05, dec: 3, group: 'Material', types: ['card'], def: 1.4 },
  intensity: { label: 'Intensity', unit: '×', step: 0.05, dec: 3, group: 'Light', types: ['led'], def: 1 },
  color: { label: 'Colour', type: 'color', group: 'Light', types: ['led'], def: '#ffffff' },
  'ring.intensity': { label: 'Ring LED intensity', unit: '×', step: 0.05, dec: 3, group: 'Light', when: o => o.ring },
  'ring.light': { label: 'Ring light', unit: '×', step: 0.05, dec: 3, group: 'Light', when: o => o.ring },
  'ring.color': { label: 'Ring colour', type: 'color', group: 'Light', when: o => o.ring },
};
/** The keyable properties an object has. Cameras keep their rig; the LED and paths have no transform record. */
export const propsFor = o => Object.keys(PROPS).filter(k => {
  const P = PROPS[k];
  if (o.type === 'camera') return false;
  if (P.group === 'Transform' || k === 'visible') return !!o.transform;
  if (P.types && !P.types.includes(o.type)) return false;
  return !P.when || P.when(o);
});

const SUB = /^(constraints|behaviours|clips)\.([^.]+)\.(.+)$/;
const CON_DEF = { influence: 1, u: 0 };
const AXES = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };

/** The static (document) value of an object property: what it is when it has no keys. */
export function staticValue(o, prop) {
  const tf = o.transform || {}, m = prop.match(/^(position|rotation|scale)\.([xyz])$/);
  if (m) { const i = 'xyz'.indexOf(m[2]);
    if (m[1] === 'position') return (tf.position || [0, 0, 0])[i];
    if (m[1] === 'scale') return (tf.scale || [1, 1, 1])[i];
    return eulerFromQuat(tf.quaternion || [0, 0, 0, 1])[i]; }
  const s = prop.match(SUB);
  if (s) { const item = (o[s[1]] || []).find(x => x.id === s[2]); if (!item) return undefined;
    if (s[1] === 'behaviours') return s[3] === 'weight' ? (item.weight ?? 1) : (item.params?.[s[3]] ?? BEHAVIOURS[item.type]?.params[s[3]]?.def);
    if (s[1] === 'clips') return item[s[3]] ?? 1;
    return item[s[3]] ?? CON_DEF[s[3]]; }
  if (prop === 'visible') return o.visible !== false;
  const v = prop.split('.').reduce((x, k) => x?.[k], o);
  if (v !== undefined) return v;
  if (prop === 'emission') return 1.5;
  return PROPS[prop]?.def;
}

/** Write a static value back into the object (the inverse of staticValue). */
export function setStaticValue(o, prop, v) {
  const m = prop.match(/^(position|rotation|scale)\.([xyz])$/);
  if (m) { const tf = o.transform ||= { position: [0, 0, 0] }, i = 'xyz'.indexOf(m[2]);
    if (m[1] === 'rotation') { const e = eulerFromQuat(tf.quaternion || [0, 0, 0, 1]); e[i] = v; tf.quaternion = quatFromEuler(e); }
    else { tf[m[1]] = (tf[m[1]] || (m[1] === 'scale' ? [1, 1, 1] : [0, 0, 0])).slice(); tf[m[1]][i] = v; }
    return; }
  const s = prop.match(SUB);
  if (s) { const item = (o[s[1]] || []).find(x => x.id === s[2]); if (!item) throw new Error(`${o.id} has no ${s[1]} ${s[2]}`);
    if (s[1] === 'behaviours' && s[3] !== 'weight') (item.params ||= {})[s[3]] = v; else item[s[3]] = v; return; }
  const ks = prop.split('.'); let x = o; for (const k of ks.slice(0, -1)) x = x[k] ??= {}; x[ks[ks.length - 1]] = v;
}

/** Which objects need evaluating (keys, parent, constraints, behaviours, clips), in parent-first order. Run once per
 *  document change (indexDoc). */
export function indexAnim(doc, tracksByKey) {
  const byId = Object.fromEntries(doc.objects.map(o => [o.id, o])), keyed = {};
  for (const tr of doc.tracks) if (tr.keys.length && byId[tr.target] && byId[tr.target].type !== 'camera') (keyed[tr.target] ||= []).push(tr);
  const own = o => !!(keyed[o.id] || o.parent || (o.constraints || []).some(c => c.on !== false) || (o.behaviours || []).some(b => b.on !== false) || (o.clips || []).length);
  const animated = new Set(), deps = o => [o.parent, ...(o.constraints || []).filter(c => c.on !== false).map(c => c.target || c.path)].filter(Boolean);
  const order = [], state = {};
  const topo = (o, stack = []) => { if (state[o.id] === 2) return; if (state[o.id] === 1) throw new Error(`dependency cycle: ${[...stack, o.id].join(' → ')}`);
    state[o.id] = 1; for (const d of deps(o)) if (byId[d]) topo(byId[d], [...stack, o.id]); state[o.id] = 2; order.push(o.id); };
  for (const o of doc.objects) topo(o);
  for (const id of order) { const o = byId[id]; if (own(o) || deps(o).some(d => animated.has(d))) animated.add(id); }
  return { animated, order: order.filter(id => animated.has(id)), keyed, byId, tracksByKey, paths: {} };
}

/** Arc-length table for a path object (cached on the index; paths are static geometry). */
function railOf(A, p) {
  if (A.paths[p.id]) return A.paths[p.id];
  const P = p.points, n = P.length, closed = !!p.closed, segs = closed ? n : n - 1;
  const pt = (i) => P[closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i))];
  const cr = (s, u) => { const p0 = pt(s - 1), p1 = pt(s), p2 = pt(s + 1), p3 = pt(s + 2), u2 = u * u, u3 = u2 * u;   // Catmull-Rom
    return [0, 1, 2].map(c => 0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * u + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * u2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * u3)); };
  const N = 32 * segs, at = [], len = [0];
  for (let i = 0; i <= N; i++) { const g = i / N * segs, s = Math.min(segs - 1, Math.floor(g)); at.push(cr(s, g - s)); if (i) len.push(len[i - 1] + Math.hypot(...sub(at[i], at[i - 1]))); }
  return A.paths[p.id] = { at, len, total: len[N], N };
}
function railAt(R, u) {
  const d = Math.max(0, Math.min(1, u)) * R.total; let lo = 0, hi = R.N;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (R.len[m] < d) lo = m; else hi = m; }
  const k = (d - R.len[lo]) / Math.max(1e-12, R.len[hi] - R.len[lo]);
  return { pos: add(R.at[lo], scl(sub(R.at[hi], R.at[lo]), k)), tan: nrm(sub(R.at[hi], R.at[lo])) };
}

const blendTRS = (a, b, k) => k >= 1 ? b : k <= 0 ? a : { position: a.position.map((v, i) => v + (b.position[i] - v) * k), quaternion: slerp(a.quaternion, b.quaternion, k), scale: a.scale.map((v, i) => v + (b.scale[i] - v) * k) };
/** A rotation whose `axis` (local) points along dir, with local +Y as close to `up` as possible. */
function aimQuat(dir, axis, up = [0, 1, 0]) {
  const f = nrm(dir); let r = cross(up, f); if (Math.hypot(...r) < 1e-6) r = cross([1, 0, 0], f); r = nrm(r); const u = cross(f, r);
  const base = quatFromBasis(r, u, f);   // local +Z -> f
  // then turn the chosen local axis onto local +Z first (shortest arc), so that axis is the one that ends up on f
  const ax = AXES[axis || '+z'] || AXES['+z'], d = ax[2];
  const toZ = d < -0.5 ? [0, 1, 0, 0] : (v => { const l = Math.hypot(...v); return v.map(x => x / l); })([...cross(ax, [0, 0, 1]), 1 + d]);
  return quatMul(base, toZ);
}

/** Evaluate every animated object at t. Returns { [id]: { matrix (world, column-major), visible, props, clips } }.
 *  `geo.clips[id][name]` gives clip durations (from the loaded assets) for looping. */
export function evaluateObjects(doc, t, ix, geo = {}) {
  const A = ix.anim, out = {}; if (!A || !A.order.length) return out;
  const world = {};   // world matrices at t of everything we touch (animated or static)
  const worldOf = id => { if (world[id]) return world[id]; const o = A.byId[id]; if (!o) return M4.id();
    if (out[id]) return out[id].matrix; return world[id] = staticWorld(o); };
  const staticWorld = o => o.transform ? (o.parent ? M4.mul(worldOf(o.parent), trsOf(o.transform)) : trsOf(o.transform)) : M4.trs(o.position || [0, 0, 0]);
  for (const id of A.order) {
    const o = A.byId[id], keyed = Object.fromEntries((A.keyed[id] || []).map(tr => [tr.prop, tr]));
    const val = p => keyed[p] ? typedValue(keyed[p], t) : staticValue(o, p);
    // local transform from keys (unkeyed components keep the document's values)
    const tf = o.transform || { position: o.position || [0, 0, 0] }, anyK = g => ['x', 'y', 'z'].some(a => keyed[`${g}.${a}`]);
    const pos = anyK('position') ? ['x', 'y', 'z'].map(a => val('position.' + a)) : (tf.position || [0, 0, 0]).slice();
    let q = anyK('rotation') ? quatFromEuler(['x', 'y', 'z'].map(a => val('rotation.' + a))) : (tf.quaternion || [0, 0, 0, 1]).slice();
    let sc = anyK('scale') ? ['x', 'y', 'z'].map(a => val('scale.' + a)) : (tf.scale || [1, 1, 1]).slice();
    // behaviours: offsets in parent space, rotations about local axes, multipliers on properties
    const mul = {};
    for (const b of (o.behaviours || [])) {
      const B = BEHAVIOURS[b.type]; if (!B || b.on === false) continue;
      const w = val(`behaviours.${b.id}.weight`); if (!(w > 0)) continue;
      const p = { ...behaviourDefaults(b.type) }; for (const k of Object.keys(p)) p[k] = val(`behaviours.${b.id}.${k}`);
      const r = B.apply(p, t, seedOf(`${o.id}/${b.id}`), b.prop || B.target); if (!r) continue;
      if (r.pos) for (let i = 0; i < 3; i++) pos[i] += r.pos[i] * w;
      if (r.rot) q = quatMul(q, w >= 1 ? r.rot : slerp([0, 0, 0, 1], r.rot, w));
      if (r.scale) sc = sc.map(v => v * (1 + (r.scale - 1) * w));
      if (r.mul) for (const [k, f] of Object.entries(r.mul)) mul[k] = (mul[k] ?? 1) * (1 + (f - 1) * w);
    }
    let M = M4.trs(pos, q, sc);
    if (o.parent) M = M4.mul(worldOf(o.parent), M);
    // constraints, in order, each blended by its influence
    for (const c of (o.constraints || [])) {
      if (c.on === false) continue;
      const k = val(`constraints.${c.id}.influence`); if (!(k > 0)) continue;
      const cur = decompose(M); let next = cur;
      if (c.type === 'attach' && A.byId[c.target]) next = decompose(M4.mul(worldOf(c.target), c.offset ? trsOf(c.offset) : M4.id()));
      else if (c.type === 'lookAt' && A.byId[c.target]) {
        const T = worldOf(c.target), tp = c.centre && geo.local?.[c.target] ? xf(T, geo.local[c.target]) : [T[12], T[13], T[14]];
        next = { ...cur, quaternion: aimQuat(sub(tp, cur.position), c.axis, c.up) };
      } else if (c.type === 'followPath' && A.byId[c.path]?.points?.length > 1) {
        const P = A.byId[c.path], PW = worldOf(c.path), r = railAt(railOf(A, P), val(`constraints.${c.id}.u`));
        const wp = xf(PW, r.pos), wt = nrm(sub(xf(PW, add(r.pos, r.tan)), wp));
        next = { ...cur, position: wp, quaternion: c.orient === false ? cur.quaternion : aimQuat(wt, c.axis || '+z', c.up) };
      }
      const b = blendTRS(cur, next, k); M = M4.trs(b.position, b.quaternion, b.scale);
    }
    // properties: keyed or static, times behaviour multipliers
    const props = {};
    for (const p of propsFor(o)) if (PROPS[p].group !== 'Transform' && p !== 'visible') { let v = val(p); if (mul[p] !== undefined && typeof v === 'number') v *= mul[p]; props[p] = v; }
    for (const [p, f] of Object.entries(mul)) if (props[p] === undefined) { const v = staticValue(o, p); if (typeof v === 'number') props[p] = v * f; }
    out[id] = { matrix: Array.from(M), visible: !!val('visible'), props, clips: clipsAt(o, t, val, geo.clips?.[id]) };
  }
  return out;
}

/** Baked glTF clips at t: [{ name, time, weight }]. A clip plays from `start` at `speed`; a later clip fades in over
 *  `fadeIn` s on top of earlier ones; before the first clip starts, its first frame holds (like a track's first key). */
export function clipsAt(o, t, val, dur = {}) {
  const C = (o.clips || []).filter(c => c.on !== false).slice().sort((a, b) => a.start - b.start); if (!C.length) return [];
  const live = C.filter(c => t >= c.start && (c.end === undefined || t < c.end));
  if (!live.length) { const c = t < C[0].start ? C[0] : C.filter(c => t >= c.start).pop(); return [{ name: c.name, time: localTime(c, Math.min(t, c.end ?? t), dur[c.name]), weight: 1 }]; }
  const out = []; let rest = 1;
  for (const c of live.slice().reverse()) {
    const w = Math.max(0, Math.min(1, val(`clips.${c.id}.weight`))) * (c.fadeIn > 0 ? Math.min(1, (t - c.start) / c.fadeIn) : 1);
    out.push({ name: c.name, time: localTime(c, t, dur[c.name]), weight: w * rest }); rest *= 1 - w; if (rest <= 1e-6) break;
  }
  return out.filter(c => c.weight > 0);
}
function localTime(c, t, D) {
  const x = (c.offset || 0) + Math.max(0, t - c.start) * (c.speed ?? 1); if (!(D > 0)) return x;
  const loop = c.loop || 'repeat';
  if (loop === 'once') return Math.max(0, Math.min(D, x));
  if (loop === 'pingpong') { const m = ((x % (2 * D)) + 2 * D) % (2 * D); return m <= D ? m : 2 * D - m; }
  return ((x % D) + D) % D;
}
