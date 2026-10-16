//! `server/serve.mjs` ported to a Tauri URI scheme (`vs://`, served as http://vs.localhost on Windows). Same routes, so
//! the editor runs unchanged in the Tauri window, plus the shell-only routes the spike measures:
//!   GET  /...                  repo root, and the read-only mounts below (read in place, never written)
//!   POST /save/<rel>           body written under the output folder
//!   POST /save-scene/<name>    a scene file in the repo's scenes/
//!   POST /save-rgba/<rel>?w=&h=[&c=fast|balanced]   raw RGBA8 (top row first), PNG-encoded here, one thread per request
//!   POST /save-idat/<rel>?w=&h=   an already compressed PNG image stream; only the chunks are wrapped around it
//!   POST /ffmpeg/open?w=&h=&fps=&codec=prores4444|h264|png&out=<rel>   starts ffmpeg reading raw RGBA on stdin
//!   POST /ffmpeg/frame?id=&i=  raw RGBA for frame i (requests may arrive out of order; frames are written in order)
//!   POST /ffmpeg/close?id=     closes stdin, waits for ffmpeg, returns {frames, seconds, bytes}
//!   GET  /native/info          what the shell is; GET /native/stats[?reset=1] per-route timings in the shell
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::http::{header, Request, Response, StatusCode};

pub struct Server {
    repo: PathBuf,
    out: PathBuf,
    mounts: Vec<(&'static str, PathBuf)>,
    stats: Mutex<HashMap<String, Stat>>,
    pipes: Mutex<HashMap<u32, Arc<Pipe>>>,
    next_pipe: AtomicU32,
}

#[derive(Default, Clone, serde::Serialize)]
struct Stat { n: u64, ms_total: f64, ms_max: f64, bytes_in: u64, bytes_out: u64 }

struct Pipe {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    order: Mutex<(u64, BTreeMap<u64, Vec<u8>>)>, // next frame index to write, frames that arrived early
    frame_bytes: usize,
    started: Instant,
    dest: PathBuf,
}

type Resp = Response<Vec<u8>>;

fn resp(status: StatusCode, ctype: &str, body: impl Into<Vec<u8>>) -> Resp {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, ctype)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::CACHE_CONTROL, "no-store")
        .body(body.into())
        .unwrap()
}
fn text(status: StatusCode, s: &str) -> Resp { resp(status, "text/plain", s.as_bytes().to_vec()) }
fn json(v: serde_json::Value) -> Resp { resp(StatusCode::OK, "application/json", v.to_string().into_bytes()) }

fn content_type(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript",
        Some("json") => "application/json",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("glb") => "model/gltf-binary",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("css") => "text/css",
        Some("wasm") => "application/wasm",
        Some("wgsl") => "text/plain",
        _ => "application/octet-stream",
    }
}

fn decode(s: &str) -> String { percent_encoding::percent_decode_str(s).decode_utf8_lossy().into_owned() }

/// A relative path from a URL, refused if it could leave its root (`..`, absolute, drive prefixes).
fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel = Path::new(rel);
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) { return None; }
    Some(root.join(rel))
}
/// The write rule from serve.mjs: plain names only, no dot-folders, no `..`.
fn ok_write_name(rel: &str) -> bool {
    !rel.is_empty()
        && rel.chars().all(|c| c.is_ascii_alphanumeric() || "_.- /".contains(c))
        && !rel.split('/').any(|s| s == ".." || s.starts_with('.'))
}

fn query(req: &Request<Vec<u8>>) -> HashMap<String, String> {
    req.uri().query().unwrap_or("").split('&').filter(|s| !s.is_empty())
        .map(|kv| { let mut it = kv.splitn(2, '='); (decode(it.next().unwrap_or("")), decode(it.next().unwrap_or(""))) })
        .collect()
}

pub fn encode_png(px: &[u8], w: u32, h: u32, fast: bool) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(px.len() / 3);
    {
        let mut e = png::Encoder::new(&mut out, w, h);
        e.set_color(png::ColorType::Rgba);
        e.set_depth(png::BitDepth::Eight);
        e.set_compression(if fast { png::Compression::Fast } else { png::Compression::Balanced });
        let mut wr = e.write_header().map_err(|e| e.to_string())?;
        wr.write_image_data(px).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

fn png_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let start = out.len();
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let crc = crc32(&out[start..]);
    out.extend_from_slice(&crc.to_be_bytes());
}
fn crc32(b: &[u8]) -> u32 {
    let mut c = !0u32;
    for &x in b { c ^= x as u32; for _ in 0..8 { c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 }; } }
    !c
}

impl Server {
    pub fn new(repo: PathBuf, out: PathBuf) -> Self {
        let m = |s: &str| PathBuf::from(s);
        Server {
            repo,
            out,
            mounts: vec![
                ("/bp/", m("G:/Claude/Virtual Legacy/Videos/Calling (Wii)/Thumbnails & Graphics/Black Page Studio")),
                ("/psx/", m("E:/Assets/Asset Packs/PSX Humble Bundle/PSX Mega Pack 3.1.3/Models/GLB (recommended)")),
                ("/wii/", m("G:/GPT/Projectless/2026-10-04/gen/outputs/Wii_Remote_LowPoly")),
                ("/bp-final-ref/", m("G:/Claude/Virtual Legacy/Channel/Virtual Shot spike/ref_final")),
            ],
            stats: Mutex::new(HashMap::new()),
            pipes: Mutex::new(HashMap::new()),
            next_pipe: AtomicU32::new(1),
        }
    }
    pub fn out(&self) -> &Path { &self.out }

    fn note(&self, route: &str, t0: Instant, bytes_in: usize, bytes_out: usize) {
        let ms = t0.elapsed().as_secs_f64() * 1000.0;
        let mut s = self.stats.lock().unwrap();
        let e = s.entry(route.to_string()).or_default();
        e.n += 1; e.ms_total += ms; e.ms_max = e.ms_max.max(ms); e.bytes_in += bytes_in as u64; e.bytes_out += bytes_out as u64;
    }

    pub fn handle(&self, req: Request<Vec<u8>>) -> Resp {
        let path = req.uri().path().to_string();
        let post = req.method() == "POST";
        let t0 = Instant::now();
        if post {
            if let Some(name) = path.strip_prefix("/save-scene/") {
                let name = decode(name);
                let valid = name.ends_with(".scene.json") && name.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c));
                if !valid { return text(StatusCode::BAD_REQUEST, "bad scene name"); }
                if let Err(e) = serde_json::from_slice::<serde_json::Value>(req.body()) { return text(StatusCode::BAD_REQUEST, &e.to_string()); }
                return match fs::write(self.repo.join("scenes").join(&name), req.body()) {
                    Ok(_) => text(StatusCode::OK, "ok"),
                    Err(e) => text(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
                };
            }
            for (route, raw) in [("/save-rgba/", true), ("/save-idat/", false)] {
                if let Some(rel) = path.strip_prefix(route) {
                    let rel = decode(rel); let q = query(&req);
                    let (w, h) = (q.get("w").and_then(|v| v.parse::<u32>().ok()).unwrap_or(0), q.get("h").and_then(|v| v.parse::<u32>().ok()).unwrap_or(0));
                    if !ok_write_name(&rel) || w == 0 || h == 0 { return text(StatusCode::BAD_REQUEST, "bad request"); }
                    let png = if raw {
                        if req.body().len() != (w * h * 4) as usize { return text(StatusCode::BAD_REQUEST, "size mismatch"); }
                        match encode_png(req.body(), w, h, q.get("c").map(|c| c != "balanced").unwrap_or(true)) { Ok(p) => p, Err(e) => return text(StatusCode::INTERNAL_SERVER_ERROR, &e) }
                    } else {
                        let mut out = vec![137, 80, 78, 71, 13, 10, 26, 10];
                        let mut ihdr = Vec::with_capacity(13);
                        ihdr.extend_from_slice(&w.to_be_bytes()); ihdr.extend_from_slice(&h.to_be_bytes()); ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
                        png_chunk(&mut out, b"IHDR", &ihdr); png_chunk(&mut out, b"IDAT", req.body()); png_chunk(&mut out, b"IEND", &[]);
                        out
                    };
                    let dest = self.out.join(&rel);
                    if let Some(d) = dest.parent() { let _ = fs::create_dir_all(d); }
                    let n = png.len();
                    return match fs::write(&dest, png) {
                        Ok(_) => { self.note(route, t0, req.body().len(), n); text(StatusCode::OK, "ok") }
                        Err(e) => text(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
                    };
                }
            }
            if let Some(rel) = path.strip_prefix("/save/") {
                let rel = decode(rel);
                if !ok_write_name(&rel) { return text(StatusCode::BAD_REQUEST, "bad name"); }
                let dest = self.out.join(&rel);
                if let Some(d) = dest.parent() { let _ = fs::create_dir_all(d); }
                return match fs::write(&dest, req.body()) {
                    Ok(_) => { self.note("/save/", t0, req.body().len(), req.body().len()); text(StatusCode::OK, "ok") }
                    Err(e) => text(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
                };
            }
            if path.starts_with("/ffmpeg/") { return self.ffmpeg(&path, &req, t0); }
            return text(StatusCode::METHOD_NOT_ALLOWED, "");
        }
        if path == "/native/info" {
            return json(serde_json::json!({ "shell": "tauri", "tauri": tauri::VERSION, "webview": tauri::webview_version().ok(),
                "repo": self.repo, "out": self.out, "ffmpeg": which("ffmpeg") }));
        }
        if path == "/native/stats" {
            let mut s = self.stats.lock().unwrap();
            let v = serde_json::to_value(&*s).unwrap();
            if query(&req).contains_key("reset") { s.clear(); }
            return json(v);
        }
        let file = self.resolve_get(&path);
        match file.and_then(|f| fs::read(&f).ok().map(|b| (f, b))) {
            Some((f, body)) => { let n = body.len(); let r = resp(StatusCode::OK, content_type(&f), body); self.note("GET", t0, 0, n); r }
            None => text(StatusCode::NOT_FOUND, "not found"),
        }
    }

    fn resolve_get(&self, url_path: &str) -> Option<PathBuf> {
        for (pre, root) in &self.mounts {
            if let Some(rest) = url_path.strip_prefix(pre) { return safe_join(root, &decode(rest)); }
        }
        let rel = url_path.trim_start_matches('/');
        let rel = if rel.is_empty() { "src/landing.html".to_string() } else { decode(rel) };
        let p = safe_join(&self.repo, &rel)?;
        if p.is_dir() { None } else { Some(p) }
    }

    fn ffmpeg(&self, path: &str, req: &Request<Vec<u8>>, t0: Instant) -> Resp {
        let q = query(req);
        let num = |k: &str| q.get(k).and_then(|v| v.parse::<u64>().ok());
        match path {
            "/ffmpeg/open" => {
                let (Some(w), Some(h)) = (num("w"), num("h")) else { return text(StatusCode::BAD_REQUEST, "w and h") };
                let fps = q.get("fps").cloned().unwrap_or_else(|| "60".into());
                let rel = q.get("out").cloned().unwrap_or_default();
                if !ok_write_name(&rel) { return text(StatusCode::BAD_REQUEST, "bad out name"); }
                let dest = self.out.join(&rel);
                if let Some(d) = dest.parent() { let _ = fs::create_dir_all(d); }
                // display-referred sRGB frames, tagged and converted as BT.709 (the master was decoded the same way)
                let bt709 = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"];
                let mut args: Vec<String> = ["-hide_banner", "-loglevel", "warning", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s"]
                    .iter().map(|s| s.to_string()).collect();
                args.push(format!("{w}x{h}")); args.extend(["-framerate".into(), fps.clone(), "-i".into(), "pipe:0".into()]);
                let codec = q.get("codec").map(String::as_str).unwrap_or("prores4444");
                let enc: &[&str] = match codec {
                    "prores4444" => &["-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuva444p10le", "-c:v", "prores_ks", "-profile:v", "4", "-vendor", "apl0"],
                    "prores422hq" => &["-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv422p10le", "-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0"],
                    "h264" => &["-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", "-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "16", "-b:v", "0"],
                    "png" => &["-c:v", "png", "-pix_fmt", "rgba"],
                    _ => return text(StatusCode::BAD_REQUEST, "codec: prores4444 | prores422hq | h264 | png"),
                };
                args.extend(enc.iter().map(|s| s.to_string()));
                if codec != "png" { args.extend(bt709.iter().map(|s| s.to_string())); }
                args.push(dest.to_string_lossy().into_owned());
                let log = fs::File::create(dest.with_extension("ffmpeg.log")).ok();
                let mut cmd = Command::new("ffmpeg");
                cmd.args(&args).stdin(Stdio::piped()).stdout(Stdio::null());
                cmd.stderr(log.map(Stdio::from).unwrap_or(Stdio::null()));
                #[cfg(windows)] { use std::os::windows::process::CommandExt; cmd.creation_flags(0x0800_0000); } // CREATE_NO_WINDOW
                let mut child = match cmd.spawn() { Ok(c) => c, Err(e) => return text(StatusCode::INTERNAL_SERVER_ERROR, &format!("ffmpeg: {e}")) };
                let stdin = child.stdin.take();
                let id = self.next_pipe.fetch_add(1, Ordering::Relaxed);
                self.pipes.lock().unwrap().insert(id, Arc::new(Pipe {
                    child: Mutex::new(Some(child)), stdin: Mutex::new(stdin), order: Mutex::new((0, BTreeMap::new())),
                    frame_bytes: (w * h * 4) as usize, started: Instant::now(), dest,
                }));
                json(serde_json::json!({ "id": id, "args": args }))
            }
            "/ffmpeg/frame" => {
                let (Some(id), Some(i)) = (num("id"), num("i")) else { return text(StatusCode::BAD_REQUEST, "id and i") };
                let Some(p) = self.pipes.lock().unwrap().get(&(id as u32)).cloned() else { return text(StatusCode::NOT_FOUND, "no such pipe") };
                if req.body().len() != p.frame_bytes { return text(StatusCode::BAD_REQUEST, "size mismatch"); }
                let mut o = p.order.lock().unwrap();
                o.1.insert(i, req.body().clone());
                let mut stdin = p.stdin.lock().unwrap();
                let Some(s) = stdin.as_mut() else { return text(StatusCode::GONE, "closed") };
                while let Some(buf) = { let next = o.0; o.1.remove(&next) } {
                    if let Err(e) = s.write_all(&buf) { return text(StatusCode::INTERNAL_SERVER_ERROR, &format!("ffmpeg stdin: {e}")); }
                    o.0 += 1;
                }
                drop(stdin); drop(o);
                self.note("/ffmpeg/frame", t0, req.body().len(), 0);
                text(StatusCode::OK, "ok")
            }
            "/ffmpeg/close" => {
                let Some(id) = num("id") else { return text(StatusCode::BAD_REQUEST, "id") };
                let Some(p) = self.pipes.lock().unwrap().remove(&(id as u32)) else { return text(StatusCode::NOT_FOUND, "no such pipe") };
                let (frames, early) = { let o = p.order.lock().unwrap(); (o.0, o.1.len()) };
                drop(p.stdin.lock().unwrap().take()); // EOF: ffmpeg finishes the file
                let status = p.child.lock().unwrap().take().map(|mut c| c.wait());
                let ok = matches!(status, Some(Ok(s)) if s.success());
                let bytes = fs::metadata(&p.dest).map(|m| m.len()).unwrap_or(0);
                json(serde_json::json!({ "ok": ok, "frames": frames, "unwritten": early, "seconds": p.started.elapsed().as_secs_f64(),
                    "bytes": bytes, "file": p.dest }))
            }
            _ => text(StatusCode::NOT_FOUND, "not found"),
        }
    }
}

fn which(exe: &str) -> Option<String> {
    let mut cmd = Command::new("where");
    cmd.arg(exe);
    #[cfg(windows)] { use std::os::windows::process::CommandExt; cmd.creation_flags(0x0800_0000); }
    let out = cmd.output().ok()?;
    String::from_utf8(out.stdout).ok()?.lines().next().map(|s| s.trim().to_string())
}

/// The same routes on a plain localhost HTTP port inside the shell's process (no Node). WebView2 hands custom-scheme
/// request bodies over through COM streams, which measured 3x slower than a socket for 8 MB frames; a socket is not.
pub fn listen_http(server: std::sync::Arc<Server>, port: u16) -> std::io::Result<()> {
    let http = tiny_http::Server::http(("127.0.0.1", port)).map_err(|e| std::io::Error::other(e.to_string()))?;
    std::thread::Builder::new().name(format!("http-{port}")).spawn(move || {
        for mut rq in http.incoming_requests() {
            let s = server.clone();
            std::thread::spawn(move || {
                let mut body = Vec::with_capacity(rq.body_length().unwrap_or(0));
                let _ = std::io::Read::read_to_end(rq.as_reader(), &mut body);
                let req = Request::builder().method(rq.method().as_str()).uri(format!("http://127.0.0.1{}", rq.url())).body(body).unwrap();
                let r = s.handle(req);
                let mut out = tiny_http::Response::from_data(r.body().clone()).with_status_code(r.status().as_u16());
                for (k, v) in r.headers() {
                    if let Ok(h) = tiny_http::Header::from_bytes(k.as_str().as_bytes(), v.as_bytes()) { out.add_header(h); }
                }
                let _ = rq.respond(out);
            });
        }
    })?;
    Ok(())
}
