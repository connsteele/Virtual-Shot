// Run the spike in a separate headless Chrome (not the Claude app's browser pane) and evaluate a script in it.
//   node tools/headless.mjs "<url path>" "<js expression, may await>" [--low] [--keep]
// e.g. node tools/headless.mjs "/src/index.html?f=300" "await VS.exportFrames([300, 720], 'run')" --low
// --low starts Chrome at below-normal priority (long renders), so the rest of the machine stays responsive.
// Needs the dev server (node server/serve.mjs) and Chrome; uses Node's built-in WebSocket for DevTools Protocol.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [, , urlPath = '/src/index.html', expr = 'window.VS_READY', ...flags] = process.argv;
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = +(process.env.CDP_PORT || 9333), BASE = process.env.VS_BASE || 'http://localhost:8790';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--enable-unsafe-webgpu',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--no-first-run', '--no-default-browser-check',
  '--window-size=1920,1200', 'about:blank'], { stdio: 'ignore' });
if (flags.includes('--low')) {
  try { execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${chrome.pid}).PriorityClass = 'BelowNormal'`]); } catch { /* best effort */ }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(t => t.type === 'page'); } catch { /* not up yet */ } }
if (!target) { chrome.kill(); throw new Error('Chrome did not start'); }
const ws = new WebSocket(target.webSocketDebuggerUrl); let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') console.error('[page]', m.params.args.map(a => a.value ?? a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') console.error('[page exception]', m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); };
await new Promise(r => { ws.onopen = r; });
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async js => { const m = await send('Runtime.evaluate', { expression: `(async () => (${js}))()`, awaitPromise: true, returnByValue: true });
  if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || 'page error'); return m.result?.result?.value; };
await send('Runtime.enable');
const nav = await send('Page.navigate', { url: BASE + urlPath }); if (nav.result?.errorText || nav.error) console.error('[navigate]', JSON.stringify(nav));
const t0 = Date.now();
await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
if (process.env.NOWAIT) await sleep(+process.env.NOWAIT); else while (!(await evaluate('window.VS_READY || window.VS_ERROR || false'))) { if (Date.now() - t0 > (+process.env.LOAD_TIMEOUT || 120000)) throw new Error('page did not load'); await sleep(250); }
const err = await evaluate('window.VS_ERROR || null'); if (err) throw new Error(err);
console.log(JSON.stringify(await evaluate(expr), null, 1));
const shot = flags.find(f => f.startsWith('--shot='));   // --shot=<png path>: a screenshot of the page after the script
if (shot) { const m = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(shot.slice(7), Buffer.from(m.result.data, 'base64')); console.log('screenshot', shot.slice(7)); }
if (!flags.includes('--keep')) { ws.close(); chrome.kill(); setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ } }, 1500); }
