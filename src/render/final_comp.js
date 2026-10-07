// The final composite, as Black Page's Blender compositor did it, but on the GPU in the same frame:
//   engine picture (3D + flat crossfade, display values) -> linear + haze x gain (haze through the engine's lens
//   warp, fringe, vignette and squint) -> pops alpha-over in linear -> sRGB.
// Plus the small passes that feed it: the screen's emission grid for lighting the haze, and a haze level meter.
import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, uv, vec2, vec3, vec4, float, mix, clamp, max, min, dot, abs, pow, select, smoothstep, floor, log2, Loop } from 'three/tsl';
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

/** Area-sampling upscale, after Dolphin's "Area Sampling" output resampler: each output pixel is the mean of the source
 *  texels under its footprint, weighted by how much of it each covers. At a non-integer factor (480 lines to 2160 is
 *  4.5x) every source pixel stays a hard-edged block of near-equal size, with a one-pixel blend only where a block
 *  edge falls inside an output pixel; nearest neighbour would make blocks of 4 and 5 pixels, bilinear would blur them.
 *  For upscales only (the footprint spans at most 2x2 texels). In display values, like the emulator.
 *  Two options of the pixel look live here too:
 *  - U.levels > 0: each source texel is quantised to that many levels per channel with a 4x4 ordered (Bayer) dither,
 *    like a console frame buffer at 6 (GameCube/Wii RGBA6) or 5 (PlayStation) bits per channel.
 *  - U.detail = 1 (sharp screen): the CRT's picture at output resolution over the chunky frame. Per output pixel the
 *    screen shader is evaluated where the camera ray meets the glass and swapped in (in linear light) for the screen
 *    colour its source pixel was drawn with: the chunky frame keeps its haze, light and blocky screen edge (the mask is
 *    the scene buffer's screen flag, at the internal size), and the text gets its fine detail back. Faded out where the
 *    screen is out of focus or under the pops, and before the 3D starts. */
export function makeAreaUpscale({ srcTex, distTex, cocTex, popsTex, crtColor, bloomTex }) {
  const v3u = () => uniform(new THREE.Vector3());
  const U = { src: uniform(new THREE.Vector2(854, 480)), dst: uniform(new THREE.Vector2(3840, 2160)), levels: uniform(0),
    detail: uniform(0), k: uniform(0), aspect: uniform(16 / 9), tanY: uniform(0.27), eye: v3u(), cf: v3u(), cr: v3u(), cu: v3u(),
    g00: v3u(), gn: v3u(), da: v3u(), db: v3u(), ub: uniform(new THREE.Vector4(0, 0, 1, 1)), popsOn: uniform(0), scrLines: uniform(0),
    bloom: uniform(0), off: uniform(new THREE.Vector2(0, 0)),
    deflicker: uniform(0) };   // the Wii's deflicker: a vertical [1 2 1] / 4 filter on the frame buffer as it's sent to the TV
  const src = texture(srcTex), dist = texture(distTex), coc = texture(cocTex), pops = texture(popsTex), bloom = texture(bloomTex);
  // 4x4 Bayer threshold in [0, 1) for integer texel coordinates
  const bayer2 = a => a.x.mul(0.5).add(a.y.mul(a.y).mul(0.75)).fract();
  const bayer4 = a => bayer2(floor(a.mul(0.5))).mul(0.25).add(bayer2(a));
  const warp = q => {
    const p0 = q.mul(2).sub(1), p = vec2(p0.x.mul(U.aspect), p0.y);
    const pw = p.mul(float(1).add(U.k.mul(dot(p, p))).div(float(1).add(U.k.mul(U.aspect.mul(U.aspect).add(1)))));
    return select(U.k.lessThanEqual(1e-4), q, vec2(pw.x.div(U.aspect), pw.y).mul(0.5).add(0.5));
  };
  // output uv -> the screen shader's mesh uv (camera ray through the lens warp, onto the glass plane), then its colour
  const meshUV = q => {
    const qq = warp(q), ndc = vec2(qq.x.mul(2).sub(1), float(1).sub(qq.y.mul(2)));
    const dir = U.cf.add(U.cr.mul(ndc.x.mul(U.tanY).mul(U.aspect))).add(U.cu.mul(ndc.y.mul(U.tanY)));
    const rel = U.eye.add(dir.mul(dot(U.g00.sub(U.eye), U.gn).div(dot(dir, U.gn)))).sub(U.g00);
    const ab = vec2(dot(rel, U.da), dot(rel, U.db));
    return U.ub.xy.add(ab.mul(U.ub.zw.sub(U.ub.xy)));
  };
  const screenLin = (m, lodBias, dm) => srgbToLinear(crtColor(m, lodBias, dm).rgb);
  const node = Fn(() => {
    const q = uv(), s = U.src.div(U.dst), p = q.mul(U.dst);        // output pixel centre, in output pixels
    // its footprint, in source texels; U.off: the pixel-stable camera's sub-pixel remainder (the snapped render, moved back)
    const a = p.sub(0.5).mul(s).add(U.off), b = p.add(0.5).mul(s).add(U.off);
    const i0 = floor(a), w = clamp(i0.add(1).sub(a).div(b.sub(a)), 0, 1);   // share of the footprint on texel i0
    const t = (x, y) => { const ti = i0.add(vec2(x, y)), tq = ti.add(0.5).div(U.src);
      const c0 = src.sample(tq).level(0).rgb.add(bloom.sample(tq).level(0).rgb.mul(U.bloom));   // bloom joins the frame buffer, before the dither
      const dy = vec2(0, float(1).div(U.src.y)), cdf = src.sample(tq.sub(dy)).level(0).rgb.add(src.sample(tq.add(dy)).level(0).rgb).add(c0.mul(2)).mul(0.25);
      const c = select(U.deflicker.greaterThan(0), mix(c0, cdf, U.deflicker), c0);
      const L = max(U.levels, 1);
      return select(U.levels.greaterThan(0.5), min(floor(c.mul(L).add(bayer4(ti))).div(L), vec3(1)), c); };
    const up = mix(mix(t(1, 1), t(0, 1), w.x), mix(t(1, 0), t(0, 0), w.x), w.y);
    // sharp screen: swap the source pixel's screen colour for this output pixel's. The source pixel's is re-evaluated as
    // the internal render drew it (at its centre, with the chat's mip level of a source-sized footprint), so what's
    // taken out matches what's there and no blocky ghost of the text is left behind.
    const m = meshUV(q), lo = screenLin(meshUV(floor(q.mul(U.src).add(U.off)).add(0.5).sub(U.off).div(U.src)), log2(U.dst.y.div(U.src.y)), m);
    const qs = q.add(U.off.div(U.src));   // where this pixel is in the (snapped) internal frame
    const onScreen = dist.sample(warp(qs)).level(0).g.greaterThan(1.5);
    const focus = float(1).sub(smoothstep(1, 3, abs(coc.sample(qs).level(0).r)));
    const wd = select(onScreen, focus, float(0)).mul(U.detail).mul(float(1).sub(pops.sample(q).level(0).a.mul(U.popsOn)));
    // the screen's own pixel grid: U.scrLines lines (a sharper but still pixelated screen), or the output's
    const R = select(U.scrLines.greaterThan(0), vec2(U.scrLines.mul(U.dst.x.div(U.dst.y)), U.scrLines), U.dst);
    const hi = screenLin(meshUV(floor(q.mul(R)).add(0.5).div(R)), log2(U.dst.y.div(R.y)), m);
    const lin = srgbToLinear(up).add(hi.sub(lo).mul(wd));
    return vec4(select(U.detail.greaterThan(0), linearToSrgb(clamp(lin, 0, 1)), up), 1);
  })();
  return { U, quad: new THREE.QuadMesh(quadMat(node)) };
}

/** Wii-era bloom (Twilight Princess, Mario Galaxy): the bright parts of the internal frame, averaged down to a quarter
 *  size, blurred wide, and added back into the internal frame by the upscale (U.bloom), so it is chunky and dithered with
 *  everything else. Passes: bright (src -> a), blur x (a -> b), blur y (b -> a). Display values, like those games. */
export function makeBloom({ srcTex, aTex, bTex }) {
  const U = { srcPx: uniform(new THREE.Vector2(1 / 854, 1 / 480)), px: uniform(new THREE.Vector2(1 / 214, 1 / 120)), threshold: uniform(0.2) };
  const src = texture(srcTex), A = texture(aTex), B = texture(bTex);
  const bright = Fn(() => {
    const q = uv(), acc = vec3(0).toVar();
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
      const c = src.sample(q.add(U.srcPx.mul(vec2(i - 1.5, j - 1.5)))).level(0).rgb;
      acc.addAssign(max(c.sub(U.threshold), vec3(0)).div(float(1).sub(U.threshold)));
    }
    return vec4(acc.div(16), 1);
  })();
  const W = [0.1585, 0.1465, 0.1157, 0.0782, 0.0452, 0.0224, 0.0095];   // gaussian, sigma 3.3 texels, 13 taps
  const blur = (T, dir) => Fn(() => {
    const q = uv(), acc = T.sample(q).level(0).rgb.mul(W[0]).toVar();
    for (let i = 1; i < W.length; i++) { const o = U.px.mul(dir).mul(i); acc.addAssign(T.sample(q.add(o)).level(0).rgb.add(T.sample(q.sub(o)).level(0).rgb).mul(W[i])); }
    return vec4(acc.div(0.9935), 1);
  })();
  return { U, quads: { bright: new THREE.QuadMesh(quadMat(bright)), blurX: new THREE.QuadMesh(quadMat(blur(A, vec2(1, 0)))), blurY: new THREE.QuadMesh(quadMat(blur(B, vec2(0, 1)))) } };
}
