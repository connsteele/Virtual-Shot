// The final composite, as Black Page's Blender compositor did it, but on the GPU in the same frame:
//   engine picture (3D + flat crossfade, display values) -> linear + haze x gain (haze through the engine's lens
//   warp, fringe, vignette and squint) -> pops alpha-over in linear -> sRGB.
// Plus the small passes that feed it: the screen's emission grid for lighting the haze, and a haze level meter.
import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, uv, vec2, vec3, vec4, float, mix, clamp, max, min, dot, abs, pow, select, smoothstep, Loop } from 'three/tsl';
import { sstep } from './materials.js';

const quadMat = node => { const m = new THREE.NodeMaterial(); m.fragmentNode = node; m.depthTest = false; m.depthWrite = false; return m; };
export const srgbToLinear = c => select(c.lessThanEqual(0.04045), c.div(12.92), pow(c.add(0.055).div(1.055), vec3(2.4)));
export const linearToSrgb = c => select(c.lessThanEqual(0.0031308), c.mul(12.92), pow(max(c, vec3(0)), vec3(1 / 2.4)).mul(1.055).sub(0.055));

/** Lens (warp, fringe, vignette) + squint applied to a linear buffer, as Black Page's post.py did for the haze. */
export function lensSample(texNode, q, U) {
  const warp = (qq, kk) => {
    const p0 = qq.mul(2).sub(1), p = vec2(p0.x.mul(U.aspect), p0.y);
    const r2 = dot(p, p), rc2 = U.aspect.mul(U.aspect).add(1);
    const pw = p.mul(float(1).add(kk.mul(r2)).div(float(1).add(kk.mul(rc2))));
    return vec2(pw.x.div(U.aspect), pw.y).mul(0.5).add(0.5);
  };
  // U.blur (uv offset, Play quality only): a 4-tap box that smooths the coarse haze's sampling noise
  const tap = w => { const o = U.blur ? U.blur : float(0);
    return texNode.sample(w.add(vec2(o, o))).level(0).add(texNode.sample(w.add(vec2(o.negate(), o))).level(0))
      .add(texNode.sample(w.add(vec2(o, o.negate()))).level(0)).add(texNode.sample(w.sub(vec2(o, o))).level(0)).mul(0.25); };
  const flat = tap(q).rgb;
  const p0 = q.mul(2).sub(1), edge = clamp(dot(p0, p0).mul(0.5), 0, 1);
  const g = tap(warp(q, U.k)).g;
  const r = tap(warp(q, U.k.mul(edge.mul(0.03).add(1)))).r, b = tap(warp(q, U.k.mul(float(1).sub(edge.mul(0.03))))).b;
  const p = vec2(p0.x.mul(U.aspect), p0.y), e = dot(p, p).div(U.aspect.mul(U.aspect).add(1));
  const vig = float(1).sub(min(U.k.mul(3), 1).mul(0.5).mul(smoothstep(0.15, 1, e)));
  const warped = vec3(r, g, b).mul(vig);
  const base = select(U.k.lessThanEqual(1e-4), flat, warped);
  const ly = abs(q.y.mul(2).sub(1)).add(pow(abs(q.x.mul(2).sub(1)), 2).mul(0.18));
  return base.mul(float(1).sub(U.sq.mul(sstep(float(1.05).sub(U.sq.mul(0.75)), float(1.25).sub(U.sq.mul(0.55)), ly))));
}

export function makeComposite({ engineTex, flatTex, popsTex, hazeTex }) {
  const U = { overlay: uniform(0), before: uniform(1), gain: uniform(0), hazeOn: uniform(1), popsOn: uniform(1),
    k: uniform(0), sq: uniform(0), aspect: uniform(16 / 9), blur: uniform(0) };
  const eng = texture(engineTex), flat = texture(flatTex), pops = texture(popsTex), haze = texture(hazeTex);
  const node = Fn(() => {
    const q = uv();
    const f = flat.sample(q).level(0).rgb, e = eng.sample(q).level(0).rgb;
    const disp = select(U.before.greaterThan(0.5), f, mix(e, f, U.overlay));
    const lin = srgbToLinear(disp).toVar();
    lin.addAssign(lensSample(haze, q, U).mul(U.gain.mul(U.hazeOn).mul(float(1).sub(U.before))));
    const p = pops.sample(q).level(0), a = p.a.mul(U.popsOn);
    const outLin = lin.mul(float(1).sub(a)).add(srgbToLinear(p.rgb).mul(a));
    return vec4(linearToSrgb(clamp(outLin, 0, 1)), 1);
  })();
  return { U, quad: new THREE.QuadMesh(quadMat(node)) };
}

/** Haze level: mean Rec.709 luminance of the lens-warped, ungained haze at the output frame, written to a small
 *  float target (read back and averaged on the CPU), as Black Page's atmos_render.py measured levels.txt. */
export function makeHazeMeter({ hazeTex }) {
  const U = { k: uniform(0), sq: uniform(0), aspect: uniform(16 / 9) };
  const haze = texture(hazeTex);
  const node = Fn(() => { const h = lensSample(haze, uv(), U); return vec4(dot(h, vec3(0.2126, 0.7152, 0.0722)), 0, 0, 1); })();
  return { U, quad: new THREE.QuadMesh(quadMat(node)) };
}

/** Average the flat screen image into the light grid: each cell = mean of linear(texel) x screenLight. */
export function makeEmitAverage({ hiTex, gx, gy, samples = 16 }) {
  const U = { screenLight: uniform(100) };
  const hi = texture(hiTex);
  const node = Fn(() => {
    const q = uv(), acc = vec3(0).toVar();
    const cell = vec2(1 / gx, 1 / gy), c0 = q.sub(cell.mul(0.5));
    for (let j = 0; j < samples; j++) for (let i = 0; i < samples; i++)
      acc.addAssign(srgbToLinear(hi.sample(c0.add(cell.mul(vec2((i + 0.5) / samples, (j + 0.5) / samples)))).level(0).rgb));
    return vec4(acc.mul(U.screenLight.div(samples * samples)), 1);
  })();
  return { U, quad: new THREE.QuadMesh(quadMat(node)) };
}

export const flatScreenQuad = node => new THREE.QuadMesh(quadMat(node));
