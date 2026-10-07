// Writes data/test/anim_cube.glb: a 6 cm cube with two baked animations ("Spin": a turn about Y in 2 s; "Hop": up
// and down in 1 s), to test glTF clip playback without touching any real asset. node tools/make_test_clip_glb.mjs
import fs from 'node:fs';

const h = 0.03, faces = [[[1, 0, 0], [0, 1, 0]], [[-1, 0, 0], [0, 1, 0]], [[0, 1, 0], [0, 0, 1]], [[0, -1, 0], [0, 0, 1]], [[0, 0, 1], [1, 0, 0]], [[0, 0, -1], [1, 0, 0]]];
const pos = [], nor = [], idx = [];
for (const [n, u] of faces) {
  const v = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]], b = pos.length / 3;
  for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { pos.push(...[0, 1, 2].map(k => (n[k] + a * u[k] + c * v[k]) * h)); nor.push(...n); }
  idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
}
const spinT = [0, 0.5, 1, 1.5, 2], spinQ = spinT.flatMap(t => { const a = Math.PI * t / 2; return [0, Math.sin(a), 0, Math.cos(a)]; });   // 360° in 2 s
const hopT = [0, 0.5, 1], hopP = [0, 0, 0, 0, 0.05, 0, 0, 0, 0];
const parts = [new Float32Array(pos), new Float32Array(nor), new Uint16Array(idx), new Float32Array(spinT), new Float32Array(spinQ), new Float32Array(hopT), new Float32Array(hopP)];
const views = [], chunks = []; let off = 0;
for (const p of parts) { const b = Buffer.from(p.buffer); views.push({ buffer: 0, byteOffset: off, byteLength: b.length }); chunks.push(b); off += b.length; const pad = (4 - off % 4) % 4; if (pad) { chunks.push(Buffer.alloc(pad)); off += pad; } }
const bin = Buffer.concat(chunks);
const acc = (view, type, count, ct = 5126, extra = {}) => ({ bufferView: view, componentType: ct, count, type, ...extra });
const gltf = {
  asset: { version: '2.0', generator: 'Virtual Shot test' }, scene: 0, scenes: [{ nodes: [0] }],
  nodes: [{ name: 'Cube', mesh: 0, translation: [0, h, 0] }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
  accessors: [acc(0, 'VEC3', 24, 5126, { min: [-h, -h, -h], max: [h, h, h] }), acc(1, 'VEC3', 24), acc(2, 'SCALAR', 36, 5123),
    acc(3, 'SCALAR', 5, 5126, { min: [0], max: [2] }), acc(4, 'VEC4', 5), acc(5, 'SCALAR', 3, 5126, { min: [0], max: [1] }), acc(6, 'VEC3', 3)],
  bufferViews: views, buffers: [{ byteLength: bin.length }],
  animations: [
    { name: 'Spin', samplers: [{ input: 3, output: 4, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 0, path: 'rotation' } }] },
    { name: 'Hop', samplers: [{ input: 5, output: 6, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }] },
  ],
};
// Hop moves the cube relative to its rest translation (h): bake that in
gltf.accessors[6].min = undefined; const hp = new Float32Array(bin.buffer, bin.byteOffset + views[6].byteOffset, 9); for (let i = 0; i < 3; i++) hp[i * 3 + 1] += h;
let json = Buffer.from(JSON.stringify(gltf)); json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
const head = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
head.writeUInt32LE(0x46546C67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
jh.writeUInt32LE(json.length, 0); jh.writeUInt32LE(0x4E4F534A, 4); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004E4942, 4);
fs.mkdirSync(new URL('../data/test/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../data/test/anim_cube.glb', import.meta.url), Buffer.concat([head, jh, json, bh, bin]));
console.log('data/test/anim_cube.glb', 12 + 16 + json.length + bin.length, 'bytes');
