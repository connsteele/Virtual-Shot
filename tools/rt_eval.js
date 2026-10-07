// Page-side helper for the ray-traced lighting research: renders frames at Render quality with each setup, writes the
// PNGs under the spike output folder (through the dev server) and returns GPU ms per pass. Every render waits for the
// GPU to finish (device.queue.onSubmittedWorkDone) before the next is queued, so no more than one heavy frame is in flight.
//   node tools/headless.mjs "/src/editor/index.html?bg" "(await import('/tools/rt_eval.js')).run([420, 720, 1000], 'rt_lighting/stills')"
export const CONFIGS = {
  off: {}, gi: { rtGI: true }, ao: { rtAO: true }, refl: { rtRefl: true }, all: { rtGI: true, rtAO: true, rtRefl: true },
  contact: { contact: true }, pt: { rtPT: true },
};
export const KEYS = ['shafts', 'softShadows', 'contact', 'hazeShadow', 'rtShadows', 'rtGI', 'rtAO', 'rtRefl', 'rtPT'];
const idle = () => window.VS.E.shot.renderer.backend.device?.queue.onSubmittedWorkDone() ?? Promise.resolve();
const pad = f => String(f).padStart(5, '0');

async function save(canvas, path) {
  const blob = await (await fetch(canvas.toDataURL('image/png'))).blob();
  const r = await fetch(`/save/${path}`, { method: 'POST', body: blob }); if (!r.ok) throw new Error('save failed ' + r.status);
}
const setCfg = (E, cfg) => { for (const k of KEYS) E.show[k] = !!cfg[k]; };

/** frames x configs. accum: passes to accumulate for the RT setups (1 = the real-time single pass). debug: the
 *  RT lighting debug view (0 picture, 1 direct only, 2 bounce only, 3 AO, 4 reflections). */
export async function run(frames, dir, configs = Object.keys(CONFIGS), { accum = 1, ptSamples = 256, debug = 0, suffix = '', timing = false } = {}) {
  const { E } = window.VS, shot = E.shot, out = document.createElement('canvas'); out.width = 1920; out.height = 1080;
  const ox = out.getContext('2d'), gpu = document.getElementById('gpu'), res = [];
  if (timing && shot.canTime) shot.setTiming(true);
  if (shot.rtl) shot.rtl.U.debug.value = debug;
  for (const f of frames) for (const name of configs) {
    const cfg = CONFIGS[name]; setCfg(E, cfg); E.frame = f;
    const isRT = cfg.rtGI || cfg.rtAO || cfg.rtRefl || cfg.rtPT;
    const n = cfg.rtPT ? ptSamples : isRT ? accum : 1, t0 = performance.now();
    if (shot.rtl) shot.rtl.accumulate = n > 1;
    if (timing) await shot.gpuTimes();
    // the canvas must be read in the same task as the render that drew it
    E.renderNow('render', { output: true }); if (n === 1) ox.drawImage(gpu, 0, 0); await idle();
    let ms = timing ? await shot.gpuTimes() : null;
    for (let i = 1; i < n; i++) { shot.refineRT(); if (i === n - 1) ox.drawImage(gpu, 0, 0); await idle(); }   // one pass per submit, waited on
    if (shot.rtl) shot.rtl.accumulate = false;
    const passes = {}; for (const p of ms || []) { const key = p.name.replace(/ \d+\/\d+$/, ''); passes[key] = +((passes[key] || 0) + p.ms).toFixed(3); }
    await save(out, `${dir}/f${pad(f)}_${name}${suffix}.png`);
    res.push({ f, name, samples: n, wallMs: Math.round(performance.now() - t0), passes });
  }
  setCfg(E, {}); if (shot.rtl) shot.rtl.U.debug.value = 0;
  return res;
}

/** Cost: median GPU ms per pass over reps single renders (quality 'render' | 'play'), plus one accumulation pass. */
export async function cost(frames, quality = 'render', configs = ['off', 'gi', 'ao', 'refl', 'all', 'pt'], reps = 5) {
  const { E } = window.VS, shot = E.shot, res = []; shot.setTiming(true);
  const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  for (const f of frames) for (const name of configs) {
    setCfg(E, CONFIGS[name]); E.frame = f; const per = {}, tot = [], cpu = [];
    for (let i = 0; i < reps + 1; i++) {
      shot.rtl?.invalidate(); await shot.gpuTimes();
      const c0 = performance.now(); E.renderNow(quality, { output: true }); cpu.push(performance.now() - c0); await idle();
      const t = await shot.gpuTimes(); if (i === 0) continue;   // the first may compile
      const p = {}; for (const x of t) { const key = x.name.replace(/ \d+\/\d+$/, ''); p[key] = (p[key] || 0) + x.ms; }
      for (const [k, v] of Object.entries(p)) (per[k] ||= []).push(v); tot.push(Object.values(p).reduce((a, b) => a + b, 0));
    }
    const row = { f, quality, name, total: +med(tot).toFixed(2), passes: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, +med(v).toFixed(3)])),
      cpuMs: +med(cpu.slice(1)).toFixed(1), bvh: shot.rtl?.stats() };
    if (CONFIGS[name].rtPT || name !== 'off') {   // one refine (accumulation) pass on its own
      shot.rtl.accumulate = true; const pp = [];
      for (let i = 0; i < reps; i++) { await shot.gpuTimes(); shot.refineRT(); await idle(); const t = await shot.gpuTimes(); pp.push(t.reduce((a, b) => a + b.ms, 0)); }
      shot.rtl.accumulate = false; row.refinePassMs = +med(pp).toFixed(2);
    }
    res.push(row);
  }
  setCfg(E, {});
  return res;
}

const half = v => { const s = (v & 0x8000) ? -1 : 1, e = (v >> 10) & 31, m = v & 1023; return e === 0 ? s * m / 16777216 : s * (1 + m / 1024) * Math.pow(2, e - 15); };
/** The screen's light grid (linear, x screenLight) averaged over the glass, and the fake's light colour, per frame:
 *  the numbers behind look.rtLighting.screenGain. */
export async function calibrate(frames) {
  const { E } = window.VS, shot = E.shot, out = [];
  const lum = c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  for (const f of frames) {
    setCfg(E, { rtAO: true }); E.frame = f; E.renderNow('render', { output: true }); await idle();
    const rt = shot.emitRT, px = await shot.renderer.readRenderTargetPixelsAsync(rt, 0, 0, rt.width, rt.height);
    const row = px.length / rt.height, m = [0, 0, 0];
    for (let y = 0; y < rt.height; y++) for (let x = 0; x < rt.width; x++) for (let c = 0; c < 3; c++) { const v = px[y * row + x * 4 + c]; m[c] += (px instanceof Uint16Array ? half(v) : v) / (rt.width * rt.height); }
    const sc = E.st.glowCol;
    out.push({ f, emitMean: m.map(v => +v.toFixed(4)), glowCol: sc.map(v => +v.toFixed(3)), gain: +(lum(sc) / lum(m)).toFixed(5) });
  }
  setCfg(E, {});
  return out;
}

/** Everything for one key frame: off, contact AO, each RT toggle and all of them as one real-time pass and as 16
 *  accumulated passes, the light terms on their own (RT vs the fake), and the path-traced reference. */
export async function stills(f, dir, { ptSamples = 256 } = {}) {
  const out = [];
  out.push(...await run([f], dir, ['off', 'contact', 'gi', 'ao', 'refl', 'all']));
  out.push(...await run([f], dir, ['gi', 'ao', 'refl', 'all'], { accum: 16, suffix: '_acc16' }));
  for (const [d, s] of [[1, 'rt_direct'], [2, 'rt_bounce'], [5, 'fake_direct'], [6, 'fake_bounce'], [3, 'ao_only'], [4, 'refl_only']])
    out.push(...await run([f], dir, [d === 3 ? 'ao' : d === 4 ? 'refl' : 'gi'], { accum: 16, debug: d, suffix: '_' + s }));
  out.push(...await run([f], dir, ['pt'], { ptSamples }));
  return out.map(r => `${r.f} ${r.name} ${r.samples} ${r.wallMs}ms`);
}
