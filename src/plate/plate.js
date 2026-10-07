// Screenshot to shot (spike): one still -> estimated depth -> a two-layer displaced mesh in three.js, a camera matched to
// the floor plane the depth implies, a prop dropped onto that floor with a shadow catcher, and camera moves rendered out.
//
// Pipeline (all in the page):
//  1. Depth Anything v2 small gives relative inverse depth (disparity) with an unknown scale and shift.
//  2. Inverse depth = 1/far + d' (1 - 1/far), d' the disparity normalised between its 1st and 99th percentiles, near = 1.
//     `ratio` = far / near is the unknown shift. A plane stays a plane under any shift (inverse depth of a plane is affine
//     in the image, and so is the model's output), so one plane can't pin it; two planes that should be perpendicular
//     (floor and wall) can: ratio=auto picks the one that makes them closest to 90°.
//  3. Points come from the pinhole camera of vertical FOV `fov` (an input: one image can't give it).
//  4. Floor = RANSAC plane facing up in the image; it gives the camera's height, pitch and roll. `height` sets the scale.
//  5. Foreground mesh: a vertex every `step` pixels, cells dropped where inverse depth changes faster than `edge` per pixel
//     (depth edges, the stretched rubber sheet). Background mesh behind it: near edges, the depth of the farthest thing
//     within `band` cells and the colour push-pull inpainted from the far side, so revealed areas show plausible fill.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { estimateDisparity } from './depth.js';

const $ = id => document.getElementById(id);
const P = new URLSearchParams(location.search);
if (P.has('bg')) window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 4);
const num = (k, d) => P.has(k) ? +P.get(k) : d;
const OPT = {
  img: P.get('img') || '/bp-final-ref/f00720.png',
  fov: num('fov', 50),                  // vertical FOV of the game camera, degrees
  ratio: P.get('ratio') || 'auto',      // far / near of the normalised disparity range, or auto (floor ⟂ wall)
  height: num('height', 1.6),           // camera height above the floor, metres (sets the scale)
  step: num('step', 0),                 // pixels per mesh cell (0: about 960 cells across)
  edge: num('edge', 0.03),              // depth edge: relative inverse-depth change per image pixel
  pitch: P.has('pitch') ? +P.get('pitch') : null,   // known camera pitch (down, degrees): picks the shift whose floor matches
  floor: (P.get('floor') || '0,0.5,1,1').split(',').map(Number),   // image rect (fractions) the floor is searched in; keep UI out
  grid: num('grid', 0),
  zoom: num('zoom', 1),                 // overscan: >1 crops in so camera moves don't reveal the plate's edges
  hud: (P.get('hud') || '').split(';').filter(Boolean).map(r => r.split(',').map(Number)),   // screen-locked rects (HUD, subtitles): cut out of the plate, drawn on top                 // debug: a floor grid of this cell size (metres) over the plate
  band: num('band', 12),                // background layer reach behind an edge, cells
  prop: P.get('prop') || '/wii/Wii_Remote_LowPoly.glb',
  propSize: num('propsize', 0.148),     // metres along the prop's longest side
  at: (P.get('at') || '0.5,0.8').split(',').map(Number),   // where the prop sits, image fractions (x, y down)
  yaw: num('yaw', 30),
  sun: (P.get('sun') || '40,55').split(',').map(Number),   // key light azimuth, elevation (degrees, floor frame)
  key: num('key', 8), fill: num('fill', 3),   // three's lights are physical: Lambert divides by pi
};

// ---------------------------------------------------------------- small math
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function percentile(arr, q) { const s = Float32Array.from(arr.filter((_, i) => i % 7 === 0)).sort(); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }
/** Smallest-eigenvalue eigenvector of a symmetric 3x3 (Jacobi). */
function smallestEig(C) {
  const a = C.map(r => r.slice()), V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 20; sweep++) for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
    if (Math.abs(a[p][q]) < 1e-15) continue;
    const th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(th), s = Math.sin(th);
    for (let k = 0; k < 3; k++) { const x = a[k][p], y = a[k][q]; a[k][p] = c * x - s * y; a[k][q] = s * x + c * y; }
    for (let k = 0; k < 3; k++) { const x = a[p][k], y = a[q][k]; a[p][k] = c * x - s * y; a[q][k] = s * x + c * y; }
    for (let k = 0; k < 3; k++) { const x = V[k][p], y = V[k][q]; V[k][p] = c * x - s * y; V[k][q] = s * x + c * y; }
  }
  const i = [0, 1, 2].reduce((b, k) => a[k][k] < a[b][b] ? k : b, 0);
  return v3(V[0][i], V[1][i], V[2][i]).normalize();
}

// ---------------------------------------------------------------- the plate
class Plate {
  constructor(rgba, W, H, disp) { Object.assign(this, { rgba, W, H, disp }); }

  /** Grid of normalised disparity, one sample per vertex. */
  grid(step) {
    const { W, H, disp } = this, GW = Math.floor(W / step) + 1, GH = Math.floor(H / step) + 1;
    const lo = percentile(disp.data, 0.01), hi = percentile(disp.data, 0.99), sx = disp.w / W, sy = disp.h / H;
    const dn = new Float32Array(GW * GH);
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
      const x = Math.min(disp.w - 1, Math.max(0, (i * step) * sx - 0.5)), y = Math.min(disp.h - 1, Math.max(0, (j * step) * sy - 0.5));
      const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(disp.w - 1, x0 + 1), y1 = Math.min(disp.h - 1, y0 + 1), fx = x - x0, fy = y - y0, D = disp.data;
      const v = (D[y0 * disp.w + x0] * (1 - fx) + D[y0 * disp.w + x1] * fx) * (1 - fy) + (D[y1 * disp.w + x0] * (1 - fx) + D[y1 * disp.w + x1] * fx) * fy;
      dn[j * GW + i] = (v - lo) / (hi - lo);
    }
    Object.assign(this, { GW, GH, step, dn });
  }
  invDepth(ratio) {
    const iz = new Float32Array(this.dn.length), a = ratio === Infinity ? 0 : 1 / ratio;
    for (let k = 0; k < iz.length; k++) iz[k] = Math.max(1e-3, a + this.dn[k] * (1 - a));
    return iz;
  }
  /** Camera-space points (three's convention: x right, y up, looking down -z) for inverse depth iz. */
  points(iz, fov, zScale = 1) {
    const { GW, GH, step, W, H } = this, f = (H / 2) / Math.tan(fov * Math.PI / 360), pos = new Float32Array(GW * GH * 3);
    for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
      const k = j * GW + i, z = zScale / iz[k];
      pos[k * 3] = (i * step - W / 2) / f * z; pos[k * 3 + 1] = -(j * step - H / 2) / f * z; pos[k * 3 + 2] = -z;
    }
    return pos;
  }
}

/** RANSAC plane through camera-space points. accept(n) filters normals. Plane: n·p + c = 0, c > 0 (camera on the + side). */
function ransacPlane(pos, idx, accept, { iters = 600, tol = 0.012, seed = 7 } = {}) {
  const r = rng(seed), p = k => v3(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]);
  let best = null;
  for (let it = 0; it < iters; it++) {
    const a = p(idx[Math.floor(r() * idx.length)]), b = p(idx[Math.floor(r() * idx.length)]), c3 = p(idx[Math.floor(r() * idx.length)]);
    const n = b.clone().sub(a).cross(c3.clone().sub(a)); if (n.lengthSq() < 1e-12) continue; n.normalize();
    let c = -n.dot(a); if (c < 0) { n.negate(); c = -c; }
    if (!accept(n)) continue;
    let cnt = 0;
    for (const k of idx) { const x = pos[k * 3], y = pos[k * 3 + 1], z = pos[k * 3 + 2]; if (Math.abs(n.x * x + n.y * y + n.z * z + c) < tol * Math.hypot(x, y, z)) cnt++; }
    if (!best || cnt > best.cnt) best = { n, c, cnt };
  }
  if (!best) return null;
  // refine: least squares on the inliers
  const inl = []; let m = v3(0, 0, 0);
  for (const k of idx) { const x = pos[k * 3], y = pos[k * 3 + 1], z = pos[k * 3 + 2];
    if (Math.abs(best.n.x * x + best.n.y * y + best.n.z * z + best.c) < tol * Math.hypot(x, y, z)) { inl.push(k); m.add(v3(x, y, z)); } }
  m.divideScalar(inl.length);
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const k of inl) { const d = [pos[k * 3] - m.x, pos[k * 3 + 1] - m.y, pos[k * 3 + 2] - m.z]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j]; }
  const n = smallestEig(C); let c = -n.dot(m); if (c < 0) { n.negate(); c = -c; }
  return { n, c, inliers: inl, frac: inl.length / idx.length };
}

/** Floor (normal up in the image) and, if there is one, a wall (normal near-perpendicular to the floor's). */
function fitPlanes(plate, ratio, fov, rect = [0, 0.5, 1, 1]) {
  const iz = plate.invDepth(ratio), pos = plate.points(iz, fov), idx = [], fidx = [];
  for (let j = 0; j < plate.GH; j += 3) for (let i = 0; i < plate.GW; i += 3) { idx.push(j * plate.GW + i);
    const u = i / (plate.GW - 1), v = j / (plate.GH - 1); if (u >= rect[0] && u <= rect[2] && v >= rect[1] && v <= rect[3]) fidx.push(j * plate.GW + i); }
  const floor = ransacPlane(pos, fidx, n => n.y > 0.3);
  if (!floor) return { ratio, floor: null };
  const fl = new Set(floor.inliers), rest = idx.filter(k => !fl.has(k));
  const wall = rest.length > 100 ? ransacPlane(pos, rest, n => Math.abs(n.dot(floor.n)) < 0.35 && Math.abs(n.y) < 0.6, { seed: 11 }) : null;
  const angle = wall ? Math.acos(Math.min(1, Math.abs(floor.n.dot(wall.n)))) * 180 / Math.PI : null;
  return { ratio, floor, wall: wall && wall.frac > 0.04 ? wall : null, angle: wall && wall.frac > 0.04 ? angle : null };
}

/** Pitch (down positive) and roll of a camera, in degrees, from the floor normal in camera space. */
const poseOf = n => ({ pitch: Math.asin(Math.max(-1, Math.min(1, n.z))) * 180 / Math.PI, roll: Math.atan2(n.x, n.y) * 180 / Math.PI });

// ---------------------------------------------------------------- image helpers
function minFilter(src, GW, GH, r) {   // separable min over a (2r+1)^2 window
  const t = new Float32Array(src.length), o = new Float32Array(src.length);
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) { let m = Infinity; for (let d = -r; d <= r; d++) { const x = Math.min(GW - 1, Math.max(0, i + d)); m = Math.min(m, src[j * GW + x]); } t[j * GW + i] = m; }
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) { let m = Infinity; for (let d = -r; d <= r; d++) { const y = Math.min(GH - 1, Math.max(0, j + d)); m = Math.min(m, t[y * GW + i]); } o[j * GW + i] = m; }
  return o;
}
function dilate(mask, GW, GH, r) { const f = Float32Array.from(mask, v => v ? 0 : 1); const m = minFilter(f, GW, GH, r); return Uint8Array.from(m, v => v === 0 ? 1 : 0); }
/** Push-pull hole fill on an nch-channel Float32Array (hole: Uint8Array per pixel). Returns the filled array. */
function pushPull(src, nch, W, H, hole) {
  const C = nch + 1, levels = []; let w = W, h = H, cur = new Float32Array(W * H * C);
  for (let k = 0; k < W * H; k++) { const a = hole[k] ? 0 : 1; for (let c = 0; c < nch; c++) cur[k * C + c] = src[k * nch + c] * a; cur[k * C + nch] = a; }
  levels.push({ d: cur, w, h });
  while (w > 1 || h > 1) {   // push: premultiplied 2x2 sums
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1), nd = new Float32Array(nw * nh * C);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const s = (Math.min(h - 1, y * 2 + dy) * w + Math.min(w - 1, x * 2 + dx)) * C, o = (y * nw + x) * C;
      for (let c = 0; c < C; c++) nd[o + c] += cur[s + c];
    }
    levels.push({ d: nd, w: nw, h: nh }); cur = nd; w = nw; h = nh;
  }
  for (let l = levels.length - 2; l >= 0; l--) {   // pull: top up each level's missing weight from the coarser one (bilinear)
    const L = levels[l], K = levels[l + 1];
    for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
      const o = (y * L.w + x) * C, a = Math.min(1, L.d[o + nch]); if (a >= 1) continue;
      const cx = Math.min(K.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), cy = Math.min(K.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const x0 = Math.floor(cx), y0 = Math.floor(cy), x1 = Math.min(K.w - 1, x0 + 1), y1 = Math.min(K.h - 1, y0 + 1), fx = cx - x0, fy = cy - y0;
      const acc = new Float32Array(C);
      for (const [xx, yy, wt] of [[x0, y0, (1 - fx) * (1 - fy)], [x1, y0, fx * (1 - fy)], [x0, y1, (1 - fx) * fy], [x1, y1, fx * fy]]) {
        const q = (yy * K.w + xx) * C, ka = K.d[q + nch]; if (ka <= 0) continue; for (let c = 0; c < nch; c++) acc[c] += K.d[q + c] / ka * wt; acc[nch] += wt;
      }
      if (acc[nch] <= 0) continue;
      const wsum = L.d[o + nch]; for (let c = 0; c < nch; c++) L.d[o + c] = (wsum > 0 ? L.d[o + c] / wsum * a : 0) + (1 - a) * acc[c] / acc[nch];
      L.d[o + nch] = 1;
    }
  }
  const out = new Float32Array(W * H * nch), L = levels[0].d;
  for (let k = 0; k < W * H; k++) { const a = L[k * C + nch]; for (let c = 0; c < nch; c++) out[k * nch + c] = a > 0 ? (a >= 1 && !hole[k] ? L[k * C + c] : L[k * C + c] / (hole[k] ? 1 : a)) : 0; }
  return out;
}
const fillRGBA = (rgba, W, H, hole) => { const f = pushPull(Float32Array.from(rgba), 4, W, H, hole), o = new Uint8ClampedArray(W * H * 4);
  for (let k = 0; k < W * H; k++) { o[k * 4] = f[k * 4]; o[k * 4 + 1] = f[k * 4 + 1]; o[k * 4 + 2] = f[k * 4 + 2]; o[k * 4 + 3] = 255; } return o; };
function canvasOf(rgba, W, H) { const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').putImageData(new ImageData(rgba, W, H), 0, 0); return c; }

// ---------------------------------------------------------------- scene build
async function boot() {
  const t0 = performance.now();
  const bmp = await createImageBitmap(await (await fetch(OPT.img)).blob());
  const W = bmp.width, H = bmp.height, c2 = document.createElement('canvas'); c2.width = W; c2.height = H;
  const cx = c2.getContext('2d'); cx.drawImage(bmp, 0, 0); let rgba = cx.getImageData(0, 0, W, H).data;
  // HUD: its pixels become a screen-space overlay; the plate gets inpainted colour (and below, depth) there
  const inHud = (u, v) => OPT.hud.some(r => u >= r[0] && u <= r[2] && v >= r[1] && v <= r[3]);
  const hudMask = new Uint8Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) hudMask[y * W + x] = inHud((x + 0.5) / W, (y + 0.5) / H) ? 1 : 0;
  const hudCanvas = document.createElement('canvas'); hudCanvas.width = W; hudCanvas.height = H;
  if (OPT.hud.length) { const hd = new Uint8ClampedArray(rgba); for (let k = 0; k < W * H; k++) hd[k * 4 + 3] = hudMask[k] ? 255 : 0;
    hudCanvas.getContext('2d').putImageData(new ImageData(hd, W, H), 0, 0); rgba = fillRGBA(rgba, W, H, hudMask); cx.putImageData(new ImageData(rgba, W, H), 0, 0); }
  $('info').textContent = `${OPT.img} · ${W}×${H} · estimating depth…`;
  const disp = await estimateDisparity(OPT.img);
  const plate = new Plate(rgba, W, H, disp); plate.grid(OPT.step || Math.max(1, Math.round(W / 960)));
  if (OPT.hud.length) { const g = new Uint8Array(plate.GW * plate.GH);   // depth under the HUD: filled from around it
    for (let j = 0; j < plate.GH; j++) for (let i = 0; i < plate.GW; i++) g[j * plate.GW + i] = inHud(i / (plate.GW - 1), j / (plate.GH - 1)) ? 1 : 0;
    plate.dn = pushPull(plate.dn, 1, plate.GW, plate.GH, dilate(g, plate.GW, plate.GH, 2)); }

  // shift (far/near) and camera match
  const CANDS = [1.2, 1.35, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 16, 20, 30, 40, 80, Infinity];
  const fits = CANDS.map(r => fitPlanes(plate, r, OPT.fov, OPT.floor));
  let fit;
  if (OPT.pitch != null) {   // a known pitch picks the shift: the candidate whose floor tilt is closest
    const ok = fits.filter(f => f.floor);
    fit = ok.reduce((b, f) => Math.abs(poseOf(f.floor.n).pitch - OPT.pitch) < Math.abs(poseOf(b.floor.n).pitch - OPT.pitch) ? f : b);
  } else if (OPT.ratio === 'auto') {
    const withWall = fits.filter(f => f.floor && f.angle != null);
    fit = withWall.length ? withWall.reduce((b, f) => Math.abs(f.angle - 90) < Math.abs(b.angle - 90) ? f : b) : fits.find(f => f.ratio === 8);
  } else fit = fitPlanes(plate, +OPT.ratio === 0 ? Infinity : +OPT.ratio, OPT.fov, OPT.floor);
  if (!fit.floor) throw new Error('no floor plane found');
  const ratio = fit.ratio, iz = plate.invDepth(ratio), scale = OPT.height / fit.floor.c;   // metres per plate unit
  const pos = plate.points(iz, OPT.fov, scale);
  const { GW, GH, step } = plate;

  // depth edges (cells where inverse depth changes faster than `edge` per pixel)
  const thr = 1 + OPT.edge * step, cellEdge = new Uint8Array(GW * GH), vEdge = new Uint8Array(GW * GH);
  for (let j = 0; j < GH - 1; j++) for (let i = 0; i < GW - 1; i++) {
    const a = iz[j * GW + i], b = iz[j * GW + i + 1], c = iz[(j + 1) * GW + i], d = iz[(j + 1) * GW + i + 1];
    if (Math.max(a, b, c, d) / Math.min(a, b, c, d) > thr) { cellEdge[j * GW + i] = 1; for (const k of [j * GW + i, j * GW + i + 1, (j + 1) * GW + i, (j + 1) * GW + i + 1]) vEdge[k] = 1; }
  }
  // background layer: near edges, the inverse depth of the farthest thing around, and inpainted colour
  const near = dilate(vEdge, GW, GH, OPT.band), izMin = minFilter(iz, GW, GH, OPT.band);
  const fgBand = new Uint8Array(GW * GH), bgIz = Float32Array.from(iz);
  for (let k = 0; k < GW * GH; k++) if (near[k] && iz[k] > izMin[k] * (1 + OPT.edge * 2)) { fgBand[k] = 1; bgIz[k] = izMin[k]; }
  const bgPos = new Float32Array(pos.length), f = (H / 2) / Math.tan(OPT.fov * Math.PI / 360);
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) { const k = j * GW + i, z = scale / bgIz[k] * 1.01;
    bgPos[k * 3] = (i * step - W / 2) / f * z; bgPos[k * 3 + 1] = -(j * step - H / 2) / f * z; bgPos[k * 3 + 2] = -z; }
  const holeG = dilate(fgBand, GW, GH, 2), hole = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) hole[y * W + x] = holeG[Math.round(y / step) * GW + Math.round(x / step)];
  const bgRGBA = fillRGBA(rgba, W, H, hole);

  // three.js
  const canvas = $('gpu'); canvas.width = 1920; canvas.height = Math.round(1920 * H / W);
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, alpha: true });
  await renderer.init();
  renderer.setPixelRatio(1); renderer.setSize(canvas.width, canvas.height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(OPT.fov, W / H, 0.01 * scale, 2000 * scale);
  cam.zoom = OPT.zoom; cam.updateProjectionMatrix();

  const tex = c => { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 8; return t; };
  const uvs = new Float32Array(GW * GH * 2);
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) { uvs[(j * GW + i) * 2] = Math.min(1, i * step / W); uvs[(j * GW + i) * 2 + 1] = 1 - Math.min(1, j * step / H); }
  const mesh = (p, keep, map) => {
    const ind = []; for (let j = 0; j < GH - 1; j++) for (let i = 0; i < GW - 1; i++) { if (!keep(j * GW + i)) continue;
      const a = j * GW + i, b = a + 1, c = a + GW, d = c + 1; ind.push(a, c, b, b, c, d); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setIndex(ind.length > 65535 ? new THREE.Uint32BufferAttribute(ind, 1) : new THREE.Uint16BufferAttribute(ind, 1));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map, side: THREE.DoubleSide })); m.frustumCulled = false; return m;
  };
  const fg = mesh(pos, k => !cellEdge[k], tex(c2)), bg = mesh(bgPos, () => true, tex(canvasOf(bgRGBA, W, H)));
  bg.renderOrder = -1; scene.add(bg, fg);

  // floor frame: Y = floor normal (camera side), origin under the camera, X along the camera's right
  const n = fit.floor.n, O = n.clone().multiplyScalar(-OPT.height);
  const X = v3(1, 0, 0).addScaledVector(n, -n.x).normalize(), Z = X.clone().cross(n);
  const floorFrame = new THREE.Group(); floorFrame.matrixAutoUpdate = false;
  floorFrame.matrix.makeBasis(X, n, Z).setPosition(O); scene.add(floorFrame);
  const toFloor = floorFrame.matrix.clone().invert();

  // prop where the ray through `at` meets the floor plane
  const ray = v3((OPT.at[0] * W - W / 2) / f, -(OPT.at[1] * H - H / 2) / f, -1).normalize();
  const tHit = OPT.height / -ray.dot(n), hit = ray.clone().multiplyScalar(tHit), hitF = hit.clone().applyMatrix4(toFloor);
  const prop = new THREE.Group(); floorFrame.add(prop);
  let propInfo = null;
  if (OPT.prop && OPT.prop !== 'none') {
    const gltf = await new GLTFLoader().loadAsync(OPT.prop), m = gltf.scene;
    const box = new THREE.Box3().setFromObject(m), sz = box.getSize(v3()), s = OPT.propSize / Math.max(sz.x, sz.y, sz.z);
    m.scale.setScalar(s); m.position.set(-(box.min.x + box.max.x) / 2 * s, -box.min.y * s, -(box.min.z + box.max.z) / 2 * s);
    m.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true;   // no environment map here: metallic PSX materials go black
      for (const mt of [o.material].flat()) if ('metalness' in mt) { mt.metalness = 0; mt.roughness = Math.max(0.6, mt.roughness); } } });
    prop.add(m); prop.position.copy(hitF); prop.rotation.y = OPT.yaw * Math.PI / 180;
    propInfo = { size: [sz.x * s, sz.y * s, sz.z * s], at: hitF.toArray() };
  }
  // light: a key from `sun` and a hemisphere fill, tinted with the plate's mean colour
  let mr = 0, mg = 0, mb = 0; for (let k = 0; k < W * H; k += 37) { mr += rgba[k * 4]; mg += rgba[k * 4 + 1]; mb += rgba[k * 4 + 2]; }
  const cnt = Math.ceil(W * H / 37), tint = new THREE.Color().setRGB(mr / cnt / 255, mg / cnt / 255, mb / cnt / 255, THREE.SRGBColorSpace);
  // hue from the plate's mean, brightness scaled with its mean luminance (a dark plate gets a dark prop)
  const lum = 0.2126 * tint.r + 0.7152 * tint.g + 0.0722 * tint.b, bright = Math.min(1, 2 * lum / 0.18);
  const tn = tint.clone().multiplyScalar(bright / Math.max(tint.r, tint.g, tint.b, 1e-3));
  const az = OPT.sun[0] * Math.PI / 180, el = OPT.sun[1] * Math.PI / 180, R = OPT.propSize * 6;
  const key = new THREE.DirectionalLight(tn, OPT.key); key.position.set(hitF.x + R * Math.cos(el) * Math.sin(az), R * Math.sin(el), hitF.z + R * Math.cos(el) * Math.cos(az));
  key.target.position.copy(hitF); key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.radius = 4;
  Object.assign(key.shadow.camera, { left: -OPT.propSize * 2, right: OPT.propSize * 2, top: OPT.propSize * 2, bottom: -OPT.propSize * 2, near: R * 0.1, far: R * 3 });
  key.shadow.bias = -0.0005;
  floorFrame.add(key, key.target, new THREE.HemisphereLight(tn, tn.clone().multiplyScalar(0.3), OPT.fill));
  const catcher = new THREE.Mesh(new THREE.PlaneGeometry(OPT.propSize * 6, OPT.propSize * 6), new THREE.ShadowMaterial({ opacity: 0.6 }));
  catcher.rotation.x = -Math.PI / 2; catcher.position.set(hitF.x, OPT.height * 0.0015, hitF.z); catcher.receiveShadow = true;
  floorFrame.add(catcher);
  let grid = null;
  if (OPT.grid > 0) { const N = 80; grid = new THREE.GridHelper(OPT.grid * N, N, 0xffff00, 0xffff00); grid.material.transparent = true; grid.material.opacity = 0.5;
    grid.position.set(hitF.x, OPT.height * 0.002, hitF.z); floorFrame.add(grid); }
  scene.updateMatrixWorld(true);

  // ------------------------------------------------------------ camera moves (pivot: the prop's spot on the floor)
  const pivot = hit.clone(), dist = pivot.length();
  /** Pose for a move: kind orbit|dolly|truck|crane|push, amount (degrees for orbit, fraction of the pivot distance or of
   *  the camera height otherwise), u in [-1, 1]. */
  function pose(kind, amount, u) {
    cam.position.set(0, 0, 0); cam.quaternion.identity();
    if (kind === 'orbit') { const q = new THREE.Quaternion().setFromAxisAngle(n, amount * u * Math.PI / 180);
      cam.position.copy(pivot.clone().sub(pivot.clone().applyQuaternion(q))); cam.quaternion.premultiply(q); }
    else if (kind === 'dolly') cam.position.copy(pivot.clone().multiplyScalar(amount * u));
    else if (kind === 'truck') cam.position.copy(X.clone().multiplyScalar(amount * u * dist));
    else if (kind === 'crane') cam.position.copy(n.clone().multiplyScalar(amount * u * OPT.height));
    cam.updateMatrixWorld(true);
  }
  const out = document.createElement('canvas'); out.width = canvas.width; out.height = canvas.height; const octx = out.getContext('2d', { willReadFrequently: true });
  function draw({ showBg = true, showProp = true, black = true, showHud = true } = {}) {
    bg.visible = showBg; prop.visible = showProp; catcher.visible = showProp;
    renderer.setClearColor(0x000000, 0); renderer.render(scene, cam);
    octx.globalCompositeOperation = 'copy'; octx.drawImage(canvas, 0, 0);
    if (OPT.hud.length && showHud) { octx.globalCompositeOperation = 'source-over'; octx.drawImage(hudCanvas, 0, 0, out.width, out.height); }
    if (black) { octx.globalCompositeOperation = 'destination-over'; octx.fillStyle = '#000'; octx.fillRect(0, 0, out.width, out.height); octx.globalCompositeOperation = 'source-over'; }
    return out;
  }
  /** Share of the frame left uncovered: by the foreground alone, and with the background layer. */
  function coverage(kind, amount, u) {
    pose(kind, amount, u);
    const holes = () => { const d = octx.getImageData(0, 0, out.width, out.height).data; let h = 0; for (let k = 3; k < d.length; k += 4) if (d[k] < 128) h++; return h / (d.length / 4); };
    draw({ showBg: false, showProp: false, black: false, showHud: false }); const fgHoles = holes();
    draw({ showBg: true, showProp: false, black: false, showHud: false }); const allHoles = holes();
    return { kind, amount, u, revealed: +(100 * (fgHoles - allHoles)).toFixed(3), offPlate: +(100 * allHoles).toFixed(3) };
  }
  async function post(name, body) { for (let i = 0; i < 5; i++) { try { const r = await fetch('/save/' + name, { method: 'POST', body }); if (r.ok) return; } catch { /* retry */ } await new Promise(r => setTimeout(r, 300 * (i + 1))); } throw new Error('save failed: ' + name); }
  const png = async c => (await fetch(c.toDataURL('image/png'))).blob();
  /** Render a move to PNGs: frames over an ease-in-out from u=-1 to 1 (dolly and push: 0 to 1). */
  async function exportMove(dir, kind, amount, frames = 90, opts = {}) {
    const t = performance.now();
    for (let i = 0; i < frames; i++) { const e = 0.5 - 0.5 * Math.cos(Math.PI * i / (frames - 1)), u = kind === 'dolly' ? e : 2 * e - 1;
      pose(kind, amount, u); await post(`${dir}/f${String(i).padStart(5, '0')}.png`, await png(draw(opts))); }
    return { frames, seconds: (performance.now() - t) / 1000 };
  }
  async function saveStill(name, kind = 'orbit', amount = 0, u = 0, opts = {}) { pose(kind, amount, u); await post(name, await png(draw(opts))); }
  /** Debug images: the depth (inverse depth, grey), the edges and background band, the floor inliers. */
  async function saveDebug(dir) {
    const img = (fn) => { const d = new Uint8ClampedArray(GW * GH * 4); for (let k = 0; k < GW * GH; k++) { const [r, g, b] = fn(k); d[k * 4] = r; d[k * 4 + 1] = g; d[k * 4 + 2] = b; d[k * 4 + 3] = 255; } return canvasOf(d, GW, GH); };
    const izMax = Math.max(...iz.filter((_, i) => i % 5 === 0));
    await post(`${dir}/depth.png`, await png(img(k => { const v = 255 * Math.min(1, iz[k] / izMax); return [v, v, v]; })));
    const inl = new Set(fit.floor.inliers), wl = new Set(fit.wall ? fit.wall.inliers : []);
    await post(`${dir}/planes.png`, await png(img(k => { const j = Math.floor(k / GW), i = k % GW, s = (j * step * W + i * step) * 4, g = (rgba[s] + rgba[s + 1] + rgba[s + 2]) / 3 * 0.6;
      const near3 = set => { if (j % 3 || i % 3) return set.has(k - (j % 3) * GW - (i % 3)); return set.has(k); };
      return near3(inl) ? [g * 0.5, g * 0.5 + 120, g * 0.5] : near3(wl) ? [g * 0.5 + 120, g * 0.5, g * 0.5 + 120] : [g, g, g]; })));
    await post(`${dir}/edges.png`, await png(img(k => cellEdge[k] ? [255, 60, 40] : fgBand[k] ? [40, 90, 255] : (() => { const j = Math.floor(k / GW), i = k % GW, s = (j * step * W + i * step) * 4; return [rgba[s] * 0.5, rgba[s + 1] * 0.5, rgba[s + 2] * 0.5]; })())));
    await post(`${dir}/background.png`, await png(canvasOf(bgRGBA, W, H)));
  }
  /** PSNR of the unmoved render (no prop) against the screenshot. */
  function identityPSNR() {
    pose('orbit', 0, 0); draw({ showProp: false });
    const a = octx.getImageData(0, 0, out.width, out.height).data, ref = document.createElement('canvas'); ref.width = out.width; ref.height = out.height;
    const rc = ref.getContext('2d'); rc.drawImage(bmp, 0, 0, out.width, out.height); const b = rc.getImageData(0, 0, out.width, out.height).data;
    let se = 0, n2 = 0; for (let k = 0; k < a.length; k += 4) for (let c = 0; c < 3; c++) { const d = a[k + c] - b[k + c]; se += d * d; n2++; }
    return +(10 * Math.log10(255 * 255 / (se / n2))).toFixed(2);
  }

  const floorPose = poseOf(n);
  const report = {
    img: OPT.img, size: [W, H], fov: OPT.fov, depthMs: Math.round(disp.ms), loadMs: Math.round(disp.loadMs), buildMs: Math.round(performance.now() - t0 - disp.ms - disp.loadMs),
    ratio: String(ratio), ratioMode: OPT.pitch != null ? 'pitch' : OPT.ratio, floorFrac: +fit.floor.frac.toFixed(3), wallFrac: fit.wall ? +fit.wall.frac.toFixed(3) : null, wallAngle: fit.angle != null ? +fit.angle.toFixed(1) : null,
    pitch: +floorPose.pitch.toFixed(2), roll: +floorPose.roll.toFixed(2), scale, dist,
    sweep: fits.map(f => f.floor ? { ratio: String(f.ratio), pitch: +poseOf(f.floor.n).pitch.toFixed(2), roll: +poseOf(f.floor.n).roll.toFixed(2), floor: +f.floor.frac.toFixed(3), wallAngle: f.angle != null ? +f.angle.toFixed(1) : null } : { ratio: f.ratio }),
    edgeCells: cellEdge.reduce((a, b) => a + b, 0), cells: (GW - 1) * (GH - 1), prop: propInfo,
  };
  pose('orbit', 0, 0); draw();
  $('info').textContent = `${W}×${H} · fov ${OPT.fov}° · far/near ${ratio} · pitch ${report.pitch}° roll ${report.roll}° · depth ${report.depthMs} ms`;
  window.VS = { OPT, report, pose, draw, coverage, exportMove, saveStill, saveDebug, identityPSNR, renderer, scene, cam, fitPlanes: (r, fv) => { const x = fitPlanes(plate, r, fv, OPT.floor); return x.floor ? { ...poseOf(x.floor.n), angle: x.angle } : null; } };

  // interactive: drag to orbit, wheel to dolly
  let drag = null, yawU = 0, dollyU = 0;
  const redraw = () => { pose('orbit', 20, yawU); if (dollyU) cam.position.addScaledVector(pivot.clone().sub(cam.position), dollyU); cam.updateMatrixWorld(true); draw({ black: false }); };
  canvas.addEventListener('pointerdown', e => { drag = { x: e.clientX, u: yawU }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => { if (!drag) return; yawU = Math.max(-1, Math.min(1, drag.u + (e.clientX - drag.x) / 400)); redraw(); });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('wheel', e => { e.preventDefault(); dollyU = Math.max(0, Math.min(0.8, dollyU - e.deltaY / 2000)); redraw(); }, { passive: false });
  window.VS_READY = true;
}
boot().catch(e => { console.error(e); window.VS_ERROR = String(e.stack || e); $('info').textContent = 'Error: ' + e.message; });
