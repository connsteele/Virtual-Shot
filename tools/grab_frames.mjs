// Render shot frames at Render quality (full look, as renders to disk) and save PNGs under the spike output folder.
//   node tools/grab_frames.mjs <dir under the output folder> 300 720
// Uses tools/headless.mjs (VS_BASE / CDP_PORT from the environment). For bit-identity checks against another branch.
import { execFileSync } from 'node:child_process';
const [, , dir, ...frames] = process.argv;
const js = `(async () => { const E = VS.E, out = []; const c = document.createElement('canvas'), x = c.getContext('2d');
  for (const f of [${frames.join(',')}]) { E.frame = f; E.renderNow('render', { output: true }); c.width = E.shot.OW; c.height = E.shot.OH; x.drawImage(document.getElementById('gpu'), 0, 0);
    const b = await new Promise(r => c.toBlob(r, 'image/png')); const r = await fetch('/save/${dir}/f' + String(f).padStart(5, '0') + '.png', { method: 'POST', body: b }); out.push(f + ':' + r.status);
    if (E.shot.backend === 'WebGPU') await E.shot.renderer.backend.device.queue.onSubmittedWorkDone(); }
  out.push(E.shot.backend);
  return out; })()`;
process.stdout.write(execFileSync('node', ['tools/headless.mjs', '/src/editor/index.html?f=300&bg', js], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }));
