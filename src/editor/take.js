// Gamepad camera takes (Unreal's Virtual Camera / a game's free cam, recorded): press Record take, fly the shot
// camera's rig with a gamepad while the shot plays in real time, then stop. The recorded rig values (one sample per
// shot frame) are thinned to Bézier keys (core/fit.js) and written over the take's time range as ONE undoable command.
// Sticks and triggers drive rates, so the camera keeps its pose when you let go:
//   left stick  pan X / Y (glass widths per second)      right stick  yaw / pitch (degrees per second)
//   triggers    dolly out (LT) / in (RT), geometric       bumpers      zoom out (LB) / in (RB), geometric FOV
//   A           stop the take and write keys              B           cancel it (nothing is written)
import { fitKeys, fitError } from '../core/fit.js';
import { COMMANDS } from '../core/commands.js';

const RATES = { x: 0.25, y: 0.18, yaw: 25, pitch: 18, dolly: 0.6, zoom: 0.5 };
const TOL = { x: 0.002, y: 0.002, yaw: 0.05, pitch: 0.05, dist: 0.004, fov: 0.05 };   // thinning tolerance per property
const dz = v => Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88;           // stick dead zone
const PROPS = ['x', 'y', 'yaw', 'pitch', 'dist', 'fov'];

export class Take {
  constructor(E) { this.E = E; this.on = false; }
  pad() { return [...(navigator.getGamepads?.() || [])].find(p => p && p.connected) || null; }
  start() {
    const E = this.E; if (this.on) return false;
    if (!this.pad()) { E.status('Take: connect a gamepad and press a button on it first'); return false; }
    if (E.playing) E.togglePlay();
    if (E.frame >= E.last) E.frame = 0;
    this.rig = { ...E.state().rig }; this.samples = []; this.on = true; this.prev = null; this.lastF = -1;
    E.over = { rig: { ...this.rig } }; E.perf?.note('take start'); E.emit('take', true); E.togglePlay();
    const tick = now => { if (!this.on) return; this.poll(now); requestAnimationFrame(tick); };
    requestAnimationFrame(tick); return true;
  }
  poll(now) {
    const E = this.E, p = this.pad(), dt = this.prev ? Math.min(0.1, (now - this.prev) / 1000) : 0; this.prev = now;
    if (p) {
      const a = i => dz(p.axes[i] || 0), b = i => p.buttons[i] ? (p.buttons[i].value ?? (p.buttons[i].pressed ? 1 : 0)) : 0, R = this.rig;
      R.x += a(0) * RATES.x * dt; R.y -= a(1) * RATES.y * dt; R.yaw += a(2) * RATES.yaw * dt; R.pitch += a(3) * RATES.pitch * dt;
      R.dist *= Math.exp((b(6) - b(7)) * RATES.dolly * dt); R.fov = Math.min(120, Math.max(1, R.fov * Math.exp((b(4) - b(5)) * RATES.zoom * dt)));
      if (b(1) > 0.5) { this.stop(false); return; }
      if (b(0) > 0.5 && this.samples.length > 10) { this.stop(true); return; }
    }
    E.over = { rig: { ...this.rig } };
    if (E.frame !== this.lastF) { this.samples.push({ f: E.frame, rig: { ...this.rig } }); this.lastF = E.frame; }
    if (!E.playing) this.stop(true);   // reached the end of the shot
  }
  /** Stop recording; keep = write the take as keys. Returns a summary per property (samples, keys, fit error). */
  stop(keep = true) {
    const E = this.E; if (!this.on) return null; this.on = false; if (E.playing) E.togglePlay();
    E.over = null; E.emit('take', false);
    const S = this.samples; if (!keep || S.length < 2) { E.status('Take cancelled'); E.requestRender(); return null; }
    this.last = S; const summary = this.write(S);
    E.status(`Take: ${S.length} frames → ${Object.values(summary).reduce((s, x) => s + x.keys, 0)} keys`); return summary;
  }
  /** Fit samples [{f, rig}] to keys and write them over the take's range (one undoable step). Exposed for scripts. */
  write(S) {
    const E = this.E, fps = E.fps, t0 = S[0].f / fps, t1 = S[S.length - 1].f / fps, before = E.cmd.begin(), summary = {};
    for (const p of PROPS) {
      const ser = S.map(s => ({ t: s.f / fps, v: s.rig[p] })), lo = Math.min(...ser.map(s => s.v)), hi = Math.max(...ser.map(s => s.v));
      if (hi - lo < TOL[p]) continue;   // untouched by this take
      const keys = fitKeys(ser, TOL[p]);
      COMMANDS.setKey(E.doc, { target: 'cam', prop: 'rig.' + p, t: t0, v: ser[0].v });   // makes the track if needed (geometric for dist/fov)
      const tr = E.doc.tracks.find(t => t.target === 'cam' && t.prop === 'rig.' + p);
      tr.keys = [...tr.keys.filter(k => k.t < t0 - 1e-6 || k.t > t1 + 1e-6), ...keys].sort((a, b) => a.t - b.t);
      summary[p] = { samples: ser.length, keys: keys.length, err: +fitError(keys, ser).toFixed(5) };
    }
    E.cmd.commit('cameraTake', before); return summary;
  }
}
