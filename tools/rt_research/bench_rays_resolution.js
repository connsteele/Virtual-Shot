(async () => { const ev = await import('/tools/rt_eval.js'), E = VS.E, sh = E.shot, RL = sh.rtl, out = { rays: [], ao: [], res: [] };
  const scene = row => +Object.entries(row.passes).filter(([n]) => /scene/.test(n) && !/pre-pass/.test(n)).reduce((s, [, v]) => s + v, 0).toFixed(3);
  const R0 = { ...RL.O.render };
  for (const pp of [false, true]) { sh.rtPrepass = pp;
    for (const [d, b] of [[1, 1], [4, 2], [9, 4], [16, 8], [36, 16], [64, 32]]) { RL.O.render = { ...R0, direct: d, bounce: b };
      const [row] = await ev.cost([720], 'render', ['gi'], 3); out.rays.push({ prepass: pp, direct: d, bounce: b, sceneMs: scene(row) }); }
    for (const a of [2, 4, 8, 16, 32]) { RL.O.render = { ...R0, ao: a }; const [row] = await ev.cost([720], 'render', ['ao'], 3); out.ao.push({ prepass: pp, ao: a, sceneMs: scene(row) }); }
  }
  RL.O.render = R0; sh.rtPrepass = true;
  const W0 = sh.W, H0 = sh.H;
  for (const [w, h] of [[960, 540], [1280, 720], [1920, 1080], [2560, 1440], [3840, 2160]]) { sh.W = w; sh.H = h;
    for (const q of ['play', 'render']) { const [row] = await ev.cost([720], q, ['all'], 3); out.res.push({ w, h, q, sceneRT: [sh.sceneRT.width, sh.sceneRT.height], sceneMs: scene(row) }); } }
  sh.W = W0; sh.H = H0; sh.rtPrepass = false; return out; })()
