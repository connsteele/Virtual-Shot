// Lookdev for the anime cel look (render/looks/cel.js) on well-lit PSX props: a key light, a sky fill, and a face proxy
// (a sphere with a nose, in the face-shadow mode). URL: ?cel=0 (baseline lambert), ?lines=0, ?view=wide|close|face, ?key=<deg>.
// In the page: LD.render({ cel, lines, view, keyDeg, look: {...}, debug }), LD.save('<dir>/<name>.png'), LD.time().
import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, uv, vec3, vec4, max, dot, normalize, If, Discard, positionWorld, cameraPosition, normalWorldGeometry, mix } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CEL_LOOK, makeCelUniforms, applyCelUniforms, ramp, rimMask, facingNormal, faceTerm, makeFaceUniforms, CelGBuffer, makeCelLines, applyLineUniforms, celAlbedo, celSpec } from '../render/looks/cel.js';

const params = new URLSearchParams(location.search), $ = id => document.getElementById(id);
const W = 1920, H = 1080;
THREE.ColorManagement.enabled = false;
const r = new THREE.WebGPURenderer({ canvas: $('gpu'), antialias: false });
r.setPixelRatio(1); r.setSize(W, H, false); r.outputColorSpace = THREE.LinearSRGBColorSpace; r.toneMapping = THREE.NoToneMapping; r.setClearColor(params.get('bg') === 'black' ? 0x000000 : 0x9fb8d8, 1);
await r.init();

// lights: key (direction to the light), sky fill, ambient
const K = { dir: uniform(new THREE.Vector3(-0.5, 0.7, 0.5).normalize()), key: uniform(new THREE.Vector3(0.92, 0.87, 0.8)), sky: uniform(new THREE.Vector3(0.32, 0.36, 0.45)), amb: uniform(0.12) };
const gbuf = new CelGBuffer(), C = makeCelUniforms(); C.gtex = gbuf.rt.texture; let look = applyCelUniforms(C, CEL_LOOK);
const albedo = (map, color) => map ? texture(map, uv()) : vec4(...color, 1);
const lambert = ({ map, color }) => { const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  m.outputNode = Fn(() => { const c = albedo(map, color); If(c.a.lessThan(0.4), () => { Discard(); });
    const V = normalize(cameraPosition.sub(positionWorld)), n = facingNormal(normalWorldGeometry, V);
    const l = K.key.mul(max(dot(n, K.dir), 0)).add(K.sky.mul(n.y.mul(0.5).add(0.5))).add(K.amb);
    return vec4(c.rgb.mul(l), 1); })(); return m; };
const cel = ({ map, color, face = null }) => { const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  m.outputNode = Fn(() => { const c = map ? celAlbedo(C, map, uv()) : vec4(...color, 1); If(c.a.lessThan(0.4), () => { Discard(); });
    const P = positionWorld, V = normalize(cameraPosition.sub(P)), n = facingNormal(normalWorldGeometry, V);
    const x = face ? faceTerm(face, P, K.dir) : dot(n, K.dir);
    const l = K.key.mul(ramp(C, x)).add(K.sky.mul(C.fill).mul(0.75)).add(C.fill.mul(K.amb));
    const rim = mix(c.rgb, vec3(1), 0.5).mul(C.rimCol).mul(rimMask(C)).mul(C.rim).mul(max(dot(n, K.dir).mul(0.5).add(0.6), 0).mul(0.8).add(C.rimAmb));
    const sp = K.key.mul(celSpec(C, n, K.dir, V)).mul(face ? 0 : 1);
    return vec4(c.rgb.mul(l).mul(C.gain).add(rim).add(sp), 1); })(); return m; };

// props, placed around the TV table (the Black Page desk) at their own scale
const scene = new THREE.Scene(), loader = new GLTFLoader(), swaps = [];
const PSX = ['Furniture/tv_table_4.glb', 'Electronics & Misc/pc_monitor_mp_1.glb', 'Electronics & Misc/pc_keyboard_mp_2.glb',
  'Small Props/clock_1.glb', 'Small Props/jerrycan_1.glb', 'Small Props/tv_remote_mp_1.glb', 'Items & Weapons/canned_food_mp_1.glb',
  'Items & Weapons/cassette_tape_mp_1.glb', 'Small Props/car_battery_1.glb',
  // research pass: more shapes (curved metal, hard boxes, a gun's fine detail)
  ...(params.get('props') === 'few' ? [] : ['Large Props/metal_barrel_mp_1.glb', 'Large Props/wooden_crate_1.glb', 'Items & Weapons/pistol_mp_1.glb', 'Items & Weapons/shotgun_1.glb'])];
const box = o => { o.updateMatrixWorld(true); return new THREE.Box3().setFromObject(o); };
let objIx = 0;
const register = (root, face = null) => {
  const seen = new Map(), obj = objIx++;
  root.updateMatrixWorld(true);
  root.traverse(n => { if (!n.isMesh) return;
    const src = n.material, map = src.map || null, color = src.color ? src.color.toArray() : [0.7, 0.7, 0.7];
    if (map) Object.assign(map, { colorSpace: THREE.NoColorSpace, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false, needsUpdate: true });
    const key = map?.uuid || src.uuid; if (!seen.has(key)) seen.set(key, seen.size);
    const s = { mesh: n, base: lambert({ map, color }), cel: cel({ map, color, face }) }; n.material = s.base; swaps.push(s);
    gbuf.add({ mesh: n, obj, mat: seen.get(key), map });
  });
};
const load = async p => (await loader.loadAsync('/psx/' + p.split('/').map(encodeURIComponent).join('/'))).scene;
const roots = await Promise.all(PSX.map(load));
const [table, monitor, keyboard, ...small] = roots;
const put = (o, x, y, z, ry = 0) => { o.rotation.y = ry; const b = box(o); o.position.set(x - (b.min.x + b.max.x) / 2, y - b.min.y, z - (b.min.z + b.max.z) / 2); scene.add(o); return box(o); };
const tb = put(table, 0, 0, 0), top = tb.max.y;
const mb = put(monitor, 0, top, tb.min.z + (tb.max.z - tb.min.z) * 0.4);
put(keyboard, 0, top, Math.min(tb.max.z - 0.1, mb.max.z + 0.14));
let x = tb.max.x + 0.25;
for (const o of small) { const b = box(o), w = b.max.x - b.min.x; put(o, x + w / 2, 0, 0.3); x += w + 0.15; }
// ground and the face proxy: a skin-coloured head with a nose, shaded in the face-shadow mode
const F = makeFaceUniforms(), skin = [1, 0.84, 0.74], hx = tb.min.x - 0.45, hy = 0.75, hz = 0.15;
const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80).rotateX(-Math.PI / 2)); scene.add(ground);
// research pass: a test bust instead of the ball: a jaw-tapered head, nose, ears, eye discs, a hair cap with a fringe,
// neck and shoulders. The head parts are shaded in the face-shadow mode; ids differ per part so material lines show.
const head = new THREE.SphereGeometry(0.16, 64, 48), hp = head.attributes.position;
for (let i = 0; i < hp.count; i++) {
  let x = hp.getX(i), y = hp.getY(i), z = hp.getZ(i);
  const t = Math.max(0, -y / 0.16);                               // 0 at the middle, 1 at the chin
  x *= 0.82 * (1 - 0.42 * t * t); z *= 0.92 * (1 - 0.18 * t) ; y *= 1.12;
  if (y < 0 && z > 0) z += 0.03 * t;                              // the chin comes forward a little
  hp.setXYZ(i, x, y, z);
}
head.computeVertexNormals();
const ball = new THREE.Mesh(head);
const nose = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.06, 4).rotateX(Math.PI / 2).rotateZ(Math.PI / 4).scale(0.8, 1, 1));
const ear = () => new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12).scale(0.35, 1, 0.7));
const earL = ear(), earR = ear();
const eye = () => new THREE.Mesh(new THREE.SphereGeometry(0.026, 20, 14).scale(0.8, 1.25, 0.3));
const eyeL = eye(), eyeR = eye();
const hair = new THREE.Mesh(new THREE.SphereGeometry(0.172, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.42).scale(0.86, 1.12, 0.98).rotateX(-0.25));
const fringe = new THREE.Mesh(new THREE.SphereGeometry(0.17, 32, 12, Math.PI * 0.15, Math.PI * 0.7, Math.PI * 0.3, Math.PI * 0.13).scale(0.86, 1.12, 0.98));
const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.16, 24));
const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.18, 8, 24).rotateZ(Math.PI / 2).scale(1.3, 0.75, 0.6));
ball.position.set(hx, hy, hz); nose.position.set(hx, hy - 0.03, hz + 0.158);
earL.position.set(hx - 0.13, hy - 0.005, hz - 0.01); earR.position.set(hx + 0.13, hy - 0.005, hz - 0.01);
eyeL.position.set(hx - 0.05, hy + 0.0, hz + 0.136); eyeR.position.set(hx + 0.05, hy + 0.0, hz + 0.136);
hair.position.set(hx, hy + 0.012, hz - 0.01); fringe.position.set(hx, hy + 0.012, hz + 0.004);
neck.position.set(hx, hy - 0.2, hz - 0.01); torso.position.set(hx, hy - 0.33, hz - 0.01);
scene.add(ball, nose, earL, earR, eyeL, eyeR, hair, fringe, neck, torso);
const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, hy - 0.4, 16)); pole.position.set(hx, (hy - 0.4) / 2, hz); scene.add(pole);
F.ctr.value.set(hx, hy, hz); F.size.value = 0.16;
const hairC = [0.22, 0.2, 0.38], eyeC = [0.12, 0.1, 0.18], shirt = [0.85, 0.35, 0.3];
for (const [m, col, face] of [[ground, [0.55, 0.55, 0.58], null], [ball, skin, F], [nose, skin, F], [earL, skin, F], [earR, skin, F],
  [eyeL, eyeC, null], [eyeR, eyeC, null], [hair, hairC, null], [fringe, hairC, null], [neck, skin, null], [torso, shirt, null], [pole, [0.25, 0.3, 0.5], null]]) {
  m.material = new THREE.MeshBasicMaterial({ color: new THREE.Color(...col) }); register(m, face); }
for (const o of roots) register(o);
console.log('table', tb.min.toArray(), tb.max.toArray());

// buffers: scene colour (4x MSAA), G-buffer, lines -> canvas
const sceneRT = new THREE.RenderTarget(W, H, { samples: 4, depthBuffer: true, type: THREE.UnsignedByteType, generateMipmaps: false });
const lines = makeCelLines({ colorTex: sceneRT.texture, gTex: gbuf.rt.texture });
const cam = new THREE.PerspectiveCamera(35, W / H, 0.02, 60);
const cx = (hx + x) / 2;
const VIEWS = { wide: [[cx - 0.3, 2.6, 7.2], [cx, 0.4, 0]],
  close: [[-0.75, top + 0.6, 1.25], [0, top + 0.22, tb.min.z + 0.25]], face: [[hx + 0.2, hy + 0.08, hz + 0.95], [hx, hy - 0.08, hz]],
  bust: [[hx + 0.75, hy + 0.1, hz + 1.2], [hx + 0.1, hy - 0.15, hz]], props: [[x - 1.6, 1.0, 2.6], [x - 1.4, 0.3, 0.3]] };
const state = { cel: params.get('cel') !== '0', lines: params.get('lines') !== '0', view: params.get('view') || 'wide', keyDeg: +(params.get('key') ?? 320), keyElev: 40, debug: 0 };
function render(o = {}) {
  Object.assign(state, o);
  if (o.look) look = applyCelUniforms(C, { ...CEL_LOOK, ...o.look });
  const az = state.keyDeg * Math.PI / 180, el = state.keyElev * Math.PI / 180;
  K.dir.value.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
  // the face looks along +z; its right is +x
  for (const s of swaps) s.mesh.material = state.cel ? s.cel : s.base;
  const [e, t] = VIEWS[state.view]; cam.position.set(...e); cam.lookAt(...t); cam.updateMatrixWorld(true);
  gbuf.render(r, cam, W, H); C.px.value.set(1 / W, 1 / H); C.rimPx.value = look.rimPx;
  r.setRenderTarget(sceneRT); r.clear(); r.render(scene, cam);
  applyLineUniforms(lines.U, { ...look, lines: state.cel && state.lines, debug: state.debug }, { sceneH: H, outH: H }); lines.U.px.value.set(1 / W, 1 / H);
  r.setRenderTarget(null); lines.quad.render(r);
}
async function save(name) {
  const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').drawImage($('gpu'), 0, 0);
  const b = await new Promise(res => c.toBlob(res, 'image/png')); return (await fetch('/save/' + name, { method: 'POST', body: b })).status;
}
/** GPU ms of the scene pass, the G-buffer and the lines (median of n), with timestamp queries if the adapter has them. */
async function time(n = 30) {
  if (!r.backend.hasFeature?.('timestamp-query')) return 'no timestamp-query';
  r.backend.trackTimestamp = true; const names = new Map(); let seq = 1e6; const out = { scene: [], gbuffer: [], lines: [] };
  const mark = k => { r.info.frame = ++seq; names.set(seq, k); };
  for (let i = 0; i < n; i++) {
    mark('gbuffer'); gbuf.render(r, cam, W, H);
    mark('scene'); r.setRenderTarget(sceneRT); r.clear(); r.render(scene, cam);
    mark('lines'); r.setRenderTarget(null); lines.quad.render(r);
    await r.resolveTimestampsAsync('render');
    const pool = r.backend.timestampQueryPool?.render; if (!pool) continue;
    for (const [uid, ms] of pool.timestamps) { const s = +(uid.match(/:f(\d+)$/) || [])[1], k = names.get(s); if (k) { out[k].push(ms); names.delete(s); } }
  }
  r.backend.trackTimestamp = false;
  const med = a => a.length ? +a.sort((p, q) => p - q)[a.length >> 1].toFixed(3) : null;
  return Object.fromEntries(Object.entries(out).map(([k, a]) => [k, med(a)]));
}
window.LD = { render, save, time, state, C, K, lines, F };
for (const id of ['cel', 'lines']) { $(id).checked = state[id]; $(id).onchange = e => render({ [id]: e.target.checked }); }
$('view').value = state.view; $('view').onchange = e => render({ view: e.target.value });
$('key').value = state.keyDeg; $('key').oninput = e => render({ keyDeg: +e.target.value });
render(); window.VS_READY = true;
