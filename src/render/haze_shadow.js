// Haze self-shadowing (research, a Show-menu toggle, off by default): light loses strength crossing the haze on its way
// to each point, so thick wisps get darker cores and the haze behind them dims.
//
// Two passes per frame into "volume atlases" (the voxel grid's z slices tiled in a 2D texture, so plain fragment
// passes can write them and bilinear filtering does x/y; z is a lerp between two slices):
//   1. density: the same density field as the march, at each voxel centre;
//   2. transmittance: from each voxel, a short march through (1) toward four points on the screen (the centres of its
//      quadrants) and toward the ringing remote's light; RGBA = the screen quadrants, and a second atlas for the ring.
// The haze march then reads one transmittance sample per step and scales each light cell by its quadrant's value.
import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, uv, vec2, vec3, vec4, float, max, min, clamp, exp, floor, mix, length } from 'three/tsl';
import { densityFn } from './haze.js';

const quadMat = node => { const m = new THREE.NodeMaterial(); m.fragmentNode = node; m.depthTest = false; m.depthWrite = false; return m; };

/** hazeU: () => the haze march's uniforms (for time). */
export function makeHazeShadow({ hazeU, look }) {
  const H = look, D = H.density, S = H.selfShadow || {};
  const N = S.voxels ?? [128, 128, 128], [NX, NY, NZ] = N, TC = S.tiles ?? 16, TR = Math.ceil(NZ / TC);
  const AW = NX * TC, AH = NY * TR, steps = S.steps ?? 24;
  const B0 = new THREE.Vector3(...H.box[0]), B1 = new THREE.Vector3(...H.box[1]);
  const rt = (fmt) => new THREE.RenderTarget(AW, AH, { depthBuffer: false, generateMipmaps: false, type: THREE.HalfFloatType, format: fmt,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  const densRT = rt(THREE.RedFormat), transRT = rt(THREE.RGBAFormat), ringRT = rt(THREE.RedFormat);
  const U = {
    q: [0, 1, 2, 3].map(() => uniform(new THREE.Vector3())),   // screen quadrant centres
    ring: uniform(new THREE.Vector3()), on: uniform(0), strength: uniform(S.strength ?? 1),
  };
  const b0 = vec3(B0.x, B0.y, B0.z), bs = vec3(B1.x - B0.x, B1.y - B0.y, B1.z - B0.z);

  /** world position of the voxel this atlas texel stores */
  const voxelPos = () => {
    const px = uv().mul(vec2(AW, AH)), tile = floor(px.div(vec2(NX, NY))), loc = px.sub(tile.mul(vec2(NX, NY)));
    const iz = tile.y.mul(TC).add(tile.x);
    return b0.add(vec3(loc.x.div(NX), loc.y.div(NY), iz.add(0.5).div(NZ)).mul(bs));
  };
  /** trilinear read of a volume atlas at world point p (clamped to the box) */
  const sampleVol = (node, p) => {
    const g = clamp(p.sub(b0).div(bs), 0, 1).mul(vec3(NX, NY, NZ)).sub(0.5);
    const z0 = clamp(floor(g.z), 0, NZ - 1), z1 = min(z0.add(1), NZ - 1), fz = clamp(g.z.sub(z0), 0, 1);
    const xy = vec2(clamp(g.x.add(0.5), 0.5, NX - 0.5), clamp(g.y.add(0.5), 0.5, NY - 0.5));
    const at = z => { const tx = z.mod(TC), ty = floor(z.div(TC)); return node.sample(vec2(tx.mul(NX).add(xy.x).div(AW), ty.mul(NY).add(xy.y).div(AH))).level(0); };
    return mix(at(z0), at(z1), fz);
  };

  // built on first use: the march's uniforms (time) exist only once the haze is made
  let densPass = null;
  const makeDensPass = () => { const density = densityFn(hazeU(), D); return new THREE.QuadMesh(quadMat(Fn(() => vec4(density(voxelPos()), 0, 0, 1))())); };

  // optical depth from p to target: `steps` samples, the first half a step from p
  const transTo = (dens, p, target) => {
    const d = target.sub(p), L = length(d), dt = L.div(steps), tau = float(0).toVar();
    for (let i = 0; i < steps; i++) tau.addAssign(sampleVol(dens, p.add(d.mul((i + 0.5) / steps))).r);
    return exp(tau.mul(dt).mul(U.strength).negate());
  };
  const transPass = new THREE.QuadMesh(quadMat(Fn(() => {
    const dens = texture(densRT.texture), p = voxelPos().toVar();
    return vec4(transTo(dens, p, U.q[0]), transTo(dens, p, U.q[1]), transTo(dens, p, U.q[2]), transTo(dens, p, U.q[3]));
  })()));
  const ringPass = new THREE.QuadMesh(quadMat(Fn(() => {
    const dens = texture(densRT.texture), p = voxelPos().toVar();
    return vec4(transTo(dens, p, U.ring), 0, 0, 1);
  })()));

  /** Rebuild the volumes for this frame (gm: glass uv -> world fit; ringPos: null when the remote isn't ringing). */
  function update(r, { gm, ringPos, mark = () => {} }) {
    [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].forEach(([u, v], i) =>
      U.q[i].value.set(...[0, 1, 2].map(c => gm.p00[c] + gm.eu[c] * u + gm.ev[c] * v)));
    densPass ||= makeDensPass();
    mark('haze self-shadow density'); r.setRenderTarget(densRT); densPass.render(r);
    mark('haze self-shadow light'); r.setRenderTarget(transRT); transPass.render(r);
    if (ringPos) { U.ring.value.set(...ringPos); mark('haze self-shadow ring'); r.setRenderTarget(ringRT); ringPass.render(r); }
  }

  /** Node builders for the march (one set per material). */
  const nodes = () => {
    const tq = texture(transRT.texture), tr = texture(ringRT.texture);
    return { screen: p => sampleVol(tq, p), ring: p => sampleVol(tr, p).r };
  };
  /** Quadrant (0..3) of light-grid cell (i, j) of a gx x gy grid. */
  const quadOf = (i, j, gx, gy) => (i + 0.5 < gx / 2 ? 0 : 1) + (j + 0.5 < gy / 2 ? 0 : 2);
  return { U, update, nodes, quadOf, rts: { densRT, transRT, ringRT } };
}
