// Named commands on the scene document. Every edit the editor makes goes through here, so undo is one mechanism and
// the editor is scriptable (window.VS.cmd('setKey', {...}) from a console, a test, or Claude).
// Undo is snapshot-based: cheap at this document size (~50 KB) and impossible to get out of step with the commands.

import { PROPS, staticValue, setStaticValue } from './animate.js';
import { BEHAVIOURS, behaviourDefaults } from './behaviours.js';
import { M4, trsOf, decompose, invAffine, eulerFromQuat } from './vec.js';

const TRACK_DEFAULTS = { 'cam.rig.dist': 3, 'cam.rig.fov': 30 };
const sortKeys = tr => tr.keys.sort((a, b) => a.t - b.t);
const findTrack = (doc, target, prop) => doc.tracks.find(t => t.target === target && t.prop === prop);
const setPath = (o, path, v) => { const ks = path.split('.'); let x = o; for (const k of ks.slice(0, -1)) x = x[k] ??= {}; x[ks[ks.length - 1]] = v; };
const getPath = (o, path) => path.split('.').reduce((x, k) => x?.[k], o);
const SNAP = 1 / 60;
const objOf = (doc, id) => { const o = doc.objects.find(o => o.id === id); if (!o) throw new Error(`no object ${id}`); return o; };
const isObjProp = (doc, target, prop) => { const o = doc.objects.find(o => o.id === target); return !!o && o.type !== 'camera' && !/^(rig\.|focus$)/.test(prop); };
const typeOf = prop => PROPS[prop]?.type;
const nextId = (list, pre) => { let i = 1; while (list.some(x => x.id === pre + i)) i++; return pre + i; };
/** Drop the tracks of a constraint, behaviour or clip that was removed. */
const dropTracks = (doc, id, kind, sid) => { doc.tracks = doc.tracks.filter(tr => !(tr.target === id && tr.prop.startsWith(`${kind}.${sid}.`))); };
/** Static world matrix of an object (its parent chain, no animation). */
const staticWorld = (doc, o) => o.parent ? M4.mul(staticWorld(doc, objOf(doc, o.parent)), trsOf(o.transform || {})) : trsOf(o.transform || {});
const roundTf = d => ({ position: d.position.map(v => +v.toFixed(7)), quaternion: d.quaternion.map(v => +v.toFixed(9)), ...(d.scale.some(v => Math.abs(v - 1) > 1e-7) ? { scale: d.scale.map(v => +v.toFixed(7)) } : {}) });

export const COMMANDS = {
  /** Set an object's transform record (position [m], quaternion [x,y,z,w], scale). */
  setTransform(doc, { id, transform }) { const o = doc.objects.find(o => o.id === id); o.transform = JSON.parse(JSON.stringify(transform)); },
  /** Set any plain property of an object (name, size, brightness, ring.t ...). */
  setObjectProp(doc, { id, path, value }) { setPath(doc.objects.find(o => o.id === id), path, value); },
  /** Set or create a key at time t on target.prop (creates the track if needed). After Effects: editing an animated
   *  value at the playhead makes a key there. */
  setKey(doc, { target, prop, t, v, curve }) {
    let tr = findTrack(doc, target, prop);
    if (!tr) { tr = { target, prop, default: TRACK_DEFAULTS[`${target}.${prop}`] ?? 0, keys: [] }; if (/rig\.(dist|fov)$/.test(prop)) tr.interp = 'geometric';
      if (typeOf(prop)) tr.type = typeOf(prop); if (isObjProp(doc, target, prop)) tr.default = staticValue(objOf(doc, target), prop); doc.tracks.push(tr); }
    if (tr.type === 'bool') { v = !!v; curve = 'hold'; }
    const k = tr.keys.find(k => Math.abs(k.t - t) < SNAP / 2);
    if (k) { k.v = v; if (curve) k.curve = curve; } else { tr.keys.push({ t, v, curve: curve || (tr.keys.length ? 'smooth' : 'linear') }); sortKeys(tr); }
  },
  /** Remove keys: [{target, prop, t}]. A track left with no keys keeps its default and stops being animated. */
  deleteKeys(doc, { keys }) {
    for (const { target, prop, t } of keys) { const tr = findTrack(doc, target, prop); if (!tr) continue;
      const k = tr.keys.find(k => Math.abs(k.t - t) < SNAP / 2); if (!k) continue;
      if (tr.keys.length === 1) tr.default = k.v;
      tr.keys = tr.keys.filter(x => x !== k); }
  },
  /** Move keys in time by dt seconds (snapped to frames). */
  moveKeys(doc, { keys, dt }) {
    const moved = new Set();
    for (const { target, prop, t } of keys) { const tr = findTrack(doc, target, prop); const k = tr && tr.keys.find(k => Math.abs(k.t - t) < SNAP / 2 && !moved.has(k));
      if (k) { k.t = Math.max(0, Math.round((k.t + dt) * 60) / 60); moved.add(k); } }
    for (const tr of doc.tracks) sortKeys(tr);
  },
  /** Set the curve into a key (bezier, linear, hold, or a preset). */
  setKeyCurve(doc, { target, prop, t, curve }) { const k = findTrack(doc, target, prop)?.keys.find(k => Math.abs(k.t - t) < SNAP / 2); if (k) k.curve = curve; },
  /** Toggle animation of a property (After Effects stopwatch): on = one key at t holding the current value; off = drop
   *  its keys and keep the value at t as the static value. */
  setAnimated(doc, { target, prop, t, v, on }) {
    const tr = findTrack(doc, target, prop);
    // object properties keep their static value on the object (transform record, ring.intensity ...), not in a track
    if (!on && isObjProp(doc, target, prop)) { setStaticValue(objOf(doc, target), prop, v); doc.tracks = doc.tracks.filter(x => x !== tr); return; }
    if (!on && tr) { tr.keys = []; tr.default = v; }
    if (on) COMMANDS.setKey(doc, { target, prop, t, v, curve: 'linear' });
  },
  /** Set the value of a property that isn't animated (stored as its track's default). */
  setStatic(doc, { target, prop, v }) {
    const tr = findTrack(doc, target, prop);
    if (tr && tr.keys.length) throw new Error(`${target}.${prop} is animated: set a key instead`);
    if (tr) tr.default = v; else doc.tracks.push({ target, prop, default: v, keys: [] });
  },
  /** Set a look parameter (look.lighting.screen, look.haze.screenLight ...). */
  setLook(doc, { path, value }) { setPath(doc.look, path, value); },
  /** Edit an event: a chat message (in the chat layer's script), a ghost flash or a pop. */
  setEvent(doc, { kind, index, patch }) {
    const list = kind === 'messages' ? doc.layers.find(l => l.type === 'chat2d').script.messages : doc.events[kind];
    Object.assign(list[index], patch);
  },
  /** Add an empty (a named frame other things can be placed against). */
  addEmpty(doc, { id, name, transform }) { doc.objects.push({ id, name: name || id, type: 'empty', transform: transform || { position: [0, 0, 0] } }); },
  rename(doc, { id, name }) { doc.objects.find(o => o.id === id).name = name; },

  // ---- object animation (src/core/animate.js)
  /** Set an object property at time t: a key there if the property is animated, else its static value. */
  setObjectValue(doc, { id, prop, t = 0, v }) {
    const tr = findTrack(doc, id, prop);
    if (tr && tr.keys.length) COMMANDS.setKey(doc, { target: id, prop, t, v }); else setStaticValue(objOf(doc, id), prop, v);
  },
  /** Set a whole local transform at time t (the gizmo): keyed components get keys at t, the rest are written statically. */
  setTransformAt(doc, { id, transform, t = 0 }) {
    const o = objOf(doc, id), e = eulerFromQuat(transform.quaternion || [0, 0, 0, 1]);
    const vals = { position: transform.position || [0, 0, 0], rotation: e, scale: transform.scale || [1, 1, 1] };
    o.transform = JSON.parse(JSON.stringify(transform));
    for (const g of ['position', 'rotation', 'scale']) ['x', 'y', 'z'].forEach((a, i) => { const tr = findTrack(doc, id, `${g}.${a}`);
      if (tr && tr.keys.length) COMMANDS.setKey(doc, { target: id, prop: `${g}.${a}`, t, v: vals[g][i] }); });
  },
  /** Parent an object to another (null: unparent). keepWorld (default) rewrites its transform so it doesn't jump. */
  setParent(doc, { id, parent = null, keepWorld = true }) {
    const o = objOf(doc, id);
    if (parent) { objOf(doc, parent); let p = parent; while (p) { if (p === id) throw new Error('that would parent an object to itself'); p = objOf(doc, p).parent; } }
    const W = staticWorld(doc, o);
    if (parent) o.parent = parent; else delete o.parent;
    if (keepWorld && o.transform) o.transform = roundTf(decompose(parent ? M4.mul(invAffine(staticWorld(doc, objOf(doc, parent))), W) : W));
  },
  /** Add a constraint: { type: 'attach'|'lookAt'|'followPath', target | path, ... }. Its id comes back in args.cid. */
  addConstraint(doc, args) {
    const o = objOf(doc, args.id), c = { ...args.constraint };
    if (!['attach', 'lookAt', 'followPath'].includes(c.type)) throw new Error(`unknown constraint ${c.type}`);
    const ref = c.target || c.path; if (ref) objOf(doc, ref);
    o.constraints ||= []; c.id ||= nextId(o.constraints, 'c'); o.constraints.push(c); args.cid = c.id;
  },
  setConstraint(doc, { id, cid, patch }) { const c = (objOf(doc, id).constraints || []).find(c => c.id === cid); if (!c) throw new Error(`no constraint ${cid}`); Object.assign(c, patch); },
  removeConstraint(doc, { id, cid }) { const o = objOf(doc, id); o.constraints = (o.constraints || []).filter(c => c.id !== cid); if (!o.constraints.length) delete o.constraints; dropTracks(doc, id, 'constraints', cid); },
  /** Add a procedural behaviour (shake, bob, spin, flicker, noise) with default parameters. Its id comes back in args.bid. */
  addBehaviour(doc, args) {
    const o = objOf(doc, args.id); if (!BEHAVIOURS[args.type]) throw new Error(`unknown behaviour ${args.type}`);
    o.behaviours ||= []; const b = { id: args.bid || nextId(o.behaviours, args.type), type: args.type, params: { ...behaviourDefaults(args.type), ...(args.params || {}) } };
    if (args.prop) b.prop = args.prop; o.behaviours.push(b); args.bid = b.id;
  },
  setBehaviour(doc, { id, bid, patch }) {
    const b = (objOf(doc, id).behaviours || []).find(b => b.id === bid); if (!b) throw new Error(`no behaviour ${bid}`);
    const { params, ...rest } = patch; Object.assign(b, rest); if (params) Object.assign(b.params ||= {}, params);
  },
  removeBehaviour(doc, { id, bid }) { const o = objOf(doc, id); o.behaviours = (o.behaviours || []).filter(b => b.id !== bid); if (!o.behaviours.length) delete o.behaviours; dropTracks(doc, id, 'behaviours', bid); },
  /** Play a baked glTF animation on a model: { name, start, speed, loop, fadeIn, offset, end }. Its id comes back in args.kid. */
  addClip(doc, args) { const o = objOf(doc, args.id); o.clips ||= []; const c = { id: args.clip.id || nextId(o.clips, 'k'), start: 0, ...args.clip }; o.clips.push(c); args.kid = c.id; },
  setClip(doc, { id, kid, patch }) { const c = (objOf(doc, id).clips || []).find(c => c.id === kid); if (!c) throw new Error(`no clip ${kid}`); Object.assign(c, patch); },
  removeClip(doc, { id, kid }) { const o = objOf(doc, id); o.clips = (o.clips || []).filter(c => c.id !== kid); if (!o.clips.length) delete o.clips; dropTracks(doc, id, 'clips', kid); },
  /** Add a path (a Catmull-Rom rail through points, in its own space) for followPath constraints. */
  addPath(doc, { id, name, points, closed = false, transform }) {
    if (doc.objects.some(o => o.id === id)) throw new Error(`${id} exists`);
    doc.objects.push({ id, name: name || id, type: 'path', transform: transform || { position: [0, 0, 0] }, points, ...(closed ? { closed } : {}) });
  },
};

/** The command runner with undo/redo. onChange(name, args) is called after every change (including undo/redo). */
export function createCommandStack(getDoc, onChange) {
  const undo = [], redo = [];
  const snap = () => { const d = getDoc(); return JSON.stringify({ objects: d.objects, tracks: d.tracks, events: d.events, look: d.look, layers: d.layers }); };
  const restore = s => Object.assign(getDoc(), JSON.parse(s));
  const api = {
    run(name, args = {}) {
      const fn = COMMANDS[name]; if (!fn) throw new Error(`unknown command ${name}`);
      const before = snap(); fn(getDoc(), args); undo.push({ name, before }); if (undo.length > 200) undo.shift(); redo.length = 0;
      onChange(name, args); return api;
    },
    /** For continuous edits (dragging a key or a gizmo): take a snapshot first, mutate live, then commit once. */
    begin() { return snap(); },
    commit(name, before) { if (before === snap()) { onChange('noop', {}); return; } undo.push({ name, before }); redo.length = 0; onChange(name, {}); },
    undo() { const e = undo.pop(); if (!e) return; redo.push({ name: e.name, before: snap() }); restore(e.before); onChange('undo', { of: e.name }); },
    redo() { const e = redo.pop(); if (!e) return; undo.push({ name: e.name, before: snap() }); restore(e.before); onChange('redo', { of: e.name }); },
    get history() { return undo.map(e => e.name); },
    list: () => Object.keys(COMMANDS),
  };
  return api;
}
export { getPath, findTrack };
