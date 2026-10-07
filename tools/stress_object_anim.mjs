// Object animation stress test (research pass, no GPU): evaluate cost per frame against counts, parent-chain depth,
// behaviours, constraints and scrub order; precision of deep chains; where it breaks.
//   node tools/stress_object_anim.mjs [out.json]
// Also writes scenes/_stress/*.scene.json (git-ignored) for the GPU bench in the editor (N animated test cubes).
import fs from 'node:fs';
import { evaluate, indexDoc } from '../src/core/evaluate.js';
import { M4, trsOf, xf, quatFromEuler } from '../src/core/vec.js';

const load = () => JSON.parse(fs.readFileSync(new URL('../scenes/black_page.scene.json', import.meta.url)));
const geo = { centres: {}, local: {}, clips: {}, wii: null };
const r3 = x => Math.round(x * 1000) / 1000;
const out = {};

/** Mean ms per evaluate() over `frames` frames (best of 3 passes), in sequential or shuffled order. */
function bench(doc, { frames = 120, order = 'sequential' } = {}) {
  const ix = indexDoc(doc), ts = [...Array(frames).keys()].map(i => 2 + i / 60);
  if (order === 'random') { let x = 7; ts.sort(() => ((x = (x * 16807) % 2147483647) / 2147483647) - 0.5); }
  let best = 1e9;
  for (let r = 0; r < 4; r++) { const t0 = performance.now(); for (const t of ts) evaluate(doc, t, geo, ix); const ms = (performance.now() - t0) / frames; if (r) best = Math.min(best, ms); }
  return r3(best);
}
const timeIndex = doc => { let best = 1e9; for (let r = 0; r < 4; r++) { const t0 = performance.now(); indexDoc(doc); best = Math.min(best, performance.now() - t0); } return r3(best); };
const keys = (target, prop, a, b) => ({ target, prop, keys: [{ t: 0, v: a, curve: 'linear' }, { t: 4, v: b, curve: 'smooth' }, { t: 8, v: a, curve: 'bezier' }, { t: 12, v: b, curve: 'linear' }] });

function keyedDoc(n, { rot = true, behaviours = null, constraint = null } = {}) {
  const doc = load();
  for (let i = 0; i < n; i++) {
    const id = `e${i}`; doc.objects.push({ id, name: id, type: 'empty', transform: { position: [i * 0.01, 0, 0] } });
    for (const a of ['x', 'y', 'z']) doc.tracks.push(keys(id, `position.${a}`, 0, 0.1 + i * 1e-4));
    if (rot) for (const a of ['x', 'y', 'z']) doc.tracks.push(keys(id, `rotation.${a}`, 0, 30));
    if (behaviours) doc.objects.at(-1).behaviours = behaviours.map((type, k) => ({ id: `b${k}`, type, on: true, params: {} }));
    if (constraint === 'lookAt' && i) doc.objects.at(-1).constraints = [{ id: 'c1', type: 'lookAt', target: 'e0', on: true }];
    if (constraint === 'followPath') doc.objects.at(-1).constraints = [{ id: 'c1', type: 'followPath', path: 'rail', on: true }];
    if (constraint === 'followPath') doc.tracks.push(keys(id, 'constraints.c1.u', 0, 1));
  }
  if (constraint === 'followPath') doc.objects.push({ id: 'rail', type: 'path', name: 'rail', transform: { position: [0, 0, 0] }, points: [[-0.3, 0, 0.4], [-0.1, 0.1, 0.5], [0.1, 0.1, 0.5], [0.3, 0, 0.4], [0.5, 0.05, 0.2]] });
  return doc;
}

// ---- 1. counts: keyed position + rotation (6 tracks x 4 keys each)
out.baseline_blackPage_ms = bench(load());
out.keyed = {};
for (const n of [1, 10, 100, 1000, 5000]) { const d = keyedDoc(n); out.keyed[n] = { evaluate_ms: bench(d, { frames: n > 1000 ? 30 : 120 }), indexDoc_ms: timeIndex(d), perObject_us: null }; out.keyed[n].perObject_us = r3((out.keyed[n].evaluate_ms - out.baseline_blackPage_ms) / n * 1000); }
// ---- 2. scrub order
out.scrub_1000 = { sequential: bench(keyedDoc(1000), { frames: 60 }), random: bench(keyedDoc(1000), { frames: 60, order: 'random' }) };
// ---- 3. behaviours and constraints
out.behaviours = {};
for (const set of [['noise'], ['shake', 'bob', 'spin'], ['noise', 'shake', 'bob', 'spin', 'flicker']]) out.behaviours[`1000 objects x [${set}]`] = bench(keyedDoc(1000, { rot: false, behaviours: set }), { frames: 60 });
out.constraints = { '1000 lookAt (one target)': bench(keyedDoc(1000, { rot: false, constraint: 'lookAt' }), { frames: 60 }), '1000 followPath': bench(keyedDoc(1000, { rot: false, constraint: 'followPath' }), { frames: 60 }) };

// ---- 4. deep parent chains: each link keyed rotation.z, offset 1 cm along x; cost and leaf precision
out.chains = {};
for (const D of [10, 100, 1000, 3000, 10000]) {
  const doc = load();
  for (let i = 0; i < D; i++) { const id = `c${i}`; doc.objects.push({ id, name: id, type: 'empty', transform: { position: [0.01, 0, 0] }, ...(i ? { parent: `c${i - 1}` } : {}) });
    doc.tracks.push({ target: id, prop: 'rotation.z', keys: [{ t: 0, v: 0, curve: 'linear' }, { t: 10, v: 360 / D * 10, curve: 'linear' }] }); }
  let res;
  try {
    const ix = indexDoc(doc), t = 0.5, st = evaluate(doc, t, geo, ix), leaf = st.objects[`c${D - 1}`].matrix;
    // reference leaf position in float64 by summing the chain analytically: link i is at angle sum(k<=i) a, each 1 cm
    const a = (360 / D * 10) * (t / 10) * Math.PI / 180; let x = 0, y = 0; for (let i = 0; i < D; i++) { x += 0.01 * Math.cos(a * i); y += 0.01 * Math.sin(a * i); }
    // the leaf node's origin: link 0 at its own position (0.01, 0) rotated by 0... compute by chaining like the evaluator
    let M = M4.id(); for (let i = 0; i < D; i++) M = M4.mul(M, M4.trs([0.01, 0, 0], quatFromEuler([0, 0, (360 / D * 10) * (t / 10)]), [1, 1, 1]));
    const err = Math.hypot(leaf[12] - M[12], leaf[13] - M[13], leaf[14] - M[14]);
    res = { evaluate_ms: bench(doc, { frames: D > 1000 ? 10 : 60 }), indexDoc_ms: timeIndex(doc), leafErrorVsChainedF64_m: err, leafReach_m: r3(Math.hypot(M[12], M[13])) };
  } catch (e) { res = { error: String(e.message || e).slice(0, 120) }; }
  out.chains[D] = res;
}
// ---- 5. a cycle is refused at index time (not a hang)
{ const doc = load(); doc.objects.push({ id: 'a', type: 'empty', transform: { position: [0, 0, 0] }, parent: 'b' }, { id: 'b', type: 'empty', transform: { position: [0, 0, 0] }, parent: 'a' });
  try { indexDoc(doc); out.cycle = 'not detected'; } catch (e) { out.cycle = 'refused: ' + e.message; } }
// ---- 6. Euler per-axis interpolation vs slerp: a 0 -> (90, 90, 0) turn, max angle off the shortest path
{ const q0 = quatFromEuler([0, 0, 0]), q1 = quatFromEuler([90, 90, 0]); let worst = 0;
  const ang = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180 / Math.PI;
  const sl = (a, b, u) => { const th = Math.acos(Math.min(1, a.reduce((s, v, i) => s + v * b[i], 0))); if (th < 1e-6) return a; const s = Math.sin(th); return a.map((v, i) => (Math.sin((1 - u) * th) * v + Math.sin(u * th) * b[i]) / s); };
  for (let k = 0; k <= 20; k++) { const u = k / 20; worst = Math.max(worst, ang(quatFromEuler([90 * u, 90 * u, 0]), sl(q0, q1, u))); }
  out.eulerVsSlerp_90_90_worstDeg = r3(worst); }

const file = process.argv[2]; if (file) fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));

// ---- scenes for the GPU bench: N animated test cubes (keys + a baked clip + a noise behaviour) on the desk
fs.mkdirSync(new URL('../scenes/_stress/', import.meta.url), { recursive: true });
for (const n of [0, 10, 50, 200]) {
  const doc = load(); doc.name = `stress: ${n} animated cubes`; doc.assets.cube = 'repo:data/test/anim_cube.glb';
  for (let i = 0; i < n; i++) {
    const id = `cube${i}`, gx = i % 20, gz = Math.floor(i / 20);
    doc.objects.push({ id, name: id, type: 'model', asset: 'cube', transform: { position: [0.2 + gx * 0.025, 0.003, 0.2 + gz * 0.025], scale: [0.3, 0.3, 0.3] }, material: 'screenLit',
      clips: [{ id: 'k1', name: i % 2 ? 'Spin' : 'Hop', start: (i % 7) * 0.1, loop: 'repeat' }], behaviours: [{ id: 'n1', type: 'noise', on: true, params: { amp: 0.002 } }] });
    doc.tracks.push(keys(id, 'rotation.y', 0, 90 + i));
  }
  fs.writeFileSync(new URL(`../scenes/_stress/cubes_${n}.scene.json`, import.meta.url), JSON.stringify(doc));
}
