// TSL materials: the Black Page engine's GLSL rewritten as three.js node graphs (WebGPU first, WebGL2 fallback).
import * as THREE from 'three/webgpu';
import { Fn, uniform, uniformArray, texture, uv, vec2, vec3, vec4, float, mix, clamp, max, min, dot, normalize, length, exp, sin, abs, pow,
  positionWorld, normalWorldGeometry, cameraPosition, If, Discard, select, mrt, acos, cross } from 'three/tsl';

/** smoothstep that also works with edge0 > edge1 (GLSL drivers allow it; WGSL's builtin does not promise it). */
export const sstep = (e0, e1, x) => { const t = clamp(float(x).sub(e0).div(float(e1).sub(e0)), 0, 1); return t.mul(t).mul(float(3).sub(t.mul(2))); };

/** Uniforms shared by every lit surface; set once per frame from the evaluated state. */
export function makeLightUniforms() {
  return {
    sp: uniform(new THREE.Vector3()), sn: uniform(new THREE.Vector3()), sc: uniform(new THREE.Vector3()),
    lp: uniform(new THREE.Vector3()), lpRaw: uniform(new THREE.Vector3()), lc: uniform(new THREE.Vector3()), li: uniform(0), lrad: uniform(0.01),
    amb: uniform(0), si: uniform(4.5), bp: uniform(new THREE.Vector3()), bi: uniform(0), bl: uniform(1),
    rp: uniform(new THREE.Vector3()), rc: uniform(new THREE.Vector3()), ri: uniform(0), rrad: uniform(1), eStr: uniform(0),
    // research (re-tuning the fake against RT): the screen as an unshadowed rectangular area light; area 0 = the engine's law
    area: uniform(0), ga: uniform(new THREE.Vector3()), gu: uniform(new THREE.Vector3()), gv: uniform(new THREE.Vector3()), aRef: uniform(0.5),
  };
}

/** The engine's body shader: the CRT is the light (soft forward lobe, distance falloff), a bounce off the unseen room,
 *  the power LED's teal spill (and its texel glowing), emissive texture, the ringing remote's red light, and an
 *  override colour for the remote's LEDs. Unlit otherwise; no colour management (values are display-referred). */
export function bodyMaterial(U, { map = null, emissiveMap = null, ledRect = [2, 2, 2, 2], ov = null, scMul = 1, blMul = 1, rawLed = false, sh = null, rsh = null, rts = null, rtl = null }) {
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
    let spill = face.mul(U.si).div(d.mul(d).mul(5).add(1));
    {   // research (U.area = 1): the glass as an unshadowed Lambertian rectangle (Lambert's polygon formula, the form factor
        // to the quad), calibrated like the ray-traced light: equal to the spill law on the axis at aRef (si aRef^2 / (5 aRef^2 + 1)
        // x pi F / area). Only the side in front of the glass is lit; the horizon isn't clipped (max 0).
      const q = [U.ga, U.ga.add(U.gu), U.ga.add(U.gu).add(U.gv), U.ga.add(U.gv)].map(c => normalize(c.sub(P)));
      let phi = vec3(0);
      for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; phi = phi.add(normalize(cross(a, b)).mul(acos(clamp(dot(a, b), -1, 1)))); }
      const toward = U.ga.add(U.gu.mul(0.5)).add(U.gv.mul(0.5)).sub(P), phiS = select(dot(phi, toward).lessThan(0), phi.negate(), phi);
      const F = max(dot(phiS, n), 0).div(2 * Math.PI), Ar = length(cross(U.gu, U.gv)), front = dot(P.sub(U.ga), U.sn).greaterThan(0);
      const r2 = U.aRef.mul(U.aRef), areaE = select(front, U.si.mul(r2).div(r2.mul(5).add(1)).mul(F).mul(Math.PI).div(max(Ar, 1e-6)), float(0));
      spill = select(U.area.greaterThan(0.5), areaE, spill);
    }
    if (sh) {   // soft shadows from the screen (Show menu, off by default): mean visibility over the screen's patches
      // The lookup point is a var declared before the If: a node first built inside an If is hoisted into a var that
      // is only assigned when the branch runs, which broke the default (off) picture when P or L was reused there.
      const sv = float(1).toVar(), xs = P.add(select(dot(n, L).lessThan(0), n.negate(), n).mul(0.003)).toVar();   // offset toward the light
      If(sh.U.surface.greaterThan(0.5), () => { sv.assign(sh.nodes().screenVis(xs, { pcf: true })); });
      // ray-traced instead (Show menu, off by default): the exact fraction of the glass visible from here
      if (rts) If(rts.U.on.greaterThan(0.5), () => { sv.assign(rts.nodes().vis(xs)); });
      spill = spill.mul(sv);
    }
    const fill = U.amb.mul(float(0.5).add(max(dot(n, normalize(vec3(-0.4, 0.8, 0.3))), 0).mul(0.5)));
    const Lb0 = U.bp.sub(P), db = length(Lb0), Lb = Lb0.div(max(db, 1e-5));
    const bnc = U.bi.mul(max(dot(n, Lb), 0)).div(db.mul(db).mul(1.5).add(1));
    const sc = scMul === 1 ? U.sc : U.sc.mul(scMul), bl = blMul === 1 ? U.bl : U.bl.mul(blMul);
    const lit = c.rgb.mul(fill.add(sc.mul(spill.add(bnc)))).mul(bl).toVar();
    const col = lit.toVar();
    // power LED: teal spill on the plastic, and the LED texel itself glows
    const lp = rawLed ? U.lpRaw : U.lp, dl = lp.sub(P), dd = length(dl);
    col.addAssign(c.rgb.mul(U.lc).mul(U.li).mul(0.9).mul(exp(dd.mul(dd).negate().div(U.lrad.mul(U.lrad)))).mul(max(dot(n, dl.div(max(dd, 1e-5))), 0.25)));
    const inRect = v.x.greaterThan(lr.x).and(v.x.lessThan(lr.z)).and(v.y.greaterThan(lr.y)).and(v.y.lessThan(lr.w));
    If(inRect, () => { col.assign(mix(col, U.lc.mul(1.15).add(0.12), min(U.li, 1).mul(0.9))); });
    if (emissiveMap) col.addAssign(texture(emissiveMap, v).rgb.mul(U.eStr));
    // the ringing remote lights what's around it
    const rl = U.rp.sub(P), rd = length(rl);
    let ring = c.rgb.mul(U.rc).mul(U.ri).mul(exp(rd.mul(rd).negate().div(U.rrad.mul(U.rrad)))).mul(max(dot(n, rl.div(max(rd, 1e-5))), 0.2));
    if (rsh) {   // shadows from the ringing remote's light (Show menu, off by default); the remote itself is the emitter
      const rv = float(1).toVar(), xr = P.add(select(dot(n, rl).lessThan(0), n.negate(), n).mul(0.002)).toVar();
      If(rsh.U.surface.greaterThan(0.5).and(U.ri.greaterThan(0)), () => { rv.assign(rsh.nodes().vis(xr, { pcf: true })); });
      ring = ring.mul(rv);
    }
    col.addAssign(ring);
    if (rtl) rtLighting(rtl, U, { c, n, P, fill, sc, bl, lit, col, scMul, spill, bnc });
    const out = ov ? mix(col, ov.xyz, ov.w) : col;
    return vec4(out, 1);
  })();
  return m;
}

/** Ray-traced lighting (Show menu, off by default; see rt_lighting.js). Runs after the body shader has built `col`;
 *  with every RT toggle off nothing here runs, so the default picture is unchanged. Everything this reads from the body
 *  shader was built before the If (a node first built inside an If is only assigned when the branch runs). */
function rtLighting({ R, emitTex, hiTex }, U, { c, n, P, fill, sc, bl, lit, col, scMul, spill, bnc }) {
  const RT = R.U, K = R.nodes({ emitTex, hiTex }), rnd = K.rng(1);
  const V = normalize(cameraPosition.sub(P)).toVar(), nf = select(dot(n, V).lessThan(0), n.negate(), n).toVar();
  const x = P.add(nf.mul(0.002)).toVar(), alb = c.rgb.toVar();
  If(RT.any.greaterThan(0.5), () => {
    // light arriving (the fake's units): ray-traced screen light (coloured, shadowed) + one bounce, or a path-traced sample
    const E = vec3(0).toVar(), Ed = vec3(0).toVar(), Eb = vec3(0).toVar();
    If(RT.pt.greaterThan(0.5), () => { Ed.assign(K.path(U, x, n, rnd).mul(scMul)); E.assign(Ed); })
      .ElseIf(RT.gi.greaterThan(0.5), () => {
        Ed.assign(K.direct(U, x, n, RT.nDirect, rnd).mul(scMul)); Eb.assign(K.bounce(U, x, nf, RT.nBounce, rnd).mul(scMul)); E.assign(Ed.add(Eb)); });
    If(RT.gi.add(RT.pt).greaterThan(0.5), () => { col.assign(col.sub(lit).add(alb.mul(fill.add(E)).mul(bl))); });
    const occ = float(1).toVar(), refl = vec3(0).toVar();
    If(RT.ao.greaterThan(0.5).and(RT.pt.lessThan(0.5)), () => { occ.assign(K.ao(x, nf, RT.nAO, rnd)); col.mulAssign(occ); });
    If(RT.refl.greaterThan(0.5), () => { refl.assign(K.reflect(U, x, nf, V, RT.plasticF0, RT.nRefl, rnd)); col.addAssign(refl); });
    // debug views: 1 RT direct light, 2 RT bounce light (both x albedo x brightness), 3 AO, 4 reflections,
    // 5 the fake's direct screen spill, 6 the fake's bounce term (U.bp / U.bi), for comparison
    If(RT.debug.greaterThan(0.5), () => {
      const fakeD = alb.mul(sc.mul(spill)).mul(bl), fakeB = alb.mul(sc.mul(bnc)).mul(bl);
      col.assign(select(RT.debug.lessThan(1.5), alb.mul(Ed).mul(bl), select(RT.debug.lessThan(2.5), alb.mul(Eb).mul(bl), select(RT.debug.lessThan(3.5), vec3(occ),
        select(RT.debug.lessThan(4.5), refl, select(RT.debug.lessThan(5.5), fakeD, fakeB))))));
    });
  });
}

/** The CRT screen: chat texture cropped to the glass, barrel bulge, RGB fringe, scanlines, vignette, glass tint,
 *  and up to four ghost reflections on the glass surface. Returns the material and `color(uvNode)`, the same shader
 *  as a function of the glass mesh's uv (used flat, in glass uv space, to light the haze). */
export function crtMaterial({ chatTex, ghostTex, ub, rtl = null, LU = null }) {
  const S = {
    fx: uniform(0), time: uniform(0), ub: uniform(new THREE.Vector4(...ub)),
    gr: uniformArray([0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, 1, 1))),
    gp: uniformArray([0, 1, 2, 3].map(() => new THREE.Vector4(.5, .5, 1, 1))),
    ga: uniformArray([0, 0, 0, 0], 'float'), gm: uniformArray([0, 0, 0, 0], 'float'),
  };
  // A plain builder, called inside each material's own Fn: shared Fn functions that read uniforms break when two
  // materials use them (the generated WGSL function refers to the first material's uniform block).
  const color = meshUV => {
    const ubv = S.ub;
    const q0 = meshUV.sub(ubv.xy).div(ubv.zw.sub(ubv.xy));
    const c0 = q0.sub(0.5);
    const cb = c0.mul(float(1).add(S.fx.mul(0.08).mul(dot(c0, c0))));
    const g = cb.add(0.5), c = cb.div(1.05), q = c.add(0.5);
    const s = vec2(mix(0.0625, 0.9375, q.x), q.y);
    const inside = s.y.greaterThan(0).and(s.y.lessThan(1)).and(q.x.greaterThan(0)).and(q.x.lessThan(1));
    const px = vec2(S.fx.div(1920), 0);
    const tex = vec3(texture(chatTex, s.add(px)).level(0).r, texture(chatTex, s).level(0).g, texture(chatTex, s.sub(px)).level(0).b);
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
  m.outputNode = rtl ? Fn(() => {
    const o = color(uv()).toVar();
    // ray-traced reflections on the glass (Show menu, off by default): what's in front of the screen, Fresnel-weighted
    const K = rtl.R.nodes(rtl), rnd = K.rng(2), RT = rtl.R.U, P = positionWorld.toVar();
    const V = normalize(cameraPosition.sub(P)).toVar(), n = select(dot(RT.gn, V).lessThan(0), RT.gn.negate(), RT.gn).toVar();
    If(RT.refl.greaterThan(0.5), () => {
      const r = K.reflect(LU, P.add(n.mul(0.003)), n, V, RT.glassF0, RT.nRefl, rnd, true).mul(S.fx);
      o.assign(vec4(select(RT.debug.greaterThan(3.5), r, o.rgb.add(r)), 1));
    });
    return o;
  })() : Fn(() => color(uv()))();
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
