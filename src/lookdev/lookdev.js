// A small well-lit look-dev view: a few PSX models (read in place from /psx/) under the shot's light model (a big soft
// key, ambient fill, a floor bounce), rendered through the same scene MRT (colour + distance) as ShotRenderer, so looks
// that plug into ShotRenderer (looks/halo_ce.js) can be judged on lit, textured props. No lens, depth of field or haze.
//   /src/lookdev/index.html            default look
//   /src/lookdev/index.html?halo       the Halo CE look
//   ?view=<n>                          camera preset (0 wide, 1 close on the desk and monitor, 2 close on the props)
import * as THREE from 'three/webgpu';
import { mrt, output, vec4, positionWorld, cameraPosition, texture, uv, Fn } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { bodyMaterial, makeLightUniforms } from '../render/materials.js';
import { assetUrl } from '../render/shot_renderer.js';
import { HaloCE, HALO_LOOK } from '../render/looks/halo_ce.js';

const params = new URLSearchParams(location.search);
if (params.has('bg')) window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 4);
const $ = id => document.getElementById(id);

/** The models: [asset, x, z, rotation y (deg), on top of (index) or null]. Metres, as the pack exports them. */
const PROPS = [
  ['psx:Furniture/tv_table_4.glb', 0, 0, 0, null],
  ['psx:Electronics & Misc/pc_monitor_mp_1.glb', 0, 0.05, 0, 0],
  ['psx:Items & Weapons/canned_food_mp_5_rusty.glb', 0.42, 0.15, 30, 0],
  ['psx:Items & Weapons/flashlight_mp_1.glb', -0.4, 0.2, 70, 0],
  ['psx:Large Props/metal_barrel_mp_1.glb', 1.2, 0.2, 0, null],
  ['psx:Large Props/vending_machine_1.glb', -1.55, -0.3, 20, null],
  ['psx:Lighting/lamp_1_on.glb', 0.85, -0.45, 0, null],
];
/** The Halo CE settings for a lit room: bright blue-grey fog farther out, the generic cube as the sky. */
const LOOKDEV_HALO = { ...HALO_LOOK, sky: 'cube', reflect: { strength: 0.35, lit: 0.3 },
  fog: { color: [0.42, 0.48, 0.56], start: 2.5, opaque: 16, max: 0.4, planeY: 0.12, planeDepth: 1.2, planeMax: 0.15 } };
const VIEWS = [
  { eye: [0.4, 1.55, 3.6], target: [-0.1, 0.65, 0], fov: 38 },
  { eye: [0.25, 1.15, 1.25], target: [0, 0.8, 0], fov: 40 },
  { eye: [1.6, 1.0, 1.6], target: [0.8, 0.55, 0], fov: 42 },
];

async function boot() {
  THREE.ColorManagement.enabled = false;
  const canvas = $('gpu'), W = 1920, H = 1080;
  const r = new THREE.WebGPURenderer({ canvas, antialias: false, alpha: false, trackTimestamp: params.has('gputime') });
  r.setPixelRatio(1); r.setSize(W, H, false); r.outputColorSpace = THREE.LinearSRGBColorSpace; r.toneMapping = THREE.NoToneMapping; r.setClearColor(0x000000, 1);
  await r.init();
  const scene = new THREE.Scene(), U = makeLightUniforms();
  const view = VIEWS[+(params.get('view') || 0)] || VIEWS[0];
  const camera = new THREE.PerspectiveCamera(view.fov, W / H, 0.02, 60);
  camera.position.set(...view.eye); camera.lookAt(new THREE.Vector3(...view.target)); camera.updateMatrixWorld(true);
  // lights in the shot's model: a big soft key (the "screen" light), ambient fill, a floor bounce
  U.sp.value.set(-1.4, 2.4, 2.4); U.sn.value.set(0.42, -0.5, -0.76).normalize(); U.sc.value.set(1, 0.95, 0.86); U.si.value = 30;
  U.amb.value = 0.42; U.bp.value.set(0.3, -0.4, 0.8); U.bi.value = 0.25; U.bl.value = 1; U.eStr.value = 1.5; U.lrad.value = 0.01; U.rrad.value = 1;

  const bodyMeshes = [], loader = new GLTFLoader(), roots = [];
  // floor: an untextured grey plane (shows the detail map and the fog plane)
  { const g = new THREE.PlaneGeometry(14, 14).rotateX(-Math.PI / 2), args = { map: null, blMul: 0.6 }, m = new THREE.Mesh(g, bodyMaterial(U, args)); scene.add(m); bodyMeshes.push({ mesh: m, args, obj: 'floor' }); }
  let lampTop = null;
  for (const [i, [ref, x, z, ry, on]] of PROPS.entries()) {
    const root = (await loader.loadAsync(assetUrl(ref))).scene; root.rotation.y = ry * Math.PI / 180; root.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(root), base = on === null ? 0 : new THREE.Box3().setFromObject(roots[on]).max.y;
    root.position.set(x - (b.min.x + b.max.x) / 2, base - b.min.y, z - (b.min.z + b.max.z) / 2); root.updateMatrixWorld(true);
    root.traverse(n => { if (!n.isMesh) return; const src = n.material;
      for (const t of [src.map, src.emissiveMap]) if (t) Object.assign(t, { colorSpace: THREE.NoColorSpace, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, needsUpdate: true });
      const args = { map: src.map, emissiveMap: src.emissiveMap }; n.material = bodyMaterial(U, args); n.userData.lookArgs = args; bodyMeshes.push({ mesh: n, args, obj: 'p' + i }); });
    // the lamp's flare sits on its emissive part (the bulb's glass)
    root.traverse(n => { if (n.isMesh && n.userData.lookArgs?.emissiveMap && ref.includes('lamp')) { const c = new THREE.Box3().setFromObject(n).getCenter(new THREE.Vector3()); lampTop = c.toArray(); } });
    scene.add(root); roots.push(root);
  }
  // the same buffers as ShotRenderer: scene (4x MSAA, colour + distance), final
  const sceneRT = new THREE.RenderTarget(W, H, { count: 2, samples: 4, depthBuffer: true, type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
  sceneRT.textures[0].name = 'output';
  Object.assign(sceneRT.textures[1], { name: 'dist', type: THREE.HalfFloatType, format: THREE.RGFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const finalRT = new THREE.RenderTarget(W, H, { depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.UnsignedByteType });
  const sceneMRT = mrt({ output, dist: vec4(positionWorld.distance(cameraPosition), 1, 0, 1) });
  const quad = tex => { const m = new THREE.NodeMaterial(); m.fragmentNode = Fn(() => vec4(texture(tex, uv()).level(0).rgb, 1))(); m.depthTest = m.depthWrite = false; return new THREE.QuadMesh(m); };
  const toFinal = quad(sceneRT.textures[0]), toCanvas = quad(finalRT.texture);

  // GPU timing per pass, as ShotRenderer.mark() does it
  let seq = 0; const names = new Map(), timing = params.has('gputime') && r.backend.hasFeature?.('timestamp-query');
  const mark = n => { if (!timing) return; r.info.frame = ++seq; names.set(seq, n); };
  const host = { renderer: r, U, scene, camera, sceneRT, finalRT, bodyMeshes, mark };
  const halo = new HaloCE(host);
  const lights = () => lampTop ? [{ pos: lampTop, color: [1, 0.85, 0.6], intensity: 0.7, size: 0.035, ghosts: 1 }] : [];
  const render = () => {
    halo.preScene();
    mark('scene'); r.setMRT(sceneMRT); r.setRenderTarget(sceneRT); r.clear(); r.render(scene, camera); r.setMRT(null);
    mark('copy'); r.setRenderTarget(finalRT); toFinal.render(r);
    halo.postFrame({ lights: lights() });
    mark('to canvas'); r.setRenderTarget(null); toCanvas.render(r);
  };
  const setHalo = on => { halo.set(on ? LOOKDEV_HALO : null); $('halo').checked = on; render(); };
  $('halo').onchange = e => setHalo(e.target.checked);
  const gpuTimes = async () => { if (!timing) return []; await r.resolveTimestampsAsync('render'); const pool = r.backend.timestampQueryPool?.render, out = [];
    if (pool) for (const [uid, ms] of pool.timestamps) { const s = +(uid.match(/:f(\d+)$/) || [])[1], n = names.get(s); if (n === undefined) continue; names.delete(s); out.push({ name: n, ms }); }
    return out; };
  /** Render and save the canvas as a PNG under the spike output folder (same task as the render). */
  const save = async name => { render(); const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').drawImage(canvas, 0, 0);
    const b = await new Promise(res => c.toBlob(res, 'image/png')); return (await fetch('/save/' + name, { method: 'POST', body: b })).status; };
  window.VS = { renderer: r, scene, camera, U, halo, render, setHalo, save, gpuTimes, LOOKDEV_HALO };
  setHalo(params.has('halo'));
  $('info').textContent = `${PROPS.length} PSX models · ${r.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2'}`;
  window.VS_READY = true;
}
boot().catch(e => { console.error(e); $('info').textContent = 'Failed: ' + e.message; window.VS_ERROR = String(e.stack || e); });
