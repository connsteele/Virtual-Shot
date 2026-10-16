//! Native viewport, replay mode: the Black Page renderer's own GPU work, captured from the browser (desktop/capture),
//! run natively each display frame (the captured frames in order at the shot's 60 fps, looping) and shown letterboxed
//! in the viewport rectangle under the web page.
use crate::native_view::ViewState;
use std::sync::{Arc, Mutex};
use std::time::Instant;

const SHOW_CANVAS: &str = r#"
struct U { rect: vec4f, size: vec2f, orbit: vec2f, time: f32, _a: f32, _b: f32, _c: f32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var img: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let d = vec2f(textureDimensions(img));
  let s = min(u.rect.z / d.x, u.rect.w / d.y);                 // fit the frame inside the viewport
  let o = u.rect.xy + (u.rect.zw - d * s) * 0.5;
  let uv = (frag.xy - o) / (d * s);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  return vec4f(textureSampleLevel(img, smp, uv, 0.0).rgb, 1.0);
}
"#;

pub fn run_replay<W>(window: W, size: impl Fn() -> (u32, u32), state: Arc<Mutex<ViewState>>) -> Result<(), String>
where W: raw_window_handle::HasWindowHandle + raw_window_handle::HasDisplayHandle {
    let path = std::env::var("VS_REPLAY").unwrap_or_else(|_| "G:/Claude/Virtual Legacy/Channel/Virtual Shot spike/rust_tauri/capture/range_play/range_play.json".into());
    state.lock().unwrap().status = format!("loading {path}");
    let cap: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let bin: &'static [u8] = Box::leak(std::fs::read(path.replace(".json", ".bin")).map_err(|e| e.to_string())?.into_boxed_slice());
    let ops: &'static Vec<serde_json::Value> = Box::leak(Box::new(cap["ops"].as_array().cloned().unwrap_or_default()));
    let mut idesc = wgpu::InstanceDescriptor::new_without_display_handle(); idesc.backends = wgpu::Backends::VULKAN;
    let instance = wgpu::Instance::new(idesc);
    let surface = unsafe { instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::from_display_and_window(&window, &window).map_err(|e| e.to_string())?) }.map_err(|e| e.to_string())?;
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, compatible_surface: Some(&surface), ..Default::default() })).map_err(|e| e.to_string())?;
    let features = vs_replay::wanted_features(ops) & adapter.features();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { required_features: features, required_limits: adapter.limits(), ..Default::default() })).map_err(|e| e.to_string())?;
    state.lock().unwrap().backend = format!("{:?} {} (Black Page, replayed natively)", adapter.get_info().backend, adapter.get_info().name);
    let (frames, first) = vs_replay::frame_segments(ops);
    let mut rp = vs_replay::Replay::new(device, queue, bin, ops, false);
    for o in &ops[..first] { rp.exec(o); }
    // run every frame once in order first: later frames use objects that earlier ones created
    for (_, a, b) in &frames { for o in &ops[*a..*b] { rp.exec(o); } }
    let (device, queue) = (rp.device.clone(), rp.queue.clone());
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: None, source: wgpu::ShaderSource::Wgsl(SHOW_CANVAS.into()) });
    let caps = surface.get_capabilities(&adapter);
    let format = caps.formats.iter().copied().find(|f| !f.is_srgb()).unwrap_or(caps.formats[0]);
    let pipe = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor { label: None, layout: None,
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), targets: &[Some(format.into())], compilation_options: Default::default() }),
        primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None });
    let ubuf = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 48, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    let smp = device.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() });
    let cview = rp.canvas.create_view(&Default::default());
    let bind = device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &pipe.get_bind_group_layout(0), entries: &[
        wgpu::BindGroupEntry { binding: 0, resource: ubuf.as_entire_binding() }, wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&cview) },
        wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&smp) }] });
    let mut cur = (0, 0); let t0 = Instant::now(); let mut last: Option<Instant> = None; let mut shown: Option<usize> = None;
    loop {
        let (w, h) = { let wn = state.lock().unwrap().win; if wn[0] > 0 { (wn[0], wn[1]) } else { size() } };
        if w == 0 || h == 0 { std::thread::sleep(std::time::Duration::from_millis(50)); continue; }
        if (w, h) != cur {
            surface.configure(&device, &wgpu::SurfaceConfiguration { usage: wgpu::TextureUsages::RENDER_ATTACHMENT, format, width: w, height: h, present_mode: wgpu::PresentMode::Fifo,
                desired_maximum_frame_latency: 1, alpha_mode: caps.alpha_modes[0], view_formats: vec![], color_space: Default::default() });
            cur = (w, h);
        }
        // the shot frame for this moment (60 fps, looping), rendered natively when it changes
        let k = ((t0.elapsed().as_secs_f64() * 60.0) as usize) % frames.len();
        if shown != Some(k) {
            let (_, a, b) = &frames[k];
            rp.timing = true; for o in &ops[*a..*b] { rp.exec(o); } rp.timing = false;
            let ms: f64 = rp.take_times().iter().map(|x| x.1).sum();
            state.lock().unwrap().gpu_ms.push(ms); shown = Some(k);
        }
        let frame = match surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            _ => { state.lock().unwrap().skipped += 1; std::thread::sleep(std::time::Duration::from_millis(5)); cur = (0, 0); continue; }
        };
        let rect = state.lock().unwrap().rect;
        let mut u = Vec::with_capacity(48);
        for f in [rect[0].floor(), rect[1].floor(), rect[2].max(1.0), rect[3].max(1.0), w as f32, h as f32, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0] { u.extend_from_slice(&f.to_le_bytes()); }
        queue.write_buffer(&ubuf, 0, &u);
        let view = frame.texture.create_view(&Default::default());
        let mut e = device.create_command_encoder(&Default::default());
        { let mut p = e.begin_render_pass(&wgpu::RenderPassDescriptor { label: None, color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &view, resolve_target: None, depth_slice: None,
              ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })], depth_stencil_attachment: None, timestamp_writes: None, occlusion_query_set: None, multiview_mask: None });
          p.set_pipeline(&pipe); p.set_bind_group(0, &bind, &[]); p.draw(0..3, 0..1); }
        queue.submit([e.finish()]);
        queue.present(frame);
        let now = Instant::now();
        let mut s = state.lock().unwrap();
        if let Some(l) = last { s.intervals.push((now - l).as_secs_f64() * 1000.0); }
        s.frames += 1; s.status = format!("shot frame {}", frames[k].0); last = Some(now);
    }
}
