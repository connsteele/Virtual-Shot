// Character lab: rigged glTF characters with clip blocks on a Sequencer-style timeline, retargeting, foot IK and a
// pose mode, on the same principles as the editor: the scene document is the only source of truth, every edit is a
// named undoable command (VS.cmd), and every frame is a pure function of (document, assets, t).
//   ?nogpu   load and evaluate only (no renderer): numeric tests without touching the GPU
//   ?bg      timers instead of animation frames (headless Chrome)
//   ?scene=  scene file in scenes/ (default characters.scene.json)
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { createCommandStack, registerCommands, COMMANDS } from '../core/commands.js';
import { trackSegment } from '../core/tracks.js';
import { CHAR_COMMANDS } from './commands.js';
import { rigFromScene, prepareClip, evalCharacter, indexTracks, retargetRestRelative, restFromClip, alignRest, identityMap,
  MIXAMO_TO_ROBOT, segmentError, fk, blockWeights, blockTime } from './pose.js';

registerCommands(CHAR_COMMANDS);
const Q = new URLSearchParams(location.search), NOGPU = Q.has('nogpu'), BG = Q.has('bg');
const MAPS = { mixamoToRobot: MIXAMO_TO_ROBOT };
const $ = id => document.getElementById(id);
const E = window.E = { t: 0, playing: false, sel: { char: null, clip: null, bone: null }, pose: false, results: {}, dirty: true };

// ---------------------------------------------------------------------------------------------------------------------
// Load: document, assets, derived clip data (own clips + retargeted ones)

async function loadAssets(doc) {
  const loader = new GLTFLoader(), A = {}, timing = {};
  await Promise.all(Object.entries(doc.assets).map(async ([id, a]) => {
    const g = await loader.loadAsync(a.url), rig = rigFromScene(g.scene, a.profile);
    A[id] = { gltf: g, rig, raw: Object.fromEntries(g.animations.map(c => [c.name, c])), clips: {} };
  }));
  for (const [id, a] of Object.entries(doc.assets)) {
    const X = A[id], t0 = performance.now();
    for (const c of Object.values(X.raw)) X.clips[c.name] = prepareClip(X.rig, c);
    for (const r of a.retarget || []) {
      const S = A[r.from], map = r.map === 'identity' ? identityMap(S.rig, X.rig) : MAPS[r.map];
      const srcRest = r.srcRestClip ? restFromClip(S.rig, S.raw[r.srcRestClip]) : undefined;
      const dstRest = r.dstRestClip ? restFromClip(X.rig, X.raw[r.dstRestClip]) : r.align ? alignRest(S.rig, X.rig, map, srcRest) : undefined;
      for (const name of r.clips) {
        const t1 = performance.now(), rc = retargetRestRelative(S.rig, X.rig, S.raw[name], map, { srcRest, dstRest });
        timing[`${id}<-${r.from}/${name}`] = +(performance.now() - t1).toFixed(1);
        // contacts belong to the motion, not the rig: take the source clip's (a retargeted foot rarely sits flat for
        // as long when the leg proportions differ), and scale its stride by the hip-height ratio like the hips' travel
        const sc = S.clips[name], ratio = X.rig.hipHeight / S.rig.hipHeight;
        X.raw[`${r.from}/${name}`] = rc;
        X.clips[`${r.from}/${name}`] = prepareClip(X.rig, rc, r.ownContacts ? {} : { contacts: sc.contacts, stride: sc.stride.map(g => g.map(v => v * ratio)) });
      }
    }
    timing[`${id} total`] = +(performance.now() - t0).toFixed(1);
  }
  return { A, timing };
}

// ---------------------------------------------------------------------------------------------------------------------
// Evaluate (pure) and apply to the scene graph

function evaluateAll(doc, t) {
  const ix = indexTracks(doc), out = {};
  for (const ch of doc.objects) if (ch.type === 'character' && E.A[ch.asset]) out[ch.id] = evalCharacter(doc, ch, t, E.A, { ix });
  return out;
}

const G = {};   // renderer, scene, camera, instances
function syncInstances() {
  if (NOGPU) return;
  const want = new Set(E.doc.objects.filter(o => o.type === 'character').map(o => o.id));
  for (const id of Object.keys(G.inst)) if (!want.has(id)) { G.scene.remove(G.inst[id].group); delete G.inst[id]; }
  for (const ch of E.doc.objects) {
    if (ch.type !== 'character' || G.inst[ch.id] || !E.A[ch.asset]) continue;
    const X = E.A[ch.asset], model = SkeletonUtils.clone(X.gltf.scene), group = new THREE.Group();
    group.matrixAutoUpdate = false; group.add(model); group.userData.char = ch.id;
    model.traverse(o => { if (o.isMesh) { o.frustumCulled = false; o.castShadow = true; o.userData.char = ch.id; } });
    G.scene.add(group);
    G.inst[ch.id] = { group, model, fix: new THREE.Matrix4().fromArray(X.rig.fix), bones: X.rig.bones.map(b => model.getObjectByName(b.name)) };
  }
}
function applyResults(R) {
  if (NOGPU) return;
  for (const [id, r] of Object.entries(R)) {
    const I = G.inst[id]; if (!I) continue;
    I.group.matrix.multiplyMatrices(r.matrix, I.fix); I.group.matrixWorldNeedsUpdate = true;   // model space includes the rig's facing fix
    r.locals.forEach((l, i) => { const b = I.bones[i]; if (!b) return; b.position.fromArray(l.p); b.quaternion.fromArray(l.q); b.scale.fromArray(l.s); });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Frame loop: draw only when something changed (time, document, view)

const requestRender = () => { E.dirty = true; };
let lastNow = 0;
function tick(now) {
  if (E.playing) {
    const dt = Math.min(0.1, (now - lastNow) / 1000); let t = E.t + dt;
    if (t >= E.doc.duration) t = 0;
    setTime(t, false);
  }
  lastNow = now;
  if (E.dirty) { E.dirty = false; draw(); }
  BG ? setTimeout(() => tick(performance.now()), 16) : requestAnimationFrame(tick);
}
function setTime(t, snap = true) {
  E.t = snap ? Math.round(Math.max(0, Math.min(E.doc.duration, t)) * E.doc.fps) / E.doc.fps : t;
  $('time').textContent = `${E.t.toFixed(2)} s`; requestRender(); drawPlayhead();
}
function draw() {
  const f = Math.round(E.t * E.doc.fps) / E.doc.fps;    // characters are evaluated on frame times, like a render
  E.results = evaluateAll(E.doc, f);
  applyResults(E.results);
  if (!NOGPU) { updatePoseOverlay(); G.renderer.render(G.scene, G.camera); }
}

// ---------------------------------------------------------------------------------------------------------------------
// Viewport

async function initGPU() {
  const canvas = $('gpu');
  G.renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  await G.renderer.init();
  G.renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  G.scene = new THREE.Scene(); G.scene.background = new THREE.Color(0x26252a);
  G.camera = new THREE.PerspectiveCamera(35, 16 / 9, 0.05, 100); G.camera.position.set(0.5, 1.7, 6.5);
  G.orbit = new OrbitControls(G.camera, canvas); G.orbit.target.set(0, 0.9, 0);
  G.orbit.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN }; G.orbit.update();
  G.orbit.addEventListener('change', requestRender);
  G.scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x3a3430, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2); sun.position.set(3, 6, 4); G.scene.add(sun);
  const grid = new THREE.GridHelper(20, 40, 0x55525c, 0x34323a); G.scene.add(grid);
  G.inst = {};
  G.proxy = new THREE.Object3D(); G.scene.add(G.proxy);
  G.gizmo = new TransformControls(G.camera, canvas); G.gizmo.setMode('rotate'); G.gizmo.setSpace('local'); G.gizmo.setSize(0.7);
  G.scene.add(G.gizmo.getHelper());
  let before = null;
  G.gizmo.addEventListener('dragging-changed', e => { G.orbit.enabled = !e.value; if (e.value) before = E.cmd.begin(); else { E.cmd.commit('setBoneKey (gizmo)', before); } });
  G.gizmo.addEventListener('objectChange', () => { if (G.gizmo.dragging) poseFromGizmo(); });
  G.joints = new THREE.Group(); G.scene.add(G.joints);
  const resize = () => { const r = canvas.parentElement.getBoundingClientRect(); G.renderer.setSize(r.width, r.height, false); G.camera.aspect = r.width / r.height; G.camera.updateProjectionMatrix(); requestRender(); };
  new ResizeObserver(resize).observe(canvas.parentElement); resize();
  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0 || G.gizmo.dragging || G.gizmo.axis) return;
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (E.pose && E.sel.char) { const b = pickBone(x, y, r); if (b !== null) { E.sel.bone = b; refresh(); return; } }
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(x / r.width * 2 - 1, -(y / r.height) * 2 + 1), G.camera);
    const hit = ray.intersectObjects(Object.values(G.inst).map(i => i.group), true).find(h => h.object.userData.char);
    select({ char: hit ? hit.object.userData.char : null, clip: null, bone: null });
  });
}

/** Screen-space joint pick (skinned meshes don't raycast against their posed shape cheaply). */
function pickBone(x, y, r) {
  const res = E.results[E.sel.char]; if (!res) return null;
  let best = null, bd = 14;
  res.world.forEach((W, i) => { const p = new THREE.Vector3().setFromMatrixPosition(W).applyMatrix4(res.matrix).project(G.camera);
    const d = Math.hypot((p.x * .5 + .5) * r.width - x, (-p.y * .5 + .5) * r.height - y); if (d < bd && p.z < 1) { bd = d; best = i; } });
  return best;
}

function updatePoseOverlay() {
  const res = E.pose && E.results[E.sel.char];
  G.joints.visible = !!res;
  if (!res) { G.gizmo.detach(); return; }
  if (G.joints.userData.char !== E.sel.char) {
    G.joints.clear(); G.joints.userData.char = E.sel.char;
    const geo = new THREE.SphereGeometry(0.018, 8, 6);
    res.world.forEach(() => { const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x3fb5a8, depthTest: false })); m.renderOrder = 10; G.joints.add(m); });
  }
  res.world.forEach((W, i) => { const m = G.joints.children[i]; m.position.setFromMatrixPosition(W).applyMatrix4(res.matrix); m.material.color.set(i === E.sel.bone ? 0xecefeb : 0x3fb5a8); });
  if (E.sel.bone === null) { G.gizmo.detach(); return; }
  if (!G.gizmo.dragging) {
    const m = new THREE.Matrix4().multiplyMatrices(res.matrix, res.world[E.sel.bone]), q = new THREE.Quaternion();
    m.decompose(G.proxy.position, q, new THREE.Vector3()); G.proxy.quaternion.copy(q);
    if (G.gizmo.object !== G.proxy) G.gizmo.attach(G.proxy);
  }
}

/** The gizmo sets the bone's world rotation; turn it into a pose key at the playhead: d' = d * local^-1 * desired. */
function poseFromGizmo() {
  const ch = E.doc.objects.find(o => o.id === E.sel.char), res = E.results[ch.id], X = E.A[ch.asset], i = E.sel.bone, b = X.rig.bones[i];
  const rotOf = m => { const q = new THREE.Quaternion(); m.decompose(new THREE.Vector3(), q, new THREE.Vector3()); return q; };
  const parentW = b.parent < 0 ? new THREE.Matrix4().fromArray(b.base) : res.world[b.parent];
  const parentQ = rotOf(new THREE.Matrix4().multiplyMatrices(res.matrix, parentW));
  const desired = parentQ.invert().multiply(G.proxy.quaternion);
  const tr = E.doc.tracks.find(x => x.target === ch.id && x.prop === `pose.${b.name}`);
  let dOld = new THREE.Quaternion();
  if (tr?.keys.length) { const { a, b: k2, u } = trackSegment(tr, E.t); dOld = new THREE.Quaternion().fromArray(a.v).slerp(new THREE.Quaternion().fromArray(k2.v), u); }
  const dNew = dOld.multiply(new THREE.Quaternion().fromArray(res.locals[i].q).invert()).multiply(desired);
  COMMANDS.setBoneKey(E.doc, { char: ch.id, bone: b.name, t: E.t, q: dNew.toArray().map(v => +v.toFixed(7)) });
  E.results = evaluateAll(E.doc, E.t); applyResults(E.results); G.renderer.render(G.scene, G.camera); drawTimeline();
}

// ---------------------------------------------------------------------------------------------------------------------
// Timeline (Sequencer-style blocks)

const TL = { pps: 100 };
function drawTimeline() {
  const el = $('tl'), doc = E.doc, w = Math.max(400, el.clientWidth - 130); TL.pps = w / doc.duration;
  const chars = doc.objects.filter(o => o.type === 'character');
  let html = `<div class="tl-ruler" id="ruler">`;
  for (let s = 0; s <= doc.duration; s += 0.5) html += `<div class="tl-tick" style="left:${s * TL.pps}px">${s % 1 ? '' : s + 's'}</div>`;
  html += `</div>`;
  for (const ch of chars) {
    const rows = Math.max(0, ...ch.clips.map(b => b.row || 0)) + 1;
    for (let r = 0; r < rows + 1; r++) {
      html += `<div class="tl-row${E.sel.char === ch.id ? ' sel' : ''}" data-char="${ch.id}" data-row="${r}"><div class="tl-label">${r ? '&nbsp;&nbsp;↳ row ' + r : ch.name}</div><div class="tl-lane">`;
      for (const b of ch.clips.filter(b => (b.row || 0) === r)) {
        const len = b.end - b.start, sel = E.sel.char === ch.id && E.sel.clip === b.id;
        html += `<div class="blk${b.clip.includes('/') ? ' retarget' : ''}${sel ? ' sel' : ''}" data-id="${b.id}" style="left:${b.start * TL.pps}px;width:${len * TL.pps}px;opacity:${b.mute ? .4 : 1}" title="${b.clip} · ${b.start.toFixed(2)}–${b.end.toFixed(2)} s · speed ${b.speed ?? 1}${b.loop ? ' · loop' : ''}">`
          + `<div class="ramp in" style="width:${(b.blendIn || 0) * TL.pps}px"></div><div class="ramp out" style="width:${(b.blendOut || 0) * TL.pps}px"></div>`
          + `${b.clip}<div class="edge l"></div><div class="edge r"></div><div class="bh in" style="left:${(b.blendIn || 0) * TL.pps}px"></div><div class="bh out" style="right:${(b.blendOut || 0) * TL.pps}px"></div></div>`;
      }
      if (r === 0) for (const tr of doc.tracks.filter(x => x.target === ch.id && x.prop.startsWith('pose.'))) for (const k of tr.keys) html += `<div class="tl-key" style="left:${k.t * TL.pps}px" title="${tr.prop} @ ${k.t.toFixed(2)} s"></div>`;
      html += `</div></div>`;
    }
  }
  html += `<div class="tl-playhead" id="playhead"></div>`;
  el.innerHTML = html; drawPlayhead();
}
function drawPlayhead() { const p = $('playhead'); if (p) p.style.left = `${120 + E.t * TL.pps}px`; }

function initTimeline() {
  const el = $('tl');
  const timeAt = e => { const lane = el.querySelector('.tl-lane') || $('ruler'); return (e.clientX - lane.getBoundingClientRect().left) / TL.pps; };
  el.addEventListener('pointerdown', e => {
    if (e.target.closest('#ruler')) { const mv = ev => setTime(timeAt(ev)); mv(e); el.setPointerCapture(e.pointerId);
      el.onpointermove = mv; el.onpointerup = () => { el.onpointermove = el.onpointerup = null; }; return; }
    const blk = e.target.closest('.blk'), row = e.target.closest('.tl-row'); if (!row) return;
    const cid = row.dataset.char;
    if (!blk) { select({ char: cid, clip: null, bone: E.sel.char === cid ? E.sel.bone : null }); setTime(timeAt(e)); return; }
    const id = blk.dataset.id; select({ char: cid, clip: id, bone: E.sel.bone });
    const ch = E.doc.objects.find(o => o.id === cid), b0 = JSON.parse(JSON.stringify(ch.clips.find(b => b.id === id)));
    const mode = e.target.classList.contains('bh') ? (e.target.classList.contains('in') ? 'blendIn' : 'blendOut')
      : e.target.classList.contains('edge') ? (e.target.classList.contains('l') ? 'left' : 'right') : 'move';
    const before = E.cmd.begin(), t0 = timeAt(e), y0 = e.clientY; el.setPointerCapture(e.pointerId);
    el.onpointermove = ev => {
      Object.assign(E.doc, JSON.parse(before));   // live edit: restore, re-apply the command with the current offset
      const t = timeAt(ev), dt = t - t0;
      if (mode === 'move') { COMMANDS.moveClip(E.doc, { char: cid, id, dt }); const dr = Math.round((ev.clientY - y0) / 34); if (dr) COMMANDS.setClip(E.doc, { char: cid, id, patch: { row: Math.max(0, (b0.row || 0) + dr) } }); }
      else if (mode === 'left' || mode === 'right') COMMANDS.trimClip(E.doc, { char: cid, id, edge: mode, t: (mode === 'left' ? b0.start : b0.end) + dt });
      else { const len = b0.end - b0.start, v = mode === 'blendIn' ? b0.blendIn + dt : b0.blendOut - dt;
        COMMANDS.setClip(E.doc, { char: cid, id, patch: { [mode]: Math.round(Math.min(len, Math.max(0, v)) * 60) / 60 } }); }
      drawTimeline(); requestRender();
    };
    el.onpointerup = () => { el.onpointermove = el.onpointerup = null; E.cmd.commit({ move: 'moveClip', left: 'trimClip', right: 'trimClip' }[mode] || 'setClip', before); };
  });
  el.addEventListener('dblclick', e => {
    const row = e.target.closest('.tl-row'); if (!row || e.target.closest('.blk')) return;
    const ch = E.doc.objects.find(o => o.id === row.dataset.char), clip = E.addClipName || Object.keys(E.A[ch.asset].clips)[0];
    E.cmd.run('addClip', { char: ch.id, clip, start: timeAt(e), duration: E.A[ch.asset].clips[clip].duration, row: +row.dataset.row, loop: true });
  });
  new ResizeObserver(() => drawTimeline()).observe(el);
}

/** keyTravel args that move `ch` at its clip's stride speed over block b, starting from where it is at b.start. */
function travelFor(doc, ch, b, factor = 1) {
  const c = E.A[ch.asset].clips[b.clip], g = c.stride.reduce((a, v) => [a[0] + v[0] / c.stride.length, a[1] + v[1] / c.stride.length], [0, 0]);
  const m = evalCharacter(doc, ch, b.start, E.A, { noIK: true }).matrix, p0 = new THREE.Vector3().setFromMatrixPosition(m);
  const v = new THREE.Vector3(-g[0], 0, -g[1]).transformDirection(m).multiplyScalar(Math.hypot(...g) * (b.speed ?? 1) * factor * new THREE.Vector3().setFromMatrixScale(m).x);
  const p1 = p0.clone().addScaledVector(v, b.end - b.start);
  return { char: ch.id, t0: b.start, t1: b.end, from: [p0.x, p0.z], to: [p1.x, p1.z] };
}

// ---------------------------------------------------------------------------------------------------------------------
// Inspector

function select(s) { E.sel = { ...E.sel, ...s }; if (s.char !== undefined && s.char !== E.sel.char) E.sel.bone = null; refresh(); }
function refresh() { drawTimeline(); drawInspector(); requestRender(); }
const num = (v, d = 3) => +(+v).toFixed(d);
function drawInspector() {
  const el = $('insp'), ch = E.doc.objects.find(o => o.id === E.sel.char);
  if (!ch) { el.innerHTML = `<p class="muted">Click a character in the viewport or a block in the timeline.</p>`; return; }
  const X = E.A[ch.asset], b = ch.clips.find(x => x.id === E.sel.clip), clipOpts = sel => Object.keys(X.clips).map(n => `<option${n === sel ? ' selected' : ''}>${n}</option>`).join('');
  let h = `<h4>${ch.name}</h4><div class="row"><span>Asset</span><span>${ch.asset}</span></div>
    <div class="row"><span>Foot lock IK</span><input type="checkbox" data-ik="feet" ${ch.ik?.feet ? 'checked' : ''}></div>
    <div class="row"><span>Add clip</span><select id="addClip">${clipOpts(E.addClipName)}</select></div>
    <div class="row"><span></span><button type="button" id="addClipBtn">Add at playhead</button></div>`;
  if (b) {
    h += `<h4>Clip block</h4><div class="row"><span>Clip</span><select data-b="clip">${clipOpts(b.clip)}</select></div>
      ${['start', 'end', 'offset', 'speed', 'blendIn', 'blendOut', 'weight'].map(k => `<div class="row"><span>${k}</span><input type="number" step="0.05" data-b="${k}" value="${num(b[k] ?? (k === 'speed' || k === 'weight' ? 1 : 0))}"></div>`).join('')}
      <div class="row"><span>Loop</span><input type="checkbox" data-b="loop" ${b.loop ? 'checked' : ''}></div>
      <div class="row"><span>Root motion</span><select data-b="root">${['clip', 'inPlace', 'accumulate'].map(m => `<option${(b.root || 'clip') === m ? ' selected' : ''}>${m}</option>`).join('')}</select></div>
      <div class="row"><span>Mute</span><input type="checkbox" data-b="mute" ${b.mute ? 'checked' : ''}></div>
      <div class="row"><span></span><button type="button" id="fitTravel" title="Key the character's travel over this block at the clip's stride speed, so an in-place walk covers ground">Match travel to stride</button></div>
      <div class="row"><span></span><button type="button" id="delClip">Delete block</button></div>`;
  }
  if (E.pose) {
    const bn = E.sel.bone !== null ? X.rig.bones[E.sel.bone].name : null, tr = bn && E.doc.tracks.find(x => x.target === ch.id && x.prop === `pose.${bn}`);
    h += `<h4>Pose</h4><div class="row"><span>Bone</span><span>${bn || '<span class="muted">click a joint</span>'}</span></div>`;
    if (bn) h += `<div class="row"><span>Keys</span><span>${tr ? tr.keys.map(k => k.t.toFixed(2)).join(', ') : 'none'}</span></div>
      <div class="row"><span></span><button type="button" id="keyBone">Key at playhead</button></div>
      <div class="row"><span></span><button type="button" id="clearBone">Clear this bone's keys</button></div>`;
  }
  const act = blockWeights(ch.clips, E.t);
  h += `<h4>At ${E.t.toFixed(2)} s</h4>${act.map(x => `<div class="row"><span>${x.b.id}</span><span>${(x.w * 100).toFixed(0)}% · clip ${blockTime(x.b, E.t, X.clips[x.b.clip]?.duration || 1).tau.toFixed(2)} s</span></div>`).join('') || '<p class="muted">rest pose</p>'}`;
  el.innerHTML = h;
  el.querySelectorAll('[data-b]').forEach(inp => inp.onchange = () => {
    const k = inp.dataset.b, v = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? +inp.value : inp.value;
    E.cmd.run('setClip', { char: ch.id, id: b.id, patch: { [k]: v } });
  });
  el.querySelector('[data-ik]').onchange = e => E.cmd.run('setIK', { char: ch.id, patch: { feet: e.target.checked } });
  $('addClip').onchange = e => { E.addClipName = e.target.value; };
  $('addClipBtn').onclick = () => { const c = $('addClip').value; E.cmd.run('addClip', { char: ch.id, clip: c, start: E.t, duration: X.clips[c].duration, row: 0, loop: true }); };
  if ($('fitTravel')) $('fitTravel').onclick = () => E.cmd.run('keyTravel', travelFor(E.doc, ch, b));
  if ($('delClip')) $('delClip').onclick = () => { E.cmd.run('removeClip', { char: ch.id, id: b.id }); E.sel.clip = null; refresh(); };
  if ($('keyBone')) $('keyBone').onclick = () => { const bn = X.rig.bones[E.sel.bone].name, tr = E.doc.tracks.find(x => x.target === ch.id && x.prop === `pose.${bn}`);
    let q = [0, 0, 0, 1]; if (tr?.keys.length) { const { a, b: k2, u } = trackSegment(tr, E.t); q = new THREE.Quaternion().fromArray(a.v).slerp(new THREE.Quaternion().fromArray(k2.v), u).toArray(); }
    E.cmd.run('setBoneKey', { char: ch.id, bone: bn, t: E.t, q }); };
  if ($('clearBone')) $('clearBone').onclick = () => { const bn = X.rig.bones[E.sel.bone].name, tr = E.doc.tracks.find(x => x.target === ch.id && x.prop === `pose.${bn}`);
    if (tr) E.cmd.run('deleteKeys', { keys: tr.keys.map(k => ({ target: ch.id, prop: tr.prop, t: k.t })) }); };
}

// ---------------------------------------------------------------------------------------------------------------------
// Tests (no GPU needed): retarget quality, purity, foot sliding, evaluate cost

const MIX_SEGS = side => [[`mixamorig${side}UpLeg`, `mixamorig${side}Leg`], [`mixamorig${side}Leg`, `mixamorig${side}Foot`], [`mixamorig${side}Arm`, `mixamorig${side}ForeArm`], [`mixamorig${side}ForeArm`, `mixamorig${side}Hand`]];
const TESTS = {
  /** Retarget xbot clips onto soldier (same names, different bone axes) and robot (other names) with three's
   *  SkeletonUtils.retargetClip and with the rest-relative method; limb-direction error against the source. */
  retarget(clipName = 'walk') {
    const A = E.A, src = A.xbot, out = {}, segsMix = [...MIX_SEGS('Left'), ...MIX_SEGS('Right'), ['mixamorigHips', 'mixamorigNeck']];
    const robotOf = n => Object.entries(MIXAMO_TO_ROBOT).find(([, s]) => s === n)?.[0];
    const skinned = root => { let s = null; root.traverse(o => { if (o.isSkinnedMesh && (!s || o.skeleton.bones.length > s.skeleton.bones.length)) s = o; }); return s; };
    for (const dstId of ['soldier', 'robot']) {
      const dst = A[dstId], map = dstId === 'robot' ? MIXAMO_TO_ROBOT : identityMap(src.rig, dst.rig);
      const segs = segsMix.map(([a, b]) => dstId === 'robot' ? [a, b, robotOf(a), robotOf(b)] : [a, b, a, b]).filter(s => s[2] && s[3]);
      const clip = src.raw[clipName], res = {};
      // three.js SkeletonUtils.retargetClip (copies the source's world rotations; needs matching bone axes)
      const sClone = SkeletonUtils.clone(src.gltf.scene), dClone = SkeletonUtils.clone(dst.gltf.scene);
      const sMesh = skinned(sClone), dMesh = skinned(dClone);
      let t0 = performance.now();
      const threeClip = SkeletonUtils.retargetClip(dMesh, sMesh, clip, { names: map, hip: 'mixamorigHips', fps: 30 });
      res.three = { ms: +(performance.now() - t0).toFixed(1), err: segmentError(src.rig, clip, dst.rig, threeClip, segs) };
      t0 = performance.now();
      const rr = retargetRestRelative(src.rig, dst.rig, clip, map);
      res.restRelative = { ms: +(performance.now() - t0).toFixed(1), err: segmentError(src.rig, clip, dst.rig, rr, segs) };
      if (dstId === 'soldier' && dst.raw.TPose) { const rest = restFromClip(dst.rig, dst.raw.TPose); res.restRelative_TPoseClip = { err: segmentError(src.rig, clip, dst.rig, retargetRestRelative(src.rig, dst.rig, clip, map, { dstRest: rest }), segs) }; }
      const al = alignRest(src.rig, dst.rig, map);
      res.restRelative_aligned = { err: segmentError(src.rig, clip, dst.rig, retargetRestRelative(src.rig, dst.rig, clip, map, { dstRest: al }), segs) };
      const summary = r => ({ ms: r.ms, meanDeg: +(r.err.reduce((s, e) => s + e.mean, 0) / r.err.length).toFixed(2), worst: r.err.reduce((a, e) => (e.max > a.max ? e : a)) });
      out[dstId] = Object.fromEntries(Object.entries(res).map(([k, r]) => [k, summary(r)]));
      out[dstId].detail = res;
    }
    return out;
  },
  /** Rest-pose facts per asset: arm direction (T-pose = horizontal), hip height, foot contacts per clip. */
  rigs() {
    return Object.fromEntries(Object.entries(E.A).map(([id, X]) => {
      const W = fk(X.rig, X.rig.bones.map(b => ({ p: b.p, q: b.q, s: b.s }))), P = i => new THREE.Vector3().setFromMatrixPosition(W[i]);
      const arm = ['mixamorigLeftArm', 'UpperArmL'].map(n => X.rig.byName[n]).find(i => i !== undefined), fore = ['mixamorigLeftForeArm', 'LowerArmL'].map(n => X.rig.byName[n]).find(i => i !== undefined);
      const d = P(fore).sub(P(arm)).normalize();
      return [id, { bones: X.rig.bones.length, hipHeight: +X.rig.hipHeight.toFixed(3), leftUpperArmDir: d.toArray().map(v => +v.toFixed(2)), legs: X.rig.legs.map(l => l.map(i => X.rig.bones[i].name)),
        clips: Object.fromEntries(Object.entries(X.clips).map(([n, c]) => [n, { dur: +c.duration.toFixed(2), hipTravel: new THREE.Vector3().fromArray(c.hipEnd).sub(new THREE.Vector3().fromArray(c.hipStart)).toArray().map(v => +v.toFixed(1)), contacts: c.contacts.map(iv => iv.map(([a, b]) => `${a.toFixed(2)}-${b.toFixed(2)}`).join(' ')) }])) }];
    }));
  },
  /** Same t, any order, same pose: evaluate frames in order, reversed and shuffled; compare a hash of every bone. */
  purity(n = 120) {
    const fr = [...Array(n).keys()].map(i => i * E.doc.duration / n), h = t => { const R = evaluateAll(E.doc, t); return JSON.stringify(Object.values(R).map(r => r.locals.map(l => [...l.p, ...l.q].map(v => Math.round(v * 1e6))))); };
    const a = fr.map(h), b = [...fr].reverse().map(h).reverse(), sh = fr.map((t, i) => [Math.sin(i * 12.9898) * 43758.5453 % 1, i]).sort((x, y) => x[0] - y[0]).map(x => x[1]);
    const c = new Array(n); sh.forEach(i => { c[i] = h(fr[i]); });
    return { frames: n, forwardVsReverse: a.every((x, i) => x === b[i]), forwardVsShuffled: a.every((x, i) => x === c[i]) };
  },
  /** Foot sliding: horizontal speed of each planted foot in the world, with foot lock off and on. */
  footSlide(charId, from = 0, to = E.doc.duration) {
    const doc = JSON.parse(JSON.stringify(E.doc)), ch = doc.objects.find(o => o.id === charId), X = E.A[ch.asset], fps = 60, res = {};
    for (const ik of [false, true]) {
      ch.ik = { ...(ch.ik || {}), feet: ik }; let slide = 0, time = 0, prev = null;
      for (let t = from; t <= to; t += 1 / fps) {
        const r = evalCharacter(doc, ch, t, E.A), act = blockWeights(ch.clips, t).filter(x => X.clips[x.b.clip]);
        if (!act.length) { prev = null; continue; }
        const dom = act.reduce((a, b) => (b.w > a.w ? b : a)), c = X.clips[dom.b.clip], tau = blockTime(dom.b, t, c.duration).tau;
        const feet = X.rig.legs.map(l => new THREE.Vector3().setFromMatrixPosition(r.world[l[2]]).applyMatrix4(r.matrix));
        const planted = c.contacts.map(iv => iv.some(([a, b]) => tau >= a + 0.05 && tau <= b - 0.05));
        if (prev) feet.forEach((p, i) => { if (planted[i] && prev.planted[i]) { slide += Math.hypot(p.x - prev.feet[i].x, p.z - prev.feet[i].z); time += 1 / fps; } });
        prev = { feet, planted };
      }
      res[ik ? 'ikOn' : 'ikOff'] = { plantedSeconds: +time.toFixed(2), slideMetres: +slide.toFixed(3), slideCmPerSec: +(100 * slide / Math.max(time, 1e-6)).toFixed(2) };
    }
    return res;
  },
  /** CPU cost of evaluating n copies of every character per frame (IK on and off). */
  cost(counts = [1, 5, 20], frames = 60) {
    const out = {};
    for (const n of counts) for (const ik of [false, true]) {
      const base = E.doc.objects.filter(o => o.type === 'character'), doc = JSON.parse(JSON.stringify(E.doc));
      doc.objects = []; for (let k = 0; k < n; k++) { const c = JSON.parse(JSON.stringify(base[k % base.length])); c.id += '_' + k; c.ik = { ...(c.ik || {}), feet: ik }; doc.objects.push(c); }
      const ix = indexTracks(doc), t0 = performance.now();
      for (let f = 0; f < frames; f++) { const t = 1 + f / 60; for (const c of doc.objects) evalCharacter(doc, c, t, E.A, { ix }); }
      out[`${n} chars, IK ${ik ? 'on' : 'off'}`] = `${((performance.now() - t0) / frames).toFixed(2)} ms/frame`;
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------------------------------
// Boot

async function main() {
  const sceneName = Q.get('scene') || 'characters.scene.json';
  E.sceneName = sceneName;
  E.doc = await (await fetch(`/scenes/${sceneName}`, { cache: 'no-store' })).json();
  const t0 = performance.now(); const { A, timing } = await loadAssets(E.doc); E.A = A; E.loadTiming = { ...timing, all: +(performance.now() - t0).toFixed(0) };
  E.cmd = createCommandStack(() => E.doc, (name) => { syncInstances(); refresh(); if (name !== 'noop') E.dirty = true; });
  window.VS = { E, cmd: (n, a) => E.cmd.run(n, a), evalAt: (t) => evaluateAll(E.doc, t), tests: TESTS, setTime, travelFor };
  if (!NOGPU) await initGPU(); else $('vpMsg').textContent = 'nogpu: evaluation only';
  syncInstances(); initTimeline(); refresh();
  $('play').onclick = () => { E.playing = !E.playing; $('play').textContent = E.playing ? 'Pause' : 'Play'; lastNow = performance.now(); };
  $('pose').onclick = () => { E.pose = !E.pose; $('pose').setAttribute('aria-pressed', E.pose); if (E.pose) { E.playing = false; $('play').textContent = 'Play'; } refresh(); };
  $('undo').onclick = () => E.cmd.undo(); $('redo').onclick = () => E.cmd.redo();
  $('save').onclick = async () => { const r = await fetch(`/save-scene/${sceneName}`, { method: 'POST', body: JSON.stringify(E.doc, null, 1) }); $('vpMsg').textContent = r.ok ? 'saved' : 'save failed'; };
  addEventListener('keydown', e => {
    if (e.target.matches('input, select')) return;
    if (e.key === ' ') { e.preventDefault(); $('play').click(); }
    else if (e.key === 'Tab') { e.preventDefault(); $('pose').click(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? E.cmd.redo() : E.cmd.undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); $('save').click(); }
    else if (e.key === 'ArrowRight') setTime(E.t + 1 / E.doc.fps); else if (e.key === 'ArrowLeft') setTime(E.t - 1 / E.doc.fps);
    else if (e.key === 'Delete' && E.sel.clip) { E.cmd.run('removeClip', { char: E.sel.char, id: E.sel.clip }); E.sel.clip = null; refresh(); }
  });
  window.VS_READY = true;
  tick(performance.now());
}
main().catch(e => { console.error(e); window.VS_ERROR = String(e.stack || e); $('vpMsg').textContent = String(e); });
