// Viewport: the shot through its camera (with the final look), or a free view for working on the scene (Blender-style
// navigation: middle-drag orbit, Shift+middle-drag pan, wheel zoom; left-click selects; G/R/S switch the gizmo between
// move, rotate and scale). Overlays: safe frames in camera view; grid, camera frustum, empties and lights in free view.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { trsOf } from '../core/vec.js';

const lineMat = (color, opacity = 1) => new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthTest: false });

export class Viewport {
  constructor(E) {
    this.E = E; const canvas = this.canvas = document.getElementById('gpu');
    const g = E.ix.glass;
    this.freeCam = new THREE.PerspectiveCamera(40, 16 / 9, 0.01, 50);
    this.freeCam.position.set(g.ctr[0] + 0.9, g.ctr[1] + 0.55, g.ctr[2] + 1.3);
    this.orbit = new OrbitControls(this.freeCam, canvas);
    this.orbit.target.set(g.ctr[0] + 0.1, g.ctr[1] - 0.15, g.ctr[2] + 0.1);
    this.orbit.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
    this.orbit.enableDamping = false; this.orbit.enabled = false; this.orbit.update();
    this.orbit.addEventListener('change', () => E.requestRender());

    // helpers scene (free view only)
    const H = this.scene = new THREE.Scene();
    const grid = new THREE.GridHelper(4, 40, 0x4a474a, 0x2a282a); grid.material.depthTest = false; H.add(grid);
    const box = (a, b) => { const g2 = new THREE.BoxGeometry(b[0] - a[0], b[1] - a[1], b[2] - a[2]); g2.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2); return new THREE.LineSegments(new THREE.EdgesGeometry(g2), lineMat(0x3fb5a8, 0.35)); };
    this.grid = grid; this.hazeBox = E.doc.look.haze ? box(...E.doc.look.haze.box) : null; if (this.hazeBox) H.add(this.hazeBox);
    this.frustum = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(16 * 3), 3)), lineMat(0xc3acc6));
    this.frustum.frustumCulled = false; H.add(this.frustum);
    this.glassAxes = new THREE.AxesHelper(0.12); this.glassAxes.material.depthTest = false; this.glassAxes.matrixAutoUpdate = false; H.add(this.glassAxes);
    const dot = (c, r) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), new THREE.MeshBasicMaterial({ color: c, depthTest: false })); m.renderOrder = 10; H.add(m); return m; };
    this.ledDot = dot(0x3fb5a8, 0.008); this.ringDot = dot(0xff2a1e, 0.008);
    this.selBox = new THREE.Box3Helper(new THREE.Box3(), 0xecefeb); this.selBox.material.depthTest = false; H.add(this.selBox);

    // gizmo on a proxy that mirrors the selected object's transform record
    this.proxy = new THREE.Object3D(); H.add(this.proxy);
    this.gizmo = new TransformControls(this.freeCam, canvas); this.gizmo.setSize(0.8); H.add(this.gizmo.getHelper());
    let before = null;
    this.gizmo.addEventListener('dragging-changed', e => {
      this.orbit.enabled = !e.value && E.view === 'free'; E.interacting = e.value;
      if (e.value) before = E.cmd.begin(); else { E.cmd.commit('setTransform (gizmo)', before); E.requestRender(); }
    });
    this.gizmo.addEventListener('objectChange', () => {
      const o = E.doc.objects.find(o => o.id === E.sel.id); if (!o) return;
      const s = this.proxy.scale.toArray().map(v => +v.toFixed(6));
      o.transform = { position: this.proxy.position.toArray().map(v => +v.toFixed(6)), quaternion: this.proxy.quaternion.toArray().map(v => +v.toFixed(9)), ...(s.some(v => Math.abs(v - 1) > 1e-6) ? { scale: s } : {}) };
      E.shot.syncFromDoc(E.doc); E.requestRender();
    });

    // left-click selects (unless the gizmo is under the pointer)
    canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0 || this.gizmo.dragging || (this.gizmo.axis && E.view === 'free')) return;
      const r = canvas.getBoundingClientRect(), ndc = [((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1)];
      const cam = E.view === 'free' ? this.freeCam : E.shot.camera;
      const id = E.shot.pick(ndc, cam); if (id) E.select({ kind: 'object', id });
    });
    E.on('select', () => this.attach()); E.on('change', () => this.attach()); E.on('show', () => this.attach());
    E.on('key', e => { const k = e.key.toLowerCase();
      // Blender: H hides the selection, Alt+H reveals everything hidden
      if (k === 'h' && e.altKey) { e.preventDefault(); E.revealAll(); return; }
      if (k === 'h' && E.sel.kind === 'object' && E.shot.placed[E.sel.id]) { E.setHidden(E.sel.id, true); return; }
      if (E.view !== 'free') return; const m = { g: 'translate', r: 'rotate', s: 'scale' }[k]; if (m) this.gizmo.setMode(m);
      if (k === 'f') this.frameSelected(); });
    this.menu();
    E.on('frameSelected', () => this.frameSelected());
  }
  setView(v) { this.orbit.enabled = v === 'free'; this.attach(); }
  attach() {
    const E = this.E, o = E.sel.kind === 'object' && E.doc.objects.find(o => o.id === E.sel.id);
    if (E.view === 'free' && o && o.transform && E.mode !== 'play' && !E.hidden.has(o.id)) {
      const m = new THREE.Matrix4().fromArray(Array.from(trsOf(o.transform)));
      m.decompose(this.proxy.position, this.proxy.quaternion, this.proxy.scale); this.proxy.updateMatrixWorld(true);
      if (this.gizmo.object !== this.proxy) this.gizmo.attach(this.proxy);
    } else if (this.gizmo.object) this.gizmo.detach();
  }
  frameSelected() {
    const node = this.E.shot.placed[this.E.sel.id]; if (!node) return;
    const b = new THREE.Box3().setFromObject(node), c = b.getCenter(new THREE.Vector3()), r = Math.max(b.getSize(new THREE.Vector3()).length(), 0.05);
    const dir = this.freeCam.position.clone().sub(this.orbit.target).normalize();
    this.orbit.target.copy(c); this.freeCam.position.copy(c.clone().add(dir.multiplyScalar(r * 1.6))); this.orbit.update();
  }
  /** Helpers for this frame (free view). */
  helpers() {
    const E = this.E, st = E.st, c = st.camera, g = E.ix.glass, S = E.show;
    this.grid.visible = S.grid; if (this.hazeBox) this.hazeBox.visible = S.hazeBox; this.frustum.visible = S.frustum;
    this.glassAxes.visible = S.lights; this.ledDot.visible = S.lights;
    // the shot camera's frustum (keyed FOV, not the lens overscan), out to its target distance
    const eye = new THREE.Vector3(...c.eye), tg = new THREE.Vector3(...c.target), up = new THREE.Vector3(...c.up);
    const f = tg.clone().sub(eye), d = f.length(); f.normalize(); const r = f.clone().cross(up).normalize(), u = r.clone().cross(f);
    const hy = Math.tan(c.fov * Math.PI / 360) * d, hx = hy * 16 / 9, ctr = eye.clone().add(f.clone().multiplyScalar(d));
    const cn = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => ctr.clone().add(r.clone().multiplyScalar(a * hx)).add(u.clone().multiplyScalar(b * hy)));
    const P = this.frustum.geometry.attributes.position, seg = [];
    cn.forEach((p, i) => { seg.push(eye, p, p, cn[(i + 1) % 4]); });
    seg.forEach((p, i) => P.setXYZ(i, p.x, p.y, p.z)); P.needsUpdate = true;
    this.glassAxes.matrix.fromArray([...g.r, 0, ...g.u, 0, ...g.n, 0, ...g.ctr, 1]);
    this.ledDot.position.set(...st.led.pos);
    this.ringDot.visible = S.lights && !!st.ring; if (st.ring) this.ringDot.position.set(...st.ring.pos);
    const node = E.sel.kind === 'object' && E.shot.placed[E.sel.id];
    this.selBox.visible = S.bounds && !!node && node.visible; if (this.selBox.visible) this.selBox.box.setFromObject(node);
    return this.scene;
  }
  /** The Show menu (Unreal's Show flags, Blender's Overlays popover): parts of the look and the helpers, viewport only. */
  menu() {
    const E = this.E, btn = document.getElementById('showBtn'), pop = document.getElementById('showMenu'), sel = document.getElementById('refineSel');
    const item = (k, label, note = '') => `<label class="check"><input type="checkbox" data-show="${k}"><span>${label}</span>${note ? `<span class="note">${note}</span>` : ''}</label>`;
    pop.innerHTML = `<div class="menu-group"><div class="menu-head">Look</div>
        ${item('haze', 'Haze', 'heaviest')}${item('dof', 'Depth of field')}${item('lens', 'Lens warp')}${item('glows', 'LED glows')}
        ${item('ghosts', 'Ghost flashes')}${item('pops', 'Pops (2D)')}</div>
      <div class="menu-group"><div class="menu-head">Style</div>
        ${item('pixels', 'Chunky pixels', '480p to 4K')}</div>
      <div class="menu-group"><div class="menu-head">Overlays</div>
        ${item('safe', 'Safe frames', 'camera')}${item('grid', 'Grid', 'free')}${item('frustum', 'Shot camera', 'free')}${item('hazeBox', 'Haze bounds', 'free')}
        ${item('lights', 'Lights and glass axes', 'free')}${item('bounds', 'Selection bounds', 'free')}</div>
      <div class="menu-foot"><button type="button" id="revealAll">Reveal hidden objects <kbd>Alt+H</kbd></button>
        <div class="note">Viewport only: renders to disk always use the full look. Chunky pixels applies to renders too (3840×2160).</div></div>`;
    pop.addEventListener('change', e => { const k = e.target.dataset.show; if (k) E.setShow(k, e.target.checked); });
    pop.querySelector('#revealAll').onclick = () => E.revealAll();
    pop.addEventListener('toggle', e => { btn.setAttribute('aria-expanded', String(e.newState === 'open')); });
    pop.addEventListener('beforetoggle', e => { if (e.newState !== 'open') return; const r = btn.getBoundingClientRect();
      pop.style.left = `${Math.min(r.left, innerWidth - 300)}px`; pop.style.top = `${r.bottom + 4}px`; });
    sel.onchange = () => E.setRefine(sel.value);
    const fps = document.getElementById('fpsSel'); fps.onchange = () => E.setFpsCap(+fps.value); E.on('view', () => { fps.value = String(E.fpsCap[E.view] || 0); });
    const sync = () => {
      pop.querySelectorAll('[data-show]').forEach(i => { i.checked = !!E.show[i.dataset.show]; });
      const off = ['haze', 'dof', 'lens', 'glows', 'ghosts', 'pops'].filter(k => !E.show[k]).length;
      btn.textContent = off ? `Show (${off} off) ▾` : 'Show ▾'; sel.value = E.refineMode; fps.value = String(E.fpsCap[E.view] || 0);
      const n = E.hidden.size, h = document.getElementById('hiddenNote');
      h.textContent = n ? `${n} hidden · Alt+H reveals` : ''; pop.querySelector('#revealAll').disabled = !n;
    };
    E.on('show', sync); sync();
  }

  /** SVG overlay: safe frames and the frame number in camera view. */
  overlay(st) {
    const svg = document.getElementById('overlay'), E = this.E;
    if (E.view !== 'camera' || E.mode === 'play' || !E.show.safe) { svg.innerHTML = ''; return; }
    const rect = (s, cls) => { const w = 1920 * s, h = 1080 * s; return `<rect x="${(1920 - w) / 2}" y="${(1080 - h) / 2}" width="${w}" height="${h}" fill="none" stroke="${cls}" stroke-width="2" stroke-dasharray="10 8"/>`; };
    svg.innerHTML = rect(0.93, 'rgba(195,172,198,.35)') + rect(0.9, 'rgba(63,181,168,.35)')
      + `<path d="M948 540h24M960 528v24" stroke="rgba(236,239,235,.4)" stroke-width="2"/>`;
  }
}
