//! The native half of the browser-vs-native GPU probe: desktop/bench/probe.wgsl with the same sizes and data as
//! desktop/bench/wgsl_bench.html, through wgpu on DX12 and Vulkan, with runtime bounds checks on (what the browser
//! must do) and off (what a trusted native app may do). GPU time from timestamp queries; prints JSON.
//!   cargo run --release -- [reps=40]
use std::time::Instant;
use wgpu::util::DeviceExt;

const W: u32 = 1920;
const H: u32 = 1080;
const SW: u32 = 2880;
const SH: u32 = 1620;

fn noise_bytes(n: usize, seed: u32) -> Vec<u8> {
    let mut x = seed;
    (0..n).map(|_| { x ^= x << 13; x ^= x >> 17; x ^= x << 5; (x & 255) as u8 }).collect()
}
fn dist_bytes() -> Vec<u8> {
    let mut b = noise_bytes((SW * SH * 4) as usize, 7);
    for y in 0..SH { for x in 0..SW {
        let i = ((y * SW + x) * 4) as usize;
        b[i] = (((x as f32 / SW as f32 * 200.0).floor() as u32) + (b[i] as u32 % 56)).min(255) as u8;
    } }
    b
}

fn run(backend: wgpu::Backends, checked: bool, reps: u32) -> Result<serde_json::Value, String> {
    let mut idesc = wgpu::InstanceDescriptor::new_without_display_handle();
    idesc.backends = backend;
    let instance = wgpu::Instance::new(idesc);
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() })).map_err(|e| e.to_string())?;
    let info = adapter.get_info();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: None, required_features: wgpu::Features::TIMESTAMP_QUERY, ..Default::default() })).map_err(|e| e.to_string())?;
    let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../bench/probe.wgsl")).map_err(|e| e.to_string())?;
    let desc = wgpu::ShaderModuleDescriptor { label: Some("probe"), source: wgpu::ShaderSource::Wgsl(src.into()) };
    let t_compile = Instant::now();
    let module = if checked { device.create_shader_module(desc) }
        else { unsafe { device.create_shader_module_trusted(desc, wgpu::ShaderRuntimeChecks::unchecked()) } };

    let tex = |data: &[u8]| device.create_texture_with_data(&queue, &wgpu::TextureDescriptor {
        label: None, size: wgpu::Extent3d { width: SW, height: SH, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
        dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm, usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[] }, wgpu::util::TextureDataOrder::LayerMajor, data);
    let color = tex(&noise_bytes((SW * SH * 4) as usize, 1));
    let dist = tex(&dist_bytes());
    let mut params = Vec::new();
    for f in [W as f32, H as f32, SW as f32, SH as f32, 0.5] { params.extend_from_slice(&f.to_le_bytes()); }
    for u in [256u32, 96, 16] { params.extend_from_slice(&u.to_le_bytes()); }
    let params = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: &params, usage: wgpu::BufferUsages::UNIFORM });
    let mut ld = Vec::new();
    for j in 0..16 { let jf = j as f32;
        for f in [jf.cos() * 0.8, (jf * 1.3).sin() * 0.5, -0.5 - jf * 0.1, 1.0, 0.5 + (j % 3) as f32 * 0.2, 0.4, 0.3 + (j % 5) as f32 * 0.1, 1.0] {
            ld.extend_from_slice(&(f as f32).to_le_bytes()); } }
    let lights = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: &ld, usage: wgpu::BufferUsages::STORAGE });
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor { mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, ..Default::default() });
    let target = device.create_texture(&wgpu::TextureDescriptor { label: None, size: wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 },
        mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT, view_formats: &[] });
    let view = target.create_view(&Default::default());
    let period = queue.get_timestamp_period() as f64; // ns per tick

    let mut out = serde_json::json!({ "backend": format!("{:?}", info.backend), "adapter": info.name, "driver": info.driver_info,
        "runtime_checks": checked, "reps": reps });
    for entry in ["fs_gather", "fs_march"] {
        let pipe = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some(entry), layout: None,
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), buffers: &[], compilation_options: Default::default() },
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some(entry), compilation_options: Default::default(),
                targets: &[Some(wgpu::TextureFormat::Rgba16Float.into())] }),
            primitive: Default::default(), depth_stencil: None, multisample: Default::default(), multiview_mask: None, cache: None });
        let cv = color.create_view(&Default::default()); let dv = dist.create_view(&Default::default());
        let mut entries = vec![wgpu::BindGroupEntry { binding: 0, resource: params.as_entire_binding() }];
        if entry == "fs_gather" {
            entries.push(wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&cv) });
            entries.push(wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&dv) });
            entries.push(wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(&sampler) });
        } else {
            entries.push(wgpu::BindGroupEntry { binding: 4, resource: lights.as_entire_binding() });
        }
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &pipe.get_bind_group_layout(0), entries: &entries });
        let qs = device.create_query_set(&wgpu::QuerySetDescriptor { label: None, ty: wgpu::QueryType::Timestamp, count: 2 * reps });
        let resolve = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 16 * reps as u64, usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
        let read = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 16 * reps as u64, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        let pass = |enc: &mut wgpu::CommandEncoder, ts: Option<u32>| {
            let mut p = enc.begin_render_pass(&wgpu::RenderPassDescriptor { label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &view, resolve_target: None, depth_slice: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } })],
                depth_stencil_attachment: None, occlusion_query_set: None, multiview_mask: None,
                timestamp_writes: ts.map(|r| wgpu::RenderPassTimestampWrites { query_set: &qs, beginning_of_pass_write_index: Some(2 * r), end_of_pass_write_index: Some(2 * r + 1) }) });
            p.set_pipeline(&pipe); p.set_bind_group(0, &bind, &[]); p.draw(0..3, 0..1);
        };
        for _ in 0..10 { let mut e = device.create_command_encoder(&Default::default()); pass(&mut e, None); queue.submit([e.finish()]); }
        device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| e.to_string())?;
        let t0 = Instant::now();
        for r in 0..reps { let mut e = device.create_command_encoder(&Default::default()); pass(&mut e, Some(r)); queue.submit([e.finish()]); }
        let mut e = device.create_command_encoder(&Default::default());
        e.resolve_query_set(&qs, 0..2 * reps, &resolve, 0); e.copy_buffer_to_buffer(&resolve, 0, &read, 0, 16 * reps as u64);
        queue.submit([e.finish()]);
        read.slice(..).map_async(wgpu::MapMode::Read, |_| {});
        device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| e.to_string())?;
        let wall = t0.elapsed().as_secs_f64() * 1000.0;
        let ts: Vec<u64> = read.slice(..).get_mapped_range().map_err(|e| format!("{e:?}"))?.chunks_exact(8).map(|c| u64::from_le_bytes(c.try_into().unwrap())).collect();
        let mut ms: Vec<f64> = (0..reps as usize).map(|r| (ts[2 * r + 1] - ts[2 * r]) as f64 * period / 1e6).collect();
        ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let r3 = |x: f64| (x * 1000.0).round() / 1000.0;
        out[entry] = serde_json::json!({ "median_ms": r3(ms[ms.len() / 2]), "min_ms": r3(ms[0]), "p90_ms": r3(ms[ms.len() * 9 / 10]), "wall_ms_per_pass": r3(wall / reps as f64) });
    }
    out["setup_ms"] = (t_compile.elapsed().as_secs_f64() * 1000.0).round().into();
    Ok(out)
}

fn main() {
    let reps = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(40);
    let mut all = Vec::new();
    for (name, b) in [("dx12", wgpu::Backends::DX12), ("vulkan", wgpu::Backends::VULKAN)] {
        for checked in [true, false] {
            match run(b, checked, reps) {
                Ok(v) => { eprintln!("{name} checked={checked}: gather {} ms, march {} ms", v["fs_gather"]["median_ms"], v["fs_march"]["median_ms"]); all.push(v) }
                Err(e) => { eprintln!("{name} checked={checked}: {e}"); all.push(serde_json::json!({ "backend": name, "runtime_checks": checked, "error": e })) }
            }
        }
    }
    println!("{}", serde_json::to_string_pretty(&all).unwrap());
}
