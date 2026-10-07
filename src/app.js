// Spike app: load the scene document, evaluate it at a frame, render the 3D shot and the 2D chat layer, composite.
// Headless hooks on window.VS for frame export (POST /save/ with retries, like Black Page's BPX).
import { evaluate, indexDoc } from './core/evaluate.js';
import { ChatLayer } from './layers/chat2d.js';
import { ShotRenderer, assetUrl } from './render/shot_renderer.js';

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
  const flat = $('flat'), fctx = flat.getContext('2d');
  const shot = await new ShotRenderer($('gpu'), doc, { forceWebGL: params.has('webgl'), trackTimestamp: params.has('gputime') }).init(tall);
  const chaosOf = st => st.chaos;
  $('info').textContent = `${doc.name} · three r186 · ${shot.backend} · ${doc.objects.length} objects, ${doc.tracks.length} tracks`;
  $('scrub').max = last;

  let state = null;
  /** Render frame f: evaluate, draw the chat layer, render 3D, set the flat overlay. Returns the state. */
  function renderFrame(f) {
    const t = f / fps, st = state = evaluate(doc, t, shot.geo, ix);
    if (st.flat.before) {
      chat.render(fctx, t, chaosOf(st), { geom: 'flat' });
      $('gpu').style.visibility = 'hidden'; flat.style.opacity = 1;
    } else {
      chat.render(tctx, t, chaosOf(st), { geom: 'tall' });
      shot.render(st);
      $('gpu').style.visibility = 'visible';
      if (st.flat.overlay > 0) chat.render(fctx, t, chaosOf(st), { geom: 'flat', chrome: 0 });
      flat.style.opacity = st.flat.overlay;
    }
    $('time').textContent = `f ${f} · ${t.toFixed(3)} s`; $('scrub').value = f;
    const ref = $('ref'); if (ref && !ref.hidden) ref.src = `/bp/blender/export/final_engine/f${String(f).padStart(5, '0')}.png`;
    return st;
  }
  /** The composited frame as a canvas (3D pixels read back, flat layer crossfaded on top), like BP.frame(). */
  const out = document.createElement('canvas'); out.width = 1920; out.height = 1080; const octx = out.getContext('2d', { willReadFrequently: true });
  async function composite() {
    if (state.flat.before) { octx.clearRect(0, 0, 1920, 1080); octx.drawImage(flat, 0, 0); return out; }
    const px = await shot.readPixels(); octx.putImageData(new ImageData(px, 1920, 1080), 0, 0);
    if (state.flat.overlay > 0) { octx.globalAlpha = state.flat.overlay; octx.drawImage(flat, 0, 0); octx.globalAlpha = 1; }
    return out;
  }
  /** Composite straight from the WebGPU canvas, in the same task as the render (no GPU readback, no JS encoding):
   *  the old engine's BP.frame() path, which exported 3x faster than readback + CompressionStream. */
  function compositeFromCanvas() {
    octx.globalAlpha = 1; octx.clearRect(0, 0, 1920, 1080);
    if (state.flat.before) { octx.drawImage(flat, 0, 0); return out; }
    octx.drawImage($('gpu'), 0, 0);
    if (state.flat.overlay > 0) { octx.globalAlpha = state.flat.overlay; octx.drawImage(flat, 0, 0); octx.globalAlpha = 1; }
    return out;
  }
  /** Raw RGBA8 of the composited frame (top row first). */
  async function compositePixels() {
    if (!state.flat.before && !(state.flat.overlay > 0)) return shot.readPixels();
    return (await composite()).getContext('2d').getImageData(0, 0, 1920, 1080).data;
  }
  /** PNG image data for RGBA8 pixels: Sub-filtered rows, zlib-compressed by the browser (the server adds the chunks). */
  async function pngIdat(px, w = 1920, h = 1080) {
    const stride = w * 4, raw = new Uint8Array((stride + 1) * h);
    for (let y = 0; y < h; y++) { const o = y * (stride + 1), r = y * stride; raw[o] = 1;
      raw[o + 1] = px[r]; raw[o + 2] = px[r + 1]; raw[o + 3] = px[r + 2]; raw[o + 4] = px[r + 3];
      for (let i = 4; i < stride; i++) raw[o + 1 + i] = px[r + i] - px[r + i - 4]; }
    return new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer();
  }
  const post = async (name, body, rgba = false) => {
    const url = rgba ? `/save-idat/${name}?w=1920&h=1080` : '/save/' + name;
    for (let i = 0; ; i++) {
      try { const r = await fetch(url, { method: 'POST', body }); if (r.ok) return; throw new Error('HTTP ' + r.status); }
      catch (e) { if (i >= 4) throw e; await new Promise(r => setTimeout(r, 1000 * (i + 1))); }
    }
  };
  let exporting = false;
  async function exportFrames(frames, dir, { via = 'canvas' } = {}) {
    if (exporting) throw new Error('an export is already running'); exporting = true;
    const t0 = performance.now(); let n = 0;
    const inflight = new Set();   // up to 4 uploads in flight; the server encodes PNGs in parallel
    try { for (const f of frames) { renderFrame(f); const name = `${dir}/f${String(f).padStart(5, '0')}.png`;
      const body = via === 'canvas' ? await (await fetch(compositeFromCanvas().toDataURL('image/png'))).blob() : await pngIdat(await compositePixels());
      const p = post(name, body, via !== 'canvas').finally(() => inflight.delete(p)); inflight.add(p);
      if (inflight.size >= 4) await Promise.race(inflight); n++;
      if (n % 20 === 0) $('status').textContent = `exported ${n}/${frames.length}`; } await Promise.all(inflight); } finally { exporting = false; }
    const s = (performance.now() - t0) / 1000; $('status').textContent = `exported ${n} frames in ${s.toFixed(1)} s`;
    return { n, seconds: s };
  }

  // transport
  let playing = false, f0 = 0, tStart = 0, cur = 0;
  const loop = now => { if (!playing) return; cur = Math.min(last, f0 + Math.floor((now - tStart) / 1000 * fps)); renderFrame(cur); if (cur >= last) { playing = false; $('play').textContent = 'Play'; return; } requestAnimationFrame(loop); };
  $('play').onclick = () => { if (playing) { playing = false; $('play').textContent = 'Play'; return; } if (cur >= last) cur = 0; playing = true; f0 = cur; tStart = performance.now(); $('play').textContent = 'Pause'; requestAnimationFrame(loop); };
  $('scrub').oninput = () => { if (exporting) return; cur = +$('scrub').value; renderFrame(cur); };
  if ($('showRef')) $('showRef').onchange = e => { $('ref').hidden = !e.target.checked; renderFrame(cur); };

  window.VS = { doc, shot, chat, evaluate: t => evaluate(doc, t, shot.geo, ix), renderFrame, composite, exportFrames,
    frameDataURL: async () => (await composite()).toDataURL('image/png'), backend: shot.backend };
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
