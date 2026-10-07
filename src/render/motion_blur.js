// Per-object motion blur from a velocity buffer (cheap, one frame), deterministic in t.
// The velocity of every visible surface point is its screen position at the shutter's close minus its position at the
// shutter's open, both computed from the scene document evaluated at those two times (camera and object matrices), so
// it never depends on which frame was drawn before (scrubbing and out-of-order renders give the same blur).
//   velocity pass  the scene again with an override material: per object, its world matrix at open and close
//                  (uniforms updated per object from object.userData.mbOpen / mbClose), the camera's view-projections
//   blur pass      a gather along each pixel's velocity, 16 taps, in linear light; a tap counts where its own motion
//                  covers this pixel (it's in front and moving over us) or where this pixel's motion covers it
//                  (background behind a moving edge), after McGuire et al. 2012's reconstruction filter, simplified
// The result goes into the lens pass's alternate input (the same slot the pixel outlines use), before the lens,
// depth of field, haze and 2D layers, so those are not blurred.
import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, uv, vec2, vec4, float, max, clamp, length, select, positionLocal, varying, Loop, int } from 'three/tsl';
import { srgbToLinear, linearToSrgb } from './final_comp.js';

export function makeVelocityMaterial() {
  const U = { openVP: uniform(new THREE.Matrix4()), closeVP: uniform(new THREE.Matrix4()) };
  const mOpen = uniform(new THREE.Matrix4()).onObjectUpdate(({ object }) => object.userData.mbOpen || object.matrixWorld);
  const mClose = uniform(new THREE.Matrix4()).onObjectUpdate(({ object }) => object.userData.mbClose || object.matrixWorld);
  const p = vec4(positionLocal, 1);
  const cO = varying(U.openVP.mul(mOpen).mul(p)), cC = varying(U.closeVP.mul(mClose).mul(p));
  const m = new THREE.NodeMaterial(); m.side = THREE.DoubleSide;
  m.fragmentNode = Fn(() => {
    const d = cC.xy.div(cC.w).sub(cO.xy.div(cO.w));   // ndc, y up
    return vec4(d.x.mul(0.5), d.y.mul(-0.5), 0, 1);   // uv units (y down), shutter open -> close
  })();
  return { U, material: m };
}

export function makeMotionBlur({ colorTex, distTex, velTex }) {
  const U = { px: uniform(new THREE.Vector2(1 / 1920, 1 / 1080)), scale: uniform(1), maxPx: uniform(96) };
  const col = texture(colorTex), dist = texture(distTex), vel = texture(velTex);
  const D = q => { const z = dist.sample(q).level(0), r = z.r.div(max(z.g, 1)); return select(r.lessThanEqual(0), float(1e3), r); };
  const N = 16;
  const node = Fn(() => {
    const q = uv(), c0 = col.sample(q).level(0);
    const vPx0 = vel.sample(q).level(0).xy.mul(U.scale).div(U.px), l0 = length(vPx0);
    const vq = select(l0.greaterThan(U.maxPx), vPx0.mul(U.maxPx.div(max(l0, 1e-4))), vPx0), lq = min_(length(vq), U.maxPx);
    const sum = vec4(srgbToLinear(c0.rgb), 1).toVar(), dq = D(q);
    Loop({ start: int(0), end: int(N), type: 'int', condition: '<' }, ({ i }) => {
      const s = float(i).add(0.5).div(N).sub(0.5);                  // -0.5 .. 0.5 along the motion
      const off = vq.mul(s), x = length(off), p = q.add(off.mul(U.px));
      const cp = col.sample(p).level(0), dp = D(p), lp = min_(length(vel.sample(p).level(0).xy.mul(U.scale).div(U.px)), U.maxPx);
      const cover = (len) => clamp(len.mul(0.5).sub(x).add(1), 0, 1);
      const front = dp.lessThan(dq.mul(0.995));
      const w = select(front, cover(lp), cover(lq));                  // in front: its motion must reach us; behind: ours must reach it
      sum.addAssign(vec4(srgbToLinear(cp.rgb).mul(w), w));
    });
    return vec4(linearToSrgb(sum.rgb.div(max(sum.a, 1e-4))), c0.a);
  })();
  const m = new THREE.NodeMaterial(); m.fragmentNode = node; m.depthTest = false; m.depthWrite = false;
  return { U, quad: new THREE.QuadMesh(m) };
}
const min_ = (a, b) => a.min(b);
