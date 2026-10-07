// Spike app: load the scene document, evaluate it at a frame, render the 3D shot and the 2D chat layer, composite.
// Headless hooks on window.VS for frame export (POST /save/ with retries, like Black Page's BPX).
import { evaluate, indexDoc } from './core/evaluate.js';
import { ChatLayer } from './layers/chat2d.js';
import { PopsLayer } from './layers/pops2d.js';
import { ShotRenderer, assetUrl, PIXEL_LOOK } from './render/shot_renderer.js';
import { HALO_LOOK } from './render/looks/halo_ce.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const CONFIG = window.VS_CONFIG || {};   // set by the artifact build
const SCENE = params.get('scene') || CONFIG.scene || '/scenes/black_page.scene.json';
// ?bg: rendering in a background tab. three's WebGL2 backend waits for GPU readback by polling with
// requestAnimationFrame, which never fires in a hidden tab, so exports stall; poll with timers instead.
if (params.has('bg')) window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 4);

async function boot() {
  const doc = await (await fetch(SCENE)).json();
  const ix = indexDoc(doc), fps = doc.fps, last = Math.round(doc.cut * fps) - 1;
  const chatDef = doc.layers.find(l => l.type === 'chat2d');
  const face = new FontFace(chatDef.fontFamily, `url(${assetUrl(doc.assets[chatDef.font])})`);
  await face.load(); document.fonts.add(face);
  const chat = new ChatLayer(chatDef.script, { fontFamily: chatDef.fontFamily, glass: ix.glass, cut: doc.cut, fps });
  const tall = document.createElement('canvas'); tall.width = 1920; tall.height = chat.TEX.th;
  const tctx = tall.getContext('2d');
  const flat = document.createElement('canvas'); flat.width = 1920; flat.height = 1080; const fctx = flat.getContext('2d');
  const popsCanvas = document.createElement('canvas'); popsCanvas.width = 1920; popsCanvas.height = 1080; const pctx = popsCanvas.getContext('2d');
  const pops = new PopsLayer(doc.events.pops, { fontFamily: chatDef.fontFamily, cut: doc.cut, fps, altFrames: doc.events.popsAltFrames });
  const shot = await new ShotRenderer($('gpu'), doc, { forceWebGL: params.has('webgl'), trackTimestamp: params.has('gputime') }).init(tall, { flatCanvas: flat, popsCanvas });
  if (params.has('pixels')) shot.setPixelLook(PIXEL_LOOK);   // ?pixels: the chunky-pixel look (480 lines, area-upscaled to 3840x2160)
  if (params.has('halo')) shot.setHaloLook(HALO_LOOK);       // ?halo: the Halo CE look (looks/halo_ce.js)
  const chaosOf = st => st.chaos;
  $('info').textContent = `${doc.name} · three r186 · ${shot.backend} · ${doc.objects.length} objects, ${doc.tracks.length} tracks`;
  $('scrub').max = last;

  let state = null;
  // ?look=engine: the engine picture alone (the first parity target); default: the final look (haze + pops), composited
  // on the GPU the way Black Page's Blender compositor did it.
  const LOOK = params.get('look') || 'final';
  /** Render frame f: evaluate, draw the 2D layers, render 3D + haze, composite to the canvas. Returns the state. */
  function renderFrame(f, quality = 'render') {
    const t = f / fps, st = state = evaluate(doc, t, shot.geo, ix);
    const needFlat = st.flat.before || st.flat.overlay > 0;
    if (needFlat) chat.render(fctx, t, chaosOf(st), st.flat.before ? { geom: 'flat' } : { geom: 'flat', chrome: 0 });
    if (!st.flat.before) chat.render(tctx, t, chaosOf(st), { geom: 'tall' });
    const anyPops = LOOK === 'final' && pops.render(pctx, t);
    shot.render(st, { final: LOOK === 'final', flat: needFlat, pops: anyPops, quality });
    $('time').textContent = `f ${f} · ${t.toFixed(3)} s`; $('scrub').value = f;
    const ref = $('ref'); if (ref && !ref.hidden) ref.src = LOOK === 'final' ? `/bp-final-ref/f${String(f).padStart(5, '0')}.png` : `/bp/blender/export/final_engine/f${String(f).padStart(5, '0')}.png`;
    return st;
  }
  /** The finished frame, copied from the WebGPU canvas in the same task as the render (the old engine's BP.frame()
   *  path: no GPU readback, no JS encoding). */
  const out = document.createElement('canvas'); out.width = shot.OW; out.height = shot.OH; const octx = out.getContext('2d');
  function composite() { octx.clearRect(0, 0, out.width, out.height); octx.drawImage($('gpu'), 0, 0); return out; }
  const post = async (name, body) => {
    for (let i = 0; ; i++) {
      try { const r = await fetch('/save/' + name, { method: 'POST', body }); if (r.ok) return; throw new Error('HTTP ' + r.status); }
      catch (e) { if (i >= 4) throw e; await new Promise(r => setTimeout(r, 1000 * (i + 1))); }
    }
  };
  let exporting = false;
  async function exportFrames(frames, dir, { quality = 'render' } = {}) {
    if (exporting) throw new Error('an export is already running'); exporting = true;
    const t0 = performance.now(); let n = 0;
    const inflight = new Set();   // up to 4 uploads in flight
    try { for (const f of frames) { renderFrame(f, quality); const name = `${dir}/f${String(f).padStart(5, '0')}.png`;
      const body = await (await fetch(composite().toDataURL('image/png'))).blob();
      const p = post(name, body).finally(() => inflight.delete(p)); inflight.add(p);
      if (inflight.size >= 4) await Promise.race(inflight); n++;
      if (n % 20 === 0) $('status').textContent = `exported ${n}/${frames.length}`; } await Promise.all(inflight); } finally { exporting = false; }
    const s = (performance.now() - t0) / 1000; $('status').textContent = `exported ${n} frames in ${s.toFixed(1)} s`;
    return { n, seconds: s };
  }
  /** Haze analysis pass: the mean level of each frame's haze (ungained, at exposure 1), like levels.txt. */
  async function measureHaze(frames, name = 'data/haze_levels_raw.json') {
    const out = {}; const t0 = performance.now();
    for (const f of frames) { const st = renderFrame(f); if (st.haze && st.haze.gain > 0) out[f] = await shot.hazeLevel(st);
      if (f % 50 === 0) $('status').textContent = `measured ${f}`; }
    await post(name, JSON.stringify(out));
    $('status').textContent = `measured ${frames.length} frames in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
    return out;
  }

  // transport
  let playing = false, f0 = 0, tStart = 0, cur = 0;
  // playback and scrubbing draw Play quality; a still frame is redrawn at Render quality
  const loop = now => { if (!playing) return; cur = Math.min(last, f0 + Math.floor((now - tStart) / 1000 * fps)); renderFrame(cur, 'play'); if (cur >= last) { playing = false; $('play').textContent = 'Play'; renderFrame(cur); return; } requestAnimationFrame(loop); };
  $('play').onclick = () => { if (playing) { playing = false; $('play').textContent = 'Play'; renderFrame(cur); return; } if (cur >= last) cur = 0; playing = true; f0 = cur; tStart = performance.now(); $('play').textContent = 'Pause'; requestAnimationFrame(loop); };
  $('scrub').oninput = () => { if (exporting) return; cur = +$('scrub').value; renderFrame(cur, 'play'); };
  $('scrub').onchange = () => { if (exporting) return; cur = +$('scrub').value; renderFrame(cur); };
  if ($('showRef')) $('showRef').onchange = e => { $('ref').hidden = !e.target.checked; renderFrame(cur); };

  window.VS = { doc, shot, chat, pops, evaluate: t => evaluate(doc, t, shot.geo, ix), renderFrame, composite, exportFrames, measureHaze,
    frameDataURL: () => composite().toDataURL('image/png'), backend: shot.backend, look: LOOK };
  cur = +(params.get('f') || 300); renderFrame(cur);
  window.VS_READY = true;
  if ($('diag')) diagnostics(shot).then(d => { window.VS_DIAG = d;
    $('diag').innerHTML = Object.entries(d).map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join(''); });
}

/** Try to open a folder picker (needs a click): reports whether this context may write frames to disk. */
async function tryFolder() {
  const out = $('folderResult');
  try { const h = await window.showDirectoryPicker({ mode: 'readwrite' }); out.textContent = `Allowed: picked "${h.name}"`; }
  catch (e) { out.textContent = `${e.name}: ${e.message}`; }
}
if ($('tryFolder')) $('tryFolder').onclick = tryFolder;

/** What this browser context allows: answers the architecture doc's open checks (WebGPU, gamepads, disk access). */
async function diagnostics(shot) {
  const d = {};
  d['Renderer backend'] = shot.backend;
  try { const a = navigator.gpu && await navigator.gpu.requestAdapter(); d['WebGPU adapter'] = a ? `${a.info?.vendor || '?'} ${a.info?.architecture || ''}`.trim() : 'none'; } catch (e) { d['WebGPU adapter'] = 'error: ' + e.message; }
  try { const pads = navigator.getGamepads ? navigator.getGamepads() : null; d['Gamepad API'] = pads ? `allowed (${[...pads].filter(Boolean).length} connected)` : 'missing'; } catch (e) { d['Gamepad API'] = 'blocked: ' + e.name; }
  const fp = document.featurePolicy || document.permissionsPolicy;
  if (fp && fp.allowsFeature) d['Gamepad policy'] = fp.allowsFeature('gamepad') ? 'allowed' : 'blocked';
  d['File System Access'] = 'showDirectoryPicker' in window ? 'present (use the button to try it)' : 'missing';
  d['In a frame'] = window.self !== window.top ? 'yes' : 'no';
  d['WebCodecs encoder'] = 'VideoEncoder' in window ? 'available' : 'missing';
  return d;
}
boot().catch(e => { console.error(e); $('info').textContent = 'Failed: ' + e.message; window.VS_ERROR = String(e.stack || e); });
