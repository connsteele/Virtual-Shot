(async () => { const E = VS.E, sh = E.shot;
  const idle = () => Promise.race([sh.renderer.backend.device.queue.onSubmittedWorkDone(), new Promise(r => setTimeout(r, 10000))]);
  const c = document.createElement('canvas'); c.width = 1920; c.height = 1080; const x = c.getContext('2d'), gpu = document.getElementById('gpu');
  E.show.grid = E.show.frustum = E.show.hazeBox = E.show.lights = E.show.bounds = false; E.setView('free');
  const orig = E.state; let tw = null;
  E.state = () => { const st = orig(); if (!tw) return st; const L = st.lighting; return { ...st, lighting: { ...L, screen: L.screen * tw.k, bounce: L.bounce * tw.b } }; };
  const out = [];
  for (const f of [420, 720, 1000]) for (const [name, t] of [['fake_base', null], ['fake_oldlaw_k4_nobounce', { k: 4, b: 0 }], ['fake_area_k1', { k: 1, b: 1, area: 1 }], ['fake_area_k5', { k: 5, b: 1, area: 1 }]]) {
    E.frame = f; tw = t; sh.fakeArea = !!t?.area; await idle(); E.renderNow('render'); x.drawImage(gpu, 0, 0);
    const bl = await new Promise(r => c.toBlob(r, 'image/png')); out.push((await fetch(`/save/rt_lighting/research/retune/free_f${String(f).padStart(5, '0')}_${name}.png`, { method: 'POST', body: bl })).status); }
  tw = null; sh.fakeArea = false; E.state = orig; return out; })()
