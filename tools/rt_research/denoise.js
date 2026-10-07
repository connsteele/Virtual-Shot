(async () => { const E = VS.E, sh = E.shot, out = []; sh.rtPrepass = true; sh.setTiming(true);
  const idle = () => Promise.race([sh.renderer.backend.device.queue.onSubmittedWorkDone(), new Promise(r => setTimeout(r, 10000))]);
  const c = document.createElement('canvas'); c.width = 1920; c.height = 1080; const x = c.getContext('2d'), gpu = document.getElementById('gpu');
  for (const k of ['shafts', 'softShadows', 'contact', 'hazeShadow', 'rtShadows', 'rtGI', 'rtAO', 'rtRefl', 'rtPT']) E.show[k] = false; E.show.rtGI = true;
  for (const f of [720, 1000]) for (const n of [1, 4]) for (const [it, sz, sl] of [[0, 0, 0], [3, 0.01, 0.25], [4, 0.01, 0.25], [4, 0.01, 1]]) {
    E.frame = f; sh.rtl.accumulate = true; await idle(); E.renderNow('render', { output: true }); await idle();
    for (let i = 1; i < n; i++) { sh.refineRT(); await idle(); }
    await sh.gpuTimes();
    if (it) sh.denoiseRT(it, { sigmaZ: sz, sigmaL: sl }); else sh.refineRT === null;
    if (!it) { sh.post3D(); sh.renderer.setRenderTarget(null); sh.comp.quad.render(sh.renderer); }
    x.drawImage(gpu, 0, 0); await idle(); const t = await sh.gpuTimes();
    const dn = t.filter(p => p.name === 'rt denoise').reduce((a, b) => a + b.ms, 0);
    const b = await new Promise(r => c.toBlob(r, 'image/png'));
    const name = `f${String(f).padStart(5, '0')}_gi_n${n}_dn${it}${it ? '_sl' + sl : ''}.png`;
    await fetch('/save/rt_lighting/research/denoise/' + name, { method: 'POST', body: b });
    out.push({ name, denoiseMs: +dn.toFixed(3) }); sh.rtl.accumulate = false; }
  return out; })()
