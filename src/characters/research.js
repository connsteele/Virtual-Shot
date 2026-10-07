// Characters research pass (7 Oct overnight): crowds of 1/5/20 characters for cost and renders, in the character lab
// (a lit test set) and in the editor's Black Page shot (figurines on the mouse pad, through the real ShotRenderer and
// its per-pass GPU timing). Loaded on demand with import() from a headless script; nothing here runs by default, and
// the editor is only touched when attachToEditor() is called.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { rigFromScene, prepareClip, evalCharacter, indexTracks, retargetRestRelative, restFromClip, alignRest, identityMap,
  MIXAMO_TO_ROBOT, segmentError, fk, blockWeights, blockTime, sampleClip, samplerFor, restLocals } from './pose.js';
import { bodyMaterial } from '../render/materials.js';

const clone = o => JSON.parse(JSON.stringify(o));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r2 = x => Math.round(x * 100) / 100;
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const stats = a => ({ mean: r2(mean(a)), p50: r2(pct(a, .5)), p95: r2(pct(a, .95)), max: r2(Math.max(...a)) });

/** Wait for the GPU, capped so a bench can't hang (brief: timeouts on every GPU await). */
export const gpuIdle = (device, cap = 2000) => Promise.race([device.queue.onSubmittedWorkDone(), sleep(cap)]);

// ---------------------------------------------------------------------------------------------------------------------
// Assets (the lab's loader, reusable outside the lab)

export async function loadCharAssets(doc) {
  const loader = new GLTFLoader(), A = {};
  await Promise.all(Object.entries(doc.assets).map(async ([id, a]) => {
    const g = await loader.loadAsync(a.url), rig = rigFromScene(g.scene, a.profile);
    A[id] = { gltf: g, rig, raw: Object.fromEntries(g.animations.map(c => [c.name, c])), clips: {} };
  }));
  for (const [id, a] of Object.entries(doc.assets)) {
    const X = A[id];
    for (const c of Object.values(X.raw)) X.clips[c.name] = prepareClip(X.rig, c);
    for (const r of a.retarget || []) {
      const S = A[r.from], map = r.map === 'identity' ? identityMap(S.rig, X.rig) : MIXAMO_TO_ROBOT;
      const dstRest = r.align ? alignRest(S.rig, X.rig, map) : undefined;
      for (const name of r.clips) {
        const rc = retargetRestRelative(S.rig, X.rig, S.raw[name], map, { dstRest }), sc = S.clips[name], ratio = X.rig.hipHeight / S.rig.hipHeight;
        X.raw[`${r.from}/${name}`] = rc;
        X.clips[`${r.from}/${name}`] = prepareClip(X.rig, rc, { contacts: sc.contacts, stride: sc.stride.map(g => g.map(v => v * ratio)) });
      }
    }
  }
  return A;
}

// ---------------------------------------------------------------------------------------------------------------------
// Crowds: n copies of the scene's characters (cycling X Bot / Soldier / Robot), each group shifted in space and in
// clip phase so poses differ, with its travel keys moved along.

export function crowdDoc(base, n, { dz = 0.9, phase = 0.37, ik } = {}) {
  const doc = clone(base), chars = base.objects.filter(o => o.type === 'character'), G = Math.ceil(n / chars.length);
  doc.objects = base.objects.filter(o => o.type !== 'character'); doc.tracks = base.tracks.filter(t => !chars.some(c => c.id === t.target));
  for (let k = 0; k < n; k++) {
    const src = chars[k % chars.length], g = Math.floor(k / chars.length), c = clone(src), id = `${src.id}_${k}`;
    const oz = (g - (G - 1) / 2) * dz, ox = ((g * 37) % 5 - 2) * 0.45;
    c.id = id; c.name = `${src.name} ${k}`; c.transform.position = [c.transform.position[0] + ox, 0, c.transform.position[2] + oz];
    if (ik !== undefined) c.ik = { ...(c.ik || {}), feet: ik };
    c.clips.forEach(b => { b.offset = (b.offset || 0) + g * phase; });
    for (const tr of base.tracks.filter(t => t.target === src.id)) {
      const t2 = clone(tr); t2.target = id;
      if (tr.prop === 'x') t2.keys.forEach(kk => { kk.v += ox; }); if (tr.prop === 'z') t2.keys.forEach(kk => { kk.v += oz; });
      doc.tracks.push(t2);
    }
    doc.objects.push(c);
  }
  return doc;
}

export function evaluateCrowd(doc, A, t) {
  const ix = indexTracks(doc), out = {};
  for (const ch of doc.objects) if (ch.type === 'character') out[ch.id] = evalCharacter(doc, ch, t, A, { ix });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Instances in any three.js scene: skinned clones under one parent matrix (the lab: identity; the editor: figurines)

export class CrowdView {
  constructor(scene, A, { parent = new THREE.Matrix4(), material = null } = {}) { Object.assign(this, { scene, A, parent, material, inst: {} }); }
  sync(doc) {
    const want = new Set(doc.objects.filter(o => o.type === 'character').map(o => o.id));
    for (const id of Object.keys(this.inst)) if (!want.has(id)) { this.scene.remove(this.inst[id].group); delete this.inst[id]; }
    for (const ch of doc.objects) {
      if (ch.type !== 'character' || this.inst[ch.id]) continue;
      const X = this.A[ch.asset], model = SkeletonUtils.clone(X.gltf.scene), group = new THREE.Group();
      group.matrixAutoUpdate = false; group.add(model);
      model.traverse(o => { if (o.isMesh) { o.frustumCulled = false; if (this.material) o.material = this.material(o.material); } });
      this.scene.add(group);
      const skel = []; model.traverse(o => { if (o.isSkinnedMesh) skel.push(o.skeleton); });
      this.inst[ch.id] = { group, model, skel, fix: new THREE.Matrix4().fromArray(X.rig.fix), bones: X.rig.bones.map(b => model.getObjectByName(b.name)) };
    }
  }
  apply(R) {
    for (const [id, r] of Object.entries(R)) {
      const I = this.inst[id]; if (!I) continue;
      I.group.matrix.multiplyMatrices(this.parent, r.matrix).multiply(I.fix); I.group.matrixWorldNeedsUpdate = true;
      r.locals.forEach((l, i) => { const b = I.bones[i]; if (!b) return; b.position.fromArray(l.p); b.quaternion.fromArray(l.q); b.scale.fromArray(l.s); });
    }
  }
  /** The CPU half of "skinning upload": bone world matrices and the skeletons' bone-matrix arrays (three does this
   *  inside render(); timed separately here so the bench can split it out; render() then finds them up to date). */
  updateSkeletons() { for (const I of Object.values(this.inst)) { I.group.updateMatrixWorld(true); for (const s of I.skel) s.update(); } }
  setVisible(v) { for (const I of Object.values(this.inst)) I.group.visible = v; }
  stats() { let bones = 0, verts = 0, skinned = 0; for (const I of Object.values(this.inst)) I.model.traverse(o => { if (o.isSkinnedMesh) { skinned++; bones += o.skeleton.bones.length; verts += o.geometry.attributes.position.count; } }); return { skinnedMeshes: skinned, bones, verts }; }
}

// ---------------------------------------------------------------------------------------------------------------------
// Editor: figurines in the Black Page shot (on the mouse pad behind the Wii remote), lit by the shot's own body shader

export async function attachToEditor(E, { n = 5, scale = 0.018, at = [0.53, 0.0035, 0.28], yaw = -21, tOffset = 0 } = {}) {
  const base = await (await fetch('/scenes/characters.scene.json', { cache: 'no-store' })).json();
  const A = E.charA ||= await loadCharAssets(base);
  const parent = new THREE.Matrix4().compose(new THREE.Vector3(...at), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw * Math.PI / 180), new THREE.Vector3().setScalar(scale))
    .multiply(new THREE.Matrix4().makeTranslation(1.5, 0, 0));   // the crowd's walk is centred on x = -1.5
  const mats = new Map(), U = E.shot.U;
  const material = src => { if (!mats.has(src)) mats.set(src, bodyMaterial(U, { map: src.map || null })); return mats.get(src); };
  if (E.crowd) { E.crowd.view.sync({ objects: [] }); }
  const view = new CrowdView(E.shot.scene, A, { parent, material });
  const doc = crowdDoc(base, n); view.sync(doc);
  const shot = E.shot, perf = E.perf;
  const crowd = E.crowd = { view, doc, A, n, tOffset, timing: { eval: [], apply: [], skel: [] } };
  // pose before every render of the shot (camera view, free view, renders to disk); the time core stays pure
  if (!shot._renderNoChars) {
    shot._renderNoChars = shot.render.bind(shot);
    shot.render = (st, opts) => {
      const C = E.crowd;
      if (C && C.n) {
        const t = ((st.t + C.tOffset) % C.doc.duration + C.doc.duration) % C.doc.duration;
        let t0 = performance.now(); const R = evaluateCrowd(C.doc, C.A, t); let t1 = performance.now(); C.timing.eval.push(t1 - t0); perf.part('characters: evaluate', t1 - t0);
        t0 = t1; C.view.apply(R); t1 = performance.now(); C.timing.apply.push(t1 - t0); perf.part('characters: copy pose to bones', t1 - t0);
        t0 = t1; C.view.updateSkeletons(); t1 = performance.now(); C.timing.skel.push(t1 - t0); perf.part('characters: bone matrices', t1 - t0);
      }
      return shot._renderNoChars(st, opts);
    };
  }
  return { n, ...view.stats() };
}

export function detachFromEditor(E) {
  if (E.crowd) { E.crowd.view.sync({ objects: [] }); E.crowd = null; }
  if (E.shot._renderNoChars) { E.shot.render = E.shot._renderNoChars; delete E.shot._renderNoChars; }
}

/** Per-pass GPU and CPU parts in the editor for one crowd size, at one quality, over `frames` sequential frames. */
export async function benchEditor(E, { quality = 'render', from = 700, frames = 30, warm = 8 } = {}) {
  const dev = E.shot.renderer.backend.device, perf = E.perf;
  perf.toggle(true);
  for (let i = 0; i < warm; i++) { E.frame = from + i; E.renderNow(quality, { output: true }); await gpuIdle(dev); }
  await sleep(200); await perf.resolve(); perf.reset(); if (E.crowd) E.crowd.timing = { eval: [], apply: [], skel: [] };
  const wall = [];
  for (let i = 0; i < frames; i++) {
    E.frame = from + warm + i; const t0 = performance.now(); E.renderNow(quality, { output: true }); await gpuIdle(dev); wall.push(performance.now() - t0);
    if (i % 5 === 4) await perf.resolve();
  }
  await sleep(300); perf.resolving = false; await perf.resolve();
  const s = perf.summary(perf.frames).output;
  return { quality, frames, cpu_ms: s.cpu_ms, gpu_ms: s.gpu_ms, gpu_pass_mean_ms: s.gpu_pass_mean_ms, cpu_part_mean_ms: s.cpu_part_mean_ms, wall_ms: stats(wall) };
}

/** Scrubbing in the editor: random frames vs sequential, Play quality, the viewport's own path (renderNow('play')). */
export async function scrubEditor(E, { frames = 40, seed = 7 } = {}) {
  const dev = E.shot.renderer.backend.device, out = {};
  let x = seed; const rnd = () => (x = (x * 16807) % 2147483647) / 2147483647;
  for (const mode of ['sequential', 'random']) {
    const cpu = [], wall = [];
    for (let i = 0; i < frames; i++) {
      E.frame = mode === 'sequential' ? 600 + i : Math.floor(rnd() * E.last);
      const t0 = performance.now(); E.renderNow('play'); const t1 = performance.now(); await gpuIdle(dev); cpu.push(t1 - t0); wall.push(performance.now() - t0);
    }
    out[mode] = { cpu_ms: stats(cpu), wall_ms: stats(wall), evaluate_ms: E.crowd ? stats(E.crowd.timing.eval.slice(-frames)) : null };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// CPU-only benches (no GPU): evaluate cost by count, sequential vs random (scrub) order, foot lock on/off

export function cpuBench(base, A, { counts = [1, 5, 20], frames = 120, reps = 3 } = {}) {
  const out = {};
  for (const n of counts) for (const ik of [false, true]) for (const order of ['sequential', 'random']) {
    const doc = crowdDoc(base, n, { ik }), ts = [...Array(frames).keys()].map(i => 0.5 + i / 60);
    if (order === 'random') { let x = 11; ts.sort(() => ((x = (x * 16807) % 2147483647) / 2147483647) - 0.5); }
    const per = [];
    for (let r = 0; r < reps + 1; r++) { const t0 = performance.now(); for (const t of ts) evaluateCrowd(doc, A, t); if (r) per.push((performance.now() - t0) / frames); }
    out[`${n} chars · foot lock ${ik ? 'on' : 'off'} · ${order}`] = r2(Math.min(...per) * 1000) / 1000;
  }
  return out;
}

/** Where evaluate's time goes for one character: clip sampling, blending, FK, foot lock (it re-evaluates the pose at
 *  each locked foot's contact start, so up to 3 poses per frame). */
export function evalBreakdown(base, A, { frames = 300 } = {}) {
  const ch = base.objects.find(o => o.id === 'bot'), X = A[ch.asset], rig = X.rig, S = X.clips.walk.sampler, out = {};
  const time = (name, fn) => { const t0 = performance.now(); for (let i = 0; i < frames; i++) fn(1 + i / 60); out[name] = r2((performance.now() - t0) / frames * 1000) / 1000; };
  for (let k = 0; k < 2; k++) {
    time('sampleClip (1 clip, ms)', t => sampleClip(rig, S, t % X.clips.walk.duration));
    time('fk (ms)', () => fk(rig, restLocals(rig)));
    time('evalCharacter, foot lock off (ms)', t => evalCharacter(base, { ...ch, ik: { feet: false } }, t, A));
    time('evalCharacter, foot lock on (ms)', t => evalCharacter(base, ch, t, A));
  }
  out.bones = rig.bones.length;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Variations: speed changes, clip blending, many clips; quality numbers without the GPU

/** Foot sliding (cm/s while planted) and how much IK had to move the foot (cm) for a doc and character. */
export function slideStats(doc, A, id, { from = 0, to = doc.duration, fps = 60 } = {}) {
  const res = {}, ch0 = doc.objects.find(o => o.id === id), X = A[ch0.asset];
  for (const ik of [false, true]) {
    const d = clone(doc), ch = d.objects.find(o => o.id === id); ch.ik = { ...(ch.ik || {}), feet: ik };
    const ix = indexTracks(d); let slide = 0, time = 0, prev = null, worstLeg = 0;
    for (let t = from; t <= to; t += 1 / fps) {
      const r = evalCharacter(d, ch, t, A, { ix }), act = blockWeights(ch.clips, t).filter(x => X.clips[x.b.clip]);
      if (!act.length) { prev = null; continue; }
      const dom = act.reduce((a, b) => (b.w > a.w ? b : a)), c = X.clips[dom.b.clip], tau = blockTime(dom.b, t, c.duration).tau;
      const feet = X.rig.legs.map(l => new THREE.Vector3().setFromMatrixPosition(r.world[l[2]]).applyMatrix4(r.matrix));
      const planted = c.contacts.map(iv => iv.some(([a, b]) => tau >= a + 0.05 && tau <= b - 0.05));
      if (ik) { // leg overextension: thigh->foot distance against the rest leg length
        X.rig.legs.forEach(l => { const a = new THREE.Vector3().setFromMatrixPosition(r.world[l[0]]), f = new THREE.Vector3().setFromMatrixPosition(r.world[l[2]]);
          const W0 = X._W0 ||= fk(X.rig, restLocals(X.rig)), L0 = new THREE.Vector3().setFromMatrixPosition(W0[l[0]]).distanceTo(new THREE.Vector3().setFromMatrixPosition(W0[l[1]])) + new THREE.Vector3().setFromMatrixPosition(W0[l[1]]).distanceTo(new THREE.Vector3().setFromMatrixPosition(W0[l[2]]));
          worstLeg = Math.max(worstLeg, a.distanceTo(f) / L0); }); }
      if (prev) feet.forEach((p, i) => { if (planted[i] && prev.planted[i]) { slide += Math.hypot(p.x - prev.feet[i].x, p.z - prev.feet[i].z); time += 1 / fps; } });
      prev = { feet, planted };
    }
    res[ik ? 'lockOn' : 'lockOff'] = { plantedS: r2(time), slideCmPerS: r2(100 * slide / Math.max(time, 1e-6)), ...(ik ? { maxLegStretch: r2(worstLeg) } : {}) };
  }
  return res;
}

/** One walker with a block list, travel keyed to the clip's stride at speed `travelFactor`. */
export function walkerDoc(base, { asset = 'xbot', blocks, travel = null, ik = true, dur = 8 }) {
  const ch = { id: 'w', name: 'walker', type: 'character', asset, transform: { position: [-4, 0, 0], yaw: 90 }, ik: { feet: ik }, clips: blocks };
  const doc = { ...clone(base), duration: dur, objects: [ch], tracks: [] };
  if (travel) for (const [prop, a, b] of [['x', travel.from[0], travel.to[0]], ['z', travel.from[1], travel.to[1]]])
    doc.tracks.push({ target: 'w', prop, keys: [{ t: travel.t0, v: a, curve: 'linear' }, { t: travel.t1, v: b, curve: 'linear' }] });
  return doc;
}

/** The clip's ground speed in metres/s on that asset (the stride the contacts measured). */
export function strideSpeed(A, asset, clip, scale = 1) { const c = A[asset].clips[clip]; const g = c.stride.reduce((a, v) => [a[0] + v[0] / c.stride.length, a[1] + v[1] / c.stride.length], [0, 0]); return Math.hypot(...g) * scale; }

export function variations(base, A) {
  const out = {}, sc = a => base.assets[a].scale ?? 1;
  const B = (o) => ({ id: o.id || o.clip, row: 0, offset: 0, speed: 1, loop: true, blendIn: 0, blendOut: 0, root: 'inPlace', ...o });
  // 1. speed changes: walk at 0.5x .. 2x, travel matched to stride x speed (what "match travel" would key), and
  //    travel left at 1x (the user changed speed but not the travel: the lock has to absorb it)
  out.speed = {};
  for (const asset of ['xbot', 'robot']) for (const sp of [0.5, 0.75, 1, 1.5, 2]) {
    const clip = asset === 'xbot' ? 'walk' : 'xbot/walk', v = strideSpeed(A, asset, clip, sc(asset));
    for (const match of [true, false]) {
      const vel = v * (match ? sp : 1), doc = walkerDoc(base, { asset, blocks: [B({ clip, start: 0, end: 6, speed: sp })], travel: { t0: 0, t1: 6, from: [-4, 0], to: [-4 + vel * 6, 0] } });
      out.speed[`${asset} walk ×${sp}${match ? ' (travel matched)' : ' (travel at ×1)'}`] = slideStats(doc, A, 'w', { from: 0.3, to: 5.7 });
    }
  }
  // 2. blending: idle -> walk -> run with crossfades of 0.1 .. 1.0 s (the dominant block switches mid-fade)
  out.crossfade = {};
  const vw = strideSpeed(A, 'xbot', 'walk'), vr = strideSpeed(A, 'xbot', 'run');
  for (const f of [0.1, 0.25, 0.5, 1.0]) {
    const blocks = [B({ id: 'walk', clip: 'walk', start: 0, end: 3 + f / 2, blendOut: f }), B({ id: 'run', clip: 'run', start: 3 - f / 2, end: 6, blendIn: f })];
    // travel: walk speed then run speed, with the speed change spread over the fade
    const x0 = -4, x1 = x0 + vw * (3 - f / 2), x2 = x1 + (vw + vr) / 2 * f, x3 = x2 + vr * (3 - f / 2);
    const doc = walkerDoc(base, { blocks }); doc.tracks.push({ target: 'w', prop: 'x', keys: [{ t: 0, v: x0, curve: 'linear' }, { t: 3 - f / 2, v: x1, curve: 'linear' }, { t: 3 + f / 2, v: x2, curve: 'linear' }, { t: 6, v: x3, curve: 'linear' }] });
    doc.tracks.push({ target: 'w', prop: 'z', keys: [{ t: 0, v: 0 }] });
    const whole = slideStats(doc, A, 'w', { from: 0.3, to: 5.7 }), fade = slideStats(doc, A, 'w', { from: 3 - f / 2 - 0.1, to: 3 + f / 2 + 0.1 });
    out.crossfade[`walk→run fade ${f}s`] = { whole, inFade: fade };
  }
  // 3. many clips: one character with a chain of 12 blocks cycling 4 clips with 0.3 s crossfades; evaluate cost and purity
  const clips = ['idle', 'walk', 'agree', 'run'], chain = [];
  for (let i = 0; i < 12; i++) chain.push(B({ id: 'c' + i, clip: clips[i % 4], start: i * 1.0, end: i * 1.0 + 1.3, blendIn: i ? 0.3 : 0, blendOut: 0.3, root: 'inPlace', row: i % 2 }));
  const many = walkerDoc(base, { blocks: chain, dur: 13.3, ik: true }); many.tracks.push({ target: 'w', prop: 'x', keys: [{ t: 0, v: -4 }] }, { target: 'w', prop: 'z', keys: [{ t: 0, v: 0 }] });
  const ts = [...Array(780).keys()].map(i => i / 60), t0 = performance.now(); for (const t of ts) evalCharacter(many, many.objects[0], t, A); const ms = (performance.now() - t0) / ts.length;
  const h = t => JSON.stringify(evalCharacter(many, many.objects[0], t, A).locals.map(l => l.q.map(v => Math.round(v * 1e6))));
  const fwd = ts.filter((_, i) => i % 7 === 0).map(h), rev = ts.filter((_, i) => i % 7 === 0).reverse().map(h).reverse();
  // stacking: 8 overlapping blocks at once (weights normalised) - the cost per extra active clip
  const stack = n => { const d = walkerDoc(base, { blocks: [...Array(n).keys()].map(i => B({ id: 's' + i, clip: clips[i % 4], start: 0, end: 8, weight: 1, offset: i * 0.21 })), ik: false });
    d.tracks.push({ target: 'w', prop: 'x', keys: [{ t: 0, v: -4 }] }, { target: 'w', prop: 'z', keys: [{ t: 0, v: 0 }] });
    const t1 = performance.now(); for (let i = 0; i < 300; i++) evalCharacter(d, d.objects[0], 1 + i / 60, A); return r2((performance.now() - t1) / 300 * 1000) / 1000; };
  out.manyClips = { blocks: 12, evalMsPerFrame: r2(ms * 1000) / 1000, pureForwardVsReverse: fwd.every((x, i) => x === rev[i]),
    activeClipsCost_ms: Object.fromEntries([1, 2, 4, 8].map(n => [`${n} active`, stack(n)])) };
  return out;
}

/** Retarget comparison on every retargeted clip: three's SkeletonUtils.retargetClip vs rest-relative vs aligned. */
export function retargetTable(A) {
  const src = A.xbot, MIX = side => [[`mixamorig${side}UpLeg`, `mixamorig${side}Leg`], [`mixamorig${side}Leg`, `mixamorig${side}Foot`], [`mixamorig${side}Arm`, `mixamorig${side}ForeArm`], [`mixamorig${side}ForeArm`, `mixamorig${side}Hand`]];
  const segsMix = [...MIX('Left'), ...MIX('Right'), ['mixamorigHips', 'mixamorigNeck']], robotOf = n => Object.entries(MIXAMO_TO_ROBOT).find(([, s]) => s === n)?.[0];
  const skinned = root => { let s = null; root.traverse(o => { if (o.isSkinnedMesh && (!s || o.skeleton.bones.length > s.skeleton.bones.length)) s = o; }); return s; };
  const out = {};
  for (const dstId of ['soldier', 'robot']) for (const clipName of ['walk', 'run', 'idle', 'agree']) {
    const dst = A[dstId], map = dstId === 'robot' ? MIXAMO_TO_ROBOT : identityMap(src.rig, dst.rig), clip = src.raw[clipName];
    const segs = segsMix.map(([a, b]) => dstId === 'robot' ? [a, b, robotOf(a), robotOf(b)] : [a, b, a, b]).filter(s => s[2] && s[3]);
    const m = e => r2(mean(e.map(x => x.mean))), w = e => r2(Math.max(...e.map(x => x.max)));
    const threeClip = SkeletonUtils.retargetClip(skinned(SkeletonUtils.clone(dst.gltf.scene)), skinned(SkeletonUtils.clone(src.gltf.scene)), clip, { names: map, hip: 'mixamorigHips', fps: 30 });
    const e3 = segmentError(src.rig, clip, dst.rig, threeClip, segs), er = segmentError(src.rig, clip, dst.rig, retargetRestRelative(src.rig, dst.rig, clip, map), segs);
    const ea = segmentError(src.rig, clip, dst.rig, retargetRestRelative(src.rig, dst.rig, clip, map, { dstRest: alignRest(src.rig, dst.rig, map) }), segs);
    out[`${dstId} ${clipName}`] = { three_mean: m(e3), three_worst: w(e3), restRel_mean: m(er), restRel_worst: w(er), aligned_mean: m(ea), aligned_worst: w(ea) };
  }
  return out;
}

/** Hand (end-effector) error: direction is retargeted, positions are not. Distance between the two hands relative to
 *  shoulder width, source vs target, over the clip: a proxy for contacts (clapping, hands on hips) that retargeting by
 *  rotations alone can't keep. */
export function handSpacing(A, clipName = 'agree') {
  const src = A.xbot, out = {};
  const f = (rig, clip, l, r, ls, rs) => { const S = samplerFor(rig, clip), vals = [];
    for (let k = 0; k <= 30; k++) { const W = fk(rig, sampleClip(rig, S, k / 30 * clip.duration)), P = i => new THREE.Vector3().setFromMatrixPosition(W[rig.byName[i]]);
      vals.push(P(l).distanceTo(P(r)) / P(ls).distanceTo(P(rs))); } return vals; };
  const s = f(src.rig, src.raw[clipName], 'mixamorigLeftHand', 'mixamorigRightHand', 'mixamorigLeftArm', 'mixamorigRightArm');
  const so = f(A.soldier.rig, A.soldier.raw[`xbot/${clipName}`], 'mixamorigLeftHand', 'mixamorigRightHand', 'mixamorigLeftArm', 'mixamorigRightArm');
  const ro = f(A.robot.rig, A.robot.raw[`xbot/${clipName}`], 'Palm2L', 'Palm2R', 'UpperArmL', 'UpperArmR');
  const diff = (a, b) => r2(mean(a.map((v, i) => Math.abs(v - b[i]))));
  out[clipName] = { xbot_meanHandsOverShoulders: r2(mean(s)), soldier: r2(mean(so)), robot: r2(mean(ro)), soldier_meanAbsDiff: diff(s, so), robot_meanAbsDiff: diff(s, ro) };
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Lab: crowd in the lit test set, GPU bench (one pass + shadow pass), renders to disk

export function labCrowd(VS, n, { ik } = {}) {
  const base = VS.baseDoc ||= clone(VS.E.doc);
  VS.E.doc = crowdDoc(base, n, { ik }); VS.sync();
  return VS.E.doc.objects.filter(o => o.type === 'character').length;
}

export function labCamera(VS, n) {
  const c = VS.G.camera;
  if (n <= 1) { c.position.set(-1.0, 1.9, 7.5); c.lookAt(-1.4, 0.9, -1.2); }
  else if (n <= 5) { c.position.set(-1.2, 3.0, 11); c.lookAt(-1.4, 0.8, -0.5); }
  else { c.position.set(-1.2, 5.2, 14.5); c.lookAt(-1.4, 0.6, -0.3); }
  c.updateProjectionMatrix(); VS.G.orbit.enabled = false;
}

export async function benchLab(VS, { counts = [1, 5, 20], sizes = [[1920, 1080], [3840, 2160]], frames = 40, warm = 10 } = {}) {
  const G = VS.G, r = G.renderer, dev = r.backend.device, out = {}, ts = r.backend.trackTimestamp;
  for (const n of [0, ...counts]) {
    labCrowd(VS, n); labCamera(VS, Math.max(n, 1));
    for (const [w, h] of sizes) {
      r.setPixelRatio(1); r.setSize(w, h, false); G.camera.aspect = w / h; G.camera.updateProjectionMatrix();
      const ev = [], ap = [], sk = [], enc = [], gpu = [], wall = [];
      for (let i = 0; i < warm + frames; i++) {
        const t = 1 + i / 30, rec = i >= warm, W0 = performance.now();
        let t0 = performance.now(); const R = VS.evaluateAll(VS.E.doc, t); let t1 = performance.now(); if (rec) ev.push(t1 - t0);
        t0 = t1; VS.applyResults(R); t1 = performance.now(); if (rec) ap.push(t1 - t0);
        t0 = t1; for (const I of Object.values(G.inst)) { I.group.updateMatrixWorld(true); I.model.traverse(o => { if (o.isSkinnedMesh) o.skeleton.update(); }); } t1 = performance.now(); if (rec) sk.push(t1 - t0);
        t0 = t1; r.render(G.scene, G.camera); t1 = performance.now(); if (rec) enc.push(t1 - t0);
        await gpuIdle(dev); if (rec) wall.push(performance.now() - W0);
        if (ts) { const d = await Promise.race([r.resolveTimestampsAsync('render'), sleep(1000)]); if (rec && d != null) gpu.push(d); }
      }
      out[`${n} chars @ ${w}x${h}`] = { evaluate: stats(ev), copyPose: stats(ap), boneMatrices: stats(sk), encodeSubmit: stats(enc), gpu: gpu.length ? stats(gpu) : null, wall: stats(wall) };
    }
  }
  return out;
}

/** Render a clip of the lab to disk: frames at `fps` from t0 for `seconds`, PNGs through the dev server's /save/. */
export async function renderLab(VS, dir, { t0 = 0.5, seconds = 3, fps = 30, w = 1920, h = 1080 } = {}) {
  const G = VS.G, r = G.renderer, dev = r.backend.device, cv = document.getElementById('gpu');
  r.setPixelRatio(1); r.setSize(w, h, false); G.camera.aspect = w / h; G.camera.updateProjectionMatrix();
  const out = document.createElement('canvas'); out.width = w; out.height = h; const ox = out.getContext('2d'), n = Math.round(seconds * fps), pending = [];
  for (let i = 0; i < n; i++) {
    const t = t0 + i / fps; VS.applyResults(VS.evaluateAll(VS.E.doc, t)); r.render(G.scene, G.camera); ox.drawImage(cv, 0, 0);
    const blob = await new Promise(res => out.toBlob(res, 'image/png'));
    pending.push(fetch(`/save/${dir}/f${String(i).padStart(4, '0')}.png`, { method: 'POST', body: blob }));
    if (pending.length > 4) await pending.shift();
    await gpuIdle(dev);
  }
  await Promise.all(pending);
  return n;
}
