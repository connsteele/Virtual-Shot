//! Probe: a native wgpu viewport drawn into the Tauri window *under* a transparent WebView2, so the web editor's panels
//! and HUD sit over a renderer that isn't WebGPU (DX12 or Vulkan through wgpu, where ray queries and other native
//! features are available). The page reports the viewport's rectangle and the camera drags; this thread draws at the
//! display's refresh with its own swapchain and keeps frame-interval and input-latency stats.
//! Modes: a test pattern (`dx12`, `vulkan`), or `rt`: the Black Page geometry (exported by bench.js `exportGeometry`)
//! with soft shadows from the CRT glass, hardware ray-traced every frame on Vulkan, orbiting with the page's drags.
use std::sync::{Arc, Mutex};
use std::time::Instant;
use wgpu::util::DeviceExt;

#[derive(Default)]
pub struct ViewState {
    pub rect: [f32; 4],          // x, y, w, h in physical pixels
    pub win: [u32; 2],           // the page's size in physical pixels (the swapchain size)
    pub orbit: [f32; 2],         // accumulated drag
    pub input_epoch_ms: f64,     // when the page saw the latest input (page clock, epoch ms)
    pub pending_input: bool,
    pub intervals: Vec<f64>,     // ms between presents
    pub input_to_submit: Vec<f64>, // page input event -> the frame that used it was submitted (ms)
    pub gpu_ms: Vec<f64>,        // GPU time of the ray-traced pass (rt mode)
    pub frames: u64,
    pub backend: String,
    pub error: Option<String>,
    pub status: String,          // what the render loop last did (diagnostics)
    pub skipped: u64,            // swapchain images not acquired
}

const PATTERN: &str = r#"
struct U { rect: vec4f, size: vec2f, orbit: vec2f, time: f32, _a: f32, _b: f32, _c: f32 };
@group(0) @binding(0) var<uniform> u: U;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  // a test pattern that moves with time and the dragged orbit: a rotating checker on a gradient, inside the viewport
  let uv = (frag.xy - u.rect.xy) / u.rect.zw;
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return vec4f(0.08, 0.02, 0.02, 1.0); }  // outside: dark red
  let a = u.orbit.x * 0.01 + u.time * 0.3;
  let c = (uv - 0.5) * vec2f(u.rect.z / u.rect.w, 1.0);
  let r = vec2f(c.x * cos(a) - c.y * sin(a), c.x * sin(a) + c.y * cos(a)) * (8.0 + u.orbit.y * 0.02);
  let chk = f32((i32(floor(r.x)) + i32(floor(r.y))) & 1);
  return vec4f(mix(vec3f(0.1, 0.3, 0.6), vec3f(0.9, 0.7, 0.2), uv.y) * (0.6 + 0.4 * chk), 1.0);
}
"#;

/// rt mode: shows the ray tracer's output buffer (one radiance value per pixel of the viewport rectangle), tone-mapped.
const BLIT: &str = r#"
struct U { rect: vec4f, size: vec2f, orbit: vec2f, time: f32, _a: f32, _b: f32, _c: f32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> px: array<vec4f>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let q = vec2i(floor(frag.xy - u.rect.xy));
  if (any(q < vec2i(0)) || any(q >= vec2i(u.rect.zw))) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let x = px[u32(q.y) * u32(u.rect.z) + u32(q.x)].x * 6.0;
  return vec4f(vec3f(pow(x / (1.0 + x), 1.0 / 2.2)), 1.0);
}
"#;

pub fn start<W>(window: W, size: impl Fn() -> (u32, u32) + Send + 'static, state: Arc<Mutex<ViewState>>, mode: String)
where W: raw_window_handle::HasWindowHandle + raw_window_handle::HasDisplayHandle + Send + 'static {
    std::thread::Builder::new().name("native-view".into()).spawn(move || {
        let st = state.clone();
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| if mode == "replay" { crate::native_replay::run_replay(window, size, st) } else { run(window, size, st, &mode) })) {
            Ok(Err(e)) => state.lock().unwrap().error = Some(e),
            Err(p) => state.lock().unwrap().error = Some(format!("panic: {}", p.downcast_ref::<String>().cloned().or(p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default())),
            Ok(Ok(())) => {}
        }
    }).unwrap();
}

/// The ray-traced view: geometry in a hardware acceleration structure, the probe's shading (desktop/rt-probe) per frame.
struct Rt {
    pipe: wgpu::ComputePipeline,
    tbuf: wgpu::Buffer,
    tlas: wgpu::Tlas,
    pbuf: wgpu::Buffer,
    cam: [[f32; 3]; 4],          // position, right, up, forward of the exported shot camera
    ty: f32,                     // tan(half vertical fov)
    glass: Vec<f32>,             // the glass rows of Params (4 × vec4)
    out: Option<(wgpu::Buffer, u32, u32)>,
    qs: wgpu::QuerySet, qres: wgpu::Buffer, qread: wgpu::Buffer,
    mapping: Arc<std::sync::atomic::AtomicBool>,   // the timestamp readback buffer is being mapped
}

fn load_rt(device: &wgpu::Device, queue: &wgpu::Queue, json_path: &str) -> Result<Rt, String> {
    let meta: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(json_path).map_err(|e| format!("{json_path}: {e}"))?).map_err(|e| e.to_string())?;
    let bin = std::fs::read(json_path.replace(".json", ".bin")).map_err(|e| e.to_string())?;
    let nv = meta["vertices"].as_u64().unwrap() as usize; let nt = meta["triangles"].as_u64().unwrap() as usize;
    let f = |i: usize| f32::from_le_bytes(bin[i * 4..i * 4 + 4].try_into().unwrap());
    let ix = |i: usize| u32::from_le_bytes(bin[nv * 12 + i * 4..nv * 12 + i * 4 + 4].try_into().unwrap()) as usize;
    let mut tris: Vec<f32> = Vec::with_capacity(nt * 12); let mut pos: Vec<f32> = Vec::with_capacity(nt * 9);
    for t in 0..nt { for c in 0..3 { let v = ix(3 * t + c); tris.extend_from_slice(&[f(3 * v), f(3 * v + 1), f(3 * v + 2), 0.0]); pos.extend_from_slice(&[f(3 * v), f(3 * v + 1), f(3 * v + 2)]); } }
    let m: Vec<f32> = meta["camera"]["matrixWorld"].as_array().unwrap().iter().map(|x| x.as_f64().unwrap() as f32).collect();
    let half = (meta["camera"]["fov"].as_f64().unwrap() as f32).to_radians() * 0.5;
    let g = &meta["glass"]; let gv = |k: &str| -> [f32; 3] { let a = g[k].as_array().unwrap(); [a[0].as_f64().unwrap() as f32, a[1].as_f64().unwrap() as f32, a[2].as_f64().unwrap() as f32] };
    let mut glass = Vec::new();
    for (v, w) in [(gv("ctr"), 0.0), (gv("r"), g["W"].as_f64().unwrap() as f32), (gv("u"), g["H"].as_f64().unwrap() as f32), (gv("n"), 0.0)] { glass.extend_from_slice(&[v[0], v[1], v[2], w]); }
    let bytes = |v: &[f32]| v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>();
    let tbuf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: &bytes(&tris), usage: wgpu::BufferUsages::STORAGE });
    let vb = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: &bytes(&pos), usage: wgpu::BufferUsages::BLAS_INPUT });
    let size = wgpu::BlasTriangleGeometrySizeDescriptor { vertex_format: wgpu::VertexFormat::Float32x3, vertex_count: (nt * 3) as u32, index_format: None, index_count: None,
        flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE };
    let blas = device.create_blas(&wgpu::CreateBlasDescriptor { label: None, flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE, update_mode: wgpu::AccelerationStructureUpdateMode::Build },
        wgpu::BlasGeometrySizeDescriptors::Triangles { descriptors: vec![size.clone()] });
    let mut tlas = device.create_tlas(&wgpu::CreateTlasDescriptor { label: None, max_instances: 1, flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE, update_mode: wgpu::AccelerationStructureUpdateMode::Build });
    tlas[0] = Some(wgpu::TlasInstance::new(&blas, [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0], 0, 0xff));
    let mut e = device.create_command_encoder(&Default::default());
    e.build_acceleration_structures([&wgpu::BlasBuildEntry { blas: &blas, geometry: wgpu::BlasGeometries::TriangleGeometries(vec![wgpu::BlasTriangleGeometry {
        size: &size, vertex_buffer: &vb, first_vertex: 0, vertex_stride: 12, index_buffer: None, first_index: None, transform_buffer: None, transform_buffer_offset: None }]) }], [&tlas]);
    queue.submit([e.finish()]);
    let src = format!("enable wgpu_ray_query;\n{}", include_str!("../../rt-probe/src/shade.wgsl").replace("//TRACER", include_str!("../../rt-probe/src/trace_hw.wgsl")));
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("rt"), source: wgpu::ShaderSource::Wgsl(src.into()) });
    let pipe = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor { label: Some("rt"), layout: None, module: &module, entry_point: Some("main"), compilation_options: Default::default(), cache: None });
    let pbuf = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 144, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    let qs = device.create_query_set(&wgpu::QuerySetDescriptor { label: None, ty: wgpu::QueryType::Timestamp, count: 2 });
    let qres = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 16, usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
    let qread = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 16, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    Ok(Rt { pipe, tbuf, tlas, pbuf, cam: [[m[12], m[13], m[14]], [m[0], m[1], m[2]], [m[4], m[5], m[6]], [-m[8], -m[9], -m[10]]], ty: half.tan(), glass, out: None, qs, qres, qread, mapping: Default::default() })
}

/// Orbit the exported camera around a point 0.6 m ahead of it: yaw about world up, pitch about the camera's right.
fn orbit_cam(c: &[[f32; 3]; 4], orbit: [f32; 2]) -> [[f32; 3]; 4] {
    let rot = |v: [f32; 3], axis: [f32; 3], a: f32| { let (s, co) = a.sin_cos(); let d = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2];
        let cr = [axis[1] * v[2] - axis[2] * v[1], axis[2] * v[0] - axis[0] * v[2], axis[0] * v[1] - axis[1] * v[0]];
        [0, 1, 2].map(|k| v[k] * co + cr[k] * s + axis[k] * d * (1.0 - co)) };
    let pivot = [0, 1, 2].map(|k| c[0][k] + c[3][k] * 0.6);
    let (yaw, pitch) = (-orbit[0] * 0.004, -orbit[1] * 0.004);
    let off = [0, 1, 2].map(|k| c[0][k] - pivot[k]);
    let r1 = rot(c[1], [0.0, 1.0, 0.0], yaw);
    let f = |v: [f32; 3]| rot(rot(v, [0.0, 1.0, 0.0], yaw), r1, pitch);
    let o = f(off);
    [[0, 1, 2].map(|k| pivot[k] + o[k]), r1, f(c[2]), f(c[3])]
}

fn run<W>(window: W, size: impl Fn() -> (u32, u32), state: Arc<Mutex<ViewState>>, mode: &str) -> Result<(), String>
where W: raw_window_handle::HasWindowHandle + raw_window_handle::HasDisplayHandle {
    let rt_mode = mode == "rt";
    let mut idesc = wgpu::InstanceDescriptor::new_without_display_handle();
    idesc.backends = if mode == "dx12" { wgpu::Backends::DX12 } else { wgpu::Backends::VULKAN };
    let instance = wgpu::Instance::new(idesc);
    let surface = unsafe { instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::from_display_and_window(&window, &window).map_err(|e| e.to_string())?) }
        .map_err(|e| e.to_string())?;
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance, compatible_surface: Some(&surface), ..Default::default() })).map_err(|e| e.to_string())?;
    let features = if rt_mode { wgpu::Features::EXPERIMENTAL_RAY_QUERY | wgpu::Features::TIMESTAMP_QUERY } else { wgpu::Features::empty() };
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { required_features: features, required_limits: adapter.limits(),
        experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() }, ..Default::default() })).map_err(|e| e.to_string())?;
    state.lock().unwrap().backend = format!("{:?} {}{}", adapter.get_info().backend, adapter.get_info().name, if rt_mode { " (ray-traced)" } else { "" });
    let mut rt = if rt_mode {
        let path = std::env::var("VS_RT_GEOM").unwrap_or_else(|_| "G:/Claude/Virtual Legacy/Channel/Virtual Shot spike/rust_tauri/rt/black_page_f450.json".into());
        Some(load_rt(&device, &queue, &path)?)
    } else { None };
    let period = queue.get_timestamp_period() as f64;
    state.lock().unwrap().status = "device".into();
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: None, source: wgpu::ShaderSource::Wgsl(if rt_mode { BLIT } else { PATTERN }.into()) });
    let caps = surface.get_capabilities(&adapter);
    let format = caps.formats.iter().copied().find(|f| !f.is_srgb()).unwrap_or(caps.formats[0]);
    let pipe = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor { label: None, layout: None,
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), targets: &[Some(format.into())], compilation_options: Default::default() }),
        primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None });
    let ubuf = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 48, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    let mut binds: Option<(wgpu::BindGroup, Option<wgpu::BindGroup>)> = None;
    state.lock().unwrap().status = "pipeline".into();
    let mut cur = (0, 0);
    let t0 = Instant::now(); let mut last: Option<Instant> = None;
    loop {
        let (w, h) = { let wn = state.lock().unwrap().win; if wn[0] > 0 { (wn[0], wn[1]) } else { size() } };
        state.lock().unwrap().status = format!("size {w}x{h}");
        if w == 0 || h == 0 { std::thread::sleep(std::time::Duration::from_millis(50)); continue; }
        if (w, h) != cur {
            surface.configure(&device, &wgpu::SurfaceConfiguration { usage: wgpu::TextureUsages::RENDER_ATTACHMENT, format, width: w, height: h,
                present_mode: wgpu::PresentMode::Fifo, desired_maximum_frame_latency: 1, alpha_mode: caps.alpha_modes[0], view_formats: vec![], color_space: Default::default() });
            cur = (w, h);
        }
        let frame = match surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            other => { let mut st = state.lock().unwrap(); st.skipped += 1; st.status = format!("acquire: {}", match other {
                    wgpu::CurrentSurfaceTexture::Timeout => "timeout", wgpu::CurrentSurfaceTexture::Occluded => "occluded",
                    wgpu::CurrentSurfaceTexture::Outdated => "outdated", wgpu::CurrentSurfaceTexture::Lost => "lost", _ => "other" });
                drop(st); std::thread::sleep(std::time::Duration::from_millis(5)); cur = (0, 0); continue; }
        };
        let (rect, orbit, input) = { let mut s = state.lock().unwrap(); let i = if s.pending_input { s.pending_input = false; Some(s.input_epoch_ms) } else { None }; (s.rect, s.orbit, i) };
        let (vw, vh) = ((rect[2].max(1.0)) as u32, (rect[3].max(1.0)) as u32);
        let mut u = Vec::with_capacity(48);
        for f in [rect[0].floor(), rect[1].floor(), vw as f32, vh as f32, w as f32, h as f32, orbit[0], orbit[1], t0.elapsed().as_secs_f32(), 0.0, 0.0, 0.0] { u.extend_from_slice(&f.to_le_bytes()); }
        queue.write_buffer(&ubuf, 0, &u);
        let mut e = device.create_command_encoder(&Default::default());
        if let Some(r) = rt.as_mut() {
            // (re)allocate the output for the viewport's size, then trace it
            if r.out.as_ref().map(|o| (o.1, o.2)) != Some((vw, vh)) {
                let ob = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: (vw * vh * 16) as u64, usage: wgpu::BufferUsages::STORAGE, mapped_at_creation: false });
                r.out = Some((ob, vw, vh)); binds = None;
            }
            let c = orbit_cam(&r.cam, orbit); let tx = r.ty * vw as f32 / vh as f32;
            let mut p: Vec<u8> = Vec::with_capacity(144);
            for (v, w4) in [(c[0], 0.0), (c[1], tx), (c[2], r.ty), (c[3], 0.0)] { for x in [v[0], v[1], v[2], w4] { p.extend_from_slice(&x.to_le_bytes()); } }
            for x in &r.glass { p.extend_from_slice(&x.to_le_bytes()); }
            for x in [vw, vh, 16u32, 0] { p.extend_from_slice(&x.to_le_bytes()); }
            queue.write_buffer(&r.pbuf, 0, &p);
            if binds.is_none() {
                let ob = &r.out.as_ref().unwrap().0;
                let rtb = device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &r.pipe.get_bind_group_layout(0), entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: r.pbuf.as_entire_binding() }, wgpu::BindGroupEntry { binding: 1, resource: r.tbuf.as_entire_binding() },
                    wgpu::BindGroupEntry { binding: 2, resource: ob.as_entire_binding() }, wgpu::BindGroupEntry { binding: 3, resource: r.tlas.as_binding() }] });
                let bb = device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &pipe.get_bind_group_layout(0), entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: ubuf.as_entire_binding() }, wgpu::BindGroupEntry { binding: 1, resource: ob.as_entire_binding() }] });
                binds = Some((bb, Some(rtb)));
            }
            { let mut cp = e.begin_compute_pass(&wgpu::ComputePassDescriptor { label: None,
                  timestamp_writes: Some(wgpu::ComputePassTimestampWrites { query_set: &r.qs, beginning_of_pass_write_index: Some(0), end_of_pass_write_index: Some(1) }) });
              cp.set_pipeline(&r.pipe); cp.set_bind_group(0, binds.as_ref().unwrap().1.as_ref().unwrap(), &[]); cp.dispatch_workgroups(vw.div_ceil(8), vh.div_ceil(8), 1); }
            e.resolve_query_set(&r.qs, 0..2, &r.qres, 0);
            if !r.mapping.load(std::sync::atomic::Ordering::Acquire) { e.copy_buffer_to_buffer(&r.qres, 0, &r.qread, 0, 16); }
        } else if binds.is_none() {
            binds = Some((device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &pipe.get_bind_group_layout(0),
                entries: &[wgpu::BindGroupEntry { binding: 0, resource: ubuf.as_entire_binding() }] }), None));
        }
        let view = frame.texture.create_view(&Default::default());
        { let mut p = e.begin_render_pass(&wgpu::RenderPassDescriptor { label: None, color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &view, resolve_target: None, depth_slice: None,
              ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })], depth_stencil_attachment: None, timestamp_writes: None, occlusion_query_set: None, multiview_mask: None });
          p.set_pipeline(&pipe); p.set_bind_group(0, &binds.as_ref().unwrap().0, &[]); p.draw(0..3, 0..1); }
        queue.submit([e.finish()]);
        let submitted = super::epoch_ms();
        queue.present(frame);
        // read the ray-traced pass's GPU time without stalling: map when free, collect when mapped
        if let Some(r) = rt.as_ref() {
            if !r.mapping.swap(true, std::sync::atomic::Ordering::AcqRel) {
                let st = state.clone(); let qr = r.qread.clone(); let flag = r.mapping.clone();
                r.qread.slice(..).map_async(wgpu::MapMode::Read, move |res| { if res.is_ok() {
                    if let Ok(v) = qr.slice(..).get_mapped_range() { let t: Vec<u64> = v.chunks_exact(8).map(|c| u64::from_le_bytes(c.try_into().unwrap())).collect();
                        if t[1] > t[0] { st.lock().unwrap().gpu_ms.push((t[1] - t[0]) as f64 * period / 1e6); } }
                    qr.unmap(); } flag.store(false, std::sync::atomic::Ordering::Release); });
            }
            let _ = device.poll(wgpu::PollType::Poll);
        }
        let now = Instant::now();
        let mut s = state.lock().unwrap();
        if let Some(l) = last { if s.intervals.len() < 100_000 { s.intervals.push((now - l).as_secs_f64() * 1000.0); } }
        if let Some(t) = input { s.input_to_submit.push(submitted - t); }
        s.frames += 1; last = Some(now);
    }
}
