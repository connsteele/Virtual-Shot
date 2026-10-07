// Blender/Cycles 4D Perlin noise and the Noise Texture node (fBm, normalized, distortion), ported to TSL so the
// in-engine haze has the same density field Cycles rendered. Source: Blender v5.1.0
// intern/cycles/kernel/svm/{noise.h, fractal_noise.h, noisetex.h} and intern/cycles/util/hash.h (Apache-2.0).
import { Fn, uint, int, float, vec4, floor, select, abs } from 'three/tsl';

// ---- JS side: Jenkins lookup3 (hash_uint2) for the distortion seeds, exactly as Cycles computes them in float32 ----
const rotl = (x, k) => ((x << k) | (x >>> (32 - k))) >>> 0;
function final3(a, b, c) {
  c = (c ^ b) >>> 0; c = (c - rotl(b, 14)) >>> 0; a = (a ^ c) >>> 0; a = (a - rotl(c, 11)) >>> 0;
  b = (b ^ a) >>> 0; b = (b - rotl(a, 25)) >>> 0; c = (c ^ b) >>> 0; c = (c - rotl(b, 16)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rotl(c, 4)) >>> 0; b = (b ^ a) >>> 0; b = (b - rotl(a, 14)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rotl(b, 24)) >>> 0; return c;
}
function hashUint2JS(kx, ky) { let a, b, c; a = b = c = (0xdeadbeef + (2 << 2) + 13) >>> 0; b = (b + ky) >>> 0; a = (a + kx) >>> 0; return final3(a, b, c); }
const f32 = Math.fround, asUint = x => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, x); return b.getUint32(0); };
const hashFloat2ToFloat = (x, y) => f32(f32(hashUint2JS(asUint(x), asUint(y))) * f32(1 / 4294967295));
/** random_float4_offset(seed): components in [100, 200]. */
export const randomFloat4Offset = seed => [0, 1, 2, 3].map(j => f32(100 + f32(hashFloat2ToFloat(seed, j) * 100)));

// ---- TSL side ----
const U = v => uint(v);
const rot = (x, k) => x.shiftLeft(U(k)).bitOr(x.shiftRight(U(32 - k)));

/** hash_uint4 (lookup3 mix + final), unsigned 32-bit arithmetic. */
const hashUint4 = Fn(([kx, ky, kz, kw]) => {
  const init = U(0xdeadbeef + (4 << 2) + 13);
  const a = init.add(kx).toVar(), b = init.add(ky).toVar(), c = init.add(kz).toVar();
  a.subAssign(c); a.bitXorAssign(rot(c, 4)); c.addAssign(b);
  b.subAssign(a); b.bitXorAssign(rot(a, 6)); a.addAssign(c);
  c.subAssign(b); c.bitXorAssign(rot(b, 8)); b.addAssign(a);
  a.subAssign(c); a.bitXorAssign(rot(c, 16)); c.addAssign(b);
  b.subAssign(a); b.bitXorAssign(rot(a, 19)); a.addAssign(c);
  c.subAssign(b); c.bitXorAssign(rot(b, 4)); b.addAssign(a);
  a.addAssign(kw);
  c.bitXorAssign(b); c.subAssign(rot(b, 14)); a.bitXorAssign(c); a.subAssign(rot(c, 11));
  b.bitXorAssign(a); b.subAssign(rot(a, 25)); c.bitXorAssign(b); c.subAssign(rot(b, 16));
  a.bitXorAssign(c); a.subAssign(rot(c, 4)); b.bitXorAssign(a); b.subAssign(rot(a, 14));
  c.bitXorAssign(b); c.subAssign(rot(b, 24));
  return c;
}, { kx: 'uint', ky: 'uint', kz: 'uint', kw: 'uint', return: 'uint' });

const negIf = (v, h, bit) => select(h.bitAnd(U(bit)).notEqual(U(0)), v.negate(), v);
/** grad4: gradient dot product for a 4D lattice corner. */
const grad4 = Fn(([hash, x, y, z, w]) => {
  const h = hash.bitAnd(U(31));
  const u = select(h.lessThan(U(24)), x, y), v = select(h.lessThan(U(16)), y, z), s = select(h.lessThan(U(8)), z, w);
  return negIf(u, h, 1).add(negIf(v, h, 2)).add(negIf(s, h, 4));
}, { hash: 'uint', x: 'float', y: 'float', z: 'float', w: 'float', return: 'float' });

const fade = t => t.mul(t).mul(t).mul(t.mul(t.mul(6).sub(15)).add(10));
const triMix = (v, x, y, z) => { const x1 = float(1).sub(x), y1 = float(1).sub(y), z1 = float(1).sub(z);
  return z1.mul(y1.mul(v[0].mul(x1).add(v[1].mul(x))).add(y.mul(v[2].mul(x1).add(v[3].mul(x)))))
    .add(z.mul(y1.mul(v[4].mul(x1).add(v[5].mul(x))).add(y.mul(v[6].mul(x1).add(v[7].mul(x)))))); };

/** perlin_4d */
export const perlin4 = Fn(([p]) => {
  const fl = floor(p), f = p.sub(fl);
  const X = uint(int(fl.x)), Y = uint(int(fl.y)), Z = uint(int(fl.z)), W = uint(int(fl.w));
  const v = [];
  for (let i = 0; i < 16; i++) {
    const dx = i & 1, dy = (i >> 1) & 1, dz = (i >> 2) & 1, dw = (i >> 3) & 1;
    v.push(grad4(hashUint4(dx ? X.add(U(1)) : X, dy ? Y.add(U(1)) : Y, dz ? Z.add(U(1)) : Z, dw ? W.add(U(1)) : W),
      dx ? f.x.sub(1) : f.x, dy ? f.y.sub(1) : f.y, dz ? f.z.sub(1) : f.z, dw ? f.w.sub(1) : f.w));
  }
  const u = fade(f.x), vv = fade(f.y), t = fade(f.z), s = fade(f.w);
  const a = triMix(v.slice(0, 8), u, vv, t), b = triMix(v.slice(8), u, vv, t);
  return a.add(s.mul(b.sub(a)));
}, { p: 'vec4', return: 'float' });

export const snoise4 = p => perlin4(p).mul(0.8344);

/** noise_fbm (normalized), detail = whole number of extra octaves (detail 4 = 5 octaves), lacunarity 2. */
export function fbm4(p, detail, roughness) {
  let sum = null, amp = 1, maxamp = 0, fscale = 1;
  for (let i = 0; i <= detail; i++) {
    const t = snoise4(fscale === 1 ? p : p.mul(fscale)).mul(amp);
    sum = sum ? sum.add(t) : t; maxamp += amp; amp *= roughness; fscale *= 2;
  }
  return sum.mul(0.5 / maxamp).add(0.5);
}

const OFF = [0, 1, 2, 3].map(randomFloat4Offset);
/** noise_texture_4d value output: optional distortion, then fBm. */
export function noiseTex4(p, { detail, roughness, distortion = 0 }) {
  let q = p;
  if (distortion !== 0) q = p.add(vec4(...OFF.map(o => snoise4(p.add(vec4(...o))))).mul(distortion));
  return fbm4(q, detail, roughness);
}
export const absf = abs;
