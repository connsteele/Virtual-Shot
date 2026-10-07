// Page-side helper for the shadow research: renders frames at Render quality with each shadow setup, writes the PNGs
// under the spike output folder (through the dev server) and returns the GPU time of every pass.
//   node tools/headless.mjs "/src/editor/index.html?bg" "(await import('/tools/shadow_eval.js')).run([300, 720], 'shadows/run1')"
const CONFIGS = { off: {}, shafts: { shafts: true }, surface: { softShadows: true }, both: { shafts: true, softShadows: true } };

export async function run(frames, dir, configs = Object.keys(CONFIGS), { save = true, reps = 3 } = {}) {
  const { E } = window.VS, shot = E.shot, out = document.createElement('canvas'); out.width = 1920; out.height = 1080;
  const ox = out.getContext('2d'), gpu = document.getElementById('gpu'), timing = shot.canTime, res = [];
  if (timing) shot.setTiming(true);
  for (const f of frames) for (const name of configs) {
    for (const k of ['shafts', 'softShadows']) E.show[k] = !!CONFIGS[name][k];
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
  for (const k of ['shafts', 'softShadows']) E.show[k] = false;
  return res;
}
