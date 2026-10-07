// Performance stats (Unreal's `stat fps` / `stat unit`, Blender's Statistics overlay): frames per second, CPU time to
// build and submit each frame, GPU time per render pass (WebGPU timestamp queries), dropped frames in playback, and a
// report (JSON) that Connor or Claude can read: saved to the spike folder on G: from the local editor, copied in the
// artifact, and returned by VS.perf.report() for scripted runs.
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const r1 = x => x == null ? null : Math.round(x * 100) / 100;
const KEEP = 600;   // frames kept for the report and the graph

export class Perf {
  constructor(E) {
    this.E = E; this.frames = []; this.cur = null; this.seq = 0; this.resolving = false; this.play = null;
    this.el = document.getElementById('stats'); this.btn = document.getElementById('statsBtn');
    this.btn.onclick = () => this.toggle(!this.on);
    this.el.innerHTML = `<div class="st-body"></div><div class="st-act"><button type="button" data-act="save">${E.canSave ? 'Save report' : 'Copy report'}</button>
      <button type="button" data-act="reset">Reset</button></div>`;
    this.body = this.el.querySelector('.st-body');
    this.el.addEventListener('click', e => { const a = e.target.closest('[data-act]')?.dataset.act; if (a === 'save') this.save(); if (a === 'reset') this.reset(); });
    E.on('show', () => this.sync());
    this.on = false; this.toggle(!!E.statsOn, true);
  }
  toggle(on, quiet) {
    this.on = on; this.E.statsOn = on; this.E.shot.setTiming(on); if (!on) this.E.shot.passNames?.clear();
    this.btn.setAttribute('aria-pressed', String(on)); this.el.hidden = !on;
    if (on) { this.reset(); this.draw(); } if (!quiet) this.E.keepView?.();
  }
  sync() { /* the Show menu may change while stats are open */ if (this.on) this.draw(); }
  reset() { this.frames = []; this.play = null; this.draw(); }

  /** Around each frame the editor draws: kind = play | render | refine | free | output. */
  begin(kind) { if (!this.on) return; this.cur = { kind, frame: this.E.frame, t: performance.now(), seq0: (this.E.shot.passSeq || 0) + 1 }; }
  end(extra) {
    const c = this.cur; if (!c) return; this.cur = null;
    c.cpu = performance.now() - c.t; c.seq1 = this.E.shot.passSeq || 0; c.gpu = null; c.passes = [];
    if (extra) Object.assign(c, extra);
    this.frames.push(c); if (this.frames.length > KEEP) this.frames.shift();
    this.resolve(); this.drawSoon();
  }
  /** Playback: the frame the clock asked for vs the one before, so skipped frames are counted. */
  playTick(f, prev) { if (!this.on) return; const p = this.play ||= { frames: 0, dropped: 0, t0: performance.now() };
    p.frames++; if (prev != null && f > prev + 1) p.dropped += f - prev - 1; }

  async resolve() {
    if (this.resolving) return; this.resolving = true;
    try {
      const times = await this.E.shot.gpuTimes();
      for (const { seq, name, ms } of times) {
        const fr = this.frames.find(f => seq >= f.seq0 && seq <= f.seq1); if (!fr) continue;
        fr.passes.push({ name, ms }); fr.gpu = (fr.gpu || 0) + ms;
      }
    } catch { /* timing is best effort */ }
    this.resolving = false; this.drawSoon();
  }
  drawSoon() { if (this._raf) return; this._raf = setTimeout(() => { this._raf = null; this.draw(); }, 100); }

  /** Frames that reached the screen in the last second (refine steps only draw off screen until the last). */
  fps() { const now = performance.now(), recent = this.frames.filter(f => now - f.t < 1000 && f.kind !== 'output' && f.kind !== 'refine');
    if (recent.length < 2) return null; const span = (recent.at(-1).t - recent[0].t) / 1000; return span > 0 ? (recent.length - 1) / span : null; }

  summary() {
    const by = {};
    for (const f of this.frames) {
      const k = by[f.kind] ||= { frames: 0, cpu: [], gpu: [], passes: {} }; k.frames++; k.cpu.push(f.cpu); if (f.gpu != null) k.gpu.push(f.gpu);
      for (const p of f.passes) { const n = p.name.replace(/ \d+\/\d+$/, ''); (k.passes[n] ||= []).push(p.ms); }
    }
    const out = {};
    for (const [kind, k] of Object.entries(by)) out[kind] = { frames: k.frames,
      cpu_ms: { mean: r1(k.cpu.reduce((a, b) => a + b, 0) / k.cpu.length), p50: r1(pct(k.cpu, .5)), p95: r1(pct(k.cpu, .95)), max: r1(Math.max(...k.cpu)) },
      gpu_ms: k.gpu.length ? { mean: r1(k.gpu.reduce((a, b) => a + b, 0) / k.gpu.length), p50: r1(pct(k.gpu, .5)), p95: r1(pct(k.gpu, .95)), max: r1(Math.max(...k.gpu)) } : null,
      gpu_pass_mean_ms: Object.fromEntries(Object.entries(k.passes).map(([n, a]) => [n, r1(a.reduce((x, y) => x + y, 0) / a.length)])) };
    return out;
  }
  report() {
    const E = this.E, s = E.shot, info = s.renderer.backend.adapter?.info || {};
    return { when: new Date().toISOString(), scene: E.doc.name, page: location.pathname,
      gpu: { backend: s.backend, vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, timestampQueries: s.canTime },
      browser: navigator.userAgent, screen: { css: `${innerWidth}x${innerHeight}`, dpr: devicePixelRatio, viewport: (() => { const r = document.getElementById('gpu').getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; })() },
      buffers: { canvas: `${s.W}x${s.H}`, scene: `${s.sceneRT.width}x${s.sceneRT.height} (4x MSAA)`, haze: `${s.hazeRT.width}x${s.hazeRT.height}` },
      settings: { view: E.view, mode: E.mode, refine: E.refineMode, show: E.show, hidden: [...E.hidden] },
      playback: this.play && { ...this.play, t0: undefined, seconds: r1((performance.now() - this.play.t0) / 1000) },
      summary: this.summary(),
      frames: this.frames.slice(-200).map(f => ({ kind: f.kind, frame: f.frame, cpu: r1(f.cpu), gpu: r1(f.gpu), passes: Object.fromEntries(f.passes.map(p => [p.name, r1(p.ms)])) })) };
  }
  async save() {
    const body = JSON.stringify(this.report(), null, 1), name = `perf/editor_perf_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    if (this.E.canSave) {
      const r = await fetch('/save/' + name, { method: 'POST', body }).catch(() => null);
      if (r && r.ok) { this.E.status(`Saved the report to the spike folder: ${name}`); return; }
    }
    try { await navigator.clipboard.writeText(body); this.E.status('Copied the performance report (JSON)'); } catch { this.E.status('Could not save or copy the report'); }
  }

  draw() {
    if (!this.on) return;
    const E = this.E, last = this.frames.filter(f => f.kind !== 'output' && f.kind !== 'refine').at(-1), fps = this.fps();
    const lastGpu = [...this.frames].reverse().find(f => f.gpu != null && f.kind !== 'refine' && f.kind !== 'output');
    const ms = v => v == null ? '–' : v < 10 ? v.toFixed(1) : Math.round(v);
    const passes = lastGpu ? lastGpu.passes : [], total = lastGpu?.gpu || 0;
    const refine = this.frames.filter(f => f.kind === 'refine').slice(-17), refineGpu = refine.reduce((a, f) => a + (f.gpu || 0), 0);
    const play = this.play ? `<div class="st-row"><span>Playback</span><b>${this.play.dropped} dropped of ${this.play.frames + this.play.dropped}</b></div>` : '';
    this.body.innerHTML = `
      <div class="st-fps"><b>${fps == null ? 'idle' : Math.round(fps)}</b><span>${fps == null ? 'no frames in the last second' : 'fps'}</span></div>
      <div class="st-row"><span>${last ? last.kind[0].toUpperCase() + last.kind.slice(1) : '–'} frame</span><b>CPU ${ms(last?.cpu)} ms · GPU ${ms(lastGpu?.gpu)} ms</b></div>
      ${refine.length ? `<div class="st-row"><span>Last refine</span><b>${refine.length} steps · GPU ${ms(refineGpu)} ms</b></div>` : ''}
      ${play}
      <canvas class="st-graph" width="300" height="60" aria-label="Frame times, last 120 frames"></canvas>
      <div class="st-legend"><i class="c"></i>CPU <i class="g"></i>GPU <span>line = 16.7 ms (60 fps)</span></div>
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
