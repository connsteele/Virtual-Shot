// The time core: evaluate(doc, t, geo) -> everything the renderer needs for one frame.
// Pure: the same (doc, geo, t) always gives the same state. `geo` is static geometry derived once from the assets
// (bounds centres, LED part centroids), because some behaviours (focus on an object, the ringing LEDs) need it.
import { clamp, lerp, easeInOut, hash, hex } from './curves.js';
import { trackValue, trackSegment } from './tracks.js';
import { add, sub, scl, dot, cross, nrm, xf, M4, trsOf, frameOf } from './vec.js';

/** Index a document once: objects by id, tracks by "target.prop". */
export function indexDoc(doc) {
  const obj = Object.fromEntries(doc.objects.map(o => [o.id, o]));
  const tracks = Object.fromEntries(doc.tracks.map(tr => [`${tr.target}.${tr.prop}`, tr]));
  const glass = obj.glass ? { ...frameOf(obj.glass.transform), W: obj.glass.size[0], H: obj.glass.size[1] } : null;
  return { obj, tracks, glass };
}

const RIG = ['dist', 'fov', 'x', 'y', 'distort', 'yaw', 'pitch', 'squint'];

/** Camera rig 'glassHeadOn': faces the glass head-on; x/y pan and dist are in glass widths; yaw/pitch turn the view
 *  like a head about a pivot `neck` metres behind the eye. Returns eye/target/up plus the lens overscan. */
export function camPose(ix, cam, c, aspect) {
  const g = ix.glass, W_ = g.W;
  const pan = add(scl(g.r, c.x * W_), scl(g.u, c.y * W_)), e0 = add(add(g.ctr, pan), scl(g.n, c.dist * W_)), f0 = scl(g.n, -1);
  const yw = c.yaw * Math.PI / 180, pt = c.pitch * Math.PI / 180;
  const f1 = add(scl(f0, Math.cos(yw)), scl(g.r, Math.sin(yw))), f = nrm(add(scl(f1, Math.cos(pt)), scl(g.u, -Math.sin(pt))));
  const neck = cam.rig.neck ?? 0.08, eye = add(e0, scl(sub(f, f0), neck));
  const r = nrm(cross(f, g.u)), up = cross(r, f);
  // lens: render wider than the keyed FOV so the barrel warp can pull edge content in (centre keeps the keyed framing)
  const k = Math.max(0, c.distort) * 0.3, ov = 1 + k * (aspect * aspect + 1);
  const fovRender = 2 * Math.atan(Math.tan(c.fov * Math.PI / 360) * ov) * 180 / Math.PI;
  return { eye, target: add(eye, scl(f, c.dist * W_)), up, fov: c.fov, fovRender, k, ov, squint: clamp(c.squint, 0, 1),
    near: cam.clip.near, far: cam.clip.far };
}

function screenPos(pt, vp, k, aspect) { // output-frame uv (0-1, y up) of a world point, through the lens warp
  const c = [0, 1, 2, 3].map(i => vp[i] * pt[0] + vp[4 + i] * pt[1] + vp[8 + i] * pt[2] + vp[12 + i]); const b = [c[0] / c[3], c[1] / c[3]];
  const pb = [b[0] * aspect, b[1]], rc2 = aspect * aspect + 1; let po = pb.slice();
  for (let i = 0; i < 8; i++) { const r2 = po[0] * po[0] + po[1] * po[1], s = (1 + k * rc2) / (1 + k * r2); po = [pb[0] * s, pb[1] * s]; }
  return [po[0] / aspect * .5 + .5, po[1] * .5 + .5];
}

function focusAt(ix, geo, tr, t, eye, vp, k, aspect) {
  if (!tr || !tr.keys.length) return null;
  const point = id => (id === 'glass' ? ix.glass.ctr : geo.centres[id]) || ix.glass.ctr;
  const val = key => { const q = key.v, g = q.target ?? 'glass';
    return { D: 1 / Math.max(1e-3, typeof g === 'number' ? g : Math.hypot(...sub(point(g), eye))), px: q.px || 0, band: q.band ?? 0.05, edge: q.edge || 0,
      spot: q.spot || 0, spotR: q.spotR ?? 0.12, spotF: q.spotF ?? 0.25, sp: (q.spot && typeof g !== 'number') ? screenPos(point(g), vp, k, aspect) : [.5, .5] }; };
  const { a, b, u } = trackSegment(tr, t), A = val(a), B = val(b);
  const sp = A.spot && B.spot ? [lerp(A.sp[0], B.sp[0], u), lerp(A.sp[1], B.sp[1], u)] : (B.spot ? B.sp : A.sp);
  const s = tr.settings || {};
  return { D: lerp(A.D, B.D, u), px: Math.max(0, lerp(A.px, B.px, u)), band: Math.max(0, lerp(A.band, B.band, u)), edge: Math.max(0, lerp(A.edge, B.edge, u)),
    max: s.max || 36, es: s.edgeStart ?? 0.35, spot: Math.max(0, lerp(A.spot, B.spot, u)), spotR: lerp(A.spotR, B.spotR, u), spotF: Math.max(0.01, lerp(A.spotF, B.spotF, u)), sp };
}

/** The remote rings: pulses follow ring.pattern (on, off, ... seconds) from ring.t to the cut. */
function ringAt(doc, wiiObj, geo, t, eye, fps) {
  const Rg = wiiObj && wiiObj.ring; const m = geo.wii;
  if (!Rg || Rg.on === false || !m || t < Rg.t || t >= doc.cut) return null;
  const pat = Rg.pattern || [0.22, 0.12, 0.22, 0.5], cyc = pat.reduce((s, v) => s + v, 0), a = (t - Rg.t) % cyc; let x = 0, lvl = 0, on = false;
  for (let i = 0; i < pat.length; i++) { if (a < x + pat[i]) { const u = a - x; if (i % 2 === 0) { on = true; lvl = Math.min(1, u / 0.025); } else lvl = Math.exp(-u / 0.04); break; } x += pat[i]; }
  const fr = Math.round(t * fps), rb = on ? (Rg.rumble ?? 0.0018) : 0;
  const off = [(hash(fr, 1, 41) - .5) * 2 * rb, (hash(fr, 2, 41) - .5) * 0.6 * rb, (hash(fr, 3, 41) - .5) * 2 * rb];
  const leds = m.leds.map(c0 => add(xf(m.M, c0), off)), ctr = leds.length ? scl(leds.reduce(add, [0, 0, 0]), 1 / leds.length) : m.ctr;
  let rum = null;
  if (rb > 0) { const ax = nrm([hash(fr, 4, 41) - .5, hash(fr, 5, 41) - .5, hash(fr, 6, 41) - .5]), an = (hash(fr, 7, 41) - .5) * 2 * (Rg.rumbleRot ?? 1.5) * Math.PI / 180, s = Math.sin(an / 2);
    rum = Array.from(M4.mul(M4.trs(add(m.ctr, off), [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(an / 2)]), M4.trs(scl(m.ctr, -1)))); }
  return { lvl, on, col: hex(Rg.color || '#FF2A1E').map(v => v / 255), I: Rg.intensity ?? 2.2, ember: Rg.ember ?? 0.06, light: Rg.light ?? 0.9,
    rad: Rg.radius || 0.07, glow: Rg.glow ?? 1, rum, pos: add(ctr, scl(m.up, 0.006)), leds: leds.map(p => add(p, scl(nrm(sub(eye, p)), 0.004))) };
}

/** Ghost flash: fast attack, short hold, decay, with per-frame flicker and dropouts. */
function ghostLevel(g, t, i) {
  const d = g.dur || 0.3, a = t - g.t; if (a < 0 || a > d) return 0; const atk = Math.min(0.035, d * .2), dec = d * .45;
  let e = a < atk ? a / atk : (a > d - dec ? (d - a) / dec : 1); const f = Math.round(t * 60); const fl = hash(f, i + 11, 7);
  if (fl < (g.dropout ?? 0.18)) e *= 0.15; else e *= 0.75 + 0.25 * fl; return e * (g.intensity || 0.3);
}

export function evaluate(doc, t, geo, ix = indexDoc(doc)) {
  const fps = doc.fps, frame = Math.round(t * fps), aspect = doc.output.width / doc.output.height;
  const val = (key, def) => { const tr = ix.tracks[key]; return tr ? trackValue(tr, t) : def; };
  const cam = ix.obj.cam;
  const rig = Object.fromEntries(RIG.map(n => [n, val(`cam.rig.${n}`, ix.tracks[`cam.rig.${n}`]?.default ?? 0)]));
  const chaos = val('scene.params.chaos', doc.params.chaos);
  const R = doc.sequence.reveal, revealK = easeInOut(clamp((t - R.start) / R.duration, 0, 1));
  const pose = camPose(ix, cam, rig, aspect);
  const vp = M4.mul(M4.persp(pose.fovRender * Math.PI / 180, aspect, pose.near, pose.far), M4.look(pose.eye, pose.target, pose.up));
  const L = doc.look.lighting, gl = L.glow;
  const glowCol = gl.base.map((v, i) => v * (gl.chaosGain[0] + gl.chaosGain[1] * chaos) + gl.floor[i]);
  const led = ix.obj.led, ledFlip = dot(led.normal, sub(pose.eye, led.position)) < 0;
  const ghosts = []; (doc.events.ghosts || []).filter(g => g.on !== false).forEach((g, i) => { if (ghosts.length >= 4) return; const lv = ghostLevel(g, t, i); if (lv > 0) ghosts.push({ ...g, level: lv }); });
  return {
    t, frame, cut: t >= doc.cut, rig, chaos, revealK,
    flat: { before: t < R.start, overlay: t < R.start ? 1 : 1 - clamp((t - R.start) / (R.dissolve || 0.6), 0, 1) },
    camera: pose, vp,
    glowCol,
    lighting: { ambient: L.ambient || 0, screen: L.screen ?? 4.5, bounce: L.bounce || 0,
      bouncePos: add(add(ix.glass.ctr, scl(ix.glass.n, L.bounceDist ?? 0.75)), scl(ix.glass.u, 0.05)) },
    led: { pos: led.position, n: ledFlip ? scl(led.normal, -1) : led.normal, color: hex(led.color).map(v => v / 255), intensity: (led.intensity ?? 1) * Math.max(revealK, 0), size: led.size || 1 },
    ring: ringAt(doc, ix.obj.wii, geo, t, pose.eye, fps),
    focus: focusAt(ix, geo, ix.tracks['cam.focus'], t, pose.eye, vp, pose.k, aspect),
    ghosts,
  };
}
