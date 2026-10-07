// Check the time core's camera against Black Page's per-frame camera export (cams_final.json, from BPX.exportCams).
//   node tools/check_camera.mjs
import fs from 'node:fs';
import { evaluate, indexDoc } from '../src/core/evaluate.js';

const doc = JSON.parse(fs.readFileSync(new URL('../scenes/black_page.scene.json', import.meta.url)));
const ref = JSON.parse(fs.readFileSync('G:/Claude/Virtual Legacy/Videos/Calling (Wii)/Thumbnails & Graphics/Black Page Studio/blender/export/cams_final.json'));
const dump = JSON.parse(fs.readFileSync(new URL('../data/engine_dump.json', import.meta.url)));
const geo = { centres: { wii: dump.wiiModel.ctr }, wii: { M: Object.values(dump.wiiModel.M), ctr: dump.wiiModel.ctr, up: dump.wiiModel.up, leds: dump.wiiModel.leds.map(l => l.c0) } };
const ix = indexDoc(doc);
const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
let worst = { eye: [0], target: [0], up: [0], fov: [0], k: [0], squint: [0], chaos: [0], ringLvl: [0], ringPos: [0], glow: [0] };
const bump = (k, v, f) => { if (v > worst[k][0]) worst[k] = [v, f]; };
for (const fr of ref.frames) {
  const s = evaluate(doc, fr.t, geo, ix), c = s.camera, r = fr.cam;
  bump('eye', d3(c.eye, r.eye), fr.f); bump('target', d3(c.target, r.target), fr.f); bump('up', d3(c.up, r.up), fr.f);
  bump('fov', Math.abs(c.fovRender - r.fovRender), fr.f); bump('k', Math.abs(c.k - r.k), fr.f); bump('squint', Math.abs(c.squint - r.squint), fr.f);
  bump('chaos', Math.abs(s.chaos - fr.chaos), fr.f); bump('glow', d3(s.glowCol, fr.glowCol), fr.f);
  if (!!s.ring !== !!fr.ring) { console.log('ring presence differs at', fr.f, !!s.ring, !!fr.ring); continue; }
  if (s.ring) { bump('ringLvl', Math.abs(s.ring.lvl - fr.ring.lvl), fr.f); bump('ringPos', d3(s.ring.pos, fr.ring.pos), fr.f); }
}
console.log('frames', ref.frames.length);
for (const [k, [v, f]] of Object.entries(worst)) console.log(k.padEnd(8), 'max diff', v.toExponential(2), 'at frame', f);
