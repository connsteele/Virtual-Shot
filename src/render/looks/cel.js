// Anime cel look (off by default): a toon material and line art, as a self-contained look module.
//
//  - Toon shading: each light's N.L goes through a ramp of 2 or 3 tones (shadow / mid / lit colours, thresholds, an
//    edge softness), distance falloff stays smooth; a rim light; and a face-shadow mode for characters, where the key
//    light's horizontal angle around the head is compared with a threshold map in face space (Genshin-style SDF face
//    shadows), so a face gets a clean designed terminator instead of N.L on its geometry.
//  - Line art: a small G-buffer pass (view normal, view distance, object and material id) of the same scene, then a
//    post pass that draws silhouette (distance jumps, object boundaries), crease (normal angle) and material-boundary
//    lines, with the width in output pixels, a colour, and a fade with distance.
//
// The renderer touches this module through CelLook (bottom): set(look) swaps the placed meshes' materials to toon
// ones, pass() draws the G-buffer and the lines into a buffer the lens pass reads. The shading builders (ramp, rim,
// faceTerm) don't know about the shot, so the lookdev page uses them with its own lights.
import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, uv, vec2, vec3, vec4, float, mix, clamp, max, min, dot, normalize, length, exp, abs, acos, sign, select, If, Discard,
  positionWorld, positionView, cameraPosition, normalWorldGeometry, normalViewGeometry, smoothstep, screenUV } from 'three/tsl';

/** Defaults. A named look preset (`look.style: "cel"` in the scene) would carry these values. */
export const CEL_LOOK = {
  tones: 3,                     // 2: shadow / lit; 3: shadow / mid / lit
  t1: 0.0, t2: 0.45,            // ramp thresholds in N.L (shadow -> mid, mid -> lit; 2 tones use t1)
  soft: 0.03,                   // half-width of each tone edge in N.L (0 = hard)
  shadow: [0.32, 0.30, 0.46],   // tone colours, multiplied with the albedo and the light (cool, purple-ish shadows)
  mid: [0.68, 0.64, 0.74],
  gain: 0.9,                    // overall exposure of the toon shading against the engine's
  fill: [0.8, 0.82, 0.9],       // ambient fill tint (flat, no ramp)
  rim: 0.5, rimPx: 5, rimRel: 0.06, rimCol: [1, 0.95, 0.9], rimAmb: 0.02,   // rim light: strength, width in output px, depth jump, colour
  lines: true,
  lineW: 2,                     // line width in output pixels
  lineCol: [0.07, 0.05, 0.09], lineTint: 0.35,   // line colour; tint mixes toward a dark shade of the surface under it
  sil: 1, crease: 0.85, mat: 0.7,                 // strength of each line kind
  depthRel: 0.02,               // silhouette: a neighbour farther by this fraction of the distance (more on grazing surfaces)
  creaseDeg: 50,                // crease: normals that differ by more than this (degrees)
  fadeNear: 8, fadeFar: 30,     // lines fade out between these distances (scene units)
  debug: 0,                     // 1: lines only (on white), 2: normals, 3: ids
};

/** Uniforms for the look (one set for every toon material and the line pass). */
export function makeCelUniforms() {
  const v3 = () => uniform(new THREE.Vector3());
  return { tones: uniform(3), t1: uniform(0), t2: uniform(0.45), soft: uniform(0.03), shadow: v3(), mid: v3(), gain: uniform(1), fill: v3(),
    rim: uniform(0), rimPx: uniform(5), rimRel: uniform(0.06), rimCol: v3(), rimAmb: uniform(0), px: uniform(new THREE.Vector2(1 / 1920, 1 / 1080)), gtex: null };
}
export function applyCelUniforms(C, look) {
  const L = { ...CEL_LOOK, ...look };
  C.tones.value = L.tones; C.t1.value = L.t1; C.t2.value = L.t2; C.soft.value = Math.max(L.soft, 0.002);
  C.shadow.value.set(...L.shadow); C.mid.value.set(...L.mid); C.gain.value = L.gain; C.fill.value.set(...L.fill);
  C.rim.value = L.rim; C.rimPx.value = L.rimPx; C.rimRel.value = L.rimRel; C.rimCol.value.set(...L.rimCol); C.rimAmb.value = L.rimAmb;
  return L;
}

// ---- shading builders (plain functions, called inside each material's own Fn: see crtMaterial's note on shared Fns)

/** N.L (or any -1..1 term) -> tone colour. Each edge is a smoothstep of half-width C.soft around its threshold. */
export const ramp = (C, x) => {
  const a = smoothstep(C.t1.sub(C.soft), C.t1.add(C.soft), x), b = smoothstep(C.t2.sub(C.soft), C.t2.add(C.soft), x);
  const three = mix(mix(C.shadow, C.mid, a), vec3(1), b), two = mix(C.shadow, vec3(1), a);
  return select(C.tones.lessThan(2.5), two, three);
};

/** Rim mask, screen-space depth-offset style: step C.rimPx pixels outward along the surface's screen-space normal in
 *  the G-buffer (rendered before the scene pass); if that lands on something clearly farther (or the background), this
 *  pixel is within rimPx of a silhouette. A fresnel rim (1 - N.V) lit up whole floors and desk tops seen at grazing
 *  angles; this one only lights real outlines, at a constant width in pixels. Needs C.gtex (the G-buffer texture). */
export const rimMask = C => {
  const V = normalize(positionView.negate()), nV = facingNormal(normalViewGeometry, V), d0 = length(positionView);
  const sl = length(nV.xy), dir = nV.xy.div(max(sl, 1e-4));
  const g = texture(C.gtex).sample(screenUV.add(vec2(dir.x, dir.y.negate()).mul(C.rimPx).mul(C.px))).level(0);
  const d1 = select(g.z.lessThanEqual(0), float(1e4), g.z);
  return smoothstep(C.rimRel, C.rimRel.mul(2), d1.sub(d0).div(d0)).mul(smoothstep(0.15, 0.5, sl));
};

/** The normal turned toward the viewer (double-sided meshes, cards). */
export const facingNormal = (n, V) => select(dot(n, V).lessThan(0), n.negate(), n);

/** Face uniforms for one face (head): centre, forward / right / up axes, half-size, optional threshold map. */
export function makeFaceUniforms() {
  return { ctr: uniform(new THREE.Vector3()), fwd: uniform(new THREE.Vector3(0, 0, 1)), right: uniform(new THREE.Vector3(1, 0, 0)),
    up: uniform(new THREE.Vector3(0, 1, 0)), size: uniform(0.1), soft: uniform(0.02) };
}

/** Face shadow: replaces N.L for the key light with a designed terminator. The light direction is flattened onto the
 *  head's horizontal plane; its angle from the forward axis (0 front .. 1 behind) is compared with a threshold map in
 *  face space (u across the face toward the light, v up), mirrored so the map only has to describe one side. Without a
 *  map, a procedural one: a straight vertical terminator that slides across the face, with a nose bump (the cheek
 *  under the nose stays lit a little longer). Returns -1 (shadow) .. 1 (lit), for ramp(). */
export const faceTerm = (F, P, L, map = null) => {
  const Lh = normalize(L.sub(F.up.mul(dot(L, F.up))).add(F.fwd.mul(1e-4)));
  const ang = acos(clamp(dot(Lh, F.fwd), -1, 1)).div(Math.PI);
  const rel = P.sub(F.ctr), u = dot(rel, F.right).div(F.size).mul(0.5).add(0.5), v = dot(rel, F.up).div(F.size).mul(0.5).add(0.5);
  const uL = select(dot(Lh, F.right).greaterThanEqual(0), u, float(1).sub(u));
  const du = uL.sub(0.42), dv = v.sub(0.45);
  const proc = uL.add(exp(du.mul(du).div(-0.003).add(dv.mul(dv).div(-0.01))).mul(0.15));
  const thr = map ? texture(map, vec2(clamp(uL, 0, 1), clamp(v, 0, 1))).r : proc;
  return smoothstep(ang.sub(F.soft), ang.add(F.soft), thr).mul(2).sub(1);
};

/** The toon version of materials.js bodyMaterial for the shot: the same lights (CRT spill with its forward lobe, room
 *  bounce, power LED, ringing remote, ambient), each N.L through the ramp; emissive, LED texel and LED override kept. */
export function celBodyMaterial(U, C, { map = null, emissiveMap = null, ledRect = [2, 2, 2, 2], ov = null, scMul = 1, blMul = 1, rawLed = false, face = null } = {}) {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  const lr = vec4(...ledRect);
  m.outputNode = Fn(() => {
    const v = uv();
    const c = map ? texture(map, v) : vec4(0.6);
    If(c.a.lessThan(0.4), () => { Discard(); });
    const P = positionWorld, V = normalize(cameraPosition.sub(P)), n = facingNormal(normalWorldGeometry, V);
    const Lv = U.sp.sub(P), d = length(Lv), L = Lv.div(d);
    const lobe = clamp(dot(L.negate(), U.sn).mul(0.7).add(0.3), 0, 1);
    const sc = scMul === 1 ? U.sc : U.sc.mul(scMul), bl = (blMul === 1 ? U.bl : U.bl.mul(blMul)).mul(C.gain);
    const keyI = U.si.mul(lobe).div(d.mul(d).mul(5).add(1));
    const keyX = face ? faceTerm(face, P, L) : dot(n, L);
    const key = ramp(C, keyX).mul(keyI);
    const Lb0 = U.bp.sub(P), db = length(Lb0), Lb = Lb0.div(max(db, 1e-5));
    const bnc = ramp(C, dot(n, Lb)).mul(U.bi.div(db.mul(db).mul(1.5).add(1)));
    const fill = C.fill.mul(U.amb);
    const col = c.rgb.mul(fill.add(sc.mul(key.add(bnc)))).mul(bl).toVar();
    const lp = rawLed ? U.lpRaw : U.lp, dl = lp.sub(P), dd = length(dl);
    col.addAssign(c.rgb.mul(U.lc).mul(U.li).mul(0.9).mul(ramp(C, dot(n, dl.div(max(dd, 1e-5))))).mul(exp(dd.mul(dd).negate().div(U.lrad.mul(U.lrad)))));
    const inRect = v.x.greaterThan(lr.x).and(v.x.lessThan(lr.z)).and(v.y.greaterThan(lr.y)).and(v.y.lessThan(lr.w));
    If(inRect, () => { col.assign(mix(col, U.lc.mul(1.15).add(0.12), min(U.li, 1).mul(0.9))); });
    if (emissiveMap) col.addAssign(texture(emissiveMap, v).rgb.mul(U.eStr));
    const rl = U.rp.sub(P), rd = length(rl);
    col.addAssign(c.rgb.mul(U.rc).mul(U.ri).mul(ramp(C, dot(n, rl.div(max(rd, 1e-5))))).mul(exp(rd.mul(rd).negate().div(U.rrad.mul(U.rrad)))));
    // rim: lit by the screen (on the side that faces it) plus a little constant rim so silhouettes read in the dark
    const rimL = sc.mul(keyI).mul(clamp(dot(n, L).mul(0.5).add(0.6), 0, 1)).add(C.rimAmb);
    col.addAssign(mix(c.rgb, vec3(1), 0.5).mul(C.rimCol).mul(rimMask(C)).mul(C.rim).mul(rimL).mul(bl));
    const out = ov ? mix(col, ov.xyz, ov.w) : col;
    return vec4(out, 1);
  })();
  return m;
}

// ---- line art

/** Octahedral encoding of a unit normal into two numbers (and back). */
const octEncode = n => {
  const p = n.xy.div(abs(n.x).add(abs(n.y)).add(abs(n.z)));
  const s = vec2(select(p.x.greaterThanEqual(0), float(1), float(-1)), select(p.y.greaterThanEqual(0), float(1), float(-1)));
  return select(n.z.lessThan(0), float(1).sub(abs(p.yx)).mul(s), p);
};
const octDecode = e => {
  const n = vec3(e.x, e.y, float(1).sub(abs(e.x)).sub(abs(e.y))).toVar(), t = max(n.z.negate(), 0);
  n.x.addAssign(select(n.x.greaterThanEqual(0), t.negate(), t)); n.y.addAssign(select(n.y.greaterThanEqual(0), t.negate(), t));
  return normalize(n);
};

/** G-buffer material: view normal (octahedral, turned to the viewer), view distance, id = object * 64 + material. */
export function celIdMaterial(id, { map = null } = {}) {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  m.outputNode = Fn(() => {
    if (map) { const c = texture(map, uv()); If(c.a.lessThan(0.4), () => { Discard(); }); }
    const V = normalize(positionView.negate()), n = facingNormal(normalViewGeometry, V);
    return vec4(octEncode(n), length(positionView), float(id));
  })();
  return m;
}

const quadMat = node => { const m = new THREE.NodeMaterial(); m.fragmentNode = node; m.depthTest = false; m.depthWrite = false; return m; };

/** The line pass: colour buffer + G-buffer -> colour with line art. Taps on 8 directions at 3 radii up to half the
 *  line width (both sides of an edge draw, so the line is the full width); the nearest ring that finds an edge gives
 *  a distance to it, and that a coverage (rough anti-aliasing). */
export function makeCelLines({ colorTex, gTex }) {
  const U = { px: uniform(new THREE.Vector2(1 / 1920, 1 / 1080)), R: uniform(1), thin: uniform(1), col: uniform(new THREE.Vector3()), tint: uniform(0),
    sil: uniform(1), crease: uniform(1), mat: uniform(1), depthRel: uniform(0.02), creaseCos: uniform(0.64),
    fadeNear: uniform(8), fadeFar: uniform(30), on: uniform(1), debug: uniform(0) };
  const col = texture(colorTex), gb = texture(gTex);
  const G = q => { const g = gb.sample(q).level(0), bg = g.z.lessThanEqual(0);
    return { n: octDecode(g.xy), d: select(bg, float(1e4), g.z), id: select(bg, float(0), g.w), bg }; };
  const node = Fn(() => {
    const q = uv(), c = col.sample(q).level(0), g0 = G(q);
    const nz0 = max(g0.n.z, 0.25);
    const K = 3, dS = float(1e3).toVar(), dC = float(1e3).toVar(), dM = float(1e3).toVar();
    const dirs = [0, 1, 2, 3, 4, 5, 6, 7].map(i => [Math.cos(i * Math.PI / 4), Math.sin(i * Math.PI / 4)]);
    for (let k = 1; k <= K; k++) {
      const r = U.R.mul(k / K);
      for (const [x, y] of dirs) {
        const g1 = G(q.add(U.px.mul(vec2(x, y)).mul(r)));
        const near = min(g0.d, g1.d);
        const depthEdge = abs(g1.d.sub(g0.d)).greaterThan(near.mul(U.depthRel).div(nz0));
        const obj0 = g0.id.div(64).floor(), obj1 = g1.id.div(64).floor();
        const objEdge = obj0.notEqual(obj1);
        const matEdge = objEdge.not().and(abs(g1.id.sub(g0.id)).greaterThan(0.5));
        const silE = depthEdge.or(objEdge);
        const creaseE = silE.not().and(matEdge.not()).and(dot(g0.n, g1.n).lessThan(U.creaseCos)).and(g0.bg.not());
        dS.assign(select(silE, min(dS, r), dS)); dM.assign(select(matEdge, min(dM, r), dM)); dC.assign(select(creaseE, min(dC, r), dC));
      }
    }
    const step = U.R.div(K * 2);
    const cover = dd => clamp(U.R.sub(dd.sub(step)).add(0.5), 0, 1).mul(select(dd.lessThan(999), float(1), float(0)));
    const fade = float(1).sub(smoothstep(U.fadeNear, U.fadeFar, g0.d.min(1e3)));
    // a silhouette against the background is drawn even far away; everything else fades with distance
    const a = max(max(cover(dS).mul(U.sil), cover(dC).mul(U.crease).mul(fade)), cover(dM).mul(U.mat).mul(fade)).mul(U.thin).mul(U.on);
    const lc = mix(U.col, c.rgb.mul(0.3), U.tint);
    const out = vec4(mix(c.rgb, lc, a), c.a);
    const dbgLines = vec4(vec3(float(1).sub(a)), 1), dbgN = vec4(g0.n.mul(0.5).add(0.5), 1);
    const h = g0.id.mul(0.618034).fract(), dbgId = vec4(vec3(h, h.mul(3.7).fract(), h.mul(7.3).fract()).mul(select(g0.bg, float(0), float(1))), 1);
    return select(U.debug.lessThan(0.5), out, select(U.debug.lessThan(1.5), dbgLines, select(U.debug.lessThan(2.5), dbgN, dbgId)));
  })();
  return { U, quad: new THREE.QuadMesh(quadMat(node)) };
}
export function applyLineUniforms(LU, look, { sceneH, outH }) {
  const L = { ...CEL_LOOK, ...look }, R = L.lineW / 2 * sceneH / outH;   // half width in scene-buffer pixels
  LU.R.value = Math.max(R, 1); LU.thin.value = Math.min(1, R / 1) ** 0.5;   // thinner than 2 buffer px: lighter, not aliased
  LU.col.value.set(...L.lineCol); LU.tint.value = L.lineTint; LU.sil.value = L.sil; LU.crease.value = L.crease; LU.mat.value = L.mat;
  LU.depthRel.value = L.depthRel; LU.creaseCos.value = Math.cos(L.creaseDeg * Math.PI / 180); LU.fadeNear.value = L.fadeNear; LU.fadeFar.value = L.fadeFar;
  LU.on.value = L.lines ? 1 : 0; LU.debug.value = L.debug;
}

/** Object / material ids and G-buffer proxies for a set of meshes: a second scene that shares their geometry and
 *  copies their world matrices and visibility each frame (so the shot's materials never swap per frame). */
export class CelGBuffer {
  constructor() {
    this.scene = new THREE.Scene(); this.proxies = [];
    this.rt = new THREE.RenderTarget(16, 16, { type: THREE.HalfFloatType, depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
  }
  /** meshes: [{ mesh, obj (object index), mat (material index), map (alpha) }] */
  add({ mesh, obj, mat, map = null }) {
    const p = new THREE.Mesh(mesh.geometry, celIdMaterial(2 + obj * 64 + mat, { map }));
    p.matrixAutoUpdate = false; p.matrixWorldAutoUpdate = false; p.frustumCulled = mesh.frustumCulled;
    this.scene.add(p); this.proxies.push({ p, mesh });
  }
  sync() {
    for (const { p, mesh } of this.proxies) { let vis = mesh.visible; mesh.traverseAncestors(a => { vis = vis && a.visible; });
      p.visible = vis; p.matrixWorld.copy(mesh.matrixWorld); }
  }
  render(r, cam, w, h) {
    if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h);
    this.sync(); r.setRenderTarget(this.rt); r.clear(); r.render(this.scene, cam);
  }
}

/** The renderer's side of the look: material swap on the placed meshes, the G-buffer and the line pass.
 *  shot: a ShotRenderer after init(). Lines are drawn into outRT (the lens pass reads it in place of the scene colour). */
export class CelLook {
  constructor(shot) {
    this.shot = shot; this.C = makeCelUniforms(); this.on = false; this.look = { ...CEL_LOOK };
    this.gbuf = new CelGBuffer(); this.swaps = []; this.C.gtex = this.gbuf.rt.texture;
    let obj = 0;
    for (const root of Object.values(shot.placed)) {
      let mat = 0; const seen = new Map();
      root.traverse(n => { if (!n.isMesh) return;
        const base = n.material, opts = base.userData.opts, isCrt = base === shot.crt;
        // material id: one per distinct source texture within the object (PSX models: usually one atlas per mesh)
        const key = isCrt ? 'crt' : opts?.map?.uuid || base.uuid; if (!seen.has(key)) seen.set(key, mat++);
        this.gbuf.add({ mesh: n, obj, mat: seen.get(key), map: opts?.map || null });
        if (opts) this.swaps.push({ mesh: n, base, cel: celBodyMaterial(shot.U, this.C, opts) });
      });
      obj++;
    }
    this.lines = makeCelLines({ colorTex: shot.sceneRT.textures[0], gTex: this.gbuf.rt.texture });
  }
  /** look: CEL_LOOK-style settings, or null for off. */
  set(look) {
    const on = !!look;
    if (on) this.look = applyCelUniforms(this.C, look);
    if (on !== this.on) for (const s of this.swaps) s.mesh.material = on ? s.cel : s.base;
    this.on = on;
  }
  /** Before the scene pass: the G-buffer of the same view (the toon materials read it for the rim). */
  prepass(r, cam, w, h) {
    const shot = this.shot;
    shot.mark('cel g-buffer'); this.gbuf.render(r, cam, w, h);
    this.C.px.value.set(1 / w, 1 / h); this.C.rimPx.value = this.look.rimPx * shot.H / shot.OH;
  }
  /** After the scene pass: the lines over the scene colour into outRT. */
  pass(r, cam, w, h, outRT) {
    const shot = this.shot;
    // the lens-overscan buffer is larger but covers a wider view by about as much, so a buffer pixel ~ an internal pixel
    applyLineUniforms(this.lines.U, this.look, { sceneH: shot.H, outH: shot.OH });
    this.lines.U.px.value.set(1 / w, 1 / h);
    shot.mark('cel lines'); r.setRenderTarget(outRT); this.lines.quad.render(r);
  }
}
