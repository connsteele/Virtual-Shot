// Summarise drive.mjs output on stdin: host, startup, backend, then one line per result key.
let s = ''; process.stdin.on('data', d => s += d).on('end', async () => {
  try { const j = JSON.parse(s.slice(s.indexOf('{\n')));
    console.log(j.host, JSON.stringify(j.startup_ms), j.env.backend, j.env.size, 'dpr', j.env.dpr);
    if (j.result && typeof j.result === 'object') for (const [k, v] of Object.entries(j.result)) console.log(' ', k, JSON.stringify(v)); else console.log(' ', JSON.stringify(j.result));
    if (process.env.SAVE) try { (await import('node:fs')).writeFileSync(process.env.SAVE, JSON.stringify(j, null, 1)); } catch (e) { console.log('  (not saved: ' + e.message + ')'); }
  } catch (e) { console.log(s); } });
