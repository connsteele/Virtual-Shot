// Characters: rigs, clip sampling, blending, retargeting and foot IK, all as pure functions of time.
//
// three.js's AnimationMixer is stateful (it accumulates time and blend weights frame by frame), so it can't give a
// pose for an arbitrary t without replaying from 0. Here a pose is computed straight from the clips' keyframe tracks:
// evalCharacter(doc, ch, t, assets) returns every bone's local transform at t, from the document alone. The renderer
// only copies the result onto the skinned mesh's bones.
//
// Data shapes (plain JSON in the document, plain objects derived once from the loaded assets):
//   character object: { id, type:'character', asset, transform:{position, yaw}, clips:[block...], ik:{feet} }
//   clip block:       { id, clip, row, start, end, offset, speed, loop, blendIn, blendOut, weight, root, rootOffset }
//                     start/end are timeline seconds; offset is the clip time at `start` (trimming the left edge moves
//                     start and offset together); root: 'clip' | 'inPlace' | 'accumulate' (loops carry the stride on).
//   pose keys:        tracks { target: <char id>, prop: 'pose.<bone>', keys:[{t, v:[x,y,z,w], curve}] }, a local
//                     rotation applied on top of the clips (before IK), so a still character can be posed and keyed.
//   rig (derived):    { bones:[{name, parent, p, q, s}], base:[Matrix4 per root bone], byName, hips, legs, height }
import * as THREE from 'three/webgpu';
import { trackValue, trackSegment } from '../core/tracks.js';

const V = () => new THREE.Vector3(), Q = () => new THREE.Quaternion(), M = () => new THREE.Matrix4();
const smooth = x => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };

// ---------------------------------------------------------------------------------------------------------------------
// Rigs

/** Plain-data rig from a loaded glTF scene: bones parents-first, rest local TRS, and the fixed matrix from the model
 *  root to each top-level bone's parent (armature scale, axis fix-ups). Leg chains are found by name. */
export function rigFromScene(root, profile = {}) {
  root.updateMatrixWorld(true);
  let skinned = null; root.traverse(o => { if (o.isSkinnedMesh && (!skinned || o.skeleton.bones.length > skinned.skeleton.bones.length)) skinned = o; });
  if (!skinned) throw new Error('no skinned mesh');
  const set = new Set(skinned.skeleton.bones);
  const depth = b => { let d = 0; for (let p = b.parent; p && set.has(p); p = p.parent) d++; return d; };
  const list = [...set].sort((a, b) => depth(a) - depth(b));
  const index = new Map(list.map((b, i) => [b, i]));
  const rootInv = M().copy(root.matrixWorld).invert();
  const bones = list.map(b => ({ name: b.name, parent: set.has(b.parent) ? index.get(b.parent) : -1,
    p: b.position.toArray(), q: b.quaternion.toArray(), s: b.scale.toArray(),
    base: set.has(b.parent) ? null : M().multiplyMatrices(rootInv, b.parent.matrixWorld).toArray() }));
  // Facing: files disagree (three's Soldier faces -Z, X Bot +Z). Turn every rig to face +Z (its left hip toward +X) by
  // folding a yaw into the root bones' base matrices; the renderer applies the same `fix` to the model.
  const legL = profile.legs?.L?.[0] ?? bones.findIndex(b => /^(mixamorig)?LeftUpLeg$|UpperLegL$/.test(b.name));
  const legR = profile.legs?.R?.[0] ?? bones.findIndex(b => /^(mixamorig)?RightUpLeg$|UpperLegR$/.test(b.name));
  let fix = M();
  if (legL >= 0 && legR >= 0) {
    const W0 = fk({ bones }, bones.map(b => ({ p: b.p, q: b.q, s: b.s }))), side = V().setFromMatrixPosition(W0[legL]).sub(V().setFromMatrixPosition(W0[legR]));
    fix = M().makeRotationY(Math.atan2(side.z, side.x));       // rotate the left-hip direction onto +X
    bones.forEach(b => { if (b.base) b.base = M().multiplyMatrices(fix, M().fromArray(b.base)).toArray(); });
  }
  const byName = Object.fromEntries(bones.map((b, i) => [b.name, i]));
  // GLTFLoader makes node names unique (RobotExpressive's 'Torso' bone becomes 'Torso_1' because a mesh is called
  // 'Torso'), so bone maps also resolve the name without the suffix
  bones.forEach((b, i) => { const base = b.name.replace(/_\d+$/, ''); if (base !== b.name && byName[base] === undefined) byName[base] = i; });
  const find = re => bones.findIndex(b => re.test(b.name));
  const hips = profile.hips ? byName[profile.hips] : find(/hips/i);
  const leg = side => profile.legs?.[side] ? profile.legs[side].map(n => byName[n])
    : side === 'L' ? [find(/^(mixamorig)?LeftUpLeg$|UpperLegL$/), find(/^(mixamorig)?LeftLeg$|LowerLegL$/), find(/^(mixamorig)?LeftFoot$|^FootL$/)]
      : [find(/^(mixamorig)?RightUpLeg$|UpperLegR$/), find(/^(mixamorig)?RightLeg$|LowerLegR$/), find(/^(mixamorig)?RightFoot$|^FootR$/)];
  const rig = { bones, byName, hips, legs: [leg('L'), leg('R')].filter(l => l.every(i => i >= 0)), fix: fix.toArray() };
  const W = fk(rig, restLocals(rig));
  const hp = V().setFromMatrixPosition(W[hips]);
  rig.hipHeight = hp.y;
  rig.ankleRest = rig.legs.map(l => V().setFromMatrixPosition(W[l[2]]).y);
  return rig;
}

export const restLocals = rig => rig.bones.map(b => ({ p: b.p.slice(), q: b.q.slice(), s: b.s.slice() }));

/** Forward kinematics: model-space matrices for local TRS records (parents come first in rig.bones). */
export function fk(rig, L) {
  const W = new Array(rig.bones.length), m = M(), p = V(), q = Q(), s = V();
  rig.bones.forEach((b, i) => {
    m.compose(p.fromArray(L[i].p), q.fromArray(L[i].q), s.fromArray(L[i].s));
    W[i] = b.parent < 0 ? M().fromArray(b.base).multiply(m) : M().multiplyMatrices(W[b.parent], m);
  });
  return W;
}

// ---------------------------------------------------------------------------------------------------------------------
// Clip sampling (no mixer)

/** Index a THREE.AnimationClip by bone: { duration, bones: { boneIndex: { q, p } } } with one interpolant per track. */
export function samplerFor(rig, clip) {
  const bones = {};
  for (const tr of clip.tracks) {
    const pb = THREE.PropertyBinding.parseTrackName(tr.name), name = pb.objectName === 'bones' ? pb.objectIndex : pb.nodeName;
    const i = rig.byName[name]; if (i === undefined) continue;
    const slot = bones[i] ??= {};
    if (pb.propertyName === 'quaternion') slot.q = tr.createInterpolant();
    else if (pb.propertyName === 'position') slot.p = tr.createInterpolant();
  }
  return { name: clip.name, duration: clip.duration, bones };
}

/** Local TRS of every bone at clip time tau (bones without tracks keep their rest values). */
export function sampleClip(rig, S, tau) {
  const L = restLocals(rig);
  for (const k in S.bones) { const slot = S.bones[k], l = L[k];
    if (slot.q) l.q = Array.from(slot.q.evaluate(tau));
    if (slot.p) l.p = Array.from(slot.p.evaluate(tau)); }
  return L;
}

// ---------------------------------------------------------------------------------------------------------------------
// Blocks on the timeline

/** Clip time for a block at timeline time t: raw (unwrapped, for root motion and contacts), wrapped, and cycle count. */
export function blockTime(b, t, duration) {
  const raw = (b.offset || 0) + (t - b.start) * (b.speed ?? 1);
  if (b.loop) { const cyc = Math.floor(raw / duration); return { raw, tau: raw - cyc * duration, cyc }; }
  return { raw, tau: Math.min(duration, Math.max(0, raw)), cyc: 0 };
}

/** Active blocks at t with their weights. Overlaps crossfade over the blend-in / blend-out ramps (UE Sequencer);
 *  when the weights add up to less than 1 the remainder is the rest pose, above 1 they are normalised. */
export function blockWeights(blocks, t) {
  const on = [];
  for (const b of blocks || []) {
    if (b.mute || t < b.start || t >= b.end) continue;
    const bi = b.blendIn || 0, bo = b.blendOut || 0;
    const w = (b.weight ?? 1) * (bi > 0 ? smooth((t - b.start) / bi) : 1) * (bo > 0 ? smooth((b.end - t) / bo) : 1);
    if (w > 1e-6) on.push({ b, w });
  }
  const sum = on.reduce((s, x) => s + x.w, 0);
  if (sum > 1) on.forEach(x => { x.w /= sum; });
  return on;
}

const UP = new THREE.Vector3(0, 1, 0);

/** Local pose of one block at timeline time t, with root motion handled per block.root. */
function blockPose(rig, clipData, b, t) {
  const { raw, tau, cyc } = blockTime(b, t, clipData.duration), L = sampleClip(rig, clipData.sampler, tau), h = rig.hips;
  const mode = b.root || 'clip';
  if (h >= 0 && mode !== 'clip') {
    // root motion lives in the hips' parent space; take the horizontal part through that space's "up"
    const up = clipData.upInHipParent, p = V().fromArray(L[h].p), p0 = V().fromArray(clipData.hipStart);
    const horiz = d => d.sub(up.clone().multiplyScalar(d.dot(up)));
    if (mode === 'inPlace') p.sub(horiz(p.clone().sub(p0)));
    else if (mode === 'accumulate' && b.loop) p.add(horiz(V().fromArray(clipData.hipEnd).sub(p0)).multiplyScalar(cyc));
    L[h].p = p.toArray();
  }
  if (h >= 0 && b.rootOffset) { // metres in character space, converted to hip-parent space
    const off = V().fromArray(b.rootOffset).applyMatrix4(clipData.charToHipParentRot).divideScalar(clipData.hipParentScale);
    L[h].p = V().fromArray(L[h].p).add(off).toArray();
  }
  return { L, raw, tau };
}

/** Weighted blend of local poses (quaternions summed in one hemisphere and normalised; positions summed). */
export function blendPoses(rig, poses) {
  const rest = restLocals(rig); if (!poses.length) return rest;
  const total = poses.reduce((s, x) => s + x.w, 0), all = total < 1 ? [...poses, { L: rest, w: 1 - total }] : poses;
  return rig.bones.map((_, i) => {
    const q = [0, 0, 0, 0], p = [0, 0, 0], s = [0, 0, 0], ref = all[0].L[i].q;
    for (const { L, w } of all) { const a = L[i].q, sg = (a[0] * ref[0] + a[1] * ref[1] + a[2] * ref[2] + a[3] * ref[3]) < 0 ? -w : w;
      for (let k = 0; k < 4; k++) q[k] += a[k] * sg;
      for (let k = 0; k < 3; k++) { p[k] += L[i].p[k] * w; s[k] += L[i].s[k] * w; } }
    const n = Math.hypot(...q) || 1;
    return { p, q: q.map(v => v / n), s };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Derived clip data (computed once per clip at load; recompute if the asset changes)

/** Everything evaluate needs about one clip on one rig: sampler, hip start/end (root motion), foot contacts. */
export function prepareClip(rig, clip, opts = {}) {
  const sampler = samplerFor(rig, clip), h = rig.hips, d = clip.duration;
  const W0 = fk(rig, restLocals(rig)), b = rig.bones[h];
  const parentW = b.parent < 0 ? M().fromArray(b.base) : W0[b.parent];
  const pr = Q(), ps = V(); parentW.decompose(V(), pr, ps);
  const data = { name: clip.name, duration: d, sampler,
    upInHipParent: UP.clone().applyQuaternion(pr.clone().invert()).normalize(),
    charToHipParentRot: M().makeRotationFromQuaternion(pr.clone().invert()), hipParentScale: ps.x,
    hipStart: sampleClip(rig, sampler, 0)[h].p, hipEnd: sampleClip(rig, sampler, d)[h].p };
  data.contacts = opts.contacts || footContacts(rig, data, opts);
  if (opts.stride) data.stride = opts.stride;
  return data;
}

/** Foot contacts per leg as clip-time intervals, from the ankle's height and horizontal velocity in the model.
 *  Also records data.stride[leg]: the ground's apparent velocity under a planted foot (model units/s; ~0 for clips with
 *  root motion, minus the walking speed for in-place clips), which "match travel to stride" uses. */
export function footContacts(rig, data, { heightTol = 0.05, speedTol = 0.35, hz = 60, mergeGap = 0.1, minLen = 0.05 } = {}) {
  const n = Math.max(2, Math.ceil(data.duration * hz)), dt = data.duration / n;
  data.stride = [];
  return rig.legs.map(([, , foot], li) => {
    const pts = [];
    for (let k = 0; k <= n; k++) { const W = fk(rig, sampleClip(rig, data.sampler, k * dt)); pts.push(V().setFromMatrixPosition(W[foot])); }
    const minY = Math.min(...pts.map(p => p.y)), low = pts.map(p => p.y - minY < heightTol * rig.hipHeight);
    const vel = pts.map((p, k) => { const a = pts[Math.max(0, k - 1)], b = pts[Math.min(n, k + 1)], s = dt * (Math.min(n, k + 1) - Math.max(0, k - 1)); return [(b.x - a.x) / s, (b.z - a.z) / s]; });
    // An in-place walk's planted foot slides backward at the stride speed; a root-motion walk's stays put. Take the
    // median velocity of the low frames as "the ground" and call a foot planted when it moves with the ground.
    const lv = vel.filter((_, k) => low[k]), med = i => { const a = lv.map(v => v[i]).sort((x, y) => x - y); return a.length ? a[a.length >> 1] : 0; };
    const g = [med(0), med(1)]; data.stride[li] = g;
    const on = vel.map((v, k) => low[k] && Math.hypot(v[0] - g[0], v[1] - g[1]) < speedTol * rig.hipHeight);
    const iv = []; let s = -1;
    on.forEach((c, k) => { if (c && s < 0) s = k; if ((!c || k === n) && s >= 0) { const e = c ? k : k - 1; iv.push([s * dt, e * dt]); s = -1; } });
    // merge flickers (gaps under mergeGap) and drop blips shorter than minLen
    const merged = []; for (const x of iv) { const L = merged[merged.length - 1]; if (L && x[0] - L[1] < mergeGap) L[1] = x[1]; else merged.push(x.slice()); }
    return merged.filter(([a, b]) => b - a >= minLen);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Evaluate

/** The character's placement at t: transform record plus keyable tracks <id>.x/.y/.z/.yaw (metres, degrees). */
export function charMatrix(doc, ch, t, ix) {
  const T = ch.transform || {}, P = T.position || [0, 0, 0];
  const val = (prop, def) => { const tr = ix ? ix[`${ch.id}.${prop}`] : doc.tracks.find(x => x.target === ch.id && x.prop === prop); return tr ? trackValue(tr, t) : def; };
  const pos = [val('x', P[0]), val('y', P[1]), val('z', P[2])], yaw = val('yaw', T.yaw || 0);
  const scale = (doc.assets[ch.asset]?.scale ?? 1) * (T.scale ?? 1);
  return M().compose(V().fromArray(pos), Q().setFromAxisAngle(UP, yaw * Math.PI / 180), V().setScalar(scale));
}

const slerpArr = (a, b, u) => Q().fromArray(a).slerp(Q().fromArray(b), u).toArray();

/** Pose keys (tracks prop 'pose.<bone>') as local rotations applied after the clips. */
function applyPoseKeys(rig, L, tracks, t) {
  for (const tr of tracks) { if (!tr.keys?.length) continue;
    const i = rig.byName[tr.prop.slice(5)]; if (i === undefined) continue;
    const { a, b, u } = trackSegment(tr, t), d = Q().fromArray(slerpArr(a.v, b.v, u));
    L[i].q = Q().fromArray(L[i].q).multiply(d).toArray(); }
}

export function indexTracks(doc) { return Object.fromEntries(doc.tracks.map(tr => [`${tr.target}.${tr.prop}`, tr])); }

/** Pose of character `ch` at t. Returns { locals, matrix, world (model space), ik:[{leg, w, target}] }.
 *  assets[ch.asset] = { rig, clips: { name: prepared clip data } }. */
export function evalCharacter(doc, ch, t, assets, opts = {}) {
  const A = assets[ch.asset], rig = A.rig, ix = opts.ix || indexTracks(doc);
  const act = blockWeights(ch.clips, t).filter(x => A.clips[x.b.clip]);
  const poses = act.map(x => ({ ...blockPose(rig, A.clips[x.b.clip], x.b, t), w: x.w, b: x.b }));
  const L = blendPoses(rig, poses);
  applyPoseKeys(rig, L, doc.tracks.filter(tr => tr.target === ch.id && tr.prop.startsWith('pose.')), t);
  const matrix = charMatrix(doc, ch, t, ix);
  const out = { locals: L, matrix, ik: [] };
  if (ch.ik?.feet && !opts.noIK && poses.length) footLock(doc, ch, t, assets, rig, L, matrix, poses, out, ix);
  out.world = fk(rig, L);
  return out;
}

/** Foot lock: while the dominant block's clip says a foot is planted, pin the ankle to where it was in the world when
 *  the contact began (evaluated at that earlier time, so it stays a pure function of t) and bend the leg to reach it.
 *  This removes skating from retargeted clips, speed changes and keyed travel that doesn't match the stride. */
function footLock(doc, ch, t, assets, rig, L, matrix, poses, out, ix) {
  const dom = poses.reduce((a, b) => (b.w > a.w ? b : a)), data = assets[ch.asset].clips[dom.b.clip], sp = dom.b.speed ?? 1;
  const fade = ch.ik.fade ?? 0.08, inv = M().copy(matrix).invert();
  rig.legs.forEach((leg, li) => {
    // full lock through the contact, then let go over `fade` seconds after the foot lifts (fading inside the contact
    // would let the planted foot slide); a lock that began before the block started eases in instead
    const iv = data.contacts[li].find(([a, b]) => dom.tau >= a && dom.tau <= b + fade * sp); if (!iv) return;
    let t0 = t - (dom.tau - iv[0]) / sp; t0 = Math.max(t0, dom.b.start);
    const w = dom.w * (dom.tau <= iv[1] ? 1 : 1 - smooth((dom.tau - iv[1]) / sp / fade)) * (t0 > dom.b.start ? 1 : smooth((t - dom.b.start) / fade));
    if (w <= 1e-4) return;
    const then = evalCharacter(doc, ch, t0, assets, { noIK: true, ix });
    const target = V().setFromMatrixPosition(then.world[leg[2]]).applyMatrix4(then.matrix);     // world position at t0
    const floor = ch.ik.floor; if (floor !== undefined) target.y = Math.max(target.y, floor + rig.ankleRest[li] * (matrix.elements[5] || 1));
    const local = target.clone().applyMatrix4(inv);                                              // into model space now
    const W = fk(rig, L), now = V().setFromMatrixPosition(W[leg[2]]);
    twoBoneIK(rig, L, W, leg, now.lerp(local, w));
    out.ik.push({ leg: li, w, target: target.toArray() });
  });
}

/** Analytic two-bone IK (thigh, shin, foot) toward a model-space target, keeping the knee's bend plane and the foot's
 *  world rotation. A foot that isn't the shin's child (an IK-controller rig) is moved to the target instead. */
export function twoBoneIK(rig, L, W, [ia, ib, ic], target) {
  const pos = i => V().setFromMatrixPosition(W[i]), rot = i => { const q = Q(); W[i].decompose(V(), q, V()); return q; };
  const a = pos(ia), b = pos(ib), c = pos(ic), footChild = rig.bones[ic].parent === ib;
  const tip = footChild ? c : b.clone().add(V().subVectors(b, a).normalize().multiplyScalar(c.distanceTo(b)));
  const lab = a.distanceTo(b), lbc = tip.distanceTo(b), eps = 1e-4 * (lab + lbc);
  const d = Math.min(Math.max(target.distanceTo(a), eps), lab + lbc - eps);
  const ang = (u, v) => Math.acos(Math.min(1, Math.max(-1, u.clone().normalize().dot(v.clone().normalize()))));
  const ac = V().subVectors(tip, a), ab = V().subVectors(b, a), ba = V().subVectors(a, b), bc = V().subVectors(tip, b), at = V().subVectors(target, a);
  const acab0 = ang(ac, ab), babc0 = ang(ba, bc), acat0 = ang(ac, at);
  const acab1 = Math.acos(Math.min(1, Math.max(-1, (lbc * lbc - lab * lab - d * d) / (-2 * lab * d))));
  const babc1 = Math.acos(Math.min(1, Math.max(-1, (d * d - lab * lab - lbc * lbc) / (-2 * lab * lbc))));
  let ax0 = V().crossVectors(ac, ab); if (ax0.lengthSq() < 1e-12) ax0 = V().crossVectors(ac, V(0, 0, 1).applyQuaternion(rot(ia))); ax0.normalize();
  let ax1 = V().crossVectors(ac, at); const hasAx1 = ax1.lengthSq() > 1e-12; ax1.normalize();
  const ga = rot(ia), gb = rot(ib), gc = rot(ic);
  const r0 = Q().setFromAxisAngle(ax0.clone().applyQuaternion(ga.clone().invert()), acab1 - acab0);
  const r1 = Q().setFromAxisAngle(ax0.clone().applyQuaternion(gb.clone().invert()), babc1 - babc0);
  const r2 = hasAx1 ? Q().setFromAxisAngle(ax1.clone().applyQuaternion(ga.clone().invert()), acat0) : Q();
  L[ia].q = Q().fromArray(L[ia].q).multiply(r0).multiply(r2).toArray();
  L[ib].q = Q().fromArray(L[ib].q).multiply(r1).toArray();
  const W2 = fk(rig, L);
  const parent = rig.bones[ic].parent, pw = parent < 0 ? M().fromArray(rig.bones[ic].base) : W2[parent];
  const pq = Q(); pw.decompose(V(), pq, V());
  L[ic].q = pq.invert().multiply(gc).toArray();                                         // keep the foot's world rotation
  if (!footChild) L[ic].p = target.clone().applyMatrix4(M().copy(pw).invert()).toArray();
}

// ---------------------------------------------------------------------------------------------------------------------
// Retargeting

/** Retarget a clip from one rig to another by world-space rotation *deltas from each rig's rest pose*:
 *    dstWorld(t) = srcWorld(t) * srcRestWorld^-1 * dstRestWorld
 *  so bones whose local axes differ (bone roll, flipped legs) still match, as long as both rest poses are the same
 *  posture (T-pose to T-pose). `restClip` options give a rig a rest posture from a clip frame instead of its bind pose.
 *  map: { dstBone: srcBone }. The hips' travel is scaled by the hip-height ratio. Returns a THREE.AnimationClip. */
export function retargetRestRelative(src, dst, clip, map, { fps = 30, srcRest, dstRest } = {}) {
  const S = samplerFor(src, clip), n = Math.max(2, Math.round(clip.duration * fps) + 1), dt = clip.duration / (n - 1);
  const rotOf = m => { const q = Q(); m.decompose(V(), q, V()); return q; };
  const Ws0 = fk(src, srcRest || restLocals(src)), Wd0 = fk(dst, dstRest || restLocals(dst));
  const pairs = Object.entries(map).map(([d, s]) => [dst.byName[d], src.byName[s]]).filter(([d, s]) => d !== undefined && s !== undefined);
  const delta0 = new Map(pairs.map(([d, s]) => [d, rotOf(Ws0[s]).invert().multiply(rotOf(Wd0[d]))]));
  const srcOf = new Map(pairs), ratio = dst.hipHeight / src.hipHeight;
  const hs = src.hips, hd = dst.hips, hs0 = V().setFromMatrixPosition(Ws0[hs]), hd0 = V().setFromMatrixPosition(Wd0[hd]);
  const dstOf = new Map(pairs.map(([d, s]) => [s, d]));
  const follow = pairs.map(([d, s]) => [d, dstOf.get(src.bones[s].parent)]).filter(([d, sp]) => sp !== undefined && sp !== dst.bones[d].parent && d !== hd);
  const followP = new Map(follow.map(([d]) => [d, new Float32Array(n * 3)])), followOf = new Map(follow);
  const followPos = (d, f, Wf, pw) => V().setFromMatrixPosition(Wd0[d]).applyMatrix4(M().copy(Wd0[f]).invert()).applyMatrix4(Wf).applyMatrix4(M().copy(pw).invert()).toArray();
  const times = new Float32Array(n), qv =new Map(pairs.map(([d]) => [d, new Float32Array(n * 4)])), pv = new Float32Array(n * 3), feetP = new Map();
  for (let k = 0; k < n; k++) {
    times[k] = k * dt;
    const Ws = fk(src, sampleClip(src, S, k * dt)), Ld = dstRest ? dstRest.map(l => ({ p: l.p.slice(), q: l.q.slice(), s: l.s.slice() })) : restLocals(dst);
    const Wd = new Array(dst.bones.length);
    dst.bones.forEach((b, i) => {
      const pw = b.parent < 0 ? M().fromArray(b.base) : Wd[b.parent];
      const s = srcOf.get(i);
      if (s !== undefined) {
        const world = rotOf(Ws[s]).multiply(delta0.get(i)), pq = rotOf(pw);
        Ld[i].q = pq.invert().multiply(world).toArray();
        Ld[i].q.forEach((v, j) => { qv.get(i)[k * 4 + j] = v; });
      }
      if (i === hd) {
        const wp = hd0.clone().add(V().setFromMatrixPosition(Ws[hs]).sub(hs0).multiplyScalar(ratio));
        Ld[i].p = wp.applyMatrix4(M().copy(pw).invert()).toArray(); Ld[i].p.forEach((v, j) => { pv[k * 3 + j] = v; });
      }
      const f = followOf.get(i);
      if (f !== undefined && f < i) { Ld[i].p = followPos(i, f, Wd[f], pw); Ld[i].p.forEach((v, j) => { followP.get(i)[k * 3 + j] = v; }); }
      Wd[i] = M().multiplyMatrices(pw, M().compose(V().fromArray(Ld[i].p), Q().fromArray(Ld[i].q), V().fromArray(Ld[i].s)));
    });
    // Bones parented differently in the two rigs (an IK-controller foot under the root instead of the shin) follow the
    // bone their source parent maps to, rigidly from the rest pose, so they travel with the limb.
    for (const [d, sp] of follow) {   // the rest follow bones whose limb is solved later in the list (leaf feet)
      if (sp < d) continue;
      const pw = dst.bones[d].parent < 0 ? M().fromArray(dst.bones[d].base) : Wd[dst.bones[d].parent];
      followPos(d, sp, Wd[sp], pw).forEach((v, j) => { followP.get(d)[k * 3 + j] = v; });
    }
  }
  const tracks = [new THREE.VectorKeyframeTrack(`${dst.bones[hd].name}.position`, times, pv)];
  for (const [d, arr] of followP) tracks.push(new THREE.VectorKeyframeTrack(`${dst.bones[d].name}.position`, times, arr));
  for (const [d, arr] of qv) tracks.push(new THREE.QuaternionKeyframeTrack(`${dst.bones[d].name}.quaternion`, times, arr));
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/** A rest posture for `dst` that matches `src`'s rest posture: each mapped bone is swung (no twist) so the direction
 *  to its nearest mapped descendant (by the source hierarchy, so IK-controller feet count) matches the source's. Use it
 *  as dstRest when the two bind poses differ (A-pose vs T-pose, arms down). */
export function alignRest(src, dst, map, srcRest) {
  const Ws = fk(src, srcRest || restLocals(src)), Ld = restLocals(dst), W0 = fk(dst, restLocals(dst));
  const pairs = Object.entries(map).map(([d, s]) => [dst.byName[d], src.byName[s]]).filter(([d, s]) => d !== undefined && s !== undefined);
  const srcOf = new Map(pairs), dstOf = new Map(pairs.map(([d, s]) => [s, d]));
  const depthBelow = (a, b) => { let n = 0; for (let x = b; x >= 0; x = src.bones[x].parent, n++) if (x === a) return n; return -1; };
  // bones parented differently than in the source (IK-controller feet) move rigidly with the bone they follow
  const follow = new Map(pairs.map(([d, s]) => [d, dstOf.get(src.bones[s].parent)]).filter(([d, f]) => f !== undefined && f !== dst.bones[d].parent && d !== dst.hips));
  const P = (W, i) => follow.has(i) ? V().setFromMatrixPosition(W0[i]).applyMatrix4(M().copy(W0[follow.get(i)]).invert()).applyMatrix4(W[follow.get(i)]) : V().setFromMatrixPosition(W[i]);
  dst.bones.forEach((b, i) => {
    const s = srcOf.get(i); if (s === undefined || i === dst.hips) return;
    let best = null, bd = 1e9;
    for (const [j, sj] of pairs) { const n = depthBelow(s, sj); if (n > 0 && n < bd) { bd = n; best = [j, sj]; } }
    if (!best) return;
    const Wd = fk(dst, Ld), dd = P(Wd, best[0]).sub(P(Wd, i)), ds = V().setFromMatrixPosition(Ws[best[1]]).sub(V().setFromMatrixPosition(Ws[s]));
    if (dd.lengthSq() < 1e-12 || ds.lengthSq() < 1e-12) return;
    const swing = Q().setFromUnitVectors(dd.normalize(), ds.normalize()), wq = Q(); Wd[i].decompose(V(), wq, V());
    const pw = b.parent < 0 ? M().fromArray(b.base) : Wd[b.parent], pq = Q(); pw.decompose(V(), pq, V());
    Ld[i].q = pq.invert().multiply(swing.multiply(wq)).toArray();
  });
  const W1 = fk(dst, Ld);
  for (const [d] of follow) { const b = dst.bones[d], pw = b.parent < 0 ? M().fromArray(b.base) : W1[b.parent]; Ld[d].p = P(W1, d).applyMatrix4(M().copy(pw).invert()).toArray(); }
  return Ld;
}

/** A rest posture taken from a clip frame (e.g. a rig whose bind pose is an A-pose but which ships a 'TPose' clip). */
export function restFromClip(rig, clip, tau = 0) { return sampleClip(rig, samplerFor(rig, clip), tau); }

/** Mixamo -> another rig's bone names. three's GLTFLoader strips ':' and '.' from node names. */
export const MIXAMO_TO_ROBOT = {
  Hips: 'mixamorigHips', Abdomen: 'mixamorigSpine', Torso: 'mixamorigSpine2', Neck: 'mixamorigNeck', Head: 'mixamorigHead',
  ShoulderL: 'mixamorigLeftShoulder', UpperArmL: 'mixamorigLeftArm', LowerArmL: 'mixamorigLeftForeArm', Palm2L: 'mixamorigLeftHand',
  ShoulderR: 'mixamorigRightShoulder', UpperArmR: 'mixamorigRightArm', LowerArmR: 'mixamorigRightForeArm', Palm2R: 'mixamorigRightHand',
  UpperLegL: 'mixamorigLeftUpLeg', LowerLegL: 'mixamorigLeftLeg', FootL: 'mixamorigLeftFoot',
  UpperLegR: 'mixamorigRightUpLeg', LowerLegR: 'mixamorigRightLeg', FootR: 'mixamorigRightFoot',
};
export const identityMap = (src, dst) => Object.fromEntries(dst.bones.filter(b => src.byName[b.name] !== undefined).map(b => [b.name, b.name]));

/** Retarget quality: angle between matching limb segments (parent joint -> child joint, world directions in each
 *  model's space) over the clip, in degrees. segs: [[srcA, srcB, dstA, dstB], ...]. */
export function segmentError(src, srcClip, dst, dstClip, segs, { hz = 30 } = {}) {
  const Ss = samplerFor(src, srcClip), Sd = samplerFor(dst, dstClip), n = Math.max(2, Math.round(srcClip.duration * hz));
  const errs = segs.map(() => []);
  for (let k = 0; k <= n; k++) {
    const tau = k / n * srcClip.duration, Ws = fk(src, sampleClip(src, Ss, tau)), Wd = fk(dst, sampleClip(dst, Sd, tau));
    const P = (W, i) => V().setFromMatrixPosition(W[i]);
    segs.forEach(([sa, sb, da, db], j) => {
      const u = P(Ws, src.byName[sa]).sub(P(Ws, src.byName[sb])).multiplyScalar(-1).normalize();
      const v = P(Wd, dst.byName[da]).sub(P(Wd, dst.byName[db])).multiplyScalar(-1).normalize();
      errs[j].push(Math.acos(Math.min(1, Math.max(-1, u.dot(v)))) * 180 / Math.PI);
    });
  }
  return segs.map((s, j) => ({ seg: `${s[2]}→${s[3]}`, mean: +(errs[j].reduce((a, b) => a + b, 0) / errs[j].length).toFixed(2), max: +Math.max(...errs[j]).toFixed(2) }));
}
