// Local dev server for the Virtual Shot spike (no dependencies).
//   GET  /...            repo root (src/, node_modules/three, scenes)
//   GET  /bp/...         Black Page Studio folder, read-only (reference engine, fonts, textures, reference frames)
//   GET  /psx/...        PSX Mega Pack GLB folder on E:, read-only, read in place
//   GET  /wii/...        Astra's Wii Remote folder, read-only
//   POST /save/<path>    writes the request body under the spike output folder on G: (retries are the client's job)
//   POST /save-rgba/<path>?w=&h=   raw RGBA8 pixels (top row first), encoded to PNG here
//   POST /save-idat/<path>?w=&h=   an already filtered + zlib-compressed RGBA8 PNG image stream (the page compresses it
//                        with CompressionStream); the server only wraps the PNG chunks around it. Frame export history:
//                        canvas.toBlob ~1 s a frame in a background tab; raw 8 MB uploads ~0.4 s through the browser pane
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOUNTS = {
  '/bp/': 'G:/Claude/Virtual Legacy/Videos/Calling (Wii)/Thumbnails & Graphics/Black Page Studio',
  '/psx/': 'E:/Assets/Asset Packs/PSX Humble Bundle/PSX Mega Pack 3.1.3/Models/GLB (recommended)',
  '/wii/': 'G:/GPT/Projectless/2026-10-04/gen/outputs/Wii_Remote_LowPoly',
  '/bp-final-ref/': 'G:/Claude/Virtual Legacy/Channel/Virtual Shot spike/ref_final',   // the final master, decoded to PNG
};
const OUT = process.env.VS_OUT || 'G:/Claude/Virtual Legacy/Channel/Virtual Shot spike';
const PORT = +(process.argv[2] || process.env.PORT || 8790);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.woff': 'font/woff', '.woff2': 'font/woff2', '.css': 'text/css', '.wasm': 'application/wasm' };

function resolveGet(urlPath) {
  for (const [pre, root] of Object.entries(MOUNTS)) if (urlPath.startsWith(pre)) return safeJoin(root, urlPath.slice(pre.length));
  return safeJoin(REPO, urlPath.slice(1) || 'src/landing.html');
}
function safeJoin(root, rel) {
  const p = path.resolve(root, decodeURIComponent(rel));
  return p.startsWith(path.resolve(root)) ? p : null;
}

const pngChunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
function pngFile(w, h, idat) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}
/** Minimal RGBA8 PNG encoder (Sub filter + zlib on the thread pool, so several frames encode in parallel). */
async function encodePNG(px, w, h) {
  const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1), r = y * stride; raw[o] = 1;
    for (let i = 0; i < stride; i++) raw[o + 1 + i] = (px[r + i] - (i >= 4 ? px[r + i - 4] : 0)) & 255;
  }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', await new Promise((ok, no) => zlib.deflate(raw, { level: 6 }, (e, b) => e ? no(e) : ok(b)))), chunk('IEND', Buffer.alloc(0))]);
}

http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  if (req.method === 'POST' && urlPath.startsWith('/save-scene/')) {   // the editor's Save: a scene file in the repo
    const name = decodeURIComponent(urlPath.slice(12));
    if (!/^[A-Za-z0-9_.-]+\.scene\.json$/.test(name)) { res.writeHead(400); return res.end('bad scene name'); }
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => { try { JSON.parse(Buffer.concat(chunks)); fs.writeFileSync(path.join(REPO, 'scenes', name), Buffer.concat(chunks)); res.writeHead(200); res.end('ok'); }
      catch (e) { res.writeHead(400); res.end(String(e)); } });
    return;
  }
  if (req.method === 'POST' && urlPath.startsWith('/save-idat/')) {
    const rel = decodeURIComponent(urlPath.slice(11)), q = new URL(req.url, 'http://x').searchParams, w = +q.get('w'), h = +q.get('h');
    if (!/^[A-Za-z0-9_.\- /]+$/.test(rel) || rel.split('/').some(s => s === '..' || s.startsWith('.')) || !(w > 0 && h > 0)) { res.writeHead(400); return res.end('bad request'); }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const dest = path.join(OUT, rel); fs.mkdirSync(path.dirname(dest), { recursive: true });
      try { await fs.promises.writeFile(dest, pngFile(w, h, Buffer.concat(chunks))); res.writeHead(200); res.end('ok'); }
      catch (e) { res.writeHead(500); res.end(String(e)); }
    });
    return;
  }
  if (req.method === 'POST' && urlPath.startsWith('/save-rgba/')) {
    const rel = decodeURIComponent(urlPath.slice(11)), q = new URL(req.url, 'http://x').searchParams, w = +q.get('w'), h = +q.get('h');
    if (!/^[A-Za-z0-9_.\- /]+$/.test(rel) || rel.split('/').some(s => s === '..' || s.startsWith('.')) || !(w > 0 && h > 0)) { res.writeHead(400); return res.end('bad request'); }
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const px = Buffer.concat(chunks);
      if (px.length !== w * h * 4) { res.writeHead(400); return res.end('size mismatch'); }
      const dest = path.join(OUT, rel); fs.mkdirSync(path.dirname(dest), { recursive: true });
      try { await fs.promises.writeFile(dest, await encodePNG(px, w, h)); res.writeHead(200); res.end('ok'); }
      catch (e) { res.writeHead(500); res.end(String(e)); }
    });
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'POST' && urlPath.startsWith('/save/')) {
    const rel = decodeURIComponent(urlPath.slice(6));
    if (!/^[A-Za-z0-9_.\- /]+$/.test(rel) || rel.split('/').some(s => s === '..' || s.startsWith('.'))) { res.writeHead(400); return res.end('bad name'); }
    const dest = path.join(OUT, rel);
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.concat(chunks));
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  const file = resolveGet(urlPath);
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`Virtual Shot spike server on http://localhost:${PORT} (saves to ${OUT})`));
