// Bake the haze level analysis into the scene: our per-frame haze levels (VS.measureHaze, exposure 1) are calibrated
// against Cycles' levels.txt with one global exposure, then stored for the time core's haze gain (evaluate.hazeGain).
//   node tools/bake_haze_levels.mjs   ->  data/haze_levels.json, then node tools/import_blackpage.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = JSON.parse(fs.readFileSync('G:/Claude/Virtual Legacy/Channel/Virtual Shot spike/data/haze_levels_raw.json'));
// MEASURED_EXPOSURE: for levels measured before hazeLevel() normalised to exposure 1
if (process.env.MEASURED_EXPOSURE) for (const k in raw) raw[k] /= +process.env.MEASURED_EXPOSURE;
const cyc = Object.fromEntries(fs.readFileSync('G:/Claude/Virtual Legacy/Videos/Calling (Wii)/Thumbnails & Graphics/Black Page Studio/blender/export/atmos_final/levels.txt', 'utf8')
  .trim().split('\n').map(l => l.split(/\s+/).map(Number)));
const frames = Object.keys(raw).map(Number).sort((a, b) => a - b);
const ratios = frames.filter(f => cyc[f] && raw[f] > 0).map(f => cyc[f] / raw[f]).sort((a, b) => a - b);
const exposure = ratios[ratios.length >> 1];
// how well the shape over time matches, after calibration: correlation of log levels, and the ratio's spread
const xs = frames.filter(f => cyc[f] && raw[f] > 0), lx = xs.map(f => Math.log(raw[f] * exposure)), ly = xs.map(f => Math.log(cyc[f]));
const mean = a => a.reduce((s, v) => s + v, 0) / a.length, mx = mean(lx), my = mean(ly);
const r = xs.reduce((s, _, i) => s + (lx[i] - mx) * (ly[i] - my), 0) / Math.sqrt(lx.reduce((s, v) => s + (v - mx) ** 2, 0) * ly.reduce((s, v) => s + (v - my) ** 2, 0));
const q = p => ratios[Math.floor(p * (ratios.length - 1))] / exposure;
const from = frames[0], values = [];
for (let f = from; f <= frames[frames.length - 1]; f++) values.push(raw[f] ?? null);
fs.writeFileSync(path.join(REPO, 'data/haze_levels.json'), JSON.stringify({ exposure, from, values, note: 'mean luminance of the lens-warped haze at exposure 1, per frame (VS.measureHaze); exposure calibrates to Cycles levels.txt' }));
console.log(`exposure ${exposure.toPrecision(4)} (Cycles/ours median); per-frame ratio 10-90%: ${q(0.1).toFixed(2)}-${q(0.9).toFixed(2)} of the median; log-level correlation r=${r.toFixed(3)} over ${xs.length} frames`);
for (const f of [264, 300, 450, 624, 720, 900, 1104, 1175]) console.log(f, 'cycles', cyc[f]?.toFixed(5), 'ours', (raw[f] * exposure).toFixed(5));
