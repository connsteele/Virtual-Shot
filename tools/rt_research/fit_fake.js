(async () => { const E = VS.E, sh = E.shot, ev = await import('/tools/rt_eval.js'); sh.rtPrepass = true;
  const idle = () => Promise.race([sh.renderer.backend.device.queue.onSubmittedWorkDone(), new Promise(r => setTimeout(r, 10000))]);
  const c = document.createElement('canvas'); c.width = 1920; c.height = 1080; const x = c.getContext('2d'), gpu = document.getElementById('gpu');
  const keys = ['shafts', 'softShadows', 'contact', 'hazeShadow', 'rtShadows', 'rtGI', 'rtAO', 'rtRefl', 'rtPT'];
  const cal = {}; for (const r of await ev.calibrate(window.FRAMES)) cal[r.f] = r;   // screen mean colour per frame (linear grid)
  E.show.grid = E.show.frustum = E.show.hazeBox = E.show.lights = E.show.bounds = false; E.setView('free');
  const orig = E.state; let tw = null;
  E.state = () => { const st = orig(); if (!tw) return st; const L = st.lighting, g = sh.ix.glass;
    const sc = tw.col === 'screen' ? cal[E.frame].emitMean.map(v => v * sh.rtl.U.screenGain.value) : st.glowCol;
    const bp = tw.bpos === 'under' ? g.ctr.map((v, i) => v + g.n[i] * 0.35 - (i === 1 ? 0.25 : 0)) : L.bouncePos;
    return { ...st, glowCol: sc, lighting: { ...L, screen: L.screen * tw.k, bounce: L.bounce * tw.b, bouncePos: bp } }; };
  const grab = async (n, pt) => { for (const k of keys) E.show[k] = false; if (pt) E.show.rtPT = true; await idle(); E.renderNow('render');
    if (n === 1) x.drawImage(gpu, 0, 0); await idle(); for (let i = 1; i < n; i++) { sh.refineRT(); if (i === n - 1) x.drawImage(gpu, 0, 0); await idle(); }
    E.show.rtPT = false; return x.getImageData(0, 0, 1920, 1080).data; };
  const rmse = (a, b) => { let s = 0, n = 0; for (let i = 0; i < a.length; i += 4) for (let k = 0; k < 3; k++) { const d = a[i + k] - b[i + k]; s += d * d; n++; } return Math.sqrt(s / n); };
  const db = r => +(20 * Math.log10(255 / r)).toFixed(2);
  const out = { frames: {} };
  const grid = []; for (const k of (window.KS || [0.75, 1, 1.5, 2, 3])) for (const col of ['glow', 'screen']) for (const spFwd of (window.SPS || [-0.3, -0.1, 0.06, 0.25])) for (const b of [0, 1, 2]) for (const bpos of ['default', 'under']) for (const area of (window.AREAS || [0])) if (!(b === 0 && bpos === 'under') && !(area && spFwd !== 0.06)) grid.push({ k, col, spFwd, b, bpos, area });
  const scores = grid.map(() => 0);
  for (const f of window.FRAMES) { E.frame = f; tw = null; sh.spFwd = undefined;
    const ref = await grab(128, true); const res = [];
    for (const [i, t] of grid.entries()) { tw = t; sh.spFwd = t.spFwd; sh.fakeArea = !!t.area; const img = await grab(1, false); const r = rmse(img, ref); res.push(r); if (window.FIT.includes(f)) scores[i] += r * r; }
    tw = null; sh.spFwd = undefined; sh.fakeArea = false;
    out.frames[f] = { base: db(res[grid.findIndex(t => t.k === 1 && t.col === 'glow' && t.spFwd === 0.06 && t.b === 1 && t.bpos === 'default' && !t.area)]), all: res.map(db) }; }
  const best = scores.map((s, i) => [s, i]).sort((a, b) => a[0] - b[0]).slice(0, 8).map(([, i]) => ({ ...grid[i], dB: Object.fromEntries(window.FRAMES.map(f => [f, out.frames[f].all[i]])) }));
  // save the base and the best fake per frame for the sheet
  for (const f of window.FRAMES) for (const [name, t] of [['fake_base', null], ['fake_tuned', best[0]]]) { E.frame = f; tw = t; sh.spFwd = t?.spFwd; sh.fakeArea = !!t?.area; await idle(); E.renderNow('render'); x.drawImage(gpu, 0, 0);
    const bl = await new Promise(r => c.toBlob(r, 'image/png')); await fetch(`/save/rt_lighting/research/retune/free_f${String(f).padStart(5, '0')}_${name}.png`, { method: 'POST', body: bl }); }
  tw = null; sh.spFwd = undefined; E.state = orig;
  return { cal, best, base: Object.fromEntries(window.FRAMES.map(f => [f, out.frames[f].base])), n: grid.length }; })()
