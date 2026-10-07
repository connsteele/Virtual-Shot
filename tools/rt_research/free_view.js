(async () => { const E = VS.E, sh = E.shot, out = []; sh.rtPrepass = true;
  const idle = () => Promise.race([sh.renderer.backend.device.queue.onSubmittedWorkDone(), new Promise(r => setTimeout(r, 10000))]);
  const c = document.createElement('canvas'); c.width = 1920; c.height = 1080; const x = c.getContext('2d'), gpu = document.getElementById('gpu');
  const keys = ['shafts', 'softShadows', 'contact', 'hazeShadow', 'rtShadows', 'rtGI', 'rtAO', 'rtRefl', 'rtPT'];
  E.show.grid = E.show.frustum = E.show.hazeBox = E.show.lights = E.show.bounds = false; E.setView('free');
  const vp = window.VSviewport;
  for (const f of window.FRAMES) for (const [name, cfg, n] of window.CFGS) {
    for (const k of keys) E.show[k] = !!cfg[k]; E.frame = f; sh.rtl.accumulate = n > 1 && !cfg.rtPT;
    await idle(); E.renderNow('render'); if (n === 1) x.drawImage(gpu, 0, 0); await idle();
    for (let i = 1; i < n; i++) { sh.refineRT(); if (i === n - 1) x.drawImage(gpu, 0, 0); await idle(); }
    sh.rtl.accumulate = false;
    const b = await new Promise(r => c.toBlob(r, 'image/png'));
    await fetch(`/save/rt_lighting/research/lit/${window.TAG}_f${String(f).padStart(5, '0')}_${name}.png`, { method: 'POST', body: b }); out.push(name); }
  for (const k of keys) E.show[k] = false; return out; })()
