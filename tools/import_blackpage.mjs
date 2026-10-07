// Import the Black Page opener into a Virtual Shot scene document.
//   node tools/import_blackpage.mjs
// Inputs (read only):
//   G:\...\Black Page Studio\final\opener_final.json  (the final script)
//   data/engine_dump.json                             (what engine v4.8.1 placed in code: tools/dump_engine.js)
// Output: scenes/black_page.scene.json. Every object is placed as data; nothing is computed from model bounds at load.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BP = 'G:/Claude/Virtual Legacy/Videos/Calling (Wii)/Thumbnails & Graphics/Black Page Studio';
const S = JSON.parse(fs.readFileSync(path.join(BP, 'final/opener_final.json'), 'utf8'));
const D = JSON.parse(fs.readFileSync(path.join(REPO, 'data/engine_dump.json'), 'utf8'));
const arr = m => (m && !Array.isArray(m)) ? Object.keys(m).sort((a, b) => a - b).map(k => m[k]) : m;
const r6 = x => Math.round(x * 1e9) / 1e9;

/** Column-major matrix -> {position, quaternion, scale}. */
function decompose(m) {
  m = arr(m);
  const sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
  const R = [m[0] / sx, m[1] / sx, m[2] / sx, m[4] / sy, m[5] / sy, m[6] / sy, m[8] / sz, m[9] / sz, m[10] / sz];
  const [m11, m21, m31, m12, m22, m32, m13, m23, m33] = R; let x, y, z, w; const tr = m11 + m22 + m33;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); w = 0.25 / s; x = (m32 - m23) * s; y = (m13 - m31) * s; z = (m21 - m12) * s; }
  else if (m11 > m22 && m11 > m33) { const s = 2 * Math.sqrt(1 + m11 - m22 - m33); w = (m32 - m23) / s; x = 0.25 * s; y = (m12 + m21) / s; z = (m13 + m31) / s; }
  else if (m22 > m33) { const s = 2 * Math.sqrt(1 + m22 - m11 - m33); w = (m13 - m31) / s; x = (m12 + m21) / s; y = 0.25 * s; z = (m23 + m32) / s; }
  else { const s = 2 * Math.sqrt(1 + m33 - m11 - m22); w = (m21 - m12) / s; x = (m13 + m31) / s; y = (m23 + m32) / s; z = 0.25 * s; }
  const q = [x, y, z, w].map(r6), ident = q[0] === 0 && q[1] === 0 && q[2] === 0;
  const out = { position: [m[12], m[13], m[14]].map(r6) };
  if (!ident) out.quaternion = q;
  if ([sx, sy, sz].some(s => Math.abs(s - 1) > 1e-7)) out.scale = [sx, sy, sz].map(r6);
  return out;
}
const placement = name => decompose(D.parts.find(p => p.name === name).placement);

// --- objects -------------------------------------------------------------------------------------------------------
const scr = D.scr;
const glassMatrix = [...scr.r, 0, ...scr.u, 0, ...scr.n, 0, ...scr.ctr, 1];
const wiiM = arr(D.wiiModel.M);
const W = S.wiiModel, R = W.ring;

const objects = [
  { id: 'monitor', name: 'CRT monitor', type: 'model', asset: 'monitor', transform: { position: [0, 0, 0] }, material: 'screenLit',
    screen: { primitive: { materialName: 'screen', maxVertices: 8 }, material: 'crt', source: 'chat' } },
  { id: 'desk', name: 'Desk', type: 'model', asset: 'desk', transform: placement('tv_table_4'), material: 'screenLit' },
  { id: 'keyboard', name: 'Keyboard', type: 'model', asset: 'keyboard', transform: placement('pc_keyboard_mp_2'), material: 'screenLit' },
  { id: 'pad', name: 'Mouse pad', type: 'model', asset: 'pad', transform: placement('mouse_pad_mp_1'), material: 'screenLit' },
  { id: 'wii', name: 'Wii Remote', type: 'model', asset: 'wii', transform: decompose(wiiM), material: 'screenLit',
    emission: W.emission, ledParts: 'player.?\\d.?led',
    ring: { t: R.t, color: R.color, pattern: R.pattern, intensity: R.intensity, ember: R.ember, light: R.light, radius: R.radius,
      glow: R.glow, rumble: R.rumble, rumbleRot: R.rumbleRot } },
  { id: 'glass', name: 'CRT glass frame', type: 'empty', transform: decompose(glassMatrix), size: [r6(scr.glassW), r6(scr.glassH)],
    note: 'Origin at the glass centre; +X right, +Y up, +Z out of the screen. The camera rig, polaroid and lights are relative to it.' },
  { id: 'led', name: 'Power LED', type: 'led', position: D.led.pos.map(r6), normal: D.led.n.map(r6), color: S.led.color,
    intensity: S.led.intensity, size: S.led.size, texelRect: D.LED_RECT, appliesTo: ['monitor', 'desk', 'keyboard', 'pad', 'polaroid', 'tape'] },
  { id: 'polaroid', name: 'Polaroid', type: 'card', texture: 'polaroid', transform: decompose(D.polaroid.polaroid), brightness: S.polaroid.brightness },
  { id: 'tape', name: 'Tape', type: 'card', texture: 'tape', transform: decompose(D.polaroid.tape), brightness: S.polaroid.brightness },
  { id: 'cam', name: 'Shot camera', type: 'camera',
    rig: { type: 'glassHeadOn', frame: 'glass', neck: 0.08, units: { dist: 'glass widths', x: 'glass widths', y: 'glass widths', fov: 'vertical degrees', yaw: 'degrees', pitch: 'degrees' } },
    clip: { near: r6(scr.glassW * .02), far: r6(scr.glassW * 60) } },
];

// --- tracks --------------------------------------------------------------------------------------------------------
const tracks = [];
const ch = S.camera.channels;
const camDefaults = { dist: 3, fov: 30, x: 0, y: 0, distort: 0, yaw: 0, pitch: 0, squint: 0 };
for (const n of Object.keys(camDefaults)) {
  if (!ch[n]) continue;
  tracks.push({ target: 'cam', prop: `rig.${n}`, default: camDefaults[n], ...(n === 'dist' || n === 'fov' ? { interp: 'geometric' } : {}),
    keys: ch[n].map(k => ({ ...k })) });
}
tracks.push({ target: 'scene', prop: 'params.chaos', default: 0, keys: S.chaos.map(([t, v]) => ({ t, v, curve: 'linear' })) });
tracks.push({ target: 'cam', prop: 'focus', type: 'focus', settings: { max: S.focus.max, edgeStart: S.focus.edgeStart },
  keys: S.focus.keys.map(({ t, curve, ...v }) => ({ t, v: { ...v, target: v.target === 'wii' ? 'wii' : v.target }, ...(curve ? { curve } : {}) })) });

// --- the scene document ----------------------------------------------------------------------------------------------
const doc = {
  format: 'virtual-shot/scene', version: 0,
  name: 'Black Page cold open (parity rebuild)',
  source: 'Imported from Black Page Studio final/opener_final.json + engine v4.8.1 placements (tools/import_blackpage.mjs)',
  units: 'metres, Y up (glTF); times in seconds',
  fps: S.fps, duration: S.duration, cut: S.cut,
  output: { width: 1920, height: 1080 },
  assets: {
    monitor: 'psx:Electronics & Misc/pc_monitor_mp_1.glb',
    desk: 'psx:Furniture/tv_table_4.glb',
    keyboard: 'psx:Electronics & Misc/pc_keyboard_mp_2.glb',
    pad: 'psx:Electronics & Misc/mouse_pad_mp_1.glb',
    wii: 'wii:Wii_Remote_LowPoly.glb',
    font: 'bp:source/assets/fonts/ipagp-sub.woff',
    polaroid: 'bp:source/assets/textures/polaroid.png',
    tape: 'bp:source/assets/textures/tape.png',
    ghost_woman: 'bp:source/assets/textures/ghosts/woman.png',
    ghost_girl: 'bp:source/assets/textures/ghosts/girl.png',
    ghost_peek: 'bp:source/assets/textures/ghosts/peek.png',
    ghost_child: 'bp:source/assets/textures/ghosts/child.png',
  },
  params: { chaos: 0 },
  objects,
  tracks,
  // Things that happen at a time with parameters, rather than keyed values.
  events: {
    ghosts: S.ghosts.map(g => ({ ...g, img: 'ghost_' + g.img })),
  },
  // 2D layers: procedural canvases that are a function of t. The chat feeds the CRT screen as a texture and is also
  // drawn full-frame before (and during) the reveal.
  layers: [
    { id: 'chat', type: 'chat2d', font: 'font', fontFamily: 'BP Gothic',
      script: { messages: S.messages, counter: S.counter, reveal: S.reveal, window: S.window, floatUntil: S.floatUntil, mode: 'auto' },
      chaos: 'scene.params.chaos' },
  ],
  // Shot-level sequencing: the flat chat dissolves into the 3D shot.
  sequence: { reveal: { start: S.reveal.start, duration: S.reveal.duration, dissolve: S.reveal.dissolve },
    composite: [ { layer: 'flat', from: 'chat', until: 'reveal.start + reveal.dissolve' }, { layer: '3d', from: 'reveal.start' } ] },
  look: {
    lighting: { ambient: S.lighting.ambient, screen: S.lighting.screen, bounce: S.lighting.bounce, bounceDist: S.lighting.bounceDist ?? 0.75,
      glow: { base: [0.95, 0.46, 0.42], chaosGain: [0.55, 0.5], floor: [0.05, 0.07, 0.08] } },
    screen: { curvature: 0.08, overscan: 1.05, crop: [120, 1800], scanFreq: 900 },
    lens: { distortScale: 0.3, fringe: 0.03 },
  },
};

const out = path.join(REPO, 'scenes/black_page.scene.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(doc, null, 1));
console.log('wrote', out, (fs.statSync(out).size / 1024).toFixed(1), 'KB;', objects.length, 'objects,', tracks.length, 'tracks');
