// Force a full garbage collection in the running page (DevTools HeapProfiler.collectGarbage).
const port = process.argv[2] || 9334;
const target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page' && !t.url.startsWith('devtools') && t.url !== 'about:blank');
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(r => { ws.onopen = r; });
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) { console.log('gc', m.error ? JSON.stringify(m.error) : 'ok'); ws.close(); process.exit(0); } };
ws.send(JSON.stringify({ id: 1, method: 'HeapProfiler.collectGarbage' }));
