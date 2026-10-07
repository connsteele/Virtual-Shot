// GPU particles as a pure function of time (spike). Every particle's state is computed in closed form in the vertex
// shader from (its instance index, the event's seed, the emitter's params, the event's age): birth time from the index,
// hashed initial direction, size, life and colour, analytic motion (exponential drag, gravity, a swirl offset that is a
// function of age), colour and fade over life. No simulation state, no compute pass: scrubbing, rendering frames out of
// order, Play and Render all give the same particles.
//
// An effect is data: a `particles` event in the scene document ({ kind, t, dur, anchor, offset, seed, ... }); evaluate()
// turns it into { age, origin } for the frame and the renderer draws it (ShotRenderer.setParticles, off by default).
import * as THREE from 'three/webgpu';
import { Fn, uniform, vec2, vec3, vec4, float, uint, uv, exp, sin, cos, pow, clamp, mix, min, max, floor, select, dot,
  instanceIndex, hash, varying, mrt, positionWorld, cameraPosition, smoothstep, texture, screenCoordinate } from 'three/tsl';

const TAU = Math.PI * 2;
const hexRGB = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);

/** Defaults for the one effect kind in the spike: an anime-style spell burst (shockwave rings, spiral sparks, a glowing
 *  core, rising embers). Sizes in metres, times in seconds from the event's start. Any of these can be set on the event. */
export const SPELL_DEFAULTS = {
  dur: 2.4, seed: 1, scale: 1, density: 1, intensity: 1, distWrite: true,
  colors: { hot: '#FFFFFF', a: '#5FE8FF', b: '#8A3CFF', ember: '#FF5AA8' },
  sparks: { count: 64000, emit: 1.1, life: [0.55, 1.35], radius: 0.075, rise: 0.22, spin: 7, arms: 3, size: 0.0021, swirl: 0.006, gravity: 0.05 },
  ring: { count: 36000, delays: [0, 0.22, 0.5], radius: 0.16, k: 5, life: [0.45, 0.85], size: 0.0013, thick: 0.004 },
  core: { count: 48, size: 0.07, life: 2.0 },
  embers: { count: 16000, life: [0.9, 2.0], rise: 0.09, spread: 0.06, size: 0.0011, swirl: 0.02 },
};
const merge = (a, b) => { const o = { ...a }; for (const [k, v] of Object.entries(b || {})) o[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] ? merge(a[k], v) : v; return o; };
export const spellParams = ev => merge(SPELL_DEFAULTS, ev);
/** Total particle count of an event (for stats). */
export const particleCount = ev => { const p = spellParams(ev), d = p.density; return ['sparks', 'ring', 'core', 'embers'].reduce((s, k) => s + Math.round(p[k].count * (k === 'core' ? 1 : d)), 0); };

/** The effect as a light (research): a point light at the core whose level follows the core's closed-form envelope
 *  (flash, sustain, out) plus the sparks' early burst, so it is a pure function of age like the particles. Colour goes
 *  from hot (the flash) to colour a. Returns { level, color: [r, g, b], radius } (display values, radius in metres). */
export function spellLight(ev, age) {
  const P = spellParams(ev), C = P.colors, L = P.core.life, a = age;
  if (a < 0 || a > Math.max(L, P.dur)) return { level: 0, color: [0, 0, 0], radius: 1 };
  const ss = (e0, e1, x) => { const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t); };
  const env = Math.min(a * 14, 1) * (1 - ss(L * 0.55, L, a)) * 0.85, flash = Math.exp(-9 * a) * 1.6 + 0.35;
  const sparks = Math.min(a * 10, 1) * Math.exp(-1.6 * a) * 0.6;
  const hot = hexRGB(C.hot), ca = hexRGB(C.a), f = Math.min(1, Math.exp(-6 * a));
  return { level: (env * flash + sparks) * P.intensity, color: ca.map((v, i) => v + (hot[i] - v) * f), radius: (P.light?.radius ?? 0.12) * P.scale };
}

/**
 * Build the sprites for one particles event. Returns { group, U, update(state) } where state = { age, origin }.
 * Each layer is one THREE.Sprite drawn `count` times (SpriteNodeMaterial billboards it; positionNode/scaleNode are
 * per instance). Dead or unborn particles get scale 0: their quads collapse and draw no fragments.
 */
export function makeSpell(ev, { distTex, invSize, soft = 0.01 }) {
  const P = spellParams(ev), C = P.colors, D = P.density, S = P.scale;
  const U = { age: uniform(0), origin: uniform(new THREE.Vector3()), intensity: uniform(P.intensity),
    hot: uniform(new THREE.Vector3(...hexRGB(C.hot))), a: uniform(new THREE.Vector3(...hexRGB(C.a))), b: uniform(new THREE.Vector3(...hexRGB(C.b))), ember: uniform(new THREE.Vector3(...hexRGB(C.ember))) };
  const group = new THREE.Group(); group.matrixAutoUpdate = false;
  let salt = (P.seed * 0x9E3779B1) >>> 0;
  // per-particle random number k (0..1): PCG hash of the index offset by a per-layer, per-number constant
  const rnd = () => { salt = (salt + 0x6C8E9CF5) >>> 0; const s = salt; return hash(instanceIndex.add(uint(s))); };
  // the sprite's look: a hot centre and a soft halo, additive; distance written only where it is solid (see below)
  const layer = (name, count, build, { halo = 0.25, core = 12, writeDist = false } = {}) => {
    if (count <= 0) return;
    // no depth buffer: the particle buffer is single-sampled (see ShotRenderer.fxFor), so the scene's depth is tested
    // here against its resolved distance pass, softly (soft particles: a fade over `soft` metres where a sprite meets a surface)
    const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, depthTest: false, sizeAttenuation: true,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor });
    const o = build();   // { pos: vec3 world, size: float metres (0 = dead), col: vec3 (premultiplied by alpha) }
    m.positionNode = o.pos; m.scaleNode = vec2(o.size, o.size);
    const col = varying(o.col, `v_${name}_col`);
    const q = uv().mul(2).sub(1), d = dot(q, q), g = exp(d.mul(-core)).add(exp(d.mul(-3)).mul(halo)).mul(float(1).sub(d).max(0));
    const zs = texture(distTex, screenCoordinate.xy.mul(invSize)).level(0), sceneD = select(zs.r.lessThanEqual(0), float(1e3), zs.r.div(max(zs.g, 1)));
    const pd = positionWorld.distance(cameraPosition), vis = clamp(sceneD.sub(pd).div(soft), 0, 1);
    m.outputNode = vec4(col.mul(g).mul(U.intensity).mul(vis), 1);
    // distance pass (min-blended, see ShotRenderer.fxMRT): the solid centre of a spark is a surface for the depth of
    // field and the haze; its halo and the soft core sprites are not (they write the far value, a no-op under min)
    const far = float(1e4);
    m.mrtNode = mrt({ dist: writeDist && P.distWrite ? vec4(select(d.lessThan(0.15).and(vis.greaterThan(0.5)), pd, far), far, 0, 1) : vec4(far, far, 0, 1) });
    const s = new THREE.Sprite(m); s.count = count; s.frustumCulled = false; s.name = `particles:${name}`; s.matrixAutoUpdate = false;
    group.add(s);
  };
  const life01 = (a, life) => clamp(a.div(life), 0, 1);
  const alive = (a, life) => a.greaterThanEqual(0).and(a.lessThan(life));
  // colour over life: hot -> colour a -> colour b, with a quick fade in and a slower fade out
  const overLife = (u, a, c0, c1, c2, pow_ = 1.5) => {
    const c = mix(mix(c0, c1, smoothstep(0.0, 0.25, u)), c2, smoothstep(0.35, 1.0, u));
    return c.mul(pow(float(1).sub(u), pow_)).mul(min(a.mul(25), 1));
  };
  // a swirl offset that depends only on age and hashed phases (curl-like wobble growing with age)
  const swirl = (a, amp, r1, r2, r3) => {
    const w = a.mul(amp);
    return vec3(sin(a.mul(9).add(r1.mul(TAU))).mul(sin(a.mul(4.3).add(r2.mul(TAU)))), sin(a.mul(7.1).add(r2.mul(TAU))).mul(0.6), cos(a.mul(8.3).add(r3.mul(TAU))).mul(sin(a.mul(5.7).add(r1.mul(TAU))))).mul(w);
  };

  // 1. spiral sparks: born front-loaded over `emit`, flung out along `arms` spiral arms that spin and rise
  const SP = P.sparks;
  layer('sparks', Math.round(SP.count * D), () => {
    const h0 = rnd(), h1 = rnd(), h2 = rnd(), h3 = rnd(), h4 = rnd(), h5 = rnd(), h6 = rnd(), h7 = rnd(), h8 = rnd(), h9 = rnd();
    const birth = pow(h0, 1.6).mul(SP.emit), a = U.age.sub(birth), life = mix(SP.life[0], SP.life[1], h1);
    const arm = floor(h2.mul(SP.arms)), th0 = arm.mul(TAU / SP.arms).add(h3.sub(0.5).mul(0.22)).add(birth.mul(5));
    const spin = mix(0.7, 1.3, h4).mul(SP.spin), drag = 2.2;
    const out = float(1).sub(exp(a.mul(-drag))).div(drag);   // integral of e^(-drag a): distance under drag
    const r = mix(0.75, 1.05, h5).mul(SP.radius * S).mul(float(0.15).add(out.mul(drag).mul(0.85)));
    const th = th0.add(spin.mul(out).mul(drag).mul(1.4)).add(a.mul(spin).mul(0.3));
    const y = mix(0.7, 1.15, h6).mul(SP.rise * S).mul(out).sub(a.mul(a).mul(0.5 * SP.gravity * S));
    const pos = U.origin.add(vec3(cos(th).mul(r), y, sin(th).mul(r))).add(swirl(a, SP.swirl * S, h7, h8, h9));
    const u = life01(a, life), ok = alive(a, life);
    const tw = sin(a.mul(40).add(h9.mul(TAU))).mul(0.25).add(0.75);   // twinkle
    const size = select(ok, mix(0.5, 1.6, h7).mul(SP.size * S).mul(pow(float(1).sub(u), 0.4)).mul(tw), float(0));
    const tint = mix(select(arm.mod(2).equal(0), U.a, U.b), U.ember, h8.mul(h8).mul(0.5));   // alternate arms cyan / violet
    return { pos, size, col: overLife(u, a, U.hot, tint, U.b).mul(0.7) };
  }, { halo: 0.3, core: 10, writeDist: true });

  // 2. shockwave rings: a burst of particles on a horizontal circle that rushes out and slows (1 - e^-ka)
  const RG = P.ring, nR = RG.delays.length;
  layer('ring', Math.round(RG.count * D), () => {
    const h0 = rnd(), h1 = rnd(), h2 = rnd(), h3 = rnd(), h4 = rnd();
    const ri = instanceIndex.mod(uint(nR)).toFloat();
    let delay = float(RG.delays[0]); for (let k = 1; k < nR; k++) delay = select(ri.equal(float(k)), float(RG.delays[k]), delay);
    const birth = delay.add(h0.mul(0.03)), a = U.age.sub(birth), life = mix(RG.life[0], RG.life[1], h1).mul(float(1).sub(ri.mul(0.15)));
    const k_ = RG.k, grow = float(1).sub(exp(a.mul(-k_))).div(1 - Math.exp(-k_ * 0.9));
    const rad = grow.mul(RG.radius * S).mul(float(1).sub(ri.mul(0.22))).add(h2.sub(0.5).mul(RG.thick * S).mul(grow.add(0.3)));
    const th = h3.mul(TAU), y = h4.sub(0.5).mul(RG.thick * S * 0.6).add(a.mul(0.02 * S)).add(ri.mul(0.012 * S));
    const pos = U.origin.add(vec3(cos(th).mul(rad), y, sin(th).mul(rad)));
    const u = life01(a, life), ok = alive(a, life);
    const size = select(ok, mix(0.6, 1.4, h2).mul(RG.size * S).mul(float(1.4).sub(u)), float(0));
    return { pos, size, col: overLife(u, a, U.hot, mix(U.a, U.hot, 0.25), U.b, 2.0) };
  }, { halo: 0.2, core: 14, writeDist: true });

  // 3. glowing core: a few big soft sprites, a flash at the start, a pulsing sustain, then out
  const CO = P.core;
  layer('core', CO.count, () => {
    const h0 = rnd(), h1 = rnd(), h2 = rnd(), h3 = rnd();
    const a = U.age, L = float(CO.life);
    const env = min(a.mul(14), 1).mul(float(1).sub(smoothstep(L.mul(0.55), L, a))).mul(sin(a.mul(18).add(h1.mul(TAU))).mul(0.15).add(0.85));
    const flash = exp(a.mul(-9)).mul(1.6).add(0.35);
    const off = vec3(h1.sub(0.5), h2.sub(0.5).mul(0.6).add(0.2), h3.sub(0.5)).mul(0.02 * S);
    const ok = a.greaterThanEqual(0).and(a.lessThan(L));
    const size = select(ok, mix(0.35, 1.0, h0).mul(CO.size * S).mul(flash.mul(0.5).add(0.6)), float(0));
    const col = mix(U.a, U.hot, h0.mul(h0)).mul(env).mul(flash).mul(0.045);
    return { pos: U.origin.add(off), size, col };
  }, { halo: 0.6, core: 5 });

  // 4. embers: born over the whole effect, drift up with drag and wobble, small and pink
  const EM = P.embers;
  layer('embers', Math.round(EM.count * D), () => {
    const h0 = rnd(), h1 = rnd(), h2 = rnd(), h3 = rnd(), h4 = rnd(), h5 = rnd(), h6 = rnd();
    const birth = h0.mul(Math.max(0.1, P.dur - EM.life[0])), a = U.age.sub(birth), life = mix(EM.life[0], EM.life[1], h1);
    const th = h2.mul(TAU), r0 = pow(h3, 0.5).mul(EM.spread * S), drag = 1.2, out = float(1).sub(exp(a.mul(-drag))).div(drag);
    const pos = U.origin.add(vec3(cos(th).mul(r0.add(out.mul(0.02 * S))), out.mul(EM.rise * S * 2).add(a.mul(EM.rise * S * 0.3)), sin(th).mul(r0.add(out.mul(0.02 * S)))))
      .add(swirl(a, EM.swirl * S, h4, h5, h6));
    const u = life01(a, life), ok = alive(a, life);
    const size = select(ok, mix(0.5, 1.5, h4).mul(EM.size * S), float(0));
    return { pos, size, col: overLife(u, a, U.hot, U.ember, U.b, 1.2).mul(0.8) };
  }, { halo: 0.35, core: 9, writeDist: true });

  return {
    group, U, params: P, count: group.children.reduce((s, c) => s + c.count, 0),
    update({ age, origin }) { U.age.value = age; U.origin.value.set(...origin); },
    dispose() { group.children.forEach(s => s.material.dispose()); },   // sprites share three's one quad geometry
  };
}
