//! Native replay of the Black Page renderer's GPU work. desktop/capture/gpu_capture.js records every WebGPU call three.js
//! makes while the viewer renders some frames (shaders, pipelines, buffers, texture uploads, passes); this runs the same
//! calls through wgpu on DX12 or Vulkan, so the browser and native can be compared on identical work:
//! per-pass GPU time (timestamp queries around every render pass), CPU time to encode a frame, the picture (against
//! the browser's own frame), and export throughput (render, read back, pipe into ffmpeg) without a browser.
//!   vs-replay <capture.json> [--backend=vulkan|dx12] [--unchecked] [--reps=30] [--refs=<dir>] [--out=<dir>]
//!             [--export=<frames> --export-out=<file.mov>] [--skip-uploads]
use vs_replay::*;
use std::collections::HashMap;
use serde_json::Value;
use std::time::Instant;

fn read_png(path: &str) -> Option<(u32, u32, Vec<u8>)> {
    let dec = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(path).ok()?));
    let mut r = dec.read_info().ok()?; let mut buf = vec![0; r.output_buffer_size()?];
    let info = r.next_frame(&mut buf).ok()?; buf.truncate(info.buffer_size());
    let px = match info.color_type { png::ColorType::Rgba => buf, png::ColorType::Rgb => buf.chunks_exact(3).flat_map(|c| [c[0], c[1], c[2], 255]).collect(), _ => return None };
    Some((info.width, info.height, px))
}
fn write_png(path: &str, w: u32, h: u32, px: &[u8]) {
    let mut e = png::Encoder::new(std::io::BufWriter::new(std::fs::File::create(path).unwrap()), w, h);
    e.set_color(png::ColorType::Rgba); e.set_depth(png::BitDepth::Eight); e.write_header().unwrap().write_image_data(px).unwrap();
}
/// RGB difference against a reference: PSNR (dB), largest channel difference, share of pixels off by more than 8/255.
fn compare_px(a: &[u8], b: &[u8]) -> serde_json::Value {
    let (mut se, mut mx, mut off8, n) = (0f64, 0u8, 0u64, a.len() / 4);
    for i in 0..n { let mut po = 0u8; for c in 0..3 { let d = a[i * 4 + c].abs_diff(b[i * 4 + c]); se += (d as f64).powi(2); mx = mx.max(d); po = po.max(d); } if po > 8 { off8 += 1; } }
    let mse = se / (n * 3) as f64;
    serde_json::json!({ "psnr_db": if mse == 0.0 { f64::INFINITY } else { (10.0 * (255.0f64 * 255.0 / mse).log10() * 100.0).round() / 100.0 }, "max_diff": mx, "pct_over_8": (off8 as f64 / n as f64 * 1e4).round() / 100.0 })
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let opt = |k: &str| args.iter().find_map(|a| a.strip_prefix(&format!("--{k}=")).map(str::to_string));
    let flag = |k: &str| args.iter().any(|a| a == &format!("--{k}"));
    let path = args.iter().skip(1).find(|a| !a.starts_with("--")).expect("capture .json").clone();
    let reps: usize = opt("reps").map(|x| x.parse().unwrap()).unwrap_or(30);
    let backend = if opt("backend").as_deref() == Some("dx12") { wgpu::Backends::DX12 } else { wgpu::Backends::VULKAN };
    let cap: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let bin = std::fs::read(path.replace(".json", ".bin")).unwrap();
    let ops = cap["ops"].as_array().unwrap();

    let mut idesc = wgpu::InstanceDescriptor::new_without_display_handle(); idesc.backends = backend;
    let instance = wgpu::Instance::new(idesc);
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, ..Default::default() })).unwrap();
    let mut features = wanted_features(ops);
    features &= adapter.features();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: None, required_features: features, required_limits: adapter.limits(), ..Default::default() })).unwrap();
    device.on_uncaptured_error(std::sync::Arc::new(|e| panic!("wgpu: {e}")));
    let info = adapter.get_info();
    let mut rp = Replay::new(device, queue, &bin, ops, flag("unchecked"));
    rp.skip_uploads = flag("skip-uploads");
    let canvas_format = rp.canvas_format;

    // segments: setup (everything before the first frame note), then each "frame ..." .. "frame end"
    let (frames, first) = frame_segments(ops);
    let t0 = Instant::now();
    for o in &ops[..first] { rp.exec(o); }
    rp.device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
    eprintln!("{:?} {}: setup {} ops in {:.0} ms (shader compiles included)", info.backend, info.name, first, t0.elapsed().as_secs_f64() * 1000.0);

    let mut results = vec![];
    for (name, a, b) in &frames {
        // first run creates whatever this frame needs (pipelines at this quality); then timed repetitions
        for o in &ops[*a..*b] { rp.exec(o); }
        rp.device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
        let mut per_pass: HashMap<String, Vec<f64>> = HashMap::new(); let mut totals = vec![]; let mut cpu = vec![];
        for _ in 0..reps {
            rp.timing = true;
            let c0 = Instant::now();
            for o in &ops[*a..*b] { rp.exec(o); }
            cpu.push(c0.elapsed().as_secs_f64() * 1000.0);
            rp.timing = false;
            let times = rp.take_times();
            let mut sum: HashMap<String, f64> = HashMap::new();
            for (l, ms) in &times { *sum.entry(l.clone()).or_default() += ms; }
            totals.push(times.iter().map(|x| x.1).sum::<f64>());
            for (l, ms) in sum { per_pass.entry(l).or_default().push(ms); }
        }
        let med = |v: &mut Vec<f64>| { v.sort_by(|x, y| x.partial_cmp(y).unwrap()); (v[v.len() / 2] * 1000.0).round() / 1000.0 };
        let mut passes: Vec<(String, f64)> = per_pass.into_iter().map(|(k, mut v)| (k, med(&mut v))).collect(); passes.sort_by(|x, y| y.1.partial_cmp(&x.1).unwrap());
        let (w, h, px) = rp.read_canvas();
        let key = name.replace(' ', "_");
        let mut cmp = Value::Null;
        if let Some(refs) = opt("refs") { if let Some((rw, rh, rpx)) = read_png(&format!("{refs}/ref_{key}.png")) { if (rw, rh) == (w, h) { cmp = compare_px(&px, &rpx); } } }
        if let Some(out) = opt("out") { std::fs::create_dir_all(&out).ok(); write_png(&format!("{out}/native_{:?}{}_{key}.png", info.backend, if rp.unchecked { "_unchecked" } else { "" }).to_lowercase(), w, h, &px); }
        let v = serde_json::json!({ "frame": name, "backend": format!("{:?}", info.backend), "unchecked": rp.unchecked, "skip_uploads": rp.skip_uploads, "reps": reps,
            "gpu_total_ms": med(&mut totals), "cpu_encode_ms": med(&mut cpu), "passes": passes.iter().map(|(k, v)| serde_json::json!([k, v])).collect::<Vec<_>>(), "vs_browser_frame": cmp });
        eprintln!("{v}");
        results.push(v);
    }

    // export: frames rendered back to back (the captured ones, cycled), read back and piped into ffmpeg as ProRes 4444
    if let Some(n) = opt("export").map(|x| x.parse::<usize>().unwrap()) {
        let out = opt("export-out").unwrap_or_else(|| "native_export.mov".into());
        let sz = rp.canvas.size(); let (w, h) = (sz.width, sz.height); let row = w * 4;
        let mut child = std::process::Command::new("ffmpeg").args(["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", if canvas_format == wgpu::TextureFormat::Bgra8Unorm { "bgr0" } else { "rgb0" },   // the canvas is opaque: alpha ignored, as the browser does
            "-s", &format!("{w}x{h}"), "-framerate", "60", "-i", "pipe:0", "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuva444p10le,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
            "-c:v", "prores_ks", "-profile:v", "4", "-vendor", "apl0", &out]).stdin(std::process::Stdio::piped()).spawn().expect("ffmpeg");
        let mut stdin = child.stdin.take().unwrap();
        let bufs: Vec<wgpu::Buffer> = (0..3).map(|_| rp.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: (row * h) as u64, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false })).collect();
        let t0 = Instant::now(); let mut render_ms = 0.0; let mut write_ms = 0.0;
        let mut pending: std::collections::VecDeque<usize> = Default::default();
        // --export-frames="720 render,300 render": which captured frames to cycle (default: all)
        let pick: Vec<usize> = opt("export-frames").map(|l| l.split(',').map(|n| frames.iter().position(|f| f.0 == n.trim()).expect("export frame")).collect())
            .unwrap_or_else(|| (0..frames.len()).collect());
        let flush = |rp: &Replay, i: usize, stdin: &mut std::process::ChildStdin, write_ms: &mut f64| {
            let s = bufs[i].slice(..); s.map_async(wgpu::MapMode::Read, |_| {}); rp.device.poll(wgpu::PollType::wait_indefinitely()).unwrap();
            let w0 = Instant::now(); { let m = s.get_mapped_range().unwrap(); std::io::Write::write_all(stdin, &m).unwrap(); } bufs[i].unmap(); *write_ms += w0.elapsed().as_secs_f64() * 1000.0;
        };
        for k in 0..n {
            let (_, a, b) = &frames[pick[k % pick.len()]];
            let r0 = Instant::now(); for o in &ops[*a..*b] { rp.exec(o); }
            let i = k % 3;
            let mut e = rp.device.create_command_encoder(&Default::default());
            e.copy_texture_to_buffer(rp.canvas.as_image_copy(), wgpu::TexelCopyBufferInfo { buffer: &bufs[i], layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(h) } }, sz);
            rp.queue.submit([e.finish()]); render_ms += r0.elapsed().as_secs_f64() * 1000.0;
            pending.push_back(i);
            if pending.len() == 3 { let j = pending.pop_front().unwrap(); flush(&rp, j, &mut stdin, &mut write_ms); }
        }
        while let Some(j) = pending.pop_front() { flush(&rp, j, &mut stdin, &mut write_ms); }
        drop(stdin); let ok = child.wait().map(|s| s.success()).unwrap_or(false);
        let secs = t0.elapsed().as_secs_f64();
        let v = serde_json::json!({ "export_frames": n, "seconds": (secs * 100.0).round() / 100.0, "fps": (n as f64 / secs * 10.0).round() / 10.0, "ffmpeg_ok": ok,
            "cpu_record_ms_per_frame": (render_ms / n as f64 * 100.0).round() / 100.0, "pipe_write_ms_per_frame": (write_ms / n as f64 * 100.0).round() / 100.0, "file": out,
            "bytes": std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0) });
        eprintln!("{v}"); results.push(v);
    }
    eprintln!("op counts: {:?}", rp.stats);
    println!("{}", serde_json::to_string_pretty(&results).unwrap());
}
