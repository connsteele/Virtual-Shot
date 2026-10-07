// Pops layer: short screen-space flashes of text above everything (engine v4.5+ drawPops, ported verbatim).
// Each pop: t, text, dur (s), x/y (0-1, text centre), size (px at 1080p; shrinks to 90% of the frame width unless
// bleed), style flash|red|invert|ghost, mirror, rot (deg), opacity, split (RGB offset px), shake (per-letter px),
// jitter (whole-pop px per frame), slices (glitch bands). Seeded per frame, so frame-exact. Drawn on a transparent canvas.
import { clamp, hash } from '../core/curves.js';

const W = 1920, H = 1080;

export class PopsLayer {
  /** altFrames: frames where each pop's `seedAlt` replaces its `seed` (see the importer). */
  constructor(pops, { fontFamily = 'BP Gothic', cut, fps = 60, altFrames = [] }) {
    this.P = pops || []; this.cut = cut; this.fps = fps; this.alt = new Set(altFrames);
    this.FONT = `"${fontFamily}","IPAPGothic","Segoe UI",sans-serif`;
  }
  /** Draw the pops at time t into a transparent canvas (1920x1080 x SC). Returns true if anything was drawn. */
  render(pctx, t, { SC = 1 } = {}) {
    const pv = pctx.canvas, P = this.P, fps = this.fps;
    pctx.setTransform(1, 0, 0, 1, 0, 0); pctx.clearRect(0, 0, pv.width, pv.height);
    if (!P.length || t >= this.cut) return false;
    const frame = Math.round(t * fps); let any = false;
    const useAlt = this.alt.has(frame);
    P.forEach((p, n) => {
      const i = useAlt ? (p.seedAlt ?? n) : (p.seed ?? n);   // the hash seed: the pop's index in the list it was rendered from
      const dur = p.dur !== undefined ? p.dur : 4 / fps, a = t - p.t; if (a < 0 || a >= dur) return;
      any = true;
      const k = a / dur, st = p.style || 'flash', size = p.size || 120, sh = p.shake !== undefined ? p.shake : 6, jit = p.jitter !== undefined ? p.jitter : 14;
      const drop = hash(frame, i, 25) < (p.dropout !== undefined ? p.dropout : 0.12);
      const op = (p.opacity !== undefined ? p.opacity : 1) * (drop ? 0.3 : 1) * (st === 'ghost' ? 0.35 : 1);
      pctx.save(); pctx.setTransform(SC, 0, 0, SC, 0, 0);
      pctx.font = `${size}px ${this.FONT}`; pctx.textBaseline = 'middle';
      const tr = size * 0.06, chars = [...p.text], ws = chars.map(c => pctx.measureText(c).width + tr), tw = ws.reduce((s, w) => s + w, 0) - tr;
      const fit = (!p.bleed && tw > W * 0.9) ? W * 0.9 / tw : 1, hw = tw * fit / 2, hh = size * 0.62 * fit, mg = W * 0.03;
      let cx = (p.x !== undefined ? p.x : .5) * W, cy = (p.y !== undefined ? p.y : .5) * H;
      if (!p.bleed) { cx = clamp(cx, hw + mg, W - hw - mg); cy = clamp(cy, hh + mg, H - hh - mg); }
      pctx.translate(cx + (hash(frame, i, 21) - .5) * jit, cy + (hash(frame, i, 22) - .5) * jit);
      pctx.rotate(((p.rot || 0) + (hash(frame, i, 23) - .5) * 2) * Math.PI / 180);
      if (p.mirror) pctx.scale(-1, 1);
      if (fit < 1) pctx.scale(fit, fit);
      const glyphs = (fill, dx, dy) => { let x = -tw / 2; chars.forEach((c, j) => { pctx.fillStyle = fill;
        pctx.fillText(c, x + dx + (hash(frame, i * 97 + j, 26) - .5) * sh, dy + (hash(frame, j, 27 + i) - .5) * sh); x += ws[j]; }); };
      pctx.globalAlpha = op;
      if (st === 'invert') { const pad = size * 0.28; pctx.fillStyle = '#f2efe9'; pctx.fillRect(-tw / 2 - pad, -size * 0.62, tw + pad * 2, size * 1.24); glyphs('#050505', 0, 0); }
      else if (st === 'red') { pctx.shadowColor = 'rgba(255,70,50,.85)'; pctx.shadowBlur = 22 * SC; glyphs('#E3604E', 0, 0); pctx.shadowBlur = 0; }
      else { const sp = (p.split !== undefined ? p.split : 8) * (1 - k * 0.5); pctx.globalCompositeOperation = 'lighter';
        glyphs('rgb(255,40,40)', -sp, 0); glyphs('rgb(40,255,90)', 0, 0); glyphs('rgb(60,90,255)', sp, 0); }
      pctx.restore();
    });
    // glitch slices: shift a few horizontal bands of the pops layer sideways
    const n = Math.max(0, ...P.filter(p => t >= p.t && t < p.t + (p.dur !== undefined ? p.dur : 4 / fps)).map(p => p.slices !== undefined ? p.slices : 2));
    for (let s = 0; s < n; s++) { const y = Math.floor(hash(frame, s, 31) * pv.height), h = Math.floor((8 + hash(frame, s, 32) * 50) * SC), dx = Math.floor((hash(frame, s, 33) - .5) * 90 * SC);
      pctx.drawImage(pv, 0, y, pv.width, h, dx, y, pv.width, h); }
    return any;
  }
}
