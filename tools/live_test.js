// Browser-side test helpers for the engine bridge, loaded into the editor page by tools/headless.mjs:
//   node tools/headless.mjs "/src/editor/index.html?f=720&bg" "(await import('/tools/live_test.js')).measure({ mode: 'interp', delay: 50 })"
// Needs server/bridge.mjs and a sender (tools/sim_game.mjs) running.
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function ready(L, url) {
  if (!L.ws) await L.connect(url);
  for (let i = 0; i < 100 && !Object.keys(L.sources).length; i++) await sleep(50);
  for (let i = 0; i < 100 && !L.buf.latest; i++) await sleep(50);
}
const LOOK_OFF = { haze: false, dof: false, lens: false, glows: false, ghosts: false, pops: false };
/** Live camera for `secs` with the given play-out settings; returns LiveCamera.report(). look: 'full' | 'off'. */
export async function measure({ mode = 'interp', delay = 50, quality = 'play', look = 'full', fps = 60, secs = 6, warm = 1, url } = {}) {
  const E = VS.E, L = VS.live, keep = { ...E.show };
  if (look === 'off') Object.assign(E.show, LOOK_OFF);
  await ready(L, url); Object.assign(L, { mode, delay, quality, fps });
  L.start(); await sleep(warm * 1000); L.resetMetrics(); await sleep(secs * 1000);
  await sleep(300);   // let the last GPU-done callbacks land
  const rep = L.report(); L.metrics = false; L.stop(); Object.assign(E.show, keep);
  return { look, ...rep };
}
/** Record a take of `secs` from frame `from`, then return the take summary and how closely the keys follow the stream. */
export async function record({ from = 300, secs = 4, mode = 'interp', delay = 50, url } = {}) {
  const E = VS.E, L = VS.live; await ready(L, url); Object.assign(L, { mode, delay, fps: 60 });
  E.frame = from; L.start(); await sleep(300); L.startRecord(); await sleep(secs * 1000);
  const take = L.stopRecord(true); L.stop();
  return { take, history: E.cmd.history.slice(-2), markers: (E.doc.events.markers || []).length };
}
/** Draw frame f at Render quality (full look, as renders to disk) with the live pose and save it as a PNG. */
export async function still(name, { f = 720, override = true } = {}) {
  const E = VS.E, L = VS.live; await ready(L);
  E.frame = f; if (override) { const p = L.buf.latest, rig = L.rigOf(p); if (!L.lensWarp) rig.distort = 0; E.over = { rig }; }
  E.renderNow('render', { output: true });
  const c = document.createElement('canvas'); c.width = E.shot.OW; c.height = E.shot.OH; c.getContext('2d').drawImage(document.getElementById('gpu'), 0, 0);
  const b = await new Promise(r => c.toBlob(r, 'image/png')); E.over = null;
  return (await fetch('/save/' + name, { method: 'POST', body: b })).status;
}

/** Record a take from the Blender demo sender (tools/blender_bridge.py --demo) and project the markers through the
 *  written keys, frame by frame, as evaluate() renders them (no live override): the alignment check. */
export async function blenderTake({ markers, from = 300, timeout = 120, url, tolScale = 1 } = {}) {
  const E = VS.E, L = VS.live; if (!L.ws) await L.connect(url); L.tolScale = tolScale;
  const { evaluate } = await import('/src/core/evaluate.js');
  Object.assign(L, { mode: 'interp', delay: 50, fps: 60 }); E.frame = from; L.start(); L.startRecord();
  const t0 = performance.now(); let n = 0, quiet = 0;
  while (performance.now() - t0 < timeout * 1000) { await sleep(250); const k = L.rec ? L.rec.samples.length : 0; if (k && k === n) { if (++quiet >= 6) break; } else quiet = 0; n = k; }
  const take = L.stopRecord(true); L.stop(); if (!take) return { error: 'no take' };
  const proj = {}, raw = {}, px = vp => Object.fromEntries(Object.entries(markers).map(([k, p]) => { const c = [0, 1, 2, 3].map(i => vp[i] * p[0] + vp[4 + i] * p[1] + vp[8 + i] * p[2] + vp[12 + i]);
    return [k, [(c[0] / c[3] * 0.5 + 0.5) * 1920, (1 - (c[1] / c[3] * 0.5 + 0.5)) * 1080]]; }));
  take.samples.forEach((s, i) => { const f = take.from + i;
    proj[f] = px(VS.evaluate(f / E.fps).vp);                                         // through the written keys
    raw[f] = px(evaluate(E.doc, f / E.fps, E.shot.geo, E.ix, { rig: s.rig }).vp); }); // through the unthinned samples
  return { take, proj, raw, source: L.sources.blender || null };
}
/** Save shot frames (after a take) twice: the look off (for overlays) and the full look (as renders to disk). */
export async function stills(list, dir) {
  const E = VS.E, keep = { ...E.show }, out = [];
  const save = async name => { const c = document.createElement('canvas'); c.width = E.shot.OW; c.height = E.shot.OH; c.getContext('2d').drawImage(document.getElementById('gpu'), 0, 0);
    const b = await new Promise(r => c.toBlob(r, 'image/png')); out.push(name + ':' + (await fetch(`/save/${dir}/${name}.png`, { method: 'POST', body: b })).status); };
  for (const f of list) {
    E.frame = f; Object.assign(E.show, LOOK_OFF); E.renderNow('render'); await save(`vs_lookoff_f${f}`);
    if (E.shot.backend === 'WebGPU') await E.shot.renderer.backend.device.queue.onSubmittedWorkDone();
    E.renderNow('render', { output: true }); await save(`vs_full_f${f}`);
    if (E.shot.backend === 'WebGPU') await E.shot.renderer.backend.device.queue.onSubmittedWorkDone();
  }
  Object.assign(E.show, keep); return out;
}
