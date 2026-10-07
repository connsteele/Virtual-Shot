// Local dev server for the Virtual Shot spike (no dependencies).
//   GET  /...            repo root (src/, node_modules/three, scenes)
//   GET  /bp/...         Black Page Studio folder, read-only (reference engine, fonts, textures, reference frames)
//   GET  /psx/...        PSX Mega Pack GLB folder on E:, read-only, read in place
//   GET  /wii/...        Astra's Wii Remote folder, read-only
//   POST /save/<path>    writes the request body under the spike output folder on G: (retries are the client's job)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOUNTS = {
  '/bp/': 'G:/Claude/Virtual Legacy/Videos/Calling (Wii)/Thumbnails & Graphics/Black Page Studio',
  '/psx/': 'E:/Assets/Asset Packs/PSX Humble Bundle/PSX Mega Pack 3.1.3/Models/GLB (recommended)',
  '/wii/': 'G:/GPT/Projectless/2026-10-04/gen/outputs/Wii_Remote_LowPoly',
};
const OUT = process.env.VS_OUT || 'G:/Claude/Virtual Legacy/Channel/Virtual Shot spike';
const PORT = +(process.argv[2] || process.env.PORT || 8790);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.glb': 'model/gltf-binary', '.woff': 'font/woff', '.woff2': 'font/woff2', '.css': 'text/css', '.wasm': 'application/wasm' };

function resolveGet(urlPath) {
  for (const [pre, root] of Object.entries(MOUNTS)) if (urlPath.startsWith(pre)) return safeJoin(root, urlPath.slice(pre.length));
  return safeJoin(REPO, urlPath.slice(1) || 'src/index.html');
}
function safeJoin(root, rel) {
  const p = path.resolve(root, decodeURIComponent(rel));
  return p.startsWith(path.resolve(root)) ? p : null;
}

http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
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
