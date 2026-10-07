// Performance stats (Unreal's `stat fps` / `stat unit`, Blender's Statistics overlay): frames per second, CPU time to
// build and submit each frame, GPU time per render pass (WebGPU timestamp queries), dropped frames in playback, and a
// report (JSON) that Connor or Claude can read: saved to the spike folder on G: from the local editor, copied in the
// artifact, and returned by VS.perf.report() for scripted runs.
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r1 = x => x == null ? null : Math.round(x * 100) / 100;
const KEEP = 600;   // frames kept for the report and the graph
const KEEP_REC = 20000;   // frames kept while recording (about 5 minutes at 60 fps)
const slug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export class Perf {
  constructor(E) {
    this.E = E; this.frames = []; this.cur = null; this.seq = 0; this.resolving = false; this.play = null;
    this.el = document.getElementById('stats'); this.btn = document.getElementById('statsBtn');
    this.btn.onclick = () => this.toggle(!this.on);
    this.el.innerHTML = `<div class="st-body"></div>
      <div class="st-rec"><input type="text" id="recLabel" placeholder="What are you doing? (optional)" aria-label="Recording label">
        <button type="button" data-act="rec" class="rec">● Record</button></div><div class="st-recmsg note" id="recMsg"></div>
      <div class="st-act"><button type="button" data-act="save">${E.canSave ? 'Save report' : 'Copy report'}</button>
      <button type="button" data-act="reset">Reset</button></div>`;
    this.body = this.el.querySelector('.st-body'); this.recBtn = this.el.querySelector('[data-act="rec"]');
    this.el.addEventListener('click', e => { const a = e.target.closest('[data-act]')?.dataset.act; if (a === 'save') this.save(); if (a === 'reset') this.reset();
      if (a === 'rec') { if (this.rec) this.stopRec(); else this.startRec(); } });
    // what happened during a recording (commands, view and mode switches, playback), so a capture reads like a log
    E.on('change', n => this.note('edit: ' + n)); E.on('view', v => this.note('view: ' + v)); E.on('mode', m => this.note('mode: ' + m));
    E.on('show', () => this.sync());
    // main-thread work outside our frames (event handlers, layout, GC, other scripts): the browser's long tasks (50 ms+)
    this.long = []; try { new PerformanceObserver(l => { for (const e of l.getEntries()) { this.long.push({ t: e.startTime, ms: e.duration,
      what: e.attribution?.[0]?.containerType || e.name }); if (this.long.length > 200) this.long.shift(); } }).observe({ type: 'longtask', buffered: false }); } catch { /* not supported */ }
    this.on = false; this.toggle(!!E.statsOn, true);
  }
  toggle(on, quiet) {
    this.on = on; this.E.statsOn = on; this.E.shot.setTiming(on || !!this.rec); if (!on && !this.rec) this.E.shot.passNames?.clear();
    this.btn.setAttribute('aria-pressed', String(on)); this.el.hidden = !on;
    if (on) { this.reset(); this.draw(); } if (!quiet) this.E.keepView?.();
  }
  sync() { /* the Show menu may change while stats are open */ if (this.on) this.draw(); }
  reset() { this.frames = []; this.play = null; this.draw(); }

  /** Around each frame the editor draws: kind = play | render | refine | free | output. */
  get active() { return this.on || !!this.rec; }
  begin(kind) { if (!this.active) return; this.cur = { kind, frame: this.E.frame, t: performance.now(), seq0: (this.E.shot.passSeq || 0) + 1, parts: {} }; }
  /** CPU time of one part of the current frame (2D layers, encoding the GPU work, panel updates). */
  part(name, ms) { if (this.cur) this.cur.parts[name] = (this.cur.parts[name] || 0) + ms; }
  time(name, fn) { if (!this.cur) return fn(); const t = performance.now(); try { return fn(); } finally { this.part(name, performance.now() - t); } }
  note(text) { if (this.rec) this.rec.events.push({ at_s: r1((performance.now() - this.rec.t0) / 1000), what: text }); }

  /** Record / Stop: everything between the two clicks, saved as one capture with a label and an event log. */
  startRec() {
    const label = this.el.querySelector('#recLabel').value.trim();
    this.rec = { t0: performance.now(), when: new Date().toISOString(), label, frames: [], events: [] };
    this.E.shot.setTiming(true); this.recBtn.textContent = '■ Stop'; this.recBtn.classList.add('on');
    this.recStatus(); this.recTimer = setInterval(() => this.recStatus(), 250);
  }
  recStatus() { const R = this.rec; if (R) this.el.querySelector('#recMsg').textContent = `Recording ${((performance.now() - R.t0) / 1000).toFixed(1)} s · ${R.frames.length} frames`; }
  async stopRec() {
    const R = this.rec; if (!R) return; clearInterval(this.recTimer); const t1 = performance.now();
    this.recBtn.textContent = '● Record'; this.recBtn.classList.remove('on');
    await new Promise(r => setTimeout(r, 300)); this.resolving = false; await this.resolve();   // let the last GPU timings arrive
    this.rec = null; this.E.shot.setTiming(this.on);
    const body = { ...this.report(R.frames), capture: { label: R.label, started: R.when, seconds: r1((t1 - R.t0) / 1000), events: R.events },
      long_tasks: this.long.filter(l => l.t >= R.t0 && l.t <= t1).map(l => ({ at_s: r1((l.t - R.t0) / 1000), ms: r1(l.ms), what: l.what })) };
    const name = `perf/capture_${R.when.replace(/[:.]/g, '-')}${R.label ? '_' + slug(R.label) : ''}.json`;
    const where = await this.write(name, body);
    this.el.querySelector('#recMsg').textContent = where ? `Saved ${R.frames.length} frames (${body.capture.seconds} s) to ${where}` : 'Could not save or copy the capture';
    return name;
  }
  end(extra) {
    const c = this.cur; if (!c) return; this.cur = null;
    c.cpu = performance.now() - c.t; c.seq1 = this.E.shot.passSeq || 0; c.gpu = null; c.passes = [];
    // time since the previous frame on screen: what panning feels like (CPU + GPU + whatever else the browser did)
    if (c.kind !== 'refine' && c.kind !== 'output') { const dt = this.lastShown != null ? c.t - this.lastShown : null; c.interval = dt != null && dt < 500 ? dt : null; this.lastShown = c.t; }
    if (extra) Object.assign(c, extra);
    if (this.on) { this.frames.push(c); if (this.frames.length > KEEP) this.frames.shift(); }
    if (this.rec) { c.at = c.t - this.rec.t0; this.rec.frames.push(c); if (this.rec.frames.length > KEEP_REC) this.rec.frames.shift(); }
    this.resolve(); this.drawSoon();
  }
  /** Playback: the frame the clock asked for vs the one before, so skipped frames are counted. */
  playTick(f, prev) { if (!this.active) return; if (!this.play) this.note('playback'); const p = this.play ||= { frames: 0, dropped: 0, t0: performance.now() };
    p.frames++; if (prev != null && f > prev + 1) p.dropped += f - prev - 1; }

  async resolve() {
    if (this.resolving) return; this.resolving = true;
    try {
      const times = await this.E.shot.gpuTimes();
      for (const { seq, name, ms } of times) {
        const hit = f => seq >= f.seq0 && seq <= f.seq1, fr = this.rec?.frames.findLast(hit) || this.frames.findLast(hit); if (!fr) continue;
        fr.passes.push({ name, ms }); fr.gpu = (fr.gpu || 0) + ms;
      }
    } catch { /* timing is best effort */ }
    this.resolving = false; this.drawSoon();
  }
  drawSoon() { if (this._raf) return; this._raf = setTimeout(() => { this._raf = null; this.draw(); }, 100); }

  /** Frames that reached the screen in the last second (refine steps only draw off screen until the last). */
  fps() { const now = performance.now(), recent = this.frames.filter(f => now - f.t < 1000 && f.kind !== 'output' && f.kind !== 'refine');
    if (recent.length < 2) return null; const span = (recent.at(-1).t - recent[0].t) / 1000; return span > 0 ? (recent.length - 1) / span : null; }

  summary(frames = this.frames) {
    const by = {};
    for (const f of frames) {
      const k = by[f.kind] ||= { frames: 0, cpu: [], gpu: [], iv: [], passes: {}, parts: {} };
      for (const [n, v] of Object.entries(f.parts || {})) (k.parts[n] ||= []).push(v); k.frames++; k.cpu.push(f.cpu); if (f.gpu != null) k.gpu.push(f.gpu); if (f.interval != null) k.iv.push(f.interval);
      for (const p of f.passes) { const n = p.name.replace(/ \d+\/\d+$/, ''); (k.passes[n] ||= []).push(p.ms); }
    }
    const out = {};
    for (const [kind, k] of Object.entries(by)) out[kind] = { frames: k.frames,
      cpu_ms: { mean: r1(k.cpu.reduce((a, b) => a + b, 0) / k.cpu.length), p50: r1(pct(k.cpu, .5)), p95: r1(pct(k.cpu, .95)), max: r1(Math.max(...k.cpu)) },
      gpu_ms: k.gpu.length ? { mean: r1(k.gpu.reduce((a, b) => a + b, 0) / k.gpu.length), p50: r1(pct(k.gpu, .5)), p95: r1(pct(k.gpu, .95)), max: r1(Math.max(...k.gpu)) } : null,
      interval_ms: k.iv.length ? { p50: r1(pct(k.iv, .5)), p95: r1(pct(k.iv, .95)), max: r1(Math.max(...k.iv)) } : null,
      cpu_part_mean_ms: Object.fromEntries(Object.entries(k.parts).map(([n, a]) => [n, r1(a.reduce((x, y) => x + y, 0) / k.frames)])),
      cpu_part_max_ms: Object.fromEntries(Object.entries(k.parts).map(([n, a]) => [n, r1(Math.max(...a))])),
      gpu_pass_mean_ms: Object.fromEntries(Object.entries(k.passes).map(([n, a]) => [n, r1(a.reduce((x, y) => x + y, 0) / a.length)])) };
    return out;
  }
  report(frames = this.frames) {
    const E = this.E, s = E.shot, info = s.renderer.backend.adapter?.info || {};
    return { when: new Date().toISOString(), scene: E.doc.name, page: location.pathname,
      gpu: { backend: s.backend, vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, timestampQueries: s.canTime },
      browser: navigator.userAgent, screen: { css: `${innerWidth}x${innerHeight}`, dpr: devicePixelRatio, viewport: (() => { const r = document.getElementById('gpu').getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; })() },
      buffers: { canvas: `${s.W}x${s.H}`, scene: `${s.sceneRT.width}x${s.sceneRT.height} (4x MSAA)`, haze: `${s.hazeRT.width}x${s.hazeRT.height}` },
      settings: { view: E.view, mode: E.mode, refine: E.refineMode, show: E.show, hidden: [...E.hidden] },
      playback: this.play && { ...this.play, t0: undefined, seconds: r1((performance.now() - this.play.t0) / 1000) },
      summary: this.summary(frames),
      long_tasks: this.long.slice(-50).map(l => ({ at_s: r1(l.t / 1000), ms: r1(l.ms), what: l.what })),
      frames: (frames === this.frames ? frames.slice(-200) : frames).map(f => ({ kind: f.kind, frame: f.frame, at_s: r1((f.at ?? f.t) / 1000), interval: r1(f.interval),
        cpu: r1(f.cpu), gpu: r1(f.gpu), cpu_parts: Object.fromEntries(Object.entries(f.parts || {}).map(([n, v]) => [n, r1(v)])),
        passes: Object.fromEntries(f.passes.map(p => [p.name, r1(p.ms)])) })) };
  }
  async save() {
    const where = await this.write(`perf/editor_perf_${new Date().toISOString().replace(/[:.]/g, '-')}.json`, this.report());
    this.E.status(where ? `Saved the report to ${where}` : 'Could not save or copy the report');
  }
  /** The spike folder on G: from the local editor; the clipboard in the artifact. Returns where it went. */
  async write(name, obj) {
    const body = JSON.stringify(obj, null, 1);
    if (this.E.canSave) { const r = await fetch('/save/' + name, { method: 'POST', body }).catch(() => null); if (r && r.ok) return name; }
    try { await navigator.clipboard.writeText(body); return 'the clipboard (paste it to Claude)'; } catch { return null; }
  }

  draw() {
    if (!this.on) return;
    const E = this.E, last = this.frames.filter(f => f.kind !== 'output' && f.kind !== 'refine').at(-1), fps = this.fps();
    const lastGpu = [...this.frames].reverse().find(f => f.gpu != null && f.kind !== 'refine' && f.kind !== 'output');
    const ms = v => v == null ? '–' : v < 10 ? v.toFixed(1) : Math.round(v);
    const passes = lastGpu ? lastGpu.passes : [], total = lastGpu?.gpu || 0;
    const refine = this.frames.filter(f => f.kind === 'refine').slice(-17), refineGpu = refine.reduce((a, f) => a + (f.gpu || 0), 0);
    const now = performance.now(), recentLong = this.long.filter(l => now - l.t < 2000), longMs = recentLong.reduce((a, l) => a + l.ms, 0);
    const ivs = this.frames.filter(f => f.interval != null && now - f.t < 2000).map(f => f.interval), iv = pct(ivs, .5);
    const play = this.play ? `<div class="st-row"><span>Playback</span><b>${this.play.dropped} dropped of ${this.play.frames + this.play.dropped}</b></div>` : '';
    this.body.innerHTML = `
      <div class="st-fps"><b>${fps == null ? 'idle' : Math.round(fps)}</b><span>${fps == null ? 'no frames in the last second' : 'fps'}</span></div>
      <div class="st-row"><span>${last ? last.kind[0].toUpperCase() + last.kind.slice(1) : '–'} frame</span><b>CPU ${ms(last?.cpu)} ms · GPU ${ms(lastGpu?.gpu)} ms</b></div>
      <div class="st-row"><span>Time between frames</span><b>${iv == null ? '–' : ms(iv) + ' ms (median, 2 s)'}</b></div>
      <div class="st-row"><span>Long tasks (2 s)</span><b>${recentLong.length ? `${recentLong.length} · ${Math.round(longMs)} ms` : 'none'}</b></div>
      ${refine.length ? `<div class="st-row"><span>Last refine</span><b>${refine.length} steps · GPU ${ms(refineGpu)} ms</b></div>` : ''}
      ${play}
      <canvas class="st-graph" width="300" height="60" aria-label="Frame times, last 120 frames"></canvas>
      <div class="st-legend"><i class="c"></i>CPU <i class="g"></i>GPU <span>line = 16.7 ms (60 fps)</span></div>
      ${last && Object.keys(last.parts || {}).length ? `<div class="st-sub">CPU, last frame</div><div class="st-passes">${Object.entries(last.parts).sort((a, b) => b[1] - a[1]).map(([n, v]) => `<div class="st-pass cpu"><span>${n}</span><div class="bar"><div style="width:${(v / Math.max(last.cpu, 0.01) * 100).toFixed(1)}%"></div></div><b>${ms(v)}</b></div>`).join('')}</div>` : ''}
      <div class="st-sub">GPU, last frame</div>
      ${E.shot.canTime ? `<div class="st-passes">${passes.map(p => `<div class="st-pass"><span>${p.name}</span><div class="bar"><div style="width:${total ? (p.ms / total * 100).toFixed(1) : 0}%"></div></div><b>${ms(p.ms)}</b></div>`).join('')}</div>`
        : '<div class="note">GPU timing needs WebGPU with timestamp queries.</div>'}
      <div class="st-row note"><span>Scene buffer ${E.shot.sceneRT.width}×${E.shot.sceneRT.height}, haze ${E.shot.hazeRT.width}×${E.shot.hazeRT.height}</span></div>`;
    this.graph(this.body.querySelector('.st-graph'));
  }
  graph(cv) {
    const x = cv.getContext('2d'), W = cv.width, H = cv.height, fr = this.frames.filter(f => f.kind !== 'output').slice(-120), max = 50;
    x.clearRect(0, 0, W, H); const cs = getComputedStyle(this.el), col = n => cs.getPropertyValue(n).trim() || '#888';
    const y = v => H - Math.min(v, max) / max * H, bw = W / 120;
    x.strokeStyle = col('--faint'); x.beginPath(); x.moveTo(0, y(16.7)); x.lineTo(W, y(16.7)); x.stroke();
    fr.forEach((f, i) => { const X = W - (fr.length - i) * bw;
      x.fillStyle = col('--teal'); if (f.gpu != null) x.fillRect(X, y(f.gpu), bw * .5, H - y(f.gpu));
      x.fillStyle = col('--accent'); x.fillRect(X + bw * .5, y(f.cpu), bw * .5, H - y(f.cpu)); });
  }
}
