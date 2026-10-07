// Lookdev for the anime cel look (render/looks/cel.js) on well-lit PSX props: a key light, a sky fill, and a face proxy
// (a sphere with a nose, in the face-shadow mode). URL: ?cel=0 (baseline lambert), ?lines=0, ?view=wide|close|face, ?key=<deg>.
// In the page: LD.render({ cel, lines, view, keyDeg, look: {...}, debug }), LD.save('<dir>/<name>.png'), LD.time().
import * as THREE from 'three/webgpu';
import { Fn, uniform, texture, uv, vec3, vec4, max, dot, normalize, If, Discard, positionWorld, cameraPosition, normalWorldGeometry, mix } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CEL_LOOK, makeCelUniforms, applyCelUniforms, ramp, rimMask, facingNormal, faceTerm, makeFaceUniforms, CelGBuffer, makeCelLines, applyLineUniforms } from '../render/looks/cel.js';

const params = new URLSearchParams(location.search), $ = id => document.getElementById(id);
const W = 1920, H = 1080;
THREE.ColorManagement.enabled = false;
const r = new THREE.WebGPURenderer({ canvas: $('gpu'), antialias: false });
r.setPixelRatio(1); r.setSize(W, H, false); r.outputColorSpace = THREE.LinearSRGBColorSpace; r.toneMapping = THREE.NoToneMapping; r.setClearColor(0x000000, 1);
await r.init();

// lights: key (direction to the light), sky fill, ambient
const K = { dir: uniform(new THREE.Vector3(-0.5, 0.7, 0.5).normalize()), key: uniform(new THREE.Vector3(1.05, 0.98, 0.9)), sky: uniform(new THREE.Vector3(0.32, 0.36, 0.45)), amb: uniform(0.12) };
const C = makeCelUniforms(); let look = applyCelUniforms(C, CEL_LOOK);
const albedo = (map, color) => map ? texture(map, uv()) : vec4(...color, 1);
const lambert = ({ map, color }) => { const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  m.outputNode = Fn(() => { const c = albedo(map, color); If(c.a.lessThan(0.4), () => { Discard(); });
    const V = normalize(cameraPosition.sub(positionWorld)), n = facingNormal(normalWorldGeometry, V);
    const l = K.key.mul(max(dot(n, K.dir), 0)).add(K.sky.mul(n.y.mul(0.5).add(0.5))).add(K.amb);
    return vec4(c.rgb.mul(l), 1); })(); return m; };
const cel = ({ map, color, face = null }) => { const m = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  m.outputNode = Fn(() => { const c = albedo(map, color); If(c.a.lessThan(0.4), () => { Discard(); });
    const P = positionWorld, V = normalize(cameraPosition.sub(P)), n = facingNormal(normalWorldGeometry, V);
    const x = face ? faceTerm(face, P, K.dir) : dot(n, K.dir);
    const l = K.key.mul(ramp(C, x)).add(K.sky.mul(C.fill).mul(0.75)).add(C.fill.mul(K.amb));
    const rim = mix(c.rgb, vec3(1), 0.5).mul(C.rimCol).mul(rimMask(C, n, V)).mul(C.rim).mul(max(dot(n, K.dir).mul(0.5).add(0.6), 0).mul(0.8).add(C.rimAmb));
    return vec4(c.rgb.mul(l).mul(C.gain).add(rim), 1); })(); return m; };

// props, placed around the TV table (the Black Page desk) at their own scale
const scene = new THREE.Scene(), loader = new GLTFLoader(), gbuf = new CelGBuffer(), swaps = [];
const PSX = ['Furniture/tv_table_4.glb', 'Electronics & Misc/pc_monitor_mp_1.glb', 'Electronics & Misc/pc_keyboard_mp_2.glb',
  'Small Props/clock_1.glb', 'Small Props/jerrycan_1.glb', 'Small Props/tv_remote_mp_1.glb', 'Items & Weapons/canned_food_mp_1.glb',
  'Items & Weapons/cassette_tape_mp_1.glb', 'Small Props/car_battery_1.glb'];
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
const ground = new THREE.Mesh(new THREE.PlaneGeometry(14, 14).rotateX(-Math.PI / 2)); scene.add(ground);
const ball = new THREE.Mesh(new THREE.SphereGeometry(0.16, 48, 32)), nose = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.06, 12).rotateX(Math.PI / 2));
ball.position.set(hx, hy, hz); nose.position.set(hx, hy - 0.01, hz + 0.165); scene.add(ball, nose);
const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, hy - 0.16, 16)); pole.position.set(hx, (hy - 0.16) / 2, hz); scene.add(pole);
F.ctr.value.set(hx, hy, hz); F.size.value = 0.16;
for (const [m, col, face] of [[ground, [0.55, 0.55, 0.58], null], [ball, skin, F], [nose, skin, F], [pole, [0.25, 0.3, 0.5], null]]) {
  m.material = new THREE.MeshBasicMaterial({ color: new THREE.Color(...col) }); register(m, face); }
for (const o of roots) register(o);
console.log('table', tb.min.toArray(), tb.max.toArray());

// buffers: scene colour (4x MSAA), G-buffer, lines -> canvas
const sceneRT = new THREE.RenderTarget(W, H, { samples: 4, depthBuffer: true, type: THREE.UnsignedByteType, generateMipmaps: false });
const lines = makeCelLines({ colorTex: sceneRT.texture, gTex: gbuf.rt.texture });
const cam = new THREE.PerspectiveCamera(35, W / H, 0.02, 60);
const cx = (hx + x) / 2;
const VIEWS = { wide: [[cx - 0.5, 1.7, 3.6], [cx, 0.45, 0]],
  close: [[-0.75, top + 0.6, 1.25], [0, top + 0.22, tb.min.z + 0.25]], face: [[hx + 0.2, hy + 0.12, hz + 0.75], [hx, hy - 0.02, hz]] };
const state = { cel: params.get('cel') !== '0', lines: params.get('lines') !== '0', view: params.get('view') || 'wide', keyDeg: +(params.get('key') ?? 135), keyElev: 40, debug: 0 };
function render(o = {}) {
  Object.assign(state, o);
  if (o.look) look = applyCelUniforms(C, { ...CEL_LOOK, ...o.look });
  const az = state.keyDeg * Math.PI / 180, el = state.keyElev * Math.PI / 180;
  K.dir.value.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
  // the face looks along +z; its right is +x
  for (const s of swaps) s.mesh.material = state.cel ? s.cel : s.base;
  const [e, t] = VIEWS[state.view]; cam.position.set(...e); cam.lookAt(...t); cam.updateMatrixWorld(true);
  r.setRenderTarget(sceneRT); r.clear(); r.render(scene, cam);
  gbuf.render(r, cam, W, H);
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
    mark('scene'); r.setRenderTarget(sceneRT); r.clear(); r.render(scene, cam);
    mark('gbuffer'); gbuf.render(r, cam, W, H);
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
