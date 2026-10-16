// Launch the editor in one of four hosts, wait until it is ready, evaluate a script in it and print JSON timings.
//   node desktop/tools/drive.mjs <host> "<page path>" "<js, may await>" [--data=<dir>] [--keep] [--shot=<png>]
// hosts:
//   tauri          the Tauri shell, page from the Rust vs:// scheme
//   tauri-node     the Tauri shell, page from the Node dev server (http://localhost:8790)
//   tauri-http     the Tauri shell, page from the shell's own in-process HTTP port (http://localhost:8792, no Node)
//   chrome         a visible Chrome window (--app), page from the Node dev server
//   chrome-headless  tools/headless.mjs's setup: headless Chrome, page from the Node dev server
// --data: the WebView2 user data folder or Chrome profile (default: a persistent warm one in the scratch folder;
//   pass a fresh folder for a cold start). Startup is measured from process spawn to window.VS_READY.
// Both shells expose the DevTools protocol (WebView2 via --remote-debugging-port), so the same script drives both.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [, , host = 'tauri', page = '/src/editor/index.html', expr = 'true', ...flags] = process.argv;
const opt = k => flags.find(f => f.startsWith(`--${k}=`))?.slice(k.length + 3);
const PORT = +(process.env.CDP_PORT || 9334);
const EXE = process.env.VS_SHELL || path.join(HERE, '..', 'src-tauri', 'target', 'release', 'virtual-shot-desktop.exe');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SCRATCH = process.env.VS_SCRATCH || path.join(os.tmpdir(), 'vs-rust-tauri');
const NODE_BASE = 'http://localhost:8790';
const data = opt('data') || path.join(SCRATCH, host.startsWith('chrome') ? `profile-${host}` : 'webview2-warm');
fs.mkdirSync(data, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanup = () => { try { execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'cleanup.ps1')]); } catch { /* best effort */ } };
cleanup();   // a leftover WebView2 from an earlier run would otherwise be reused, port and page included
const t0 = performance.now();
let proc;
if (host.startsWith('tauri')) {
  const a = [`--page=${page}`, `--cdp=${PORT}`, `--data=${data}`];
  if (host === 'tauri-node') a.push(`--server=${NODE_BASE}`);
  if (host === 'tauri-http') a.push('--http=8792', '--server=http://localhost:8792');
  if (process.env.EXTRA_ARGS) a.push(`--browser-args=${process.env.EXTRA_ARGS}`);   // extra Chromium switches for WebView2
  proc = spawn(EXE, a, { stdio: 'ignore' });
} else {
  const a = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${data}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=1600,900'];
  if (process.env.EXTRA_ARGS) a.push(...process.env.EXTRA_ARGS.split(' '));
  if (host === 'chrome-headless') a.push('--headless=new', '--enable-unsafe-webgpu', 'about:blank');
  else a.push(`--app=${NODE_BASE}${page}`);
  proc = spawn(CHROME, a, { stdio: 'ignore' });
}
let target;
for (let i = 0; i < 300 && !target; i++) {
  await sleep(50);
  // WebView2 shows an about:blank target first, and a session on it doesn't follow the navigation: wait for the page
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(t => t.type === 'page' && !t.url.startsWith('devtools')
    && (host === 'chrome-headless' || t.url !== 'about:blank')); } catch { /* not up */ }
}
if (!target) { proc.kill(); throw new Error('no DevTools target'); }
const tCdp = performance.now() - t0; if (process.env.DEBUG) console.error("target", target.url);
const ws = new WebSocket(target.webSocketDebuggerUrl); let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') console.error('[page exception]', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') console.error('[page]', m.params.args.map(a => a.value ?? a.description).join(' ')); };
await new Promise(r => { ws.onopen = r; });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async js => { const m = await send('Runtime.evaluate', { expression: `(async () => (${js}))()`, awaitPromise: true, returnByValue: true });
  if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || 'page error'); return m.result?.result?.value; };
await send('Runtime.enable');
if (host === 'chrome-headless') {
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: NODE_BASE + page });
}
let ready = false;
while (!ready) {
  if (performance.now() - t0 > (+process.env.LOAD_TIMEOUT || 180000)) throw new Error('page did not load');
  try { ready = await evaluate("window.VS_READY || window.VS_ERROR || false"); } catch (e) { if (process.env.DEBUG) console.error("eval", e.message); }
  if (!ready) await sleep(25);
}
const tReady = performance.now() - t0;
const err = await evaluate('window.VS_ERROR || null'); if (err) { console.error(err); }
const env = await evaluate(`({ ua: navigator.userAgent, url: location.href, backend: (window.VS && (VS.backend || (VS.E && VS.E.shot && VS.E.shot.backend))) || null,
  adapter: await (async () => { try { const a = await navigator.gpu.requestAdapter(); const i = a.info || {}; return { vendor: i.vendor, architecture: i.architecture, description: i.description, features: [...a.features].sort() }; } catch (e) { return String(e); } })(),
  dpr: devicePixelRatio, size: [innerWidth, innerHeight], visibility: document.visibilityState })`);
let result = null, tExpr = 0;
{ const t1 = performance.now(); try { result = await evaluate(expr); } catch (e) { result = { error: e.message }; } tExpr = performance.now() - t1; }
const shot = opt('shot');
if (shot) { const m = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(shot, Buffer.from(m.result.data, 'base64')); }
console.log(JSON.stringify({ host, page, startup_ms: { devtools: Math.round(tCdp), ready: Math.round(tReady) }, env, expr_ms: Math.round(tExpr), result }, null, 1));
if (!flags.includes('--keep')) {
  ws.close();
  try { proc.kill(); } catch { /* gone */ }
  cleanup();
}
process.exit(0);
