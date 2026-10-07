// Ray-traced soft shadows from the CRT (research, a Show-menu toggle, off by default; WebGPU only).
//
// The scene is small (about 2,500 triangles), so a BVH built on the CPU fits in two storage buffers and the surface
// shader can trace shadow rays itself: for each pixel, `rays` rays to stratified, jittered points on the glass; the
// screen light is scaled by the fraction that reach it. This is the exact area-light visibility the 12 shadow maps
// approximate. The BVH is flattened depth-first with skip ("escape") indices, so traversal needs no stack.
// It is rebuilt (on the CPU) whenever something that casts has moved, e.g. every frame while the remote rumbles.
import * as THREE from 'three/webgpu';
import { storage, uniform, vec3, float, int, uint, max, min, dot, cross, abs, select, Loop, If, Break, screenCoordinate } from 'three/tsl';

const LEAF = 4;

/** Triangles (world space) -> flattened BVH. Returns { nodes: Float32Array (2 vec4 per node), tris: Float32Array (3 vec4). */
function buildBVH(tri) {   // tri: Float32Array, 9 floats per triangle
  const n = tri.length / 9, idx = Array.from({ length: n }, (_, i) => i);
  const c = new Float32Array(n * 3), bb = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) {
    const v = [tri[i * 9 + a], tri[i * 9 + 3 + a], tri[i * 9 + 6 + a]];
    bb[i * 6 + a] = Math.min(...v); bb[i * 6 + 3 + a] = Math.max(...v); c[i * 3 + a] = (v[0] + v[1] + v[2]) / 3;
  }
  const out = [];   // { mn, mx, start, count, escape }
  const order = [];
  const rec = (lo, hi) => {
    const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9], cmn = [1e9, 1e9, 1e9], cmx = [-1e9, -1e9, -1e9];
    for (let k = lo; k < hi; k++) { const i = idx[k]; for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], bb[i * 6 + a]); mx[a] = Math.max(mx[a], bb[i * 6 + 3 + a]);
      cmn[a] = Math.min(cmn[a], c[i * 3 + a]); cmx[a] = Math.max(cmx[a], c[i * 3 + a]); } }
    const node = { mn, mx, start: -1, count: 0, escape: 0 }; out.push(node);
    if (hi - lo <= LEAF) { node.start = order.length; node.count = hi - lo; for (let k = lo; k < hi; k++) order.push(idx[k]); node.escape = out.length; return; }
    const ext = [0, 1, 2].map(a => cmx[a] - cmn[a]), ax = ext.indexOf(Math.max(...ext));
    const sub = idx.slice(lo, hi).sort((p, q) => c[p * 3 + ax] - c[q * 3 + ax]); for (let k = lo; k < hi; k++) idx[k] = sub[k - lo];
    const mid = (lo + hi) >> 1; rec(lo, mid); rec(mid, hi); node.escape = out.length;
  };
  rec(0, n);
  const nodes = new Float32Array(out.length * 8);
  out.forEach((o, i) => { nodes.set([...o.mn, o.escape, ...o.mx, o.count ? o.start * 8 + o.count : -1], i * 8); });
  const tris = new Float32Array(Math.max(1, n) * 12);
  order.forEach((t, k) => { const v0 = [0, 1, 2].map(a => tri[t * 9 + a]), v1 = [0, 1, 2].map(a => tri[t * 9 + 3 + a]), v2 = [0, 1, 2].map(a => tri[t * 9 + 6 + a]);
    tris.set([...v0, 0, ...v1.map((x, a) => x - v0[a]), 0, ...v2.map((x, a) => x - v0[a]), 0], k * 12); });
  return { nodes, tris, nodeCount: out.length, triCount: n };
}

export function makeRTShadows({ maxTris = 8192 } = {}) {
  const nodeAttr = new THREE.StorageBufferAttribute(new Float32Array(maxTris * 2 * 8 / LEAF * 2), 4);   // generous: 2n/LEAF nodes
  const triAttr = new THREE.StorageBufferAttribute(new Float32Array(maxTris * 12), 4);
  const U = { on: uniform(0), rays: uniform(16), nodeCount: uniform(0),
    g00: uniform(new THREE.Vector3()), geu: uniform(new THREE.Vector3()), gev: uniform(new THREE.Vector3()), frame: uniform(0) };
  let key = '', stats = null;

  /** Collect world-space triangles of the casters (minus `skip` meshes) and upload a fresh BVH when something moved. */
  function update(casters, skip, gm) {
    U.g00.value.set(...gm.p00); U.geu.value.set(...gm.eu); U.gev.value.set(...gm.ev);
    const k = casters.map(c => c.visible ? c.matrixWorld.elements.join(',') : 'h').join('|');
    if (k === key) return false; key = k;
    const t0 = performance.now(), list = [], p = new THREE.Vector3();
    for (const root of casters) { if (!root.visible) continue; root.traverseVisible(m => {
      if (!m.isMesh || skip.includes(m)) return; const g = m.geometry, pos = g.attributes.position, ix = g.index;
      const nT = (ix ? ix.count : pos.count) / 3;
      for (let t = 0; t < nT; t++) for (let v = 0; v < 3; v++) { p.fromBufferAttribute(pos, ix ? ix.getX(t * 3 + v) : t * 3 + v).applyMatrix4(m.matrixWorld); list.push(p.x, p.y, p.z); }
    }); }
    const tri = new Float32Array(list).subarray(0, Math.min(list.length, maxTris * 9));
    const b = buildBVH(tri);
    nodeAttr.array.set(b.nodes.subarray(0, Math.min(b.nodes.length, nodeAttr.array.length))); nodeAttr.needsUpdate = true;
    triAttr.array.set(b.tris); triAttr.needsUpdate = true;
    U.nodeCount.value = b.nodeCount;
    stats = { tris: b.triCount, nodes: b.nodeCount, buildMs: +(performance.now() - t0).toFixed(2) };
    return true;
  }

  /** Node builders for one material: vis(x) = fraction of `rays` rays from x that reach the glass. */
  const nodes = () => {
    const N = storage(nodeAttr, 'vec4', nodeAttr.count).toReadOnly(), T = storage(triAttr, 'vec4', triAttr.count).toReadOnly();
    /** 1 when the segment o -> o + d (t in (0, 1)) hits no triangle. */
    const clear = (o, d) => {
      const inv = vec3(1).div(select(abs(d).lessThan(1e-9), vec3(1e-9), d));
      const i = int(0).toVar(), hit = float(0).toVar();
      Loop({ start: 0, end: 4096, type: 'int', condition: '<', name: 'trav' }, () => {
        If(i.greaterThanEqual(int(U.nodeCount)).or(hit.greaterThan(0.5)), () => { Break(); });
        const a = N.element(i.mul(2)), b = N.element(i.mul(2).add(1));
        const t0 = a.xyz.sub(o).mul(inv), t1 = b.xyz.sub(o).mul(inv);
        const tn = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z)), tf = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
        const boxHit = tf.greaterThanEqual(max(tn, 0)).and(tn.lessThanEqual(1));
        If(boxHit.not(), () => { i.assign(int(a.w)); }).Else(() => {
          If(b.w.lessThan(0), () => { i.addAssign(1); }).Else(() => {
            const start = int(b.w.div(8).floor()), cnt = int(b.w).sub(start.mul(8));
            Loop({ start: 0, end: LEAF, type: 'int', condition: '<', name: 'tk' }, ({ tk: k }) => {
              If(k.greaterThanEqual(cnt), () => { Break(); });
              const ti = start.add(k).mul(3), v0 = T.element(ti).xyz, e1 = T.element(ti.add(1)).xyz, e2 = T.element(ti.add(2)).xyz;
              // Moller-Trumbore, segment version
              const pv = cross(d, e2), det = dot(e1, pv), id = float(1).div(det), tv = o.sub(v0);
              const u = dot(tv, pv).mul(id), qv = cross(tv, e1), v = dot(d, qv).mul(id), t = dot(e2, qv).mul(id);
              If(abs(det).greaterThan(1e-12).and(u.greaterThanEqual(0)).and(v.greaterThanEqual(0)).and(u.add(v).lessThanEqual(1))
                .and(t.greaterThan(1e-4)).and(t.lessThan(0.999)), () => { hit.assign(1); Break(); });
            });
            i.assign(int(a.w));
          });
        });
      });
      return float(1).sub(hit);
    };
    const vis = x => {
      // stratified over the glass on a sqrt(rays) grid, jittered per pixel and frame (PCG hash)
      const h0 = uint(screenCoordinate.x).add(uint(screenCoordinate.y).mul(uint(4099))).add(uint(U.frame).mul(uint(16777619))).toVar();
      const rnd = () => { h0.assign(h0.mul(uint(747796405)).add(uint(2891336453))); const w = h0.shiftRight(h0.shiftRight(uint(28)).add(uint(4))).bitXor(h0).mul(uint(277803737));
        return float(w.shiftRight(uint(22)).bitXor(w)).div(4294967296.0); };
      const acc = float(0).toVar(), side = int(U.rays.sqrt().floor()), n = side.mul(side);
      Loop({ start: 0, end: 64, type: 'int', condition: '<', name: 'ray' }, ({ ray: r }) => {
        If(r.greaterThanEqual(n), () => { Break(); });
        const su = float(r.mod(side)).add(rnd()).div(float(side)), sv = float(r.div(side)).add(rnd()).div(float(side));
        const target = U.g00.add(U.geu.mul(su)).add(U.gev.mul(sv));
        acc.addAssign(clear(x, target.sub(x)));
      });
      return acc.div(float(n));
    };
    return { vis };
  };
  return { U, update, nodes, stats: () => stats, invalidate: () => { key = ''; } };
}
