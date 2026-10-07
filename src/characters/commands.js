// Named, undoable commands for characters (registered into core/commands.js, so VS.cmd and undo cover them).
// Clip blocks behave like UE Sequencer animation sections: slide (move start/end together), trim either edge (the left
// edge keeps the content in place by moving `offset`), and crossfade where blocks overlap via blendIn/blendOut.
import { findTrack, COMMANDS } from '../core/commands.js';

const FPS = 60, snap = t => Math.round(t * FPS) / FPS;
const char = (doc, id) => { const c = doc.objects.find(o => o.id === id && o.type === 'character'); if (!c) throw new Error(`no character ${id}`); return c; };
const block = (doc, cid, id) => { const b = char(doc, cid).clips.find(b => b.id === id); if (!b) throw new Error(`no clip ${id} on ${cid}`); return b; };

export const CHAR_COMMANDS = {
  /** Place a character from a loaded asset. */
  addCharacter(doc, { id, name, asset, position = [0, 0, 0], yaw = 0 }) {
    if (doc.objects.some(o => o.id === id)) throw new Error(`id ${id} exists`);
    doc.objects.push({ id, name: name || id, type: 'character', asset, transform: { position, yaw }, clips: [], ik: { feet: false } });
  },
  /** Put a clip on a character's timeline. `length` defaults to one pass of the clip at its speed. */
  addClip(doc, { char: cid, clip, start = 0, length, duration, row = 0, speed = 1, loop = false, root = 'clip', id }) {
    const c = char(doc, cid), len = length ?? (duration ?? 1) / speed;
    id ||= `${clip}_${(c.clips.length + 1)}`.replace(/[^A-Za-z0-9_]/g, '');
    c.clips.push({ id, clip, row, start: snap(start), end: snap(start + len), offset: 0, speed, loop, blendIn: 0, blendOut: 0, root });
    return id;
  },
  /** Slide a block in time (start and end together). */
  moveClip(doc, { char: cid, id, dt }) { const b = block(doc, cid, id), d = Math.max(-b.start, dt); b.start = snap(b.start + d); b.end = snap(b.end + d); },
  /** Trim an edge to time t. Left: the content stays where it is (offset follows); right: shortens or extends. */
  trimClip(doc, { char: cid, id, edge, t }) {
    const b = block(doc, cid, id), min = 1 / FPS;
    if (edge === 'left') { const nt = snap(Math.min(t, b.end - min)); b.offset = (b.offset || 0) + (nt - b.start) * (b.speed ?? 1); b.start = nt; }
    else b.end = snap(Math.max(t, b.start + min));
  },
  /** Any other block setting: clip, speed, loop, blendIn, blendOut, weight, root, rootOffset, row, mute. */
  setClip(doc, { char: cid, id, patch }) { Object.assign(block(doc, cid, id), patch); },
  removeClip(doc, { char: cid, id }) { const c = char(doc, cid); c.clips = c.clips.filter(b => b.id !== id); },
  /** Foot IK settings: { feet: bool, fade (s), floor (m) }. */
  setIK(doc, { char: cid, patch }) { Object.assign(char(doc, cid).ik ??= {}, patch); },
  /** Key straight-line travel (tracks <char>.x and <char>.z, linear) from t0 to t1, replacing keys in between. The
   *  lab's "Match travel to stride" computes `to` from the clip's stride so in-place walks cover ground. */
  keyTravel(doc, { char: cid, t0, t1, from, to }) {
    char(doc, cid);
    for (const [prop, a, b] of [['x', from[0], to[0]], ['z', from[1], to[1]]]) {
      const tr = findTrack(doc, cid, prop); if (tr) tr.keys = tr.keys.filter(k => k.t < t0 - 1e-6 || k.t > t1 + 1e-6);
      COMMANDS.setKey(doc, { target: cid, prop, t: snap(t0), v: +a.toFixed(4), curve: 'linear' });
      COMMANDS.setKey(doc, { target: cid, prop, t: snap(t1), v: +b.toFixed(4), curve: 'linear' });
    }
  },
  /** Pose mode: key a bone's local rotation offset [x,y,z,w] at t (on top of the clips). Identity removes nothing;
   *  use deleteKeys on target=<char>, prop='pose.<bone>' to remove. */
  setBoneKey(doc, { char: cid, bone, t, q, curve = 'smooth' }) {
    char(doc, cid);
    let tr = findTrack(doc, cid, `pose.${bone}`);
    if (!tr) { tr = { target: cid, prop: `pose.${bone}`, default: [0, 0, 0, 1], keys: [] }; doc.tracks.push(tr); }
    const tt = snap(t), k = tr.keys.find(k => Math.abs(k.t - tt) < 0.5 / FPS);
    if (k) k.v = q.slice(); else { tr.keys.push({ t: tt, v: q.slice(), curve }); tr.keys.sort((a, b) => a.t - b.t); }
  },
};
