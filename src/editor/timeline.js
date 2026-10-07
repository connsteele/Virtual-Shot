// Timeline: an After Effects-style dope sheet (rows per object and property, key diamonds, event lanes for chat
// messages, ghost flashes and pops) and the graph editor ported from Black Page (curves, Bézier handles, presets).
// Shared: the ruler (seconds and frames, reveal and cut markers), the playhead, zoom (wheel) and pan (middle-drag).
import { segVal, bzCtrl } from '../core/tracks.js';
import { CURVES, clamp } from '../core/curves.js';
import { esc } from './outliner.js';

const COL = { 'rig.dist': '#C3ACC6', 'rig.fov': '#3FB5A8', 'rig.x': '#E0A458', 'rig.y': '#8FB8E0', 'rig.distort': '#B9B39C', 'rig.yaw': '#E06A66',
  'rig.pitch': '#E6D06A', 'rig.squint': '#7FD39A', 'params.chaos': '#E88AC4' };
const LABEL = { 'rig.dist': 'Distance', 'rig.fov': 'FOV', 'rig.x': 'Pan X', 'rig.y': 'Pan Y', 'rig.distort': 'Lens', 'rig.yaw': 'Yaw', 'rig.pitch': 'Pitch',
  'rig.squint': 'Squint', 'params.chaos': 'Chaos', focus: 'Focus' };
const ROW = 20, RULER = 26, FR = 1 / 60, snapT = v => Math.round(v * 60) / 60;
const keyKind = c => c === 'linear' ? 'linear' : c === 'bezier' ? 'bezier' : c === 'hold' ? 'hold' : 'preset';

export class Timeline {
  constructor(E, canvas, labels) {
    this.E = E; this.cv = canvas; this.labels = labels; this.mode = 'dope';
    this.view = [-0.3, E.doc.duration + 0.3]; this.scroll = 0; this.drag = null;
    this.vis = new Set(['cam.rig.dist', 'cam.rig.yaw', 'cam.rig.pitch', 'cam.rig.fov']); this.act = 'cam.rig.dist';
    E.on('change', () => { this.build(); this.draw(); }); E.on('frame', () => this.draw()); E.on('select', () => this.draw());
    E.on('resize', () => this.draw()); E.on('mode', () => this.draw());
    E.on('key', e => this.onKey(e));
    document.querySelectorAll('[data-tl]').forEach(b => b.onclick = () => { this.mode = b.dataset.tl;
      document.querySelectorAll('[data-tl]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); this.build(); this.draw(); });
    canvas.addEventListener('pointerdown', e => this.down(e)); canvas.addEventListener('pointermove', e => this.move(e));
    canvas.addEventListener('pointerup', e => this.up(e)); canvas.addEventListener('pointercancel', e => this.up(e));
    canvas.addEventListener('dblclick', e => this.dbl(e)); canvas.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
    canvas.addEventListener('wheel', e => { e.preventDefault(); const L = this.L(), at = this.Xt(e.offsetX);
      if (e.shiftKey) { this.scroll = Math.max(0, this.scroll + e.deltaY * 0.5); } else { const f = Math.exp(e.deltaY * 0.0015), a = at - (at - this.view[0]) * f, b = at + (this.view[1] - at) * f; if (b - a > 0.2 && b - a < 120) this.view = [a, b]; }
      this.draw(); void L; }, { passive: false });
    labels.addEventListener('click', e => { const el = e.target.closest('[data-row]'); if (!el) return; const r = this.rows[+el.dataset.row];
      if (this.mode === 'graph') { if (e.target.matches('input')) { e.target.checked ? this.vis.add(r.key) : this.vis.delete(r.key); } else { this.act = r.key; this.vis.add(r.key); } this.build(); this.draw(); return; }
      if (r.obj) E.select({ kind: 'object', id: r.obj }); if (r.events) E.select(r.events === 'messages' ? { kind: 'layer', id: 'chat' } : { kind: 'events', id: r.events }); });
    this.build();
  }
  // ---------- geometry ----------
  L() { const r = this.cv.getBoundingClientRect(), d = window.devicePixelRatio || 1, W = Math.max(200, r.width), H = Math.max(80, r.height);
    if (this.cv.width !== Math.round(W * d) || this.cv.height !== Math.round(H * d)) { this.cv.width = Math.round(W * d); this.cv.height = Math.round(H * d); }
    return { W, H, d, left: 8, right: W - 8, top: RULER, bot: H - 6 }; }
  tX(t) { const L = this._L; return L.left + (t - this.view[0]) / (this.view[1] - this.view[0]) * (L.right - L.left); }
  Xt(x) { const L = this._L || this.L(); return this.view[0] + (x - L.left) / (L.right - L.left) * (this.view[1] - this.view[0]); }
  tracks() { return this.E.doc.tracks; }
  numericTracks() { return this.tracks().filter(t => t.type !== 'focus'); }

  /** Rows: per object (summary) then its properties; scene parameters; event lanes. */
  build() {
    const E = this.E, d = E.doc, rows = [];
    if (this.mode === 'dope') {
      const byTarget = {}; for (const tr of d.tracks) (byTarget[tr.target] ||= []).push(tr);
      for (const [tg, trs] of Object.entries(byTarget)) {
        const o = d.objects.find(o => o.id === tg);
        rows.push({ group: true, label: o ? o.name : 'Scene', obj: o ? o.id : null, tracks: trs });
        for (const tr of trs) rows.push({ track: tr, label: LABEL[tr.prop] || tr.prop, obj: o ? o.id : null, depth: 1 });
      }
      rows.push({ group: true, label: 'Events' });
      rows.push({ events: 'messages', label: 'Chat messages', depth: 1 });
      rows.push({ events: 'ghosts', label: 'Ghost flashes', depth: 1 });
      rows.push({ events: 'pops', label: 'Pops', depth: 1 });
    } else {
      for (const tr of this.numericTracks()) { const key = `${tr.target}.${tr.prop}`; rows.push({ key, track: tr, label: LABEL[tr.prop] || tr.prop, col: COL[tr.prop] || '#aaa' }); }
    }
    this.rows = rows;
    const sel = E.sel;
    this.labels.innerHTML = (this.mode === 'graph' ? `<div class="lab group" style="top:2px;height:22px;gap:4px">
        ${['linear', 'bezier', 'ease', 'hold'].map(m => `<button type="button" data-interp="${m}" title="Set the selected keys' interpolation">${{ linear: 'Linear', bezier: 'Bézier', ease: 'Ease', hold: 'Hold' }[m]}</button>`).join('')}
        <select data-preset aria-label="Preset curve into the selected keys"><option value="">Preset…</option>${Object.keys(CURVES).filter(c => c !== 'linear').map(c => `<option>${c}</option>`).join('')}</select></div>` : '')
      + rows.map((r, i) => { const y = RULER + i * ROW - this.scroll;
        if (this.mode === 'graph') return `<div class="lab${r.key === this.act ? ' on' : ''}" data-row="${i}" style="top:${y}px;height:${ROW}px"><input type="checkbox" ${this.vis.has(r.key) || r.key === this.act ? 'checked' : ''} aria-label="Show ${esc(r.label)}"><span class="dot" style="background:${r.col}"></span>${esc(r.label)}</div>`;
        const on = (r.obj && sel.kind === 'object' && sel.id === r.obj && r.group) || (r.events && ((sel.kind === 'events' && sel.id === r.events) || (r.events === 'messages' && sel.kind === 'layer')));
        return `<div class="lab${r.group ? ' group' : ''}${on ? ' on' : ''}" data-row="${i}" style="top:${y}px;height:${ROW}px;--depth:${r.depth || 0}">${esc(r.label)}</div>`; }).join('');
    this.labels.querySelectorAll('[data-interp]').forEach(b => b.onclick = () => this.interp(b.dataset.interp));
    const ps = this.labels.querySelector('[data-preset]'); if (ps) ps.onchange = () => { this.preset(ps.value); ps.value = ''; };
  }

  // ---------- drawing ----------
  draw() {
    const L = this._L = this.L(), x = this.cv.getContext('2d'), E = this.E; x.setTransform(L.d, 0, 0, L.d, 0, 0);
    x.fillStyle = '#161516'; x.fillRect(0, 0, L.W, L.H); x.font = '11px Barlow, system-ui, sans-serif';
    // ruler: seconds, frame ticks when zoomed in; reveal and cut markers
    const span = this.view[1] - this.view[0], step = [FR, 2 * FR, 5 * FR, 0.1, 0.25, 0.5, 1, 2, 5].find(s => s >= span / 14) || 5;
    x.fillStyle = '#201F20'; x.fillRect(0, 0, L.W, RULER);
    for (let s = Math.ceil(this.view[0] / step) * step; s <= this.view[1] + 1e-9; s += step) { const X = this.tX(s);
      x.strokeStyle = '#262426'; x.beginPath(); x.moveTo(X, RULER); x.lineTo(X, L.H); x.stroke();
      x.fillStyle = '#A6A3A6'; x.fillText(step < 0.1 ? `${Math.round(s * 60)}f` : (step < 1 ? s.toFixed(2) : s.toFixed(0)) + 's', X + 3, 16); }
    const R = E.doc.sequence.reveal;
    for (const [t, lab, c] of [[R.start, 'reveal', '#3FB5A8'], [E.doc.cut, 'cut', '#E06A66']]) { const X = this.tX(t); x.fillStyle = c; x.fillRect(X - 1, 0, 2, RULER); x.fillText(lab, X + 4, RULER - 3); }
    x.save(); x.beginPath(); x.rect(0, RULER, L.W, L.H - RULER); x.clip();
    if (this.mode === 'dope') this.drawDope(x, L); else this.drawGraph(x, L);
    x.restore();
    const B = this.drag && this.drag.type === 'box' ? this.drag : null;
    if (B) { x.fillStyle = 'rgba(195,172,198,.12)'; x.strokeStyle = '#C3ACC6'; x.setLineDash([4, 3]); const bx = Math.min(B.x0, B.x1), by = Math.min(B.y0, B.y1);
      x.fillRect(bx, by, Math.abs(B.x1 - B.x0), Math.abs(B.y1 - B.y0)); x.strokeRect(bx + .5, by + .5, Math.abs(B.x1 - B.x0), Math.abs(B.y1 - B.y0)); x.setLineDash([]); }
    // playhead
    const P = this.tX(E.frame / E.fps); x.strokeStyle = '#C3ACC6'; x.lineWidth = 1.5; x.beginPath(); x.moveTo(P, 4); x.lineTo(P, L.H); x.stroke(); x.lineWidth = 1;
    x.fillStyle = '#C3ACC6'; x.beginPath(); x.moveTo(P - 6, 4); x.lineTo(P + 6, 4); x.lineTo(P, 12); x.fill();
  }
  rowY(i) { return RULER + i * ROW - this.scroll; }
  isSel(tr, k) { return this.E.selKeys.some(s => s.tr === tr && s.k === k); }
  drawDope(x, L) {
    const E = this.E, d = E.doc;
    this.rows.forEach((r, i) => { const y = this.rowY(i), cy = y + ROW / 2; if (y > L.H || y + ROW < RULER) return;
      if (r.group) { x.fillStyle = '#1c1b1c'; x.fillRect(0, y, L.W, ROW); }
      x.strokeStyle = '#211f21'; x.beginPath(); x.moveTo(0, y + ROW); x.lineTo(L.W, y + ROW); x.stroke();
      if (r.track) { const K = r.track.keys, c = COL[r.track.prop] || '#C3ACC6';
        for (let k = 1; k < K.length; k++) { if (K[k].curve === 'hold') continue; x.strokeStyle = c + '55'; x.lineWidth = 2; x.beginPath(); x.moveTo(this.tX(K[k - 1].t), cy); x.lineTo(this.tX(K[k].t), cy); x.stroke(); x.lineWidth = 1; }
        K.forEach((k, j) => this.keyIcon(x, this.tX(k.t), cy, 5.5, j > 0 ? keyKind(k.curve || 'bezier') : null, K[j + 1] ? keyKind(K[j + 1].curve || 'bezier') : null, this.isSel(r.track, k) ? '#ECEFEB' : c)); }
      if (r.group && r.tracks) { const ts = [...new Set(r.tracks.flatMap(t => t.keys.map(k => Math.round(k.t * 60))))];
        x.fillStyle = '#8a858b'; for (const f of ts) { const X = this.tX(f / 60); x.beginPath(); x.moveTo(X, cy - 4); x.lineTo(X + 4, cy); x.lineTo(X, cy + 4); x.lineTo(X - 4, cy); x.fill(); } }
      if (r.events) { const list = r.events === 'messages' ? d.layers.find(l => l.type === 'chat2d').script.messages : d.events[r.events];
        const on = (E.sel.kind === 'events' && E.sel.id === r.events) || (r.events === 'messages' && E.sel.kind === 'layer');
        list.forEach((ev, j) => { const t0 = ev.t, dur = r.events === 'messages' ? 0.08 : (ev.dur ?? 4 / 60), X0 = this.tX(t0), X1 = Math.max(X0 + 3, this.tX(t0 + dur));
          x.fillStyle = r.events === 'ghosts' ? '#8FB8E0' : r.events === 'pops' ? '#E06A66' : '#C3ACC6'; x.globalAlpha = on ? 0.95 : 0.6;
          x.fillRect(X0, cy - 6, X1 - X0, 12); x.globalAlpha = 1;
          if (r.events === 'pops' && X1 - X0 > 30) { x.fillStyle = '#161516'; x.fillText(ev.text.slice(0, 18), X0 + 3, cy + 4); } }); }
    });
  }
  keyIcon(x, X, Y, s, kin, kout, fill) {   // After Effects icons: left half = into the key, right half = out of it
    const half = (kind, dir) => { const e = X + dir * s; kind = kind || 'linear';
      if (kind === 'linear') { x.moveTo(X, Y - s); x.lineTo(e, Y); x.lineTo(X, Y + s); }
      else if (kind === 'bezier') { x.moveTo(X, Y); x.lineTo(e, Y - s); x.lineTo(e, Y + s); }
      else if (kind === 'hold') { x.moveTo(X, Y - s * .85); x.lineTo(e, Y - s * .85); x.lineTo(e, Y + s * .85); x.lineTo(X, Y + s * .85); }
      else { x.moveTo(X, Y - s); x.arc(X, Y, s, -Math.PI / 2, Math.PI / 2, dir < 0); } x.closePath(); };
    x.fillStyle = fill; x.strokeStyle = '#0d0c0d'; x.lineWidth = 1.2; x.beginPath(); half(kin || kout, -1); half(kout || kin, 1); x.fill(); x.stroke(); x.lineWidth = 1;
  }

  // ---------- graph editor (ported from Black Page v4.8) ----------
  gTracks() { return this.rows.filter(r => this.vis.has(r.key) || r.key === this.act); }
  range(tr) { const K = tr.keys; if (!K.length) return [tr.default - 1, tr.default + 1]; let lo = Infinity, hi = -Infinity; const t0 = K[0].t, t1 = K[K.length - 1].t;
    for (let i = 0; i <= 200; i++) { const v = this.val(tr, t0 + (t1 - t0) * i / 200); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    K.forEach(k => { lo = Math.min(lo, k.v); hi = Math.max(hi, k.v); });
    if (hi - lo < 1e-6) { const p = Math.max(Math.abs(hi) * 0.1, 0.5); return [lo - p, hi + p]; } const p = (hi - lo) * 0.12; return [lo - p, hi + p]; }
  val(tr, t) { const K = tr.keys; if (!K.length) return tr.default; if (t <= K[0].t) return K[0].v; if (t >= K[K.length - 1].t) return K[K.length - 1].v;
    let i = 1; while (K[i].t < t) i++; return segVal(K[i - 1], K[i], t, tr.interp === 'geometric'); }
  vY(r, v) { const L = this._L; return L.bot - (v - r[0]) / (r[1] - r[0]) * (L.bot - L.top - 4); }
  Yv(r, y) { const L = this._L; return r[0] + (L.bot - y) / (L.bot - L.top - 4) * (r[1] - r[0]); }
  slopes(tr, a, b) { const T = Math.max(1e-6, b.t - a.t), cv = b.curve || 'bezier';
    if (cv === 'linear') { const s = (b.v - a.v) / T; return [s, s]; } if (cv === 'hold') return [0, 0];
    if (cv === 'bezier') { const [p1, p2] = bzCtrl(a, b); return [p1[0] - a.t > 1e-9 ? (p1[1] - a.v) / (p1[0] - a.t) : 0, b.t - p2[0] > 1e-9 ? (b.v - p2[1]) / (b.t - p2[0]) : 0]; }
    const e = T * 0.002, g = tr.interp === 'geometric'; return [(segVal(a, b, a.t + e, g) - a.v) / e, (b.v - segVal(a, b, b.t - e, g)) / e]; }
  handle(tr, i, side) { const K = tr.keys, k = K[i];
    if (side === 'o') { const nx = K[i + 1]; if (!nx || nx.curve === 'hold') return null; if ((nx.curve || 'bezier') === 'bezier') return bzCtrl(k, nx)[0];
      const T = nx.t - k.t, s = this.slopes(tr, k, nx)[0]; return [k.t + T / 3, k.v + s * T / 3]; }
    const pv = K[i - 1]; if (!pv || k.curve === 'hold') return null; if ((k.curve || 'bezier') === 'bezier') return bzCtrl(pv, k)[1];
    const T = k.t - pv.t, s = this.slopes(tr, pv, k)[1]; return [k.t - T / 3, k.v - s * T / 3]; }
  /** Grabbing a handle on a linear/preset side converts that segment to Bézier from its current shape (least-squares
   *  fit of the handle lengths, keeping the end slopes), as Black Page's graph editor did. */
  toBezier(tr, a, b) {
    if (!a || !b || (b.curve || 'bezier') === 'bezier') return;
    const A = { ...a }, B = { ...b }, g = tr.interp === 'geometric', f = t => segVal(A, B, t, g);
    const T = b.t - a.t, e = T * 0.002, s0 = (f(a.t + e) - a.v) / e, s1 = (b.v - f(b.t - e)) / e, ref = [];
    for (let j = 1; j < 24; j++) { const t = a.t + T * j / 24; ref.push([t, f(t)]); }
    const run = (l0, l1) => { const AA = { t: a.t, v: a.v, ho: [l0, s0 * l0] }, BB = { t: b.t, v: b.v, hi: [-l1, -s1 * l1], curve: 'bezier' }; let se = 0;
      for (const [t, v] of ref) { const dd = segVal(AA, BB, t, false) - v; se += dd * dd; } return se; };
    let best = [T / 3, T / 3], bs = run(T / 3, T / 3);
    for (let p = 1; p <= 20; p++) for (let q = 1; q <= 20; q++) { const sc = run(T * p / 20, T * q / 20); if (sc < bs) { bs = sc; best = [T * p / 20, T * q / 20]; } }
    a.ho = [best[0], s0 * best[0]]; b.hi = [-best[1], -s1 * best[1]]; b.curve = 'bezier';
  }
  drawGraph(x, L) {
    const act = this.rows.find(r => r.key === this.act);
    if (act) { const rr = this.range(act.track); x.fillStyle = '#6f6b70'; x.textAlign = 'left';
      for (let i = 0; i <= 4; i++) { const v = rr[0] + (rr[1] - rr[0]) * i / 4, Y = this.vY(rr, v); x.strokeStyle = '#211f21'; x.beginPath(); x.moveTo(0, Y); x.lineTo(L.W, Y); x.stroke(); x.fillText(v.toFixed(2), 4, Y - 2); } }
    const order = this.gTracks().sort((a, b) => (a.key === this.act) - (b.key === this.act));
    for (const r of order) { const tr = r.track, K = tr.keys, rr = this.range(tr), on = r.key === this.act;
      x.strokeStyle = r.col; x.globalAlpha = on ? 1 : 0.45; x.lineWidth = on ? 2 : 1.25; x.beginPath();
      for (let X = L.left; X <= L.right; X += 2) { const Y = this.vY(rr, this.val(tr, this.Xt(X))); X === L.left ? x.moveTo(X, Y) : x.lineTo(X, Y); } x.stroke(); x.lineWidth = 1;
      K.forEach((k, i) => { const X = this.tX(k.t), Y = this.vY(rr, k.v), sel = this.isSel(tr, k);
        if (sel) { x.globalAlpha = 1; for (const side of ['i', 'o']) { const h = this.handle(tr, i, side); if (!h) continue; const hx = this.tX(h[0]), hy = this.vY(rr, h[1]);
          const bz = side === 'o' ? K[i + 1] && (K[i + 1].curve || 'bezier') === 'bezier' : i > 0 && (k.curve || 'bezier') === 'bezier';
          x.strokeStyle = '#ECEFEB'; x.setLineDash(bz ? [] : [3, 3]); x.beginPath(); x.moveTo(X, Y); x.lineTo(hx, hy); x.stroke(); x.setLineDash([]);
          x.fillStyle = bz ? '#ECEFEB' : '#161516'; x.beginPath(); x.arc(hx, hy, 4, 0, 7); x.fill(); x.stroke(); } x.globalAlpha = on ? 1 : 0.45; }
        if (on && i > 0 && !['bezier', 'linear', 'hold'].includes(k.curve || 'bezier')) { x.fillStyle = '#A6A3A6'; x.fillText(k.curve, Math.max(L.left, (this.tX(K[i - 1].t) + X) / 2 - 14), L.bot - 4); }
        this.keyIcon(x, X, Y, on ? 7 : 5, i > 0 ? keyKind(k.curve || 'bezier') : null, K[i + 1] ? keyKind(K[i + 1].curve || 'bezier') : null, sel ? '#ECEFEB' : r.col); });
      x.globalAlpha = 1; }
  }

  // ---------- interaction ----------
  hit(px, py) {
    if (py < RULER) return { type: 'ruler' };
    if (this.mode === 'dope') { const i = Math.floor((py - RULER + this.scroll) / ROW), r = this.rows[i]; if (!r) return null;
      if (r.track) for (const k of r.track.keys) if (Math.abs(this.tX(k.t) - px) < 7) return { type: 'k', tr: r.track, k, row: r };
      if (r.events) { const d = this.E.doc, list = r.events === 'messages' ? d.layers.find(l => l.type === 'chat2d').script.messages : d.events[r.events];
        for (let j = list.length - 1; j >= 0; j--) { const ev = list[j], X0 = this.tX(ev.t), X1 = Math.max(X0 + 3, this.tX(ev.t + (r.events === 'messages' ? 0.08 : (ev.dur ?? 4 / 60))));
          if (px >= X0 - 2 && px <= X1 + 2) return { type: 'ev', kind: r.events, index: j, ev }; } }
      return { type: 'row', row: r }; }
    for (const r of this.gTracks()) { const tr = r.track, rr = this.range(tr);
      for (let i = 0; i < tr.keys.length; i++) { const k = tr.keys[i]; if (!this.isSel(tr, k)) continue;
        for (const side of ['i', 'o']) { const h = this.handle(tr, i, side); if (h && Math.hypot(this.tX(h[0]) - px, this.vY(rr, h[1]) - py) < 7) return { type: 'h', tr, k, i, side, r: rr }; } }
      for (const k of tr.keys) if (Math.hypot(this.tX(k.t) - px, this.vY(rr, k.v) - py) < 8) return { type: 'k', tr, k, r: rr, key: r.key }; }
    return null;
  }
  down(e) {
    const E = this.E, px = e.offsetX, py = e.offsetY; this.cv.focus(); try { this.cv.setPointerCapture(e.pointerId); } catch { /* */ }
    if (e.button === 1) { e.preventDefault(); this.drag = { type: 'pan', x0: px, v0: this.view.slice(), s0: this.scroll, y0: py }; return; }
    const h = this.hit(px, py);
    if (h && h.type === 'ruler') { E.interacting = true; this.drag = { type: 'scrub' }; E.setFrame(this.Xt(px) * E.fps); return; }
    if (h && h.type === 'ev') { const sel = h.kind === 'messages' ? { kind: 'layer', id: 'chat' } : { kind: 'events', id: h.kind }; E.select(sel);
      this.drag = { type: 'ev', x0: px, h, t0: h.ev.t, before: E.cmd.begin() }; return; }
    if (h && (h.type === 'k')) { if (h.key) this.act = h.key;
      const on = E.selKeys.findIndex(s => s.k === h.k);
      if (e.shiftKey) { if (on >= 0) E.selKeys.splice(on, 1); else E.selKeys.push({ tr: h.tr, k: h.k }); } else if (on < 0) E.selKeys = [{ tr: h.tr, k: h.k }];
      this.drag = { type: 'k', x0: px, y0: py, orig: E.selKeys.map(s => ({ s, t: s.k.t, v: s.k.v })), before: E.cmd.begin(), r: h.r, moved: false };
      E.interacting = true; this.draw(); return; }
    if (h && h.type === 'h') { const K = h.tr.keys; this.drag = { type: 'h', h, before: E.cmd.begin() }; E.interacting = true;
      if (h.side === 'o') this.toBezier(h.tr, h.k, K[h.i + 1]); else this.toBezier(h.tr, K[h.i - 1], h.k); return; }
    if (h && h.type === 'row' && h.row.group && h.row.obj) E.select({ kind: 'object', id: h.row.obj });
    this.drag = { type: 'box', x0: px, y0: py, x1: px, y1: py, base: e.shiftKey ? E.selKeys.slice() : [] }; if (!e.shiftKey) E.selKeys = []; this.draw();
  }
  move(e) {
    const D = this.drag, E = this.E; if (!D) return; const px = e.offsetX, py = e.offsetY;
    if (D.type === 'pan') { const dt = (px - D.x0) / (this._L.right - this._L.left) * (D.v0[1] - D.v0[0]); this.view = [D.v0[0] - dt, D.v0[1] - dt]; this.scroll = Math.max(0, D.s0 - (py - D.y0)); this.build(); this.draw(); return; }
    if (D.type === 'scrub') { E.setFrame(this.Xt(px) * E.fps); return; }
    if (D.type === 'box') { D.x1 = px; D.y1 = py; this.boxSelect(D); this.draw(); return; }
    if (D.type === 'ev') { const dt = snapT((px - D.x0) / (this._L.right - this._L.left) * (this.view[1] - this.view[0])); D.h.ev.t = Math.max(0, +(D.t0 + dt).toFixed(4)); D.moved = true;
      E.emit('eventsMoved'); this.draw(); E.requestRender(); return; }
    if (D.type === 'k') { const dT = snapT((px - D.x0) / (this._L.right - this._L.left) * (this.view[1] - this.view[0]));
      for (const o of D.orig) { o.s.k.t = Math.max(0, snapT(o.t + (e.altKey ? 0 : dT)));
        if (this.mode === 'graph' && !e.ctrlKey) { const rr = D.r || this.range(o.s.tr); o.s.k.v = o.v + (py - D.y0) * -(rr[1] - rr[0]) / (this._L.bot - this._L.top - 4); } }
      for (const tr of new Set(D.orig.map(o => o.s.tr))) tr.keys.sort((a, b) => a.t - b.t);
      D.moved = true; this.draw(); E.requestRender(); return; }
    if (D.type === 'h') { const { tr, k, side, r: rr } = D.h; let dt = this.Xt(px) - k.t, dv = this.Yv(rr, py) - k.v;
      if (side === 'o') dt = Math.max(dt, 1e-3); else dt = Math.min(dt, -1e-3); if (e.altKey) k.brk = true;
      if (side === 'o') k.ho = [dt, dv]; else k.hi = [dt, dv];
      const K = tr.keys, i = K.indexOf(k), other = side === 'o' ? 'hi' : 'ho', otherBz = side === 'o' ? i > 0 && (k.curve || 'bezier') === 'bezier' : K[i + 1] && (K[i + 1].curve || 'bezier') === 'bezier';
      if (!k.brk && otherBz) { const sl = dv / dt, len = k[other] ? Math.abs(k[other][0]) : 0.3; k[other] = side === 'o' ? [-len, -sl * len] : [len, sl * len]; }
      this.draw(); E.requestRender(); }
  }
  up() {
    const D = this.drag, E = this.E; this.drag = null; E.interacting = false;
    if (!D) return;
    if (D.type === 'k' || D.type === 'h') E.cmd.commit(D.type === 'k' ? 'moveKeys (drag)' : 'set handle', D.before);
    else if (D.type === 'ev') { if (D.moved) E.cmd.commit('setEvent (drag)', D.before); }
    else E.requestRender();
    this.draw();
  }
  boxSelect(B) {
    const E = this.E, out = B.base.slice(), x0 = Math.min(B.x0, B.x1), x1 = Math.max(B.x0, B.x1), y0 = Math.min(B.y0, B.y1), y1 = Math.max(B.y0, B.y1);
    if (this.mode === 'dope') this.rows.forEach((r, i) => { if (!r.track) return; const cy = this.rowY(i) + ROW / 2; if (cy < y0 || cy > y1) return;
      for (const k of r.track.keys) { const X = this.tX(k.t); if (X >= x0 && X <= x1 && !out.some(s => s.k === k)) out.push({ tr: r.track, k }); } });
    else for (const r of this.gTracks()) { const rr = this.range(r.track); for (const k of r.track.keys) { const X = this.tX(k.t), Y = this.vY(rr, k.v);
      if (X >= x0 && X <= x1 && Y >= y0 && Y <= y1 && !out.some(s => s.k === k)) out.push({ tr: r.track, k }); } }
    E.selKeys = out;
  }
  dbl(e) {   // add a key at that time (current value) on the row / active curve
    const E = this.E, t = snapT(this.Xt(e.offsetX));
    if (this.mode === 'dope') { const r = this.rows[Math.floor((e.offsetY - RULER + this.scroll) / ROW)]; if (!r || !r.track || r.track.type === 'focus') return;
      E.cmd.run('setKey', { target: r.track.target, prop: r.track.prop, t, v: this.val(r.track, t) }); return; }
    const r = this.rows.find(r => r.key === this.act); if (!r) return;
    E.cmd.run('setKey', { target: r.track.target, prop: r.track.prop, t, v: this.val(r.track, t), curve: 'bezier' });
  }
  onKey(e) {
    const E = this.E;
    if ((e.key === 'Delete' || e.key === 'Backspace') && E.selKeys.length) {
      E.cmd.run('deleteKeys', { keys: E.selKeys.map(s => ({ target: s.tr.target, prop: s.tr.prop, t: s.k.t })) }); E.selKeys = []; }
  }
  interp(mode) {
    const E = this.E; if (!E.selKeys.length) return; const before = E.cmd.begin();
    for (const { tr, k } of E.selKeys) { const K = tr.keys, i = K.indexOf(k), pv = K[i - 1], nx = K[i + 1], c = mode === 'ease' ? 'bezier' : mode;
      if (pv) k.curve = c; if (nx) nx.curve = c; const a = pv ? (k.t - pv.t) / 3 : 0.3, b = nx ? (nx.t - k.t) / 3 : 0.3;
      if (mode === 'ease') { k.hi = [-a, 0]; k.ho = [b, 0]; k.brk = false; }
      else if (mode === 'bezier') { const p = pv || k, q = nx || k, sl = (q.v - p.v) / Math.max(1e-6, q.t - p.t); k.hi = [-a, -sl * a]; k.ho = [b, sl * b]; k.brk = false; } }
    E.cmd.commit(`interpolation ${mode}`, before);
  }
  preset(name) { const E = this.E; if (!name || !E.selKeys.length) return; const before = E.cmd.begin(); for (const { k } of E.selKeys) k.curve = name; E.cmd.commit(`preset ${name}`, before); }
}
export { clamp };
