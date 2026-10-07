// Builds a three.js scene from the scene document and renders evaluated frames with the Black Page look.
// WebGPURenderer (falls back to WebGL2 by itself) with TSL materials; no colour management, like the engine.
import * as THREE from 'three/webgpu';
import { mrt, output, vec2, vec3, vec4, float, positionWorld, cameraPosition, uniform, uv, Fn, texture, mix, select, abs, exp, max, luminance } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { bodyMaterial, crtMaterial, glowMaterial, makeLightUniforms } from './materials.js';
import { makePost } from './post.js';
import { makeHaze } from './haze.js';
import { makeScreenShadows, makePointShadows } from './shadows.js';
import { makeAO } from './ao.js';
import { makeHazeShadow } from './haze_shadow.js';
import { makeRTShadows } from './rt_shadows.js';
import { makeRTLighting } from './rt_lighting.js';
import { makeComposite, makeHazeMeter, makeEmitAverage, flatScreenQuad } from './final_comp.js';
import { indexDoc } from '../core/evaluate.js';
import { add, scl, xf, nrm, trsOf } from '../core/vec.js';

/** Asset reference -> URL. psx:, wii:, bp: are read-only mounts of the original folders on the dev server;
 *  rel: is relative to the page (the artifact build); data: passes through. */
export const assetUrl = ref => {
  if (ref.startsWith('data:')) return ref;
  const [ns, ...rest] = ref.split(':'), p = rest.join(':').split('/').map(encodeURIComponent).join('/');
  if (ns === 'rel') return p;
  return ({ psx: '/psx/', wii: '/wii/', bp: '/bp/' }[ns] || '/') + p;
};
// ImageBitmap, not <img>.decode(): decode() never settles while the tab is hidden, and renders run in background tabs.
const loadImage = async src => createImageBitmap(await (await fetch(src)).blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
/** Parts of the look the editor can turn off in its viewport (all on for renders). */
export const SHOW = { haze: true, dof: true, lens: true, glows: true, ghosts: true, pops: true, shafts: false, softShadows: false, contact: false, hazeShadow: false, rtShadows: false,
  rtGI: false, rtAO: false, rtRefl: false, rtPT: false };
/** The shadow and ray-traced lighting toggles (research): off by default; renders to disk follow the viewport's choice. */
export const SHADOW_KEYS = ['shafts', 'softShadows', 'contact', 'hazeShadow', 'rtShadows', 'rtGI', 'rtAO', 'rtRefl', 'rtPT'];
/** Forward, right and up of an evaluated camera (eye, target, up). */
const camBasis = c => {
  const f = nrm(c.target.map((v, i) => v - c.eye[i])), rr = nrm([f[1] * c.up[2] - f[2] * c.up[1], f[2] * c.up[0] - f[0] * c.up[2], f[0] * c.up[1] - f[1] * c.up[0]]);
  return [f, rr, [rr[1] * f[2] - rr[2] * f[1], rr[2] * f[0] - rr[0] * f[2], rr[0] * f[1] - rr[1] * f[0]]];
};
const m4 = a => new THREE.Matrix4().fromArray(Array.from(a));
const v3 = a => new THREE.Vector3(...a);

export class ShotRenderer {
  constructor(canvas, doc, { forceWebGL = false, trackTimestamp = false } = {}) {
    this.canvas = canvas; this.doc = doc; this.ix = indexDoc(doc); this.forceWebGL = forceWebGL; this.trackTimestamp = trackTimestamp;
    this.W = doc.output.width; this.H = doc.output.height;
  }

  /** chatCanvas: the tall chat texture; flatCanvas / popsCanvas: the full-frame chat and pops layers (composited here). */
  async init(chatCanvas, { flatCanvas = null, popsCanvas = null } = {}) {
    const { doc, ix } = this;
    THREE.ColorManagement.enabled = false;
    const r = this.renderer = new THREE.WebGPURenderer({ canvas: this.canvas, antialias: false, alpha: false, forceWebGL: this.forceWebGL, trackTimestamp: this.trackTimestamp });
    r.setPixelRatio(1); r.setSize(this.W, this.H, false);
    r.outputColorSpace = THREE.LinearSRGBColorSpace; r.toneMapping = THREE.NoToneMapping;
    r.setClearColor(0x000000, 1);
    await r.init();
    this.backend = r.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2';

    const scene = this.scene = new THREE.Scene();
    const U = this.U = makeLightUniforms();
    this.camera = new THREE.PerspectiveCamera(30, this.W / this.H, 0.01, 100);
    this.geo = { centres: {}, wii: null };

    // chat texture: the 2D layer drawn into the tall canvas each frame
    const chatTex = this.chatTex = new THREE.CanvasTexture(chatCanvas);
    Object.assign(chatTex, { flipY: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.NoColorSpace });
    // ghost atlas, built like the engine's (images side by side, 2 px gutters, alpha used as the matte)
    const ghostKeys = Object.keys(doc.assets).filter(k => k.startsWith('ghost_'));
    const ims = await Promise.all(ghostKeys.map(k => loadImage(assetUrl(doc.assets[k]))));
    const AW = ims.reduce((s, im) => s + im.width + 4, 0), AH = Math.max(...ims.map(im => im.height)) + 4, ac = document.createElement('canvas'); ac.width = AW; ac.height = AH;
    const ax = ac.getContext('2d'); this.ghostRects = {}; let gx = 2;
    ims.forEach((im, i) => { ax.drawImage(im, gx, 2); this.ghostRects[ghostKeys[i]] = { r: [gx / AW, 2 / AH, (gx + im.width) / AW, (2 + im.height) / AH], aspect: im.width / im.height }; gx += im.width + 4; });
    const ghostTex = new THREE.CanvasTexture(ac);
    Object.assign(ghostTex, { flipY: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.NoColorSpace });

    const loader = new GLTFLoader();
    // Artifacts don't serve .glb, so the artifact build ships models as base64 text. Their embedded textures then load
    // through blob: URLs; <img> (TextureLoader) is used there because fetch() of a blob: URL may be refused by the CSP.
    if (window.VS_CONFIG?.imgTextures) loader.register(parser => { parser.textureLoader = new THREE.TextureLoader(parser.options.manager); return { name: 'VS_img_textures' }; });
    const loadModel = async ref => {
      const url = assetUrl(ref);
      if (!url.endsWith('.glb.txt')) return loader.loadAsync(url);
      const bin = Uint8Array.from(atob((await (await fetch(url)).text()).trim()), c => c.charCodeAt(0));
      return loader.parseAsync(bin.buffer, '');
    };
    const sh = this.shadows = makeScreenShadows(doc.look.shadows?.screen), rsh = this.ringShadows = makePointShadows(doc.look.shadows?.ring);
    // ray tracing reads storage buffers in the surface shader: WebGPU only
    const rts = this.rtShadows = this.forceWebGL ? null : makeRTShadows();
    // ray-traced lighting (GI, AO, reflections, path-traced stills): the same tracer, lit by the screen's light grid
    const rt = (w, h, o = {}) => new THREE.RenderTarget(w, h, { depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.UnsignedByteType, ...o });
    const HZ0 = doc.look.haze;
    if (HZ0) { const [gx, gy] = HZ0.grid; this.emitHiRT = rt(gx * 32, gy * 32); this.emitRT = rt(gx, gy, { type: THREE.HalfFloatType }); }   // linear: the Play grid samples between cells
    const rtl = this.rtl = this.forceWebGL || !HZ0 ? null : makeRTLighting({ look: doc.look.rtLighting });
    const rtlOpt = rtl ? { R: rtl, emitTex: this.emitRT.texture, hiTex: this.emitHiRT.texture } : null;
    const ledRect = ix.obj.led.texelRect, ledTargets = new Set(ix.obj.led.appliesTo || []);
    this.ledParts = []; this.placed = {};
    for (const o of doc.objects) {
      if (o.type !== 'model') continue;
      const gltf = await loadModel(doc.assets[o.asset]);
      const root = gltf.scene; root.matrixAutoUpdate = false; root.matrix.copy(m4(trsOf(o.transform))); root.userData.base = root.matrix.clone();
      root.userData.docId = o.id; this.placed[o.id] = root;
      root.updateMatrixWorld(true);
      const ledRe = o.ledParts ? new RegExp(o.ledParts, 'i') : null;
      const meshes = []; root.traverse(n => { if (n.isMesh) meshes.push(n); });
      const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9], rootInv = root.matrixWorld.clone().invert();
      for (const mesh of meshes) {
        const src = mesh.material, geom = mesh.geometry, pos = geom.attributes.position;
        for (const t of [src.map, src.emissiveMap]) if (t) Object.assign(t, { colorSpace: THREE.NoColorSpace, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
          generateMipmaps: false, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, needsUpdate: true });
        // bounds in the model's own (root) space, as the engine measured them
        const toRoot = rootInv.clone().multiply(mesh.matrixWorld), p = new THREE.Vector3(), a0 = [1e9, 1e9, 1e9], a1 = [-1e9, -1e9, -1e9];
        for (let i = 0; i < pos.count; i++) { p.fromBufferAttribute(pos, i).applyMatrix4(toRoot); const q = p.toArray(); for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], q[c]); mx[c] = Math.max(mx[c], q[c]); a0[c] = Math.min(a0[c], q[c]); a1[c] = Math.max(a1[c], q[c]); } }
        const nodeName = mesh.name || (mesh.parent && mesh.parent.name) || '';
        const isScreen = o.screen && new RegExp(o.screen.primitive.materialName, 'i').test(src.name || '') && pos.count <= o.screen.primitive.maxVertices;
        if (isScreen) {
          const uvA = geom.attributes.uv; let u0 = [1e9, 1e9], u1 = [-1e9, -1e9];
          for (let i = 0; i < uvA.count; i++) { u0 = [Math.min(u0[0], uvA.getX(i)), Math.min(u0[1], uvA.getY(i))]; u1 = [Math.max(u1[0], uvA.getX(i)), Math.max(u1[1], uvA.getY(i))]; }
          mesh.material = this.crt = crtMaterial({ chatTex, ghostTex, ub: [...u0, ...u1], rtl: rtlOpt, LU: U }); this.crtMesh = mesh;
          this.screenUB = [...u0, ...u1];
          // glass uv -> world (least squares over the primitive's vertices): where each part of the image emits from
          const n = pos.count, Mw = mesh.matrixWorld; let S11 = 0, Su = 0, Sv = 0, Suu = 0, Suv = 0, Svv = 0; const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
          for (let i = 0; i < n; i++) { const w = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(Mw).toArray(), u = uvA.getX(i), v = uvA.getY(i);
            S11 += 1; Su += u; Sv += v; Suu += u * u; Suv += u * v; Svv += v * v; for (let c = 0; c < 3; c++) { R[0][c] += w[c]; R[1][c] += u * w[c]; R[2][c] += v * w[c]; } }
          const A = new THREE.Matrix3().set(S11, Su, Sv, Su, Suu, Suv, Sv, Suv, Svv).invert().elements;   // symmetric
          const coef = [0, 1, 2].map(r => [0, 1, 2].map(c => A[r * 3] * R[0][c] + A[r * 3 + 1] * R[1][c] + A[r * 3 + 2] * R[2][c]));
          const at = (u, v) => [0, 1, 2].map(c => coef[0][c] + coef[1][c] * u + coef[2][c] * v);
          const p00 = at(u0[0], u0[1]), p10 = at(u1[0], u0[1]), p01 = at(u0[0], u1[1]);
          this.glassMap = { p00, eu: p10.map((x, c) => x - p00[c]), ev: p01.map((x, c) => x - p00[c]) };
          continue;
        }
        const isLed = ledRe && ledRe.test(nodeName);
        const ov = isLed ? uniform(new THREE.Vector4(0, 0, 0, 0)) : null;
        mesh.material = bodyMaterial(U, { map: src.map, emissiveMap: src.emissiveMap, ledRect: ledTargets.has(o.id) ? ledRect : [2, 2, 2, 2], ov, sh, rsh: o.ring ? null : rsh, rts, rtl: rtlOpt });
        mesh.userData.rt = { map: src.map, mul: 1 };   // albedo for rays that hit it
        if (isLed) this.ledParts.push({ mesh, ov, c0: a0.map((v, c) => (v + a1[c]) / 2) });
      }
      const M = Array.from(root.matrix.elements), ctrLocal = mn.map((v, c) => (v + mx[c]) / 2);
      this.geo.centres[o.id] = xf(M, ctrLocal); root.userData.ctrLocal = ctrLocal;
      if (o.ring) this.ringNode = root;
      if (o.ring) this.geo.wii = { M, ctr: xf(M, ctrLocal), up: nrm([M[4], M[5], M[6]]), leds: this.ledParts.map(l => l.c0) };
      if (o.id === 'wii') this.wiiRoot = root;
      scene.add(root);
    }
    // cards (polaroid, tape): a unit quad facing +Z, lit like the plastic
    const quad = new THREE.BufferGeometry();
    quad.setAttribute('position', new THREE.Float32BufferAttribute([-.5, -.5, 0, .5, -.5, 0, .5, .5, 0, -.5, .5, 0], 3));
    quad.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
    quad.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    for (const o of doc.objects.filter(o => o.type === 'card')) {
      const im = await loadImage(assetUrl(doc.assets[o.texture])), tx = new THREE.Texture(im);
      Object.assign(tx, { flipY: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.NoColorSpace, needsUpdate: true });
      const mesh = new THREE.Mesh(quad, bodyMaterial(U, { map: tx, scMul: 1.15, blMul: o.brightness || 1.4, rawLed: true, sh, rsh, rts, rtl: rtlOpt }));
      mesh.userData.rt = { map: tx, mul: 1.15 * (o.brightness || 1.4) };
      mesh.matrixAutoUpdate = false; mesh.matrix.copy(m4(trsOf(o.transform))); mesh.userData.docId = o.id; this.placed[o.id] = mesh; scene.add(mesh);
    }
    // glows: four for the ringing LEDs, one for the power LED
    const plane = new THREE.PlaneGeometry(2, 2);
    this.glows = [0, 1, 2, 3, 4].map(() => { const m = new THREE.Mesh(plane, glowMaterial()); m.matrixAutoUpdate = false; m.frustumCulled = false; m.visible = false; scene.add(m); return m; });

    // render targets: scene (MSAA, colour + distance), lens colour, circle of confusion, final
    this.sceneRT = new THREE.RenderTarget(this.W, this.H, { count: 2, samples: 4, depthBuffer: true, type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    this.sceneRT.textures[0].name = 'output';
    Object.assign(this.sceneRT.textures[1], { name: 'dist', type: THREE.HalfFloatType, format: THREE.RGFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.lensRT = rt(this.W, this.H);
    this.cocRT = rt(this.W, this.H, { type: THREE.HalfFloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.finalRT = rt(this.W, this.H);
    // Blending for MRT targets is read from the renderer-level MRT (not the material's mrtNode): 'dist' follows each
    // material, so opaque surfaces overwrite it and the additive glows (which output dist 0) leave it untouched.
    this.sceneMRT = mrt({ output, dist: vec4(positionWorld.distance(cameraPosition), 1, 0, 1) }).setBlendMode('dist', new THREE.BlendMode(THREE.MaterialBlending));
    this.aoRT = rt(Math.round(this.W / 2), Math.round(this.H / 2), { type: THREE.HalfFloatType, format: THREE.RedFormat });
    this.ao = makeAO({ distTex: this.sceneRT.textures[1], aoTex: this.aoRT.texture, look: doc.look.shadows?.contact });
    // ray-traced lighting accumulation: the RT scene pass (float), and the running mean the lens reads instead of the scene
    if (rtl) {
      this.ptRT = new THREE.RenderTarget(this.W, this.H, { count: 2, samples: 4, depthBuffer: true, type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
      this.ptRT.textures[0].name = 'output';   // MRT outputs bind to textures by name
      Object.assign(this.ptRT.textures[1], { name: 'dist', type: THREE.HalfFloatType, format: THREE.RGFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      this.accA = rt(this.W, this.H, { type: THREE.HalfFloatType }); this.accB = rt(this.W, this.H, { type: THREE.HalfFloatType });
      const qm = node => { const m = new THREE.NodeMaterial(); m.fragmentNode = node; m.depthTest = false; m.depthWrite = false; return new THREE.QuadMesh(m); };
      this.accW = uniform(1);
      const cur = texture(this.ptRT.textures[0]), prev = texture(this.accA.texture), prevB = texture(this.accB.texture);
      this.accQuad = qm(Fn(() => { const a = cur.sample(uv()); return select(this.accW.greaterThanEqual(1), vec4(a.rgb, 1), vec4(mix(prev.sample(uv()).rgb, a.rgb, this.accW), 1)); })());
      this.accCopy = qm(Fn(() => prevB.sample(uv()))());
    }
    this.post = makePost({ src: this.sceneRT.textures[0], zs: this.sceneRT.textures[1], lens: this.lensRT.texture, coc: this.cocRT.texture, final: this.finalRT.texture, alt: rtl ? this.accA.texture : null });

    // final look: haze, layers and the composite (doc.look.haze, doc.layers)
    const tex2d = c => { const t = new THREE.CanvasTexture(c || document.createElement('canvas'));
      Object.assign(t, { flipY: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.NoColorSpace }); return t; };
    this.flatTex = tex2d(flatCanvas); this.popsTex = tex2d(popsCanvas);
    const HZ = doc.look.haze;
    this.hazeRT = rt(Math.round(this.W * 0.75), Math.round(this.H * 0.75), { type: THREE.HalfFloatType });
    if (HZ) {
      const [gx, gy] = HZ.grid;
      const ub = this.screenUB, crtColor = this.crt.userData.color;
      this.emitFlat = flatScreenQuad(Fn(() => crtColor(vec2(ub[0], ub[1]).add(uv().mul(vec2(ub[2] - ub[0], ub[3] - ub[1])))))());
      this.emitAvg = makeEmitAverage({ hiTex: this.emitHiRT.texture, gx, gy });
      this.emitAvg.U.screenLight.value = HZ.screenLight ?? 100;
      this.hazeShadow = makeHazeShadow({ hazeU: () => this.haze.U, look: HZ });
      this.haze = makeHaze({ distTex: this.sceneRT.textures[1], emitTex: this.emitRT.texture, look: HZ, shadows: this.shadows, ringShadows: this.ringShadows, selfShadow: this.hazeShadow });
      this.meterRT = rt(480, 270, { type: THREE.FloatType });
      this.meter = makeHazeMeter({ hazeTex: this.hazeRT.texture });
    }
    this.comp = makeComposite({ engineTex: this.finalRT.texture, flatTex: this.flatTex, popsTex: this.popsTex, hazeTex: this.hazeRT.texture });
    return this;
  }

  /** Render one evaluated frame to the canvas: the 3D shot (into finalRT), the haze, then the composite with the 2D
   *  layers. opts: { flat: the flat chat canvas changed, pops: the pops canvas has content, haze: render the haze,
   *  final: composite the haze and pops (false = the engine picture alone), quality: 'render' | 'play' }.
   *  Play quality trades sampling for speed (haze at a quarter of the scene buffer, 3x longer steps and a 10x5 light
   *  grid; a sparser depth-of-field gather); framing, timing and the look's settings are the same. */
  render(st, opts = {}) {
    const job = this.renderSteps(st, opts);
    while (!job.next().done) { /* all at once */ }
  }

  /** render() in steps, for the editor: the 3D pass, then the haze ray march in `slices` horizontal bands, then the
   *  composite, yielding between them so a new edit can drop the job (about 15–25 ms each at 16 slices).
   *  The picture is the same as render()'s. opts.show turns parts of the look off in the viewport (see SHOW). */
  *renderSteps(st, opts = {}) {
    const r = this.renderer, final = opts.final !== false, show = { ...SHOW, ...opts.show }, n = Math.max(1, opts.slices || 1);
    this.quality = opts.quality || 'render'; this.show = show;
    if (st.cut) { r.setRenderTarget(this.finalRT); r.clear(); r.setRenderTarget(null); r.clear(); return; }
    if (!show.lens) st = { ...st, camera: { ...st.camera, k: 0, ov: 1, fovRender: st.camera.fov } };
    const hazeOn = !!(final && this.haze && show.haze && opts.haze !== false && st.haze && st.haze.gain > 0 && !st.flat.before);
    if (!st.flat.before) {
      this.render3D(st, show, opts.upload);
      if (hazeOn) {
        if (n > 1) yield;
        this.prepHaze(st);
        for (let i = 0; i < n; i++) { this.marchSlice(i, n); if (i < n - 1) yield; }
      }
    }
    const up = opts.upload || {};   // which 2D layers were redrawn since the last frame (default: all)
    if (opts.flat !== false && up.flat !== false) this.flatTex.needsUpdate = true;
    if (opts.pops && up.pops !== false) this.popsTex.needsUpdate = true;
    const C = this.comp.U, c = st.camera;
    C.before.value = st.flat.before ? 1 : 0; C.overlay.value = st.flat.overlay; C.gain.value = st.haze ? st.haze.gain : 0;
    C.hazeOn.value = hazeOn ? 1 : 0; C.popsOn.value = final && opts.pops && show.pops ? 1 : 0;
    C.k.value = c.k; C.sq.value = c.squint; C.aspect.value = this.W / this.H;
    C.blur.value = this.quality === 'play' ? 1.0 / this.hazeRT.width : 0;
    this.mark('composite'); r.setRenderTarget(null); this.comp.quad.render(r);
  }

  /** The haze for this frame: the screen's light grid, then the ray march into hazeRT (a fraction of the scene buffer). */
  renderHaze(st) { this.prepHaze(st); this.marchSlice(0, 1); }

  /** Band i of n of the haze ray march (n = 1: all of it). Bands are scissored and drawn without clearing. */
  marchSlice(i, n) {
    const r = this.renderer, rt = this.hazeRT, march = this.quality === 'play' ? this.haze.marchPlay : this.haze.march;
    r.setRenderTarget(rt);
    this.mark(n === 1 ? 'haze march' : `haze march ${i + 1}/${n}`);
    if (n === 1) { march.render(r); return; }
    const y0 = Math.floor(rt.height * i / n), y1 = Math.floor(rt.height * (i + 1) / n), ac = r.autoClear;
    rt.scissor.set(0, y0, rt.width, y1 - y0); r.autoClear = false; r.setScissorTest(true);
    march.render(r);
    r.setScissorTest(false); r.autoClear = ac;
  }

  /** Light grid and march uniforms for this frame, and hazeRT sized for the quality. */
  prepHaze(st) {
    const r = this.renderer, H = this.haze.U, c = st.camera, gm = this.glassMap, R = st.ring, led = st.led, HZ = this.doc.look.haze;
    this.emitAvg.U.screenLight.value = HZ.screenLight ?? 100;
    this.mark('haze light grid'); r.setRenderTarget(this.emitHiRT); this.emitFlat.render(r);
    this.mark('haze light grid avg'); r.setRenderTarget(this.emitRT); this.emitAvg.quad.render(r);
    const [f, rr, uu] = camBasis(c);
    H.eye.value.set(...c.eye); H.cf.value.set(...f); H.cr.value.set(...rr); H.cu.value.set(...uu);
    H.tanY.value = Math.tan(c.fovRender * Math.PI / 360); H.aspect.value = this.W / this.H; H.t.value = st.t; H.frame.value = st.frame;
    H.g00.value.set(...gm.p00); H.geu.value.set(...gm.eu); H.gev.value.set(...gm.ev); H.gn.value.set(...this.ix.glass.n);
    const lin = x => x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4), I4 = 1 / (4 * Math.PI);
    const ringW = R ? (HZ.ringW ?? 0.06) * (R.ember + R.lvl * R.I) : 0;
    H.ringPos.value.set(...(R ? R.pos : [0, -10, 0])); H.ringI.value.set(...(R ? R.col.map(v => lin(v) * ringW * I4 * (HZ.ringGain ?? 1)) : [0, 0, 0]));
    const ledW = (HZ.ledW ?? 0.006) * (led.intensity > 0 ? 1 : 0);
    H.ledPos.value.set(...add(led.pos, scl(led.n, this.ix.glass.W * 0.012))); H.ledI.value.set(...led.color.map(v => lin(v) * ledW * I4));
    const play = this.quality === 'play', PQ = HZ.play || {}, res = play ? (PQ.resolution ?? 0.25) : (HZ.resolution ?? 0.5);
    H.stepLen.value = (HZ.stepLen ?? 0.015) * (play ? (PQ.stepScale ?? 3) : 1);
    const hw = Math.round(this.sceneRT.width * res), hh = Math.round(this.sceneRT.height * res);
    if (this.hazeRT.width !== hw || this.hazeRT.height !== hh) this.hazeRT.setSize(hw, hh);
    // haze self-shadowing (Show menu, off by default): this frame's density and light-transmittance volumes
    const SS = this.hazeShadow, ssOn = !!this.show?.hazeShadow; SS.U.on.value = ssOn ? 1 : 0;
    if (ssOn) SS.update(r, { gm, ringPos: R ? R.pos : null, mark: n => this.mark(n) });
  }

  /** Mean luminance of this frame's lens-warped, ungained haze (call after render()). */
  async hazeLevel(st) {
    const r = this.renderer, M = this.meter.U, c = st.camera;
    M.k.value = c.k; M.sq.value = c.squint; M.aspect.value = this.W / this.H;
    r.setRenderTarget(this.meterRT); this.meter.quad.render(r); r.setRenderTarget(null);
    const px = await r.readRenderTargetPixelsAsync(this.meterRT, 0, 0, 480, 270);
    let s = 0; for (let i = 0; i < 480 * 270; i++) s += px[i * 4];
    return s / (480 * 270) / this.haze.U.exposure.value;   // at exposure 1
  }

  render3D(st, show = SHOW, upload = {}) {
    const { renderer: r, U, ix, post } = this, g = ix.glass, W_ = g.W, c = st.camera;
    if (upload.chat !== false) this.chatTex.needsUpdate = true;   // a 1920x1330 copy: only when the chat was redrawn
    // camera
    const cam = this.camera; cam.fov = c.fovRender; cam.near = c.near; cam.far = c.far; cam.aspect = this.W / this.H;
    cam.position.set(...c.eye); cam.up.set(...c.up); cam.lookAt(v3(c.target)); cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
    // lights and look
    const rk = st.revealK, L = st.lighting;
    U.sp.value.set(...add(g.ctr, scl(g.n, W_ * (this.spFwd ?? .06)))); U.sn.value.set(...g.n); U.sc.value.set(...st.glowCol);   // spFwd: research hook (re-tuning the fake against RT)
    if (this.glassMap) { const gm = this.glassMap; U.ga.value.set(...gm.p00); U.gu.value.set(...gm.eu); U.gv.value.set(...gm.ev); }
    U.area.value = this.fakeArea ? 1 : 0; U.aRef.value = this.rtl?.U.refDist.value ?? 0.5;   // research hook: the screen as an area light
    U.amb.value = L.ambient; U.si.value = L.screen; U.bp.value.set(...L.bouncePos); U.bi.value = L.bounce; U.bl.value = rk;
    const led = st.led; U.lp.value.set(...add(led.pos, scl(led.n, W_ * .004))); U.lpRaw.value.set(...led.pos); U.lc.value.set(...led.color);
    U.li.value = led.intensity; U.lrad.value = W_ * .035;
    U.eStr.value = (ix.obj.wii.emission ?? 1.5) * rk;
    const R = st.ring;
    U.rp.value.set(...(R ? R.pos : [0, 0, 0])); U.rc.value.set(...(R ? R.col : [0, 0, 0])); U.ri.value = R ? R.lvl * R.light : 0; U.rrad.value = R ? R.rad : 1;
    for (const p of this.ledParts) p.ov.value.set(...(R ? [...R.col.map(v => v * (R.ember + R.lvl * R.I)), 1] : [0, 0, 0, 0]));
    if (this.wiiRoot) { this.wiiRoot.matrix.copy(this.wiiRoot.userData.base); if (R && R.rum) this.wiiRoot.matrix.premultiply(m4(R.rum)); this.wiiRoot.updateMatrixWorld(true); }
    // screen
    const S = this.crt.userData.S; S.fx.value = rk; S.time.value = st.t;
    for (let i = 0; i < 4; i++) {
      const gh = st.ghosts[i], R_ = gh && this.ghostRects[gh.img];
      if (!R_) { S.ga.array[i] = 0; continue; }
      const h = gh.h || 0.5, w = h * R_.aspect * (g.H / g.W);
      S.gr.array[i].set(...R_.r); S.gp.array[i].set(gh.x ?? .5, gh.y ?? .5, w, h); S.ga.array[i] = show.ghosts ? gh.level : 0; S.gm.array[i] = gh.mirror === false ? 0 : 1;
    }
    // glows (in the glass plane)
    this.glows.forEach(m => { m.visible = false; });
    const setGlow = (m, ctr, s, col, a) => { m.visible = show.glows; m.matrix.set(g.r[0] * s, g.u[0] * s, g.n[0], ctr[0], g.r[1] * s, g.u[1] * s, g.n[1], ctr[1], g.r[2] * s, g.u[2] * s, g.n[2], ctr[2], 0, 0, 0, 1);
      m.material.userData.G.col.value.set(...col); m.material.userData.G.a.value = a; };
    // the glows hide with their object in the viewport (the ring's with the remote, the power LED's with the model it sits on)
    if (R && R.lvl > 0.01 && R.glow > 0 && this.ringNode?.visible !== false) R.leds.forEach((p, i) => setGlow(this.glows[i], p, 0.007 * R.glow, R.col, R.lvl * 0.5));
    if (led.intensity > 0 && (!this.anyHidden || this.ledHost()?.visible !== false)) setGlow(this.glows[4], add(led.pos, scl(led.n, W_ * .006)), W_ * .03 * led.size, led.color, led.intensity * .6);
    // shadow maps (the screen's patches, the ringing remote's cube), when a shadow toggle is on (redrawn only when something that casts has moved)
    const SH = this.shadows; SH.U.shafts.value = show.shafts ? 1 : 0; SH.U.surface.value = show.softShadows ? 1 : 0;
    const RS = this.ringShadows; RS.U.shafts.value = SH.U.shafts.value; RS.U.surface.value = SH.U.surface.value;
    const RT = this.rtShadows; if (RT) { RT.U.on.value = show.rtShadows ? 1 : 0; RT.U.frame.value = st.frame || 0; RT.U.rays.value = this.quality === 'play' ? 4 : 16;
      if (show.rtShadows) { this.mark('rt shadows (cpu bvh)'); RT.update(Object.values(this.placed), [this.crtMesh, ...this.glows], this.glassMap); } }
    // ray-traced lighting (Show menu, off by default)
    const RL = this.rtl, rtOn = !!(RL && (show.rtGI || show.rtAO || show.rtRefl || show.rtPT));
    if (RL) {
      RL.U.gi.value = show.rtGI ? 1 : 0; RL.U.ao.value = show.rtAO ? 1 : 0; RL.U.refl.value = show.rtRefl ? 1 : 0; RL.U.pt.value = show.rtPT ? 1 : 0;
      RL.U.any.value = rtOn ? 1 : 0; RL.U.frame.value = st.frame || 0; RL.U.sample.value = 0; RL.setQuality(this.quality);
    }
    if (rtOn) {
      this.mark('rt lighting (cpu bvh)'); RL.update(Object.values(this.placed), this.crtMesh, this.glassMap);
      if (this.emitFlat) {   // this frame's screen light grid (the haze draws it again later)
        this.emitAvg.U.screenLight.value = this.doc.look.haze.screenLight ?? 100; RL.U.screenLight.value = this.emitAvg.U.screenLight.value;
        this.mark('rt screen light grid'); r.setRenderTarget(this.emitHiRT); this.emitFlat.render(r); r.setRenderTarget(this.emitRT); this.emitAvg.quad.render(r);
      }
    }
    const accum = rtOn && (show.rtPT || RL.accumulate); this.rtAccum = accum ? 0 : -1;
    if (show.shafts || show.softShadows) {
      const casters = Object.values(this.placed), mark = n => this.mark(n);
      SH.update(r, this.scene, { gm: this.glassMap, n: g.n, hide: [this.crtMesh, ...this.glows], casters, mark });
      if (R) RS.update(r, this.scene, { pos: R.pos, hide: this.glows, casters, mark });   // the remote's light, while it rings
    }
    // scene pass: the buffer grows with the lens overscan so the centre stays sharp
    const scale = c.k > 1e-4 ? Math.min(2, Math.ceil(c.ov * 2) / 2) : 1, sw = Math.round(this.W * scale), sh = Math.round(this.H * scale);
    if (this.sceneRT.width !== sw || this.sceneRT.height !== sh) this.sceneRT.setSize(sw, sh);
    if (accum) RL.U.any.value = 0;   // accumulating: a plain pass for the distance buffer (haze, focus), then the RT pass
    if (rtOn && !accum && this.rtPrepass) this.prepassScene(this.sceneRT, 'scene');
    else { this.mark('scene'); r.setMRT(this.sceneMRT); r.setRenderTarget(this.sceneRT); r.clear(); r.render(this.scene, cam); r.setMRT(null); }
    if (accum) { RL.U.any.value = 1; this.rtPass(); }
    if (RL) post.U.alt.value = accum ? 1 : 0;
    this.postState = { c, sw, sh, show, st };
    this.post3D();
  }

  /** Depth pre-pass for the ray-traced lighting (research; `rtPrepass`, off by default): the scene is drawn once with
   *  the ray tracing off (cheap: it lays depth and the distance pass), then again with the opaque materials testing
   *  depth-equal and not writing depth, so only the front surface of each sample runs the tracer. The body shader has
   *  Discard (alpha cut-outs), which turns early depth testing off when it writes depth; with depth writes off in the
   *  second pass the test can run before the shader. The glows (additive) are left out of the first pass. */
  prepassScene(target, name) {
    const r = this.renderer, RL = this.rtl, any = RL.U.any.value;
    if (!this.opaqueMats) { this.opaqueMats = new Set(); const glow = new Set(this.glows.map(g => g.material));
      this.scene.traverse(m => { if (m.isMesh && !m.material.transparent && !glow.has(m.material)) this.opaqueMats.add(m.material); }); }
    const gv = this.glows.map(g => g.visible); this.glows.forEach(g => { g.visible = false; });
    RL.U.any.value = 0;
    this.mark(name + ' depth pre-pass'); r.setMRT(this.sceneMRT); r.setRenderTarget(target); r.clear(); r.render(this.scene, this.camera);
    RL.U.any.value = any; this.glows.forEach((g, i) => { g.visible = gv[i]; });
    for (const m of this.opaqueMats) { m.depthFunc = THREE.EqualDepth; m.depthWrite = false; }
    const ac = r.autoClear; r.autoClear = false;
    this.mark(name); r.render(this.scene, this.camera);
    r.autoClear = ac; r.setMRT(null);
    for (const m of this.opaqueMats) { m.depthFunc = THREE.LessEqualDepth; m.depthWrite = true; }
  }

  /** Research: an edge-aware a-trous filter (5x5 B3-spline taps at steps 1, 2, 4, ...) over the accumulated ray-traced
   *  image (accA), weighted by distance (from the RT pass's distance attachment) and luminance; then lens, focus and the
   *  composite again. Not wired to a toggle: called by tools/rt_eval.js to compare against accumulation. */
  denoiseRT(iters = 3, { sigmaZ = 0.01, sigmaL = 0.25 } = {}) {
    if (!this.rtl || this.rtAccum < 1) return false;
    const r = this.renderer;
    if (!this.dn) {
      const U = { step: uniform(1), px: uniform(new THREE.Vector2()), sz: uniform(sigmaZ), sl: uniform(sigmaL) }, zt = texture(this.ptRT.textures[1]);
      const k = [1 / 16, 1 / 4, 3 / 8, 1 / 4, 1 / 16];
      const mk = srcTex => { const src = texture(srcTex); const m = new THREE.NodeMaterial(); m.depthTest = m.depthWrite = false;
        m.fragmentNode = Fn(() => {
          const c0 = src.sample(uv()).rgb, z0 = zt.sample(uv()).r, l0 = luminance(c0), sum = vec3(0).toVar(), ws = float(0).toVar();
          for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
            const o = uv().add(vec2(i, j).mul(U.px).mul(U.step)), c = src.sample(o).rgb, z = zt.sample(o).r;
            const w = exp(abs(z.sub(z0)).div(max(z0.mul(U.sz), 1e-4)).negate().sub(abs(luminance(c).sub(l0)).div(U.sl))).mul(k[i + 2] * k[j + 2]);
            sum.addAssign(c.mul(w)); ws.addAssign(w);
          }
          return vec4(sum.div(max(ws, 1e-6)), 1);
        })(); return new THREE.QuadMesh(m); };
      this.dn = { U, aToB: mk(this.accA.texture), bToA: mk(this.accB.texture) };
    }
    const U = this.dn.U; U.sz.value = sigmaZ; U.sl.value = sigmaL; U.px.value.set(1 / this.accA.width, 1 / this.accA.height);
    for (let i = 0; i < iters; i++) {
      U.step.value = 2 ** i; this.mark('rt denoise');
      if (i % 2 === 0) { r.setRenderTarget(this.accB); this.dn.aToB.render(r); } else { r.setRenderTarget(this.accA); this.dn.bToA.render(r); }
    }
    if (iters % 2 === 1) { r.setRenderTarget(this.accA); this.accCopy.render(r); }
    this.post3D(); this.mark('composite'); r.setRenderTarget(null); this.comp.quad.render(r);
    return true;
  }

  /** One ray-traced pass into ptRT, folded into the running mean (accA) that the lens reads. */
  rtPass() {
    const r = this.renderer, n = this.rtAccum, w = this.sceneRT.width, h = this.sceneRT.height;
    for (const t of [this.ptRT, this.accA, this.accB]) if (t.width !== w || t.height !== h) t.setSize(w, h);
    this.rtl.U.sample.value = n;
    if (this.rtPrepass) this.prepassScene(this.ptRT, n === 0 ? 'rt scene' : 'rt scene (refine)');
    else { this.mark(n === 0 ? 'rt scene' : 'rt scene (refine)'); r.setMRT(this.sceneMRT); r.setRenderTarget(this.ptRT); r.clear(); r.render(this.scene, this.camera); r.setMRT(null); }
    this.accW.value = 1 / (n + 1);
    this.mark('rt accumulate'); r.setRenderTarget(this.accB); this.accQuad.render(r); r.setRenderTarget(this.accA); this.accCopy.render(r);
    this.rtAccum = n + 1;
  }

  /** Progressive refinement of the ray-traced lighting while idle: one more sample pass, then lens, focus and the
   *  composite again (the haze from the last full render is reused). Returns the sample count, or false when nothing
   *  accumulates. */
  refineRT() {
    if (!this.rtl || this.rtAccum < 0 || !this.postState) return false;
    this.rtPass(); this.post3D();
    this.mark('composite'); this.renderer.setRenderTarget(null); this.comp.quad.render(this.renderer);
    return this.rtAccum;
  }

  /** Lens, contact shadows, circle of confusion and depth of field from the scene buffer (uniforms set by render3D). */
  post3D() {
    const r = this.renderer, post = this.post, { c, sw, sh, show, st } = this.postState;
    // lens + circle of confusion
    const P = post.U, F = st.focus, D = !!(show.dof && F && (F.px > 0 || F.edge > 0 || F.spot > 0));
    P.k.value = c.k; P.aspect.value = this.W / this.H; P.sq.value = c.squint;
    P.fD.value = D ? F.D : 0; P.ppd.value = D ? F.px : 0; P.band.value = D ? F.band : 0; P.maxc.value = D ? F.max : 0; P.edge.value = D ? F.edge : 0; P.es.value = D ? F.es : 1;
    P.sp.value.set(D ? F.sp[0] : .5, D ? 1 - F.sp[1] : .5); P.spot.value = D ? F.spot : 0; P.spr.value = D ? F.spotR : 1; P.spf.value = D ? F.spotF : 1;
    this.mark('lens'); r.setRenderTarget(this.lensRT); post.quads.lens.render(r);
    if (show.contact) this.contactAO(c, sw, sh);
    this.mark('focus (CoC)'); r.setRenderTarget(this.cocRT); post.quads.coc.render(r);
    const sc = this.H / 1080; P.px.value.set(1 / this.W, 1 / this.H); P.sc.value = sc; P.maxR.value = D ? F.max * sc : 0; P.rs.value = (this.quality === 'play' ? (this.doc.look.haze?.play?.dofStep ?? 2) : 0.5) * sc;
    this.mark('depth of field'); r.setRenderTarget(this.finalRT); post.quads.dof.render(r);
  }

  /** Contact shadows (Show menu, off by default): ambient obscurance from the distance pass at half the scene buffer,
   *  multiplied into the lens output before depth of field. */
  contactAO(c, sw, sh) {
    const r = this.renderer, A = this.ao.U, [f, rr, uu] = camBasis(c);
    const aw = Math.round(sw / 2), ah = Math.round(sh / 2);
    if (this.aoRT.width !== aw || this.aoRT.height !== ah) this.aoRT.setSize(aw, ah);
    A.eye.value.set(...c.eye); A.cf.value.set(...f); A.cr.value.set(...rr); A.cu.value.set(...uu);
    A.tanY.value = Math.tan(c.fovRender * Math.PI / 360); A.aspect.value = this.W / this.H; A.px.value.set(1 / aw, 1 / ah); A.bufH.value = ah; A.k.value = c.k;
    const g = this.ix.glass; A.gc.value.set(...g.ctr); A.gr.value.set(...g.r); A.gu.value.set(...g.u); A.gn.value.set(...g.n); A.gh.value.set(g.W / 2, g.H / 2);
    this.mark('contact AO'); r.setRenderTarget(this.aoRT); this.ao.pass.render(r);
    this.mark('contact AO apply'); const ac = r.autoClear; r.autoClear = false; r.setRenderTarget(this.lensRT); this.ao.apply.render(r); r.autoClear = ac;
  }

  /** After the document changed (editor commands, undo): re-index it and move placed objects to their transforms. */
  syncFromDoc(doc = this.doc) {
    this.doc = doc; this.ix = indexDoc(doc);
    for (const o of doc.objects) { const node = this.placed[o.id]; if (!node || !o.transform) continue;
      node.matrix.copy(m4(trsOf(o.transform))); if (node.userData.base) node.userData.base = node.matrix.clone(); node.updateMatrixWorld(true);
      const M = Array.from(node.matrix.elements);
      if (node.userData.ctrLocal) this.geo.centres[o.id] = xf(M, node.userData.ctrLocal);   // focus targets follow the object
      if (o.ring && this.geo.wii) Object.assign(this.geo.wii, { M, ctr: this.geo.centres[o.id], up: nrm([M[4], M[5], M[6]]) }); }
    if (this.haze) { const H = this.haze.U, HZ = doc.look.haze; H.exposure.value = HZ.exposure ?? 1; }
  }

  /** Render the scene from an editor camera (free view): the engine picture without lens warp, depth of field, haze
   *  or the flat layer, lit as after the reveal so it can be worked on before it. Helpers are drawn on top. */
  renderFree(st, cam, helpers, show, upload) {
    const r = this.renderer;
    const f = new THREE.Vector3(); cam.getWorldDirection(f);
    const eye = cam.position.toArray(), target = cam.position.clone().add(f).toArray(), up = cam.up.toArray();
    const fs = { ...st, cut: false, revealK: Math.max(st.revealK, 1), flat: { before: false, overlay: 0 }, focus: null, haze: null,
      led: { ...st.led, intensity: Math.max(st.led.intensity, 1) }, lighting: { ...st.lighting, ambient: Math.max(st.lighting.ambient, 0.3) },
      camera: { eye, target, up, fov: cam.fov, fovRender: cam.fov, k: 0, ov: 1, squint: 0, near: cam.near, far: cam.far } };
    this.render(fs, { final: false, flat: false, pops: false, quality: 'render', show, upload });
    if (helpers) { this.mark('helpers'); const ac = r.autoClear; r.autoClear = false; r.setRenderTarget(null); r.render(helpers, cam); r.autoClear = ac; }
  }

  /** The placed model whose bounds hold the power LED (null if none). */
  ledHost() {
    const p = v3(this.ix.obj.led.position), b = new THREE.Box3();
    return Object.values(this.placed).find(n => b.setFromObject(n).expandByScalar(0.005).containsPoint(p)) || null;
  }

  /** GPU timing per pass (WebGPU timestamp queries, when the adapter has them). mark() names the next pass: each
   *  gets its own number in three's query ids (renderer.info.frame, unused otherwise without an animation loop). */
  get canTime() { return !!(this.renderer.backend.isWebGPUBackend && this.renderer.backend.hasFeature?.('timestamp-query')); }
  setTiming(on) { this.timing = on && this.canTime; this.renderer.backend.trackTimestamp = this.timing; this.passNames ||= new Map(); this.passSeq ||= 0; }
  mark(name) { if (!this.timing) return; this.renderer.info.frame = ++this.passSeq; this.passNames.set(this.passSeq, name); }
  /** Resolve finished queries: [{ seq, name, ms }] for passes not reported before. */
  async gpuTimes() {
    if (!this.timing) return [];
    const r = this.renderer; await r.resolveTimestampsAsync('render');
    const pool = r.backend.timestampQueryPool?.render; if (!pool) return [];
    const out = [];
    for (const [uid, ms] of pool.timestamps) { const seq = +(uid.match(/:f(\d+)$/) || [])[1]; const name = this.passNames.get(seq);
      if (name === undefined) continue; this.passNames.delete(seq); out.push({ seq, name, ms }); }
    return out;
  }

  /** Hide placed objects in the viewport (ids), show the rest. */
  setHidden(ids) { for (const [id, node] of Object.entries(this.placed)) node.visible = !ids.has(id); this.anyHidden = ids.size > 0; }

  /** The visible placed object under a canvas point (ndc -1..1), or null. */
  pick(ndc, cam) {
    const rc = new THREE.Raycaster(); rc.setFromCamera(new THREE.Vector2(ndc[0], ndc[1]), cam);
    const hits = rc.intersectObjects(Object.values(this.placed).filter(n => n.visible), true);
    for (const h of hits) { let n = h.object; while (n && !n.userData.docId) n = n.parent; if (n) return n.userData.docId; }
    return null;
  }

  /** RGBA8 pixels of the last frame (top row first). The WebGL2 backend reads rows bottom-up, WebGPU top-down. */
  async readPixels() {
    const px = await this.renderer.readRenderTargetPixelsAsync(this.finalRT, 0, 0, this.W, this.H);
    const out = new Uint8ClampedArray(px.buffer, px.byteOffset, this.W * this.H * 4);
    if (this.backend === 'WebGPU') return out;
    const flipped = new Uint8ClampedArray(out.length), row = this.W * 4;
    for (let y = 0; y < this.H; y++) flipped.set(out.subarray((this.H - 1 - y) * row, (this.H - y) * row), y * row);
    return flipped;
  }
}
