// Shadows from the CRT (research, behind Show-menu toggles; off by default).
//
// The screen is an area light, so one shadow map can't give its soft shadows. The glass is split into KX x KY patches
// and each patch gets a distance map rendered from its centre (a 150° perspective view along the glass normal), side
// by side in one atlas row. A point x is lit by patch k when nothing in map k is nearer than x along that direction.
//   - Haze light shafts: the haze march's light grid (20x15 cells) weights each cell by its patch's visibility.
//   - Soft surface shadows: the surfaces' screen light is scaled by the visibility averaged over all patches (2x2 PCF
//     each), which gives a penumbra that widens with distance from the occluder, as an area light's does.
// The maps hold Euclidean distance from the patch centre (half float). Points outside a map's field of view count as
// lit; points behind the glass get no screen light anyway.
import * as THREE from 'three/webgpu';
import { texture, vec2, vec3, vec4, float, max, dot, length, select, step, positionWorld, cameraPosition, uniform } from 'three/tsl';

export const SHADOW_DEFAULTS = { patches: [4, 3], size: 512, fov: 150, offset: 0.004, bias: 0.006, biasSlope: 0.01 };

export function makeScreenShadows(opts = {}) {
  const O = { ...SHADOW_DEFAULTS, ...opts }, [KX, KY] = O.patches, K = KX * KY, S = O.size;
  const atlas = new THREE.RenderTarget(S * K, S, { depthBuffer: true, generateMipmaps: false, type: THREE.HalfFloatType, format: THREE.RedFormat,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const cam = new THREE.PerspectiveCamera(O.fov, 1, 0.003, 10);
  const distMat = new THREE.NodeMaterial(); distMat.side = THREE.DoubleSide; distMat.blending = THREE.NoBlending;   // the target has no alpha
  distMat.fragmentNode = vec4(positionWorld.distance(cameraPosition), 0, 0, 1);
  const U = {
    o00: uniform(new THREE.Vector3()), du: uniform(new THREE.Vector3()), dv: uniform(new THREE.Vector3()),
    n: uniform(new THREE.Vector3()), X: uniform(new THREE.Vector3()), Y: uniform(new THREE.Vector3()),
    tan: uniform(Math.tan(O.fov * Math.PI / 360)), bias: uniform(O.bias), biasSlope: uniform(O.biasSlope),
    shafts: uniform(0), surface: uniform(0),
  };
  const far = new THREE.Color(1000, 0, 0);
  let key = '';

  /** Render the K maps (skipped when nothing that casts has moved). gm: the glass uv->world fit; n: glass normal;
   *  hide: meshes that must not cast (the screen itself, additive glows); casters: the placed roots (for the key). */
  function update(r, scene, { gm, n, hide, casters, mark = () => {} }) {
    const k = casters.map(c => c.visible ? c.matrixWorld.elements.join(',') : 'h').join('|') + gm.p00.join(',');
    if (k === key) return false; key = k;
    const N = new THREE.Vector3(...n).normalize(), up = new THREE.Vector3(...gm.ev).normalize().negate();   // glass v runs down
    const p00 = new THREE.Vector3(...gm.p00), eu = new THREE.Vector3(...gm.eu), ev = new THREE.Vector3(...gm.ev);
    U.du.value.copy(eu).multiplyScalar(1 / KX); U.dv.value.copy(ev).multiplyScalar(1 / KY);
    U.o00.value.copy(p00).addScaledVector(U.du.value, 0.5).addScaledVector(U.dv.value, 0.5).addScaledVector(N, O.offset);
    cam.up.copy(up);
    const vis = hide.map(m => m.visible); hide.forEach(m => { m.visible = false; });
    const prevOverride = scene.overrideMaterial, ac = r.autoClear, cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    scene.overrideMaterial = distMat;
    r.setRenderTarget(atlas); atlas.viewport.set(0, 0, S * K, S); r.setClearColor(far, 1); r.clear(); r.autoClear = false;
    for (let j = 0; j < KY; j++) for (let i = 0; i < KX; i++) {
      cam.position.copy(U.o00.value).addScaledVector(U.du.value, i).addScaledVector(U.dv.value, j);
      cam.lookAt(cam.position.clone().add(N)); cam.updateMatrixWorld(true);
      atlas.viewport.set((j * KX + i) * S, 0, S, S);
      mark(`shadow map ${j * KX + i + 1}/${K}`); r.render(scene, cam);
    }
    atlas.viewport.set(0, 0, S * K, S);
    // the view basis every patch shares (three's lookAt: z = -forward, x = up x z, y = z x x)
    const z = N.clone().negate(), X = new THREE.Vector3().crossVectors(up, z).normalize(), Y = new THREE.Vector3().crossVectors(z, X);
    U.n.value.copy(N); U.X.value.copy(X); U.Y.value.copy(Y);
    r.autoClear = ac; r.setClearColor(cc, ca); scene.overrideMaterial = prevOverride; hide.forEach((m, i) => { m.visible = vis[i]; });
    return true;
  }

  /** Patch of light-grid cell (ci, cj) of a gx x gy grid. */
  const patchOf = (ci, cj, gx, gy) => [Math.min(KX - 1, Math.floor((ci + 0.5) * KX / gx)), Math.min(KY - 1, Math.floor((cj + 0.5) * KY / gy))];
  // Node builders, for use inside one material's graph: nodes() gives each material its own texture node. A texture
  // node shared between materials can bind to another material's texture slot (here the atlas replaced the
  // surfaces' colour maps); see also LEARNINGS section 6 on sharing Fns between materials.
  const nodes = () => {
  const tex = texture(atlas.texture);
  /** Visibility (0..1) of patch (i, j) from world point x. pcf: 2x2 taps one texel apart. */
  const patchVis = (x, i, j, { pcf = false, bias = null } = {}) => {
    const o = U.o00.add(U.du.mul(i)).add(U.dv.mul(j)), d = x.sub(o), dist = length(d);
    const lz = dot(d, U.n), inv = float(1).div(max(lz, 1e-5).mul(U.tan));
    const u = dot(d, U.X).mul(inv).mul(0.5).add(0.5), v = float(0.5).sub(dot(d, U.Y).mul(inv).mul(0.5));
    const inside = lz.greaterThan(0).and(u.greaterThan(0)).and(u.lessThan(1)).and(v.greaterThan(0)).and(v.lessThan(1));
    const k = j * KX + i, ref = dist.sub(bias ?? U.bias.add(dist.mul(U.biasSlope)));
    const at = (du, dv) => step(ref, tex.sample(vec2(u.add(k).div(K).add(du / (S * K)), v.add(dv / S))).level(0).r);
    const s = pcf ? at(-0.5, -0.5).add(at(0.5, -0.5)).add(at(-0.5, 0.5)).add(at(0.5, 0.5)).mul(0.25) : at(0, 0);
    return select(inside, s, float(1));
  };
  /** Mean visibility of the whole screen from x (soft surface shadows). */
  const screenVis = (x, opts) => {
    let s = null;
    for (let j = 0; j < KY; j++) for (let i = 0; i < KX; i++) { const v = patchVis(x, i, j, opts); s = s ? s.add(v) : v; }
    return s.div(K);
  };
  return { patchVis, screenVis };
  };
  return { U, O, KX, KY, atlas, update, nodes, patchOf, invalidate: () => { key = ''; } };
}

// Shadows from a point light (the ringing remote's red light): a distance cube, six 90° faces side by side in one row.
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(f => {
  const F = new THREE.Vector3(...f), up = Math.abs(f[1]) ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const z = F.clone().negate(), X = new THREE.Vector3().crossVectors(up, z).normalize(), Y = new THREE.Vector3().crossVectors(z, X);
  return { F, up, X, Y };
});

export function makePointShadows(opts = {}) {
  const O = { size: 512, bias: 0.004, biasSlope: 0.01, ...opts }, S = O.size;
  const atlas = new THREE.RenderTarget(S * 6, S, { depthBuffer: true, generateMipmaps: false, type: THREE.HalfFloatType, format: THREE.RedFormat,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const cam = new THREE.PerspectiveCamera(90, 1, 0.002, 10);
  const distMat = new THREE.NodeMaterial(); distMat.side = THREE.DoubleSide; distMat.blending = THREE.NoBlending;
  distMat.fragmentNode = vec4(positionWorld.distance(cameraPosition), 0, 0, 1);
  const U = { pos: uniform(new THREE.Vector3()), bias: uniform(O.bias), biasSlope: uniform(O.biasSlope), shafts: uniform(0), surface: uniform(0) };
  const far = new THREE.Color(1000, 0, 0);
  let key = '';

  function update(r, scene, { pos, hide, casters, mark = () => {} }) {
    const k = casters.map(c => c.visible ? c.matrixWorld.elements.join(',') : 'h').join('|') + pos.join(',');
    if (k === key) return false; key = k;
    U.pos.value.set(...pos);
    const vis = hide.map(m => m.visible); hide.forEach(m => { m.visible = false; });
    const prevOverride = scene.overrideMaterial, ac = r.autoClear, cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    scene.overrideMaterial = distMat;
    r.setRenderTarget(atlas); atlas.viewport.set(0, 0, S * 6, S); r.setClearColor(far, 1); r.clear(); r.autoClear = false;
    FACES.forEach((f, i) => {
      cam.position.copy(U.pos.value); cam.up.copy(f.up); cam.lookAt(cam.position.clone().add(f.F)); cam.updateMatrixWorld(true);
      atlas.viewport.set(i * S, 0, S, S); mark(`ring shadow ${i + 1}/6`); r.render(scene, cam);
    });
    atlas.viewport.set(0, 0, S * 6, S);
    r.autoClear = ac; r.setClearColor(cc, ca); scene.overrideMaterial = prevOverride; hide.forEach((m, i) => { m.visible = vis[i]; });
    return true;
  }

  const nodes = () => {
    const tex = texture(atlas.texture);
    /** Visibility (0..1) of the light from world point x. pcf: 2x2 taps one texel apart. */
    const vis = (x, { pcf = false } = {}) => {
      const d = x.sub(U.pos), dist = length(d), a = d.abs();
      const isX = a.x.greaterThanEqual(a.y).and(a.x.greaterThanEqual(a.z)), isY = isX.not().and(a.y.greaterThanEqual(a.z));
      const pick = (sel, fx, fy, fz) => select(isX, select(d.x.greaterThan(0), fx[0], fx[1]), select(isY, select(d.y.greaterThan(0), fy[0], fy[1]), select(d.z.greaterThan(0), fz[0], fz[1])));
      const v3 = w => vec3(w.x, w.y, w.z);
      const F = pick(0, [v3(FACES[0].F), v3(FACES[1].F)], [v3(FACES[2].F), v3(FACES[3].F)], [v3(FACES[4].F), v3(FACES[5].F)]);
      const X = pick(0, [v3(FACES[0].X), v3(FACES[1].X)], [v3(FACES[2].X), v3(FACES[3].X)], [v3(FACES[4].X), v3(FACES[5].X)]);
      const Y = pick(0, [v3(FACES[0].Y), v3(FACES[1].Y)], [v3(FACES[2].Y), v3(FACES[3].Y)], [v3(FACES[4].Y), v3(FACES[5].Y)]);
      const k = pick(0, [float(0), float(1)], [float(2), float(3)], [float(4), float(5)]);
      const inv = float(1).div(max(dot(d, F), 1e-6));
      const lim = 1 - 1 / S;   // keep the PCF taps inside the face
      const u = dot(d, X).mul(inv).clamp(-lim, lim).mul(0.5).add(0.5), v = float(0.5).sub(dot(d, Y).mul(inv).clamp(-lim, lim).mul(0.5));
      const ref = dist.sub(U.bias.add(dist.mul(U.biasSlope)));
      const at = (du, dv) => step(ref, tex.sample(vec2(u.add(k).div(6).add(du / (S * 6)), v.add(dv / S))).level(0).r);
      return pcf ? at(-0.5, -0.5).add(at(0.5, -0.5)).add(at(-0.5, 0.5)).add(at(0.5, 0.5)).mul(0.25) : at(0, 0);
    };
    return { vis };
  };
  return { U, O, atlas, update, nodes, invalidate: () => { key = ''; } };
}
