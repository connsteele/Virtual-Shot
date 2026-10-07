// End-to-end alignment check with a real sender: Blender (background, scratch scene) streams an animated camera through
// the bridge while the editor records it as keys; then every recorded frame's marker positions, projected by
// Virtual Shot's evaluate() from the written keys, are compared with Blender's own projection of the same points.
//   node tools/blender_align.mjs        (needs the dev server on VS_BASE and server/bridge.mjs on 8799; no sim running)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
const OUT = 'G:/Claude/Virtual Legacy/Channel/Virtual Shot spike/engine_bridge/blender', BLENDER = 'C:/Program Files/Blender Foundation/Blender 5.1/blender.exe';
const markers = JSON.parse(fs.readFileSync(OUT + '/markers.json', 'utf8')), FROM = 300, TOL = +(process.argv[2] || 1);
const js = `(async () => { const m = await import('/tools/live_test.js'); const r = await m.blenderTake({ markers: ${JSON.stringify(markers)}, from: ${FROM}, tolScale: ${TOL} });
  r.stills = await m.stills([${FROM}, ${FROM + 89}, ${FROM + 179}], 'engine_bridge/blender'); return r; })()`;
const page = spawn('node', ['tools/headless.mjs', '/src/editor/index.html?f=300&bg', js], { env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
let out = ''; page.stdout.on('data', d => { out += d; }); page.stderr.on('data', d => process.stderr.write(d));
await new Promise(r => setTimeout(r, 20000));   // the page loads and compiles its shaders first
execFileSync(BLENDER, ['-b', '--factory-startup', '--python', 'tools/blender_bridge.py', '--', '--demo', '--markers', OUT + '/markers.json', '--out', OUT, '--frames', '1-180', '--render', '1,90,180'], { stdio: 'inherit' });
await new Promise(r => page.on('close', r));
const res = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)), truth = JSON.parse(fs.readFileSync(OUT + '/blender_truth.json', 'utf8'));
const errs = [], perFrame = [], rawErrs = [];
const bf0 = res.take ? Math.min(...Object.keys(truth.frames).map(Number)) : 0;
for (const [f, P] of Object.entries(res.proj)) {
  const T = truth.frames[bf0 + (+f - res.take.from)]; if (!T) continue; let w = 0;
  for (const k of Object.keys(P)) { if (T.px[k][2] <= 0) continue; const e = Math.hypot(P[k][0] - T.px[k][0], P[k][1] - T.px[k][1]); errs.push(e); w = Math.max(w, e);
    const R = res.raw[f][k]; rawErrs.push(Math.hypot(R[0] - T.px[k][0], R[1] - T.px[k][1])); }
  perFrame.push([+f, +w.toFixed(3)]);
}
errs.sort((a, b) => a - b); rawErrs.sort((a, b) => a - b);
const summary = { tolScale: TOL, take: res.take, frames: perFrame.length, unthinnedPx: { p50: rawErrs[rawErrs.length >> 1], max: rawErrs.at(-1) }, px: { p50: errs[errs.length >> 1], p95: errs[Math.floor(errs.length * 0.95)], max: errs.at(-1) }, worstFrames: [...perFrame].sort((a, b) => b[1] - a[1]).slice(0, 5), stills: res.stills };
fs.writeFileSync(OUT + `/align_report_tol${TOL}.json`, JSON.stringify({ ...summary, perFrame }, null, 1));
console.log(JSON.stringify(summary, null, 1));
