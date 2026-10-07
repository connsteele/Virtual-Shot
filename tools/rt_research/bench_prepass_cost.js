(async () => { const ev = await import('/tools/rt_eval.js'), E = VS.E, sh = E.shot, out = {};
  // 1. the pre-pass gives the same picture
  for (const pp of [false, true]) { sh.rtPrepass = pp; out['stills_' + pp] = await ev.run([720, 1000], 'rt_lighting/research/prepass', ['gi', 'all'], { suffix: pp ? '_prepass' : '_noprepass' }); }
  // 2. clean costs, without and with the pre-pass
  for (const pp of [false, true]) { sh.rtPrepass = pp;
    for (const q of ['render', 'play']) out[`cost_${q}_${pp ? 'prepass' : 'noprepass'}`] = await ev.cost([420, 720, 1000], q, q === 'play' ? ['off', 'gi', 'ao', 'refl', 'all'] : ['off', 'gi', 'ao', 'refl', 'all', 'pt']); }
  sh.rtPrepass = false; return out; })()
