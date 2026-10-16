// Two synthetic full-screen passes shaped like Virtual Shot's two expensive ones, run unchanged by the browser
// (desktop/bench/wgsl_bench.html: Chrome and WebView2 through Dawn) and natively (desktop/wgpu-probe: wgpu on DX12 and
// Vulkan, with and without runtime bounds checks). Same WGSL, same sizes, GPU time from timestamp queries.
//   fs_gather: a depth-of-field-like gather, 256 taps a pixel from a 2880x1620 colour and distance buffer (texture-bound)
//   fs_march:  a haze-like ray march, 96 steps of 4-octave 3D value noise and a 16-light loop indexed at run time (ALU-bound)

struct Params { size: vec2f, src_size: vec2f, time: f32, taps: u32, steps: u32, lights: u32 };
struct Light { pos: vec4f, color: vec4f };

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var color_tex: texture_2d<f32>;
@group(0) @binding(2) var dist_tex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<storage, read> lights: array<Light>;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment fn fs_gather(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let uv = frag.xy / P.size;
  let d0 = textureSampleLevel(dist_tex, samp, uv, 0.0).r * 4.0;   // distance in metres, stored /4 in rgba8
  let coc = clamp(abs(d0 - 1.2) * 18.0, 1.0, 24.0);          // circle of confusion in pixels
  var acc = vec4f(0.0); var wsum = 0.0;
  let golden = 2.39996323;
  for (var k = 0u; k < P.taps; k++) {
    let r = sqrt((f32(k) + 0.5) / f32(P.taps)) * coc;
    let a = f32(k) * golden;
    let o = vec2f(cos(a), sin(a)) * r / P.src_size;
    let c = textureSampleLevel(color_tex, samp, uv + o, 0.0);
    let d = textureSampleLevel(dist_tex, samp, uv + o, 0.0).r * 4.0;
    let w = smoothstep(0.0, 1.0, clamp(abs(d - 1.2) * 18.0 - r + 1.0, 0.0, 1.0)) + 1e-3;
    acc += c * w; wsum += w;
  }
  return acc / wsum;
}

fn hash3(p: vec3f) -> f32 {
  var q = fract(p * 0.1031);
  q += dot(q, q.zyx + 31.32);
  return fract((q.x + q.y) * q.z);
}
fn vnoise(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3f(1, 0, 0)), u.x), mix(hash3(i + vec3f(0, 1, 0)), hash3(i + vec3f(1, 1, 0)), u.x), u.y),
             mix(mix(hash3(i + vec3f(0, 0, 1)), hash3(i + vec3f(1, 0, 1)), u.x), mix(hash3(i + vec3f(0, 1, 1)), hash3(i + vec3f(1, 1, 1)), u.x), u.y), u.z);
}
fn fbm(p0: vec3f) -> f32 {
  var p = p0; var a = 0.5; var s = 0.0;
  for (var o = 0; o < 4; o++) { s += a * vnoise(p); p = p * 2.03 + vec3f(1.7, 9.2, 3.1); a *= 0.5; }
  return s;
}

@fragment fn fs_march(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let uv = frag.xy / P.size * 2.0 - 1.0;
  let ro = vec3f(0.0, 0.0, 2.5);
  let rd = normalize(vec3f(uv.x * P.size.x / P.size.y, -uv.y, -1.8));
  var trans = 1.0; var light = vec3f(0.0);
  let dt = 3.0 / f32(P.steps);
  for (var s = 0u; s < P.steps; s++) {
    let p = ro + rd * (f32(s) + 0.5) * dt;
    let dens = max(fbm(p * 3.0 + vec3f(0.0, 0.0, P.time * 0.1)) - 0.35, 0.0) * 2.0;
    if (dens > 0.0) {
      var l = vec3f(0.0);
      for (var j = 0u; j < P.lights; j++) {          // run-time index into a storage buffer: robustness checks apply
        let L = lights[(j + s) % P.lights];
        let dv = L.pos.xyz - p;
        l += L.color.rgb / (1.0 + dot(dv, dv) * 8.0);
      }
      light += trans * dens * dt * l;
      trans *= exp(-dens * dt * 1.5);
    }
  }
  return vec4f(light, 1.0 - trans);
}
