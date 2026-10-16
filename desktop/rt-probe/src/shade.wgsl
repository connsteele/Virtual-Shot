// Soft shadows from the CRT glass (an area light) on the Black Page geometry: one primary ray a pixel, then `samples`
// shadow rays to stratified points on the glass. The tracer is either hardware ray queries (TRACE_HW, native only:
// WebGPU has no ray tracing) or a software BVH walk that also runs in a browser (TRACE_SW). Everything else is shared.

struct Params {
  cam_pos: vec4f, cam_right: vec4f, cam_up: vec4f, cam_fwd: vec4f,     // right.w = tan(half fov x), up.w = tan(half fov y)
  glass_ctr: vec4f, glass_r: vec4f, glass_u: vec4f, glass_n: vec4f,   // r.w = width, u.w = height
  size: vec2u, samples: u32, ntris: u32,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> tris: array<vec4f>;          // 3 vertices per triangle (xyz, w unused)
@group(0) @binding(2) var<storage, read_write> out_px: array<vec4f>;

//TRACER

fn rnd(seed: ptr<function, u32>) -> f32 {
  *seed = *seed * 747796405u + 2891336453u;
  let w = ((*seed >> ((*seed >> 28u) + 4u)) ^ *seed) * 277803737u;
  return f32((w >> 22u) ^ w) / 4294967296.0;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= P.size.x || gid.y >= P.size.y) { return; }
  let ndc = (vec2f(gid.xy) + 0.5) / vec2f(P.size) * 2.0 - 1.0;
  let d = normalize(P.cam_fwd.xyz + P.cam_right.xyz * (ndc.x * P.cam_right.w) - P.cam_up.xyz * (ndc.y * P.cam_up.w));
  let o = P.cam_pos.xyz;
  let h = trace(o, d, 1e30, false);
  var c = 0.0;
  if (h.x > 0.0) {
    let i = bitcast<u32>(h.y);
    let v0 = tris[3u * i].xyz;
    var n = normalize(cross(tris[3u * i + 1u].xyz - v0, tris[3u * i + 2u].xyz - v0));
    if (dot(n, d) > 0.0) { n = -n; }
    let p = o + d * h.x + n * 2e-4;
    var seed = gid.x * 1973u + gid.y * 9277u + 26699u;
    let s1 = max(1u, u32(sqrt(f32(P.samples))));
    var lit = 0.0;
    for (var s = 0u; s < P.samples; s++) {
      let sx = (f32(s % s1) + rnd(&seed)) / f32(s1);
      let sy = (f32(s / s1) + rnd(&seed)) / f32(s1);
      let q = P.glass_ctr.xyz + P.glass_r.xyz * ((sx - 0.5) * P.glass_r.w) + P.glass_u.xyz * ((sy - 0.5) * P.glass_u.w);
      let L = q - p; let dist = length(L); let ld = L / dist;
      let cs = dot(n, ld); let cl = dot(P.glass_n.xyz, -ld);
      if (cs <= 0.0 || cl <= 0.0) { continue; }
      if (trace(p, ld, dist * 0.999, true).x < 0.0) { lit += cs * cl / (dist * dist); }
    }
    c = lit * P.glass_r.w * P.glass_u.w / f32(P.samples);
  }
  out_px[gid.y * P.size.x + gid.x] = vec4f(c, c, c, 1.0);
}
