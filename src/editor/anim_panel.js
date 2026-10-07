// Inspector sections for object animation: keyable transform, visibility, material and light rows (After Effects
// stopwatches), the parent, constraints (attach, look at, follow path), procedural behaviours and baked glTF clips.
// Every edit is a named command (src/core/commands.js), so it is undoable and scriptable like the rest.
import { esc } from './outliner.js';
import { PROPS, propsFor, staticValue } from '../core/animate.js';
import { typedValue } from '../core/tracks.js';
import { BEHAVIOURS } from '../core/behaviours.js';

const CON = { attach: 'Attach to', lookAt: 'Look at', followPath: 'Follow path' };
const AXES = ['+z', '-z', '+x', '-x', '+y', '-y'];

/** An object property's value at time t, before behaviours and constraints (what its keys or static value say). */
export function propValue(doc, o, prop, t) {
  const tr = doc.tracks.find(x => x.target === o.id && x.prop === prop);
  return tr && tr.keys.length ? typedValue(tr, t) : staticValue(o, prop);
}

/** The animation sections for object o, built with the inspector's keyRow. */
export function animSections(I, o) {
  const E = I.E, d = E.doc, t = E.frame / E.fps, P = propsFor(o), row = (prop, label, meta = PROPS[prop] || {}) =>
    I.keyRow(o.id, prop, label || meta.label, meta.unit || '', meta.step || 0.01, meta.dec ?? 3, propValue(d, o, prop, t), meta.type);
  const group = g => P.filter(p => PROPS[p].group === g).map(p => row(p)).join('');
  let html = '';
  if (o.transform) {
    html += `<div class="sect"><h3>Transform${o.parent ? ` · in ${esc(d.objects.find(x => x.id === o.parent)?.name || o.parent)}` : ''}</h3>${group('Transform')}
      <div class="note">${E.view === 'free' ? 'Drag the gizmo in the viewport: G move, R rotate, S scale. Keyed values get a key at the playhead.' : 'Switch to Free view to move it with a gizmo.'}</div></div>
      <div class="sect"><h3>Visibility</h3>${group('Visibility')}<div class="note">Keyed visibility steps (each key holds until the next). The eye in the outliner only hides it in this viewport.</div></div>`;
  }
  for (const g of ['Material', 'Light']) { const r = group(g); if (r) html += `<div class="sect"><h3>${g}</h3>${r}</div>`; }
  if (!o.transform) return html;

  // parent and constraints: targets are other objects with a transform (not descendants, which would be a cycle)
  const desc = id => d.objects.filter(x => x.parent === id).flatMap(x => [x.id, ...desc(x.id)]), no = new Set([o.id, ...desc(o.id)]);
  const targets = d.objects.filter(x => x.transform && !no.has(x.id) && x.type !== 'path'), paths = d.objects.filter(x => x.type === 'path');
  const opts = (list, sel, none) => (none ? `<option value="">${none}</option>` : '') + list.map(x => `<option value="${esc(x.id)}"${x.id === sel ? ' selected' : ''}>${esc(x.name || x.id)}</option>`).join('');
  html += `<div class="sect"><h3>Parent</h3><div class="prop static"><label>Parent</label><select data-anim="parent" aria-label="Parent">${opts(targets, o.parent, 'None (world)')}</select></div>
    <div class="note">Its transform becomes relative to the parent; it keeps its place when you change parents.</div></div>`;
  html += `<div class="sect"><h3>Constraints</h3>${(o.constraints || []).map(c => `<div class="sub" data-cid="${esc(c.id)}">
      <div class="prop static"><label><input type="checkbox" data-anim="conOn" ${c.on === false ? '' : 'checked'} aria-label="Constraint on"> ${CON[c.type]}</label>
        <select data-anim="conRef" aria-label="Target">${c.type === 'followPath' ? opts(paths, c.path) : opts(targets, c.target)}</select>
        <button type="button" data-anim="conDel" title="Remove this constraint">✕</button></div>
      ${c.type === 'lookAt' ? `<div class="prop static"><label>Aim axis</label><select data-anim="conAxis" aria-label="Aim axis">${AXES.map(a => `<option${(c.axis || '+z') === a ? ' selected' : ''}>${a}</option>`).join('')}</select></div>` : ''}
      ${row(`constraints.${c.id}.influence`, 'Influence', { unit: '0–1', step: 0.01, dec: 2 })}
      ${c.type === 'followPath' ? row(`constraints.${c.id}.u`, 'Progress', { unit: '0–1 along the path, by length', step: 0.005, dec: 3 }) : ''}</div>`).join('')}
    <div class="r-btns"><button type="button" data-anim="conAdd" data-type="attach" ${targets.length ? '' : 'disabled'}>+ Attach</button>
      <button type="button" data-anim="conAdd" data-type="lookAt" ${targets.length ? '' : 'disabled'}>+ Look at</button>
      <button type="button" data-anim="conAdd" data-type="followPath" ${paths.length ? '' : 'disabled'} title="${paths.length ? '' : 'Add a path first (VS.cmd(\'addPath\', …))'}">+ Follow path</button></div>
    <div class="note">Applied in order after the parent. Key Influence with Hold keys to pick something up and put it down.</div></div>`;
  const numProps = ['transform', ...P.filter(p => PROPS[p].group !== 'Transform' && !PROPS[p].type)];
  html += `<div class="sect"><h3>Behaviours</h3>${(o.behaviours || []).map(b => { const B = BEHAVIOURS[b.type]; return `<div class="sub" data-bid="${esc(b.id)}">
      <div class="prop static"><label title="${esc(B.note)}"><input type="checkbox" data-anim="behOn" ${b.on === false ? '' : 'checked'} aria-label="Behaviour on"> ${esc(B.label)}</label>
        ${B.target ? `<select data-anim="behProp" aria-label="Drives">${numProps.filter(p => B.target === 'transform' || p !== 'transform').map(p => `<option value="${p}"${(b.prop || B.target) === p ? ' selected' : ''}>${p === 'transform' ? 'Position' : esc(PROPS[p].label)}</option>`).join('')}</select>` : '<span></span>'}
        <button type="button" data-anim="behDel" title="Remove this behaviour">✕</button></div>
      ${row(`behaviours.${b.id}.weight`, 'Weight', { unit: '0–1', step: 0.01, dec: 2 })}
      ${Object.entries(B.params).map(([k, p]) => row(`behaviours.${b.id}.${k}`, p.label, { unit: p.unit, step: p.step, dec: 4 })).join('')}</div>`; }).join('')}
    <div class="prop static"><label>Add</label><select data-anim="behAdd" aria-label="Add a behaviour"><option value="">Behaviour…</option>${Object.entries(BEHAVIOURS).map(([k, B]) => `<option value="${k}">${esc(B.label)}</option>`).join('')}</select></div>
    <div class="note">Procedural motion with its settings in the scene file; every setting can be keyed. Seeded by the object and behaviour ids.</div></div>`;
  const names = Object.keys(E.shot.geo.clips?.[o.id] || {});
  if (o.type === 'model') html += `<div class="sect"><h3>Animation clips</h3>${names.length ? (o.clips || []).map(c => `<div class="sub" data-kid="${esc(c.id)}">
      <div class="prop static"><label>Clip</label><select data-anim="clipName" aria-label="Clip">${names.map(n => `<option${n === c.name ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select><button type="button" data-anim="clipDel" title="Remove">✕</button></div>
      ${[['start', 'Starts at (s)', 0.01], ['speed', 'Speed', 0.05], ['offset', 'Clip offset (s)', 0.01], ['fadeIn', 'Fade in (s)', 0.05]].map(([k, l, s]) => `<div class="prop static"><label>${l}</label><input type="number" step="${s}" value="${c[k] ?? (k === 'speed' ? 1 : 0)}" data-anim="clipNum" data-k="${k}" aria-label="${l}"></div>`).join('')}
      <div class="prop static"><label>Loop</label><select data-anim="clipLoop" aria-label="Loop">${['repeat', 'once', 'pingpong'].map(l => `<option${(c.loop || 'repeat') === l ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
      ${row(`clips.${c.id}.weight`, 'Weight', { unit: '0–1', step: 0.01, dec: 2 })}</div>`).join('') + `<div class="r-btns"><button type="button" data-anim="clipAdd">+ Play a clip</button></div>`
      : '<div class="note">This model has no baked animations.</div>'}</div>`;
  return html;
}

/** Change events from the animation sections. Returns true when handled. */
export function animInput(I, inp) {
  const E = I.E, id = E.sel.id, a = inp.dataset.anim; if (!a) return false;
  const cid = inp.closest('[data-cid]')?.dataset.cid, bid = inp.closest('[data-bid]')?.dataset.bid, kid = inp.closest('[data-kid]')?.dataset.kid;
  const o = E.doc.objects.find(x => x.id === id), c = (o.constraints || []).find(x => x.id === cid);
  if (a === 'parent') E.cmd.run('setParent', { id, parent: inp.value || null });
  else if (a === 'conOn') E.cmd.run('setConstraint', { id, cid, patch: { on: inp.checked } });
  else if (a === 'conRef') E.cmd.run('setConstraint', { id, cid, patch: c.type === 'followPath' ? { path: inp.value } : { target: inp.value } });
  else if (a === 'conAxis') E.cmd.run('setConstraint', { id, cid, patch: { axis: inp.value } });
  else if (a === 'behOn') E.cmd.run('setBehaviour', { id, bid, patch: { on: inp.checked } });
  else if (a === 'behProp') E.cmd.run('setBehaviour', { id, bid, patch: { prop: inp.value } });
  else if (a === 'behAdd') { if (inp.value) E.cmd.run('addBehaviour', { id, type: inp.value }); }
  else if (a === 'clipName') E.cmd.run('setClip', { id, kid, patch: { name: inp.value } });
  else if (a === 'clipNum') E.cmd.run('setClip', { id, kid, patch: { [inp.dataset.k]: +inp.value } });
  else if (a === 'clipLoop') E.cmd.run('setClip', { id, kid, patch: { loop: inp.value } });
  else return false;
  return true;
}

/** Button clicks from the animation sections. Returns true when handled. */
export function animButton(I, b) {
  const E = I.E, id = E.sel.id, a = b.dataset.anim; if (!a) return false;
  const d = E.doc, o = d.objects.find(x => x.id === id);
  if (a === 'conAdd') { const type = b.dataset.type, tg = type === 'followPath' ? d.objects.find(x => x.type === 'path') : d.objects.find(x => x.transform && x.id !== id && x.type !== 'path');
    E.cmd.run('addConstraint', { id, constraint: type === 'followPath' ? { type, path: tg.id } : { type, target: tg.id } }); }
  else if (a === 'conDel') E.cmd.run('removeConstraint', { id, cid: b.closest('[data-cid]').dataset.cid });
  else if (a === 'behDel') E.cmd.run('removeBehaviour', { id, bid: b.closest('[data-bid]').dataset.bid });
  else if (a === 'clipAdd') E.cmd.run('addClip', { id, clip: { name: Object.keys(E.shot.geo.clips[o.id])[0], start: +(E.frame / E.fps).toFixed(3) } });
  else if (a === 'clipDel') E.cmd.run('removeClip', { id, kid: b.closest('[data-kid]').dataset.kid });
  else return false;
  return true;
}
