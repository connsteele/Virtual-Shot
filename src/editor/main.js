// Virtual Shot editor (spike): boots the scene document, the time core and the renderer, and wires the panels.
// All edits go through the command stack (src/core/commands.js); every panel redraws from the document + the frame.
import { evaluate, indexDoc } from '../core/evaluate.js';
import { createCommandStack } from '../core/commands.js';
import { ChatLayer } from '../layers/chat2d.js';
import { PopsLayer } from '../layers/pops2d.js';
import { ShotRenderer, assetUrl, SHOW } from '../render/shot_renderer.js';
import { Outliner } from './outliner.js';
import { Inspector } from './inspector.js';
import { Viewport } from './viewport.js';
import { Timeline } from './timeline.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const CONFIG = window.VS_CONFIG || {};
const SCENE = params.get('scene') || CONFIG.scene || '/scenes/black_page.scene.json';
if (params.has('bg')) window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 4);

/** Editor state shared by the panels, with a tiny event bus. */
const E = {
  doc: null, ix: null, fps: 60, frame: 300, last: 1175, mode: 'edit', view: 'camera', playing: false,
  sel: { kind: 'object', id: 'cam' }, selKeys: [], quality: 'render', canSave: !CONFIG.scene,
  _h: {}, on(ev, fn) { (this._h[ev] ||= []).push(fn); }, emit(ev, a) { for (const fn of this._h[ev] || []) fn(a); },
  timecode(f) { const fps = this.fps, ff = f % fps, s = Math.floor(f / fps), p = n => String(n).padStart(2, '0');
    return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(ff)}`; },
};
window.VS_EDITOR = E;

async function boot() {
  const doc = E.doc = await (await fetch(SCENE)).json();
  E.ix = indexDoc(doc); E.fps = doc.fps; E.last = Math.round(doc.cut * doc.fps) - 1; E.frame = +(params.get('f') ?? 300);
  $('docName').textContent = doc.name;
  const chatDef = doc.layers.find(l => l.type === 'chat2d');
  const face = new FontFace(chatDef.fontFamily, `url(${assetUrl(doc.assets[chatDef.font])})`); await face.load(); document.fonts.add(face);
  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const layers = () => {
    E.chat = new ChatLayer(chatDef.script, { fontFamily: chatDef.fontFamily, glass: E.ix.glass, cut: doc.cut, fps: E.fps });
    E.pops = new PopsLayer(doc.events.pops, { fontFamily: chatDef.fontFamily, cut: doc.cut, fps: E.fps, altFrames: doc.events.popsAltFrames });
  };
  layers();
  const tall = mk(1920, E.chat.TEX.th), flat = mk(1920, 1080), popsC = mk(1920, 1080);
  const tctx = tall.getContext('2d'), fctx = flat.getContext('2d'), pctx = popsC.getContext('2d');
  const shot = E.shot = await new ShotRenderer($('gpu'), doc, { forceWebGL: params.has('webgl') }).init(tall, { flatCanvas: flat, popsCanvas: popsC });

  // ---- commands: every change re-indexes the document, syncs the renderer and redraws
  E.cmd = createCommandStack(() => E.doc, (name) => {
    E.ix = indexDoc(E.doc); shot.syncFromDoc(E.doc);
    if (/undo|redo|deleteKeys/.test(name)) E.selKeys = [];
    if (/Event|undo|redo|setLook/.test(name)) layers();
    E.emit('change', name); E.requestRender();
  });
  E.on('eventsMoved', () => layers());   // a dragged message re-lays out the chat live
  window.VS = { E, cmd: (n, a) => E.cmd.run(n, a), commands: () => E.cmd.list(), evaluate: t => evaluate(E.doc, t, shot.geo, E.ix) };

  // ---- viewport visibility (Blender's eye toggles and overlays, Unreal's Show menu): editor-only, kept in this browser
  E.show = { ...SHOW, safe: true, grid: true, frustum: true, hazeBox: true, lights: true, bounds: true };
  E.hidden = new Set(); E.refineMode = 'idle';
  const viewKey = 'vs-editor-view:' + doc.name;
  try { const v = JSON.parse(localStorage.getItem(viewKey) || 'null');
    if (v) { Object.assign(E.show, v.show); E.hidden = new Set(v.hidden || []); E.refineMode = v.refine || 'idle'; } } catch { /* storage may be blocked */ }
  const keepView = () => { try { localStorage.setItem(viewKey, JSON.stringify({ show: E.show, hidden: [...E.hidden], refine: E.refineMode })); } catch { /* storage may be blocked */ } };
  E.setShow = (k, on) => { E.show[k] = on; keepView(); E.emit('show'); E.requestRender(); };
  E.setHidden = (id, hide) => { hide ? E.hidden.add(id) : E.hidden.delete(id); keepView(); E.emit('show'); E.requestRender(); };
  E.revealAll = () => { E.hidden.clear(); keepView(); E.emit('show'); E.requestRender(); };
  E.setRefine = m => { E.refineMode = m; keepView(); E.emit('show'); E.requestRender(); };

  // ---- rendering: every change draws at Play quality straight away (~15 ms); once things stop, the camera view
  // refines to Render quality in 16 slices (15–25 ms each), and any new change drops the refine. Renders to disk use the
  // full look whatever the viewport shows.
  const viewport = new Viewport(E);
  let pending = false, idleTimer = null, refineJob = null;
  E.state = () => evaluate(E.doc, E.frame / E.fps, shot.geo, E.ix);
  const hud = text => { $('hudQuality').textContent = E.view === 'camera' ? text : ''; };
  const layerOpts = st => {
    const t = st.t, needFlat = st.flat.before || st.flat.overlay > 0;
    if (needFlat) chat.render(fctx, t, st.chaos, st.flat.before ? { geom: 'flat' } : { geom: 'flat', chrome: 0 });
    if (!st.flat.before) chat.render(tctx, t, st.chaos, { geom: 'tall' });
    return { final: true, flat: needFlat, pops: E.pops.render(pctx, t) };
  };
  E.renderNow = (quality = 'play', { output = false } = {}) => {
    refineJob = null; clearTimeout(idleTimer);
    const st = E.st = E.state(), t = st.t;
    shot.setHidden(output ? new Set() : E.hidden);
    if (E.view === 'free' && !output) {
      chat.render(tctx, t, st.chaos, { geom: 'tall' });
      shot.renderFree(st, viewport.freeCam, viewport.helpers(), E.show);
    } else {
      E.layerOpts = layerOpts(st);
      shot.render(st, { ...E.layerOpts, quality, show: output ? undefined : E.show });
    }
    E.quality = quality; viewport.overlay(st);
    $('timecode').textContent = E.timecode(E.frame); $('frameNo').textContent = `f ${E.frame} · ${t.toFixed(3)} s`;
    hud(quality === 'play' ? 'Play quality' : 'Render quality');
    E.emit('frame', st);
  };
  const chat = { render: (...a) => E.chat.render(...a) };
  // one slice per step, each after the GPU has finished the last, so an edit never waits behind a queue of slices.
  // Chrome can be slow to report finished work while no frames are drawn, so the wait is capped (a slice is ~15–25 ms).
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const gpuIdle = () => Promise.race([shot.backend === 'WebGPU' ? shot.renderer.backend.device.queue.onSubmittedWorkDone() : sleep(25), sleep(40)]);
  const refine = async () => {
    if (E.view !== 'camera' || E.playing || E.interacting || E.refineMode !== 'idle' || !E.st) return;
    const SLICES = 16, job = refineJob = shot.renderSteps(E.st, { ...E.layerOpts, quality: 'render', slices: SLICES, show: E.show });
    for (let i = 1; ; i++) {
      if (refineJob !== job) return;
      if (job.next().done) break;
      hud(`Refining ${Math.round(i / (SLICES + 1) * 100)}%`);
      await Promise.all([gpuIdle(), new Promise(r => requestAnimationFrame(r))]);
    }
    refineJob = null; E.quality = 'render'; hud('Render quality');
  };
  E.requestRender = () => {
    refineJob = null; clearTimeout(idleTimer);
    if (pending) return; pending = true;
    requestAnimationFrame(() => { pending = false; E.renderNow('play');
      if (!E.playing && !E.interacting) idleTimer = setTimeout(refine, 250); });
  };
  E.setFrame = f => { E.frame = Math.max(0, Math.min(E.last, Math.round(f))); E.requestRender(); };
  E.select = sel => { E.sel = sel; E.emit('select', sel); E.requestRender(); };

  // ---- panels
  E.panels = { outliner: new Outliner(E, $('outlinerBody')), inspector: new Inspector(E, $('inspectorBody'), $('inspectorTitle')),
    timeline: new Timeline(E, $('tlCanvas'), $('tlLabels')), viewport };

  // ---- transport and playback (real time, Play quality; drops frames to keep time like an NLE)
  let t0 = 0, f0 = 0;
  const loop = now => { if (!E.playing) return; const f = f0 + Math.floor((now - t0) / 1000 * E.fps);
    if (f > E.last) { E.playing = false; $('playBtn').textContent = 'Play'; E.frame = E.last; E.requestRender(); return; }
    E.frame = f; E.renderNow('play'); requestAnimationFrame(loop); };
  E.togglePlay = () => { if (E.playing) { E.playing = false; $('playBtn').textContent = 'Play'; E.requestRender(); return; }
    if (E.frame >= E.last) E.frame = 0; E.playing = true; t0 = performance.now(); f0 = E.frame; $('playBtn').textContent = 'Pause'; requestAnimationFrame(loop); };
  const keyTimes = () => [...new Set(E.doc.tracks.flatMap(tr => tr.keys.map(k => Math.round(k.t * E.fps))))].sort((a, b) => a - b);
  const transport = { start: () => E.setFrame(0), end: () => E.setFrame(E.last), prev: () => E.setFrame(E.frame - 1), next: () => E.setFrame(E.frame + 1),
    play: () => E.togglePlay(), prevkey: () => { const k = keyTimes().filter(f => f < E.frame).pop(); if (k !== undefined) E.setFrame(k); },
    nextkey: () => { const k = keyTimes().find(f => f > E.frame); if (k !== undefined) E.setFrame(k); } };
  document.querySelectorAll('[data-t]').forEach(b => b.onclick = () => transport[b.dataset.t]());

  // ---- modes, views, undo, save
  const setMode = m => { E.mode = m; $('app').className = 'mode-' + m;
    document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mode === m)));
    if (m === 'play') { setView('camera'); } E.emit('mode', m); requestAnimationFrame(() => { E.emit('resize'); E.requestRender(); }); };
  const setView = v => { E.view = v; document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
    $('hudView').textContent = v === 'camera' ? 'Shot camera' : 'Free view (lit for editing)'; viewport.setView(v); E.emit('view', v); E.requestRender(); };
  E.setView = setView; E.setMode = setMode;
  document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));
  document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => setView(b.dataset.view));
  $('undo').onclick = () => E.cmd.undo(); $('redo').onclick = () => E.cmd.redo();
  E.save = async () => {
    const body = JSON.stringify(E.doc, null, 1);
    if (E.canSave) {
      const name = SCENE.split('/').pop(); const r = await fetch('/save-scene/' + name, { method: 'POST', body });
      E.status(r.ok ? `Saved scenes/${name}` : `Save failed: HTTP ${r.status}`);
    } else {
      try { localStorage.setItem('vs-scene-draft', body); } catch { /* storage may be blocked */ }
      try { await navigator.clipboard.writeText(body); E.status('Copied the scene JSON (artifacts can\'t write files)'); } catch { E.status('Saved a draft in this browser'); }
    }
  };
  $('save').onclick = () => E.save();
  // ---- Render mode: frames to disk through the dev server (local copy only), from the shot camera at Render quality
  E.on('renderFrames', async ({ from, to, dir }) => {
    if (E.rendering) return; E.rendering = true; const was = E.view; if (was !== 'camera') setView('camera');
    const out = document.createElement('canvas'); out.width = 1920; out.height = 1080; const ox = out.getContext('2d');
    const bar = () => document.getElementById('rBar'), msg = t => { const m = document.getElementById('rMsg'); if (m) m.textContent = t; };
    const t0 = performance.now(), n = to - from + 1; let done = 0; const inflight = new Set();
    try {
      for (let f = from; f <= to; f++) {
        E.frame = f; E.renderNow('render', { output: true }); ox.drawImage($('gpu'), 0, 0);
        const blob = await (await fetch(out.toDataURL('image/png'))).blob(), name = `${dir}/f${String(f).padStart(5, '0')}.png`;
        const p = (async () => { for (let i = 0; ; i++) { try { const r = await fetch('/save/' + name, { method: 'POST', body: blob }); if (r.ok) return; throw new Error('HTTP ' + r.status); }
          catch (e) { if (i >= 4) throw e; await new Promise(r => setTimeout(r, 1000 * (i + 1))); } } })().finally(() => inflight.delete(p));
        inflight.add(p); if (inflight.size >= 4) await Promise.race(inflight);
        done++; if (bar()) bar().style.width = `${done / n * 100}%`; if (done % 10 === 0) msg(`${done} of ${n} frames`);
      }
      await Promise.all(inflight);
      msg(`Rendered ${n} frames in ${((performance.now() - t0) / 1000).toFixed(1)} s to ${dir}`);
    } catch (e) { msg('Render failed: ' + e.message); }
    finally { E.rendering = false; if (was !== 'camera') setView(was); else E.requestRender(); }
  });
  E.status = msg => { $('status').textContent = msg; clearTimeout(E._st); E._st = setTimeout(() => { $('status').textContent = ''; }, 4000); };

  // ---- keyboard (Blender-like where it applies: G/R/S gizmo modes, Numpad 0 camera view; Resolve/AE for transport)
  window.addEventListener('keydown', e => {
    if (e.target.matches('input, textarea, select')) return;
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (mod && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? E.cmd.redo() : E.cmd.undo(); return; }
    if (mod && k.toLowerCase() === 'y') { e.preventDefault(); E.cmd.redo(); return; }
    if (mod && k.toLowerCase() === 's') { e.preventDefault(); E.save(); return; }
    if (k === ' ') { e.preventDefault(); E.togglePlay(); return; }
    if (k === 'ArrowLeft') { e.preventDefault(); E.setFrame(E.frame - (e.shiftKey ? 10 : 1)); return; }
    if (k === 'ArrowRight') { e.preventDefault(); E.setFrame(E.frame + (e.shiftKey ? 10 : 1)); return; }
    if (k === 'Home') { E.setFrame(0); return; } if (k === 'End') { E.setFrame(E.last); return; }
    if (k === 'j' || k === 'J') { transport.prevkey(); return; } if (k === 'k' || k === 'K') { transport.nextkey(); return; }
    if (k === '0' && e.location === 3) { setView(E.view === 'camera' ? 'free' : 'camera'); return; }
    E.emit('key', e);
  });
  window.addEventListener('resize', () => E.emit('resize'));
  E.emit('change', 'boot'); E.emit('select', E.sel); E.emit('show'); E.renderNow('render'); E.quality = 'render';
  window.VS_READY = true;
}
boot().catch(e => { console.error(e); $('status').textContent = 'Failed: ' + e.message; window.VS_ERROR = String(e.stack || e); });
