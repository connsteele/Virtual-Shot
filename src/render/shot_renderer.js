// Builds a three.js scene from the scene document and renders evaluated frames with the Black Page look.
// WebGPURenderer (falls back to WebGL2 by itself) with TSL materials; no colour management, like the engine.
import * as THREE from 'three/webgpu';
import { mrt, output, vec2, vec4, positionWorld, cameraPosition, uniform, uv, Fn } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { bodyMaterial, crtMaterial, glowMaterial, makeLightUniforms } from './materials.js';
import { ps1Material, makePs1Uniforms } from './looks/ps1.js';
import { makePost, makeOutline } from './post.js';
import { makeHaze } from './haze.js';
import { makeComposite, makeHazeMeter, makeEmitAverage, makeAreaUpscale, makeBloom, flatScreenQuad } from './final_comp.js';
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
export const SHOW = { haze: true, dof: true, lens: true, glows: true, ghosts: true, pops: true };
/** The chunky-pixel look (off by default): the whole frame (3D, lens, depth of field, haze, 2D layers) is rendered at a
 *  480-line internal size, as an emulator renders a Wii game at native resolution, then area-upscaled to the output. */
export const PIXEL_LOOK = { lines: 480, output: [3840, 2160], msaa: false, bits: 6, sharpScreen: 1080, outlines: false, stable: false, bands: 0, bloom: 0 };
// Options: lines (internal height), msaa (keep the 4x MSAA, softer edges), bits (0 = 24-bit colour; 6 or 5 = that many bits
// per channel with an ordered dither), sharpScreen (the CRT's picture over the chunky frame at output resolution, true, or
// at that many lines, e.g. 1080), outlines (pixel outlines on silhouettes and creases), stable (pixel-stable camera),
// bands (banded lighting, steps per doubling; 0 = smooth), bloom (Wii-era bloom strength; 0 = none).
/** Material sets a look style can switch the lit surfaces to: name -> (renderer, light uniforms, bodyMaterial options) -> material.
 *  'default' is the Black Page body shader each surface is built with. Other looks register theirs here. */
export const MATERIAL_SETS = {
  ps1: (sr, U, o) => ps1Material(U, sr.ps1U ||= makePs1Uniforms(), o),
};
const m4 = a => new THREE.Matrix4().fromArray(Array.from(a));
const v3 = a => new THREE.Vector3(...a);

export class ShotRenderer {
  constructor(canvas, doc, { forceWebGL = false, trackTimestamp = false } = {}) {
    this.canvas = canvas; this.doc = doc; this.ix = indexDoc(doc); this.forceWebGL = forceWebGL; this.trackTimestamp = trackTimestamp;
    // W x H: the size everything renders at; OW x OH: the canvas. They differ only with the pixel look (setPixelLook).
    this.W = this.OW = doc.output.width; this.H = this.OH = doc.output.height; this.pixel = null;
  }

  /** Turn the chunky-pixel look on (PIXEL_LOOK, or { lines, output: [w, h] }) or off (null). Resizes the buffers and
   *  the canvas; the next render() draws with it. */
  setPixelLook(look) {
    const { doc } = this, aspect = doc.output.width / doc.output.height;
    const [ow, oh] = look ? look.output : [doc.output.width, doc.output.height];
    const h = look ? look.lines : oh, w = look ? Math.round(h * aspect / 2) * 2 : ow;   // 480 lines at 16:9 -> 854 x 480
    this.pixel = look ? { ...PIXEL_LOOK, ...look, lines: h, output: [ow, oh] } : null;
    this.W = w; this.H = h; this.OW = ow; this.OH = oh;
    for (const t of [this.lensRT, this.cocRT, this.finalRT, this.pixelRT]) t.setSize(w, h);
    const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4); this.bloomA.setSize(bw, bh); this.bloomB.setSize(bw, bh);
    this.bloom.U.srcPx.value.set(1 / w, 1 / h); this.bloom.U.px.value.set(1 / bw, 1 / bh);
    const P = this.pixel, UU = this.upscale.U;
    UU.src.value.set(w, h); UU.dst.value.set(ow, oh); UU.levels.value = P && P.bits ? 2 ** P.bits - 1 : 0; UU.detail.value = P && P.sharpScreen ? 1 : 0; UU.scrLines.value = P && typeof P.sharpScreen === 'number' ? P.sharpScreen : 0;
    this.sceneRT.samples = P && !P.msaa ? 0 : 4;
    this.screenFlag.value = P ? 1 : 0; this.U.bands.value = P ? P.bands || 0 : 0; UU.bloom.value = P ? P.bloom || 0 : 0;
    if (!P || !P.stable) UU.off.value.set(0, 0);
    // the chat on the screen: filtered by its footprint (mipmaps) in the pixel look, the engine's single taps otherwise
    const mip = !!P, ct = this.chatTex;
    if (ct.generateMipmaps !== mip) { Object.assign(ct, { generateMipmaps: mip, minFilter: mip ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter }); ct.dispose(); ct.needsUpdate = true; }
    this.crt.userData.S.mip.value = mip ? 1 : 0;
    this.renderer.setSize(ow, oh, false);
  }

  /** Apply a resolved look style (looks/styles.js resolveStyle): the chunky-pixel settings and the material set. */
  setStyle(style) {
    const pixel = style.pixel ? { ...PIXEL_LOOK, ...style.pixel } : null, key = JSON.stringify(pixel);
    if (key !== this.pixelKey) { this.setPixelLook(pixel); this.pixelKey = key; }
    this.setMaterialSet(style.materials || 'default');
    if (this.ps1U && style.ps1) for (const k of ['snap', 'affine', 'gouraud']) this.ps1U[k].value = style.ps1[k] ?? 1;
    this.style = style;
  }
  /** Switch every lit surface (models and cards, not the CRT or glows) to a material set; built on first use. */
  setMaterialSet(name) {
    if (name === this.materialSet) return;
    for (const b of this.bodies) { const mats = b.mesh.userData.mats;
      if (!mats[name]) mats[name] = MATERIAL_SETS[name] ? MATERIAL_SETS[name](this, this.U, b.opts) : mats.default;
      b.mesh.material = mats[name]; }
    this.materialSet = name;
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
    const ledRect = ix.obj.led.texelRect, ledTargets = new Set(ix.obj.led.appliesTo || []);
    this.ledParts = []; this.placed = {}; this.bodies = []; this.materialSet = 'default';
    const body = (mesh, opts) => { mesh.material = bodyMaterial(U, opts); mesh.userData.mats = { default: mesh.material }; this.bodies.push({ mesh, opts }); };
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
          mesh.material = this.crt = crtMaterial({ chatTex, ghostTex, ub: [...u0, ...u1] });
          // the pixel look flags the screen in the distance pass (g = 2, r scaled with it so r / g stays the distance)
          const flag = this.screenFlag = uniform(0), dd = positionWorld.distance(cameraPosition);
          this.crt.mrtNode = mrt({ dist: vec4(dd.mul(flag.add(1)), flag.add(1), 0, 1) });
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
        body(mesh, { map: src.map, emissiveMap: src.emissiveMap, ledRect: ledTargets.has(o.id) ? ledRect : [2, 2, 2, 2], ov });
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
      const mesh = new THREE.Mesh(quad); body(mesh, { map: tx, scMul: 1.15, blMul: o.brightness || 1.4, rawLed: true });
      mesh.matrixAutoUpdate = false; mesh.matrix.copy(m4(trsOf(o.transform))); mesh.userData.docId = o.id; this.placed[o.id] = mesh; scene.add(mesh);
    }
    // glows: four for the ringing LEDs, one for the power LED
    const plane = new THREE.PlaneGeometry(2, 2);
    this.glows = [0, 1, 2, 3, 4].map(() => { const m = new THREE.Mesh(plane, glowMaterial()); m.matrixAutoUpdate = false; m.frustumCulled = false; m.visible = false; scene.add(m); return m; });

    // render targets: scene (MSAA, colour + distance), lens colour, circle of confusion, final
    const rt = (w, h, o = {}) => new THREE.RenderTarget(w, h, { depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.UnsignedByteType, ...o });
    this.sceneRT = new THREE.RenderTarget(this.W, this.H, { count: 2, samples: 4, depthBuffer: true, type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    this.sceneRT.textures[0].name = 'output';
    Object.assign(this.sceneRT.textures[1], { name: 'dist', type: THREE.HalfFloatType, format: THREE.RGFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.lensRT = rt(this.W, this.H);
    this.cocRT = rt(this.W, this.H, { type: THREE.HalfFloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.finalRT = rt(this.W, this.H);
    // Blending for MRT targets is read from the renderer-level MRT (not the material's mrtNode): 'dist' follows each
    // material, so opaque surfaces overwrite it and the additive glows (which output dist 0) leave it untouched.
    this.sceneMRT = mrt({ output, dist: vec4(positionWorld.distance(cameraPosition), 1, 0, 1) }).setBlendMode('dist', new THREE.BlendMode(THREE.MaterialBlending));
    this.outlineRT = rt(this.W, this.H, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.outline = makeOutline({ colorTex: this.sceneRT.textures[0], distTex: this.sceneRT.textures[1] });
    this.post = makePost({ src: this.sceneRT.textures[0], alt: this.outlineRT.texture, zs: this.sceneRT.textures[1], lens: this.lensRT.texture, coc: this.cocRT.texture, final: this.finalRT.texture });

    // final look: haze, layers and the composite (doc.look.haze, doc.layers)
    const tex2d = c => { const t = new THREE.CanvasTexture(c || document.createElement('canvas'));
      Object.assign(t, { flipY: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, colorSpace: THREE.NoColorSpace }); return t; };
    this.flatTex = tex2d(flatCanvas); this.popsTex = tex2d(popsCanvas);
    const HZ = doc.look.haze;
    this.hazeRT = rt(Math.round(this.W * 0.75), Math.round(this.H * 0.75), { type: THREE.HalfFloatType });
    if (HZ) {
      const [gx, gy] = HZ.grid;
      this.emitHiRT = rt(gx * 32, gy * 32);
      this.emitRT = rt(gx, gy, { type: THREE.HalfFloatType });   // linear: the Play grid samples between cells
      const ub = this.screenUB, crtColor = this.crt.userData.color;
      this.emitFlat = flatScreenQuad(Fn(() => crtColor(vec2(ub[0], ub[1]).add(uv().mul(vec2(ub[2] - ub[0], ub[3] - ub[1])))))());
      this.emitAvg = makeEmitAverage({ hiTex: this.emitHiRT.texture, gx, gy });
      this.emitAvg.U.screenLight.value = HZ.screenLight ?? 100;
      this.haze = makeHaze({ distTex: this.sceneRT.textures[1], emitTex: this.emitRT.texture, look: HZ });
      this.meterRT = rt(480, 270, { type: THREE.FloatType });
      this.meter = makeHazeMeter({ hazeTex: this.hazeRT.texture });
    }
    this.comp = makeComposite({ engineTex: this.finalRT.texture, flatTex: this.flatTex, popsTex: this.popsTex, hazeTex: this.hazeRT.texture });
    // pixel look: the composite goes to this internal-size buffer, then is area-upscaled to the canvas
    this.pixelRT = rt(this.W, this.H, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.bloomA = rt(this.W / 4, this.H / 4); this.bloomB = rt(this.W / 4, this.H / 4);
    this.bloom = makeBloom({ srcTex: this.pixelRT.texture, aTex: this.bloomA.texture, bTex: this.bloomB.texture });
    this.upscale = makeAreaUpscale({ srcTex: this.pixelRT.texture, distTex: this.sceneRT.textures[1], cocTex: this.cocRT.texture,
      popsTex: this.popsTex, crtColor: this.crt.userData.color, bloomTex: this.bloomA.texture });
    { const gm = this.glassMap, dotp = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], uu = dotp(gm.eu, gm.eu), uv_ = dotp(gm.eu, gm.ev), vv = dotp(gm.ev, gm.ev), det = uu * vv - uv_ * uv_;
      // dual basis of the glass plane: rel . da = a, rel . db = b for rel = a eu + b ev
      const da = gm.eu.map((x, c) => (vv * x - uv_ * gm.ev[c]) / det), db = gm.ev.map((x, c) => (uu * x - uv_ * gm.eu[c]) / det), UU = this.upscale.U;
      UU.g00.value.set(...gm.p00); UU.gn.value.set(...this.ix.glass.n); UU.da.value.set(...da); UU.db.value.set(...db); UU.ub.value.set(...this.screenUB); }
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
    this.quality = opts.quality || 'render';
    if (st.cut) { r.setRenderTarget(this.finalRT); r.clear(); r.setRenderTarget(null); r.clear(); return; }
    const pixel = !!this.pixel;
    if (!show.lens) st = { ...st, camera: { ...st.camera, k: 0, ov: 1, fovRender: st.camera.fov } };
    const cTrue = st.camera;   // the pixel-stable camera renders from a snapped one; the upscale moves the picture back
    if (pixel && this.pixel.stable) { const s = this.snapCamera(cTrue); st = { ...st, camera: s.camera }; this.upscale.U.off.value.set(...s.off); }
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
    this.mark('composite'); r.setRenderTarget(pixel ? this.pixelRT : null); this.comp.quad.render(r);
    if (pixel) {
      const c = cTrue, B = this.bloom, UU = this.upscale.U, f = nrm(c.target.map((v, i) => v - c.eye[i])), rr = nrm([f[1] * c.up[2] - f[2] * c.up[1], f[2] * c.up[0] - f[0] * c.up[2], f[0] * c.up[1] - f[1] * c.up[0]]);
      UU.eye.value.set(...c.eye); UU.cf.value.set(...f); UU.cr.value.set(...rr); UU.cu.value.set(rr[1] * f[2] - rr[2] * f[1], rr[2] * f[0] - rr[0] * f[2], rr[0] * f[1] - rr[1] * f[0]);
      UU.tanY.value = Math.tan(c.fovRender * Math.PI / 360); UU.aspect.value = this.W / this.H; UU.k.value = c.k;
      UU.popsOn.value = C.popsOn.value; UU.detail.value = this.pixel.sharpScreen && !st.flat.before ? 1 - st.flat.overlay : 0;
      if (UU.bloom.value > 0) { this.mark('bloom'); r.setRenderTarget(this.bloomA); B.quads.bright.render(r); r.setRenderTarget(this.bloomB); B.quads.blurX.render(r); r.setRenderTarget(this.bloomA); B.quads.blurY.render(r); }
      this.mark('area upscale'); r.setRenderTarget(null); this.upscale.quad.render(r);
    }
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
    const f = nrm(c.target.map((v, i) => v - c.eye[i])), rr = nrm([f[1] * c.up[2] - f[2] * c.up[1], f[2] * c.up[0] - f[0] * c.up[2], f[0] * c.up[1] - f[1] * c.up[0]]);
    const uu = [rr[1] * f[2] - rr[2] * f[1], rr[2] * f[0] - rr[0] * f[2], rr[0] * f[1] - rr[1] * f[0]];
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
    U.sp.value.set(...add(g.ctr, scl(g.n, W_ * .06))); U.sn.value.set(...g.n); U.sc.value.set(...st.glowCol);
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
    // scene pass: the buffer grows with the lens overscan so the centre stays sharp
    const scale = c.k > 1e-4 ? Math.min(2, Math.ceil(c.ov * 2) / 2) : 1, sw = Math.round(this.W * scale), sh = Math.round(this.H * scale);
    if (this.sceneRT.width !== sw || this.sceneRT.height !== sh) this.sceneRT.setSize(sw, sh);
    if (this.ps1U) this.ps1U.res.value.set(sw, sh);   // PS1 vertex snapping: the scene buffer's pixel grid
    this.mark('scene'); r.setMRT(this.sceneMRT); r.setRenderTarget(this.sceneRT); r.clear(); r.render(this.scene, cam); r.setMRT(null);
    // lens + circle of confusion
    const P = post.U, F = st.focus, D = !!(show.dof && F && (F.px > 0 || F.edge > 0 || F.spot > 0));
    P.k.value = c.k; P.aspect.value = this.W / this.H; P.sq.value = c.squint;
    P.fD.value = D ? F.D : 0; P.ppd.value = D ? F.px : 0; P.band.value = D ? F.band : 0; P.maxc.value = D ? F.max : 0; P.edge.value = D ? F.edge : 0; P.es.value = D ? F.es : 1;
    P.sp.value.set(D ? F.sp[0] : .5, D ? 1 - F.sp[1] : .5); P.spot.value = D ? F.spot : 0; P.spr.value = D ? F.spotR : 1; P.spf.value = D ? F.spotF : 1;
    const outl = !!this.pixel?.outlines; P.alt.value = outl ? 1 : 0;
    if (outl) { const O = this.outline; if (this.outlineRT.width !== sw || this.outlineRT.height !== sh) this.outlineRT.setSize(sw, sh);
      O.U.px.value.set(1 / sw, 1 / sh); this.mark('outlines'); r.setRenderTarget(this.outlineRT); O.quad.render(r); }
    this.mark('lens'); r.setRenderTarget(this.lensRT); post.quads.lens.render(r);
    this.mark('focus (CoC)'); r.setRenderTarget(this.cocRT); post.quads.coc.render(r);
    const sc = this.H / 1080; P.px.value.set(1 / this.W, 1 / this.H); P.sc.value = sc; P.maxR.value = D ? F.max * sc : 0; P.rs.value = (this.quality === 'play' ? (this.doc.look.haze?.play?.dofStep ?? 2) : 0.5) * sc;
    this.mark('depth of field'); r.setRenderTarget(this.finalRT); post.quads.dof.render(r);
  }

  /** The pixel-stable camera: the shot camera moved in its own image plane to the nearest whole internal pixel (sized at
   *  the target distance, at the lens centre), so still geometry lands on the same pixels while the camera drifts and the
   *  jaggies don't crawl. off: the remainder in internal pixels, which the upscale takes back out so the motion stays smooth. */
  snapCamera(c) {
    const f0 = c.target.map((v, i) => v - c.eye[i]), D = Math.hypot(...f0), f = nrm(f0);
    const r = nrm([f[1] * c.up[2] - f[2] * c.up[1], f[2] * c.up[0] - f[0] * c.up[2], f[0] * c.up[1] - f[1] * c.up[0]]);
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const aspect = this.W / this.H, px = 2 * D * Math.tan(c.fovRender * Math.PI / 360) / this.H / (1 + c.k * (aspect * aspect + 1));
    const er = dot(c.eye, r) / px, eu = dot(c.eye, u) / px, dr = Math.round(er) - er, du = Math.round(eu) - eu;
    const d = r.map((v, i) => (v * dr + u[i] * du) * px);
    return { camera: { ...c, eye: add(c.eye, d), target: add(c.target, d) }, off: [-dr, du] };
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
