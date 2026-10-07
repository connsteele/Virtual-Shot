// Live camera (the architecture sketch's "game link"): the editor joins the engine bridge (server/bridge.mjs) as a
// receiver, and while Live is on the shot camera follows the stream: each drawn frame takes the stream's pose for that
// moment (latest sample, interpolated behind a fixed delay, or extrapolated), turns it into rig values (poseToRig) and
// passes them to evaluate() as an override (E.over), exactly like a gamepad take. Nothing in the document changes.
// Record turns the stream into keys: the raw samples are kept with their sender times, and on Stop they are resampled
// once per shot frame and written through the named command writeCameraTake (thinned to Bézier keys, one undo), so
// evaluate() stays a pure function of t. Off by default: nothing connects until Connect is pressed.
import { SampleBuffer, applyAlign, alignTo, camForward, camUp, qLook } from '../bridge/protocol.js';
import { poseToRig } from '../core/evaluate.js';
import { TAKE_TOL } from '../core/commands.js';
import { simPath } from '../bridge/sim_path.js';

const epoch = (t = performance.now()) => performance.timeOrigin + t;
const PROPS = ['x', 'y', 'dist', 'yaw', 'pitch', 'roll', 'fov'];
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const stat = a => a.length ? { n: a.length, mean: +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(2), p50: +pct(a, 0.5).toFixed(2), p95: +pct(a, 0.95).toFixed(2), max: +Math.max(...a).toFixed(2) } : null;
const sd = a => { if (a.length < 2) return 0; const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };

export class LiveCamera {
  constructor(E) {
    this.E = E; this.ws = null; this.state = 'off'; this.on = false; this.buf = new SampleBuffer();
    // settings (kept in this browser with the view settings, never in the scene)
    this.url = 'ws://127.0.0.1:8799/'; this.mode = 'interp'; this.delay = 50; this.fps = 0; this.quality = 'play'; this.lensWarp = false;
    this.align = null; this.sources = {}; this.events = []; this.rec = null; this.lastTake = null; this.prevRig = null;
    this.arr = []; this.frames = []; this.metrics = false; this.recent = []; this.tolScale = 1;
  }
  /** Join the bridge as a receiver. */
  connect(url = this.url) {
    this.disconnect(); this.url = url; this.state = 'connecting'; this.emit();
    const ws = this.ws = new WebSocket(url);
    ws.onopen = () => { this.state = 'connected'; ws.send(JSON.stringify({ type: 'hello', v: 1, role: 'sink', name: 'virtual-shot-editor', app: 'Virtual Shot', conventions: 'gltf', subscribe: ['cam', 'event', 'hello', 'bye'] })); this.emit(); };
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; this.state = 'off'; this.emit(); } };
    ws.onerror = () => { this.state = 'error'; this.emit(); };
    ws.onmessage = e => this.onMessage(JSON.parse(e.data), epoch());
    return new Promise(r => { ws.addEventListener('open', () => r(true)); ws.addEventListener('error', () => r(false)); });
  }
  disconnect() { if (this.ws) { const w = this.ws; this.ws = null; w.close(); } this.state = 'off'; this.emit(); }
  onMessage(m, rx) {
    if (m.type === 'hello') { this.sources[m.src] = { ...m, at: rx }; this.emit(); return; }
    if (m.type === 'bye') { delete this.sources[m.src]; if (this.follow === m.src) { this.follow = null; this.buf = new SampleBuffer(); this.prevRig = null; } this.emit(); return; }
    if (m.type === 'event') { this.events.push({ ...m, at: rx }); if (this.events.length > 50) this.events.shift(); if (this.rec) this.rec.events.push(m); this.E.emit('liveEvent', m); return; }
    if (m.type !== 'cam') return;
    // one camera at a time: the first source that sends one, until it leaves or another is chosen (follow)
    if (!this.follow || !this.sources[this.follow]) this.follow = m.src;
    if (m.src !== this.follow) return;
    this.lastRaw = m; const s = applyAlign(m, this.align);
    if (!this.buf.push(s, rx)) return;
    if (this.metrics) this.arr.push({ ts: m.ts, f: m.f, rx, brx: m.rx });
    if (this.rec) this.rec.samples.push(s);
    this.recent.push(rx - m.ts); if (this.recent.length > 120) this.recent.shift();
  }
  /** Rig values for a canonical scene pose. */
  rigOf(pose) {
    const E = this.E, rig = poseToRig(E.ix, E.ix.obj.cam, { eye: pose.p, f: camForward(pose.q), up: camUp(pose.q), fov: pose.fov ?? E.state().rig.fov }, this.prevRig);
    this.prevRig = rig; return rig;
  }
  /** Live on: the shot camera follows the stream until stop(). */
  start() {
    const E = this.E; if (this.on) return; if (E.playing) E.togglePlay();
    E.setView?.('camera'); this.on = true; E.interacting = true; this.prevRig = null; this.lastDrawn = null; this.nextAt = 0;
    E.perf?.note('live on'); this.emit();
    const tick = now => { if (!this.on) return; this.tick(now); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
  stop() {
    const E = this.E; if (!this.on) return; if (this.rec) this.stopRecord(true);
    this.on = false; E.over = null; E.interacting = false; E.perf?.note('live off'); this.emit(); E.requestRender();
  }
  /** One display frame: pick the pose for this moment and draw it (only when it changed). */
  tick(now) {
    const E = this.E;
    if (this.fps) { const iv = 1000 / this.fps; if (now + 1 < this.nextAt) return; const vs = this.nextAt && now - this.nextAt < iv ? this.nextAt : now; this.nextAt = vs + iv; now = vs; }
    const disp = epoch(now), pose = this.buf.pose(disp, this.mode, this.delay); if (!pose) return;
    if (this.rec) { if (this.rec.ts0 == null) this.rec.ts0 = pose.ts;
      const f = this.rec.f0 + Math.round((pose.ts - this.rec.ts0) / 1000 * E.fps); if (f > E.last) { this.stopRecord(true); return; } E.frame = Math.max(this.rec.f0, f); }
    const key = pose.ts + '|' + E.frame; if (key === this.lastDrawn) return; this.lastDrawn = key;
    const rig = this.rigOf(pose); if (!this.lensWarp) rig.distort = 0;
    E.over = { rig };
    const t0 = performance.now(); E.renderNow(this.quality); const cpu = performance.now() - t0;
    if (this.metrics) {
      const rec = { disp, sub: epoch(), cpu, c: pose.ts, latest: this.buf.latest.ts, off: this.buf.offset, held: pose.held || 0, ahead: pose.ahead || 0, p: pose.p, q: pose.q, done: null };
      this.frames.push(rec);
      if (E.shot.backend === 'WebGPU') E.shot.renderer.backend.device.queue.onSubmittedWorkDone().then(() => { rec.done = epoch(); });
    }
  }
  /** Set the alignment so the stream's current pose sits exactly where the shot camera is now (yaw + offset). */
  alignToShot() {
    const E = this.E, src = this.lastRaw; if (!src) return null;
    const c = E.docState().camera, f = c.target.map((v, i) => v - c.eye[i]);   // the keyed camera, without the live override
    this.align = alignTo(src, { p: c.eye, q: qLook(f, c.up) }); this.buf = new SampleBuffer(); this.prevRig = null; this.emit(); return this.align;
  }
  resetAlign() { this.align = null; this.buf = new SampleBuffer(); this.prevRig = null; this.emit(); }

  // ---- record: stream -> keys
  startRecord() {
    const E = this.E; if (!this.on) this.start(); if (this.rec) return;
    if (E.frame >= E.last) E.frame = 0;
    this.rec = { f0: E.frame, ts0: null, samples: [], events: [], align: this.align }; E.perf?.note('live record'); this.emit();
  }
  /** Stop recording; keep = resample the raw stream at the shot's frame rate and write keys (one undoable command). */
  stopRecord(keep = true) {
    const E = this.E, R = this.rec; if (!R) return null; this.rec = null; this.emit();
    if (!keep || R.ts0 == null || R.samples.length < 2) { E.status('Live take cancelled'); return null; }
    // A fixed-step source (its hello says timebase 'fixed' and its fps: an emulator, Blender, a game with a fixed tick)
    // is placed by its frame numbers, so a hitch in its sending can't stretch or squeeze the take; otherwise by sender time.
    const src = this.sources[R.samples[0].src], fixed = src && src.timebase === 'fixed' && src.fps > 0 && R.samples.every(s => s.f != null);
    const S = fixed ? R.samples.map(s => ({ ...s, ts: R.samples[0].ts + (s.f - R.samples[0].f) * 1000 / src.fps })) : R.samples;
    if (fixed) R.ts0 = S[0].ts;
    const b = new SampleBuffer({ keepMs: Infinity }); for (const s of S) b.push(s, 0);
    const tEnd = S[S.length - 1].ts, fEnd = Math.min(E.last, R.f0 + Math.floor((tEnd - R.ts0) / 1000 * E.fps + 1e-3));   // epoch-ms times lose ~1e-4 ms to rounding
    const samples = []; let prev = null;
    for (let f = R.f0; f <= fEnd; f++) {
      const p = b.at(R.ts0 + (f - R.f0) * 1000 / E.fps);
      const rig = poseToRig(E.ix, E.ix.obj.cam, { eye: p.p, f: camForward(p.q), up: camUp(p.q), fov: p.fov }, prev); prev = rig;
      const keep = Object.fromEntries(PROPS.map(k => [k, rig[k]])); if (!this.lensWarp) keep.distort = 0;   // a game's straight lens
      samples.push({ t: f / E.fps, rig: keep });
    }
    const markers = R.events.map(ev => ({ t: (R.f0 + (ev.ts - R.ts0) / 1000 * E.fps) / E.fps, name: ev.name, data: ev.data })).filter(m => m.t >= R.f0 / E.fps && m.t <= fEnd / E.fps);
    const args = { samples, markers, always: this.lensWarp ? [] : ['distort'], ...(this.tolScale !== 1 ? { tol: Object.fromEntries(Object.entries(TAKE_TOL).map(([k, v]) => [k, v * this.tolScale])) } : {}) }; E.cmd.run('writeCameraTake', args);
    this.lastTake = { clock: fixed ? `source frames at ${src.fps} fps` : 'sender time', frames: samples.length, from: R.f0, to: fEnd, streamSamples: S.length, srcFrames: [S[0].f, S[S.length - 1].f], keys: Object.values(args.summary).reduce((s, x) => s + x.keys, 0), summary: args.summary, markers: markers.length };
    Object.defineProperty(this.lastTake, 'samples', { value: samples, enumerable: false });   // the unthinned rig per frame (for checks)
    E.status(`Live take: ${S.length} samples → ${samples.length} frames → ${this.lastTake.keys} keys`); this.emit();
    return this.lastTake;
  }

  // ---- the reverse direction: publish the shot camera (every drawn frame) to the bridge, for Blender or Unreal
  setPublish(on) {
    this.publish = !!on;
    if (on && !this._pub) { this._pub = true; this.E.on('frame', st => {
      if (!this.publish || !this.ws || this.ws.readyState !== 1) return; const c = st.camera, f = c.target.map((v, i) => v - c.eye[i]);
      this.ws.send(JSON.stringify({ type: 'cam', id: 'shot', f: this.E.frame, t: st.t, ts: epoch(), p: c.eye, q: qLook(f, c.up), fov: c.fov, aspect: this.E.doc.output.width / this.E.doc.output.height }));
    }); }
    this.emit();
  }

  // ---- measurement (tests and the Stats panel): arrival and per-frame records, then a report
  resetMetrics() { this.arr = []; this.frames = []; this.metrics = true; }
  report() {
    const A = this.arr, F = this.frames.filter(f => f.done != null || this.E.shot.backend !== 'WebGPU');
    const iv = A.slice(1).map((a, i) => a.rx - A[i].rx), siv = A.slice(1).map((a, i) => a.ts - A[i].ts);
    const off = this.buf.offset, out = {
      samples: A.length, sender: { interval: stat(siv), sd: +sd(siv).toFixed(2) }, arrival: { interval: stat(iv), sd: +sd(iv).toFixed(2) },
      transport: { senderToBridge: stat(A.map(a => a.brx - a.ts)), bridgeToEditor: stat(A.map(a => a.rx - a.brx)), total: stat(A.map(a => a.rx - a.ts)) },
      droppedBySender: this.buf.dropped, frames: F.length, mode: this.mode, delay: this.delay, quality: this.quality,
    };
    if (F.length > 2) {
      const di = F.slice(1).map((f, i) => f.disp - F[i].disp);
      // latency: how old the drawn pose is when its frame is submitted, and when the GPU has finished it
      out.latency = { poseAgeAtSubmit: stat(F.map(f => f.sub - (f.c + off))), poseAgeAtGpuDone: stat(F.filter(f => f.done).map(f => f.done - (f.c + off))),
        newestSampleAgeAtGpuDone: stat(F.filter(f => f.done).map(f => f.done - (f.latest + off))), gpuDoneAfterSubmit: stat(F.filter(f => f.done).map(f => f.done - f.sub)), cpu: stat(F.map(f => f.cpu)) };
      out.display = { interval: stat(di), sd: +sd(di).toFixed(2) };
      // judder: the drawn pose's time should advance with the display; its deviation from a straight line, in ms
      const lag = F.map(f => f.disp - off - f.c), mLag = lag.reduce((s, v) => s + v, 0) / lag.length;
      out.judder = { lagMean: +mLag.toFixed(2), lagSd: +sd(lag).toFixed(2), lagMaxDev: +Math.max(...lag.map(v => Math.abs(v - mLag))).toFixed(2),
        repeats: F.slice(1).filter((f, i) => f.c === F[i].c).length, held: F.filter(f => f.held > 0).length, extrapolated: F.filter(f => f.ahead > 0).length };
      // pose error against the simulated game's exact path (only for sim-game): at the drawn pose's own time
      // (reconstruction) and against a smooth path delayed by the mean lag (what an eye sees as judder), mm and degrees
      const sim = Object.values(this.sources).find(s => s.src === 'sim-game')?.sim;
      if (sim && !this.align) {
        const err = (f, t) => { const g = simPath((t - sim.t0) / 1000), fa = camForward(f.q), fb = camForward(g.q);
          return [Math.hypot(...f.p.map((v, i) => v - g.p[i])) * 1000, Math.acos(Math.min(1, fa[0] * fb[0] + fa[1] * fb[1] + fa[2] * fb[2])) * 180 / Math.PI]; };
        const rc = F.map(f => err(f, f.c)), sm = F.map(f => err(f, f.disp - off - mLag));
        out.poseError = { reconstruction: { mm: stat(rc.map(e => e[0])), deg: stat(rc.map(e => e[1])) }, vsSmoothDelayed: { mm: stat(sm.map(e => e[0])), deg: stat(sm.map(e => e[1])) } };
      }
    }
    return out;
  }
  emit() { this.E.emit('live', this); }
}

/** The Live popover in the viewport bar (next to Show): bridge address, connect, follow, play-out, align, record. */
export function liveMenu(E) {
  const L = E.live, btn = document.getElementById('liveBtn'), pop = document.getElementById('liveMenu');
  pop.innerHTML = `<div class="menu-group"><div class="menu-head">Engine bridge</div>
      <label class="check pick"><span>Bridge</span><input type="text" id="lvUrl" spellcheck="false" style="width:160px"></label>
      <div class="menu-row"><button type="button" id="lvConnect">Connect</button><span id="lvState" class="note"></span></div>
      <div id="lvSources" class="note"></div></div>
    <div class="menu-group"><div class="menu-head">Live camera</div>
      <label class="check"><input type="checkbox" id="lvOn"><span>Shot camera follows the stream</span></label>
      <label class="check pick"><span>Play-out</span><select id="lvMode"><option value="interp">Interpolate, fixed delay</option><option value="latest">Latest sample</option><option value="extrap">Extrapolate (predict)</option></select></label>
      <label class="check pick"><span>Delay (ms)</span><input type="number" id="lvDelay" min="0" step="5" style="width:64px"></label>
      <label class="check pick"><span>Quality</span><select id="lvQ"><option value="play">Play</option><option value="render">Render (slow)</option></select></label>
      <label class="check"><input type="checkbox" id="lvPub"><span>Send the shot camera out</span><span class="note">to Blender / Unreal</span></label>
      <label class="check"><input type="checkbox" id="lvLens"><span>Keep the shot's lens warp</span><span class="note">off: a game's straight lens</span></label>
      <div class="menu-row"><button type="button" id="lvAlign" title="Move and turn the stream's world so its camera sits where the shot camera is now">Align to shot camera</button><button type="button" id="lvReset">Reset</button></div>
      <div id="lvAlignNote" class="note"></div></div>
    <div class="menu-group"><div class="menu-head">Record</div>
      <div class="menu-row"><button type="button" id="lvRec" class="primary">Record take</button><button type="button" id="lvCancel">Cancel</button></div>
      <div id="lvTake" class="note">Plays the shot from the playhead in step with the stream; Stop writes Bézier keys (one undo).</div>
      <div id="lvEvents" class="note"></div></div>`;
  const $ = id => pop.querySelector('#' + id);
  $('lvUrl').value = L.url; $('lvUrl').onchange = e => { L.url = e.target.value; };
  $('lvConnect').onclick = () => L.ws ? L.disconnect() : L.connect($('lvUrl').value);
  $('lvOn').onchange = e => e.target.checked ? L.start() : L.stop();
  $('lvMode').onchange = e => { L.mode = e.target.value; L.emit(); };
  $('lvDelay').onchange = e => { L.delay = Math.max(0, +e.target.value); L.emit(); };
  $('lvQ').onchange = e => { L.quality = e.target.value; L.emit(); };
  $('lvLens').onchange = e => { L.lensWarp = e.target.checked; L.lastDrawn = null; L.emit(); };
  $('lvPub').onchange = e => L.setPublish(e.target.checked);
  $('lvAlign').onclick = () => L.alignToShot(); $('lvReset').onclick = () => L.resetAlign();
  $('lvRec').onclick = () => L.rec ? L.stopRecord(true) : L.startRecord(); $('lvCancel').onclick = () => L.stopRecord(false);
  const sync = () => {
    $('lvConnect').textContent = L.ws ? 'Disconnect' : 'Connect';
    const r = L.recent, med = r.length ? [...r].sort((a, b) => a - b)[r.length >> 1] : null;
    $('lvState').textContent = L.state + (med != null ? ` · ${med.toFixed(1)} ms sender to editor` : '');
    $('lvSources').textContent = Object.values(L.sources).map(s => `${s.src} (${s.conventions}${s.rate ? ', ' + s.rate + ' Hz' : ''})`).join(' · ') || (L.ws ? 'No source yet' : '');
    $('lvOn').checked = L.on; $('lvMode').value = L.mode; $('lvDelay').value = L.delay; $('lvDelay').disabled = L.mode !== 'interp'; $('lvQ').value = L.quality; $('lvLens').checked = L.lensWarp; $('lvPub').checked = !!L.publish;
    $('lvAlignNote').textContent = L.align ? `Aligned: yaw ${L.align.yaw.toFixed(1)}°, offset ${L.align.p.map(v => v.toFixed(2)).join(', ')} m` : 'Stream world = scene world';
    $('lvRec').textContent = L.rec ? 'Stop and write keys' : 'Record take'; $('lvCancel').disabled = !L.rec;
    if (L.lastTake) $('lvTake').textContent = `Last take: frames ${L.lastTake.from}–${L.lastTake.to}, ${L.lastTake.streamSamples} samples → ${L.lastTake.keys} keys${L.lastTake.markers ? `, ${L.lastTake.markers} markers` : ''}`;
    $('lvEvents').textContent = L.events.slice(-4).map(e => `${e.name}${e.f != null ? ' @' + e.f : ''}`).join(' · ');
    btn.textContent = L.rec ? 'Live ● REC ▾' : L.on ? 'Live ● ▾' : L.ws ? 'Live (connected) ▾' : 'Live ▾';
    btn.classList.toggle('on', L.on);
  };
  E.on('live', sync); E.on('liveEvent', () => { if (pop.matches(':popover-open')) sync(); });
  setInterval(() => { if (L.ws && pop.matches(':popover-open')) sync(); }, 500);
  pop.addEventListener('beforetoggle', e => { if (e.newState !== 'open') return; const r = btn.getBoundingClientRect();
    pop.style.left = `${Math.min(r.left, innerWidth - 340)}px`; pop.style.top = `${r.bottom + 4}px`; sync(); });
  sync();
}
