// Per-frame difference metrics for a whole run against the Black Page reference frames (fast: decodes PNGs in Node).
//   node tools/metrics_all.mjs <run-dir-name> [f0] [f1]
// Writes <spike>/compare/<run>/metrics_all.json and .csv, and prints a summary.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SPIKE = 'G:/Claude/Virtual Legacy/Channel/Virtual Shot spike';
const REF = process.env.REF || 'G:/Claude/Virtual Legacy/Videos/Calling (Wii)/Thumbnails & Graphics/Black Page Studio/blender/export/final_engine';
const run = process.argv[2] || 'full_v1', f0 = +(process.argv[3] ?? 0), f1 = +(process.argv[4] ?? 1175);

/** Decode an 8-bit RGB/RGBA PNG to {w, h, ch, px}. */
function readPNG(file) {
  const b = fs.readFileSync(file); let o = 8, w, h, ct, idat = [];
  while (o < b.length) { const len = b.readUInt32BE(o), type = b.toString('ascii', o + 4, o + 8), d = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); if (d[8] !== 8 || d[12] !== 0) throw new Error('unsupported PNG ' + file); ct = d[9]; }
    else if (type === 'IDAT') idat.push(d); else if (type === 'IEND') break; o += 12 + len; }
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : (() => { throw new Error('colour type ' + ct); })(), stride = w * ch, raw = zlib.inflateSync(Buffer.concat(idat)), px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) { const ft = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let i = 0; i < stride; i++) { const x = raw[src + i], a = i >= ch ? px[dst + i - ch] : 0, up = y ? px[dst - stride + i] : 0, c = (y && i >= ch) ? px[dst - stride + i - ch] : 0;
      let v; if (ft === 0) v = x; else if (ft === 1) v = x + a; else if (ft === 2) v = x + up; else if (ft === 3) v = x + ((a + up) >> 1);
      else { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c); }
      px[dst + i] = v & 255; } }
  return { w, h, ch, px };
}

const rows = [], id = f => String(f).padStart(5, '0');
for (let f = f0; f <= f1; f++) {
  const A = readPNG(path.join(REF, `f${id(f)}.png`)), B = readPNG(path.join(SPIKE, run, `f${id(f)}.png`));
  let sum = 0, sq = 0, over8 = 0, over32 = 0, max = 0; const n = A.w * A.h;
  for (let p = 0; p < n; p++) { let pm = 0;
    for (let c = 0; c < 3; c++) { const d = Math.abs(A.px[p * A.ch + c] - B.px[p * B.ch + c]); sum += d; sq += d * d; if (d > pm) pm = d; }
    if (pm > 8) over8++; if (pm > 32) over32++; if (pm > max) max = pm; }
  const rmse = Math.sqrt(sq / (n * 3)) / 255;
  rows.push({ f, t: +(f / 60).toFixed(3), mae: +(sum / (n * 3)).toFixed(4), psnr: rmse > 0 ? +(20 * Math.log10(1 / rmse)).toFixed(2) : 99, over8pct: +(over8 / n * 100).toFixed(4), over32pct: +(over32 / n * 100).toFixed(4), max });
  if (f % 100 === 0) process.stdout.write(`${f} `);
}
const out = path.join(SPIKE, 'compare', run); fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'metrics_all.json'), JSON.stringify(rows));
fs.writeFileSync(path.join(out, 'metrics_all.csv'), 'frame,t,mae,psnr,over8pct,over32pct,max\n' + rows.map(r => [r.f, r.t, r.mae, r.psnr, r.over8pct, r.over32pct, r.max].join(',')).join('\n'));
const seg = (a, b) => rows.filter(r => r.f >= a && r.f <= b);
const sum = (name, R) => { const ps = R.map(r => r.psnr).sort((x, y) => x - y), w = R.reduce((m, r) => r.psnr < m.psnr ? r : m, R[0]);
  console.log(`\n${name}: ${R.length} frames · identical ${R.filter(r => r.max === 0).length} · PSNR min ${ps[0]} (f${w.f}) median ${ps[ps.length >> 1]} · worst share >8/255 ${Math.max(...R.map(r => r.over8pct))}% · worst share >32/255 ${Math.max(...R.map(r => r.over32pct))}% · max pixel diff ${Math.max(...R.map(r => r.max))}`); };
sum('all', rows); sum('flat (0-263)', seg(0, 263)); sum('3D (264-1175)', seg(264, 1175));
