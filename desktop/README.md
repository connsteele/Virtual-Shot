# Desktop spike: Rust + Tauri

The unchanged editor in a Tauri 2 window (WebView2 on Windows), with `server/serve.mjs` ported to Rust. Findings and
numbers: [LEARNINGS.md §9](../LEARNINGS.md#9-rust--tauri-desktop-app-branch-spike-rust-tauri).

## Build and run

Needs Rust (stable, MSVC), WebView2 (ships with Windows 11), and ffmpeg on PATH for the `/ffmpeg/` routes.

```
cd desktop/src-tauri
cargo build --release                       # 2 min the first time; about 1 min after a change (thin LTO)
target/release/virtual-shot-desktop.exe     # opens the editor from the vs:// scheme
```

Switches (all optional):

| Switch | What it does |
|---|---|
| `--page=/src/index.html?f=300` | the page to open (default `/src/editor/index.html`) |
| `--http=8792 --server=http://localhost:8792` | serve the same routes on a localhost port inside the app and load from it (the fast path for big uploads) |
| `--server=http://localhost:8790` | load from the Node dev server instead |
| `--cdp=9334` | open WebView2's DevTools port (how the scripts below drive it) |
| `--hidden` | never show the window (rendering still runs) |
| `--data=<dir>` | WebView2 profile folder (a new one is a cold start) |
| `--browser-args="..."` | extra Chromium switches, e.g. `--enable-dawn-features=disable_robustness` |

`VS_REPO` and `VS_OUT` override the repo root and the output folder (default: the spike folder on G:).
`npx @tauri-apps/cli@2 build` (from `desktop/`) makes the NSIS installer.

## Measure

From Git Bash, prefix `MSYS_NO_PATHCONV=1`. The Node server (`node server/serve.mjs`) is needed for the Chrome hosts.

```
node desktop/tools/drive.mjs <tauri|tauri-http|tauri-node|chrome|chrome-headless> "<page>" "<js>" [--data=<dir>] [--shot=<png>]
bash desktop/tools/export_matrix.sh "tauri-http:ffmpeg:blob chrome-headless:rgba:blob" [frames]
desktop/wgpu-probe/target/release/wgpu-probe.exe [reps]     # cargo build --release in desktop/wgpu-probe first
powershell -File desktop/tools/cleanup.ps1                  # stop leftover shells, WebView2 and spike Chrome processes
```

In-page benches (`desktop/bench/bench.js`): `exportBench` (paths `none`, `readback`, `dataurl`, `rgba`, `rgba-ipc`,
`ffmpeg`; `body: 'blob'` for raw pixels), `transportBench`, `leakTest`, `playBench`, `editorRender`, `bridgeBench`
(with `node desktop/tools/udp_sender.mjs 10 8799 8798` and the Node bridge from `spike-engine-bridge`).
`desktop/bench/wgsl_bench.html` is the browser half of the shader probe.

## Rules learned

- Serve the page and bulk data from a localhost port inside the app, not the `vs://` scheme: wry reads custom-scheme
  request bodies 1 KB at a time on the UI thread (8 MB: 90 ms against 36 ms).
- POST raw pixels as `Blob`s: Chromium (Chrome and WebView2 155) kept typed-array bodies until the renderer crashed.
- A force-killed shell leaves its WebView2 processes running with the DevTools port and the page; the next shell with the
  same profile reuses them. `cleanup.ps1` stops them.
- Commands called from a localhost-port page need a capability with an app manifest; the `vs://` page gets them as is.
