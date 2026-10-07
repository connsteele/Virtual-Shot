// Named commands on the scene document. Every edit the editor makes goes through here, so undo is one mechanism and
// the editor is scriptable (window.VS.cmd('setKey', {...}) from a console, a test, or Claude).
// Undo is snapshot-based: cheap at this document size (~50 KB) and impossible to get out of step with the commands.
import { fitKeys, fitError } from './fit.js';

const TRACK_DEFAULTS = { 'cam.rig.dist': 3, 'cam.rig.fov': 30 };
const sortKeys = tr => tr.keys.sort((a, b) => a.t - b.t);
const findTrack = (doc, target, prop) => doc.tracks.find(t => t.target === target && t.prop === prop);
const setPath = (o, path, v) => { const ks = path.split('.'); let x = o; for (const k of ks.slice(0, -1)) x = x[k] ??= {}; x[ks[ks.length - 1]] = v; };
const getPath = (o, path) => path.split('.').reduce((x, k) => x?.[k], o);
const SNAP = 1 / 60;

export const COMMANDS = {
  /** Set an object's transform record (position [m], quaternion [x,y,z,w], scale). */
  setTransform(doc, { id, transform }) { const o = doc.objects.find(o => o.id === id); o.transform = JSON.parse(JSON.stringify(transform)); },
  /** Set any plain property of an object (name, size, brightness, ring.t ...). */
  setObjectProp(doc, { id, path, value }) { setPath(doc.objects.find(o => o.id === id), path, value); },
  /** Set or create a key at time t on target.prop (creates the track if needed). After Effects: editing an animated
   *  value at the playhead makes a key there. */
  setKey(doc, { target, prop, t, v, curve }) {
    let tr = findTrack(doc, target, prop);
    if (!tr) { tr = { target, prop, default: TRACK_DEFAULTS[`${target}.${prop}`] ?? 0, keys: [] }; if (/rig\.(dist|fov)$/.test(prop)) tr.interp = 'geometric'; doc.tracks.push(tr); }
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
  /** Write a recorded camera take as keys: samples [{ t (seconds), rig: { x, y, dist, yaw, pitch, roll, fov } }], one per
   *  shot frame, are thinned to Bézier keys (fit.js) within tol per property and replace the keys of each track over
   *  the take's time range. Properties that hardly moved are skipped unless listed in always. markers [{ t, name, data }] (events from the
   *  stream) go to doc.events.markers (in the undo snapshot; evaluate ignores them). Returns nothing; the summary is left in args.summary for the caller. */
  writeCameraTake(doc, args) {
    const { samples: S, target = 'cam', tol = TAKE_TOL, markers = [], always = [] } = args;
    if (!S || S.length < 2) throw new Error('writeCameraTake: needs at least two samples');
    const t0 = S[0].t, t1 = S[S.length - 1].t, summary = {};
    for (const p of Object.keys(S[0].rig)) {
      const ser = S.map(s => ({ t: s.t, v: s.rig[p] })), lo = Math.min(...ser.map(s => s.v)), hi = Math.max(...ser.map(s => s.v)), tl = tol[p] ?? 0.01;
      if (hi - lo < tl && !always.includes(p)) continue;   // untouched by this take (unless the caller wants it written)
      const keys = fitKeys(ser, tl);
      COMMANDS.setKey(doc, { target, prop: 'rig.' + p, t: t0, v: ser[0].v });   // makes the track if needed
      const tr = findTrack(doc, target, 'rig.' + p);
      tr.keys = [...tr.keys.filter(k => k.t < t0 - 1e-6 || k.t > t1 + 1e-6), ...keys].sort((a, b) => a.t - b.t);
      summary[p] = { samples: ser.length, keys: keys.length, err: +fitError(keys, ser).toFixed(5) };
    }
    if (markers.length) doc.events.markers = [...(doc.events.markers || []).filter(m => m.t < t0 || m.t > t1), ...markers.map(m => ({ t: +m.t.toFixed(4), name: m.name, ...(m.data ? { data: m.data } : {}) }))].sort((a, b) => a.t - b.t);
    args.summary = summary;
  },
};
/** Thinning tolerance per rig property (glass widths, degrees): about a pixel at 1080p for the Black Page framing. */
export const TAKE_TOL = { x: 0.002, y: 0.002, dist: 0.004, yaw: 0.05, pitch: 0.05, roll: 0.05, fov: 0.05 };

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
