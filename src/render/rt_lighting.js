// Ray-traced lighting (research, Show-menu toggles, off by default; WebGPU only).
//
// Reuses the shadows spike's ray tracer: a CPU BVH of the scene's triangles (skip-pointer layout, no stack) in two
// storage buffers, traversed in the surface shader. Here every stored triangle also carries its albedo (the mean of its
// texture at its corners and centre, times the material's brightness) in the spare w components, and the CRT glass is
// in the BVH too, flagged as the emitter (albedo r = -1), so rays can tell what they hit:
//   - GI: the screen as an area light whose colour is what's on it (the haze's light grid: the CRT shader's colour,
//     linear, averaged over 20x15 cells), shadowed, plus one diffuse bounce (rays from the surface to whatever they
//     hit; the hit is lit by the screen in turn, with a shadow ray, and re-emits its albedo times that light).
//   - AO: the fraction of cosine-distributed rays that hit something within a few centimetres.
//   - Reflections: a glossy (Fresnel-weighted, jittered) mirror ray on the plastic and the CRT glass; what it hits is
//     shaded with the cheap unshadowed screen spill (or shows the screen itself).
//   - Path traced: direct light from the full-resolution screen image and a two-bounce diffuse path per sample, one
//     sample a pass; the renderer accumulates passes into a float buffer (see ShotRenderer.refineRT).
// Units are the engine's: outgoing = albedo x E, where E is "light arriving" as the body shader counts it
// (sc x spill + bounce). The screen's radiance per cell is emit(uv) x screenGain (2.4: at f720-f1000 the screen's mean
// colour then has the luminance of the fake's single light colour sc = glowCol; tools/rt_eval.js calibrate()), and
// the screen light is a physical area light (cos x cos / r^2) scaled to equal the fake's spill law on the axis at
// refDist (0.5 m). Both are look.rtLighting settings.
// Noise is seeded by (pixel, sample index, frame), so a frame renders the same every time.
import * as THREE from 'three/webgpu';
import { Fn, storage, uniform, texture, vec2, vec3, vec4, float, int, uint, max, min, dot, cross, abs, normalize, length, select, sqrt,
  cos, sin, pow, exp, clamp, Loop, If, Break, screenCoordinate } from 'three/tsl';
import { buildBVH } from './rt_shadows.js';
import { srgbToLinear } from './final_comp.js';

export const RT_DEFAULTS = {
  render: { direct: 16, bounce: 8, ao: 8, refl: 4 },
  play: { direct: 4, bounce: 2, ao: 4, refl: 1 },
  aoRadius: 0.05, rough: 0.12, plasticF0: 0.04, glassF0: 0.04, screenGain: 2.4, refDist: 0.5,
};

const imgCache = new WeakMap();
/** RGBA pixels of a texture's image (ImageBitmap / canvas / image), cached. */
function pixelsOf(tex) {
  const im = tex?.image; if (!im || !im.width) return null;
  if (imgCache.has(im)) return imgCache.get(im);
  const c = new OffscreenCanvas(im.width, im.height), x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0);
  const p = { w: im.width, h: im.height, d: x.getImageData(0, 0, im.width, im.height).data }; imgCache.set(im, p); return p;
}
/** Per-triangle display-referred albedo (r, g, b) of a mesh: its texture at the corners and centre, averaged. */
function albedoOf(mesh) {
  const info = mesh.userData.rt || {}, g = mesh.geometry, uvA = g.attributes.uv, ix = g.index, nT = (ix ? ix.count : g.attributes.position.count) / 3;
  const P = pixelsOf(info.map), mul = info.mul ?? 1, out = new Float32Array(nT * 3);
  const at = (u, v) => { if (!P) return [0.6, 0.6, 0.6]; const fx = ((u % 1) + 1) % 1, fy = ((v % 1) + 1) % 1;
    const i = (Math.min(P.h - 1, Math.floor(fy * P.h)) * P.w + Math.min(P.w - 1, Math.floor(fx * P.w))) * 4; return [P.d[i] / 255, P.d[i + 1] / 255, P.d[i + 2] / 255]; };
  for (let t = 0; t < nT; t++) {
    const vi = [0, 1, 2].map(k => ix ? ix.getX(t * 3 + k) : t * 3 + k), uvs = uvA ? vi.map(i => [uvA.getX(i), uvA.getY(i)]) : [[0, 0], [0, 0], [0, 0]];
    const cs = [...uvs, [(uvs[0][0] + uvs[1][0] + uvs[2][0]) / 3, (uvs[0][1] + uvs[1][1] + uvs[2][1]) / 3]].map(q => at(q[0], q[1]));
    for (let a = 0; a < 3; a++) out[t * 3 + a] = mul * (cs[0][a] + cs[1][a] + cs[2][a] + cs[3][a]) / 4;
  }
  return out;
}

export function makeRTLighting({ maxTris = 8192, look = {} } = {}) {
  const O = { ...RT_DEFAULTS, ...look };
  const nodeAttr = new THREE.StorageBufferAttribute(new Float32Array(maxTris * 2 * 8 / 4 * 2), 4);
  const triAttr = new THREE.StorageBufferAttribute(new Float32Array(maxTris * 12), 4);
  const U = {
    gi: uniform(0), ao: uniform(0), refl: uniform(0), pt: uniform(0), any: uniform(0), debug: uniform(0),
    nodeCount: uniform(0), frame: uniform(0), sample: uniform(0),
    g00: uniform(new THREE.Vector3()), geu: uniform(new THREE.Vector3()), gev: uniform(new THREE.Vector3()), gn: uniform(new THREE.Vector3()),
    nDirect: uniform(O.render.direct), nBounce: uniform(O.render.bounce), nAO: uniform(O.render.ao), nRefl: uniform(O.render.refl),
    aoRadius: uniform(O.aoRadius), rough: uniform(O.rough), plasticF0: uniform(O.plasticF0), glassF0: uniform(O.glassF0),
    screenGain: uniform(O.screenGain), screenLight: uniform(100), refDist: uniform(O.refDist),
  };
  let key = '', stats = null; const albedoCache = new Map();
  const R = { U, O, accumulate: false };

  /** Collect world-space triangles of the placed objects (the CRT glass flagged as the emitter) and upload a BVH when
   *  something moved. */
  R.update = (casters, glassMesh, gm) => {
    U.g00.value.set(...gm.p00); U.geu.value.set(...gm.eu); U.gev.value.set(...gm.ev);
    U.gn.value.crossVectors(new THREE.Vector3(...gm.ev), new THREE.Vector3(...gm.eu)).normalize();
    const k = casters.map(c => c.visible ? c.matrixWorld.elements.join(',') : 'h').join('|');
    if (k === key) return false; key = k;
    const t0 = performance.now(), list = [], alb = [], p = new THREE.Vector3();
    for (const root of casters) { if (!root.visible) continue; root.traverseVisible(m => {
      if (!m.isMesh) return; const g = m.geometry, pos = g.attributes.position, ix = g.index, nT = (ix ? ix.count : pos.count) / 3;
      const glass = m === glassMesh;
      let a = null; if (!glass) { a = albedoCache.get(m.uuid); if (!a) { a = albedoOf(m); albedoCache.set(m.uuid, a); } }
      for (let t = 0; t < nT; t++) {
        for (let v = 0; v < 3; v++) { p.fromBufferAttribute(pos, ix ? ix.getX(t * 3 + v) : t * 3 + v).applyMatrix4(m.matrixWorld); list.push(p.x, p.y, p.z); }
        if (glass) alb.push(-1, 0, 0); else alb.push(a[t * 3], a[t * 3 + 1], a[t * 3 + 2]);
      }
    }); }
    const nT = Math.min(list.length / 9, maxTris), b = buildBVH(new Float32Array(list).subarray(0, nT * 9));
    b.order.forEach((src, k) => { for (let a = 0; a < 3; a++) b.tris[k * 12 + a * 4 + 3] = alb[src * 3 + a]; });   // albedo in v0.w, e1.w, e2.w
    nodeAttr.array.set(b.nodes.subarray(0, Math.min(b.nodes.length, nodeAttr.array.length))); nodeAttr.needsUpdate = true;
    triAttr.array.set(b.tris); triAttr.needsUpdate = true;
    U.nodeCount.value = b.nodeCount;
    stats = { tris: b.triCount, nodes: b.nodeCount, buildMs: +(performance.now() - t0).toFixed(2) };
    return true;
  };
  R.stats = () => stats; R.invalidate = () => { key = ''; };
  R.setQuality = q => { const Q = O[q] || O.render; U.nDirect.value = Q.direct; U.nBounce.value = Q.bounce; U.nAO.value = Q.ao; U.nRefl.value = Q.refl; };

  /** Node builders for one material (texture nodes and the traversal function are made per material: shared ones bind
   *  to the wrong slots, LEARNINGS 6 and 9). emitTex: the linear light grid; hiTex: the screen image (display values). */
  R.nodes = ({ emitTex, hiTex }) => {
    const N = storage(nodeAttr, 'vec4', nodeAttr.count).toReadOnly(), T = storage(triAttr, 'vec4', triAttr.count).toReadOnly();
    const emit = texture(emitTex), hi = texture(hiTex);
    // trace(o, d, tmax, flags) -> (t, triangle) along o + t d, t in (1e-4, tmax); triangle -1 = miss.
    // flags: 1 = any hit (stop at the first), 2 = ignore the glass (shadow rays end on it).
    const trace = Fn(([o, d, tmax, flags]) => {
      const inv = vec3(1).div(select(abs(d).lessThan(1e-9), vec3(1e-9), d));
      const anyHit = flags.bitAnd(int(1)).greaterThan(0), skipGlass = flags.bitAnd(int(2)).greaterThan(0);
      const i = int(0).toVar(), best = float(tmax).toVar(), tri = int(-1).toVar(), done = int(0).toVar();
      Loop({ start: 0, end: 8192, type: 'int', condition: '<', name: 'trav' }, () => {
        If(i.greaterThanEqual(int(U.nodeCount)).or(done.greaterThan(0)), () => { Break(); });
        const a = N.element(i.mul(2)), b = N.element(i.mul(2).add(1));
        const t0 = a.xyz.sub(o).mul(inv), t1 = b.xyz.sub(o).mul(inv);
        const tn = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z)), tf = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
        const boxHit = tf.greaterThanEqual(max(tn, 0)).and(tn.lessThanEqual(best));
        If(boxHit.not(), () => { i.assign(int(a.w)); }).Else(() => {
          If(b.w.lessThan(0), () => { i.addAssign(1); }).Else(() => {
            const start = int(b.w.div(8).floor()), cnt = int(b.w).sub(start.mul(8));
            Loop({ start: 0, end: 4, type: 'int', condition: '<', name: 'tk' }, ({ tk: k }) => {
              If(k.greaterThanEqual(cnt), () => { Break(); });
              const ti = start.add(k), A = T.element(ti.mul(3)), e1 = T.element(ti.mul(3).add(1)).xyz, e2 = T.element(ti.mul(3).add(2)).xyz;
              const pv = cross(d, e2), det = dot(e1, pv), id = float(1).div(det), tv = o.sub(A.xyz);
              const u = dot(tv, pv).mul(id), qv = cross(tv, e1), v = dot(d, qv).mul(id), t = dot(e2, qv).mul(id);
              const ok = abs(det).greaterThan(1e-14).and(u.greaterThanEqual(0)).and(v.greaterThanEqual(0)).and(u.add(v).lessThanEqual(1))
                .and(t.greaterThan(1e-4)).and(t.lessThan(best)).and(skipGlass.and(A.w.lessThan(0)).not());
              If(ok, () => { best.assign(t); tri.assign(ti); If(anyHit, () => { done.assign(1); Break(); }); });
            });
            i.assign(int(a.w));
          });
        });
      });
      return vec2(best, float(tri));
    }).setLayout({ name: 'rtTrace', type: 'vec2', inputs: [{ name: 'o', type: 'vec3' }, { name: 'd', type: 'vec3' }, { name: 'tmax', type: 'float' }, { name: 'flags', type: 'int' }] });

    /** Triangle k: albedo (r < 0: the glass) and geometric normal. */
    const triInfo = k => { const ki = int(k), A = T.element(ki.mul(3)), B = T.element(ki.mul(3).add(1)), C = T.element(ki.mul(3).add(2));
      return { alb: vec3(A.w, B.w, C.w), n: normalize(cross(B.xyz, C.xyz)), glass: A.w.lessThan(0) }; };

    /** PCG random stream seeded by (pixel, sample index, frame, salt). Declare before any If that uses it. */
    const rng = (salt = 0) => {
      const h = uint(screenCoordinate.x).mul(uint(1973)).add(uint(screenCoordinate.y).mul(uint(9277))).add(uint(U.sample).mul(uint(26699)))
        .add(uint(U.frame).mul(uint(16777619))).add(uint(salt * 7919 + 1)).toVar();
      return () => { h.assign(h.mul(uint(747796405)).add(uint(2891336453))); const w = h.shiftRight(h.shiftRight(uint(28)).add(uint(4))).bitXor(h).mul(uint(277803737));
        return float(w.shiftRight(uint(22)).bitXor(w)).div(4294967296.0); };
    };
    /** Cosine-distributed direction about n. */
    const cosDir = (n, r1, r2) => {
      const s = select(abs(n.z).lessThan(0.999), vec3(0, 0, 1), vec3(1, 0, 0)), t = normalize(cross(s, n)), b = cross(n, t);
      const r = sqrt(r1), ph = r2.mul(6.2831853);
      return normalize(t.mul(r.mul(cos(ph))).add(b.mul(r.mul(sin(ph)))).add(n.mul(sqrt(max(float(1).sub(r1), 0)))));
    };
    /** The screen's radiance at glass (su, sv): the light grid (smooth) or the full image (detail; for path tracing). */
    const screenL = (su, sv, full = false) => full
      ? srgbToLinear(hi.sample(vec2(su, sv)).level(0).rgb).mul(U.screenLight).mul(U.screenGain)
      : emit.sample(vec2(su, sv)).level(0).rgb.mul(U.screenGain);
    /** Physical area-light term toward one point y on the glass, from x with normal n: cos at the glass x cos at x / r^2,
     *  scaled so that a point on the axis at refDist gets what the body shader's spill law gives it there
     *  (si / (5 d^2 + 1)); the glass area cancels out of the Monte Carlo estimate. r^2 is clamped at 2 cm. */
    const areaTo = (LU, x, n, y) => {
      const Lv = y.sub(x), d2 = dot(Lv, Lv), L = Lv.div(sqrt(d2));
      const ce = max(dot(L.negate(), LU.sn), 0), cr = max(dot(n, L), 0), d0 = U.refDist;
      return { w: ce.mul(cr).div(max(d2, 0.0004)).mul(LU.si.mul(d0.mul(d0)).div(d0.mul(d0).mul(5).add(1))), Lv };
    };
    /** The body shader's spill law toward one point y, from x with normal n (lobe x wrap x falloff). */
    const spillTo = (LU, x, n, y) => {
      const Lv = y.sub(x), d = length(Lv), L = Lv.div(d);
      const lobe = clamp(dot(L.negate(), LU.sn).mul(0.7).add(0.3), 0, 1);
      return { w: max(dot(n, L).mul(0.85).add(0.15), 0).mul(lobe).mul(LU.si).div(d.mul(d).mul(5).add(1)), Lv };
    };
    /** Screen light arriving at x (normal n): `count` stratified jittered samples over the glass, each shadowed and
     *  coloured by the screen there. */
    const direct = (LU, x, n, count, rnd, full = false) => {
      const acc = vec3(0).toVar(), side = int(float(count).sqrt().floor()), cnt = side.mul(side);
      Loop({ start: 0, end: 64, type: 'int', condition: '<', name: 'dl' }, ({ dl: k }) => {
        If(k.greaterThanEqual(cnt), () => { Break(); });
        const su = float(k.mod(side)).add(rnd()).div(float(side)).toVar(), sv = float(k.div(side)).add(rnd()).div(float(side)).toVar();
        const y = U.g00.add(U.geu.mul(su)).add(U.gev.mul(sv)), s = areaTo(LU, x, n, y);
        If(s.w.greaterThan(1e-5), () => {
          const h = trace(x, s.Lv, float(0.999), int(3));
          If(h.y.lessThan(0), () => { acc.addAssign(screenL(su, sv, full).mul(s.w)); });
        });
      });
      return acc.div(float(cnt));
    };
    /** One sample of screen light at x (for bounce hits). */
    const direct1 = (LU, x, n, rnd, full = false) => {
      const su = rnd().toVar(), sv = rnd().toVar(), y = U.g00.add(U.geu.mul(su)).add(U.gev.mul(sv)), s = areaTo(LU, x, n, y);
      const out = vec3(0).toVar();
      If(s.w.greaterThan(1e-5), () => { const h = trace(x, s.Lv, float(0.999), int(3)); If(h.y.lessThan(0), () => { out.assign(screenL(su, sv, full).mul(s.w)); }); });
      return out;
    };
    /** The ringing remote's light at a hit (as the body shader's, unshadowed). */
    const ringAt = (LU, p, n) => { const rl = LU.rp.sub(p), rd = length(rl);
      return LU.rc.mul(LU.ri).mul(exp(rd.mul(rd).negate().div(LU.rrad.mul(LU.rrad)))).mul(max(dot(n, rl.div(max(rd, 1e-5))), 0.2)); };
    /** Cheap shading of a reflection hit: unshadowed screen spill (the fake's law with its colour) and the ring light. */
    const shadeHit = (LU, p, n, alb) => { const s = spillTo(LU, p, n, LU.sp);
      return alb.mul(LU.bl).mul(LU.sc.mul(s.w).add(ringAt(LU, p, n))); };
    /** glass uv of a point on (or near) the glass plane */
    const glassUV = p => { const q = p.sub(U.g00); return vec2(dot(q, U.geu).div(dot(U.geu, U.geu)), dot(q, U.gev).div(dot(U.gev, U.gev))); };

    /** One diffuse bounce: light that reaches x after one hit (count cosine rays); the hit is lit by one screen sample. */
    const bounce = (LU, x, n, count, rnd) => {
      const acc = vec3(0).toVar();
      Loop({ start: 0, end: 64, type: 'int', condition: '<', name: 'bn' }, ({ bn: k }) => {
        If(k.greaterThanEqual(int(count)), () => { Break(); });
        const dir = cosDir(n, rnd(), rnd()).toVar(), h = trace(x, dir, float(10), int(0)).toVar();
        If(h.y.greaterThanEqual(0), () => {
          const ti = triInfo(h.y), nh = select(dot(ti.n, dir).greaterThan(0), ti.n.negate(), ti.n).toVar();
          If(ti.glass.not(), () => {
            const p = x.add(dir.mul(h.x)).add(nh.mul(0.002)).toVar();
            acc.addAssign(ti.alb.mul(LU.bl).mul(direct1(LU, p, nh, rnd).add(ringAt(LU, p, nh))));
          });
        });
      });
      return acc.div(max(float(count), 1));
    };
    /** Ambient occlusion: 1 - fraction of cosine rays that hit within aoRadius. */
    const ao = (x, n, count, rnd) => {
      const occ = float(0).toVar();
      Loop({ start: 0, end: 64, type: 'int', condition: '<', name: 'ao' }, ({ ao: k }) => {
        If(k.greaterThanEqual(int(count)), () => { Break(); });
        const h = trace(x, cosDir(n, rnd(), rnd()), U.aoRadius, int(1));
        If(h.y.greaterThanEqual(0), () => { occ.addAssign(1); });
      });
      return float(1).sub(occ.div(max(float(count), 1)));
    };
    /** Glossy reflection (Fresnel-weighted mean of `count` jittered mirror rays) seen from eye along -V, normal n. */
    const reflect = (LU, x, n, V, F0, count, rnd, skipGlass = false) => {
      const acc = vec3(0).toVar(), cosV = max(dot(n, V), 0), F = F0.add(float(1).sub(F0).mul(pow(float(1).sub(cosV), 5)));
      const r0 = n.mul(dot(n, V).mul(2)).sub(V).toVar();
      Loop({ start: 0, end: 16, type: 'int', condition: '<', name: 'rf' }, ({ rf: k }) => {
        If(k.greaterThanEqual(int(count)), () => { Break(); });
        const z = rnd().mul(2).sub(1), ph = rnd().mul(6.2831853), rr = sqrt(max(float(1).sub(z.mul(z)), 0));
        const dir = normalize(r0.add(vec3(rr.mul(cos(ph)), rr.mul(sin(ph)), z).mul(U.rough).mul(rnd().pow(0.333)))).toVar();
        const h = trace(x, dir, float(10), int(skipGlass ? 2 : 0)).toVar();
        If(h.y.greaterThanEqual(0).and(dot(dir, n).greaterThan(0)), () => {
          const ti = triInfo(h.y), p = x.add(dir.mul(h.x)).toVar();
          If(ti.glass, () => { acc.addAssign(hi.sample(glassUV(p)).level(0).rgb); })   // the screen as the camera sees it
            .Else(() => { const nh = select(dot(ti.n, dir).greaterThan(0), ti.n.negate(), ti.n); acc.addAssign(shadeHit(LU, p.add(nh.mul(0.002)), nh, ti.alb)); });
        });
      });
      return acc.div(max(float(count), 1)).mul(F);
    };
    /** Path-traced light arriving at x: full-image screen light (4 samples) + a two-bounce diffuse path. */
    const path = (LU, x, n, rnd) => {
      const E = direct(LU, x, n, 4, rnd, true).toVar();
      const d1 = cosDir(n, rnd(), rnd()).toVar(), h1 = trace(x, d1, float(10), int(0)).toVar();
      If(h1.y.greaterThanEqual(0), () => {
        const t1 = triInfo(h1.y), n1 = select(dot(t1.n, d1).greaterThan(0), t1.n.negate(), t1.n).toVar();
        If(t1.glass.not(), () => {
          const p1 = x.add(d1.mul(h1.x)).add(n1.mul(0.002)).toVar(), a1 = t1.alb.mul(LU.bl).toVar();
          const L1 = direct1(LU, p1, n1, rnd, true).add(ringAt(LU, p1, n1)).toVar();
          const d2 = cosDir(n1, rnd(), rnd()).toVar(), h2 = trace(p1, d2, float(10), int(0)).toVar();
          If(h2.y.greaterThanEqual(0), () => {
            const t2 = triInfo(h2.y), n2 = select(dot(t2.n, d2).greaterThan(0), t2.n.negate(), t2.n).toVar();
            If(t2.glass.not(), () => { const p2 = p1.add(d2.mul(h2.x)).add(n2.mul(0.002)).toVar();
              L1.addAssign(t2.alb.mul(LU.bl).mul(direct1(LU, p2, n2, rnd, true).add(ringAt(LU, p2, n2)))); });
          });
          E.addAssign(a1.mul(L1));
        });
      });
      return E;
    };
    return { trace, rng, direct, bounce, ao, reflect, path, screenL };
  };
  return R;
}
