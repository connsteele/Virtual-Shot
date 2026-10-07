// The reverse direction: the editor publishes its shot camera (Live ▾ > Send the shot camera out) while Blender
// (background, scratch scene) receives it in Blender conventions, keys a camera and saves the scratch scene.
// Compares Blender's received pose (converted back) with the camera evaluate() gave for each frame.
//   node tools/reverse_test.mjs     (needs the dev server on VS_BASE and server/bridge.mjs on 8799)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { toCanonical, camForward, camUp } from '../src/bridge/protocol.js';
const OUT = 'G:/Claude/Virtual Legacy/Channel/Virtual Shot spike/engine_bridge/blender_reverse', BLENDER = 'C:/Program Files/Blender Foundation/Blender 5.1/blender.exe';
fs.mkdirSync(OUT, { recursive: true });
const js = `(async () => { const E = VS.E, L = VS.live; await L.connect(); L.setPublish(true);
  for (let i = 0; i < 600 && !L.sources['blender-receiver']; i++) await new Promise(r => setTimeout(r, 100));   // wait for Blender to join
  const cams = {}; for (let f = 300; f < 420; f++) { E.frame = f; E.renderNow('play'); const c = E.st.camera; cams[f] = { eye: c.eye, target: c.target, up: c.up, fov: c.fov };
    await E.shot.renderer.backend.device.queue.onSubmittedWorkDone(); await new Promise(r => setTimeout(r, 12)); }
  return cams; })()`;
const page = spawn('node', ['tools/headless.mjs', '/src/editor/index.html?f=300&bg', js], { env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
let out = ''; page.stdout.on('data', d => { out += d; });
await new Promise(r => setTimeout(r, 20000));
execFileSync(BLENDER, ['-b', '--factory-startup', '--python', 'tools/blender_bridge.py', '--', '--receive', '--secs', '14', '--out', OUT, '--save'], { stdio: 'ignore' });
await new Promise(r => page.on('close', r));
const cams = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)), got = JSON.parse(fs.readFileSync(OUT + '/blender_received.json', 'utf8'));
let n = 0, pe = 0, ae = 0, fe = 0; const lat = [];
for (const m of got) { const c = cams[m.f]; if (!c) continue; n++; const k = toCanonical(m, 'blender'), f = camForward(k.q), u = camUp(k.q);
  const f0 = c.target.map((v, i) => v - c.eye[i]), l = Math.hypot(...f0);
  pe = Math.max(pe, Math.hypot(...k.p.map((v, i) => v - c.eye[i]))); ae = Math.max(ae, Math.acos(Math.min(1, f.reduce((s, v, i) => s + v * f0[i] / l, 0))) * 180 / Math.PI,
    Math.acos(Math.min(1, u.reduce((s, v, i) => s + v * c.up[i], 0))) * 180 / Math.PI); fe = Math.max(fe, Math.abs(k.fov - c.fov)); lat.push(m.rx - m.ts); }
lat.sort((a, b) => a - b);
const rep = { received: got.length, matched: n, maxPosErr_m: pe, maxAngleErr_deg: ae, maxFovErr_deg: fe, latency_ms: { p50: lat[lat.length >> 1], max: lat.at(-1) }, blend: OUT + '/received_take.blend' };
fs.writeFileSync(OUT + '/reverse_report.json', JSON.stringify(rep, null, 1)); console.log(JSON.stringify(rep, null, 1));
