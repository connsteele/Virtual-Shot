// Inspector (Blender Properties / Unreal Details), with After Effects stopwatches: every animatable property has a
// stopwatch (animate it), its value at the playhead, and key navigation (previous key, key here, next key).
// Editing an animated property at the playhead sets a key there; editing a static one sets its value.
import * as THREE from 'three/webgpu';
import { esc } from './outliner.js';

const RIG = [
  ['dist', 'Distance', 'glass widths', 0.01, 3], ['fov', 'Field of view', '° vertical', 0.1, 2], ['x', 'Pan X', 'glass widths', 0.005, 3],
  ['y', 'Pan Y', 'glass widths', 0.005, 3], ['yaw', 'Yaw', '°', 0.1, 2], ['pitch', 'Pitch', '°', 0.1, 2],
  ['squint', 'Squint', '0–1', 0.01, 3], ['distort', 'Lens distortion', '0–1', 0.01, 3],
];
const SNAP = 1 / 120;

export class Inspector {
  constructor(E, el, title) {
    this.E = E; this.el = el; this.title = title;
    E.on('select', () => this.draw()); E.on('change', () => this.draw()); E.on('view', () => this.draw()); E.on('frame', () => this.refresh()); E.on('mode', () => this.draw()); E.on('take', () => this.draw());
    el.addEventListener('change', e => this.onInput(e.target, true));
    el.addEventListener('click', e => { const b = e.target.closest('button'); if (b) this.onButton(b); });
  }
  track(target, prop) { return this.E.doc.tracks.find(t => t.target === target && t.prop === prop); }

  /** A keyable property row: stopwatch, label, value at the playhead, key navigation. */
  keyRow(target, prop, label, unit, step, dec, value) {
    const tr = this.track(target, prop), anim = !!(tr && tr.keys.length), t = this.E.frame / this.E.fps;
    const atKey = anim && tr.keys.some(k => Math.abs(k.t - t) < SNAP);
    return `<div class="prop${anim ? ' keyed' : ''}${atKey ? ' atkey' : ''}" data-target="${target}" data-prop="${prop}">
      <button type="button" class="stopwatch" data-act="watch" aria-pressed="${anim}" title="${anim ? 'Stop animating (removes its keys)' : 'Animate this property'}">⏱</button>
      <label title="${esc(unit)}">${esc(label)}</label>
      <input type="number" step="${step}" data-dec="${dec}" value="${(+value).toFixed(dec)}" aria-label="${esc(label)}">
      <span class="keynav">${anim ? `<button type="button" data-act="prevkey" title="Previous key">◀</button><button type="button" data-act="togglekey" class="${atKey ? 'on' : ''}" title="${atKey ? 'Delete the key here' : 'Add a key here'}">◆</button><button type="button" data-act="nextkey" title="Next key">▶</button>` : ''}</span>
    </div>`;
  }
  flagRow(path, label, on) { return `<div class="prop static"><label>${esc(label)}</label><input type="checkbox" ${on ? 'checked' : ''} data-objp="${path}" aria-label="${esc(label)}"></div>`; }
  staticRow(path, label, value, step = 0.01, attrs = '') {
    return `<div class="prop static"><label>${esc(label)}</label><input type="number" step="${step}" value="${value}" data-look="${path}" ${attrs} aria-label="${esc(label)}"></div>`;
  }

  draw() {
    const E = this.E, s = E.sel, d = E.doc, st = E.st || E.state();
    let title = 'Inspector', html = '';
    if (E.mode === 'render') { this.title.textContent = 'Render'; this.el.innerHTML = this.renderPanel(); return; }
    if (s.kind === 'object') {
      const o = d.objects.find(o => o.id === s.id); title = o.name || o.id;
      html += `<div class="sect"><h3>${esc(o.type)}</h3><div class="prop static"><label>Name</label><input type="text" value="${esc(o.name || '')}" data-obj="name" aria-label="Name"></div>
        <div class="note">id <code>${esc(o.id)}</code>${o.asset ? ` · asset <code>${esc(d.assets[o.asset])}</code>` : ''}</div></div>`;
      if (o.transform) {
        const tf = o.transform, e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...(tf.quaternion || [0, 0, 0, 1])), 'XYZ');
        const vec = (k, v, step, dec) => `<div class="vec">${v.map((x, i) => `<input type="number" step="${step}" value="${(+x).toFixed(dec)}" data-tf="${k}" data-i="${i}" aria-label="${k} ${'XYZ'[i]}">`).join('')}</div>`;
        html += `<div class="sect"><h3>Transform</h3>
          <div class="prop static"><label>Position (m)</label>${vec('position', tf.position || [0, 0, 0], 0.001, 4)}</div>
          <div class="prop static"><label>Rotation (°, XYZ)</label>${vec('rotation', [e.x, e.y, e.z].map(r => r * 180 / Math.PI), 0.1, 2)}</div>
          <div class="prop static"><label>Scale</label>${vec('scale', tf.scale || [1, 1, 1], 0.001, 4)}</div>
          ${E.view === 'free' ? '<div class="note">Drag the gizmo in the viewport: G move, R rotate, S scale.</div>' : '<div class="note">Switch to Free view to move it with a gizmo.</div>'}</div>`;
      }
      if (o.type === 'camera') {
        html += `<div class="sect"><h3>Camera rig · head-on to ${esc(o.rig.frame)}</h3>${RIG.map(([n, l, u, stp, dec]) => this.keyRow('cam', 'rig.' + n, l, u, stp, dec, st.rig[n])).join('')}
          <div class="note">Distance and pan are in glass widths, as Black Page keyed them; FOV and distance ease geometrically.</div></div>
          <div class="sect"><h3>Focus</h3>${(this.track('cam', 'focus')?.keys || []).map(k => `<div class="note">${k.t.toFixed(2)} s · ${esc(k.v.target)} · ${k.v.px} px/dioptre${k.curve ? ' · ' + esc(k.curve) : ''}</div>`).join('')}
          <div class="note">Focus keys are records (a target object and blur settings); editing them is not in the spike.</div></div>
          <div class="sect"><h3>Handheld</h3>${this.flagRow('handheld.on', 'Handheld shake', o.handheld?.on)}
            ${[['amount', 'Amount', 1, 0.05], ['rot', 'Sway (°)', 0.6, 0.05], ['roll', 'Roll (°)', 0.35, 0.05], ['pos', 'Drift (m)', 0.004, 0.001], ['freq', 'Speed (Hz)', 0.7, 0.05], ['seed', 'Seed', 1, 1]]
              .map(([k, l, d, stp]) => `<div class="prop static"><label>${l}</label><input type="number" step="${stp}" value="${o.handheld?.[k] ?? d}" data-objp="handheld.${k}" aria-label="Handheld ${l}"></div>`).join('')}
            <div class="note">Procedural and repeatable: the same time always gives the same shake. Off by default.</div></div>
          <div class="sect"><h3>Shutter (motion blur)</h3>${this.flagRow('shutter.on', 'Motion blur', o.shutter?.on)}
            <div class="prop static"><label>Shutter angle (°)</label><input type="number" step="15" value="${o.shutter?.angle ?? 180}" data-objp="shutter.angle" aria-label="Shutter angle"></div>
            <div class="prop static"><label>Samples</label><input type="number" step="1" min="2" value="${o.shutter?.samples ?? 8}" data-objp="shutter.samples" aria-label="Shutter samples"></div>
            <div class="note">Render quality and renders to disk only: each frame is rendered once per sample and averaged.</div></div>
          <div class="sect"><h3>Gamepad take</h3><button type="button" data-act="take">${E.take?.on ? 'Stop take' : 'Record take'}</button>
            <div class="note">Plays the shot and records the rig from a gamepad: left stick pans, right stick turns, triggers dolly, bumpers zoom. A stops and writes keys (thinned to Bézier curves, one undo); B cancels.</div></div>`;
      }
      if (o.ring) html += `<div class="sect"><h3>Ringing</h3>${['t', 'intensity', 'light', 'radius', 'rumble'].map(k => `<div class="prop static"><label>${k === 't' ? 'Starts at (s)' : k}</label><input type="number" step="0.01" value="${o.ring[k]}" data-objp="ring.${k}" aria-label="ring ${k}"></div>`).join('')}</div>`;
      if (o.type === 'card') html += `<div class="sect"><h3>Card</h3><div class="prop static"><label>Brightness</label><input type="number" step="0.05" value="${o.brightness}" data-objp="brightness" aria-label="Brightness"></div></div>`;
      if (o.type === 'led') html += `<div class="sect"><h3>LED</h3><div class="prop static"><label>Colour</label><input type="text" value="${esc(o.color)}" data-objp="color" aria-label="Colour"></div>
        <div class="prop static"><label>Intensity</label><input type="number" step="0.05" value="${o.intensity}" data-objp="intensity" aria-label="Intensity"></div></div>`;
    } else if (s.kind === 'scene') {
      title = 'Scene';
      html += `<div class="sect"><h3>Parameters</h3>${this.keyRow('scene', 'params.chaos', 'Chaos', '0–1: jitter, glitch bands, warmer glow', 0.01, 3, st.chaos)}</div>
        <div class="sect"><h3>Shot</h3><div class="note">${d.fps} fps · ${d.duration} s · ${E.last + 1} frames · ${d.output.width}×${d.output.height} · reveal at ${d.sequence.reveal.start} s</div></div>`;
    } else if (s.kind === 'layer') {
      const L = d.layers.find(l => l.id === s.id); title = 'Chat layer';
      const t = E.frame / E.fps;
      html += `<div class="sect"><h3>Messages</h3><div class="list">${L.script.messages.map((m, i) => `<div class="item${m.t <= t ? ' on' : ''}">
          <input type="number" step="0.01" value="${m.t}" data-ev="messages" data-i="${i}" data-k="t" aria-label="Time of message ${i + 1}">
          <input type="text" value="${esc(m.system || `${m.user}> ${m.text}`)}" data-ev="messages" data-i="${i}" data-k="${m.system ? 'system' : 'text'}" ${m.system ? '' : `data-user="${esc(m.user)}"`} aria-label="Message ${i + 1}"></div>`).join('')}</div>
        <div class="note">Highlighted messages have appeared by the playhead. Edit "user> text"; times are seconds.</div></div>`;
    } else if (s.kind === 'events') {
      title = s.id === 'pops' ? 'Pops' : 'Ghost flashes';
      const list = d.events[s.id];
      html += `<div class="sect"><h3>${title}</h3><div class="list">${list.map((g, i) => `<div class="item">
          <input type="number" step="0.01" value="${(+g.t).toFixed(3)}" data-ev="${s.id}" data-i="${i}" data-k="t" aria-label="Time ${i + 1}">
          ${s.id === 'pops' ? `<input type="text" value="${esc(g.text)}" data-ev="pops" data-i="${i}" data-k="text" aria-label="Pop text ${i + 1}">` : `<span class="muted">${esc(g.img.replace('ghost_', ''))} · ${g.dur}s · ${g.intensity}</span>`}</div>`).join('')}</div></div>`;
    } else if (s.kind === 'look' && s.id === 'lighting') {
      title = 'Lighting'; const L = d.look.lighting;
      html += `<div class="sect"><h3>Screen light</h3>${this.staticRow('lighting.screen', 'Screen', L.screen, 0.1)}${this.staticRow('lighting.bounce', 'Bounce', L.bounce, 0.05)}${this.staticRow('lighting.ambient', 'Ambient', L.ambient, 0.01)}
        <div class="note">The CRT is the only light; bounce is its light off the unseen room.</div></div>`;
    } else if (s.kind === 'look' && s.id === 'haze') {
      title = 'Haze'; const H = d.look.haze, D = H.density;
      html += `<div class="sect"><h3>Strength</h3>${this.staticRow('haze.level.base', 'Target level', H.level.base, 0.0005)}${this.staticRow('haze.level.end', 'Level at the cut', H.level.end, 0.0005)}${this.staticRow('haze.level.maxGain', 'Max gain', H.level.maxGain, 0.05)}
          <div class="note">The haze is scaled toward a target brightness per frame, from the baked levels.</div></div>
        <div class="sect"><h3>Lights in the haze</h3>${this.staticRow('haze.screenLight', 'Screen emission', H.screenLight, 1)}${this.staticRow('haze.ringW', 'Ring light (W per level)', H.ringW, 0.005)}${this.staticRow('haze.ledW', 'LED light (W)', H.ledW, 0.001)}</div>
        <div class="sect"><h3>Density field (Cycles noise)</h3><div class="note">scale ${D.scale} · detail ${D.detail} · roughness ${D.roughness} · distortion ${D.distortion} · wisp ${D.wisp} · cover ${D.cover.join('–')} · drift ${D.drift} m/s · evolve ${D.evolve}/s · anisotropy ${H.anisotropy}</div>
          <div class="note">These are compiled into the haze shader; changing them live isn't in the spike.</div></div>`;
    }
    this.title.textContent = title; this.el.innerHTML = html;
  }

  renderPanel() {
    const E = this.E, local = E.canSave;
    return `<div class="sect"><h3>Frames to disk</h3>
      <div class="prop static"><label>From frame</label><input type="number" id="rFrom" value="${E.renderFrom ?? 0}" min="0" max="${E.last}" aria-label="From frame"></div>
      <div class="prop static"><label>To frame</label><input type="number" id="rTo" value="${E.renderTo ?? E.last}" min="0" max="${E.last}" aria-label="To frame"></div>
      <div class="prop static"><label>Folder</label><input type="text" id="rDir" value="${esc(E.renderDir || 'editor_render')}" aria-label="Output folder"></div>
      <div class="note">PNG, 1920×1080 (3840×2160 with Chunky pixels on), Render quality, to G:\\Claude\\Virtual Legacy\\Channel\\Virtual Shot spike\\&lt;folder&gt;. Frames always have the full look: the viewport's Show settings (except Chunky pixels) and hidden objects don't apply.</div>
      <div class="r-btns"><button type="button" class="primary" data-act="render" id="rStart" ${local && !E.rendering ? '' : 'disabled'}>${E.rendering ? 'Rendering…' : 'Render frames'}</button>
        <button type="button" data-act="stopRender" id="rStop" title="Stop the render (Esc). Frames already written are kept." ${E.rendering ? '' : 'disabled'}>Stop</button></div>
      ${local ? '' : '<div class="note">Rendering to disk needs the local copy of the editor (artifacts can\'t write files).</div>'}
      <div class="progress" aria-hidden="true"><div id="rBar"></div></div><div class="note" id="rMsg"></div></div>`;
  }

  /** Values change with the playhead: update the keyable rows without rebuilding (keeps focus and typing). */
  refresh() {
    const E = this.E, st = E.st; if (!st) return;
    this.el.querySelectorAll('.prop[data-target]').forEach(row => {
      const tg = row.dataset.target, prop = row.dataset.prop, inp = row.querySelector('input');
      const v = tg === 'cam' ? st.rig[prop.slice(4)] : tg === 'scene' ? st.chaos : null;
      if (v !== null && document.activeElement !== inp) inp.value = (+v).toFixed(+inp.dataset.dec);
      const tr = this.track(tg, prop), t = E.frame / E.fps, atKey = !!tr && tr.keys.some(k => Math.abs(k.t - t) < SNAP);
      row.classList.toggle('atkey', atKey); const kb = row.querySelector('[data-act="togglekey"]'); if (kb) kb.classList.toggle('on', atKey);
    });
    if (E.sel.kind === 'layer') { const t = E.frame / E.fps; this.el.querySelectorAll('.item').forEach((it, i) => it.classList.toggle('on', E.doc.layers[0].script.messages[i]?.t <= t)); }
  }

  onInput(inp) {
    const E = this.E, t = E.frame / E.fps, row = inp.closest('.prop[data-target]');
    try {
      if (row) { const v = +inp.value, tr = this.track(row.dataset.target, row.dataset.prop);
        if (tr && tr.keys.length) E.cmd.run('setKey', { target: row.dataset.target, prop: row.dataset.prop, t, v });
        else E.cmd.run('setStatic', { target: row.dataset.target, prop: row.dataset.prop, v }); return; }
      if (inp.dataset.tf) { const o = E.doc.objects.find(o => o.id === E.sel.id), tf = JSON.parse(JSON.stringify(o.transform)), i = +inp.dataset.i;
        if (inp.dataset.tf === 'rotation') { const vals = [...this.el.querySelectorAll('[data-tf="rotation"]')].map(x => +x.value * Math.PI / 180);
          tf.quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(...vals, 'XYZ')).toArray(); }
        else { tf[inp.dataset.tf] = (tf[inp.dataset.tf] || (inp.dataset.tf === 'scale' ? [1, 1, 1] : [0, 0, 0])).slice(); tf[inp.dataset.tf][i] = +inp.value; }
        E.cmd.run('setTransform', { id: o.id, transform: tf }); return; }
      if (inp.dataset.obj) { E.cmd.run('rename', { id: E.sel.id, name: inp.value }); return; }
      if (inp.dataset.objp) { E.cmd.run('setObjectProp', { id: E.sel.id, path: inp.dataset.objp, value: inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? +inp.value : inp.value }); return; }
      if (inp.dataset.look) { E.cmd.run('setLook', { path: inp.dataset.look, value: +inp.value }); return; }
      if (inp.dataset.ev) { const k = inp.dataset.k; let patch;
        if (k === 't') patch = { t: +inp.value };
        else if (k === 'text' && inp.dataset.user !== undefined) { const m = inp.value.match(/^([^>]*)>\s?(.*)$/); patch = m ? { user: m[1], text: m[2] } : { text: inp.value }; }
        else patch = { [k]: inp.value };
        E.cmd.run('setEvent', { kind: inp.dataset.ev, index: +inp.dataset.i, patch }); return; }
      if (inp.id === 'rFrom') E.renderFrom = +inp.value; if (inp.id === 'rTo') E.renderTo = +inp.value; if (inp.id === 'rDir') E.renderDir = inp.value;
    } catch (e) { E.status(e.message); }
  }

  onButton(b) {
    const E = this.E, row = b.closest('.prop[data-target]'), act = b.dataset.act, t = E.frame / E.fps;
    if (act === 'stopRender') return E.stopRender();
    if (act === 'take') { E.take.on ? E.take.stop(true) : E.take.start(); return this.draw(); }
    if (act === 'render') return E.emit('renderFrames', { from: E.renderFrom ?? 0, to: E.renderTo ?? E.last, dir: E.renderDir || 'editor_render' });
    if (!row) return;
    const target = row.dataset.target, prop = row.dataset.prop, tr = this.track(target, prop), v = +row.querySelector('input').value;
    if (act === 'watch') E.cmd.run('setAnimated', { target, prop, t, v, on: !(tr && tr.keys.length) });
    if (act === 'togglekey') { const has = tr.keys.some(k => Math.abs(k.t - t) < SNAP);
      E.cmd.run(has ? 'deleteKeys' : 'setKey', has ? { keys: [{ target, prop, t }] } : { target, prop, t, v }); }
    if (act === 'prevkey') { const k = tr.keys.filter(k => k.t < t - SNAP).pop(); if (k) E.setFrame(k.t * E.fps); }
    if (act === 'nextkey') { const k = tr.keys.find(k => k.t > t + SNAP); if (k) E.setFrame(k.t * E.fps); }
  }
}
