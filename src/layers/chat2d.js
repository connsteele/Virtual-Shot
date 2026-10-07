// Chat layer: the Black Page chatroom drawn with Canvas 2D as a pure function of t.
// Ported from engine v4.8.1 (layout, glyph animation, window chrome, user list, counter, glitch postFX) with the
// globals turned into instance state. Two geometries share one coordinate system (the 1920x1080 flat frame):
// 'flat' (the 16:9 window) and 'tall' (stretched to fill the CRT glass top to bottom).
import { clamp, lerp, easeOut, easeInOut, hash, hex } from '../core/curves.js';

const W = 1920, H = 1080;
const TXT = { size: 38, lh: 52, track: 2.2, pad: 30 };
const COL = { red: hex('#E3604E'), ghost: hex('#FF8A70'), sysWin: hex('#9C9C9C'), white: hex('#DADADA'), sysFloat: hex('#BDBDBD') };
const mix = (a, b, k) => `rgb(${a.map((v, i) => Math.round(lerp(v, b[i], k))).join(',')})`;

export class ChatLayer {
  /** @param script {messages, counter, reveal, window, floatUntil, mode}; glass {W,H}: the CRT glass size, for the tall texture. */
  constructor(script, { fontFamily = 'BP Gothic', glass, cut, fps = 60 }) {
    this.S = script; this.cut = cut; this.fps = fps; this.mode = script.mode || 'auto';
    this.FONT = `"${fontFamily}","IPAPGothic","Segoe UI",sans-serif`;
    this.WIN = { x: 150, y: 96, w: 1620, h: 888 };
    this.PANE = { x: this.WIN.x + 92, y: this.WIN.y + 52, w: 1080, h: this.WIN.h - 200 };
    this.LIST = { x: this.PANE.x + this.PANE.w + 56, y: this.PANE.y, w: this.WIN.x + this.WIN.w - 92 - (this.PANE.x + this.PANE.w + 56), h: this.PANE.h };
    this.GEO = { flat: { y: 96, h: 888 } };
    this.LAYOUTS = {};
    this.measure = document.createElement('canvas').getContext('2d');
    // the glass shows 1600 px of width (crop 120-1800, 1.05 overscan); match that scale vertically
    const th = Math.round(1600 / (glass.W / glass.H) * 1.05), offY = (th - 1080) / 2, visTop = -offY + th * (0.5 - 0.5 / 1.05), visH = th / 1.05;
    this.TEX = { th, offY };
    this.GEO.tall = { y: Math.round(visTop + 18), h: Math.round(visH - 36) };
    for (const n of ['tall', 'flat']) { this.setGeom(n); this.buildLayout(); this.LAYOUTS[n] = this.layout; }
    this.setGeom('flat');
  }
  setGeom(n) {
    const g = this.GEO[n], { WIN, PANE, LIST } = this;
    WIN.y = g.y; WIN.h = g.h; PANE.y = WIN.y + 52; PANE.h = WIN.h - 200; LIST.y = PANE.y; LIST.h = PANE.h;
    if (this.LAYOUTS[n]) this.layout = this.LAYOUTS[n];
  }
  revealStart() { const S = this.S; return (S.reveal && S.reveal.start !== undefined) ? S.reveal.start : (S.floatUntil || 0); }

  buildLayout() {
    const ctx = this.measure, { PANE } = this, S = this.S;
    ctx.font = `${TXT.size}px ${this.FONT}`;
    const maxW = PANE.w - TXT.pad * 2; let y = TXT.pad + TXT.size; const msgs = [];
    const sorted = [...S.messages].map((m, i) => ({ ...m, idx: i })).sort((a, b) => a.t - b.t);
    let prevReq = 0;
    for (const m of sorted) {
      const str = m.system ? m.system : `${m.user}> ${m.text}`;
      const glyphs = []; let x = 0, line = 0;
      for (const w of str.split(/(\s+)/)) {
        const ww = [...w].reduce((s, ch) => s + ctx.measureText(ch).width + TXT.track, 0);
        if (x + ww > maxW && x > 0 && w.trim()) { line++; x = 0; }
        if (x === 0 && !w.trim() && line > 0) continue;
        for (const ch of w) { glyphs.push({ ch, x, line }); x += ctx.measureText(ch).width + TXT.track; }
      }
      const lines = line + 1, top = y, bottom = y + (lines - 1) * TXT.lh;
      const req = Math.max(0, bottom + TXT.pad - PANE.h + 14), cps = m.cps || 34;
      glyphs.forEach((g, k) => { g.y = top + g.line * TXT.lh; const spread = Math.min(0.45, 6 / cps);
        g.delay = Math.max(0, k / cps + (hash(m.idx, k, 1) - .5) * 2 * spread); g.dx = hash(m.idx, k, 2) - .5; g.dy = hash(m.idx, k, 3) - .5; });
      msgs.push({ ...m, glyphs, top, bottom, lines, scrollStep: req - prevReq, reveal: glyphs.length / cps + 0.6 });
      prevReq = Math.max(prevReq, req); y = bottom + TXT.lh + 10;
    }
    const users = []; for (const m of msgs) { const u = m.system ? (m.system.match(/^<([^>]+)>/) || [])[1] : m.user; if (u && !users.find(x => x.name === u)) users.push({ name: u, t: m.t }); }
    this.layout = { msgs, users };
  }
  scrollAt(t) { let s = 0; for (const m of this.layout.msgs) { if (m.scrollStep > 0) s += m.scrollStep * easeOut(clamp((t - m.t) / 0.22, 0, 1)); } return s; }

  glyphAnim(m, g, k, t, chaos, frame, scatter) {
    const lt = t - m.t - g.delay; if (lt < 0) return null;
    const p = easeOut(clamp(lt / 0.35, 0, 1));
    let ox = (1 - p) * g.dx * scatter, oy = (1 - p) * g.dy * scatter * .5;
    if (chaos > 0.15) { const j = (chaos - .15) * 4; ox += (hash(frame, m.idx, k) - .5) * j; oy += (hash(frame, k, m.idx) - .5) * j; }
    let ch = g.ch; if (p < .6 && g.ch.trim() && hash(m.idx, k, Math.floor(t * 20)) < .25) ch = String.fromCharCode(33 + Math.floor(hash(k, m.idx, Math.floor(t * 20)) * 60));
    return { ox, oy, a: clamp(p * 1.4, 0, 1), ch };
  }
  glyph(ch, x, y, alpha, color, glow) { const ctx = this.ctx; ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.shadowColor = glow; ctx.shadowBlur = 10; ctx.fillText(ch, x, y); }
  floatY(m, auto) { if (m.fy !== undefined) return m.fy; if (auto) return this.PANE.y + m.top; return 260 + ((m.idx * 137) % 5) * 120; }
  floatAlpha(m, t, auto) { const hold = m.hold !== undefined ? m.hold : (auto ? 1e6 : 1.8); return 1 - clamp((t - (m.t + m.reveal + hold)) / 0.6, 0, 1); }

  roundRect(x, y, w, h, r) { const ctx = this.ctx; ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  drawWindow(a) {
    if (a <= 0) return; const ctx = this.ctx, { WIN, PANE, LIST } = this; ctx.save(); ctx.globalAlpha = a;
    const g = ctx.createLinearGradient(WIN.x, 0, WIN.x + WIN.w, 0);
    g.addColorStop(0, '#1d2025'); g.addColorStop(.03, '#56606b'); g.addColorStop(.055, '#2b3036'); g.addColorStop(.5, '#1a1d21'); g.addColorStop(.945, '#2b3036'); g.addColorStop(.97, '#56606b'); g.addColorStop(1, '#1d2025');
    this.roundRect(WIN.x, WIN.y, WIN.w, WIN.h, 10); ctx.fillStyle = g; ctx.fill();
    this.roundRect(WIN.x + 70, WIN.y + 26, WIN.w - 140, WIN.h - 52, 4); ctx.fillStyle = '#030304'; ctx.fill();
    ctx.strokeStyle = 'rgba(150,165,180,.35)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.strokeStyle = 'rgba(170,185,200,.5)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(WIN.x + 82, WIN.y + 40); ctx.lineTo(WIN.x + WIN.w - 82, WIN.y + 40); ctx.stroke();
    const sx = PANE.x + PANE.w + 20; ctx.strokeStyle = 'rgba(150,170,190,.45)'; ctx.lineWidth = 1.2;
    for (const o of [0, 10]) { ctx.beginPath(); ctx.moveTo(sx + o, PANE.y - 6); ctx.lineTo(sx + o, PANE.y + PANE.h + 50); ctx.stroke(); }
    ctx.fillStyle = 'rgba(120,160,200,.7)'; ctx.fillRect(sx + 2, PANE.y + 8, 6, 22); ctx.fillRect(sx + 2, PANE.y + PANE.h - 10, 6, 22);
    ctx.strokeStyle = 'rgba(150,165,180,.28)'; ctx.lineWidth = 1;
    for (let r = 1; r <= 12; r++) { const yy = LIST.y + 18 + r * TXT.lh; if (yy > LIST.y + LIST.h + 40) break; ctx.beginPath(); ctx.moveTo(LIST.x - 14, yy); ctx.lineTo(LIST.x + LIST.w, yy); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(220,225,230,.85)'; ctx.lineWidth = 2; ctx.strokeRect(WIN.x + WIN.w - 150, WIN.y + 56, 40, 40);
    ctx.fillStyle = 'rgba(220,225,230,.9)'; ctx.fillRect(WIN.x + WIN.w - 142, WIN.y + 64, 6, 26); ctx.fillRect(WIN.x + WIN.w - 142, WIN.y + 64, 18, 6);
    const iy = WIN.y + WIN.h - 110; ctx.strokeStyle = 'rgba(150,165,180,.4)'; ctx.beginPath(); ctx.moveTo(WIN.x + 92, iy); ctx.lineTo(PANE.x + PANE.w, iy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(WIN.x + 92, iy + 64); ctx.lineTo(WIN.x + WIN.w - 170, iy + 64); ctx.stroke();
    ctx.save(); ctx.translate(WIN.x + WIN.w - 130, iy + 46); ctx.rotate(-Math.PI / 4); ctx.fillStyle = 'rgba(200,205,210,.75)'; ctx.fillRect(-16, -4, 28, 8); ctx.beginPath(); ctx.moveTo(12, -4); ctx.lineTo(20, 0); ctx.lineTo(12, 4); ctx.fill(); ctx.restore();
    ctx.restore();
  }
  drawMessages(t, chaos, frame, morphK, auto) {
    const ctx = this.ctx, { PANE } = this;
    const scroll = this.scrollAt(t), scatter = 48 + chaos * 170, fu = this.revealStart();
    ctx.save(); ctx.font = `${TXT.size}px ${this.FONT}`; ctx.textBaseline = 'alphabetic';
    for (const m of this.layout.msgs) {
      if (t < m.t) break;
      const fromFloat = auto && m.t < fu;
      const sy = PANE.y + m.top - scroll; if (!fromFloat && (sy + m.lines * TXT.lh < PANE.y - 60 || sy > PANE.y + PANE.h + 60)) continue;
      const isSys = !!m.system, ghost = (m.user || '').startsWith('%');
      const target = isSys ? COL.sysWin : ghost ? COL.ghost : COL.red;
      const k = fromFloat ? morphK : 1, fa = fromFloat ? this.floatAlpha(m, fu, true) : 1;
      const color = fromFloat ? mix(isSys ? COL.sysFloat : COL.white, target, k) : `rgb(${target})`;
      const glow = isSys ? 'rgba(0,0,0,0)' : `rgba(255,70,50,${.55 * k})`;
      const alphaMul = fromFloat ? lerp(fa, 1, k) : 1;
      for (let gi = 0; gi < m.glyphs.length; gi++) {
        const g = m.glyphs[gi]; const A = this.glyphAnim(m, g, gi, t, chaos, frame, scatter); if (!A) continue;
        const wx = PANE.x + TXT.pad + g.x, wy = PANE.y + g.y - scroll;
        let x = wx, y = wy;
        if (fromFloat) { const fx = PANE.x + TXT.pad + g.x, fy = this.floatY(m, true) + g.line * TXT.lh; const e = easeInOut(k); x = lerp(fx, wx, e); y = lerp(fy, wy, e); }
        if (k >= 1 && (y < PANE.y - 10 || y > PANE.y + PANE.h + TXT.size)) continue;
        this.glyph(A.ch, x + A.ox, y + A.oy, A.a * alphaMul, color, glow);
      }
    }
    ctx.restore(); ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  }
  drawUsers(t, a) {
    if (a <= 0) return; const ctx = this.ctx, { LIST } = this;
    ctx.save(); ctx.font = `${TXT.size}px ${this.FONT}`; ctx.fillStyle = '#E3604E'; ctx.shadowColor = 'rgba(255,70,50,.5)'; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.rect(LIST.x - 10, LIST.y, LIST.w + 10, LIST.h + 60); ctx.clip();
    const shown = this.layout.users.filter(u => u.t <= t), max = Math.floor((LIST.h + 40) / TXT.lh), list = shown.slice(-max);
    list.forEach((u, i) => { ctx.globalAlpha = a * clamp((t - u.t) / 0.3, 0, 1); ctx.fillText(u.name, LIST.x, LIST.y + TXT.size + 8 + i * TXT.lh); });
    ctx.restore();
  }
  drawFloat(t, chaos, frame, auto) {
    const ctx = this.ctx; ctx.save(); ctx.font = `${TXT.size}px ${this.FONT}`; const scatter = 48 + chaos * 170, fu = this.revealStart();
    for (const m of this.layout.msgs) {
      if (t < m.t) break; if (auto && m.t >= fu) continue;
      const fa = this.floatAlpha(m, t, auto); if (fa <= 0) continue;
      const col = `rgb(${m.system ? COL.sysFloat : COL.white})`;
      for (let gi = 0; gi < m.glyphs.length; gi++) { const g = m.glyphs[gi]; const A = this.glyphAnim(m, g, gi, t, chaos, frame, scatter); if (!A) continue;
        this.glyph(A.ch, this.PANE.x + TXT.pad + g.x + A.ox, this.floatY(m, auto) + g.line * TXT.lh + A.oy, A.a * fa, col, 'rgba(255,255,255,.18)'); }
    }
    ctx.restore(); ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  }
  drawCounter(t) {
    const C = this.S.counter, ctx = this.ctx; if (!C || t < C.start || t > C.end + (C.fadeOut !== undefined ? C.fadeOut : 0.9)) return;
    const fi = C.fadeIn !== undefined ? C.fadeIn : 0.7, fo = C.fadeOut !== undefined ? C.fadeOut : 0.9;
    const a = Math.min(fi > 0 ? clamp((t - C.start) / fi, 0, 1) : 1, 1 - clamp((t - C.end) / fo, 0, 1));
    const el = t - C.start, n = Math.floor(el / C.tickEvery), roll = easeInOut(clamp((el - n * C.tickEvery) / Math.min(0.45, C.tickEvery * 0.6), 0, 1));
    const cur = C.from + n, prev = cur - 1, cw = 60, chh = 92, gap = 8, total = 5 * cw + 4 * gap, x0 = W / 2 - total / 2, y0 = H / 2 - chh / 2;
    ctx.save(); ctx.globalAlpha = a;
    for (let i = 0; i < 14; i++) { const ex = x0 - 20 + hash(i, 7, 1) * (total + 40), flick = .5 + .5 * Math.sin(t * 6 + i * 1.7);
      const gr = ctx.createLinearGradient(0, y0 + chh + 30, 0, y0 - 10); gr.addColorStop(0, 'rgba(120,70,20,0)'); gr.addColorStop(.5, `rgba(150,90,30,${.10 + .12 * flick})`); gr.addColorStop(1, 'rgba(150,90,30,0)');
      ctx.fillStyle = gr; ctx.fillRect(ex, y0 - 10, 10 + hash(i, 3, 3) * 14, chh + 40); }
    const ps = String(Math.max(0, prev)).padStart(5, '0'), cs = String(cur).padStart(5, '0');
    ctx.font = `600 76px ${this.FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < 5; i++) { const x = x0 + i * (cw + gap);
      ctx.fillStyle = '#0a0506'; ctx.fillRect(x, y0, cw, chh); ctx.strokeStyle = 'rgba(150,95,50,.55)'; ctx.lineWidth = 1.5; ctx.strokeRect(x, y0, cw, chh);
      ctx.save(); ctx.beginPath(); ctx.rect(x, y0, cw, chh); ctx.clip();
      const draws = (ps[i] !== cs[i] && n > 0) ? [[ps[i], -roll * chh], [cs[i], (1 - roll) * chh]] : [[cs[i], 0]];
      for (const [d, off] of draws) { ctx.shadowColor = 'rgba(230,40,60,.95)'; ctx.shadowBlur = 18; ctx.fillStyle = '#F2C9CF'; ctx.fillText(d, x + cw / 2, y0 + chh / 2 + 4 + off); ctx.shadowBlur = 4; ctx.fillStyle = '#FBE7EA'; ctx.fillText(d, x + cw / 2, y0 + chh / 2 + 4 + off); }
      ctx.restore(); }
    ctx.restore(); ctx.shadowBlur = 0;
  }
  postFX(chaos, frame, SC) {
    if (chaos <= 0.02) return; const ctx = this.ctx, cv = ctx.canvas;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    const bands = Math.floor(chaos * chaos * 9), PW = cv.width, PH = cv.height;
    for (let i = 0; i < bands; i++) { const y = Math.floor(hash(frame, i, 9) * PH), h = Math.floor((6 + hash(frame, i, 8) * 40) * SC), dx = Math.floor((hash(frame, i, 7) - .5) * 120 * chaos * SC); ctx.drawImage(cv, 0, y, PW, h, dx, y, PW, h); }
    ctx.globalAlpha = 0.06 + 0.12 * chaos; ctx.fillStyle = '#fff';
    for (let i = 0; i < 300 * chaos; i++) ctx.fillRect(hash(frame, i, 1) * PW, hash(frame, i, 2) * PH, 2 * SC, 2 * SC);
    ctx.restore();
  }

  /** Draw the chat at time t into ctx. geom 'flat' (1920x1080 frame) or 'tall' (the CRT texture, TEX.th tall).
   *  chrome scales the window/user-list alpha (0 during the reveal crossfade overlay). SC = pixel scale (2 for 4K). */
  render(ctx, t, chaosRaw, { geom = 'flat', alpha = false, chrome = 1, SC = 1 } = {}) {
    this.ctx = ctx; this.setGeom(geom);
    const offY = geom === 'tall' ? this.TEX.offY : 0;
    const frame = Math.round(t * this.fps), chaos = t >= this.cut ? 0 : chaosRaw;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height); if (!alpha) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); }
    ctx.setTransform(SC, 0, 0, SC, 0, offY * SC);
    if (t >= this.cut) { this.setGeom('flat'); return; }
    this.drawCounter(t);
    const auto = this.mode === 'auto', fu = this.revealStart(), S = this.S;
    const sh = chaos > .3 ? (chaos - .3) * 14 : 0; ctx.save(); ctx.translate((hash(frame, 3, 3) - .5) * sh, (hash(frame, 4, 4) - .5) * sh);
    if (this.mode === 'float') this.drawFloat(t, chaos, frame, false);
    else if (auto && t < fu) this.drawFloat(t, chaos, frame, true);
    else {
      const wStart = auto ? fu : ((S.window || {}).start || 0);
      if (t >= wStart) {
        const R = S.reveal || {}, dis = R.dissolve || 0.6, slideAt = fu + (R.slideDelay !== undefined ? R.slideDelay : dis + 0.1), slideDur = R.slide || 0.9;
        const k = auto ? clamp((t - slideAt) / slideDur, 0, 1) : 1;
        const flick = (t - wStart < .3 && hash(frame, 1, 1) < .15) ? .4 : 1;
        const a = (auto ? easeInOut(clamp((t - fu) / dis, 0, 1)) : clamp((t - wStart) / 0.3, 0, 1)) * flick;
        this.drawWindow(a * chrome); this.drawMessages(t, chaos, frame, k, auto); this.drawUsers(t, a * chrome);
      }
    }
    ctx.restore();
    this.postFX(chaos, frame, SC);
    this.setGeom('flat');
  }
}
