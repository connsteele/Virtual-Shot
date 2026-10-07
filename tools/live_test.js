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
