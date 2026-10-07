# Virtual Shot spike: handoff

For the Claude threads in a new Virtual Shot project. Read this first, then `LEARNINGS.md` (the findings, with numbers)
for whatever area your thread is about. Connor directs the spike; the look is his call.

## What exists (as of 7 Oct 2026, commit `2ea5656` on `spike`)

- **A parity rebuild of the Black Page cold open** in a WebGPU three.js renderer driven by a scene document
  (`scenes/black_page.scene.json`) and a pure time core (`evaluate(doc, t)`). Engine frames match the Black Page engine
  at 58.8 dB or better; the final look (haze, pops, lens) matches the delivered master at 40 dB or better (median 46).
- **An editor** (`src/editor/`) laid out after Blender, Unreal, After Effects and Resolve: outliner with eye toggles,
  viewport (shot camera or free view, gizmo, Show menu, frame-rate cap, quality menu), inspector with keyframe
  stopwatches, dope sheet and graph editor, Edit / Play / Render modes, undoable commands, save, render to disk with
  Stop, and a Stats overlay with Record / Stop performance captures.
- **The artifact copy**: https://claude.ai/artifact/NXA3hjwnqtV1VzuqrGmsV9 (can't save or render to disk).
- **Outputs** (renders, comparisons, screenshots, perf captures): `G:\Claude\Virtual Legacy\Channel\Virtual Shot spike\`.

## Rules (Connor's, standing)

- Repo: `F:\Repos\Virtual-Shot` (GitHub `connsteele/Virtual-Shot`). Work on the `spike` branch; commit and push often
  (GitHub Desktop once stashed uncommitted work mid-session).
- Write only to the repo and to `G:\Claude\Virtual Legacy\Channel\Virtual Shot spike\`.
- Never change anything in the Black Page folder. Never rebuild over `blender\black_page_anim.blend`; keep
  `blender\export\atmos_final` and `seq_screen`. The dev server mounts these read-only.
- Read models in place from `E:\Assets\Asset Packs\PSX Humble Bundle\PSX Mega Pack 3.1.3\Models\GLB`; never copy, move or
  reorganise anything on E:, and never commit E: assets (`dist/` is gitignored for this reason). The Wii Remote is
  `G:\GPT\Projectless\2026-10-04\gen\outputs\Wii_Remote_LowPoly\Wii_Remote_LowPoly.glb`.
- Deleting goes to the Recycle Bin, never outright; ask before deleting anything of Connor's.
- Creative changes are Connor's call. Match the existing look unless he asks; put new looks behind toggles, off by default.
- Give Connor file links as `%20`-encoded paths.

## How to run, test and measure

```
node server/serve.mjs                               # http://localhost:8790/ (landing), /src/editor/index.html (editor)
node tools/headless.mjs "/src/editor/index.html?f=720&bg" "<js, may await>" [--low] [--shot=<png>]
node tools/build_artifact.mjs                       # then publish dist/artifact/index.html with the changed files
```

- **Browser: Chrome** (or the Claude app's built-in browser, also Chromium). Firefox copies Canvas 2D to WebGPU 20×
  slower (LEARNINGS §7.2), so don't tune for it.
- **Test in a separate headless Chrome** (`tools/headless.mjs`), not the Claude app's browser pane: renders there
  load Connor's machine. From Git Bash prefix `MSYS_NO_PATHCONV=1`. Use `?bg` when a test needs the frame loop
  (headless Chrome doesn't run `requestAnimationFrame`). Capture canvas pixels in the same task as the render.
- **Headless numbers aren't Connor's numbers.** Hidden and headless tabs hid a 200 ms per-frame cost that only a
  visible window showed. Ask Connor for a Stats capture (Record / Stop in the viewport) and read it from
  `G:\…\Virtual Shot spike\perf\capture_*.json`: per-frame CPU split by part, GPU per pass, long tasks, an event log.
- In the page: `VS.cmd(name, args)` runs editor commands; `VS.perf.report()` returns the stats; `VS.E` is editor state.
- Parity checks: `node tools/compare.mjs <run> [frames]` and `node tools/metrics_all.mjs <run>` (`REF=<dir>` for the
  master in `ref_final\`).

## Where things stand on performance (Chrome, RTX 4090)

Play quality: about 1.4 ms CPU and 7.5–9 ms GPU a frame (haze march 5–6.5 ms, depth of field 2 ms, everything else under
0.1 ms). Render quality: haze march about 160 ms one-shot, depth of field 17–31 ms; the editor refines to it in 16 slices
when idle. Playback draws only when the shot frame changes. Shaders compile at load ("Preparing shaders…").

## Open work (suggested threads)

1. **Spike · Shadows.** Nothing casts shadows yet. Connor wants to push this for research. Options: shadows in the
   haze (light shafts from the screen past the remote and keyboard; biggest change, recommended first), soft surface
   shadows from the CRT and ring light, contact shadows or AO. Build each as a Show-menu toggle, off by default.
2. **Spike · GPU chat text.** The chat is Canvas 2D (hundreds of glyphs with `shadowBlur`) uploaded as a 1920×1330
   texture whenever time changes. Draw it on the GPU (glyph atlas or SDF) to remove the upload; must match the
   current look.
3. **Spike · Render-quality DOF.** The gather costs 17–31 ms; a cheaper method changes pixels slightly, so compare
   against the master.
4. **Editor gaps** (LEARNINGS §7): dockable panels, multi-select, adding objects from assets, shot list, typed-key
   editors (focus keys), gamepad free-cam, live haze noise settings.
5. **Architecture doc edits**: LEARNINGS §4 and the "what this says about the architecture" notes in §7.

## Where to look

`LEARNINGS.md` (findings and numbers, by section), `README.md`, `src/editor/` (editor), `src/render/shot_renderer.js`
(passes, `renderSteps` for sliced refine, `mark()` for GPU timing), `src/editor/perf.js` (stats and captures),
`tools/bench_upload.html` (Canvas 2D to WebGPU upload benchmark).
