// In-page benchmarks for the Rust + Tauri spike. Load from a driven page with
//   (await import('/desktop/bench/bench.js')).exportBench({...})   (viewer: /src/index.html?look=engine)
//   (await import('/desktop/bench/bench.js')).playBench({...})     (editor: /src/editor/index.html)
// Works in Chrome (Node dev server) and in the Tauri shell (Rust vs scheme), which serve the same routes.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const r1 = x => Math.round(x * 10) / 10;
const pad = f => String(f).padStart(5, '0');
const tauri = () => window.__TAURI_INTERNALS__;

async function post(url, body) {
  for (let i = 0; ; i++) {
    try { const r = await fetch(url, { method: 'POST', body }); if (r.ok) return r; throw new Error(`HTTP ${r.status} ${await r.text()}`); }
    catch (e) { if (i >= 4) throw e; await sleep(500 * (i + 1)); }
  }
}

/** Render frames with the viewer and write them out by one of several paths; times each stage on the page.
 *  path: 'none' (render only) | 'readback' (render + getImageData, nothing written) | 'dataurl' (the current
 *  exporter: toDataURL PNG, POST /save/) | 'rgba' (raw pixels, the host encodes PNG: POST /save-rgba/) |
 *  'rgba-ipc' (raw pixels through Tauri's invoke) | 'ffmpeg' (raw pixels piped to ffmpeg: ProRes 4444 .mov etc.) */
export async function exportBench({ frames, from = 264, n = 300, path = 'dataurl', dir = 'rust_tauri/bench', quality = 'render', codec = 'prores4444', inflight = 4, fps = 60, body = 'view' } = {}) {
  const VS = window.VS; frames ||= Array.from({ length: n }, (_, i) => from + i);
  const t = { render: 0, readback: 0, encode: 0, wait: 0 }; let bytes = 0;
  const live = new Set(); const errors = [];
  const track = p => { const q = p.catch(e => errors.push(String(e))).finally(() => live.delete(q)); live.add(q); return q; };
  const throttle = async () => { if (live.size >= inflight) { const t0 = performance.now(); await Promise.race(live); t.wait += performance.now() - t0; } };
  let pipe = null;
  const c0 = VS.composite(); const W = c0.width, H = c0.height;
  if (path === 'ffmpeg') pipe = await (await post(`/ffmpeg/open?w=${W}&h=${H}&fps=${fps}&codec=${codec}&out=${encodeURIComponent(`${dir}.${codec === 'h264' ? 'mp4' : codec === 'png' ? 'png' : 'mov'}`)}`)).json();
  if (path === 'ffmpeg' && codec === 'png') throw new Error('use a %05d pattern for png sequences');
  const start = performance.now();
  let i = 0;
  for (const f of frames) {
    let s = performance.now();
    VS.renderFrame(f, quality); const canvas = VS.composite();
    t.render += performance.now() - s;
    if (path === 'none') { i++; continue; }
    if (path === 'dataurl') {
      s = performance.now(); const blob = await (await fetch(canvas.toDataURL('image/png'))).blob(); t.encode += performance.now() - s; bytes += blob.size;
      await throttle(); track(post(`/save/${dir}/f${pad(f)}.png`, blob));
    } else {
      s = performance.now(); const data = canvas.getContext('2d').getImageData(0, 0, W, H).data; t.readback += performance.now() - s; bytes += data.byteLength;
      // body: 'view' (the Uint8ClampedArray) or 'blob' (WebView2 155 never frees typed-array POST bodies; see leakTest)
      const px = body === 'blob' ? new Blob([data]) : data;
      if (path === 'readback') { i++; continue; }
      await throttle();
      if (path === 'rgba') track(post(`/save-rgba/${dir}/f${pad(f)}.png?w=${W}&h=${H}`, px));
      else if (path === 'rgba-ipc') track(tauri().invoke('save_rgba_ipc', data, { headers: { 'x-path': `${dir}/f${pad(f)}.png`, 'x-w': String(W), 'x-h': String(H) } }));
      else if (path === 'ffmpeg') track(post(`/ffmpeg/frame?id=${pipe.id}&i=${i}`, px));
    }
    i++;
  }
  let s = performance.now(); await Promise.all(live); t.wait += performance.now() - s;
  let ff = null; if (pipe) ff = await (await post(`/ffmpeg/close?id=${pipe.id}`)).json();
  const seconds = (performance.now() - start) / 1000;
  return { path, body, codec: pipe ? codec : undefined, frames: frames.length, size: `${W}x${H}`, seconds: r1(seconds), fps: r1(frames.length / seconds),
    per_frame_ms: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, r1(v / frames.length)])), mb_out_of_page: r1(bytes / 1e6), errors: errors.slice(0, 3), ffmpeg: ff };
}

/** Bytes through each transport: n round trips of size bytes. fetch POST to the host (Node or the vs scheme) and,
 *  in the shell, Tauri's invoke with a raw body. */
export async function transportBench({ size = 1920 * 1080 * 4, n = 30 } = {}) {
  const body = new Uint8Array(size); for (let i = 0; i < size; i += 4096) body[i] = i & 255;
  const out = {};
  // a write that the host discards would be the purest, but both hosts only have /save/: write to a scratch file
  let t0 = performance.now();
  for (let i = 0; i < n; i++) await post(`/save/rust_tauri/scratch/transport.bin`, body);
  out.fetch_post_ms = r1((performance.now() - t0) / n);
  if (tauri()) {
    try { t0 = performance.now();
      for (let i = 0; i < n; i++) await tauri().invoke('echo_ipc', body);
      out.invoke_echo_ms = r1((performance.now() - t0) / n);
    } catch (e) { out.invoke_error = String(e); }   // remote origins (the Node server) need the command allowed in a capability
  }
  out.mb = r1(size / 1e6); out.mb_per_s_fetch = r1(size / 1e6 / (out.fetch_post_ms / 1000));
  if (out.invoke_echo_ms) out.mb_per_s_invoke_round_trip = r1(2 * size / 1e6 / (out.invoke_echo_ms / 1000));
  return out;
}

/** Editor playback: play `seconds` from frame `from` with stats on, return the editor's own perf summary. */
export async function playBench({ from = 264, seconds = 10 } = {}) {
  const VS = window.VS, E = VS.E;
  VS.perf.on(true); E.setFrame(from); await sleep(1500);   // let the still frame's refine finish
  E.perf.reset(); E.togglePlay(); await sleep(seconds * 1000); if (E.playing) E.togglePlay(); await sleep(800);
  const r = VS.perf.report(); VS.perf.on(false);
  return { screen: r.screen, buffers: r.buffers, playback: r.playback, play: r.summary.play, long_tasks: r.long_tasks.length };
}

/** A Render-mode export through the editor's own path (Render quality, final look, toDataURL + POST /save/). */
export async function editorRender({ from = 700, to = 759, dir = 'rust_tauri/editor_render' } = {}) {
  const E = window.VS.E, t0 = performance.now();
  E.emit('renderFrames', { from, to, dir });
  await sleep(100); while (E.rendering) await sleep(100);
  return { frames: to - from + 1, seconds: r1((performance.now() - t0) / 1000) };
}

/** WebView2 leak check: POST n bodies of `size` bytes, handed to fetch as `kind` ('view' a Uint8Array, 'buffer' its
 *  ArrayBuffer, 'blob' a Blob, 'copy' a fresh Uint8Array copy), with `inflight` requests in flight. The caller samples
 *  the renderer's private memory around it (desktop/tools/procmem.ps1). */
export async function leakTest({ kind = 'view', n = 200, size = 1920 * 1080 * 4, inflight = 4, url = '/save/rust_tauri/scratch/leak.bin' } = {}) {
  const live = new Set(); const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const px = new Uint8ClampedArray(size); px[i % size] = i & 255;
    const body = kind === 'view' ? px : kind === 'buffer' ? px.buffer : kind === 'blob' ? new Blob([px]) : px.slice();
    const p = post(url, body).finally(() => live.delete(p)); live.add(p);
    if (live.size >= inflight) await Promise.race(live);
  }
  await Promise.all(live);
  return { kind, n, mb: r1(n * size / 1e6), seconds: r1((performance.now() - t0) / 1000) };
}

/** Camera bridge latency: the same 60 Hz datagrams reach the page through (a) the Node bridge (engine-bridge branch,
 *  server/bridge.mjs, UDP in and WebSocket out) and (b) the shell's Rust UDP listener and a Tauri channel. For each,
 *  sender→page latency at the moment the page's main thread sees the message, and sender→stamp for the Rust path.
 *  `block`: a main-thread stall (ms) every 500 ms, like a Render-quality frame. */
export async function bridgeBench({ seconds = 10, nodePort = 8799, rustPort = 8798, block = 0 } = {}) {
  const now = () => performance.timeOrigin + performance.now();
  const lat = { node: [], rust: [], rust_stamp: [] };
  let ws = null;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${nodePort}/`);
    await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
    ws.send(JSON.stringify({ type: 'hello', v: 1, role: 'sink', name: 'bench', conventions: 'gltf', subscribe: ['cam'] }));
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.type === 'cam' && m.ts) lat.node.push(now() - m.ts); };
  } catch { ws = null; }
  const T = window.__TAURI__;
  if (T) {
    const ch = new T.core.Channel();
    ch.onmessage = s => { const m = JSON.parse(s); if (m.type === 'cam') { lat.rust.push(now() - m.ts); lat.rust_stamp.push(m.rx_native - m.ts); } };
    await T.core.invoke('bridge_listen', { port: rustPort, onMessage: ch });
  }
  const stall = block ? setInterval(() => { const t = performance.now(); while (performance.now() - t < block) { /* busy */ } }, 500) : null;
  window.BRIDGE_READY = true;
  await sleep(seconds * 1000 + 500);
  if (stall) clearInterval(stall); ws?.close();
  const st = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), q = p => Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 100) / 100;
    return { n: a.length, p50: q(0.5), p95: q(0.95), max: q(1) }; };
  return { block, node_ws_ms: st(lat.node), rust_channel_ms: st(lat.rust), rust_receive_stamp_ms: st(lat.rust_stamp) };
}
