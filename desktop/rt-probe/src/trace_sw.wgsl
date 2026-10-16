// Software tracer: a binned-SAH BVH built on the CPU, walked with a stack. Plain WGSL, so it runs in Chrome too.
// Interior node: a = right child (left child is the next node), count = 0. Leaf: a = first triangle, count > 0.
struct Node { mn: vec3f, a: u32, mx: vec3f, count: u32 };
@group(0) @binding(3) var<storage, read> nodes: array<Node>;

fn hit_tri(o: vec3f, d: vec3f, i: u32, tmax: f32) -> f32 {
  let v0 = tris[3u * i].xyz; let e1 = tris[3u * i + 1u].xyz - v0; let e2 = tris[3u * i + 2u].xyz - v0;
  let pv = cross(d, e2); let det = dot(e1, pv);
  if (abs(det) < 1e-14) { return -1.0; }
  let inv = 1.0 / det; let tv = o - v0; let u = dot(tv, pv) * inv;
  if (u < 0.0 || u > 1.0) { return -1.0; }
  let qv = cross(tv, e1); let v = dot(d, qv) * inv;
  if (v < 0.0 || u + v > 1.0) { return -1.0; }
  let t = dot(e2, qv) * inv;
  if (t > 1e-5 && t < tmax) { return t; }
  return -1.0;
}
fn box_near(o: vec3f, inv_d: vec3f, mn: vec3f, mx: vec3f, tmax: f32) -> f32 {
  let t0 = (mn - o) * inv_d; let t1 = (mx - o) * inv_d;
  let tn = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
  let tf = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
  if (tf >= max(tn, 0.0) && tn < tmax) { return tn; }
  return 1e30;
}
/// (t, triangle as bits), t < 0 on a miss. `any`: stop at the first hit (shadow rays).
fn trace(o: vec3f, d: vec3f, tmax_in: f32, any: bool) -> vec2f {
  let dd = select(d, vec3f(1e-20), abs(d) < vec3f(1e-20));
  let inv_d = 1.0 / dd;
  var stack: array<u32, 48>; var sp = 1u; stack[0] = 0u;
  var best = tmax_in; var hit = 0xffffffffu;
  while (sp > 0u) {
    sp -= 1u; let ni = stack[sp]; let n = nodes[ni];
    if (box_near(o, inv_d, n.mn, n.mx, best) >= 1e30) { continue; }
    if (n.count > 0u) {
      for (var k = 0u; k < n.count; k++) {
        let t = hit_tri(o, d, n.a + k, best);
        if (t > 0.0) { best = t; hit = n.a + k; if (any) { return vec2f(best, bitcast<f32>(hit)); } }
      }
    } else if (sp + 2u <= 48u) {
      // visit the nearer child first
      let l = nodes[ni + 1u]; let r = nodes[n.a];
      let tl = box_near(o, inv_d, l.mn, l.mx, best); let tr = box_near(o, inv_d, r.mn, r.mx, best);
      if (tl < tr) { stack[sp] = n.a; stack[sp + 1u] = ni + 1u; } else { stack[sp] = ni + 1u; stack[sp + 1u] = n.a; }
      sp += 2u;
    }
  }
  if (hit == 0xffffffffu) { return vec2f(-1.0, 0.0); }
  return vec2f(best, bitcast<f32>(hit));
}
