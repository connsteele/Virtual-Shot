// Live camera latency / jitter matrix: the simulated game streams through the bridge while the editor (headless Chrome)
// draws the shot from it in each play-out mode, with the look off and on, at Play and Render quality.
//   node tools/live_bench.mjs [out.json] [--secs=8] [--hitch=4] [--rate=60]
// Needs the dev server (VS_BASE) and server/bridge.mjs on 8799. Take the GPU lock first: it renders continuously.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
const A = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; }));
const OUT = process.argv.slice(2).find(a => !a.startsWith('--')) || 'G:/Claude/Virtual Legacy/Channel/Virtual Shot spike/engine_bridge/research/live_bench.json';
const SECS = +(A.secs || 8), RUNS = JSON.parse(A.runs || 'null') || [
  { look: 'off', mode: 'latest' }, { look: 'off', mode: 'interp', delay: 20 }, { look: 'off', mode: 'interp', delay: 50 }, { look: 'off', mode: 'interp', delay: 100 }, { look: 'off', mode: 'extrap' },
  { look: 'full', mode: 'latest' }, { look: 'full', mode: 'interp', delay: 50 }, { look: 'full', mode: 'extrap' },
  { look: 'full', mode: 'interp', delay: 50, quality: 'render', secs: 6 },
];
const total = RUNS.reduce((s, r) => s + (r.secs || SECS) + 1.6, 0) + 40;
const sim = spawn('node', ['tools/sim_game.mjs', `--secs=${Math.ceil(total)}`, `--hitch=${A.hitch ?? 4}`, `--rate=${A.rate || 60}`, '--events'], { stdio: 'ignore' });
const js = `(async () => { const m = await import('/tools/live_test.js'), out = [];
  for (const r of ${JSON.stringify(RUNS)}) out.push({ run: r, ...(await m.measure({ secs: ${SECS}, ...r })) });
  return out; })()`;
const gpu = () => { try { return execFileSync('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader'], { encoding: 'utf8' }).trim(); } catch { return 'n/a'; } };
const before = gpu();
const res = execFileSync('node', ['tools/headless.mjs', '/src/editor/index.html?f=720&bg', js], { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' }, maxBuffer: 64e6 });
sim.kill();
const data = JSON.parse(res.slice(res.indexOf('['), res.lastIndexOf(']') + 1));
fs.mkdirSync(OUT.replace(/[\/][^\/]+$/, ''), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), gpuBefore: before, gpuAfter: gpu(), secs: SECS, args: A, runs: data }, null, 1));
const row = r => { const L = r.latency || {}, J = r.judder || {}, PE = r.poseError || {};
  return [`${r.run.look}/${r.run.quality || 'play'} ${r.run.mode}${r.run.delay != null ? ' ' + r.run.delay + 'ms' : ''}`, r.frames, r.display?.interval?.mean, L.poseAgeAtGpuDone?.p50, L.poseAgeAtGpuDone?.p95,
    L.gpuDoneAfterSubmit?.p50, J.lagSd, J.lagMaxDev, J.repeats, J.held, J.extrapolated, PE.vsSmoothDelayed?.mm?.p95, PE.vsSmoothDelayed?.mm?.max, PE.reconstruction?.mm?.max].join(' | '); };
console.log('run | frames | display ms | pose age at GPU done p50 | p95 | GPU done after submit p50 | judder sd ms | max dev ms | repeats | held | extrap | judder mm p95 | max | reconstruction mm max');
for (const r of data) console.log(row(r));
