// FX look dev (particles research pass): the spell burst on a lit table of PSX props (read in place from /psx/), drawn
// through the same scene MRT (colour + distance, 4x MSAA) and the same particle pass as ShotRenderer (its setParticles /
// fxFor run on this page's buffers), so what is judged here is what the shot draws. No lens, depth of field or haze.
// Research extras, all on this page only:
//   - the effect lighting the props (bodyMaterial's effect light, particles.js spellLight)
//   - an alpha-blended smoke layer in three orders: unsorted (instance order), sorted (GPU bitonic sort of a depth key,
//     every frame), weighted blended OIT (McGuire & Bavoil 2013, no sort)
//   - a stateful compute tier: fixed-step simulation with collisions, re-simulated from the event's start every frame
//   - stress settings (overdraw: big soft sprites filling the screen) and any resolution (?w=&h=)
//   /src/lookdev/fx.html?view=1&age=0.4&light&lighting=dusk&smoke=wboit&w=1920&h=1080&gputime
import * as THREE from 'three/webgpu';
import { mrt, output, vec4, vec3, vec2, float, uint, int, positionWorld, cameraPosition, texture, uv, Fn, uniform, instanceIndex,
  hash, instancedArray, varying, exp, dot, clamp, select, mix, pow, sin, cos, screenCoordinate, max, min, smoothstep, If, Loop, sqrt } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BitonicSort } from 'three/addons/gpgpu/BitonicSort.js';
import { bodyMaterial, makeLightUniforms } from '../render/materials.js';
import { assetUrl, ShotRenderer } from '../render/shot_renderer.js';
import { spellLight, particleCount } from '../render/particles.js';

const params = new URLSearchParams(location.search);
if (params.has('bg')) window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 4);
const $ = id => document.getElementById(id);
const TAU = Math.PI * 2;

/** The props: [asset, x, z, rotation y (deg), on top of (index) or null], as the Halo CE look dev places them. */
const PROPS = [
  ['psx:Furniture/tv_table_4.glb', 0, 0, 0, null],
  ['psx:Electronics & Misc/pc_monitor_mp_1.glb', 0, 0.05, 0, 0],
  ['psx:Items & Weapons/canned_food_mp_5_rusty.glb', 0.42, 0.15, 30, 0],
  ['psx:Items & Weapons/flashlight_mp_1.glb', -0.4, 0.2, 70, 0],
  ['psx:Large Props/metal_barrel_mp_1.glb', 1.2, 0.2, 0, null],
  ['psx:Large Props/vending_machine_1.glb', -1.55, -0.3, 20, null],
  ['psx:Lighting/lamp_1_on.glb', 0.85, -0.45, 0, null],
  ['psx:Large Props/supply_crate_1.glb', 2.0, 0.9, -25, null],
];
/** Camera presets, relative to the effect's origin (eye offset, target offset). */
const VIEWS = [
  { eye: [0.3, 0.75, 3.2], target: [-0.2, -0.1, -0.2], fov: 38 },   // 0 wide: the room
  { eye: [0.42, 0.2, 0.62], target: [0, 0.07, 0], fov: 40 },         // 1 the burst on the table
  { eye: [0.12, 0.06, 0.2], target: [0, 0.05, 0], fov: 60 },         // 2 inside the burst (overdraw)
];
/** Light rigs for the props: lit for editing (the Halo look dev's), dusk, night (the effect is the main light). */
const LIGHTING = {
  day: { si: 30, amb: 0.42, bi: 0.25 },
  dusk: { si: 6, amb: 0.12, bi: 0.08 },
  night: { si: 0.8, amb: 0.03, bi: 0.02 },
};

async function boot() {
  THREE.ColorManagement.enabled = false;
  const canvas = $('gpu'), W = +(params.get('w') || 1920), H = +(params.get('h') || 1080);
  canvas.width = W; canvas.height = H;
  const r = new THREE.WebGPURenderer({ canvas, antialias: false, alpha: false, trackTimestamp: params.has('gputime') });
  r.setPixelRatio(1); r.setSize(W, H, false); r.outputColorSpace = THREE.LinearSRGBColorSpace; r.toneMapping = THREE.NoToneMapping; r.setClearColor(0x000000, 1);
  await r.init();
  const scene = new THREE.Scene(), U = makeLightUniforms();
  const camera = new THREE.PerspectiveCamera(40, W / H, 0.02, 60);
  U.sp.value.set(-1.4, 2.4, 2.4); U.sn.value.set(0.42, -0.5, -0.76).normalize(); U.sc.value.set(1, 0.95, 0.86);
  U.bp.value.set(0.3, -0.4, 0.8); U.bl.value = 1; U.eStr.value = 1.5; U.lrad.value = 0.01; U.rrad.value = 1;
  const setLighting = k => { const L = LIGHTING[k] || LIGHTING.day; U.si.value = L.si; U.amb.value = L.amb; U.bi.value = L.bi; state.lighting = k; };

  const loader = new GLTFLoader(), roots = [];
  { const g = new THREE.PlaneGeometry(14, 14).rotateX(-Math.PI / 2); scene.add(new THREE.Mesh(g, bodyMaterial(U, { map: null, blMul: 0.6 }))); }
  for (const [i, [ref, x, z, ry, on]] of PROPS.entries()) {
    const root = (await loader.loadAsync(assetUrl(ref))).scene; root.rotation.y = ry * Math.PI / 180; root.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(root), base = on === null ? 0 : new THREE.Box3().setFromObject(roots[on]).max.y;
    root.position.set(x - (b.min.x + b.max.x) / 2, base - b.min.y, z - (b.min.z + b.max.z) / 2); root.updateMatrixWorld(true);
    root.traverse(n => { if (!n.isMesh) return; const src = n.material;
      for (const t of [src.map, src.emissiveMap]) if (t) Object.assign(t, { colorSpace: THREE.NoColorSpace, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, needsUpdate: true });
      n.material = bodyMaterial(U, { map: src.map, emissiveMap: src.emissiveMap }); });
    scene.add(root); roots.push(root);
  }
  const tableTop = new THREE.Box3().setFromObject(roots[0]).max.y;
  const origin = [0.2, tableTop + 0.05, 0.36];   // on the table in front of the monitor, beside the can
  const O = new THREE.Vector3(...origin);
  const setView = i => { const v = VIEWS[i] || VIEWS[1]; camera.fov = v.fov; camera.aspect = W / H; camera.updateProjectionMatrix();
    camera.position.copy(O).add(new THREE.Vector3(...v.eye)); camera.lookAt(O.clone().add(new THREE.Vector3(...v.target))); camera.updateMatrixWorld(true); };
  setView(+(params.get('view') ?? 1));

  // the same buffers as ShotRenderer: scene (4x MSAA, colour + distance)
  const sceneRT = new THREE.RenderTarget(W, H, { count: 2, samples: 4, depthBuffer: true, type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
  sceneRT.textures[0].name = 'output';
  Object.assign(sceneRT.textures[1], { name: 'dist', type: THREE.HalfFloatType, format: THREE.RGFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const sceneMRT = mrt({ output, dist: vec4(positionWorld.distance(cameraPosition), 1, 0, 1) });
  const quadOf = node => { const m = new THREE.NodeMaterial(); m.fragmentNode = node; m.depthTest = m.depthWrite = false; return new THREE.QuadMesh(m); };
  const finalRT = new THREE.RenderTarget(W, H, { depthBuffer: false, generateMipmaps: false, type: THREE.UnsignedByteType });

  // the shot's particle pass, run on this page's buffers (ShotRenderer.setParticles / fxFor need W, H, sceneRT)
  const fxHost = { W, H, sceneRT, fx: null };
  ShotRenderer.prototype.setParticles.call(fxHost, true);
  const fxFor = list => ShotRenderer.prototype.fxFor.call(fxHost, list);
  const distTex = sceneRT.textures[1], invSize = fxHost.fxInv;

  // GPU timing per pass, as ShotRenderer.mark() does it
  let seq = 0; const names = new Map(), timing = params.has('gputime') && r.backend.hasFeature?.('timestamp-query');
  const mark = n => { if (!timing) return; r.info.frame = ++seq; names.set(seq, n); };
  const gpuTimes = async () => { if (!timing) return []; await Promise.race([r.resolveTimestampsAsync('render'), new Promise(res => setTimeout(res, 3000))]);
    await Promise.race([r.resolveTimestampsAsync('compute'), new Promise(res => setTimeout(res, 3000))]);
    const out = [];
    for (const type of ['render', 'compute']) { const pool = r.backend.timestampQueryPool?.[type]; if (!pool) continue;
      for (const [uid, ms] of pool.timestamps) { const s = +(uid.match(/:f(\d+)$/) || [])[1], n = names.get(s); if (n === undefined) continue; names.delete(s); out.push({ name: n, ms }); } }
    return out; };

  // ---- alpha smoke: a layer that needs an order (premultiplied "over", unlike the additive sparks) ------------------
  const SMOKE_N = 1 << +(params.get('smokeBits') || 14);   // a power of two for the bitonic sort; 16 bits of index in the key
  const SU = { age: uniform(0), origin: uniform(new THREE.Vector3(...origin)), cam: uniform(new THREE.Vector3()), size: uniform(1), dark: uniform(1) };
  /** The closed-form smoke puff for particle id (a plain builder: called inside each material's or kernel's own Fn). */
  const smokeState = id => {
    const h = k => hash(id.add(uint(0x51ED27 + k * 0x6C8E9CF5 >>> 0)));
    const birth = h(0).mul(1.4), a = SU.age.sub(birth), life = mix(1.4, 2.4, h(1)), u = clamp(a.div(life), 0, 1);
    const ok = a.greaterThanEqual(0).and(a.lessThan(life));
    const th = h(2).mul(TAU), r0 = sqrt(h(3)).mul(0.05), drag = 1.4, out = float(1).sub(exp(a.mul(-drag))).div(drag);
    const pos = SU.origin.add(vec3(cos(th).mul(r0.add(out.mul(0.09))), out.mul(0.16).add(a.mul(0.05)).add(0.01), sin(th).mul(r0.add(out.mul(0.09)))))
      .add(vec3(sin(a.mul(2.1).add(h(4).mul(TAU))), 0, cos(a.mul(1.7).add(h(5).mul(TAU)))).mul(a.mul(0.02)));
    const size = select(ok, mix(0.035, 0.07, h(6)).mul(float(1).add(a.mul(1.6))).mul(SU.size), float(0));
    const alpha = select(ok, smoothstep(0, 0.15, a).mul(pow(float(1).sub(u), 1.3)).mul(0.6), float(0));
    // bright and dark puffs mixed, so a wrong order shows: dark violet soot and pale lit wisps
    const col = mix(vec3(0.05, 0.03, 0.09).mul(SU.dark), vec3(0.85, 0.8, 0.95), h(7).greaterThan(0.6).toFloat());
    return { pos, size, alpha, col, ok };
  };
  // sort keys: 16 bits of quantised distance (far = small key, drawn first) and 16 bits of particle index
  const keys = instancedArray(SMOKE_N, 'uint');
  const keyKernel = Fn(() => {
    const s = smokeState(instanceIndex), d = select(s.ok, s.pos.distance(SU.cam), float(64));
    const q = uint(clamp(d.div(8).mul(65535), 0, 65535));
    keys.element(instanceIndex).assign(uint(65535).sub(q).shiftLeft(uint(16)).bitOr(instanceIndex));
  })().compute(SMOKE_N);
  const sorter = new BitonicSort(r, keys, { workgroupSize: 64 });
  const smokeRT = new THREE.RenderTarget(W, H, { count: 2, samples: 0, depthBuffer: false, type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  smokeRT.textures[0].name = 'output'; smokeRT.textures[1].name = 'reveal';
  const smokeMats = {};
  const smokeSprite = mode => {
    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, sizeAttenuation: true });
    const pid = mode === 'sorted' ? keys.element(instanceIndex).bitAnd(uint(0xFFFF)) : instanceIndex;
    const s = smokeState(pid);
    m.positionNode = s.pos; m.scaleNode = vec2(s.size, s.size);
    const col = varying(s.col, 'v_smoke_col'), al = varying(s.alpha, 'v_smoke_a');
    const q = uv().mul(2).sub(1), d = dot(q, q), g = pow(float(1).sub(d).max(0), 1.5);
    const zs = texture(distTex, screenCoordinate.xy.mul(invSize)).level(0), sceneD = select(zs.r.lessThanEqual(0), float(1e3), zs.r.div(max(zs.g, 1)));
    const pd = positionWorld.distance(cameraPosition), vis = clamp(sceneD.sub(pd).div(0.02), 0, 1);
    const a = al.mul(g).mul(vis);
    if (mode === 'wboit') {
      // weighted blended OIT: accumulate (c a w, a w) additively, revealage multiplies by (1 - a); w favours near fragments
      const w = clamp(float(0.03).div(pow(pd.div(2), 4).add(1e-5)), 1e-2, 3e3).mul(a);
      m.blending = THREE.CustomBlending; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneFactor; m.blendEquation = THREE.AddEquation;
      m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneFactor;
      m.outputNode = vec4(col.mul(a).mul(w), a.mul(w));
      const rev = Object.assign(new THREE.BlendMode(THREE.CustomBlending), { blendSrc: THREE.ZeroFactor, blendDst: THREE.OneMinusSrcColorFactor, blendEquation: THREE.AddEquation,
        blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor, blendEquationAlpha: THREE.AddEquation });
      m.mrtNode = mrt({ reveal: vec4(a, a, a, a) }); m.userData.rev = rev;
    } else {
      // premultiplied over, in draw order: dst = src + dst (1 - a)
      m.blending = THREE.CustomBlending; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor; m.blendEquation = THREE.AddEquation;
      m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
      m.outputNode = vec4(col.mul(a), a);
    }
    const sp = new THREE.Sprite(m); sp.count = SMOKE_N; sp.frustumCulled = false; sp.matrixAutoUpdate = false;
    const sc = new THREE.Scene(); sc.add(sp); return { scene: sc, mat: m };
  };
  const smokeFor = mode => {
    if (!smokeMats[mode]) {
      const s = smokeSprite(mode); smokeMats[mode] = s;
      if (mode === 'wboit') s.mrt = mrt({ output, reveal: vec4(0) }).setBlendMode('reveal', s.mat.userData.rev).setClearColor('reveal', new THREE.Color(1, 1, 1), 1);
      else s.mrt = mrt({ output, reveal: vec4(0) });
    }
    return smokeMats[mode];
  };
  // composite the smoke buffer over the scene buffer: over = C + scene (1 - A); wboit = scene rev + avg colour (1 - rev)
  const smokeC = texture(smokeRT.textures[0]), smokeR = texture(smokeRT.textures[1]);
  const mkComp = wb => { const m = new THREE.NodeMaterial(); Object.assign(m, { depthTest: false, depthWrite: false, transparent: true, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor, blendEquation: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor });
    const c = smokeC.sample(uv());
    if (wb) { const rv = smokeR.sample(uv()).r; m.outputNode = vec4(c.rgb.div(max(c.a, 1e-5)).mul(float(1).sub(rv)), rv); }
    else m.outputNode = vec4(c.rgb, float(1).sub(c.a));
    m.mrtNode = mrt({ dist: vec4(1e4, 1e4, 0, 1) });   // drawn with the particle MRT: min blending leaves the scene's distance alone
    return new THREE.QuadMesh(m); };
  const compOver = mkComp(false), compWB = mkComp(true);

  // ---- stateful compute tier: fixed-step simulation with a floor collision, re-simulated from the event's start ------
  const SIM_N = +(params.get('simN') || 65536), DT = 1 / 240;
  const simPos = instancedArray(SIM_N, 'vec4'), simVel = instancedArray(SIM_N, 'vec4');
  const SIM = { steps: uniform(0, 'int'), origin: uniform(new THREE.Vector3(...origin)), floor: uniform(tableTop), n: SIM_N };
  const initState = id => {
    const h = k => hash(id.add(uint(0xA511E9B3 + k * 0x6C8E9CF5 >>> 0)));
    const th = h(0).mul(TAU), up = mix(0.6, 1.0, h(1)), sp = mix(0.4, 1.3, h(2));
    return { p: SIM.origin.add(vec3(0, 0.02, 0)), v: vec3(cos(th).mul(sqrt(float(1).sub(up.mul(up)))), up, sin(th).mul(sqrt(float(1).sub(up.mul(up))))).mul(sp) };
  };
  const stepInto = (p, v) => {   // one fixed step: gravity, drag, a bounce on the table top (restitution 0.45, friction)
    v.y.subAssign(9.81 * DT); v.mulAssign(1 - 1.5 * DT); p.addAssign(v.mul(DT));
    If(p.y.lessThan(SIM.floor), () => { p.y.assign(SIM.floor.add(SIM.floor.sub(p.y).mul(0.45))); v.y.assign(v.y.negate().mul(0.45)); v.x.mulAssign(0.8); v.z.mulAssign(0.8); });
  };
  // re-simulate from birth: state(t) = steps applied to the initial state; the same ops in the same order every time
  const resim = Fn(() => {
    const s = initState(instanceIndex), p = s.p.toVar(), v = s.v.toVar();
    Loop(SIM.steps, () => { stepInto(p, v); });
    simPos.element(instanceIndex).assign(vec4(p, 1)); simVel.element(instanceIndex).assign(vec4(v, 0));
  })().compute(SIM_N);
  const initK = Fn(() => { const s = initState(instanceIndex); simPos.element(instanceIndex).assign(vec4(s.p, 1)); simVel.element(instanceIndex).assign(vec4(s.v, 0)); })().compute(SIM_N);
  const step1 = Fn(() => { const p = simPos.element(instanceIndex).xyz.toVar(), v = simVel.element(instanceIndex).xyz.toVar(); stepInto(p, v);
    simPos.element(instanceIndex).assign(vec4(p, 1)); simVel.element(instanceIndex).assign(vec4(v, 0)); })().compute(SIM_N);
  // the simulated sparks drawn as additive sprites in the shot's particle buffer
  const simScene = new THREE.Scene();
  { const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, sizeAttenuation: true, blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor });
    m.positionNode = simPos.element(instanceIndex).xyz; m.scaleNode = vec2(0.0035, 0.0035);
    const q = uv().mul(2).sub(1), d = dot(q, q), g = exp(d.mul(-10)).add(exp(d.mul(-3)).mul(0.3)).mul(float(1).sub(d).max(0));
    const zs = texture(distTex, screenCoordinate.xy.mul(invSize)).level(0), sceneD = select(zs.r.lessThanEqual(0), float(1e3), zs.r.div(max(zs.g, 1)));
    const vis = clamp(sceneD.sub(positionWorld.distance(cameraPosition)).div(0.01), 0, 1);
    m.outputNode = vec4(vec3(1.0, 0.55, 0.2).mul(g).mul(vis).mul(0.5), 1);
    m.mrtNode = mrt({ dist: vec4(1e4, 1e4, 0, 1) });
    const s = new THREE.Sprite(m); s.count = SIM_N; s.frustumCulled = false; s.matrixAutoUpdate = false; simScene.add(s); }

  const toFinal = quadOf(Fn(() => vec4(texture(sceneRT.textures[0], uv()).level(0).rgb, 1))());
  const toCanvas = quadOf(Fn(() => vec4(texture(finalRT.texture, uv()).level(0).rgb, 1))());

  const state = { age: +(params.get('age') ?? 0.4), light: params.has('light') ? +(params.get('light') || 1) : 0, lighting: 'day',
    smoke: params.get('smoke') || 'off', spell: true, sim: false, ev: { id: 'lookdev', kind: 'spellBurst', t: 0, dur: 2.4, seed: 1 } };
  setLighting(params.get('lighting') || 'day');

  /** Render one frame of the look dev at state.age. */
  const render = () => {
    const ev = state.ev, age = state.age;
    const XL = state.light > 0 ? spellLight(ev, age) : null;
    U.xp.value.set(...origin); U.xc.value.set(...(XL ? XL.color : [0, 0, 0])); U.xi.value = XL ? XL.level * state.light : 0; U.xrad.value = XL ? XL.radius : 0.1;
    mark('scene'); r.setMRT(sceneMRT); r.setRenderTarget(sceneRT); r.clear(); r.render(scene, camera); r.setMRT(null);
    const cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    if (state.spell || state.sim) {
      if (state.spell) fxFor([{ ev, age, origin }]); else for (const e of fxHost.fx.values()) e.group.visible = false;
      if (state.sim) {
        SIM.steps.value = Math.max(0, Math.round(age / DT)); mark('sim resimulate'); r.compute(resim);
        fxHost.fxScene.add(simScene);
      } else fxHost.fxScene.remove(simScene);
      mark('particles'); r.setMRT(fxHost.fxMRT); r.setRenderTarget(fxHost.fxRT); r.setClearColor(0x000000, 0); r.render(fxHost.fxScene, camera);
      const ac = r.autoClear; r.autoClear = false;
      mark('particles merge'); r.setRenderTarget(sceneRT); fxHost.fxMerge.render(r); r.setMRT(null); r.autoClear = ac;
    }
    if (state.smoke !== 'off') {
      SU.age.value = age; SU.cam.value.copy(camera.position);
      if (state.smoke === 'sorted') { mark('smoke keys'); r.compute(keyKernel); mark('smoke sort'); sorter.compute(r); }
      const s = smokeFor(state.smoke);
      mark('smoke'); r.setMRT(s.mrt); r.setRenderTarget(smokeRT); r.setClearColor(0x000000, 0); r.render(s.scene, camera);
      const ac = r.autoClear; r.autoClear = false;
      mark('smoke composite'); r.setMRT(fxHost.fxMRT); r.setRenderTarget(sceneRT); (state.smoke === 'wboit' ? compWB : compOver).render(r); r.setMRT(null); r.autoClear = ac;
    }
    r.setClearColor(cc, ca);
    mark('copy'); r.setRenderTarget(finalRT); toFinal.render(r);
    r.setRenderTarget(null); toCanvas.render(r);
  };
  const device = r.backend.device;
  const idle = () => Promise.race([device.queue.onSubmittedWorkDone(), new Promise(res => setTimeout(res, 10000))]);
  /** Render and save the canvas as a PNG under the spike output folder (same task as the render). */
  const save = async name => { await idle(); render(); const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').drawImage(canvas, 0, 0);
    const b = await new Promise(res => c.toBlob(res, 'image/png')); return (await fetch('/save/' + name, { method: 'POST', body: b })).status; };
  /** n timed frames after `warm` untimed ones: median ms per pass name. */
  const bench = async (n = 8, warm = 3) => {
    for (let i = 0; i < warm; i++) { render(); await idle(); await gpuTimes(); }
    const by = {};
    for (let i = 0; i < n; i++) { render(); await idle(); for (const { name, ms } of await gpuTimes()) (by[name] ||= []).push(ms); }
    const med = a => { const s = [...a].sort((x, y) => x - y); return +s[s.length >> 1].toFixed(3); };
    return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, med(v)]));
  };
  /** Compute-tier checks: wall ms (submit to done) of the re-simulation at `steps`, and determinism (two re-simulations,
   *  and re-simulation vs stepping one step per call from the initial state, compared bit for bit). */
  const simBench = async (stepsList = [60, 240, 480, 960], reps = 5) => {
    const out = {};
    for (const steps of stepsList) { SIM.steps.value = steps; r.compute(resim); await idle();
      const ts = []; for (let i = 0; i < reps; i++) { const t0 = performance.now(); r.compute(resim); await idle(); ts.push(performance.now() - t0); }
      ts.sort((a, b) => a - b); out[steps] = +ts[ts.length >> 1].toFixed(3); }
    const t1 = []; for (let i = 0; i < reps; i++) { const t0 = performance.now(); r.compute(step1); await idle(); t1.push(performance.now() - t0); } t1.sort((a, b) => a - b);
    return { n: SIM_N, dt: DT, resimMs: out, oneStepMs: +t1[t1.length >> 1].toFixed(3) };
  };
  const readSim = async () => new Uint32Array(await r.getArrayBufferAsync(simPos.value));
  const simDeterminism = async (steps = 240) => {
    SIM.steps.value = steps; r.compute(resim); await idle(); const a = await readSim();
    r.compute(resim); await idle(); const b = await readSim();
    r.compute(initK); for (let i = 0; i < steps; i++) r.compute(step1); await idle(); const c = await readSim();
    let ab = 0, ac = 0, maxd = 0; const fa = new Float32Array(a.buffer), fc = new Float32Array(c.buffer);
    for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) ab++; if (a[i] !== c[i]) { ac++; maxd = Math.max(maxd, Math.abs(fa[i] - fc[i])); } }
    return { steps, values: a.length, resimTwiceDiffer: ab, resimVsIncrementalDiffer: ac, maxAbsDiff: maxd };
  };
  const sortBench = async (reps = 8) => {   // the key kernel and the full bitonic sort, timed as compute passes (wall, submit to done)
    SU.cam.value.copy(camera.position); SU.age.value = state.age; r.compute(keyKernel); sorter.compute(r); await idle();
    const ts = []; for (let i = 0; i < reps; i++) { const t0 = performance.now(); r.compute(keyKernel); sorter.compute(r); await idle(); ts.push(performance.now() - t0); }
    ts.sort((a, b) => a - b); return { n: SMOKE_N, steps: sorter.stepCount, wallMs: +ts[ts.length >> 1].toFixed(3) };
  };
  const setEvent = over => { state.ev = { id: 'lookdev', kind: 'spellBurst', t: 0, dur: 2.4, seed: 1, ...over }; };

  window.VS = { renderer: r, scene, camera, U, SU, SIM, state, render, save, bench, gpuTimes, setView, VIEWS, setLighting, setEvent, simBench, simDeterminism, sortBench,
    particleCount: () => particleCount(state.ev), origin, W, H, idle };
  $('age').value = state.age; $('light').checked = state.light > 0; $('lighting').value = state.lighting; $('smoke').value = state.smoke;
  $('age').oninput = e => { state.age = +e.target.value; render(); };
  $('light').onchange = e => { state.light = e.target.checked ? 1 : 0; render(); };
  $('lighting').onchange = e => { setLighting(e.target.value); render(); };
  $('smoke').onchange = e => { state.smoke = e.target.value; render(); };
  render();
  $('info').textContent = `${PROPS.length} PSX models · ${W}x${H} · ${r.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2'}`;
  window.VS_READY = true;
}
boot().catch(e => { console.error(e); $('info').textContent = 'Failed: ' + e.message; window.VS_ERROR = String(e.stack || e); });
