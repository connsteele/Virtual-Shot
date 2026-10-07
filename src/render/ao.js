// Contact shadows as screen-space ambient obscurance (research, a Show-menu toggle, off by default).
// Positions come from the scene's distance pass (coverage x distance, coverage) and the camera ray of each pixel;
// normals from the neighbouring positions. Each pixel gathers a 16-tap spiral within a few centimetres (Alchemy AO:
// McGuire et al. 2011), so it darkens where surfaces meet: the remote on the pad, the keyboard on the desk, the
// monitor's foot. The factor multiplies the lens pass's output, so the haze and glows added later are not darkened.
import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, uv, vec2, vec3, vec4, float, max, min, dot, normalize, cross, abs, pow, cos, sin, select, clamp, screenCoordinate } from 'three/tsl';

const quadMat = node => { const m = new THREE.NodeMaterial(); m.fragmentNode = node; m.depthTest = false; m.depthWrite = false; return m; };

export function makeAO({ distTex, aoTex, look = {} }) {
  const U = {
    eye: uniform(new THREE.Vector3()), cr: uniform(new THREE.Vector3()), cu: uniform(new THREE.Vector3()), cf: uniform(new THREE.Vector3()),
    tanY: uniform(0.27), aspect: uniform(16 / 9), px: uniform(new THREE.Vector2(1 / 960, 1 / 540)), bufH: uniform(540),
    radius: uniform(look.radius ?? 0.05), strength: uniform(look.strength ?? 2.0), bias: uniform(look.bias ?? 0.004),
    k: uniform(0), frame: uniform(0),
    // the CRT glass emits: it is masked out (centre, right, up, normal, half size)
    gc: uniform(new THREE.Vector3()), gr: uniform(new THREE.Vector3()), gu: uniform(new THREE.Vector3()), gn: uniform(new THREE.Vector3()), gh: uniform(new THREE.Vector2()),
  };
  const N = look.samples ?? 16;
  const dist = texture(distTex), ao = texture(aoTex);

  const pass = quadMat(Fn(() => {
    const q = uv();
    const ray = qq => normalize(U.cf.add(U.cr.mul(qq.x.mul(2).sub(1).mul(U.tanY).mul(U.aspect))).add(U.cu.mul(float(1).sub(qq.y.mul(2)).mul(U.tanY))));
    const dAt = qq => { const s = dist.sample(qq).level(0); return select(s.g.greaterThan(0.5), s.r.div(max(s.g, 1e-4)), float(1e4)); };
    const pos = qq => U.eye.add(ray(qq).mul(dAt(qq)));
    const d0 = dAt(q), p = U.eye.add(ray(q).mul(d0));
    // normal from the nearer neighbour on each axis (so silhouettes don't bend it)
    const dx = vec2(U.px.x, 0), dy = vec2(0, U.px.y);
    const pr = pos(q.add(dx)), pl = pos(q.sub(dx)), pd = pos(q.add(dy)), pu = pos(q.sub(dy));
    const ex = select(abs(dAt(q.add(dx)).sub(d0)).lessThan(abs(dAt(q.sub(dx)).sub(d0))), pr.sub(p), p.sub(pl));
    const ey = select(abs(dAt(q.add(dy)).sub(d0)).lessThan(abs(dAt(q.sub(dy)).sub(d0))), pd.sub(p), p.sub(pu));
    const n0 = normalize(cross(ex, ey)), toEye = U.eye.sub(p), n = select(dot(n0, toEye).lessThan(0), n0.negate(), n0);
    // spiral of N taps out to the projected radius, rotated per pixel
    const rPx = clamp(U.radius.div(d0.mul(U.tanY).mul(2)).mul(U.bufH), 2, 120);
    // the spiral's rotation follows a 4x4 pixel pattern, which the 4x4 blur in apply() averages out exactly
    const ix = screenCoordinate.x.floor().mod(4), iy = screenCoordinate.y.floor().mod(4);
    const rot = ix.mul(4).add(iy).mul(6.2831853 / 16).add(ix.mul(0.37));
    const acc = float(0).toVar();
    for (let i = 0; i < N; i++) {
      const t = (i + 0.5) / N, a = rot.add(i * 2.39996323), r = rPx.mul(Math.sqrt(t));
      const qs = q.add(vec2(cos(a), sin(a)).mul(r).mul(U.px));
      const v = pos(qs).sub(p), vv = dot(v, v);
      // falloff past the radius so a far background behind an edge doesn't count
      const fall = max(float(1).sub(vv.div(U.radius.mul(U.radius).mul(4))), 0);
      acc.addAssign(max(dot(v, n).sub(U.bias.mul(d0)), 0).div(vv.add(1e-4)).mul(fall));
    }
    const A = max(float(1).sub(acc.mul(U.radius.mul(2 / N)).mul(U.strength)), 0);
    const g = p.sub(U.gc), onGlass = abs(dot(g, U.gn)).lessThan(0.02).and(abs(dot(g, U.gr)).lessThan(U.gh.x)).and(abs(dot(g, U.gu)).lessThan(U.gh.y));
    return vec4(select(d0.greaterThan(1e3).or(onGlass), float(1), A), 0, 0, 1);
  })());

  // multiply the lens output by the AO, read through the same barrel warp as the lens pass's green channel
  const warp = (qq, kk) => {
    const p0 = qq.mul(2).sub(1), pp = vec2(p0.x.mul(U.aspect), p0.y);
    const r2 = dot(pp, pp), rc2 = U.aspect.mul(U.aspect).add(1);
    const pw = pp.mul(float(1).add(kk.mul(r2)).div(float(1).add(kk.mul(rc2))));
    return vec2(pw.x.div(U.aspect), pw.y).mul(0.5).add(0.5);
  };
  // a 4x4 depth-aware blur of the half-resolution buffer (taps on surfaces at a different distance are left out)
  const apply = quadMat(Fn(() => {
    const q0 = uv(), q = select(U.k.lessThanEqual(1e-4), q0, warp(q0, U.k));
    const dAt = qq => { const s = dist.sample(qq).level(0); return select(s.g.greaterThan(0.5), s.r.div(max(s.g, 1e-4)), float(1e4)); };
    const d0 = dAt(q), sum = float(0).toVar(), wsum = float(0).toVar();
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
      const qs = q.add(vec2(i - 1.5, j - 1.5).mul(U.px));
      const w = select(abs(dAt(qs).sub(d0)).lessThan(d0.mul(0.03)), float(1), float(0.001));
      sum.addAssign(ao.sample(qs).level(0).r.mul(w)); wsum.addAssign(w);
    }
    const a = sum.div(wsum);
    return vec4(a, a, a, 1);
  })());
  Object.assign(apply, { blending: THREE.CustomBlending, blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor, blendEquation: THREE.AddEquation,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor, transparent: true });
  return { U, pass: new THREE.QuadMesh(pass), apply: new THREE.QuadMesh(apply) };
}
