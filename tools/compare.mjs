// Compare rendered frames against the Black Page engine reference frames (ImageMagick).
//   node tools/compare.mjs <run-dir-name> [frames...]      (NOIMG=1: metrics only; GAIN=n boosts the difference, default 16)
// Writes <spike>/compare/<run>/: side-by-side (reference | spike | difference x4) per frame, plus metrics.json.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SPIKE = 'G:/Claude/Virtual Legacy/Channel/Virtual Shot spike';
const REF = 'G:/Claude/Virtual Legacy/Videos/Calling (Wii)/Thumbnails & Graphics/Black Page Studio/blender/export/final_engine';
const run = process.argv[2] || 'try1';
const src = path.join(SPIKE, run);  // run may be a nested path, e.g. scratch/oldengine_export
let frames = process.argv.slice(3).map(Number);
if (!frames.length) frames = fs.readdirSync(src).filter(f => /^f\d{5}\.png$/.test(f)).map(f => +f.slice(1, 6));

const mg = (...a) => execFileSync('magick', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const id = f => String(f).padStart(5, '0');
const out = path.join(SPIKE, 'compare', process.env.OUTNAME || run); fs.mkdirSync(out, { recursive: true });
const metrics = {}, GAIN = +(process.env.GAIN || 16), OUTNAME = process.env.OUTNAME || run;
for (const f of frames) {
  const a = path.join(REF, `f${id(f)}.png`), b = path.join(src, `f${id(f)}.png`);
  const diff = path.join(out, `diff_${id(f)}.png`);
  // per-pixel absolute difference, boosted so small errors are visible
  if (!process.env.NOIMG) mg(a, b, '-alpha', 'off', '-compose', 'difference', '-composite', '-evaluate', 'multiply', String(GAIN), diff);
  // metrics: mean absolute error (0-255), RMSE, PSNR, share of pixels off by more than 8/255 and 32/255
  const mae = +mg(a, b, '-alpha', 'off', '-compose', 'difference', '-composite', '-format', '%[fx:mean*255]', 'info:');
  const p8 = +mg(a, b, '-alpha', 'off', '-compose', 'difference', '-composite', '-separate', '-evaluate-sequence', 'max', '-threshold', `${(8 / 255 * 100).toFixed(3)}%`, '-format', '%[fx:mean*100]', 'info:');
  const p32 = +mg(a, b, '-alpha', 'off', '-compose', 'difference', '-composite', '-separate', '-evaluate-sequence', 'max', '-threshold', `${(32 / 255 * 100).toFixed(3)}%`, '-format', '%[fx:mean*100]', 'info:');
  // RMSE over RGB, normalised 0-1 (the value in brackets); PSNR from it
  const rm = spawnSync('magick', ['compare', '-alpha', 'off', '-metric', 'RMSE', a, b, 'null:'], { encoding: 'utf8' }).stderr;
  const rmse = +rm.match(/\(([\d.e+-]+)\)/)[1], psnr = rmse > 0 ? 20 * Math.log10(1 / rmse) : 99;
  metrics[f] = { t: +(f / 60).toFixed(3), mae: +mae.toFixed(3), rmse255: +(rmse * 255).toFixed(3), psnr: +psnr.toFixed(2), over8pct: +p8.toFixed(3), over32pct: +p32.toFixed(3) };
  const label = (img, text) => ['(', img, '-resize', '960x540', '-gravity', 'NorthWest', '-fill', '#ECEFEB', '-undercolor', '#000a', '-pointsize', '22', '-annotate', '+10+8', text, ')'];
  if (!process.env.NOIMG) mg(...label(a, `Black Page engine  f${f}  ${(f / 60).toFixed(2)} s`), ...label(b, `Virtual Shot spike (${run})`), ...label(diff, `difference x${GAIN}   PSNR ${psnr.toFixed(1)} dB   ${p8.toFixed(3)}% px > 8/255`),
    '+append', path.join(out, `side_${id(f)}.jpg`));
  console.log(f, JSON.stringify(metrics[f]));
}
fs.writeFileSync(path.join(out, 'metrics.json'), JSON.stringify(metrics, null, 1));
