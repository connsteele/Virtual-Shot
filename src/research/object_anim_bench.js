// Object animation research pass: GPU/CPU bench, scrub and renders in the editor (headless). Loaded with import() from
// tools/headless.mjs; nothing here runs by default.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r2 = x => Math.round(x * 100) / 100;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const stats = a => ({ mean: r2(a.reduce((s, x) => s + x, 0) / a.length), p50: r2(pct(a, .5)), p95: r2(pct(a, .95)), max: r2(Math.max(...a)) });
const gpuIdle = (E, cap = 2000) => Promise.race([E.shot.renderer.backend.device.queue.onSubmittedWorkDone(), sleep(cap)]);

/** Evaluate cost (E.state()) and the renderer's object pass (applyObjects: matrices, mixers) timed separately. */
function wrap(E) {
  if (E._benchWrapped) return; E._benchWrapped = true; E.bt = { state: [], apply: [] };
  const st = E.state; E.state = () => { const t0 = performance.now(); const r = st(); const d = performance.now() - t0; E.bt.state.push(d); E.perf.part('evaluate (time core)', d); return r; };
  const sh = E.shot, ap = sh.applyObjects.bind(sh);
  sh.applyObjects = (s, rk) => { const t0 = performance.now(); ap(s, rk); const d = performance.now() - t0; E.bt.apply.push(d); E.perf.part('applyObjects (matrices, clips)', d); };
}

export async function bench(E, { quality = 'render', from = 700, frames = 30, warm = 8 } = {}) {
  wrap(E); const perf = E.perf; perf.toggle(true);
  for (let i = 0; i < warm; i++) { E.frame = from + i; E.renderNow(quality, { output: true }); await gpuIdle(E); }
  await sleep(200); await perf.resolve(); perf.reset(); E.bt.state = []; E.bt.apply = [];
  const wall = [];
  for (let i = 0; i < frames; i++) { E.frame = from + warm + i; const t0 = performance.now(); E.renderNow(quality, { output: true }); await gpuIdle(E); wall.push(performance.now() - t0); if (i % 5 === 4) await perf.resolve(); }
  await sleep(300); perf.resolving = false; await perf.resolve();
  const s = perf.summary(perf.frames).output;
  return { quality, frames, cpu_ms: s.cpu_ms, gpu_ms: s.gpu_ms, gpu_pass_mean_ms: s.gpu_pass_mean_ms, cpu_part_mean_ms: s.cpu_part_mean_ms, evaluate_ms: stats(E.bt.state), applyObjects_ms: stats(E.bt.apply), wall_ms: stats(wall) };
}

export async function scrub(E, { frames = 40 } = {}) {
  wrap(E); const out = {}; let x = 3; const rnd = () => (x = (x * 16807) % 2147483647) / 2147483647;
  for (const mode of ['sequential', 'random']) {
    const cpu = [], wall = []; E.bt.state = []; E.bt.apply = [];
    for (let i = 0; i < frames; i++) { E.frame = mode === 'sequential' ? 600 + i : Math.floor(rnd() * E.last);
      const t0 = performance.now(); E.renderNow('play'); const t1 = performance.now(); await gpuIdle(E); cpu.push(t1 - t0); wall.push(performance.now() - t0); }
    out[mode] = { cpu_ms: stats(cpu), wall_ms: stats(wall), evaluate_ms: stats(E.bt.state), applyObjects_ms: stats(E.bt.apply) };
  }
  return out;
}

/** One frame to disk from the camera (output) or the free view (lit for editing), drawn and read in the same task. */
export async function still(E, frame, path, { view = 'camera', freeCam = null } = {}) {
  E.frame = frame;
  if (view === 'free') { E.setView('free'); if (freeCam) { const v = E.panels.viewport; v.freeCam.position.set(...freeCam.eye); v.orbit.target.set(...freeCam.target); v.orbit.update(); } E.renderNow('render'); }
  else { if (E.view !== 'camera') E.setView('camera'); E.renderNow('render', { output: true }); }
  const cv = document.getElementById('gpu'), c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height; c.getContext('2d').drawImage(cv, 0, 0);
  const b = await new Promise(r => c.toBlob(r, 'image/png')); await fetch('/save/' + path, { method: 'POST', body: b }); await gpuIdle(E);
  return [cv.width, cv.height];
}

export async function clip(E, dir, from, to, step = 1, opts = {}) {
  let n = 0; for (let f = from; f <= to; f += step) { await still(E, f, `${dir}/f${String(n++).padStart(4, '0')}.png`, opts); await sleep(5); }
  return n;
}
