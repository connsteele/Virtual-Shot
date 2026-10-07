// PS1-era surface material: the Black Page body lighting (same terms as bodyMaterial in materials.js) with the
// PlayStation's artefacts, each a 0..1 uniform so a style can mix them without recompiling:
//   snap     vertices snapped to whole pixels of the scene buffer (the GTE had no sub-pixel precision: wobbling polygons)
//   affine   textures interpolated in screen space, without perspective correction (the GPU's warping textures)
//   gouraud  lighting computed per vertex and interpolated (no per-pixel lighting on the PS1)
// Colour depth (15-bit with the 4x4 ordered dither) and the low internal resolution come from the chunky-pixel pass.
import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, uv, vec2, vec3, vec4, float, mix, clamp, max, min, dot, normalize, length, exp, round, If, Discard,
  positionWorld, positionLocal, normalWorldGeometry, modelViewMatrix, cameraProjectionMatrix, varying, select, cameraPosition } from 'three/tsl';

/** Uniforms shared by every PS1 surface; res is the scene buffer's size in pixels (set per frame). */
export const makePs1Uniforms = () => ({ res: uniform(new THREE.Vector2(854, 480)), snap: uniform(1), affine: uniform(1), gouraud: uniform(1),
  fog: uniform(new THREE.Vector2(0, 0)) });   // depth cue: fade to black from fog.x to fog.y metres (0, 0 = off), per vertex like the GTE

/** The light reaching a surface point (multiplies the texture colour), as in bodyMaterial without banding. */
function lightK(U, n, P, { scMul, blMul, rawLed }) {
  const Lv = U.sp.sub(P), d = length(Lv), L = Lv.div(d);
  const lobe = clamp(dot(L.negate(), U.sn).mul(0.7).add(0.3), 0, 1);
  const face = max(dot(n, L).mul(0.85).add(0.15), 0).mul(lobe);
  const spill = face.mul(U.si).div(d.mul(d).mul(5).add(1));
  const fill = U.amb.mul(float(0.5).add(max(dot(n, normalize(vec3(-0.4, 0.8, 0.3))), 0).mul(0.5)));
  const Lb0 = U.bp.sub(P), db = length(Lb0), Lb = Lb0.div(max(db, 1e-5));
  const bnc = U.bi.mul(max(dot(n, Lb), 0)).div(db.mul(db).mul(1.5).add(1));
  const sc = scMul === 1 ? U.sc : U.sc.mul(scMul), bl = blMul === 1 ? U.bl : U.bl.mul(blMul);
  const lp = rawLed ? U.lpRaw : U.lp, dl = lp.sub(P), dd = length(dl);
  const led = U.lc.mul(U.li).mul(0.9).mul(exp(dd.mul(dd).negate().div(U.lrad.mul(U.lrad))).mul(max(dot(n, dl.div(max(dd, 1e-5))), 0.25)));
  const rl = U.rp.sub(P), rd = length(rl);
  const ring = U.rc.mul(U.ri).mul(exp(rd.mul(rd).negate().div(U.rrad.mul(U.rrad))).mul(max(dot(n, rl.div(max(rd, 1e-5))), 0.2)));
  return fill.add(sc.mul(spill.add(bnc))).mul(bl).add(led).add(ring);
}

export function ps1Material(U, P, { map = null, emissiveMap = null, ledRect = [2, 2, 2, 2], ov = null, scMul = 1, blMul = 1, rawLed = false } = {}) {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  // vertex snapping: clip position -> nearest whole pixel of the scene buffer
  const clip = cameraProjectionMatrix.mul(modelViewMatrix).mul(vec4(positionLocal, 1)), half = P.res.mul(0.5);
  const snapped = round(clip.xy.div(clip.w).mul(half)).div(half).mul(clip.w);
  m.vertexNode = vec4(mix(clip.xy, snapped, P.snap), clip.z, clip.w);
  // affine textures: interpolate uv*w and w (perspective-correct), divide per pixel = screen-linear uv
  const uvw = varying(vec3(uv().mul(clip.w), clip.w)), lr = vec4(...ledRect);
  const opt = { scMul, blMul, rawLed };
  const kVert = varying(lightK(U, normalWorldGeometry, positionWorld, opt));
  m.outputNode = Fn(() => {
    const v = mix(uv(), uvw.xy.div(uvw.z), P.affine).toVar();
    const c = map ? texture(map, v) : vec4(0.6);
    If(c.a.lessThan(0.4), () => { Discard(); });
    const fd = positionWorld.distance(cameraPosition), fogK = select(P.fog.y.greaterThan(0), float(1).sub(clamp(fd.sub(P.fog.x).div(max(P.fog.y.sub(P.fog.x), 1e-4)), 0, 1)), float(1));
    const K = mix(lightK(U, normalWorldGeometry, positionWorld, opt), kVert, P.gouraud).mul(fogK);
    const col = c.rgb.mul(K).toVar();
    const inRect = v.x.greaterThan(lr.x).and(v.x.lessThan(lr.z)).and(v.y.greaterThan(lr.y)).and(v.y.lessThan(lr.w));
    If(inRect, () => { col.assign(mix(col, U.lc.mul(1.15).add(0.12), min(U.li, 1).mul(0.9))); });
    if (emissiveMap) col.addAssign(texture(emissiveMap, v).rgb.mul(U.eStr));
    return vec4(ov ? mix(col, ov.xyz, ov.w) : col, 1);
  })();
  return m;
}
