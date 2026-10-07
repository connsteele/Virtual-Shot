// Lens and depth-of-field passes (TSL on full-screen quads). Ported from engine v4.8.1's lens + DOF shaders.
// Post uv here is three.js's convention (origin top-left, y down); the engine's GLSL used y up. Every formula is
// symmetric in y except the focus spot centre and the DOF spiral, which are mirrored explicitly.
import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, uv, vec2, vec3, vec4, float, mix, clamp, max, min, dot, length, abs, pow, sign, sqrt, cos, sin,
  smoothstep, select, Loop, If, Break } from 'three/tsl';
import { sstep } from './materials.js';

const quadMat = node => { const m = new THREE.NodeMaterial(); m.fragmentNode = node; m.depthTest = false; m.depthWrite = false; return m; };

/** tex: { src (scene colour), zs (scene distance), lens, coc, final } textures of render targets that live for the
 *  whole session (resizing a RenderTarget keeps its texture objects, so the node graphs stay valid). */
export function makePost(tex) {
  const U = {
    k: uniform(0), aspect: uniform(16 / 9), sq: uniform(0),
    fD: uniform(0), ppd: uniform(0), band: uniform(0), maxc: uniform(0), edge: uniform(0), es: uniform(1),
    sp: uniform(new THREE.Vector2(.5, .5)), spot: uniform(0), spr: uniform(1), spf: uniform(1),
    px: uniform(new THREE.Vector2(1 / 1920, 1 / 1080)), sc: uniform(1), maxR: uniform(0), rs: uniform(0.5),
  };
  // tex.alt (optional): a second scene colour the lens reads instead when U.alt is 1 (the ray-traced accumulation)
  U.alt = uniform(0);
  const srcTex = texture(tex.src), altTex = tex.alt ? texture(tex.alt) : null;
  // (clamped to the 0..1 an 8-bit scene buffer holds, so the accumulated mean clips like a single pass would)
  const srcNode = altTex ? { sample: q => select(U.alt.greaterThan(0.5), clamp(altTex.sample(q), 0, 1), srcTex.sample(q)) } : srcTex;
  const zsNode = texture(tex.zs), lensSrc = texture(tex.lens), cocSrc = texture(tex.coc), finalSrc = texture(tex.final);

  const warp = (q, kk) => {
    const p0 = q.mul(2).sub(1), p = vec2(p0.x.mul(U.aspect), p0.y);
    const r2 = dot(p, p), rc2 = U.aspect.mul(U.aspect).add(1);
    const pw = p.mul(float(1).add(kk.mul(r2)).div(float(1).add(kk.mul(rc2))));
    return vec2(pw.x.div(U.aspect), pw.y).mul(0.5).add(0.5);
  };

  // lens: barrel warp, edge colour fringing, vignette, squint lids
  const lens = quadMat(Fn(() => {
    const q = uv();
    const flat = srcNode.sample(q);
    const g = srcNode.sample(warp(q, U.k));
    const p0 = q.mul(2).sub(1), edge = clamp(dot(p0, p0).mul(0.5), 0, 1);
    const r = srcNode.sample(warp(q, U.k.mul(edge.mul(0.03).add(1)))).r, b = srcNode.sample(warp(q, U.k.mul(float(1).sub(edge.mul(0.03))))).b;
    const p = vec2(p0.x.mul(U.aspect), p0.y), e = dot(p, p).div(U.aspect.mul(U.aspect).add(1));
    const v0 = float(1).sub(min(U.k.mul(3), 1).mul(0.5).mul(smoothstep(0.15, 1, e)));
    const ly = abs(q.y.mul(2).sub(1)).add(pow(abs(q.x.mul(2).sub(1)), 2).mul(0.18));
    const v = v0.mul(float(1).sub(U.sq.mul(sstep(float(1.05).sub(U.sq.mul(0.75)), float(1.25).sub(U.sq.mul(0.55)), ly))));
    const warped = vec4(vec3(r, g.g, b).mul(v), g.a);
    return select(U.k.lessThanEqual(1e-4), flat, warped);
  })());

  // circle of confusion (signed px at 1080p) from the distance pass, focus band, corner softness and the stylised spot
  const coc = quadMat(Fn(() => {
    const q = uv(), qq = select(U.k.lessThanEqual(1e-4), q, warp(q, U.k));
    const d0 = zsNode.sample(qq).r, d = select(d0.lessThanEqual(0), float(1e3), d0);
    const dD = U.fD.sub(float(1).div(d));
    const c = clamp(sign(dD).mul(max(abs(dD).sub(U.band), 0)).mul(U.ppd), U.maxc.negate(), U.maxc);
    const p0 = q.mul(2).sub(1), p = vec2(p0.x.mul(U.aspect), p0.y);
    const e1 = U.edge.mul(sstep(U.es, 1, length(p).div(sqrt(U.aspect.mul(U.aspect).add(1)))));
    const e2 = max(e1, U.spot.mul(sstep(U.spr, U.spr.add(U.spf), length(q.sub(U.sp).mul(vec2(U.aspect, 1))))));
    const e = min(e2, U.maxc);
    return vec4(select(c.lessThan(0), min(c, e.negate()), max(c, e)), 0, 0, 1);
  })());

  // depth of field: scatter-as-gather on a golden-angle spiral, in linear light
  const dof = quadMat(Fn(() => {
    const q = uv();
    const c0 = lensSrc.sample(q).level(0);
    const z0 = cocSrc.sample(q).level(0).r, s0 = abs(z0).mul(U.sc);
    const acc = pow(c0.rgb, vec3(2.2)).toVar(), tot = float(1).toVar(), r = float(U.rs).toVar(), a = float(0).toVar();
    Loop(1600, () => {
      If(r.greaterThanEqual(U.maxR), () => { Break(); });
      const tc = q.add(vec2(cos(a), sin(a).negate()).mul(r).mul(U.px));
      const c = pow(lensSrc.sample(tc).level(0).rgb, vec3(2.2));
      const z = cocSrc.sample(tc).level(0).r, s1 = abs(z).mul(U.sc);
      const s = select(z.greaterThan(z0), min(s1, s0.mul(2)), s1);
      const m = smoothstep(r.sub(0.5), r.add(0.5), s);
      acc.addAssign(mix(acc.div(tot), c, m));
      tot.addAssign(1);
      r.addAssign(U.rs.div(r));
      a.addAssign(2.39996323);
    });
    return select(U.maxR.lessThan(0.5), c0, vec4(pow(acc.div(tot), vec3(1 / 2.2)), c0.a));
  })());

  const blit = quadMat(Fn(() => finalSrc.sample(uv()))());

  return { U,
    quads: { lens: new THREE.QuadMesh(lens), coc: new THREE.QuadMesh(coc), dof: new THREE.QuadMesh(dof), blit: new THREE.QuadMesh(blit) } };
}
