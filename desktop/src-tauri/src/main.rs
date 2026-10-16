// Virtual Shot desktop shell (spike): the unchanged web editor in a Tauri window (WebView2 on Windows), with the local
// dev server ported to Rust as the `vs` URI scheme. Measures what a native host changes; see LEARNINGS §9.
//   virtual-shot-desktop [--page=/src/editor/index.html] [--server=http://localhost:8790] [--cdp=9334] [--hidden]
//   --server   load the page from the Node dev server instead of the vs scheme (to separate the shell from the server)
//   --cdp      open WebView2's DevTools port, so tools/headless-style scripts can drive and measure the page
//   --data     WebView2 user data folder (a fresh one measures a cold start: no shader cache)
//   --http=<port>  also serve the same routes on http://localhost:<port> from this process (use with --server)
//   --browser-args="..."  extra Chromium switches for WebView2 (e.g. --enable-dawn-features=disable_robustness)
//   --native-viewport[=dx12|vulkan]  a transparent window: wgpu draws a native viewport under the web page (probe)
//   --test-window  keep the window on top without taking focus (for unattended screen captures)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod bridge;
mod native_view;
mod serve;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::ipc::{Channel, InvokeBody, Request};
use tauri::Manager;

struct Shell { server: Arc<serve::Server>, started: Instant, started_epoch_ms: f64, view: Arc<std::sync::Mutex<native_view::ViewState>> }

/// The page tells the native viewport where it is (physical pixels, from getBoundingClientRect × devicePixelRatio).
#[tauri::command]
fn view_rect(shell: tauri::State<Shell>, rect: [f32; 4], win: [u32; 2]) { let mut v = shell.view.lock().unwrap(); v.rect = rect; v.win = win; }
/// A camera drag from the page, with the page's event time (epoch ms) for input-to-frame latency.
#[tauri::command]
fn view_input(shell: tauri::State<Shell>, dx: f32, dy: f32, t: f64) {
    let mut v = shell.view.lock().unwrap(); v.orbit[0] += dx; v.orbit[1] += dy; v.input_epoch_ms = t; v.pending_input = true;
}
/// Native viewport stats: present intervals and input-to-submit latency (p50/p95/max), optionally reset.
#[tauri::command]
fn view_stats(shell: tauri::State<Shell>, reset: bool) -> serde_json::Value {
    let mut v = shell.view.lock().unwrap();
    let st = |a: &Vec<f64>| { if a.is_empty() { return serde_json::Value::Null; } let mut s = a.clone(); s.sort_by(|x, y| x.partial_cmp(y).unwrap());
        let q = |p: f64| (s[((p * s.len() as f64) as usize).min(s.len() - 1)] * 100.0).round() / 100.0;
        serde_json::json!({ "n": s.len(), "p50": q(0.5), "p95": q(0.95), "max": q(1.0) }) };
    let out = serde_json::json!({ "backend": v.backend, "frames": v.frames, "error": v.error, "status": v.status, "skipped": v.skipped, "present_interval_ms": st(&v.intervals), "input_to_submit_ms": st(&v.input_to_submit), "rect": v.rect });
    if reset { v.intervals.clear(); v.input_to_submit.clear(); }
    out
}

fn epoch_ms() -> f64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs_f64() * 1000.0 }

/// Process start time and shell facts, so a page can measure launch-to-ready.
#[tauri::command]
fn native_info(shell: tauri::State<Shell>) -> serde_json::Value {
    serde_json::json!({ "tauri": tauri::VERSION, "webview": tauri::webview_version().ok(), "pid": std::process::id(),
        "started_epoch_ms": shell.started_epoch_ms, "uptime_ms": shell.started.elapsed().as_secs_f64() * 1000.0,
        "out": shell.server.out() })
}

/// The same raw-RGBA frame save as POST /save-rgba/, but through Tauri's IPC (`invoke` with a Uint8Array body and the
/// path, width and height in headers), to compare the two transports.
#[tauri::command]
fn save_rgba_ipc(shell: tauri::State<Shell>, request: Request) -> Result<f64, String> {
    let t0 = Instant::now();
    let InvokeBody::Raw(px) = request.body() else { return Err("expected a raw body".into()) };
    let h = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(str::to_string);
    let (rel, w, ht) = (h("x-path").ok_or("x-path")?, h("x-w").and_then(|v| v.parse().ok()).ok_or("x-w")?, h("x-h").and_then(|v| v.parse().ok()).ok_or("x-h")?);
    if px.len() != (w * ht * 4) as usize { return Err("size mismatch".into()); }
    if rel.contains("..") { return Err("bad path".into()); }
    let png = serve::encode_png(px, w, ht, true)?;
    let dest = shell.server.out().join(rel);
    if let Some(d) = dest.parent() { let _ = std::fs::create_dir_all(d); }
    std::fs::write(dest, png).map_err(|e| e.to_string())?;
    Ok(t0.elapsed().as_secs_f64() * 1000.0)
}

/// IPC round trip with a body of n bytes each way, for transport timings.
#[tauri::command]
fn echo_ipc(request: Request) -> tauri::ipc::Response {
    let body = match request.body() { InvokeBody::Raw(b) => b.clone(), InvokeBody::Json(v) => v.to_string().into_bytes() };
    tauri::ipc::Response::new(body)
}

/// Listen for bridge datagrams (the engine-bridge `vsb/1` JSON) on 127.0.0.1:port and push each one, stamped with the
/// shell's receive time `rx_native`, into the page's channel.
#[tauri::command]
fn bridge_listen(port: u16, on_message: Channel<String>) -> Result<(), String> {
    bridge::listen(port, move |s| { let _ = on_message.send(s); }).map_err(|e| e.to_string())
}

fn main() {
    let started = Instant::now();
    let started_epoch_ms = epoch_ms();
    let args: Vec<String> = std::env::args().collect();
    let arg = |k: &str| args.iter().find_map(|a| a.strip_prefix(&format!("--{k}=")).map(str::to_string));
    let flag = |k: &str| args.iter().any(|a| a == &format!("--{k}"));
    let repo = std::env::var("VS_REPO").map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join(".."));
    let repo = repo.canonicalize().unwrap_or(repo);
    let out = std::env::var("VS_OUT").map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("G:/Claude/Virtual Legacy/Channel/Virtual Shot spike"));
    let server = Arc::new(serve::Server::new(repo, out));
    let page = arg("page").unwrap_or_else(|| "/src/editor/index.html".into());
    let base = arg("server").unwrap_or_else(|| "http://vs.localhost".into());
    let cdp = arg("cdp");
    let data = arg("data");
    let browser_args = arg("browser-args");
    let hidden = flag("hidden");
    let native_view = args.iter().find_map(|a| a.strip_prefix("--native-viewport").map(|r| r.trim_start_matches('=').to_string()));
    let test_window = flag("test-window");
    let view_state = Arc::new(std::sync::Mutex::new(native_view::ViewState::default()));
    if let Some(p) = arg("http").and_then(|p| p.parse::<u16>().ok()) {
        serve::listen_http(server.clone(), p).expect("http port");
    }

    let scheme_server = server.clone();
    tauri::Builder::default()
        .manage(Shell { server, started, started_epoch_ms, view: view_state.clone() })
        // each request on its own thread: frame uploads encode in parallel, and file reads never block the webview
        .register_asynchronous_uri_scheme_protocol("vs", move |_ctx, req, responder| {
            let s = scheme_server.clone();
            std::thread::spawn(move || responder.respond(s.handle(req)));
        })
        .invoke_handler(tauri::generate_handler![native_info, save_rgba_ipc, echo_ipc, bridge_listen, view_rect, view_input, view_stats])
        .setup(move |app| {
            let url = format!("{base}{page}");
            let mut b = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url.parse()?))
                .title("Virtual Shot (Tauri spike)")
                .inner_size(1600.0, 900.0)
                .visible(!hidden)
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled);
            // Tauri's own WebView2 switches, plus the DevTools port when asked for
            let mut extra = String::from("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
            if let Some(p) = &cdp { extra.push_str(&format!(" --remote-debugging-port={p}")); }
            if let Some(a) = &browser_args { extra.push(' '); extra.push_str(a); }
            b = b.additional_browser_args(&extra);
            if let Some(d) = &data { b = b.data_directory(PathBuf::from(d)); }
            if native_view.is_some() { b = b.transparent(true); }
            if test_window { b = b.always_on_top(true).focused(false).position(40.0, 40.0); }
            let win = b.build()?;
            if let Some(nv) = &native_view {
                let backends = if nv == "vulkan" { wgpu::Backends::VULKAN } else { wgpu::Backends::DX12 };
                let w2 = win.clone();
                native_view::start(win.clone(), move || w2.inner_size().map(|s| (s.width, s.height)).unwrap_or((0, 0)), view_state.clone(), backends);   // size until the page reports it
            }
            let _ = app.handle().get_webview_window("main");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Virtual Shot shell");
}
