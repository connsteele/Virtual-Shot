// Page-side helper for the shadow research: renders frames at Render quality with each shadow setup, writes the PNGs
// under the spike output folder (through the dev server) and returns the GPU time of every pass.
//   node tools/headless.mjs "/src/editor/index.html?bg" "(await import('/tools/shadow_eval.js')).run([300, 720], 'shadows/run1')"
const CONFIGS = { off: {}, shafts: { shafts: true }, surface: { softShadows: true }, contact: { contact: true }, both: { shafts: true, softShadows: true },
  all: { shafts: true, softShadows: true, contact: true }, self: { hazeShadow: true }, rt: { rtShadows: true }, all2: { shafts: true, softShadows: true, contact: true, hazeShadow: true } };
const KEYS = ['shafts', 'softShadows', 'contact', 'hazeShadow', 'rtShadows'];

export async function run(frames, dir, configs = Object.keys(CONFIGS), { save = true, reps = 3 } = {}) {
  const { E } = window.VS, shot = E.shot, out = document.createElement('canvas'); out.width = 1920; out.height = 1080;
  const ox = out.getContext('2d'), gpu = document.getElementById('gpu'), timing = shot.canTime, res = [];
  if (timing) shot.setTiming(true);
  for (const f of frames) for (const name of configs) {
    for (const k of KEYS) E.show[k] = !!CONFIGS[name][k];
    E.frame = f;
    let ms = null;
    for (let i = 0; i < reps; i++) {   // the first render after a change also redraws the shadow maps; later ones reuse them
      if (i === reps - 1) shot.shadows.invalidate();
      if (timing) await shot.gpuTimes();
      E.renderNow('render', { output: true });
      if (i === reps - 1) ox.drawImage(gpu, 0, 0);
      if (timing) { await shot.renderer.backend.device.queue.onSubmittedWorkDone(); const t = await shot.gpuTimes(); if (i === reps - 1) ms = t; }
    }
    const passes = {}; for (const p of ms || []) { const key = p.name.replace(/ \d+\/\d+$/, ''); passes[key] = +((passes[key] || 0) + p.ms).toFixed(3); }
    if (save) { const blob = await (await fetch(out.toDataURL('image/png'))).blob();
      const r = await fetch(`/save/${dir}/f${String(f).padStart(5, '0')}_${name}.png`, { method: 'POST', body: blob }); if (!r.ok) throw new Error('save failed ' + r.status); }
    res.push({ f, name, total: +Object.values(passes).reduce((a, b) => a + b, 0).toFixed(2), passes });
  }
  for (const k of KEYS) E.show[k] = false;
  return res;
}

/** The same comparison from a camera of your own (eye, target in metres), depth of field off: shows the shadows from
 *  angles the shot camera never takes (light shafts read best across the light, not along it). */
export async function side(f, eye, target, dir, configs = ['off', 'shafts', 'surface'], { fov = 40 } = {}) {
  const { E } = window.VS, shot = E.shot, out = document.createElement('canvas'); out.width = 1920; out.height = 1080;
  const ox = out.getContext('2d'), gpu = document.getElementById('gpu');
  E.frame = f; E.renderNow('render', { output: true });
  const st0 = E.state(), saved = [];
  for (const name of configs) {
    const st = { ...st0, focus: null, camera: { ...st0.camera, eye, target, up: [0, 1, 0], fov, fovRender: fov, k: 0, ov: 1, squint: 0 } };
    shot.shadows.invalidate();
    shot.render(st, { ...E.layerOpts, quality: 'render', show: { ...CONFIGS[name], dof: false } });
    ox.drawImage(gpu, 0, 0);
    const name_ = `${dir}/f${String(f).padStart(5, '0')}_side_${name}.png`;
    const r = await fetch('/save/' + name_, { method: 'POST', body: await (await fetch(out.toDataURL('image/png'))).blob() }); if (!r.ok) throw new Error('save failed');
    saved.push(name_);
  }
  return saved;
}

/** The contact-shadow buffer itself (white = open, dark = occluded) for frame f, as a PNG under dir. */
export async function aoBuffer(f, dir) {
  const { E } = window.VS, shot = E.shot; E.show.contact = true; E.frame = f; E.renderNow('render', { output: true }); E.show.contact = false;
  const rt = shot.aoRT, px = await shot.renderer.readRenderTargetPixelsAsync(rt, 0, 0, rt.width, rt.height);
  const out = new Uint8Array(rt.width * rt.height * 4), n = rt.width * rt.height, row = px.length / rt.height;   // rows are padded
  const half = v => { const s = (v & 0x8000) ? -1 : 1, e = (v >> 10) & 31, m = v & 1023; return e === 0 ? s * m / 16777216 : s * (1 + m / 1024) * Math.pow(2, e - 15); };
  for (let i = 0; i < n; i++) { const j = Math.floor(i / rt.width) * row + (i % rt.width), a = px instanceof Uint16Array ? half(px[j]) : px[j]; const v = Math.max(0, Math.min(255, Math.round(a * 255))); out.set([v, v, v, 255], i * 4); }
  const r = await fetch(`/save-rgba/${dir}/f${String(f).padStart(5, '0')}_ao.png?w=${rt.width}&h=${rt.height}`, { method: 'POST', body: out });
  return [rt.width, rt.height, r.status];
}

/** Cost of each setup: median GPU ms per pass over reps renders (shadow maps redrawn every time, as while the remote
 *  rumbles) and the CPU time of the shadow-map encodes. quality: 'render' | 'play'. */
export async function cost(frames, quality = 'render', configs = ['off', 'shafts', 'surface', 'contact', 'all'], reps = 7) {
  const { E } = window.VS, shot = E.shot, res = []; shot.setTiming(true);
  const cpu = []; for (const S of [shot.shadows, shot.ringShadows]) { const u = S.update; S.update = (...a) => { const t = performance.now(); const r = u(...a); cpu.push(performance.now() - t); return r; }; }
  const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  for (const f of frames) for (const name of configs) {
    for (const k of KEYS) E.show[k] = !!CONFIGS[name][k];
    E.frame = f; const per = {}, tot = []; cpu.length = 0;
    for (let i = 0; i < reps + 1; i++) {
      shot.shadows.invalidate(); shot.ringShadows.invalidate(); await shot.gpuTimes();
      E.renderNow(quality, { output: true }); await shot.renderer.backend.device.queue.onSubmittedWorkDone();
      const t = await shot.gpuTimes(); if (i === 0) continue;   // the first may compile
      const p = {}; for (const x of t) { const key = x.name.replace(/ \d+\/\d+$/, ''); p[key] = (p[key] || 0) + x.ms; }
      for (const [k, v] of Object.entries(p)) (per[k] ||= []).push(v); tot.push(Object.values(p).reduce((a, b) => a + b, 0));
    }
    res.push({ f, quality, name, total: +med(tot).toFixed(2), passes: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, +med(v).toFixed(3)])),
      shadowCpu: cpu.length ? +(cpu.slice(2).reduce((a, b) => a + b, 0) / Math.max(1, reps)).toFixed(2) : 0 });
  }
  for (const k of KEYS) E.show[k] = false;
  return res;
}
