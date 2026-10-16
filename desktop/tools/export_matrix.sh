#!/usr/bin/env bash
# Export all 1176 frames of the engine look through each host and path; one JSON per run in rust_tauri/results/.
# usage: bash desktop/tools/export_matrix.sh "<host:path[:body]> ..." [frames=1176]   (body: view | blob)
export MSYS_NO_PATHCONV=1
R="G:/Claude/Virtual Legacy/Channel/Virtual Shot spike/rust_tauri/results"; mkdir -p "$R"
N=${2:-1176}
for hp in $1; do
  IFS=: read -r host path body <<< "$hp"; body=${body:-view}
  timeout ${RUN_TIMEOUT:-400} node desktop/tools/drive.mjs $host "/src/index.html?look=engine&f=0&bg" "(async () => { const b = await import('/desktop/bench/bench.js'); await new Promise(r => setTimeout(r, 1000)); return await b.exportBench({from: 0, n: $N, path: '$path', body: '$body', dir: 'rust_tauri/export/$path' }) })()" 2>&1 \
    | SAVE="$R/export_${host}_${path}_${body}_$N.json" node desktop/tools/fmt.mjs
  sleep 2
done
