// TSL materials: the Black Page engine's GLSL rewritten as three.js node graphs (WebGPU first, WebGL2 fallback).
import * as THREE from 'three/webgpu';
import { Fn, uniform, uniformArray, texture, uv, vec2, vec3, vec4, float, mix, clamp, max, min, dot, normalize, length, exp, sin, abs, pow,
  positionWorld, normalWorldGeometry, If, Discard, select, mrt, dFdx, dFdy, log2, exp2, round } from 'three/tsl';

/** smoothstep that also works with edge0 > edge1 (GLSL drivers allow it; WGSL's builtin does not promise it). */
export const sstep = (e0, e1, x) => { const t = clamp(float(x).sub(e0).div(float(e1).sub(e0)), 0, 1); return t.mul(t).mul(float(3).sub(t.mul(2))); };

/** Uniforms shared by every lit surface; set once per frame from the evaluated state. */
export function makeLightUniforms() {
  return {
    sp: uniform(new THREE.Vector3()), sn: uniform(new THREE.Vector3()), sc: uniform(new THREE.Vector3()),
    lp: uniform(new THREE.Vector3()), lpRaw: uniform(new THREE.Vector3()), lc: uniform(new THREE.Vector3()), li: uniform(0), lrad: uniform(0.01),
    amb: uniform(0), si: uniform(4.5), bp: uniform(new THREE.Vector3()), bi: uniform(0), bl: uniform(1),
    rp: uniform(new THREE.Vector3()), rc: uniform(new THREE.Vector3()), ri: uniform(0), rrad: uniform(1), eStr: uniform(0),
    bands: uniform(0),   // > 0: banded lighting (pixel look), that many steps per doubling of each light's falloff
  };
}

/** The engine's body shader: the CRT is the light (soft forward lobe, distance falloff), a bounce off the unseen room,
 *  the power LED's teal spill (and its texel glowing), emissive texture, the ringing remote's red light, and an
 *  override colour for the remote's LEDs. Unlit otherwise; no colour management (values are display-referred). */
export function bodyMaterial(U, { map = null, emissiveMap = null, ledRect = [2, 2, 2, 2], ov = null, scMul = 1, blMul = 1, rawLed = false }) {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  const lr = vec4(...ledRect);
  m.outputNode = Fn(() => {
    const v = uv();
    const c = map ? texture(map, v) : vec4(0.6);
    If(c.a.lessThan(0.4), () => { Discard(); });
    const n = normalWorldGeometry, P = positionWorld;
    const Lv = U.sp.sub(P), d = length(Lv), L = Lv.div(d);
    const lobe = clamp(dot(L.negate(), U.sn).mul(0.7).add(0.3), 0, 1);
    const face = max(dot(n, L).mul(0.85).add(0.15), 0).mul(lobe);
    // banded lighting: each light's falloff snapped to steps of equal ratio, so it lands in hard-edged tones
    const band = x => select(U.bands.greaterThan(0), exp2(round(log2(max(x, 1e-6)).mul(U.bands)).div(max(U.bands, 1))), x);
    const spill = band(face.mul(U.si).div(d.mul(d).mul(5).add(1)));
    const fill = U.amb.mul(float(0.5).add(max(dot(n, normalize(vec3(-0.4, 0.8, 0.3))), 0).mul(0.5)));
    const Lb0 = U.bp.sub(P), db = length(Lb0), Lb = Lb0.div(max(db, 1e-5));
    const bnc = band(U.bi.mul(max(dot(n, Lb), 0)).div(db.mul(db).mul(1.5).add(1)));
    const sc = scMul === 1 ? U.sc : U.sc.mul(scMul), bl = blMul === 1 ? U.bl : U.bl.mul(blMul);
    const col = c.rgb.mul(fill.add(sc.mul(spill.add(bnc)))).mul(bl).toVar();
    // power LED: teal spill on the plastic, and the LED texel itself glows
    const lp = rawLed ? U.lpRaw : U.lp, dl = lp.sub(P), dd = length(dl);
    col.addAssign(c.rgb.mul(U.lc).mul(U.li).mul(0.9).mul(band(exp(dd.mul(dd).negate().div(U.lrad.mul(U.lrad))).mul(max(dot(n, dl.div(max(dd, 1e-5))), 0.25)))));
    const inRect = v.x.greaterThan(lr.x).and(v.x.lessThan(lr.z)).and(v.y.greaterThan(lr.y)).and(v.y.lessThan(lr.w));
    If(inRect, () => { col.assign(mix(col, U.lc.mul(1.15).add(0.12), min(U.li, 1).mul(0.9))); });
    if (emissiveMap) col.addAssign(texture(emissiveMap, v).rgb.mul(U.eStr));
    // the ringing remote lights what's around it
    const rl = U.rp.sub(P), rd = length(rl);
    col.addAssign(c.rgb.mul(U.rc).mul(U.ri).mul(band(exp(rd.mul(rd).negate().div(U.rrad.mul(U.rrad))).mul(max(dot(n, rl.div(max(rd, 1e-5))), 0.2)))));
    const out = ov ? mix(col, ov.xyz, ov.w) : col;
    return vec4(out, 1);
  })();
  return m;
}

/** The CRT screen: chat texture cropped to the glass, barrel bulge, RGB fringe, scanlines, vignette, glass tint,
 *  and up to four ghost reflections on the glass surface. Returns the material and `color(uvNode)`, the same shader
 *  as a function of the glass mesh's uv (used flat, in glass uv space, to light the haze). */
export function crtMaterial({ chatTex, ghostTex, ub }) {
  const S = {
    fx: uniform(0), time: uniform(0), ub: uniform(new THREE.Vector4(...ub)),
    mip: uniform(0),   // 1 = filter the chat by its footprint (mipmaps; the chunky-pixel look), 0 = the engine's point-sized taps
    gr: uniformArray([0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, 1, 1))),
    gp: uniformArray([0, 1, 2, 3].map(() => new THREE.Vector4(.5, .5, 1, 1))),
    ga: uniformArray([0, 0, 0, 0], 'float'), gm: uniformArray([0, 0, 0, 0], 'float'),
  };
  // A plain builder, called inside each material's own Fn: shared Fn functions that read uniforms break when two
  // materials use them (the generated WGSL function refers to the first material's uniform block).
  // lodBias / derivUV: the chat's mip level for another footprint (log2 scale) or another uv's derivatives; see makeAreaUpscale
  const color = (meshUV, lodBias = 0, derivUV = meshUV) => {
    const ubv = S.ub;
    const q0 = meshUV.sub(ubv.xy).div(ubv.zw.sub(ubv.xy));
    const c0 = q0.sub(0.5);
    const cb = c0.mul(float(1).add(S.fx.mul(0.08).mul(dot(c0, c0))));
    const g = cb.add(0.5), c = cb.div(1.05), q = c.add(0.5);
    const s = vec2(mix(0.0625, 0.9375, q.x), q.y);
    const inside = s.y.greaterThan(0).and(s.y.lessThan(1)).and(q.x.greaterThan(0)).and(q.x.lessThan(1));
    const px = vec2(S.fx.div(1920), 0);
    const fs = derivUV.sub(ubv.xy).div(ubv.zw.sub(ubv.xy)).mul(vec2(0.875 / 1.05, 1 / 1.05)).mul(vec2(chatTex.image.width, chatTex.image.height)), lod = max(log2(max(length(dFdx(fs)), length(dFdy(fs)))).add(lodBias), 0).mul(S.mip);
    const tex = vec3(texture(chatTex, s.add(px)).level(lod).r, texture(chatTex, s).level(lod).g, texture(chatTex, s.sub(px)).level(lod).b);
    const col = select(inside, tex, vec3(0)).toVar();
    const scan = sin(g.y.mul(900)).mul(0.22).add(0.78);
    const vig = sstep(0.75, 0.25, length(c.mul(vec2(1, 1.2))));
    const glass = vec3(0.018, 0.026, 0.03).mul(float(1).sub(length(c)));
    col.assign(mix(col, col.mul(1.55).mul(scan).mul(vig.mul(0.45).add(0.55)).add(glass), S.fx));
    const ref = float(0).toVar();
    for (let i = 0; i < 4; i++) {
      const gp = S.gp.element(i), gr = S.gr.element(i), ga = S.ga.element(i), gm = S.gm.element(i);
      const l0 = q0.sub(gp.xy).div(gp.zw).add(0.5);
      const lx = l0.x.add(sin(l0.y.mul(38).add(S.time.mul(27))).mul(0.012));
      const l = vec2(select(gm.greaterThan(0.5), float(1).sub(lx), lx), l0.y);
      const l2 = l.add(vec2(0.035, 0.02));
      const in1 = l.x.greaterThan(0).and(l.x.lessThan(1)).and(l.y.greaterThan(0)).and(l.y.lessThan(1));
      const in2 = l2.x.greaterThan(0).and(l2.x.lessThan(1)).and(l2.y.greaterThan(0)).and(l2.y.lessThan(1));
      const a1 = texture(ghostTex, mix(gr.xy, gr.zw, l)).level(0).a, a2 = texture(ghostTex, mix(gr.xy, gr.zw, l2)).level(0).a;
      ref.addAssign(select(in1, a1, float(0)).mul(ga).add(select(in2, a2, float(0)).mul(ga).mul(0.3)));
    }
    col.addAssign(vec3(0.7, 0.8, 0.9).mul(ref).mul(S.fx).mul(float(1).sub(dot(c, c).mul(0.4))));
    const outside = g.x.lessThan(0).or(g.x.greaterThan(1)).or(g.y.lessThan(0)).or(g.y.greaterThan(1));
    return vec4(select(outside, vec3(0), col), 1);
  };
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  m.outputNode = Fn(() => color(uv()))();
  m.userData.S = S; m.userData.color = color;
  return m;
}

/** Additive glow billboard (LED and the remote's ring LEDs). Lies in the glass plane; adds light, writes no distance. */
export function glowMaterial() {
  const G = { col: uniform(new THREE.Vector3()), a: uniform(0) };
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor });
  m.outputNode = Fn(() => {
    const q = uv().mul(2).sub(1), d = dot(q, q);
    const g = exp(d.mul(-7)).mul(0.9).add(exp(d.mul(-60)).mul(1.2));
    return vec4(G.col.mul(g).mul(G.a), 1);
  })();
  m.mrtNode = mrt({ dist: vec4(0) });   // adds nothing to the distance pass (see sceneMRT's blend mode)
  m.userData.G = G;
  return m;
}
