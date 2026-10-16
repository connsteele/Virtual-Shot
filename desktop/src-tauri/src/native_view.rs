//! Probe: a native wgpu viewport drawn into the Tauri window *under* a transparent WebView2, so the web editor's panels
//! and HUD sit over a renderer that isn't WebGPU (DX12 or Vulkan through wgpu, where ray queries and other native
//! features are available). The page reports the viewport's rectangle and the camera drags; this thread draws at the
//! display's refresh with its own swapchain and keeps frame-interval and input-latency stats.
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Default)]
pub struct ViewState {
    pub rect: [f32; 4],          // x, y, w, h in physical pixels
    pub win: [u32; 2],           // the page's size in physical pixels (the swapchain size)
    pub orbit: [f32; 2],         // accumulated drag
    pub input_epoch_ms: f64,     // when the page saw the latest input (page clock, epoch ms)
    pub pending_input: bool,
    pub intervals: Vec<f64>,     // ms between presents
    pub input_to_submit: Vec<f64>, // page input event -> the frame that used it was submitted (ms)
    pub frames: u64,
    pub backend: String,
    pub error: Option<String>,
    pub status: String,          // what the render loop last did (diagnostics)
    pub skipped: u64,            // swapchain images not acquired
}

const SHADER: &str = r#"
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

pub fn start<W>(window: W, size: impl Fn() -> (u32, u32) + Send + 'static, state: Arc<Mutex<ViewState>>, backends: wgpu::Backends)
where W: raw_window_handle::HasWindowHandle + raw_window_handle::HasDisplayHandle + Send + 'static {
    std::thread::Builder::new().name("native-view".into()).spawn(move || {
        let st = state.clone();
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(window, size, st, backends))) {
            Ok(Err(e)) => state.lock().unwrap().error = Some(e),
            Err(p) => state.lock().unwrap().error = Some(format!("panic: {}", p.downcast_ref::<String>().cloned().or(p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default())),
            Ok(Ok(())) => {}
        }
    }).unwrap();
}

fn run<W>(window: W, size: impl Fn() -> (u32, u32), state: Arc<Mutex<ViewState>>, backends: wgpu::Backends) -> Result<(), String>
where W: raw_window_handle::HasWindowHandle + raw_window_handle::HasDisplayHandle {
    let mut idesc = wgpu::InstanceDescriptor::new_without_display_handle(); idesc.backends = backends;
    let instance = wgpu::Instance::new(idesc);
    let surface = unsafe { instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::from_display_and_window(&window, &window).map_err(|e| e.to_string())?) }
        .map_err(|e| e.to_string())?;
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance, compatible_surface: Some(&surface), ..Default::default() })).map_err(|e| e.to_string())?;
    let (device, queue) = pollster::block_on(adapter.request_device(&Default::default())).map_err(|e| e.to_string())?;
    state.lock().unwrap().backend = format!("{:?} {}", adapter.get_info().backend, adapter.get_info().name);
    state.lock().unwrap().status = "device".into();
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: None, source: wgpu::ShaderSource::Wgsl(SHADER.into()) });
    let caps = surface.get_capabilities(&adapter);
    let format = caps.formats.iter().copied().find(|f| !f.is_srgb()).unwrap_or(caps.formats[0]);
    let pipe = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor { label: None, layout: None,
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), targets: &[Some(format.into())], compilation_options: Default::default() }),
        primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None });
    let ubuf = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 48, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    let bind = device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &pipe.get_bind_group_layout(0),
        entries: &[wgpu::BindGroupEntry { binding: 0, resource: ubuf.as_entire_binding() }] });
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
        let mut u = Vec::with_capacity(48);
        for f in [rect[0], rect[1], rect[2].max(1.0), rect[3].max(1.0), w as f32, h as f32, orbit[0], orbit[1], t0.elapsed().as_secs_f32(), 0.0, 0.0, 0.0] { u.extend_from_slice(&f.to_le_bytes()); }
        queue.write_buffer(&ubuf, 0, &u);
        let view = frame.texture.create_view(&Default::default());
        let mut e = device.create_command_encoder(&Default::default());
        { let mut p = e.begin_render_pass(&wgpu::RenderPassDescriptor { label: None, color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &view, resolve_target: None, depth_slice: None,
              ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })], depth_stencil_attachment: None, timestamp_writes: None, occlusion_query_set: None, multiview_mask: None });
          p.set_pipeline(&pipe); p.set_bind_group(0, &bind, &[]); p.draw(0..3, 0..1); }
        queue.submit([e.finish()]);
        let submitted = super::epoch_ms();
        queue.present(frame);
        let now = Instant::now();
        let mut s = state.lock().unwrap();
        if let Some(l) = last { if s.intervals.len() < 100_000 { s.intervals.push((now - l).as_secs_f64() * 1000.0); } }
        if let Some(t) = input { s.input_to_submit.push(submitted - t); }
        s.frames += 1; last = Some(now);
    }
}
