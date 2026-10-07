// Halo: Combat Evolved look (2001 Xbox / 2003 PC), as a self-contained look module for ShotRenderer (or any host with
// the same few fields, e.g. the lookdev page). Off by default; the default look's materials and passes are untouched:
// this module builds its own materials and swaps them onto the meshes while it is on, and adds its own passes.
//
// The era's signature pieces, in TSL:
//  - Base maps filtered like a 2001 PC/Xbox game (trilinear + anisotropic), not the PSX pack's nearest texels.
//  - Detail map: a tiled high-frequency greyscale texture (generated here) "double-multiplied" over the base map
//    (base x detail x 2, mean 0.5, so it adds grain without darkening; mipmaps fade it to flat grey with distance).
//  - Multipurpose map (Halo's shader_model): derived from the base texture per texel, packed as
//    R = specular / reflection mask, G = self-illumination, B = detail mask (Halo PC packs them as auxiliary/detail,
//    self-illum, specular, colour change; Xbox swizzles them; the meaning is the same).
//  - Cubemap reflections: a generated low-res "generic" environment cube (bright sky, horizon band, light panels),
//    added under the reflection mask with no fresnel, the era's bright chrome-and-plastic sheen. Optionally dimmed by
//    the local light, so dark corners don't shine.
//  - Lightmap feel: the direct light evaluated on a world-space lattice (a lightmap's texel grid, 8 taps, trilinear),
//    so tight light spots smear into soft texel-shaped pools, plus one bounce of colour bleed from virtual point lights
//    (one per placed object: its lit surfaces' area x albedo x irradiance, measured on the CPU like a radiosity bake).
//  - Fog: Halo's atmospheric fog (colour, start and opaque distances, maximum density) and planar fog (density by the
//    length of the view ray under a fog plane); a fog-coloured sky shell so the void fogs too.
//  - Glow: self-illuminated texels (and the screen) write a glow mask into alpha; a quarter-size blurred glow is added.
//  - Lens flares: sprite flares on the light sources (core, 6-point star, horizontal streak, hexagon ghosts along the
//    axis through the frame centre), occlusion-tested against the distance buffer.
import * as THREE from 'three/webgpu';
import { Fn, uniform, uniformArray, texture, cubeTexture, uv, vec2, vec3, vec4, float, mix, clamp, max, min, dot, normalize, length, exp,
  abs, pow, positionWorld, normalWorldGeometry, cameraPosition, If, Discard, select, smoothstep, floor, fract, reflect, atan, cos, mrt, dFdx, dFdy, cross, sign } from 'three/tsl';

/** The look's settings. Fog numbers are metres in the scene (Black Page is desk-sized). Colours are display values. */
export const HALO_LOOK = {
  detail: { scale: 6, strength: 0.45 },        // detail tiles per metre (world-space, triplanar; 256 px a tile), strength 0..1
  reflect: { strength: 0.35, lit: 0.75,      // cube reflection under the mask; lit: 0 = always full, 1 = scaled by the local light
    perp: 1, par: 1,                          // research pass: Halo's perpendicular / parallel brightness (facing vs grazing); 1, 1 = no fresnel
    bump: 0 },                                // research pass: bumped cube map, the bump derived from the base map's luminance (0 = flat)
  selfIllum: 1,                               // derived self-illumination strength (texels that read as lamps / LEDs)
  lightmap: { cell: 0.05, bleed: 0.5, bits: 0 },   // lattice cell (m; 0 = per pixel), colour-bleed strength; bits: research pass,
                                              //  1 = quantise the light to a 16-bit R5G6B5 lightmap (banding in dark gradients), 0 = off
  fog: { color: [0.11, 0.13, 0.16], start: 0.45, opaque: 4.5, max: 0.5, planeY: -0.25, planeDepth: 0.6, planeMax: 0.35 },
  sky: 'fog',                                 // 'fog': the void is fog-coloured; 'cube': the generic cube, fogged
  glow: 0.4, flares: 1,
};

/** The generic environment cube, generated: six faces of `size` px (display values). */
function makeGenericCube(size = 64) {
  const sun = normalize3([0.45, 0.55, -0.7]);
  const env = d => {
    const [x, y, z] = d, h = y;
    // sky: blue-grey, brighter toward a hazy horizon; ground: dark warm grey
    let c = h > 0 ? lerp3([0.62, 0.68, 0.74], [0.32, 0.42, 0.58], Math.pow(h, 0.6)) : lerp3([0.42, 0.4, 0.36], [0.12, 0.11, 0.1], Math.pow(-h, 0.5));
    c = add3(c, scl3([0.35, 0.33, 0.3], Math.exp(-Math.abs(h) * 18)));                       // horizon band
    const s = Math.max(0, x * sun[0] + y * sun[1] + z * sun[2]);
    c = add3(c, scl3([1, 0.95, 0.85], Math.pow(s, 300) * 3 + Math.pow(s, 12) * 0.35));            // sun and its halo
    // a few rectangular light panels (the "interior" half of Halo's generic metal cubes)
    for (const [ax, ay] of [[0.6, 0.25], [-1.9, 0.35], [2.6, 0.15]]) {
      const a = Math.atan2(z, x) - ax, el = Math.asin(Math.max(-1, Math.min(1, y))) - ay;
      if (Math.abs(a) < 0.18 && Math.abs(el) < 0.07) c = add3(c, [0.55, 0.6, 0.65]);
    }
    return c.map(v => Math.max(0, Math.min(1, v)));
  };
  const faces = [0, 1, 2, 3, 4, 5].map(f => {
    const cv = document.createElement('canvas'); cv.width = cv.height = size; const cx = cv.getContext('2d'), im = cx.createImageData(size, size);
    for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
      const a = 2 * (i + 0.5) / size - 1, b = 2 * (j + 0.5) / size - 1;
      const d = normalize3([[1, -b, -a], [-1, -b, a], [a, 1, b], [a, -1, -b], [a, -b, 1], [-a, -b, -1]][f]), c = env(d), o = (j * size + i) * 4;
      im.data[o] = c[0] * 255; im.data[o + 1] = c[1] * 255; im.data[o + 2] = c[2] * 255; im.data[o + 3] = 255;
    }
    cx.putImageData(im, 0, 0); return cv;
  });
  const t = new THREE.CubeTexture(faces);
  Object.assign(t, { colorSpace: THREE.NoColorSpace, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, needsUpdate: true });
  return t;
}

/** The detail map, generated: 256 px tileable greyscale grain (value noise octaves + fine speckle + a few scratches), mean 0.5. */
function makeDetailMap(size = 256) {
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const lattice = n => { const g = new Float32Array(n * n); for (let i = 0; i < g.length; i++) g[i] = rnd(); return g; };
  const octs = [16, 32, 64, 128].map(n => ({ n, g: lattice(n) }));
  const val = (o, x, y) => {   // tileable bilinear value noise (smoothstepped)
    const fx = x * o.n, fy = y * o.n, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const G = (i, j) => o.g[((j % o.n + o.n) % o.n) * o.n + ((i % o.n + o.n) % o.n)];
    return (G(x0, y0) * (1 - sx) + G(x0 + 1, y0) * sx) * (1 - sy) + (G(x0, y0 + 1) * (1 - sx) + G(x0 + 1, y0 + 1) * sx) * sy;
  };
  const px = new Float32Array(size * size);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const x = i / size, y = j / size; let v = 0, a = 0.5, s = 0;
    for (const o of octs) { v += (val(o, x, y) - 0.5) * a; s += a; a *= 0.85; }
    px[j * size + i] = v / s * 0.75 + (rnd() - 0.5) * 0.25;
  }
  for (let k = 0; k < 40; k++) {   // scratches: short bright/dark strokes, wrapped
    let x = rnd() * size, y = rnd() * size; const ang = rnd() * Math.PI, len = 8 + rnd() * 30, dv = (rnd() < 0.5 ? -1 : 1) * (0.15 + rnd() * 0.2);
    for (let t = 0; t < len; t++) { const xi = ((Math.round(x) % size) + size) % size, yi = ((Math.round(y) % size) + size) % size; px[yi * size + xi] += dv; x += Math.cos(ang); y += Math.sin(ang); }
  }
  let mean = 0; for (const v of px) mean += v; mean /= px.length;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < px.length; i++) { const v = Math.max(0, Math.min(255, Math.round((0.5 + (px[i] - mean)) * 255))); data.set([v, v, v, 255], i * 4); }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  Object.assign(t, { colorSpace: THREE.NoColorSpace, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, anisotropy: 8, needsUpdate: true });
  return t;
}

const NV = 8;   // virtual point lights (colour bleed), one per placed object
const NF = 8;   // lens flares

/** Uniforms of the look (shared by its materials). */
function makeHaloUniforms() {
  return {
    detScale: uniform(9), detStr: uniform(1), refl: uniform(0.45), reflLit: uniform(0.75), si: uniform(1), cell: uniform(0.05), bleed: uniform(1),
    perp: uniform(1), par: uniform(1), bump: uniform(0), lmBits: uniform(0),
    fogC: uniform(new THREE.Vector3()), fogStart: uniform(0.45), fogEnd: uniform(4.5), fogMax: uniform(0.5),
    planeY: uniform(-0.25), planeDepth: uniform(0.6), planeMax: uniform(0.35), sky: uniform(0),
    vp: uniformArray([...Array(NV)].map(() => new THREE.Vector4(0, -100, 0, 0.1))),   // VPL position (xyz) and radius (w)
    vn: uniformArray([...Array(NV)].map(() => new THREE.Vector4(0, 1, 0, 0))),         // VPL normal
    vc: uniformArray([...Array(NV)].map(() => new THREE.Vector4(0, 0, 0, 0))),         // VPL flux (rgb)
  };
}

/** Halo fog: atmospheric (linear from start to opaque distance, capped at max) + planar (view-ray length below the plane). */
function fogAmount(H, P) {
  const d = P.distance(cameraPosition);
  const atm = clamp(d.sub(H.fogStart).div(max(H.fogEnd.sub(H.fogStart), 1e-3)), 0, 1).mul(H.fogMax);
  const yc = cameraPosition.y, yp = P.y, lo = min(yc, yp), hi = max(yc, yp);
  const below = clamp(H.planeY.sub(lo).div(max(hi.sub(lo), 1e-4)), 0, 1).mul(d);   // the part of the ray under the plane
  const pl = clamp(below.div(max(H.planeDepth, 1e-3)), 0, 1).mul(H.planeMax);
  return float(1).sub(float(1).sub(atm).mul(float(1).sub(pl)));
}

/** The Halo CE version of bodyMaterial (same light model and arguments; see materials.js), plus the look's pieces. */
export function haloBodyMaterial(U, H, tex, { map = null, emissiveMap = null, ledRect = [2, 2, 2, 2], ov = null, scMul = 1, blMul = 1, rawLed = false }, objIndex = -1) {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  const lr = vec4(...ledRect);
  m.outputNode = Fn(() => {
    const v = uv();
    const c0 = map ? texture(map, v) : vec4(0.6);
    If(c0.a.lessThan(0.4), () => { Discard(); });
    const n = normalWorldGeometry, P = positionWorld;
    // multipurpose map, derived from the base texel: R reflection mask, G self-illumination, B detail mask
    const lum = dot(c0.rgb, vec3(0.299, 0.587, 0.114)), mx = max(c0.r, max(c0.g, c0.b)), mn = min(c0.r, min(c0.g, c0.b));
    const sat = mx.sub(mn).div(max(mx, 1e-3));
    const mR = smoothstep(0.35, 0.85, lum).mul(float(1).sub(sat.mul(0.85)));
    const em = emissiveMap ? texture(emissiveMap, v).rgb : null;
    const mG = em ? dot(em, vec3(0.333)) : smoothstep(0.82, 0.95, mx).mul(smoothstep(0.45, 0.75, sat));
    const mB = smoothstep(0.04, 0.25, lum).mul(float(1).sub(mR.mul(0.5)));
    // detail map: world-space triplanar, double-multiplied under the detail mask
    const w0 = pow(abs(n), vec3(4)), w = w0.div(w0.x.add(w0.y).add(w0.z).add(1e-4)), q = P.mul(H.detScale);
    const det = texture(tex.detail, q.yz).r.mul(w.x).add(texture(tex.detail, q.xz).r.mul(w.y)).add(texture(tex.detail, q.xy).r.mul(w.z));
    const c = c0.rgb.mul(mix(float(1), det.mul(2), mB.mul(H.detStr))).toVar();
    // the shot's light model (bodyMaterial), as a function of the point it is evaluated at
    const sc = scMul === 1 ? U.sc : U.sc.mul(scMul), bl = blMul === 1 ? U.bl : U.bl.mul(blMul), lp = rawLed ? U.lpRaw : U.lp;
    const direct = X => {
      const Lv = U.sp.sub(X), d = length(Lv), L = Lv.div(d);
      const lobe = clamp(dot(L.negate(), U.sn).mul(0.7).add(0.3), 0, 1);
      const face = max(dot(n, L).mul(0.85).add(0.15), 0).mul(lobe);
      const spill = face.mul(U.si).div(d.mul(d).mul(5).add(1));
      const fill = U.amb.mul(float(0.5).add(max(dot(n, normalize(vec3(-0.4, 0.8, 0.3))), 0).mul(0.5)));
      const Lb0 = U.bp.sub(X), db = length(Lb0), Lb = Lb0.div(max(db, 1e-5));
      const bnc = U.bi.mul(max(dot(n, Lb), 0)).div(db.mul(db).mul(1.5).add(1));
      const dl = lp.sub(X), dd = length(dl);
      const led = U.lc.mul(U.li).mul(0.9).mul(exp(dd.mul(dd).negate().div(U.lrad.mul(U.lrad))).mul(max(dot(n, dl.div(max(dd, 1e-5))), 0.25)));
      const rl = U.rp.sub(X), rd = length(rl);
      const ring = U.rc.mul(U.ri).mul(exp(rd.mul(rd).negate().div(U.rrad.mul(U.rrad))).mul(max(dot(n, rl.div(max(rd, 1e-5))), 0.2)));
      return vec3(fill).add(sc.mul(spill.add(bnc))).mul(bl).add(led).add(ring);
    };
    // lightmap feel: the light on a world lattice (a lightmap's texels), trilinear between the 8 corners
    const g = P.div(H.cell), g0 = floor(g), f = fract(g), cs = H.cell;
    const C = (i, j, k) => direct(g0.add(vec3(i, j, k)).mul(cs));
    const lx00 = mix(C(0, 0, 0), C(1, 0, 0), f.x), lx10 = mix(C(0, 1, 0), C(1, 1, 0), f.x), lx01 = mix(C(0, 0, 1), C(1, 0, 1), f.x), lx11 = mix(C(0, 1, 1), C(1, 1, 1), f.x);
    const grid = mix(mix(lx00, lx10, f.y), mix(lx01, lx11, f.y), f.z);
    const light = select(H.cell.greaterThan(0), grid, direct(P)).toVar();
    // colour bleed: one bounce from the placed objects' virtual point lights (not the object's own)
    for (let i = 0; i < NV; i++) {
      if (i === objIndex) continue;
      const vp = H.vp.element(i), vn = H.vn.element(i), vc = H.vc.element(i);
      const dv = P.sub(vp.xyz), d2 = dot(dv, dv), Ld = dv.div(d2.sqrt().max(1e-4));
      const ce = max(dot(vn.xyz, Ld).mul(0.8).add(0.2), 0), cr = max(dot(n, Ld.negate()).mul(0.8).add(0.2), 0);
      light.addAssign(vc.xyz.mul(ce.mul(cr).div(d2.add(vp.w.mul(vp.w))).mul(H.bleed).mul(1 / Math.PI)));
    }
    // research pass: a 16-bit lightmap (R5G6B5, Halo CE's lightmap bitmaps), the light quantised on the lattice's scale (0..2)
    If(H.lmBits.greaterThan(0.5), () => { const q = vec3(31, 63, 31).div(2); light.assign(floor(clamp(light, 0, 2).mul(q).add(0.5)).div(q)); });
    const col = c.mul(light).toVar();
    // the LED texel glows (as in bodyMaterial), emissive texture, derived self-illumination
    const inRect = v.x.greaterThan(lr.x).and(v.x.lessThan(lr.z)).and(v.y.greaterThan(lr.y)).and(v.y.lessThan(lr.w));
    const glow = float(0).toVar();
    If(inRect, () => { col.assign(mix(col, U.lc.mul(1.15).add(0.12), min(U.li, 1).mul(0.9))); glow.assign(min(U.li, 1).mul(0.9)); });
    if (em) { col.addAssign(em.mul(U.eStr)); glow.assign(max(glow, mG.mul(min(U.eStr, 1)).mul(0.35))); }
    else { col.addAssign(c.mul(mG).mul(H.si)); glow.assign(max(glow, mG.mul(min(H.si, 1)))); }
    // cubemap reflection under the mask, no fresnel; optionally dimmed where the light is low
    // research pass: a bumped cube map (the bump is the base map's luminance, through screen-space derivatives: the
    // surface-gradient method, no tangents needed) and Halo's perpendicular / parallel brightness
    const Vd = normalize(P.sub(cameraPosition));
    const dpx = dFdx(P), dpy = dFdy(P), r1 = cross(dpy, n), r2 = cross(n, dpx), dt = dot(dpx, r1);
    const hgt = lum.mul(H.bump.mul(0.01)), grad = r1.mul(dFdx(hgt)).add(r2.mul(dFdy(hgt))).mul(sign(dt));
    const nb = select(H.bump.greaterThan(0), normalize(n.mul(abs(dt)).sub(grad)), n);
    const env = cubeTexture(tex.cube, reflect(Vd, nb)).rgb;
    const fres = mix(H.perp, H.par, pow(float(1).sub(abs(dot(Vd, nb))), 2));
    const lit = mix(float(1), clamp(dot(light, vec3(0.333)), 0, 1), H.reflLit);
    col.addAssign(env.mul(mR).mul(H.refl).mul(lit).mul(fres));
    const out = ov ? mix(col, ov.xyz, ov.w) : col;
    if (ov) glow.assign(max(glow, ov.w));
    return vec4(mix(out, H.fogC, fogAmount(H, P)), glow);
  })();
  return m;
}

/** The CRT under the look: the same screen shader, fogged, with a faint cube reflection on the glass; glows by its colour. */
function haloCrtMaterial(crt, H, tex) {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide }), color = crt.userData.color;
  m.outputNode = Fn(() => {
    const P = positionWorld, n = normalWorldGeometry, c = color(uv()).rgb;
    const env = cubeTexture(tex.cube, reflect(normalize(P.sub(cameraPosition)), n)).rgb;
    const col = c.add(env.mul(0.06).mul(H.refl.mul(2)));
    return vec4(mix(col, H.fogC, fogAmount(H, P)), 1);
  })();
  m.mrtNode = crt.mrtNode; m.userData = crt.userData;
  return m;
}

/** The sky shell: fog colour (or the generic cube, fogged at the maximum density) where nothing else is drawn. */
function skyMaterial(H, tex) {
  const m = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: true });
  m.outputNode = Fn(() => {
    const d = normalize(positionWorld.sub(cameraPosition));
    const c = select(H.sky.greaterThan(0.5), cubeTexture(tex.cube, d).rgb, vec3(0));
    return vec4(mix(c, H.fogC, max(H.fogMax, H.planeMax)), 0);
  })();
  return m;
}

const quadMat = node => { const m = new THREE.NodeMaterial(); m.fragmentNode = node; m.depthTest = false; m.depthWrite = false; return m; };

/** Glow and flares: bright (finalRT rgb x glow mask -> a, quarter size), blur x (a -> b), blur y (b -> a), then the
 *  combine (finalRT + glow + flares -> out) and a copy back into finalRT, so the rest of the pipeline is unchanged. */
function makeHaloPost({ finalTex, distTex, aTex, bTex, outTex }) {
  const P = { srcPx: uniform(new THREE.Vector2(1 / 1920, 1 / 1080)), px: uniform(new THREE.Vector2(1 / 480, 1 / 270)), knee: uniform(0.45),
    glow: uniform(1), flares: uniform(1), aspect: uniform(16 / 9),
    fq: uniformArray([...Array(NF)].map(() => new THREE.Vector4(0, 0, 0, 0))),   // flare: final uv (xy), scene uv (zw)
    fc: uniformArray([...Array(NF)].map(() => new THREE.Vector4(0, 0, 0, 0))),   // colour (rgb), intensity (w)
    fd: uniformArray([...Array(NF)].map(() => new THREE.Vector4(0, 0, 0, 0))),   // light distance, size, occlusion radius (uv), ghosts
    fw: uniformArray([...Array(NF)].map(() => new THREE.Vector4(1, 1, 1, 0))),   // weights: core, star, streak
  };
  const fin = texture(finalTex), dist = texture(distTex), A = texture(aTex), B = texture(bTex), O = texture(outTex);
  const bright = Fn(() => {
    const q = uv(), acc = vec3(0).toVar();
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
      const c = fin.sample(q.add(P.srcPx.mul(vec2(i - 1.5, j - 1.5)))).level(0);
      acc.addAssign(max(c.rgb.mul(c.a).sub(P.knee), vec3(0)).div(float(1).sub(P.knee)));
    }
    return vec4(acc.div(16), 1);
  })();
  const W = [0.1585, 0.1465, 0.1157, 0.0782, 0.0452, 0.0224, 0.0095];
  const blur = (T, dir) => Fn(() => {
    const q = uv(), acc = T.sample(q).level(0).rgb.mul(W[0]).toVar();
    for (let i = 1; i < W.length; i++) { const o = P.px.mul(dir).mul(i); acc.addAssign(T.sample(q.add(o)).level(0).rgb.add(T.sample(q.sub(o)).level(0).rgb).mul(W[i])); }
    return vec4(acc.div(0.9935), 1);
  })();
  // distance at a scene uv (0 = nothing drawn: far away)
  const D = s => { const z = dist.sample(s).level(0), r = z.r.div(max(z.g, 1)); return select(r.lessThanEqual(0), float(1e4), r); };
  const combine = Fn(() => {
    const q = uv(), base = fin.sample(q).level(0).rgb, gl = A.sample(q).level(0).rgb;
    const fl = vec3(0).toVar();
    for (let i = 0; i < NF; i++) {
      const fq = P.fq.element(i), fc = P.fc.element(i), fd = P.fd.element(i), fw = P.fw.element(i);
      // occlusion: 5 taps of the distance buffer around the light, against the light's own distance
      const tol = fd.x.mul(0.03).add(0.01), r = fd.z;
      let vis = float(0);
      for (const [x, y] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) vis = vis.add(select(D(fq.zw.add(vec2(x, y).mul(r))).greaterThan(fd.x.sub(tol)), float(0.2), float(0)));
      const k = fc.w.mul(vis).mul(P.flares);
      const p = q.sub(fq.xy).mul(vec2(P.aspect, 1)), rr = length(p), s = fd.y;
      const core = exp(rr.div(s.mul(0.25)).pow(2).negate()).mul(1.2).add(exp(rr.div(s).negate().mul(3)).mul(0.35));
      const a = atan(p.y, p.x), star = pow(abs(cos(a.mul(3))), float(60)).mul(exp(rr.div(s.mul(1.4)).negate().mul(2.5))).mul(0.8);
      const streak = exp(abs(p.y).div(s.mul(0.03)).negate()).mul(exp(abs(p.x).div(s.mul(5)).negate())).mul(0.5);
      const sprite = fc.xyz.mul(core.mul(fw.x).add(star.mul(fw.y))).add(vec3(0.55, 0.7, 1).mul(streak.mul(fw.z)).mul(fc.xyz.add(0.5)));
      // ghosts: soft hexagons along the line from the light through the frame centre (Halo's sun flares)
      const ghost = vec3(0).toVar();
      for (const [t, sz, tint] of [[-0.35, 0.6, [0.5, 0.8, 1]], [-0.75, 1.1, [0.9, 0.7, 0.4]], [-1.25, 0.45, [0.6, 1, 0.7]]]) {
        const gc = vec2(0.5).add(fq.xy.sub(0.5).mul(t)), gp = q.sub(gc).mul(vec2(P.aspect, 1)), ax = abs(gp.x), ay = abs(gp.y);
        const hex = max(ax.mul(0.866).add(ay.mul(0.5)), ay), gs = s.mul(sz);
        ghost.addAssign(vec3(...tint).mul(smoothstep(gs, gs.mul(0.8), hex).mul(0.06).add(smoothstep(gs, gs.mul(0.95), hex).mul(0.05))));
      }
      fl.addAssign(sprite.add(ghost.mul(fd.w)).mul(k));
    }
    return vec4(base.add(gl.mul(P.glow)).add(fl), 1);
  })();
  const copy = Fn(() => vec4(O.sample(uv()).level(0).rgb, 1))();
  const Q = n => new THREE.QuadMesh(quadMat(n));
  return { U: P, quads: { bright: Q(bright), blurX: Q(blur(A, vec2(1, 0))), blurY: Q(blur(B, vec2(0, 1))), combine: Q(combine), copy: Q(copy) } };
}

/** The look on a host renderer. host: { renderer, U (light uniforms), scene, camera, sceneRT (colour + distance MRT),
 *  finalRT, bodyMeshes: [{ mesh, args (bodyMaterial's), obj }], crt? (the screen mesh's material), mark? (GPU timing) }. */
export class HaloCE {
  constructor(host) {
    this.host = host; this.H = makeHaloUniforms(); this.tex = { cube: makeGenericCube(64), detail: makeDetailMap(256) };
    this.mats = new Map(); this.maps = new Map(); this.objIndex = new Map(); this.on = false; this.dirty = true;
    const rt = (w, h) => new THREE.RenderTarget(w, h, { depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.UnsignedByteType });
    this.gA = rt(480, 270); this.gB = rt(480, 270); this.outRT = rt(1920, 1080);
    this.post = makeHaloPost({ finalTex: host.finalRT.texture, distTex: host.sceneRT.textures[1], aTex: this.gA.texture, bTex: this.gB.texture, outTex: this.outRT.texture });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), skyMaterial(this.H, this.tex)); this.sky.frustumCulled = false; this.sky.renderOrder = -1;
    this.flares = [];
  }

  /** Turn the look on (settings, merged over HALO_LOOK) or off (null): swaps the materials and the sky shell. */
  set(look) {
    const host = this.host, on = !!look;
    this.look = on ? { ...HALO_LOOK, ...look, detail: { ...HALO_LOOK.detail, ...look.detail }, reflect: { ...HALO_LOOK.reflect, ...look.reflect },
      lightmap: { ...HALO_LOOK.lightmap, ...look.lightmap }, fog: { ...HALO_LOOK.fog, ...look.fog } } : null;
    if (on) {
      const L = this.look, H = this.H;
      H.detScale.value = L.detail.scale; H.detStr.value = L.detail.strength; H.refl.value = L.reflect.strength; H.reflLit.value = L.reflect.lit;
      H.si.value = L.selfIllum; H.cell.value = L.lightmap.cell; H.bleed.value = L.lightmap.bleed;
      H.perp.value = L.reflect.perp ?? 1; H.par.value = L.reflect.par ?? 1; H.bump.value = L.reflect.bump ?? 0; H.lmBits.value = L.lightmap.bits ?? 0;
      const F = L.fog; H.fogC.value.set(...F.color); H.fogStart.value = F.start; H.fogEnd.value = F.opaque; H.fogMax.value = F.max;
      H.planeY.value = F.planeY ?? -1e3; H.planeDepth.value = F.planeDepth ?? 1; H.planeMax.value = F.planeMax ?? 0; H.sky.value = L.sky === 'cube' ? 1 : 0;
      this.post.U.glow.value = L.glow; this.post.U.flares.value = L.flares;
    }
    for (const b of host.bodyMeshes) {
      if (!b.base) b.base = b.mesh.material;
      if (on && !this.objIndex.has(b.obj)) this.objIndex.set(b.obj, this.objIndex.size);
      b.mesh.material = on ? this.material(b) : b.base;
    }
    if (host.crtMesh) { host.crtMesh.material = on ? (this.crtMat ||= haloCrtMaterial(host.crtBase, this.H, this.tex)) : host.crtBase; }
    if (on && !this.sky.parent) host.scene.add(this.sky); if (!on && this.sky.parent) this.sky.parent.remove(this.sky);
    this.on = on; this.dirty = true;
  }

  /** A mesh's Halo material (cached): base maps re-filtered trilinear + anisotropic, like a 2001 PC game. */
  material(b) {
    let m = this.mats.get(b.mesh); if (m) return m;
    const filt = t => { if (!t) return t; let c = this.maps.get(t); if (c) return c;
      c = t.clone(); Object.assign(c, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, anisotropy: 8, needsUpdate: true });
      this.maps.set(t, c); return c; };
    const oi = this.objIndex.get(b.obj);
    m = haloBodyMaterial(this.host.U, this.H, this.tex, { ...b.args, map: filt(b.args.map), emissiveMap: filt(b.args.emissiveMap) }, oi < NV ? oi : -1);
    this.mats.set(b.mesh, m); return m;
  }

  /** The colour-bleed bake: per placed object, the area x albedo x irradiance of its surfaces (screen spill and ambient
   *  fill, without their per-frame gains) and where it comes from: one virtual point light each, re-gained every frame. */
  bakeBleed() {
    const U = this.host.U, sp = U.sp.value.toArray(), sn = U.sn.value.toArray(), fillDir = normalize3([-0.4, 0.8, 0.3]), objs = new Map();
    const pix = new Map();
    const albedoAt = (t, u, v) => {   // the base map at a uv (wrapped), from a 64 px copy
      if (!t || !t.image) return [0.6, 0.6, 0.6];
      let p = pix.get(t); if (!p) { const S = 64, cv = new OffscreenCanvas(S, S), cx = cv.getContext('2d'); cx.drawImage(t.image, 0, 0, S, S); p = { S, d: cx.getImageData(0, 0, S, S).data }; pix.set(t, p); }
      const x = ((Math.floor(u * p.S) % p.S) + p.S) % p.S, y = ((Math.floor(v * p.S) % p.S) + p.S) % p.S, o = (y * p.S + x) * 4;   // glTF uv: v down, flipY false
      return [p.d[o] / 255, p.d[o + 1] / 255, p.d[o + 2] / 255];
    };
    for (const b of this.host.bodyMeshes) {
      const g = b.mesh.geometry, pos = g.attributes.position, uvA = g.attributes.uv, idx = g.index, M = b.mesh.matrixWorld;
      const o = objs.get(b.obj) || { gs: [0, 0, 0], ga: [0, 0, 0], ps: [0, 0, 0], ns: [0, 0, 0], w: 0, area: 0 }; objs.set(b.obj, o);
      const tri = idx ? idx.count / 3 : pos.count / 3, V = i => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(M);
      for (let t = 0; t < tri; t++) {
        const [i0, i1, i2] = [0, 1, 2].map(k => idx ? idx.getX(t * 3 + k) : t * 3 + k), a = V(i0), bb = V(i1), c = V(i2);
        const cr = new THREE.Vector3().subVectors(bb, a).cross(new THREE.Vector3().subVectors(c, a)), area = cr.length() / 2; if (area < 1e-9) continue;
        const n = cr.normalize().toArray(), ctr = [(a.x + bb.x + c.x) / 3, (a.y + bb.y + c.y) / 3, (a.z + bb.z + c.z) / 3];
        const al = uvA ? albedoAt(b.args.map, (uvA.getX(i0) + uvA.getX(i1) + uvA.getX(i2)) / 3, (uvA.getY(i0) + uvA.getY(i1) + uvA.getY(i2)) / 3) : [0.6, 0.6, 0.6];
        // two-sided (the materials are DoubleSide): face the light
        const Lv = sub3(sp, ctr), d = Math.hypot(...Lv), L = scl3(Lv, 1 / d), nn = dot3(n, L) < 0 ? scl3(n, -1) : n;
        const lobe = Math.min(1, Math.max(0, -dot3(L, sn) * 0.7 + 0.3)), spill = Math.max(dot3(nn, L) * 0.85 + 0.15, 0) * lobe / (d * d * 5 + 1);
        const fill = 0.5 + 0.5 * Math.max(dot3(nn, fillDir), 0), wgt = area * (spill + 0.05);
        for (let k = 0; k < 3; k++) { o.gs[k] += area * al[k] * spill; o.ga[k] += area * al[k] * fill; o.ps[k] += ctr[k] * wgt; o.ns[k] += nn[k] * wgt; }
        o.w += wgt; o.area += area;
      }
    }
    this.vpl = [...objs.entries()].map(([obj, o]) => ({ obj, i: this.objIndex.get(obj), gs: o.gs, ga: o.ga, p: scl3(o.ps, 1 / o.w), n: normalize3(o.ns), r: Math.sqrt(o.area / Math.PI) }));   // r: a disc of the same area, so the bleed at d = 0 is the radiosity
    this.dirty = false;
  }

  /** Per frame, before the scene pass: the colour-bleed lights (re-gained by this frame's light levels), the sky shell. */
  preScene() {
    if (!this.on) return;
    if (this.dirty) this.bakeBleed();
    const U = this.host.U, H = this.H, sc = U.sc.value, si = U.si.value, amb = U.amb.value, bl = U.bl.value;
    for (let i = 0; i < NV; i++) { H.vc.array[i].set(0, 0, 0, 0); H.vp.array[i].set(0, -100, 0, 0.1); }
    for (const v of this.vpl) { if (v.i >= NV) continue;
      H.vp.array[v.i].set(...v.p, v.r); H.vn.array[v.i].set(...v.n, 0);
      H.vc.array[v.i].set(...[0, 1, 2].map(k => (v.gs[k] * si * [sc.x, sc.y, sc.z][k] + v.ga[k] * amb) * bl), 0); }
    const cam = this.host.camera; this.sky.position.copy(cam.position); this.sky.scale.setScalar(cam.far * 0.9); this.sky.updateMatrixWorld(true);
  }

  /** After the frame is in finalRT (post lens and depth of field): glow and flares, written back into finalRT.
   *  lights: [{ pos: [x,y,z], color: [r,g,b], intensity, size (fraction of frame height), ghosts (0..1) }]; k: lens warp. */
  postFrame({ lights = [], k = 0 } = {}) {
    if (!this.on) return;
    const host = this.host, r = host.renderer, F = host.finalRT, Pu = this.post.U, mark = n => host.mark && host.mark(n);
    const w = F.width, h = F.height, gw = Math.max(1, Math.ceil(w / 4)), gh = Math.max(1, Math.ceil(h / 4));
    if (this.outRT.width !== w || this.outRT.height !== h) this.outRT.setSize(w, h);
    if (this.gA.width !== gw || this.gA.height !== gh) { this.gA.setSize(gw, gh); this.gB.setSize(gw, gh); }
    Pu.srcPx.value.set(1 / w, 1 / h); Pu.px.value.set(1 / gw, 1 / gh); Pu.aspect.value = w / h;
    // flares: project each light (scene uv), then through the lens warp's inverse (final uv)
    const cam = host.camera, aspect = w / h, flares = this.look.flares > 0 ? lights.slice(0, NF) : [];
    for (let i = 0; i < NF; i++) { Pu.fc.array[i].set(0, 0, 0, 0); Pu.fq.array[i].set(-9, -9, -9, -9); }
    flares.forEach((L, i) => {
      const v = new THREE.Vector3(...L.pos).project(cam); if (v.z > 1 || v.z < -1) return;
      const s = [v.x * 0.5 + 0.5, 0.5 - v.y * 0.5], q = unwarp(s, k, aspect);
      Pu.fq.array[i].set(q[0], q[1], s[0], s[1]); Pu.fc.array[i].set(...L.color, L.intensity);
      Pu.fd.array[i].set(cam.position.distanceTo(new THREE.Vector3(...L.pos)), L.size ?? 0.05, 1.5 / h, L.ghosts ?? 1);
      Pu.fw.array[i].set(...(L.weights || [1, 1, 1]), 0);
    });
    const Q = this.post.quads;
    if (this.look.glow > 0) { mark('halo glow bright'); r.setRenderTarget(this.gA); Q.bright.render(r); mark('halo glow blur x'); r.setRenderTarget(this.gB); Q.blurX.render(r);
      mark('halo glow blur y'); r.setRenderTarget(this.gA); Q.blurY.render(r); }
    else { r.setRenderTarget(this.gA); r.clear(); }
    mark('halo glow + flares'); r.setRenderTarget(this.outRT); Q.combine.render(r);
    mark('halo copy'); r.setRenderTarget(F); Q.copy.render(r);
  }
}

/** The shot's light sources as flares: the power LED, the ringing remote's LEDs, and the CRT (a faint wide streak). */
export function shotFlares(st, ix) {
  const g = ix.glass, out = [], led = st.led, R = st.ring;
  if (led && led.intensity > 0) out.push({ pos: add3(led.pos, scl3(led.n, g.W * 0.006)), color: led.color, intensity: Math.min(led.intensity, 1) * 0.55, size: 0.022, ghosts: 0.6 });
  if (R && R.lvl > 0.01) R.leds.forEach(p => out.push({ pos: p, color: R.col, intensity: R.lvl * 0.35, size: 0.016, ghosts: 0.25 }));
  // the screen is an area light: no core or star, a wide faint streak and ghosts
  if (st.revealK > 0) out.push({ pos: add3(g.ctr, scl3(g.n, 0.01)), color: st.glowCol, intensity: 0.15 * st.revealK, size: 0.12, ghosts: 0.5, weights: [0, 0, 1] });
  return out;
}

/** Final (lens-warped) uv whose warp lands on scene uv s (fixed-point inverse of the lens warp in post.js). */
function unwarp(s, k, aspect) {
  if (!(k > 1e-4)) return s;
  const warp = q => { const p0 = [q[0] * 2 - 1, q[1] * 2 - 1], p = [p0[0] * aspect, p0[1]], r2 = p[0] * p[0] + p[1] * p[1], f = (1 + k * r2) / (1 + k * (aspect * aspect + 1));
    return [p[0] * f / aspect * 0.5 + 0.5, p[1] * f * 0.5 + 0.5]; };
  let q = [...s]; for (let i = 0; i < 20; i++) { const w = warp(q); q = [q[0] + (s[0] - w[0]), q[1] + (s[1] - w[1])]; }
  return q;
}

const add3 = (a, b) => a.map((v, i) => v + b[i]), sub3 = (a, b) => a.map((v, i) => v - b[i]), scl3 = (a, s) => a.map(v => v * s);
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], lerp3 = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
function normalize3(a) { const l = Math.hypot(...a) || 1; return a.map(v => v / l); }
