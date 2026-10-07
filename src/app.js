// Spike app: load the scene document, evaluate it at a frame, render the 3D shot and the 2D chat layer, composite.
// Headless hooks on window.VS for frame export (POST /save/ with retries, like Black Page's BPX).
import { evaluate, indexDoc } from './core/evaluate.js';
import { ChatLayer } from './layers/chat2d.js';
import { ShotRenderer, assetUrl } from './render/shot_renderer.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SCENE = params.get('scene') || '/scenes/black_page.scene.json';

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
  const shot = await new ShotRenderer($('gpu'), doc, { forceWebGL: params.has('webgl') }).init(tall);
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
    const ref = $('ref'); if (!ref.hidden) ref.src = `/bp/blender/export/final_engine/f${String(f).padStart(5, '0')}.png`;
    return st;
  }
  /** The composited frame as a canvas (3D pixels read back, flat layer crossfaded on top), like BP.frame(). */
  async function composite() {
    const o = document.createElement('canvas'); o.width = 1920; o.height = 1080; const x = o.getContext('2d');
    if (state.flat.before) { x.drawImage(flat, 0, 0); return o; }
    const px = await shot.readPixels(); x.putImageData(new ImageData(px, 1920, 1080), 0, 0);
    if (state.flat.overlay > 0) { x.globalAlpha = state.flat.overlay; x.drawImage(flat, 0, 0); x.globalAlpha = 1; }
    return o;
  }
  const post = async (name, body) => {
    for (let i = 0; ; i++) {
      try { const r = await fetch('/save/' + name, { method: 'POST', body }); if (r.ok) return; throw new Error('HTTP ' + r.status); }
      catch (e) { if (i >= 4) throw e; await new Promise(r => setTimeout(r, 1000 * (i + 1))); }
    }
  };
  const png = c => new Promise(r => c.toBlob(r, 'image/png'));
  async function exportFrames(frames, dir) {
    const t0 = performance.now(); let n = 0;
    for (const f of frames) { renderFrame(f); await post(`${dir}/f${String(f).padStart(5, '0')}.png`, await png(await composite())); n++;
      if (n % 20 === 0) $('status').textContent = `exported ${n}/${frames.length}`; }
    const s = (performance.now() - t0) / 1000; $('status').textContent = `exported ${n} frames in ${s.toFixed(1)} s`;
    return { n, seconds: s };
  }

  // transport
  let playing = false, f0 = 0, tStart = 0, cur = 0;
  const loop = now => { if (!playing) return; cur = Math.min(last, f0 + Math.floor((now - tStart) / 1000 * fps)); renderFrame(cur); if (cur >= last) { playing = false; $('play').textContent = 'Play'; return; } requestAnimationFrame(loop); };
  $('play').onclick = () => { if (playing) { playing = false; $('play').textContent = 'Play'; return; } if (cur >= last) cur = 0; playing = true; f0 = cur; tStart = performance.now(); $('play').textContent = 'Pause'; requestAnimationFrame(loop); };
  $('scrub').oninput = () => { cur = +$('scrub').value; renderFrame(cur); };
  $('showRef').onchange = e => { $('ref').hidden = !e.target.checked; renderFrame(cur); };

  window.VS = { doc, shot, chat, evaluate: t => evaluate(doc, t, shot.geo, ix), renderFrame, composite, exportFrames,
    frameDataURL: async () => (await composite()).toDataURL('image/png'), backend: shot.backend };
  cur = +(params.get('f') || 300); renderFrame(cur);
  window.VS_READY = true;
}
boot().catch(e => { console.error(e); $('info').textContent = 'Failed: ' + e.message; window.VS_ERROR = String(e.stack || e); });
