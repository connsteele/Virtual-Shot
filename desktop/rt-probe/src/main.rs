//! Ray-traced soft shadows from the CRT glass on the Black Page geometry (exported from the editor by
//! desktop/bench/bench.js `exportGeometry`), traced two ways with the same shading code:
//!   hw: hardware ray queries (wgpu EXPERIMENTAL_RAY_QUERY; DX12 inline ray tracing / Vulkan ray query). Native only.
//!   sw: a software BVH walk in plain WGSL, which a browser's WebGPU can run too (desktop/bench/rt_bench.html).
//! Each triangle can be split into 4^k to stand in for denser assets. GPU time from timestamp queries; images and the
//! browser's inputs (BVH, triangles, params, WGSL) are written for comparison.
//!   cargo run --release -- <geometry.json> [--k=0,3,5] [--samples=16] [--reps=20] [--backend=dx12|vulkan]
//!       [--out=<dir for PNGs>] [--browser=<dir for the browser's inputs>]
use std::time::Instant;
use wgpu::util::DeviceExt;

const W: u32 = 1920;
const H: u32 = 1080;

type V3 = [f32; 3];
fn sub(a: V3, b: V3) -> V3 { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
fn mid(a: V3, b: V3) -> V3 { [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5] }

#[derive(Clone, Copy)]
struct Tri { v: [V3; 3], c: V3 }

#[repr(C)]
#[derive(Clone, Copy)]
struct Node { mn: V3, a: u32, mx: V3, count: u32 }

fn bounds(ts: &[Tri]) -> (V3, V3) {
    let (mut mn, mut mx) = ([f32::MAX; 3], [f32::MIN; 3]);
    for t in ts { for v in &t.v { for k in 0..3 { mn[k] = mn[k].min(v[k]); mx[k] = mx[k].max(v[k]); } } }
    (mn, mx)
}
fn area(mn: V3, mx: V3) -> f32 { let d = sub(mx, mn); if d[0] < 0.0 { return 0.0 } 2.0 * (d[0] * d[1] + d[1] * d[2] + d[2] * d[0]) }

/// Binned SAH BVH, depth-first: an interior node's left child is the next node, `a` is the right child.
fn build(ts: &mut [Tri], first: usize, nodes: &mut Vec<Node>, depth: u32, max_depth: &mut u32) -> u32 {
    *max_depth = (*max_depth).max(depth);
    let (mn, mx) = bounds(ts);
    let idx = nodes.len() as u32;
    nodes.push(Node { mn, a: first as u32, mx, count: ts.len() as u32 });
    let n = ts.len();
    if n <= 4 || depth >= 40 { return idx; }
    let (mut cmn, mut cmx) = ([f32::MAX; 3], [f32::MIN; 3]);
    for t in ts.iter() { for k in 0..3 { cmn[k] = cmn[k].min(t.c[k]); cmx[k] = cmx[k].max(t.c[k]); } }
    const B: usize = 12;
    let mut best = (f32::MAX, 0usize, 0usize); // cost, axis, split bin
    for ax in 0..3 {
        let ext = cmx[ax] - cmn[ax];
        if ext <= 1e-9 { continue; }
        let mut cnt = [0usize; B]; let mut bb = [([f32::MAX; 3], [f32::MIN; 3]); B];
        for t in ts.iter() {
            let b = (((t.c[ax] - cmn[ax]) / ext * B as f32) as usize).min(B - 1);
            cnt[b] += 1;
            for v in &t.v { for k in 0..3 { bb[b].0[k] = bb[b].0[k].min(v[k]); bb[b].1[k] = bb[b].1[k].max(v[k]); } }
        }
        for s in 1..B {
            let (mut l, mut r) = (([f32::MAX; 3], [f32::MIN; 3]), ([f32::MAX; 3], [f32::MIN; 3]));
            let (mut nl, mut nr) = (0, 0);
            for b in 0..B {
                let tgt = if b < s { nl += cnt[b]; &mut l } else { nr += cnt[b]; &mut r };
                for k in 0..3 { tgt.0[k] = tgt.0[k].min(bb[b].0[k]); tgt.1[k] = tgt.1[k].max(bb[b].1[k]); }
            }
            if nl == 0 || nr == 0 { continue; }
            let cost = nl as f32 * area(l.0, l.1) + nr as f32 * area(r.0, r.1);
            if cost < best.0 { best = (cost, ax, s); }
        }
    }
    let mut m;
    if best.0 < f32::MAX {
        let (ax, s) = (best.1, best.2); let ext = cmx[ax] - cmn[ax];
        if n <= 16 && best.0 >= n as f32 * area(mn, mx) { return idx; } // splitting doesn't pay
        m = 0;
        for i in 0..n {
            let b = (((ts[i].c[ax] - cmn[ax]) / ext * B as f32) as usize).min(B - 1);
            if b < s { ts.swap(i, m); m += 1; }
        }
    } else { m = n / 2; }
    if m == 0 || m == n { m = n / 2; }
    nodes[idx as usize].count = 0;
    let (l, r) = ts.split_at_mut(m);
    build(l, first, nodes, depth + 1, max_depth);
    let right = build(r, first + m, nodes, depth + 1, max_depth);
    nodes[idx as usize].a = right;
    idx
}

fn tessellate(ts: Vec<Tri>, k: u32) -> Vec<Tri> {
    let mut ts = ts;
    for _ in 0..k {
        let mut o = Vec::with_capacity(ts.len() * 4);
        for t in &ts {
            let [a, b, c] = t.v; let (ab, bc, ca) = (mid(a, b), mid(b, c), mid(c, a));
            for v in [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]] { o.push(Tri { v, c: [0.0; 3] }); }
        }
        ts = o;
    }
    for t in ts.iter_mut() { for k in 0..3 { t.c[k] = (t.v[0][k] + t.v[1][k] + t.v[2][k]) / 3.0; } }
    ts
}

fn bytes<T>(v: &[T]) -> &[u8] { unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, std::mem::size_of_val(v)) } }

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let opt = |k: &str| args.iter().find_map(|a| a.strip_prefix(&format!("--{k}=")).map(str::to_string));
    let json_path = args.iter().skip(1).find(|a| !a.starts_with("--")).expect("geometry .json").clone();
    let ks: Vec<u32> = opt("k").unwrap_or("0,3,5".into()).split(',').map(|s| s.parse().unwrap()).collect();
    let samples: u32 = opt("samples").map(|s| s.parse().unwrap()).unwrap_or(16);
    let reps: u32 = opt("reps").map(|s| s.parse().unwrap()).unwrap_or(20);
    let backend = match opt("backend").as_deref() { Some("vulkan") => wgpu::Backends::VULKAN, _ => wgpu::Backends::DX12 };
    let out_dir = opt("out"); let browser_dir = opt("browser");

    let meta: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&json_path).unwrap()).unwrap();
    let bin = std::fs::read(json_path.replace(".json", ".bin")).unwrap();
    let nv = meta["vertices"].as_u64().unwrap() as usize; let nt = meta["triangles"].as_u64().unwrap() as usize;
    let f = |i: usize| f32::from_le_bytes(bin[i * 4..i * 4 + 4].try_into().unwrap());
    let u = |i: usize| u32::from_le_bytes(bin[nv * 12 + i * 4..nv * 12 + i * 4 + 4].try_into().unwrap()) as usize;
    let vtx = |i: usize| [f(3 * i), f(3 * i + 1), f(3 * i + 2)];
    let base: Vec<Tri> = (0..nt).map(|t| Tri { v: [vtx(u(3 * t)), vtx(u(3 * t + 1)), vtx(u(3 * t + 2))], c: [0.0; 3] }).collect();

    // camera and light, as the shader's Params
    let m: Vec<f32> = meta["camera"]["matrixWorld"].as_array().unwrap().iter().map(|x| x.as_f64().unwrap() as f32).collect();
    let fov = meta["camera"]["fov"].as_f64().unwrap() as f32; let aspect = W as f32 / H as f32;
    let ty = (fov.to_radians() * 0.5).tan(); let tx = ty * aspect;
    let g = &meta["glass"]; let gv = |k: &str| -> V3 { let a = g[k].as_array().unwrap(); [a[0].as_f64().unwrap() as f32, a[1].as_f64().unwrap() as f32, a[2].as_f64().unwrap() as f32] };
    let (gw, gh) = (g["W"].as_f64().unwrap() as f32, g["H"].as_f64().unwrap() as f32);
    let v4 = |v: V3, w: f32| [v[0], v[1], v[2], w];
    let mut params: Vec<f32> = Vec::new();
    for q in [v4([m[12], m[13], m[14]], 0.0), v4([m[0], m[1], m[2]], tx), v4([m[4], m[5], m[6]], ty), v4([-m[8], -m[9], -m[10]], 0.0),
              v4(gv("ctr"), 0.0), v4(gv("r"), gw), v4(gv("u"), gh), v4(gv("n"), 0.0)] { params.extend_from_slice(&q); }

    let mut idesc = wgpu::InstanceDescriptor::new_without_display_handle(); idesc.backends = backend;
    let instance = wgpu::Instance::new(idesc);
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() })).unwrap();
    let hw_ok = adapter.features().contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY) && adapter.limits().max_acceleration_structures_per_shader_stage > 0;
    eprintln!("adapter: ray query feature {}, acceleration structures per stage {}", adapter.features().contains(wgpu::Features::EXPERIMENTAL_RAY_QUERY), adapter.limits().max_acceleration_structures_per_shader_stage);
    let mut features = wgpu::Features::TIMESTAMP_QUERY;
    if hw_ok { features |= wgpu::Features::EXPERIMENTAL_RAY_QUERY; }
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: None, required_features: features, required_limits: wgpu::Limits { max_storage_buffer_binding_size: adapter.limits().max_storage_buffer_binding_size.min(1 << 30), max_buffer_size: adapter.limits().max_buffer_size.min(1 << 31), ..adapter.limits() },
        experimental_features: unsafe { wgpu::ExperimentalFeatures::enabled() }, ..Default::default() })).unwrap();
    let info = adapter.get_info();
    eprintln!("{:?} {} ray queries: {hw_ok}", info.backend, info.name);
    let period = queue.get_timestamp_period() as f64;
    let shade = include_str!("shade.wgsl");
    let sw_src = shade.replace("//TRACER", include_str!("trace_sw.wgsl"));
    let hw_src = format!("enable wgpu_ray_query;\n{}", shade.replace("//TRACER", include_str!("trace_hw.wgsl")));
    if let Some(d) = &browser_dir { std::fs::create_dir_all(d).unwrap(); std::fs::write(format!("{d}/sw.wgsl"), &sw_src).unwrap(); }

    let mut results = Vec::new();
    for &k in &ks {
        let mut ts = tessellate(base.clone(), k);
        let t_build = Instant::now();
        let mut nodes = Vec::with_capacity(ts.len() / 2); let mut depth = 0;
        build(&mut ts, 0, &mut nodes, 0, &mut depth);
        let build_ms = t_build.elapsed().as_secs_f64() * 1000.0;
        let tri_data: Vec<[f32; 4]> = ts.iter().flat_map(|t| t.v.iter().map(|v| [v[0], v[1], v[2], 0.0])).collect();
        let mut p = params.clone();
        let mut pb: Vec<u8> = bytes(&p).to_vec();
        for x in [W, H, samples, ts.len() as u32] { pb.extend_from_slice(&x.to_le_bytes()); }
        p.clear();
        let pbuf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: &pb, usage: wgpu::BufferUsages::UNIFORM });
        let tbuf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: bytes(&tri_data), usage: wgpu::BufferUsages::STORAGE });
        let nbuf = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: bytes(&nodes), usage: wgpu::BufferUsages::STORAGE });
        let obuf = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: (W * H * 16) as u64, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
        let rbuf = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: (W * H * 16) as u64, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
        if let Some(d) = &browser_dir {
            std::fs::write(format!("{d}/tris_k{k}.bin"), bytes(&tri_data)).unwrap();
            std::fs::write(format!("{d}/nodes_k{k}.bin"), bytes(&nodes)).unwrap();
            std::fs::write(format!("{d}/params_k{k}.bin"), &pb).unwrap();
        }

        // hardware acceleration structures: one BLAS of non-indexed triangles in the BVH's order (so primitive_index
        // means the same triangle as in `tris`), one identity instance
        let mut hw_build_ms = None;
        let tlas = if hw_ok {
            let pos: Vec<f32> = ts.iter().flat_map(|t| t.v.iter().flat_map(|v| v.iter().copied())).collect();
            let vb = device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: bytes(&pos), usage: wgpu::BufferUsages::BLAS_INPUT });
            let size = wgpu::BlasTriangleGeometrySizeDescriptor { vertex_format: wgpu::VertexFormat::Float32x3, vertex_count: (ts.len() * 3) as u32,
                index_format: None, index_count: None, flags: wgpu::AccelerationStructureGeometryFlags::OPAQUE };
            let blas = device.create_blas(&wgpu::CreateBlasDescriptor { label: None, flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                update_mode: wgpu::AccelerationStructureUpdateMode::Build }, wgpu::BlasGeometrySizeDescriptors::Triangles { descriptors: vec![size.clone()] });
            let mut tlas = device.create_tlas(&wgpu::CreateTlasDescriptor { label: None, max_instances: 1, flags: wgpu::AccelerationStructureFlags::PREFER_FAST_TRACE,
                update_mode: wgpu::AccelerationStructureUpdateMode::Build });
            tlas[0] = Some(wgpu::TlasInstance::new(&blas, [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0], 0, 0xff));
            let t0 = Instant::now();
            let mut e = device.create_command_encoder(&Default::default());
            e.build_acceleration_structures([&wgpu::BlasBuildEntry { blas: &blas, geometry: wgpu::BlasGeometries::TriangleGeometries(vec![wgpu::BlasTriangleGeometry {
                size: &size, vertex_buffer: &vb, first_vertex: 0, vertex_stride: 12, index_buffer: None, first_index: None, transform_buffer: None, transform_buffer_offset: None }]) }],
                [&tlas]);
            queue.submit([e.finish()]); device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
            hw_build_ms = Some(t0.elapsed().as_secs_f64() * 1000.0);
            Some(tlas)
        } else { None };

        for (name, src) in [("sw", &sw_src), ("hw", &hw_src)] {
            if name == "hw" && tlas.is_none() { continue; }
            let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some(name), source: wgpu::ShaderSource::Wgsl(src.as_str().into()) });
            let pipe = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor { label: Some(name), layout: None, module: &module, entry_point: Some("main"), compilation_options: Default::default(), cache: None });
            let bind = device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &pipe.get_bind_group_layout(0), entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: pbuf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: tbuf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: obuf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: if name == "hw" { tlas.as_ref().unwrap().as_binding() } else { nbuf.as_entire_binding() } }] });
            let qs = device.create_query_set(&wgpu::QuerySetDescriptor { label: None, ty: wgpu::QueryType::Timestamp, count: 2 * reps });
            let qres = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 16 * reps as u64, usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
            let qread = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 16 * reps as u64, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
            let dispatch = |ts: Option<u32>| {
                let mut e = device.create_command_encoder(&Default::default());
                { let mut c = e.begin_compute_pass(&wgpu::ComputePassDescriptor { label: None,
                    timestamp_writes: ts.map(|r| wgpu::ComputePassTimestampWrites { query_set: &qs, beginning_of_pass_write_index: Some(2 * r), end_of_pass_write_index: Some(2 * r + 1) }) });
                  c.set_pipeline(&pipe); c.set_bind_group(0, &bind, &[]); c.dispatch_workgroups(W.div_ceil(8), H.div_ceil(8), 1); }
                queue.submit([e.finish()]);
            };
            for _ in 0..3 { dispatch(None); }
            device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
            for r in 0..reps { dispatch(Some(r)); }
            let mut e = device.create_command_encoder(&Default::default());
            e.resolve_query_set(&qs, 0..2 * reps, &qres, 0); e.copy_buffer_to_buffer(&qres, 0, &qread, 0, 16 * reps as u64);
            e.copy_buffer_to_buffer(&obuf, 0, &rbuf, 0, (W * H * 16) as u64);
            queue.submit([e.finish()]);
            qread.slice(..).map_async(wgpu::MapMode::Read, |_| {}); rbuf.slice(..).map_async(wgpu::MapMode::Read, |_| {});
            device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
            let tsv: Vec<u64> = qread.slice(..).get_mapped_range().unwrap().chunks_exact(8).map(|c| u64::from_le_bytes(c.try_into().unwrap())).collect();
            let mut ms: Vec<f64> = (0..reps as usize).map(|r| (tsv[2 * r + 1] - tsv[2 * r]) as f64 * period / 1e6).collect();
            ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let px: Vec<f32> = rbuf.slice(..).get_mapped_range().unwrap().chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
            drop(qread);
            rbuf.unmap();
            let lit = (0..(W * H) as usize).map(|i| px[i * 4] as f64).sum::<f64>() / (W * H) as f64;
            if let Some(d) = &out_dir {
                std::fs::create_dir_all(d).unwrap();
                let img: Vec<u8> = (0..(W * H) as usize).map(|i| { let x = px[i * 4] * 6.0; ((x / (1.0 + x)).powf(1.0 / 2.2) * 255.0) as u8 }).collect();
                let file = std::fs::File::create(format!("{d}/{:?}_{name}_k{k}.png", info.backend).to_lowercase()).unwrap();
                let mut enc = png::Encoder::new(std::io::BufWriter::new(file), W, H); enc.set_color(png::ColorType::Grayscale); enc.set_depth(png::BitDepth::Eight);
                enc.write_header().unwrap().write_image_data(&img).unwrap();
            }
            let r3 = |x: f64| (x * 1000.0).round() / 1000.0;
            let rays = (W * H) as f64 * (1.0 + samples as f64);
            let v = serde_json::json!({ "backend": format!("{:?}", info.backend), "tracer": name, "k": k, "triangles": ts.len(), "bvh_nodes": nodes.len(), "bvh_depth": depth,
                "cpu_bvh_build_ms": r3(build_ms), "hw_as_build_ms": hw_build_ms.map(r3), "samples": samples, "median_ms": r3(ms[ms.len() / 2]), "min_ms": r3(ms[0]),
                "mrays_per_s": ((rays / (ms[ms.len() / 2] / 1000.0)) / 1e6).round(), "mean_light": r3(lit * 1000.0) / 1000.0 });
            eprintln!("{v}");
            results.push(v);
        }
    }
    println!("{}", serde_json::to_string_pretty(&results).unwrap());
}
