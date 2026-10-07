// Build the artifact version of the spike viewer into dist/artifact (gitignored: it holds copies of the models).
//   node tools/build_artifact.mjs
// The page is src/artifact.html; the modules are published beside it unchanged; three.js comes from jsDelivr at the
// pinned version; assets are copied (read in place from E: and G:) under assets/ and the scene's refs rewritten to rel:.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO, 'dist/artifact');
const ROOTS = {
  psx: 'E:/Assets/Asset Packs/PSX Humble Bundle/PSX Mega Pack 3.1.3/Models/GLB (recommended)',
  wii: 'G:/GPT/Projectless/2026-10-04/gen/outputs/Wii_Remote_LowPoly',
  bp: 'G:/Claude/Virtual Legacy/Videos/Calling (Wii)/Thumbnails & Graphics/Black Page Studio',
};
const pin = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'))).dependencies.three;
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });

const doc = JSON.parse(fs.readFileSync(path.join(REPO, 'scenes/black_page.scene.json')));
const files = {};
for (const [key, ref] of Object.entries(doc.assets)) {
  const [ns, ...rest] = ref.split(':'), src = path.join(ROOTS[ns], rest.join(':')), ext = path.extname(src);
  if (ext === '.woff') { doc.assets[key] = 'data:font/woff;base64,' + fs.readFileSync(src).toString('base64'); continue; } // font loads are CSP-limited
  if (ext === '.glb') { // artifacts don't serve .glb: ship it as base64 text
    const rel = `assets/${key}.glb.txt`; fs.writeFileSync(path.join(OUT, rel), fs.readFileSync(src).toString('base64'));
    doc.assets[key] = 'rel:' + rel; files[rel] = rel; continue; }
  const rel = `assets/${key}${ext}`;
  fs.copyFileSync(src, path.join(OUT, rel)); doc.assets[key] = 'rel:' + rel; files[rel] = rel;
}
fs.writeFileSync(path.join(OUT, 'scene.json'), JSON.stringify(doc)); files['scene.json'] = 'scene.json';
for (const f of walk(path.join(REPO, 'src')).filter(f => f.endsWith('.js') || f.endsWith('.css'))) {
  const rel = path.relative(REPO, f).split(path.sep).join('/');
  fs.mkdirSync(path.dirname(path.join(OUT, rel)), { recursive: true }); fs.copyFileSync(f, path.join(OUT, rel)); files[rel] = rel;
}
// the page: the editor (src/editor/artifact.html); VIEWER=1 builds the plain viewer (src/artifact.html) instead
const html = fs.readFileSync(path.join(REPO, process.env.VIEWER ? 'src/artifact.html' : 'src/editor/artifact.html'), 'utf8');
if (!html.includes(`three@${pin}/`)) throw new Error(`artifact.html does not load three@${pin}`);
fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.writeFileSync(path.join(OUT, 'files.json'), JSON.stringify(files, null, 1));
const size = Object.keys(files).reduce((s, f) => s + fs.statSync(path.join(OUT, f)).size, 0) + html.length;
console.log(`built ${OUT}: ${Object.keys(files).length + 1} files, ${(size / 1024).toFixed(0)} KB`);

function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]); }
