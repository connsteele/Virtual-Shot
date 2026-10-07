// Builds a three.js scene from the scene document and renders evaluated frames with the Black Page look.
// WebGPURenderer (falls back to WebGL2 by itself) with TSL materials; no colour management, like the engine.
import * as THREE from 'three/webgpu';
import { mrt, output, vec4, positionWorld, cameraPosition, uniform } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { bodyMaterial, crtMaterial, glowMaterial, makeLightUniforms } from './materials.js';
import { makePost } from './post.js';
import { indexDoc } from '../core/evaluate.js';
import { add, scl, xf, nrm, trsOf } from '../core/vec.js';

/** Asset key -> URL on the dev server (psx:, wii:, bp: are read-only mounts of the original folders). */
export const assetUrl = ref => {
  const [ns, ...rest] = ref.split(':'), p = rest.join(':').split('/').map(encodeURIComponent).join('/');
  return ({ psx: '/psx/', wii: '/wii/', bp: '/bp/' }[ns] || '/') + p;
};
const loadImage = async src => { const im = new Image(); im.src = src; await im.decode(); return im; };
const m4 = a => new THREE.Matrix4().fromArray(Array.from(a));
const v3 = a => new THREE.Vector3(...a);

export class ShotRenderer {
  constructor(canvas, doc, { forceWebGL = false } = {}) {
    this.canvas = canvas; this.doc = doc; this.ix = indexDoc(doc); this.forceWebGL = forceWebGL;
    this.W = doc.output.width; this.H = doc.output.height;
  }

  async init(chatCanvas) {
    const { doc, ix } = this;
    THREE.ColorManagement.enabled = false;
    const r = this.renderer = new THREE.WebGPURenderer({ canvas: this.canvas, antialias: false, alpha: false, forceWebGL: this.forceWebGL });
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
    const ledRect = ix.obj.led.texelRect, ledTargets = new Set(ix.obj.led.appliesTo || []);
    this.ledParts = [];
    for (const o of doc.objects) {
      if (o.type !== 'model') continue;
      const gltf = await loader.loadAsync(assetUrl(doc.assets[o.asset]));
      const root = gltf.scene; root.matrixAutoUpdate = false; root.matrix.copy(m4(trsOf(o.transform))); root.userData.base = root.matrix.clone();
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
          this.screenUB = [...u0, ...u1];
          continue;
        }
        const isLed = ledRe && ledRe.test(nodeName);
        const ov = isLed ? uniform(new THREE.Vector4(0, 0, 0, 0)) : null;
        mesh.material = bodyMaterial(U, { map: src.map, emissiveMap: src.emissiveMap, ledRect: ledTargets.has(o.id) ? ledRect : [2, 2, 2, 2], ov });
        if (isLed) this.ledParts.push({ mesh, ov, c0: a0.map((v, c) => (v + a1[c]) / 2) });
      }
      const M = Array.from(root.matrix.elements), ctrLocal = mn.map((v, c) => (v + mx[c]) / 2);
      this.geo.centres[o.id] = xf(M, ctrLocal);
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
      const mesh = new THREE.Mesh(quad, bodyMaterial(U, { map: tx, scMul: 1.15, blMul: o.brightness || 1.4, rawLed: true }));
      mesh.matrixAutoUpdate = false; mesh.matrix.copy(m4(trsOf(o.transform))); scene.add(mesh);
    }
    // glows: four for the ringing LEDs, one for the power LED
    const plane = new THREE.PlaneGeometry(2, 2);
    this.glows = [0, 1, 2, 3, 4].map(() => { const m = new THREE.Mesh(plane, glowMaterial()); m.matrixAutoUpdate = false; m.frustumCulled = false; m.visible = false; scene.add(m); return m; });

    // render targets: scene (MSAA, colour + distance), lens colour, circle of confusion, final
    const rt = (w, h, o = {}) => new THREE.RenderTarget(w, h, { depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.UnsignedByteType, ...o });
    this.sceneRT = new THREE.RenderTarget(this.W, this.H, { count: 2, samples: 4, depthBuffer: true, type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    this.sceneRT.textures[0].name = 'output';
    Object.assign(this.sceneRT.textures[1], { name: 'dist', type: THREE.HalfFloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.lensRT = rt(this.W, this.H);
    this.cocRT = rt(this.W, this.H, { type: THREE.HalfFloatType, format: THREE.RedFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.finalRT = rt(this.W, this.H);
    // Blending for MRT targets is read from the renderer-level MRT (not the material's mrtNode): 'dist' follows each
    // material, so opaque surfaces overwrite it and the additive glows (which output dist 0) leave it untouched.
    this.sceneMRT = mrt({ output, dist: vec4(positionWorld.distance(cameraPosition), 0, 0, 1) }).setBlendMode('dist', new THREE.BlendMode(THREE.MaterialBlending));
    this.post = makePost({ src: this.sceneRT.textures[0], zs: this.sceneRT.textures[1], lens: this.lensRT.texture, coc: this.cocRT.texture, final: this.finalRT.texture });
    return this;
  }

  /** Render one evaluated frame into finalRT and the canvas. */
  render(st) {
    const { renderer: r, U, ix, post } = this, g = ix.glass, W_ = g.W, c = st.camera;
    if (st.cut) { r.setRenderTarget(this.finalRT); r.clear(); r.setRenderTarget(null); r.clear(); return; }
    this.chatTex.needsUpdate = true;
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
      S.gr.array[i].set(...R_.r); S.gp.array[i].set(gh.x ?? .5, gh.y ?? .5, w, h); S.ga.array[i] = gh.level; S.gm.array[i] = gh.mirror === false ? 0 : 1;
    }
    // glows (in the glass plane)
    this.glows.forEach(m => { m.visible = false; });
    const setGlow = (m, ctr, s, col, a) => { m.visible = true; m.matrix.set(g.r[0] * s, g.u[0] * s, g.n[0], ctr[0], g.r[1] * s, g.u[1] * s, g.n[1], ctr[1], g.r[2] * s, g.u[2] * s, g.n[2], ctr[2], 0, 0, 0, 1);
      m.material.userData.G.col.value.set(...col); m.material.userData.G.a.value = a; };
    if (R && R.lvl > 0.01 && R.glow > 0) R.leds.forEach((p, i) => setGlow(this.glows[i], p, 0.007 * R.glow, R.col, R.lvl * 0.5));
    if (led.intensity > 0) setGlow(this.glows[4], add(led.pos, scl(led.n, W_ * .006)), W_ * .03 * led.size, led.color, led.intensity * .6);
    // scene pass: the buffer grows with the lens overscan so the centre stays sharp
    const scale = c.k > 1e-4 ? Math.min(2, Math.ceil(c.ov * 2) / 2) : 1, sw = Math.round(this.W * scale), sh = Math.round(this.H * scale);
    if (this.sceneRT.width !== sw || this.sceneRT.height !== sh) this.sceneRT.setSize(sw, sh);
    r.setMRT(this.sceneMRT); r.setRenderTarget(this.sceneRT); r.clear(); r.render(this.scene, cam); r.setMRT(null);
    // lens + circle of confusion
    const P = post.U, F = st.focus, D = !!(F && (F.px > 0 || F.edge > 0 || F.spot > 0));
    P.k.value = c.k; P.aspect.value = this.W / this.H; P.sq.value = c.squint;
    P.fD.value = D ? F.D : 0; P.ppd.value = D ? F.px : 0; P.band.value = D ? F.band : 0; P.maxc.value = D ? F.max : 0; P.edge.value = D ? F.edge : 0; P.es.value = D ? F.es : 1;
    P.sp.value.set(D ? F.sp[0] : .5, D ? 1 - F.sp[1] : .5); P.spot.value = D ? F.spot : 0; P.spr.value = D ? F.spotR : 1; P.spf.value = D ? F.spotF : 1;
    r.setRenderTarget(this.lensRT); post.quads.lens.render(r);
    r.setRenderTarget(this.cocRT); post.quads.coc.render(r);
    const sc = this.H / 1080; P.px.value.set(1 / this.W, 1 / this.H); P.sc.value = sc; P.maxR.value = D ? F.max * sc : 0; P.rs.value = 0.5 * sc;
    r.setRenderTarget(this.finalRT); post.quads.dof.render(r);
    r.setRenderTarget(null); post.quads.blit.render(r);
  }

  /** RGBA8 pixels of the last frame (top row first). */
  async readPixels() {
    const px = await this.renderer.readRenderTargetPixelsAsync(this.finalRT, 0, 0, this.W, this.H);
    return new Uint8ClampedArray(px.buffer, px.byteOffset, this.W * this.H * 4);
  }
}
