// In-engine haze: a single-scattering ray march through Black Page's Cycles haze (same density field, same lights),
// rendered into a half-resolution buffer of the scene's overscan frame. Replaces the 2.5 s/frame Cycles pass.
//
// Density: final look C "fine wisps" (Blender haze_mat.py): thin sheets around the 0.5 level set of a distorted 4D
// fBm, broken up by a slower coverage noise. Lights: the CRT screen as a grid of area-light cells emitting 100x the
// screen image (linear), the ringing remote's red point light, the LED's teal spill. Henyey-Greenstein phase, g 0.3.
// Not modelled: shadowing by geometry and attenuation along light paths (the haze is thin; light rays mostly cross
// clear air).
import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, uv, vec2, vec3, vec4, float, int, uint, max, min, dot, normalize, length, exp, abs, pow, sqrt, mix,
  smoothstep, select, Loop, If, Break, screenCoordinate } from 'three/tsl';
import { noiseTex4, fbm4 } from './cycles_noise.js';

const quadMat = node => { const m = new THREE.NodeMaterial(); m.fragmentNode = node; m.depthTest = false; m.depthWrite = false; return m; };

export function makeHaze({ distTex, emitTex, look }) {
  const H = look;   // doc.look.haze
  const U = {
    eye: uniform(new THREE.Vector3()), cr: uniform(new THREE.Vector3()), cu: uniform(new THREE.Vector3()), cf: uniform(new THREE.Vector3()),
    tanY: uniform(0.27), aspect: uniform(16 / 9), t: uniform(0), frame: uniform(0),
    g00: uniform(new THREE.Vector3()), geu: uniform(new THREE.Vector3()), gev: uniform(new THREE.Vector3()), gn: uniform(new THREE.Vector3()),
    ringPos: uniform(new THREE.Vector3()), ringI: uniform(new THREE.Vector3()),   // radiant intensity, W/sr, linear RGB
    ledPos: uniform(new THREE.Vector3()), ledI: uniform(new THREE.Vector3()),
    exposure: uniform(H.exposure ?? 1), stepLen: uniform(H.stepLen ?? 0.015), screenLight: uniform(H.screenLight ?? 100),
  };
  const GX = H.grid?.[0] ?? 12, GY = H.grid?.[1] ?? 9, G = H.anisotropy ?? 0.3;
  const BOX0 = vec3(...H.box[0]), BOX1 = vec3(...H.box[1]);
  const D = H.density;   // { density, scale, detail, roughness, distortion, wisp, cover:[c0,c1], coverScale, drift, evolve }
  const emitNode = texture(emitTex);

  /** haze density at a glTF-space point (Blender's Position is (x, -z, y)). */
  const density = Fn(([pg]) => {
    const vb = vec3(pg.x, pg.z.negate(), pg.y).sub(vec3(0, 0, U.t.mul(D.drift)));
    const nz = noiseTex4(vec4(vb.mul(D.scale), U.t.mul(D.evolve).mul(D.scale)), { detail: D.detail, roughness: D.roughness, distortion: D.distortion });
    const cs = D.scale * D.coverScale;
    const cz = fbm4(vec4(vb.mul(cs), U.t.mul(D.evolve * 0.6).add(7.3).mul(cs)), D.coverDetail ?? 2, D.coverRoughness ?? 0.5);
    const sheet = float(1).sub(smoothstep(0, D.wisp, abs(nz.sub(0.5))));
    const cover = smoothstep(D.cover[0], D.cover[1], cz);
    return sheet.mul(cover).mul(2 * D.density);
  }, { pg: 'vec3', return: 'float' });

  const hg = cosT => { const g2 = G * G; return float((1 - g2) / (4 * Math.PI)).div(pow(float(1 + g2).sub(cosT.mul(2 * G)), 1.5)); };

  /** in-scattered radiance at x toward the camera (direction vd = x -> eye). */
  const inscatter = Fn(([x, vd]) => {
    const acc = vec3(0).toVar();
    const dA = length(U.geu.cross(U.gev)).div(GX * GY);
    for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
      const su = (i + 0.5) / GX, sv = (j + 0.5) / GY;
      const p = U.g00.add(U.geu.mul(su)).add(U.gev.mul(sv));
      const dv = x.sub(p), d2 = dot(dv, dv), dl = dv.div(sqrt(d2));
      const cosE = max(dot(U.gn, dl), 0);
      const d2s = d2.add(dA.mul(0.25));   // soften the cell's 1/d^2 for points nearer the glass than the cell size
      const Le = emitNode.sample(vec2(su, sv)).level(0).rgb;   // linear emission already scaled
      acc.addAssign(Le.mul(cosE.mul(dA).div(d2s).mul(hg(dot(dl, vd)))));
    }
    for (const [P, I] of [[U.ringPos, U.ringI], [U.ledPos, U.ledI]]) {
      const dv = x.sub(P), d2 = max(dot(dv, dv), 1e-6), dl = dv.div(sqrt(d2));
      acc.addAssign(I.div(d2).mul(hg(dot(dl, vd))));
    }
    return acc;
  }, { x: 'vec3', vd: 'vec3', return: 'vec3' });

  const march = quadMat(Fn(() => {
    const q = uv();   // y down
    const ndc = vec2(q.x.mul(2).sub(1), float(1).sub(q.y.mul(2)));
    const dir = normalize(U.cf.add(U.cr.mul(ndc.x.mul(U.tanY).mul(U.aspect))).add(U.cu.mul(ndc.y.mul(U.tanY))));
    // ray / room box
    const inv = vec3(1).div(dir), t0 = BOX0.sub(U.eye).mul(inv), t1 = BOX1.sub(U.eye).mul(inv);
    const tmin = min(t0, t1), tmax = max(t0, t1);
    const tEnter = max(max(max(tmin.x, tmin.y), tmin.z), 0), tExit = min(min(tmax.x, tmax.y), tmax.z);
    // the distance pass holds (coverage x distance, coverage), multisampled: at a silhouette pixel the haze is the
    // coverage-weighted mix of the haze up to the surface and the haze past it, as Cycles' many samples would give
    const ds = texture(distTex, q).level(0), cov = ds.g, dNear = select(cov.greaterThan(1e-4), ds.r.div(max(cov, 1e-4)), float(1e9));
    const tEnd = select(cov.greaterThan(0.999), min(tExit, dNear), tExit);
    const L = vec3(0).toVar(), T = float(1).toVar(), Lnear = vec3(0).toVar(), snapped = float(0).toVar();
    // per-pixel start offset: white noise from a PCG hash of the pixel and frame (a sin-based hash left diagonal hatching)
    const h0 = uint(screenCoordinate.x).add(uint(screenCoordinate.y).mul(uint(4099))).add(uint(U.frame).mul(uint(16777619)));
    const st1 = h0.mul(uint(747796405)).add(uint(2891336453));
    const w1 = st1.shiftRight(st1.shiftRight(uint(28)).add(uint(4))).bitXor(st1).mul(uint(277803737));
    const jit = float(w1.shiftRight(uint(22)).bitXor(w1)).div(4294967296.0);
    const tt = tEnter.add(U.stepLen.mul(jit)).toVar();
    const vd = dir.negate();
    Loop(H.maxSteps ?? 320, () => {
      If(tt.greaterThanEqual(tEnd), () => { Break(); });
      If(snapped.lessThan(0.5).and(tt.greaterThanEqual(dNear)), () => { Lnear.assign(L); snapped.assign(1); });
      const x = U.eye.add(dir.mul(tt));
      const dt = min(U.stepLen, tEnd.sub(tt));
      const s = density(x);
      If(s.greaterThan(0), () => {
        L.addAssign(inscatter(x, vd).mul(s.mul(dt).mul(T)));
        T.mulAssign(exp(s.mul(dt).negate()));
      });
      tt.addAssign(U.stepLen);
    });
    If(snapped.lessThan(0.5), () => { Lnear.assign(L); });
    return vec4(mix(L, Lnear, cov).mul(U.exposure), 1);
  })());
  return { U, march: new THREE.QuadMesh(march) };
}

/** The CRT's emission for lighting: the screen image (display values) decoded to linear and scaled, on a small grid. */
export function makeEmitPass(crtFlatNode) {
  return new THREE.QuadMesh(quadMat(crtFlatNode));
}
