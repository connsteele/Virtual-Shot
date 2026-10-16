// Evaluate a script in a running page over the DevTools protocol (the Tauri shell started with --cdp, or Chrome).
//   node desktop/tools/cdp_eval.mjs "<js, may await>" [port=9334]
const [, , expr = 'location.href', port = process.env.CDP_PORT || 9334] = process.argv;
const target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page' && !t.url.startsWith('devtools'));
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id !== 1) return;
  console.log(JSON.stringify(m.result?.exceptionDetails ? { error: m.result.exceptionDetails.exception?.description } : m.result?.result?.value, null, 1)); ws.close(); process.exit(0); };
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true } }));
