# Virtual Shot spike: learnings

The spike rebuilt the Black Page cold open on the architecture sketch's plan: a scene document (JSON, every object
placed as data), a time core (`evaluate`), three.js pinned at r186 (`WebGPURenderer` + TSL), the CRT screen, lens,
squint and depth of field, a timeline scrub and frame export. It reached parity with the Black Page engine frames.
A second round then took the engine to the **final composite**: the Cycles haze and the pops layer, rendered in the
engine instead of Blender, at near visual parity with the delivered master (see [section 6](#6-final-composite-parity-haze-and-pops-in-the-engine)).

**Result, all 1176 frames (pops off, the engine picture):**

| Frames | Backend | Match against `blender/export/final_engine` |
|---|---|---|
| 0–263 (flat chat, before the reveal) | any | 264 of 264 pixel-identical |
| 264–1175 (3D) | WebGPU | PSNR 58.8 dB worst (f725), 69.4 dB median. At most 0.043% of a frame's pixels differ by more than 8/255; differences sit on anti-aliased edges |
| 264–1175 (3D) | WebGL2 fallback, same TSL code | PSNR 66.4 dB worst (f585), 83.0 dB median. At most 0.016% of a frame's pixels differ by more than 8/255 |
| Camera (eye, target, up, FOV) | time core vs `cams_final.json` | within 2e-9 m and 1e-14° on every frame |

Side-by-side and difference images (reference | spike | difference ×16) for the key frames are in
`G:\Claude\Virtual Legacy\Channel\Virtual Shot spike\compare\keyframes\` (f120 flat, f300 reveal, f624 head turn,
f720 stare and squint, f1098 and f1104 ghost flash, f1175 last frame). f1098 is exactly 18.3 s, where the ghost's
attack has not started yet; f1104 (18.4 s) shows the flash at full strength. Per-frame metrics for the whole run are
in `compare\full_v1\metrics_all.csv`.

**Result, final composite (engine + haze + pops), all 1176 frames** against the delivered master
(`final\black_page_opener_final_1080p60_prores4444.mov`, decoded to PNG): worst frame 40.0 dB (f759), median 46.0 dB,
at most 3.3% of a frame's pixels off by more than 8/255 and 0.18% by more than 32/255. Key frames are in
`compare\final_look_keyframes\` and `compare\final_look_sheet.jpg`; per-frame metrics in `compare\final_look_v1\`.
The whole final renders and exports in 185 s; Black Page's pipeline took about an hour at 1080p.

The plan held up where it matters most: a pure `evaluate(t)` plus a three.js renderer reproduced the engine almost
bit for bit, and quickly. What it got wrong or left vague is mostly the scene format (it is too simple for a real shot)
and the plumbing around rendering (export, hidden tabs, artifacts), which is where the time went.

---

## 1. Where the doc's plan was wrong or vague

### Scene format

1. **"No object is placed by code" is right, but layout rules still exist; they move to the editor and the importer.**
   The engine placed the desk, keyboard, pad and remote relative to each other's bounds ("monitor on the desk near its
   back edge", "keyboard 7 cm in front"). The document can store only the results, so something has to run the rules
   once. The importer got them by running the old engine and dumping its world matrices
   (`tools/dump_engine.js` → `data/engine_dump.json` → `tools/import_blackpage.mjs`). Treat "place relative to bounds",
   "rest on surface" and "lift above the bezel" as editor commands that write transforms.
2. **The document needs attachment points (empties).** Three things the engine derived at load have no home in the
   doc's object list: the CRT glass frame (centre, axes and size, measured from the screen primitive), the power LED
   (found by a UV lookup on the monitor texture) and the polaroid's depth (a raycast against the bezel). The spike
   stores them as an `empty` (`glass`, with `size`), an `led` object and two `card` objects. The camera rig and lights
   are defined relative to `glass`.
3. **Keys are richer than `[frame, value, "bezier"]`.** The final script needed:
   - times in **seconds**, not frames: keys sit at 11.2333 s and 19.59 s, and messages at 13.85 s;
   - the curve shaping the segment **into** the key (the After Effects convention the engine uses); the doc does not
     say which side a key's interpolation applies to;
   - **preset curves** (smooth, ease-in, ease-out, exp, back, soft-back, settle). `settle` overshoots and cannot be one
     Bézier (the graph editor's `fitCubic` adds a key to approximate it), so presets must stay first-class;
   - **geometric interpolation** for distance and FOV (`exp` interpolates the ratio), as a per-track setting;
   - handles as `[dt, dv]` offsets per side, plus a break flag;
   - **typed values**: a focus key is a record `{target: "wii", px, band, edge, spot, …}` interpolated in dioptres
     against a distance that is re-measured every frame. A numeric-only track model can't hold it.
4. **The document needs events (clips), not only tracks.** Chat messages, ghost flashes, the remote ringing, the
   counter and the pops are things that start at a time and carry parameters. They are not keyed values. Character
   clips will need the same concept.
5. **Global parameters need a home.** `chaos` drives the chat jitter, the glitch bands and the room's glow colour. It
   is not a property of any object. The spike keys it as `scene.params.chaos`.
6. **Units: the camera was keyed in vertical FOV degrees inside a rig, not in mm.** The camera is a rig: it faces the
   glass head-on at a distance in **glass widths**, pans in glass widths, and turns yaw and pitch about a neck pivot.
   FOV and distance interpolate geometrically. Keying focal length in mm instead changes the motion (equal steps in FOV
   are not equal steps in mm), and the lens adds an overscan, so the rendered FOV differs from the keyed one. The rig
   parameters are what was keyed. The pose (and mm + sensor for Blender or Unreal) is derived.

### Time core

7. **`evaluate(scene, t)` is pure in (document, assets, t), not (document, t).** Focus on "the remote" needs the remote's
   bounds centre, and the ringing LEDs need the LED parts' centroids. Both come from the model file. The spike passes a
   small `geo` object derived once from the loaded assets: `evaluate(doc, t, geo)`. Either cache that derived geometry
   in the document (keyed by an asset hash) or say that evaluate takes an asset context.
8. **Behaviours live in the time core.** The ring pattern, rumble, ghost flicker and focus are code with parameters
   (ported verbatim). The doc's "tracks" layer doesn't mention them; they need a registry of named behaviours whose
   parameters live in the document.

### Layers

9. **The four layers miss a compositor and 2D layers.** The shot is not one 3D render: the chat is a Canvas 2D program
   that is both a texture on the CRT and a full-frame layer before the reveal, then crossfades into the 3D shot (and in
   the final video the pops and the Cycles haze sit on top). The spike composites a 2D layer over the 3D layer with an
   opacity curve. The doc should add a layer stack between the renderer and the output: ordered layers (2D canvas
   programs, 3D renders, overlays) with blend modes and opacity tracks, and "texture sources" so a 2D layer can feed a
   material.
10. **Looks are custom code, not three.js materials.** Black Page's look is an unlit, display-referred shading model
    (the CRT as the only light, a forward lobe, a bounce off the unseen room, LED spill, emissive), a CRT shader, and a
    lens pass with barrel warp, fringing, vignette, squint lids and a scatter-as-gather DOF. None of it is
    `MeshStandardMaterial` or a stock post effect. The doc should plan "look modules": custom materials and post passes
    registered by name, with parameters in the document (`material: "screenLit"`, `look.lens`).

### Tech defaults

11. **Colour pipeline is undecided in the doc, and three.js defaults would change the look.** The engine does lighting
    on sRGB-encoded values and never converts (except DOF, which blurs in a pow-2.2 space). three.js decodes sRGB
    textures to linear and encodes on output. Parity needed `ColorManagement.enabled = false`, every texture
    `NoColorSpace`, and a linear (no-op) output. Missing any one of them silently shifts the colours. Decide per
    project: display-referred for ported looks; linear for new work and EXR passes.
12. **"Render mode = same renderer, higher settings" hides a resolution rule.** The scene buffer grows with the lens
    overscan (1×, 1.5× or 2× the output, per frame) so the barrel warp keeps the centre sharp. Render mode's internal
    resolution is a function of the lens, not only of the output size.
13. **The depth pass is a distance pass with blend rules.** DOF needs Euclidean distance from the eye (not z-depth),
    multisampled and resolved like colour, and additive glows must not write it. See §2 for how that bit.
14. **Frame export is the slow part, and the browser fights it.** Measured in the browser pane on this machine:
    `canvas.toBlob` PNG took ~1 s a frame in a background tab; uploading raw 8 MB frames to the local server took
    ~0.4 s; reading pixels back and compressing them in the page (`CompressionStream`) brought it to 0.16 s (186 s for
    all 1176 frames). The fastest path is the old engine's: draw the WebGPU canvas into a 2D canvas in the same task as
    the render and encode with the synchronous `toDataURL`. That exports all 1176 frames in **50 s**, against **61 s**
    for the old engine on the same machine. No GPU readback, no JS encoding, and the PNG upload is ~0.5 MB.
15. **Background tabs break things that a visible page never notices.** `<img>.decode()` never settles while the tab is
    hidden (the page stopped loading). three's WebGL2 backend waits for GPU readback by polling with
    `requestAnimationFrame`, which never fires in a hidden tab, so exports stalled. Render mode must not depend on
    `requestAnimationFrame` or `decode()`. The spike uses `createImageBitmap` and swaps the rAF polling for timers
    (`?bg`).
16. **Artifacts work for viewing, with an asset step.** The spike runs as a multi-file artifact (modules published
    beside the page, three.js r186 from jsDelivr at the pinned version). Artifacts refuse `.glb` files, so models ship
    as base64 text (+33%), and their embedded textures load through `<img>` to avoid `fetch()` of `blob:` URLs. Total
    1.6 MB. The artifact cannot write frames to disk, as the doc says. Its readout panel checks WebGPU, the gamepad
    policy and the folder picker inside the artifact frame ([spike viewer](https://claude.ai/artifact/NXA3hjwnqtV1VzuqrGmsV9),
    private). I could not open it from this machine's browser pane (not signed in), so those three answers are still
    open.
17. **Play mode can't use Render quality.** On the RTX 4090 the engine picture alone costs 13–24 ms of GPU time a
    frame, almost all of it the DOF gather. With the final look's haze it costs 140–190 ms, about 8 fps, which is why
    the artifact's playback stuttered. A Play quality preset (haze at a fifth of the scene buffer with 4× longer steps
    and a 10×5 light grid, a sparser DOF gather, a small blur on the haze) costs 10–12 ms and plays at the display's
    60 fps; a still frame is redrawn at Render quality. The doc's promise should be "framing and timing hold between
    Play and Render", with quality presets named per mode (see [Performance](#performance)).

## 2. What took longest; what three.js gave for free or fought against

Wall-clock times are this agent session's (start 01:15 UTC):

- **Export plumbing took longest** (about 11 minutes, three rewrites plus two hidden-tab fixes; §5). None of it is
  about rendering: it is getting pixels out of a browser tab quickly and reliably.
- **Reading the old engine came next.** It is 1161 dense lines in one HTML file, and the placement rules, lighting
  uniforms and draw order are interleaved. Dumping its state from the running page made the scene import quick.
- **The render port itself was quick**: first full render at 01:32, parity at 01:35.

**three.js gave for free:**
- glTF loading with node hierarchy, embedded textures and emissive maps. The engine has two hand-written GLB walkers.
- Placement as one matrix on each model's root; the remote's rumble is one `premultiply`.
- Multisampled render targets with two attachments (colour + distance) and automatic resolve. The engine needed ~50
  lines of framebuffer, renderbuffer and blit code, plus a fallback when float targets are missing.
- A WebGL2 fallback from the same TSL graphs, which matched the old GLSL engine even more closely than WebGPU did
  (median 83 dB).
- Pixel readback and `CanvasTexture` uploads.

**three.js fought against:**
- **MRT blending.** Blend modes for extra render targets come from the renderer-level `mrt()` (`setBlendMode`), not
  from a material's `mrtNode`. Non-`output` targets default to no blending, so the additive LED glows overwrote the
  distance pass, and DOF blurred a hard-edged square around the LED. This was the only real parity bug. The first fix
  (on the material) did nothing; the second (on the renderer's MRT) fixed it.
- **`fragmentNode` skips MRT.** A material that should also write distance must use `outputNode` instead.
- **`TextureNode.sample()` clones capture the texture when the graph is built.** Swapping textures later does nothing,
  so post passes bind to render targets that live for the whole session (`setSize` keeps their texture objects).
- **Backend differences leak through.** `readRenderTargetPixelsAsync` returns rows bottom-up on WebGL2 and top-down on
  WebGPU (the first WebGL2 frames came out upside down). The post quad's uv is y-down where the GLSL was y-up; the
  focus spot centre and the DOF spiral had to be mirrored.
- **WGSL is stricter than GLSL.** `smoothstep` with reversed edges isn't promised (wrote `sstep`), texture reads inside
  the DOF loop use an explicit level, and branches became `select`. None of these failed; they were written defensively.
- **Colour management defaults** (see §1.11).

## 3. What could not reach parity, and why

- **Edge pixels on WebGPU.** WebGPU's rasterisation and MSAA resolve differ slightly from WebGL2's, so anti-aliased
  edges (the remote, the polaroid) differ by a few levels. The distance pass resolves differently at those edges too,
  so DOF blurs a pixel or two differently. Worst frame: 0.043% of pixels off by more than 8/255; the largest single
  pixel (182/255) is on the remote's edge during the stare. Not visible at normal size. The same TSL code on the
  WebGL2 backend is several times closer (worst frame 66.4 dB, largest pixel 55/255), which points at the backend,
  not the port.
- **Out of scope, not attempted:** the Cycles haze, the pops layer (it would be another 2D layer on the stack), 4K
  (the chat layer takes a scale; the renderer's 2× path is untested), and the graph editor UI. The evaluation half of
  the graph editor (`segVal`, `bzCtrl`, presets) is ported in `src/core/tracks.js`.
- **Parity depends on the browser.** The chat text is rasterised by Canvas 2D. It is pixel-identical here because the
  reference was rendered in the same Chromium with the same font. Another browser or OS will differ on glyph edges.

## 4. Recommended changes to the doc

Quoted text is the doc's current wording; each item says what to replace it with.

1. **The scene document → the list of contents.** After "Takes: recorded free-cam passes…", add:
   - **Empties and attachment points:** named frames (position, axes, size) on or between objects, such as a screen's
     glass or a light's mount. Rigs, props and lights are placed relative to them.
   - **Events:** things that start at a time and carry parameters (a chat message, a flash, a phone ringing, a clip).
   - **Layers:** 2D programs (Canvas or shader) that render as a function of t, used full-frame or as a texture.
   - **Parameters:** global animated values that several things read (Black Page's `chaos`).
   - **Looks:** named custom materials and post passes with their parameters.
2. **The scene document → "Tracks: a target id, a property path and keys (bezier, linear or hold, with handles)."**
   Replace with: "Tracks: a target id, a property path, a value type and keys. Keys are `{t, v, curve, hi, ho}`: `t`
   in seconds; `curve` shapes the segment into the key and is bezier, linear, hold or a named preset (smooth, ease-in,
   ease-out, exp, back, soft-back, settle); handles are `[dt, dv]` offsets. A track can interpolate geometrically
   (distance, FOV). Values can be numbers, vectors, colours or records (a focus key names a target object)." Update
   the JSON example to match.
3. **Rule 1 "Any frame is `evaluate(scene, t)`"** → "Any frame is `evaluate(scene, t, assets)`, a pure function of the
   document, the loaded assets and time. Assets supply derived geometry (bounds centres, part centroids) that
   behaviours such as focus need."
4. **Rule 3 "Cameras store focal length in millimetres plus sensor size"** → "Cameras store the lens the way it is
   keyed (vertical FOV in degrees or focal length in mm), with the interpolation space explicit. A camera can be a rig
   (head-on to a frame, orbit, rail) whose parameters are keyed. Millimetres plus sensor size is what the Blender and
   Unreal exports write."
5. **Core architecture diagram:** add a "Layer stack" box between the renderer and Render output: "2D layers + 3D
   render + overlays, blend modes and opacity tracks". Add "Look modules (custom materials, post passes)" beside the
   renderer.
6. **Core architecture → "Only the quality settings differ, which is why a previz framing holds in the final render."**
   → "Framing and timing are identical in every mode. Play mode uses a cheaper quality preset (haze sampling, DOF
   taps, buffer scale): the Black Page shot's final look costs 140–190 ms a frame at Render quality and 10–12 ms at
   Play quality on an RTX 4090."
7. **Render mode → Passes:** replace "beauty, depth, normals and an object ID mask" with "beauty, distance from the
   camera (Euclidean, multisampled like colour; additive effects don't write it), normals and an object ID mask".
   Add a bullet: "Internal resolution follows the lens: the buffer grows with barrel-distortion overscan (1×–2×)."
8. **Render mode → Writing to disk:** replace with "Each frame is drawn from the WebGPU canvas into a 2D canvas in the
   same task as the render, encoded with `toDataURL`, and a small local server writes the PNG: 1176 frames at 1080p in
   50 s (the old engine took 61 s). Render mode never depends on `requestAnimationFrame` or `<img>.decode()`, which
   stall in background tabs. The File System Access API is the alternative for the local copy (untested); Electron
   later."
9. **Tech choices table:** keep `WebGPURenderer` with TSL; add to the Why cell: "Proven by the spike: the Black Page
   look ported to TSL in one pass, and the WebGL2 fallback matched the old GLSL engine (median 83 dB)." Add two rows:
   - **Colour pipeline:** "Display-referred, colour management off, for ported looks; linear for new work and EXR."
   - **Artifacts:** "Modules published beside the page; three.js from jsDelivr at the pinned version; models as base64
     text (artifacts refuse .glb)."
10. **Black Page lessons → Keep:** add "the dump hooks: reading the old engine's state from the running page is the
    migration path for any legacy scene". **Change:** add "MRT blend modes are set on the renderer's MRT".
11. **First milestones:** move "rebuild Black Page" from the end of milestone 4 to its own milestone after the time
    core, and note it is done in the spike. Budget the next milestones for the importer, the layer stack and export
    plumbing; the renderer was the cheap part. Replace "First check: gamepads work inside an artifact" with the answer
    from the spike artifact's readout once Connor has opened it.

## 5. Effort per milestone

Agent wall-clock, 7 Oct 2026 (UTC). "Attempts" counts full rewrites or re-renders of that piece.

| Milestone | Time | Attempts | Notes |
|---|---|---|---|
| Read the handoff, doc, engine, script, exports | 01:15–01:20 | 1 | engine.html is the bulk |
| Scene document + importer (dump the engine's placements) | 01:20–01:25 | 1 | 10 objects, 10 tracks, 19 KB |
| Time core + camera check | 01:25 | 1 | matched `cams_final.json` on the first run |
| Chat 2D layer | 01:26 | 1 | verbatim port; pixel-identical |
| Renderer: TSL materials, lens, DOF, MRT | 01:27–01:32 | 1 | |
| Parity debugging | 01:32–01:35 | 2 fixes | MRT blending (material-level fix did nothing; renderer-level fixed it) |
| Frame export | 01:36–01:47 | 3 rewrites | toBlob 1 s/frame → raw upload 0.4 s → in-page deflate 0.16 s; plus `decode()` and rAF hidden-tab fixes |
| Full run + metrics (1176 frames) | 01:47–01:52 | 1 | render 186 s; metrics 99 s |
| WebGL2 fallback | 01:51–01:59 | 2 | readback rows came back upside down; full run 322 s |
| Artifact build | 01:53–01:58 | 2 | `.glb` refused → base64 text |
| Performance check | 02:00–02:03 | 2 | page timings were inflated by the background tab; GPU timestamp queries gave the real cost |
| LEARNINGS.md | 01:58–02:08 | 1 | |
| Render time vs the old engine | 02:08–02:22 | 3 | timed both engines; canvas export path (50 s vs 61 s) |

## Performance

RTX 4090, Chrome 152 in the Claude desktop browser pane, 1920×1080, background tab.

| Measure | Result |
|---|---|
| GPU time per frame, full quality (timestamp queries) | 24.1 ms at the reveal, 16.8 ms in the stare, 12.9 ms near the end |
| GPU time per frame, DOF off | 0.1–0.3 ms |
| Old engine GPU time per frame (WebGL2 timer queries around `renderAt`) | 19.2 ms at the reveal, 11.5 ms in the stare, 7.8 ms near the end; 0.5–1.5 ms with DOF off |
| Spike's TSL on the WebGL2 backend (three's timestamp queries) | 8.8 / 7.1 / 6.1 ms; 0.2–0.9 ms with DOF off |
| **Export, all 1176 frames, same machine and pane (render + PNG + write)** | **old engine 61 s; spike on WebGPU 50 s** (canvas path) |
| Export, spike, GPU readback + `CompressionStream` path | 186 s (WebGPU), 322 s (WebGL2) |
| Engine time per frame as seen from the page | 60–130 ms, inflated by background-tab scheduling; GPU time above is the real cost |
| **Final look (haze + pops), GPU time per frame**, headless Chrome | Render quality 38 ms (reveal) to 188 ms; Play quality 10–12 ms |
| Final look playback, 10–14 s, headless Chrome (no vsync) | Render quality 7.7 fps; Play quality 105 fps |

GPU clocks matter: in the browser pane's background tab the 4090 stayed at 540 MHz (P3) and the same frames measured
about twice as slow. Benchmarks and long renders now run in a separate headless Chrome (`tools/headless.mjs`, Chrome's
DevTools protocol over Node's built-in WebSocket, optional below-normal priority), which also keeps the load out of
the Claude app. Its frames match the pane's exactly in the comparisons.

The GPU numbers come from two different timer methods, so compare them loosely. The pattern is clear, though: the
depth of field is nearly all the cost in every version, and the WebGPU backend runs this DOF pass 1.3–2× slower than
the same TSL compiled to WebGL2 (and than the old GLSL). That matters for 60 fps playback, not for exports, which are
bound by PNG encoding and upload. Profiling the WebGPU DOF (loop codegen, robustness checks on texture reads) is the
first performance task if WebGPU is the main backend.

The old engine also can't start in a hidden tab: its `init3D` waits on `<img>.decode()`. Black Page's exports
presumably ran with the pane visible; the benchmark above patched `decode()` to run it in the background.

## WebGL2 fallback

`?webgl` forces three's WebGL2 backend with the same TSL graphs. After one fix (readback rows are bottom-up on WebGL2),
it matched the Black Page engine more closely than WebGPU did: worst 3D frame 66.4 dB, median 83.0 dB, no frame with
more than 0.016% of pixels off by more than 8/255, largest single-pixel difference 55/255. WebGL2 rasterises like the
old engine (also WebGL2), so this pins the WebGPU residuals on the backend's rasterisation and MSAA, not on the port.
The fallback works, but frame export from a hidden tab needs `?bg` (see §1.15).

## 6. Final-composite parity: haze and pops in the engine

Black Page's final is the engine picture plus two passes made elsewhere: a Cycles haze pass (path traced in Blender,
2.5 s a frame at 1440×810) and the engine's pops layer, assembled in Blender's compositor with a per-frame haze level.
This round rebuilt both inside the spike's engine and composited them on the GPU in the same frame.

| Frames | Backend | Match against the final master |
|---|---|---|
| 0–263 (flat chat) | WebGPU | 68–75 dB (the master's 4:4:4 ProRes round trip) |
| 264–1175 (3D, haze, pops) | WebGPU | worst 40.0 dB (f759), median 45.2 dB; median 0.74% of pixels off by more than 8/255 |
| f720, f1104 | WebGL2 fallback, same TSL | 49.7 dB and 41.0 dB, the same as WebGPU |

| Cost | Black Page | Spike |
|---|---|---|
| Haze, one 1080p frame | 2.5 s (Cycles, OptiX, 128 samples, denoised) | about 0.1 s of GPU time (whole frame 114–137 ms) |
| Final, all 1176 frames | about 1 h after any picture change (engine passes, camera export, haze scene rebuild, haze, composite) | 185 s, one browser tab |

**How it got there:**
1. **The density field is Cycles' own.** `src/render/cycles_noise.js` ports Blender's Noise Texture from the v5.1.0
   source (4D Perlin, the lookup3 hash, normalized fBm, distortion) to TSL with 32-bit integer maths. With the final
   haze settings (`final\atmos_build.py`: fine wisps, scale 3, distortion 0.9, drift and evolve) the spike draws the
   same wisps in the same places as the Cycles render. This is what made the first try look right.
2. **The lighting is Cycles' scene, approximated.** Single scattering, Henyey-Greenstein g 0.3. The CRT screen is a
   20×15 grid of area cells emitting 100× the linear screen image (the CRT shader rendered flat and averaged per cell),
   placed by fitting the glass mesh's uv to world space. The ringing remote is a point light of P/4π W/sr, plus the
   LED's teal spill. A half-resolution ray march with 1.5 cm steps runs from the camera to the scene's distance pass,
   then the haze takes the engine's lens warp, fringe, vignette and squint, as `blender\post.py` did.
3. **Absolute brightness came out within 6% of Cycles.** One global exposure of 1.055 calibrates it; per-frame levels
   sit within about ±6% of Cycles' for 80% of frames, with a log-level correlation of 0.998 over 911 frames. The
   physical units line up without tuning.
4. **The level curve became baked data.** The compositor scaled each frame's haze toward a target brightness using the
   haze's measured level averaged over ±0.5 s. That needs neighbouring frames, so it is not a function of t alone.
   An analysis pass (`VS.measureHaze`) measures every frame and the levels are baked into the document
   (`look.haze.levels`); `evaluate` computes the gain from them and stays pure.
5. **Pops are a 2D layer, composited in linear light** like Blender's alpha-over.
6. **The composite is one GPU pass**: engine picture (with the flat crossfade) → linear + haze × gain → pops
   alpha-over → sRGB.

**What it cost, attempts and gotchas (about 35 minutes, 02:21–02:55 UTC):**
- **The pops' jitter is seeded by each pop's index in the list.** The final's pops layer was rendered with the
  original 17-pop list; when 6 pops were cut, a few frames were re-rendered with the 11-pop list. Matching it needs
  both seeds, and which frames used which can't be derived from the script: rendering all 177 pop frames both ways
  against `blender\export\final_pops` showed 174 used the 17-pop seeds and 3 (1097, 1154, 1155) the 11-pop seeds,
  each an exact match. Seeds should come from stable ids, not list positions.
- **Silhouettes need a coverage-aware distance pass.** The multisampled distance averaged near and far at the
  monitor's edge, which drew a dark outline in the haze. The pass now stores (coverage × distance, coverage), and one
  march mixes the haze up to the surface with the haze past it, as Cycles' many samples per pixel do.
- **A `sin`-based jitter hash left diagonal hatching** in the haze; a PCG integer hash fixed it.
- **A TSL `Fn` with a typed layout that read uniforms** was shared by two materials (the screen mesh and the flat
  screen pass) and produced WGSL that referred to an undeclared uniform block. Building the nodes inside each
  material fixed it.
- **The level calibration was redone once**, after the light grid went from 12×9 to 20×15. The finer grid fixed most
  of the haze over the screen and cut the worst frames' share of pixels off by more than 8/255 from 5% to 1.5%.

**Not at parity, and why:**
- **Haze just in front of the glass.** Cycles' haze there shows a soft copy of the text; a 20×15 light grid blurs it.
  This is most of the residual over the screen from 15 s on. A finer grid or a mip-mapped screen texture sampled per
  cell would close it, at more cost.
- **Grain.** Cycles' denoised noise and the march's jitter are both random; they can't match pixel for pixel.
- **Not modelled:** geometry shadowing the haze's light, and attenuation along light paths. Neither showed up in the
  comparison.
- **Pops edges** differ slightly: an 8-bit straight-alpha canvas composited in linear here, Blender's premultiplied
  float there.

**What this means for the doc:**
- The engine can replace an offline volumetric pass when the look is single-scattering haze: about 20× faster than
  Cycles here and visually at parity, and it re-renders with the picture instead of after an hour of passes. It was a
  fragment-shader ray march; WebGPU compute wasn't needed.
- To match a Blender look, port Blender's procedural textures rather than imitating them: the density field carried
  over exactly.
- Analysis passes (levels, auto-exposure, anything that looks at neighbouring frames) should write baked data into
  the document, so `evaluate` stays pure.
- The layer stack (§1.9) needs linear-light blending and a haze layer as well as 2D layers.
- Random seeds should come from stable ids, never list positions.

## 7. The editor

`src/editor/` is a first editor on the scene document, laid out from the tools Connor uses: an Outliner (Blender,
Unreal) on the left, the viewport in the middle, an Inspector (Blender Properties, Unreal Details) with After Effects
stopwatches on the right, and an After Effects-style timeline along the bottom with a dope sheet and the graph editor
ported from Black Page. Edit, Play and Render are page tabs in the top bar, as in Resolve.

What it does:
- **Viewport.** The shot camera with the final look (Play quality while things move, Render quality when they stop),
  or a free view lit for editing, with Blender navigation (middle-drag orbit, Shift+middle pan, wheel zoom, F to frame
  the selection), click to select, and a move/rotate/scale gizmo (G, R, S). Free view draws the grid, the shot
  camera's frustum, the haze box, the glass frame's axes, the LED and ring lights, and the selection's bounds. Camera
  view shows action- and title-safe frames.
- **Inspector.** Transforms for placed objects; the camera rig's eight properties, each with a stopwatch (animate it),
  its value at the playhead, and previous key / key here / next key; the chat messages, ghost flashes and pops as
  editable lists; lighting and haze strength. Editing an animated value at the playhead sets a key there (After
  Effects); editing a static one sets its value.
- **Timeline.** Ruler with reveal and cut markers, playhead scrub, keys per object and property with After Effects key
  icons, box select, drag to retime (snapped to frames), double-click to add a key, Delete; event lanes where messages,
  ghosts and pops can be dragged in time. The graph editor shows chosen curves with Bézier handles, interpolation
  buttons and the Black Page presets (settle, soft-back, exp…).
- **Commands.** Every edit is a named command on the document (`src/core/commands.js`: setKey, deleteKeys, moveKeys,
  setTransform, setEvent, setLook…) with snapshot undo and redo. The same commands are scriptable from the page
  (`VS.cmd('setKey', {...})`), which is how the editor was tested from a headless Chrome.
- **Render and Save.** Render mode writes a frame range to disk at Render quality (10 frames in 1.9 s; they match
  the final master at 51 dB). Save writes the scene file back to `scenes/` through the dev server; in the artifact,
  where files can't be written, it copies the scene JSON and keeps a draft in the browser.

Effort: about 35 minutes (03:26–04:00 UTC), roughly 900 lines of editor code. Plain DOM and CSS grid were enough for
the spike; no UI library.

**What three.js gave for free:** `OrbitControls` and `TransformControls` work with `WebGPURenderer` unchanged, and
raycasting picks the glTF models directly. The gizmo drives a proxy object; its transform is written back to the
document, so the scene document stays the only source of truth.

**What the editor taught us about the plan:**
- **Commands and snapshot undo were the right call.** At this document size (about 50 KB) a JSON snapshot per edit
  is instant, can't drift from the commands, and made undo, live drags (snapshot, mutate, commit once) and scripting
  one mechanism. Exposing the commands made the doc's "Claude control" idea work with no extra code.
- **Derived data goes stale when the document changes.** Moving the Wii Remote left its focus point and ring lights
  behind until the renderer recomputed them from the document. The baked haze levels (§6) also go stale when an edit
  changes the picture. The architecture needs a rule for derived and baked data: recompute on change, or mark it stale
  and re-run its analysis.
- **The shot is too dark to edit in.** It is lit by the screen alone and black before the reveal. Free view renders
  it as after the reveal with a little fill light, the way Blender's solid view does.
- **Typed keys need their own editors.** Focus keys are records (a target object and blur settings); the dope sheet
  shows them, but editing them needs a custom inspector. Every typed track (focus, events, colours) will.
- **Still missing:** resizable and dockable panels, multi-selection in the viewport, adding objects from assets, the
  shot list, gamepad free-cam and takes, and live editing of compiled look settings (the haze's noise settings need a
  shader rebuild).

**Process lessons from this round:**
- GitHub Desktop stashed the uncommitted work mid-session (`stash@{0}: !!GitHub_Desktop<spike>`, which
  removed two new files and reverted one edit). The work was redone and committed straight away; the stash is still
  there, untouched. Long agent sessions should commit work in progress often.
- Git Bash rewrites arguments that look like absolute paths (`/dist/...` became `C:/Program Files/Git/dist/...`), so
  the headless runner needs `MSYS_NO_PATHCONV=1` for URL paths without a query string.

### 7.1 Why the editor felt choppy, and visibility toggles

Connor found the editor choppy. Measured per frame in headless Chrome (RTX 4090, WebGPU), at frames 300 / 720 / 1000:

| | Render quality | Play quality |
|---|---|---|
| Whole frame | 66 / 156 / 178 ms | 7 / 14 / 14 ms |
| Haze ray march alone | 27 / 161 / 202 ms | 3 / 6 / 5 ms |
| Everything but the haze | 12 / 17 / 16 ms | 6 / 6 / 6 ms |

The haze was about 90% of a Render quality frame. The editor drew Render quality straight away for any change that
wasn't a drag (a frame step, a click, an inspector edit), and refined to Render quality 220 ms after a drag stopped, so
each of those cost a 150–200 ms stall, and a drag that started during a refine waited for it.

What changed:
- **Every change draws at Play quality first** (7–23 ms). After 250 ms without changes, the camera view refines to
  Render quality in 16 horizontal bands of the haze march (one band per step, 15–35 ms each, scissored, no clear), and
  any change drops the refine. The bands add up to the same picture as a one-shot Render quality frame (identical
  pixels at frames 720 and 1000). A Quality menu can turn the refine off ("Play quality only").
- **A Show menu** in a viewport header (Unreal's Show flags, Blender's Overlays popover): haze, depth of field, lens
  warp, LED glows, ghost flashes and pops; and the overlays (safe frames, grid, shot camera, haze bounds, lights,
  selection bounds). Without haze, a Render quality frame is 12–22 ms; without haze, lens warp and depth of field, 6 ms.
- **Eye toggles in the outliner** (Blender) for each placed object and for the haze, ghost flashes and pops. H hides
  the selection, Alt+H reveals everything. Hidden objects can't be picked, and an LED glow hides with its object.
- **Viewport only.** These settings live in the browser, not in the scene document, and frames rendered to disk always
  have the full look and every object (checked: identical pixels with the haze off and the remote hidden).

**What this says about the architecture:**
- **Viewport quality is a policy, separate from the look.** The look's settings define the picture; the editor
  chooses how much of it to compute while someone works. The doc should define the quality tiers (Play, Render) as
  sampling choices with the same framing, timing and settings (it does for playback) and make progressive refinement
  the editor default.
- **Expensive passes should be sliceable.** Anything that can't finish in a frame (the haze march here; path tracing
  or heavy bakes later) should render in pieces that can be dropped. A full-screen pass with a scissor rectangle was
  enough here.
- **Viewport visibility is editor state.** Hiding things in the viewport shouldn't change the document or the
  render (Blender's eye versus its render toggle). If the shot needs render-time switches, they belong in the
  document as their own settings.

**Gotchas:**
- A WebGPU canvas only holds its picture until it is presented. `drawImage(canvas)` in the same task as the render
  works (the export path does this); after an `await`, it returns a blank image, which made a first test report
  "no difference" for everything.
- `queue.onSubmittedWorkDone()` can take seconds to resolve in Chrome when no frames are being drawn (headless, or no
  animation frame requested). The refine waits for it to pace the bands, but caps the wait at 40 ms.
- Headless Chrome doesn't run `requestAnimationFrame` here unless frames are forced, so editor tests that need the
  frame loop run with `?bg` (timers instead of animation frames).

### 7.2 Performance stats

A Stats button in the viewport header opens an overlay (Unreal's `stat fps` and `stat unit`): frames per second
that reached the screen, CPU time to build and submit the last frame, its GPU time, GPU time per render pass as bars,
the last refine's GPU total, dropped frames during playback, and a graph of the last 120 frames against the 60 fps
line. "Save report" writes a JSON report to the spike folder (`perf/editor_perf_<time>.json`: GPU and browser, buffer
sizes, viewport settings, per-kind percentiles, per-pass means and the last 200 frames); the artifact copies it
instead, and `VS.perf.report()` returns it to scripts, so Connor and Claude read the same numbers.

GPU times come from WebGPU timestamp queries, which three.js records per render call when `trackTimestamp` is on.
three keys them by `renderer.info.frame`, which only advances with its own animation loop, so `ShotRenderer.mark(name)`
sets that number before each pass and keeps a name for it; after resolving, each duration maps back to a named pass.
That's a workaround: the doc's renderer should name its passes and expose timings itself.

First readings (headless Chrome, RTX 4090, frames 700–760):

| GPU ms | Play quality | Render quality |
|---|---|---|
| Haze march | 3.6–8 | ~160 one-shot; 12–50 per band |
| Depth of field | 1.3–2.8 | ~31 |
| Scene (4× MSAA, 2880×1620) | 0.1–0.2 | 0.2 |
| Lens, focus, light grid, composite | under 0.1 each | under 0.1 each |
| Whole frame (mean) | 11 | |

- **Depth of field is the second cost** at Render quality (its gather steps every half pixel; Play steps every 2–3).
  It's worth a cheaper Render quality path (a separable or mip-based blur) before the doc commits to this gather.
- **The scene itself is nearly free.** The PSX models cost nothing; the look's passes are the whole bill. The
  architecture's budget should be stated per pass, not per scene.
- **Slicing costs total GPU time.** A full refine measured 189 ms in one run and 503 ms in another for the same frame:
  the GPU idles between bands and its clocks drop. Fewer, larger bands while nothing else is happening, or a
  compute pass the GPU can schedule itself, would recover some of that.
- Headless playback numbers (fps, dropped frames) come from the timer-driven loop and don't mean anything; they need
  a visible browser.

**Connor saw about 5 fps panning the free view with the haze off, with CPU time looking like the bottleneck.** Measured
the same pan in headless Chrome and in the Claude app's browser (a hidden tab): 1–5 ms of JavaScript and 0.4 ms of GPU
per frame, so the render path doesn't explain it. The one CPU-to-GPU copy per frame was the chat text, which is drawn
with Canvas 2D and uploaded as a 1920×1330 texture (about 1.2 ms); the 2D layers are now redrawn and uploaded only when
time or the document changes, so camera moves, toggles and object moves reuse them (identical pixels; a free-view pan
frame went from 1.8 to 1.15 ms). The stats now also show the time between frames on screen and the browser's long
tasks (main-thread work of 50 ms or more outside our frames), so a slow pan in a visible window shows where the time
goes. Open question until Connor's report comes back. For the architecture: every per-frame CPU-to-GPU copy needs a
reason, and text that animates every frame (the chat) is a candidate for drawing on the GPU (a glyph atlas) instead of
Canvas 2D.

**Follow-up from Connor:** skipping the chat redraw and upload took free-view panning from about 5 fps to his monitor's
refresh rate, haze on or off. So on his visible browser, redrawing and uploading the Canvas 2D chat (a 1920×1330
texture drawn as hundreds of glyphs, each with `shadowBlur`) cost on the order of 200 ms a frame, while hidden or
headless tabs measured about 1 ms. Measuring only in hidden tabs hid the real bottleneck. The camera view still
redraws the chat whenever time changes (scrubbing, playback), so it is still slow there. To capture specific cases,
the stats overlay has Record and Stop: everything between them is saved as one capture (`perf/capture_<time>_<label>.json`)
with a label, an event log (edits, view and mode switches, playback), long tasks, and a CPU breakdown per frame (2D
chat, 2D pops, three's encode and texture uploads, panels).

**Connor's first capture was in Firefox 157,** which is his everyday browser. Camera-view frames spent 30–550 ms of CPU
in three's encode with texture uploads (the 2D chat, flat frame and pops canvases) against 7–25 ms of GPU; drawing the
chat measured 0–3 ms because Firefox defers the work to the upload. `tools/bench_upload.html` times seven ways of
getting a 1920×1330 Canvas 2D drawing into a WebGPU texture:

| median CPU ms | Chrome 152 (headless) | Firefox 157 (Connor's) |
|---|---|---|
| Draw only | 0.3 | 14 |
| `copyExternalImageToTexture(canvas)` (current) | 1.1 | 21 |
| `getImageData` + `writeTexture` | 3.7 | 19 |
| `createImageBitmap` + copy | 1.9 | 22 |
| `OffscreenCanvas.transferToImageBitmap` + copy | 1.0 | 25 |

Firefox has no fast path: its Canvas 2D text with glow is drawn on the CPU, and every way into WebGPU costs about
20 ms more in isolation, and much more inside a real frame. Firefox also rounds `performance.now()` to whole
milliseconds and resolves `onSubmittedWorkDone()` about every 100 ms, so its stats are coarser. **Decision: Chrome
(or the Claude app's built-in browser, also Chromium) is the browser for the editor**, and it is what the headless tests
measure. For the architecture: state the supported browser, and treat Canvas 2D as a convenience for layers that
change rarely. A layer that animates every frame should be drawn on the GPU (glyph atlas or SDF text), which would also
make Firefox usable.

**In Chrome, Connor's playback capture** (22 s, 2,144 frames) showed CPU at 1.4 ms a frame (mean) and GPU at 5 ms
(7.5–9 ms once the haze is on: haze march 5–6.5 ms, depth of field 2 ms, everything else under 0.1 ms), with 50 of
2,974 shot frames dropped. Playback was drawing at his monitor's refresh rate (about 6.4 ms between frames, 120 Hz or
more) although the shot is 60 fps, so it drew most frames two or three times. It now draws only when the shot frame
changes, which cuts playback GPU load by more than half on a high-refresh monitor. Lesson for the doc: the player
should be clocked by the shot's frame rate, not the display's.

**Frame-rate cap and V-Sync.** The viewport header has a frame-rate cap per view (Display, 120, 60, 30, 24, 15; camera
and free view keep their own). A page can't turn V-Sync off: the browser draws on the display's refresh through the
desktop compositor, so the driver's V-Sync setting doesn't apply to it and there is no tearing or conflict. A cap
below the refresh rate spaces frames on refresh boundaries, averaging the cap. Playback keeps real time under a cap
(skipping shot frames on purpose, not counted as dropped).

**First-use shader compiles.** In a fresh browser profile the first playback froze for about 9 s while Chrome compiled
the pipelines in the background (the haze march with the Cycles noise port is the big one). The editor now renders a
few frames at both qualities while loading and waits for the GPU, so the wait happens behind "Preparing shaders…"
at load. Chrome caches compiled shaders, so later loads are quick. The architecture should precompile its pipelines at
load (three's `compileAsync` covers scene materials but not full-screen passes).

## 8. Chunky-pixel look (480p, area-upscaled to 4K)

- A Show-menu toggle (Style › Chunky pixels, off by default; `?pixels` on the app page). `ShotRenderer.setPixelLook()`
  renders the whole frame (3D, lens, DOF, haze, chat, pops) at 854×480, then area-upscales it to 3840×2160
  (`makeAreaUpscale` in `final_comp.js`, after Dolphin's Area Sampling resampler). Renders to disk follow the toggle.
- The look goes before the upscale, so haze and DOF are at 480p too, like a game at native resolution. DOF radii and
  the haze buffer scale with the internal size already (`H / 1080`, fractions of the scene buffer).
- Area sampling at 4.5× keeps every source pixel a hard block of even width, with a one-pixel blend at block edges;
  nearest gives 4- and 5-pixel blocks, bilinear blurs. The pass is a 4-tap shader, a few ms of headless frame time at most.
- In the Black Page shot the effect is mild (dark, DOF-blurred); it shows on the remote's edges and the screen text.
  Chunkier options: no 4× MSAA in this mode, or fewer lines. Frames: `Virtual Shot spike\chunky_pixels_v1\`.
- **v2** (frames: `chunky_pixels_v2\compare_2x2\`). Options in the Show menu under Chunky pixels: lines (480/360/240),
  colour (24-bit, or 18/15-bit with a 4x4 Bayer dither per internal pixel, like a console frame buffer), screen text,
  4× MSAA (off by default now; the jaggies are the look). Defaults: 480, no AA, 18-bit, screen text sharp at 1080.
- **Screen text readability.** In the wide shot (about f390–600) the chat is 2–4 internal pixels tall: unreadable at
  480 however it's filtered. Fix, mixed resolution (HD-2D style): in the upscale pass the screen shader is re-evaluated per
  output pixel where the camera ray (through the lens warp) meets the glass plane, and swapped in, in linear light, for
  the screen colour its internal pixel was drawn with. That one is re-evaluated too (at the pixel centre, with the chat's
  mip level for an internal-pixel footprint), so nothing of the blocky text is left behind; subtracting a box mean
  instead left dark fringes. Haze, light, glows and the blocky screen edge stay chunky. The mask is a screen flag in
  the distance pass (g = 2 with r scaled by it, so r/g, which the haze and CoC read, stays the distance). Faded out when
  the screen is out of focus (|CoC| 1–3 px), under the pops and in the flat crossfade. The screen's own grid is
  selectable: 1080 lines (sharp but still pixelated, the default) or 4K.
- The chat texture gets mipmaps in the pixel look (`S.mip`, lod from the uv derivatives): the engine's single taps
  sparkle at 480.
- GPU (headless, f420, Play quality): pixel look total is lower than the normal look (haze march 4.8 vs 11.7 ms, DOF
  0.4 vs 4.3 ms); the upscale is 0.8 ms, 0.9 ms with the sharp screen.
- **v3** (frames: `chunky_pixels_v3\compare_2x2\`), all toggles under Chunky pixels, off by default:
  - Pixel outlines (`makeOutline`, post.js): from the distance pass alone, before the lens. Silhouettes (a neighbour
    farther by > 4%) darken, convex creases (nearer than the neighbours' mean by > 0.2%) lighten. In this dark scene
    darkened silhouettes barely show against black; the crease highlights (keys, bezel, stand) carry the look.
  - Banded lighting (`U.bands` in bodyMaterial): each light's falloff (screen spill, bounce, LED, ring) snapped to steps
    of equal ratio, 1 or 2 per doubling, so falloff lands in hard-edged tones.
  - Wii bloom (`makeBloom`): bright pass (threshold 0.2, display values) at quarter size, 13-tap gaussian each way,
    added into the internal frame in the upscale before the dither, so it is chunky and dithered like the rest. A 0.45
    threshold showed almost nothing here: the brightest things are the chat text and the LED.
  - Pixel-stable camera (`snapCamera`): snaps the camera to whole internal pixels at the target distance and shifts the
    picture back by the remainder. It made things worse on this shot (frame-to-frame change in the internal frame
    1.73 vs 1.35, f440–470): the moves are pushes, FOV changes and lens warp, which translation snapping can't hold
    still. It's for orthographic or pan-only cameras; kept as an experimental toggle. It also moves the pops by the
    sub-pixel remainder.
- The default look is unchanged by all of this: frames 120/300/720/1100 are bit-identical to before the pixel look
  (PSNR infinite).

## 9. Rust + Tauri desktop app (branch `spike-rust-tauri`)

Question: what fundamentally changes, and what is gained or lost, if Virtual Shot becomes a Rust + Tauri desktop app
instead of a browser three.js app? Built a Tauri 2.12.4 shell around the unchanged editor, ported the local server to
Rust, then measured each place Rust could take over against Chrome 155 on the same machine (RTX 4090, 160 Hz monitor).

**Answer in one paragraph.** The editor runs unchanged in Tauri's WebView2, which is Chromium 155 like Chrome 155, so
rendering, WebGPU, shaders, playback and frames are the same: pixel-identical frames, the same GPU time, the same
startup. Everything Rust added that mattered (writing straight to G:, piping frames into ffmpeg for a ProRes master,
receiving Blender's camera) came from *having a native host process*, which the Node dev server already is: the same
features in Node measured the same. Rust only wins where the work leaves the browser entirely: the same WGSL run
natively through wgpu was 4–23% faster on DX12 and up to 40% faster on Vulkan, but getting that means replacing three.js
and TSL with a renderer of our own. **Recommendation: stay browser-first with the Node host for now; when a desktop app
is wanted, make it a Tauri shell only (it replaces "Electron later"); don't move rendering into Rust.**

### What was built

- `desktop/src-tauri/` (Rust): a Tauri window that loads the editor from one of three places: the `vs://` URI scheme
  served from Rust (`http://vs.localhost` on Windows), an HTTP port inside the shell (`--http=8792`, tiny_http), or the
  Node dev server (`--server=`). `serve.rs` is `server/serve.mjs` ported route for route (repo, the read-only `/bp/`,
  `/psx/`, `/wii/` and `/bp-final-ref/` mounts, `/save/`, `/save-scene/`, `/save-rgba/`, `/save-idat/`), so the page
  needs no changes and still runs in Chrome. New in both hosts: `/ffmpeg/open|frame|close`, raw RGBA frames piped into
  ffmpeg (ProRes 4444 by default, ProRes 422 HQ, H.264 on NVENC), written in frame order even when uploads arrive out
  of order. `serve.mjs` got the same routes, to separate "native host" from "Rust". Also: a UDP camera listener for the
  engine bridge's `vsb/1` datagrams feeding a Tauri channel (`bridge.rs`), raw-body IPC commands, and the switches
  `--cdp` (WebView2's DevTools port), `--hidden`, `--data` and `--browser-args`.
- `desktop/tools/drive.mjs` launches the editor in Tauri (three ways) or Chrome (visible or headless), times startup and
  runs a script in the page over the DevTools protocol, so every number below comes from the same in-page code
  (`desktop/bench/bench.js`). `desktop/wgpu-probe/` runs `desktop/bench/probe.wgsl` natively; `wgsl_bench.html` runs it
  in a browser. How to run: `desktop/README.md`.
- Results (JSON per run), the ProRes masters, renders and the Blender test: `Virtual Shot spike\rust_tauri\`.

### Measurements

**Rendering and the editor: no difference.** WebView2 155 exposes WebGPU with timestamp queries on the 4090. Frames are
pixel-identical to Chrome's (engine look, and the editor's final-look Render mode: 0 differing pixels on every compared
frame).

| | Chrome 155 (visible window) | Tauri / WebView2 155 |
|---|---|---|
| Editor ready, warm profile | 1.24–1.33 s | 1.39–1.43 s |
| Editor ready, fresh profile (shaders compile) | 9.0 s | 10.6 s |
| Playback, 10 s from f264, final look, Play quality | 583 frames drawn, 0 dropped, GPU 4.84–4.87 ms, CPU p50 1.8–2.0 ms | 583 frames, 0 dropped, GPU 4.87–4.88 ms, CPU p50 1.7–1.8 ms |
| Render mode, f700–759, final look, Render quality | 9.6 s | 9.5 s (also 9.5 s with the window never shown) |
| Memory, idle editor | 933 MB private (8 processes), plus the Node server | 845–856 MB (7 processes, shell included) |

One Chrome playback run dropped 165 frames (its window had lost focus or was covered); its two repeats matched Tauri.

**Frame export: the host's language doesn't matter; the transport does.** All 1176 frames, 1920×1080, engine look,
Render quality. Rendering alone takes 8.3 s and reading the pixels back (`getImageData`) 24.3 s in both hosts, so
readback is the floor for any raw-pixel path.

| Path | Chrome headless + Node | Tauri, page from the shell's HTTP port | Tauri, page from the `vs://` scheme |
|---|---|---|---|
| Current exporter (`toDataURL` PNG, POST) | 38.2 s (visible Chrome: 37.0 s) | 32.4 s (from the Node server: 32.2 s) | 35.5 s |
| Raw RGBA, the host encodes PNG | 37.0 s (608 MB) | 29.3 s at fast compression (files ~4× larger); 41.1 s at balanced (589 MB) | 100.4 s |
| Raw RGBA piped into ffmpeg, ProRes 4444 .mov | 30.2 s | 31.0 s | 103.2 s |

- **The ProRes pipe is the real gain, and it is a host feature, not a Rust one.** A finished 1176-frame ProRes 4444
  master (862 MB, byte-identical from every host) in 30 s, as fast as today's PNG sequence, with no encode step after.
  Decoded back, every pixel is within 2% of the PNG (f720: 67.9 dB; 4:4:4 BT.709, limited range). The encoder's colour
  options alone left transfer and primaries untagged; `setparams` in the filter chain tags them (checked with ffprobe on
  ProRes 4444 and on H.264 from NVENC, which also works).
- **Rust's PNG encoder is not faster at the same compression** (41.1 s against Node's 37.0 s). Its fast level wins
  only by writing files about four times larger.
- **Tauri's custom scheme is slow for big uploads.** An 8 MB POST took 90 ms through `vs://`, against 23–26 ms from
  Chrome to Node, 36 ms from WebView2 to the shell's HTTP port and 40 ms from WebView2 to Node. Tauri's `invoke` with a
  raw 8 MB body round-trips in 116 ms. The cause, in wry 0.57's source: custom-scheme request bodies are read through
  COM `IStream::Read` in 1 KB chunks on the window's UI thread, which also slows the page's readbacks (21 vs 13 ms a
  frame). Small requests are fine (0.3 MB: 5 ms everywhere). **Rule: in a Tauri shell, serve the page and bulk data from
  a localhost port inside the shell, not from the custom scheme.**
- **Chromium keeps typed-array upload bodies.** Raw-pixel exports in WebView2 grew the renderer by about 8 MB a frame
  until it crashed (at frame 1011 twice; once past 16 GB). A synthetic test kept `Uint8Array` and `ArrayBuffer` POST
  bodies in Chrome 155 too (+2.4 GB per 1.2 GB posted, not freed by a forced GC), while `Blob` bodies were freed in both:
  the WebView2 renderer stayed at 126–311 MB through whole exports. **Rule: POST raw pixels as Blobs** (today's exporter
  already does).
- **Hidden windows render.** A Tauri window that is never shown still reports `visible`, runs `requestAnimationFrame` at
  162 Hz and renders bit-identical frames. The hidden-tab stalls of §1.15 don't apply, so a background render window
  next to the editor is possible; a hidden Chrome tab would be throttled.

**Engine bridge: the same.** The same 60 Hz datagrams reached the page in 1.4–2.6 ms p50 through the Node relay
(WebSocket) and through the Rust UDP listener and a Tauri channel, p95 within 0.6 ms of each other. With 150 ms stalls
on the page's main thread, both delivered late alike (p95 127 ms) and both receive stamps stayed accurate (Rust's within
0.2–0.5 ms of the sender). A real Blender 5.2 (background, `tools/blender_bridge.py` from `spike-engine-bridge`,
unchanged apart from `--port 8798`) streamed 180 of 180 frames into the shell at about 1 ms p50. The gain is one process
fewer, not latency.

**Native GPU (wgpu 30) against the browser, same WGSL.** `probe.wgsl` has two synthetic full-screen passes shaped like
ours: a 256-tap depth-of-field gather (texture-bound) and a 96-step haze-like march with 4-octave noise and a light loop
(ALU-bound). Median GPU ms over 40 runs at 1920×1080; two native runs agreed within 0.1 ms.

| | Gather | March |
|---|---|---|
| Chrome 155 and WebView2 155 (Dawn on D3D12) | 1.75–1.84 | 10.1–10.2 |
| Same, with `--enable-dawn-features=disable_robustness` | 1.44–1.56 | 9.2–9.3 |
| wgpu on DX12, bounds checks on / off | 1.62–1.70 / 1.36–1.45 | 9.03–9.06 / 8.58–8.59 |
| wgpu on Vulkan, bounds checks on / off | 1.71–1.72 / 1.43–1.44 | 7.25 / 6.08–6.10 |

- With robustness off (a switch a desktop shell can set for its own trusted pages; Chrome would need a dedicated
  profile), the browser comes within 5–8% of native DX12. The rest of the native gain is Vulkan: the driver ran the
  ALU-heavy march 20–29% faster than DX12. Chrome's switches didn't move Dawn off D3D12.
- On the real editor the robustness switch changed nothing (haze march 3.42 ms, DOF 1.30 ms either way), so the probe's
  gain doesn't carry over to today's TSL output.
- The Vulkan gain needs a renderer outside three.js: our own WGSL or a Rust engine, re-porting the TSL looks, loaders,
  skinning (characters) and the WebGL2 fallback, and redoing the parity work of §1–6. Not worth it while the look's
  passes cost single-digit milliseconds at Play quality.

**Cost of the Rust side.** The first release build took 2 min 6 s, dependencies included. After a one-file change a
release rebuild takes 1 min 6–17 s (thin LTO, one codegen unit) and a debug one 2.9 s (39 s from clean); `target\` is
3.2 GB. The page itself still reloads instantly, because the shell reads it from the repo. The exe is 10.7 MB and the
NSIS installer 2.3 MB (without the web files). Tool caches outside the repo: `~\.cargo`, the Tauri CLI's NSIS download
in `%LOCALAPPDATA%\tauri`, and WebView2 profiles in `%TEMP%\vs-rust-tauri`.

### What fundamentally changes with Tauri

- **One process instead of a browser and a server.** The Rust shell is the server: the same routes, files on E: and G:
  read and written directly, ffmpeg spawned directly, the bridge's UDP port inside the app. The page doesn't know which
  host it has, which keeps the browser and artifact paths working. Keep the host API HTTP-shaped for that reason.
- **The browser engine is no longer chosen or pinned by us.** WebView2 is evergreen and updates with Edge (155 today,
  the same as Chrome). A Fixed Version runtime pins it, at the cost of shipping the engine with the app. On macOS Tauri
  uses WKWebView (WebGPU expected from macOS 26) and on Linux WebKitGTK (no WebGPU found), so a Tauri app is
  Windows-first in practice. Electron would pin one Chromium on every OS, at roughly 100 MB more per install.
- **Security model.** Native commands are granted per origin. The `vs://` page could call Rust commands at once; pages
  from localhost ports were refused ("not allowed by ACL") until listed in a capability with an app manifest. Every
  native power has to be granted explicitly, which suits a client-facing build.
- **The app owns its browser switches and windows.** The shell sets WebView2's switches (DevTools port, robustness,
  throttling) and can open hidden render windows or several webviews. A DevTools port is how Claude drove it here, so
  the "MCP after Electron" idea works on Tauri too: `VS.cmd` over the DevTools protocol, or an MCP server inside the
  Rust process.
- **Lifecycle quirk.** Force-killing the shell left its WebView2 processes running (still there 40 s later), holding the
  DevTools port and the page (one held 12 GB after a leak test), and a new shell with the same profile reused them. A
  real app needs a clean shutdown and a single-instance guard; the tests clean up with `desktop/tools/cleanup.ps1`.
- **Two languages and a compile step** for host features. The renderer, editor and looks stay JavaScript.

### Gains, losses and the recommendation

| Option | Gains | Losses |
|---|---|---|
| **Stay browser + Node host** (today) | Artifacts for iteration, no build step, Chrome pinned by choice, the ProRes pipe and disk writes already work (`serve.mjs` now has the ffmpeg routes) | Two things to start (Chrome and the server); hidden tabs throttle; no packaged app |
| **Tauri shell only** | One 2–11 MB app; direct disk and ffmpeg; hidden render windows; app-owned switches; a home for an MCP server, native dialogs and file watching; gamepads through gilrs if the Gamepad API falls short | Rust for host features (1-minute release rebuilds); an unpinned WebView2; Windows-first; transport rules (a localhost port, Blob bodies) |
| **Deeper Rust (native rendering)** | 4–40% less GPU time on the probe; Vulkan; no browser limits | Rewrite the renderer and every TSL look; lose three.js's loaders and the artifact path; redo parity |

Recommendation: stay browser-first with the Node host while the look and the editor are still changing, and adopt the
ProRes pipe now (it works in either host). When a packaged desktop app is wanted (a background render queue, MCP
control, a client build), make it a Tauri shell that serves the page from a localhost port inside the app, and keep the
page host-agnostic. Revisit native rendering only if Render-quality passes become the bottleneck, and then as a
separate render worker over the same scene document, not as the editor's renderer.

Not tested: gamepads in WebView2 (no pad connected), native file dialogs and file watching, an MCP server in Rust,
macOS and Linux, and Electron itself.

**GPU log.** Every GPU step ran under `F:\Repos\Virtual-Shot\.gpu.lock`, taken and released about 15 times, the
longest about 25 minutes (an export run that hung when WebView2's renderer crashed). No other session held the lock, so there were no waits or overlaps.
`nvidia-smi` read 11–31% before runs.

## 10. Beyond WebGPU: what a Rust backend unlocks (branch `spike-rust-tauri`)

Connor's follow-up to §9: with a Rust process in the app, the renderer isn't limited to WebGPU. Two probes: hardware
ray tracing on the Black Page geometry, and a native viewport drawn under the web editor in the same window.

**Answer.** Both work. Hardware ray-traced soft shadows from the CRT cost 0.2 ms a frame at 1080p and 16 samples,
8–28× less than the same shadows traced in software (which WebGPU can do: 1.5–5.6 ms), and the cost doesn't grow with
triangle count. A native Vulkan or DX12 viewport composites under a transparent WebView2, so the HTML panels, HUD and
gizmos sit over it, at the display's 160 Hz with 3.6 ms from a page input event to the native frame's submit. Together
they gave a live, orbitable, hardware ray-traced view of the Black Page set inside an HTML layout. The catch is that
the native viewport can't share textures with the page: native and web layers can be stacked, not shaded together, so
using native rendering in the editor means the native side draws the whole picture, which is a port of the renderer
and its looks out of three.js and TSL.

### What native unlocks that WebGPU doesn't

From wgpu 30 on this machine (RTX 4090, driver features as reported by the adapter):

| Feature | WebGPU in Chrome 155 | wgpu 30 native | What it would buy Virtual Shot |
|---|---|---|---|
| Ray queries (inline ray tracing) | no | Vulkan only (`EXPERIMENTAL_RAY_QUERY`; wgpu's DX12 backend reported none) | Shadows (the open Shadows work: CRT soft shadows, haze light shafts), AO, reflections, a path tracer for stills |
| Ray-tracing pipelines, mesh shaders | no | experimental | Full path tracing; dense geometry (arch viz) |
| 64-bit atomics, f64, binding arrays (bindless), push constants | no or limited | yes | GPU-built BVHs, splatting, many textures without rebinding |
| Robustness checks | always on | off with trusted shaders | 4–23% on §9's probe |
| Vendor SDKs (DLSS, OptiX/OIDN denoisers, NVENC, CUDA) | no | through raw Vulkan/DX12 next to wgpu | Denoised path tracing, GPU-side video encode without readback |

### Probe 1: ray-traced soft shadows from the CRT (`desktop/rt-probe`)

The editor's scene at f450 (2,312 triangles; the CRT screen meshes are the light and the glow quads are left out),
exported by `bench.js exportGeometry`. One primary ray a pixel, then 16 shadow rays to stratified points on the glass;
the same WGSL shading with two tracers: hardware ray queries, or a binned-SAH BVH walked in plain WGSL (which a browser
can run). Each triangle split into 4^k to stand in for denser assets. GPU ms at 1920×1080, median of 60 runs; all
variants produce the same image (mean radiance equal to six digits).

| Triangles | HW ray query (Vulkan) | Software BVH, Vulkan | Software BVH, DX12 | Software BVH in Chrome / WebView2 |
|---|---|---|---|---|
| 2,312 (Black Page as is) | 0.19 | 1.54 | 1.74 | 1.77–1.85 |
| 147,968 (k = 3) | 0.19 | 2.70 | 3.58 | 3.50–3.74 |
| 2,367,488 (k = 5) | 0.20 | 4.71 | 5.62 | 5.31–5.37 |

- At 64 samples the hardware path took 0.63–0.66 ms at every size.
- The hardware acceleration structure builds on the GPU in 1–21 ms; the spike's CPU BVH builder (single-threaded) took
  2 ms, 0.13 s and 2.3 s. That gap matters for animated and skinned meshes (characters), which need rebuilds or refits
  every frame.
- **For Black Page itself, software ray tracing in the browser is affordable** (1.8 ms for 16-sample soft shadows), so
  shadows don't by themselves force leaving WebGPU. Hardware tracing pays off with dense scenes, many samples or
  bounces (path tracing), and animated geometry.
- Images: `rust_tauri\rt\img_s16\` and `img_s64\` (`vulkan_hw_k0.png` and the rest).

### Probe 2: a native viewport under the web page (`--native-viewport`)

The shell's window is made transparent, a wgpu swapchain is created on it, and the page (`desktop/bench/native_view.html`,
a mock editor layout) leaves the viewport transparent and reports its rectangle and camera drags through `invoke`.
Unattended runs used a synthetic drag every 8 ms for 6 s; screen captures in `rust_tauri\native_view\`.

| | DX12 test pattern | Vulkan test pattern | Vulkan, hardware ray-traced Black Page |
|---|---|---|---|
| Native present interval p50 / p95 | 6.37 / 6.41 ms | 6.37 / 6.41 ms | 6.37 / 6.43 ms |
| Page input event → native frame submitted, p50 / p95 | 3.62 / 6.69 ms | 3.74 / 6.57 ms | 3.65 / 6.59 ms |
| Page `invoke` for one drag event, p50 | 0.9 ms | 0.9 ms | 1.0 ms |
| Page's own frame interval | 6.3 ms | 6.2 ms | 6.3 ms |
| Ray-traced pass, 1530×1014, GPU | | | 0.30 ms p50 |

- The HTML panels, the HUD label and the CSS gizmo circle draw over the native picture, composited by the desktop;
  the page keeps its own 160 Hz alongside.
- If the native renderer stops presenting, the transparent window shows the desktop behind it (the first run, before a
  uniform-layout bug was fixed), so a real build needs an opaque fallback.
- Not tested: window resizing and maximising (the swapchain follows the size the page reports), the real editor page
  with its WebGPU canvas removed, multiple monitors and DPI changes.

### What this means for the architecture

- **Native and web layers stack; they don't mix.** WebView2 can't import a texture from the native device (or export
  one), so a native shadow or ray-traced pass can't feed three.js's shading. Each layer is a whole picture, composited
  over or under the other with alpha.
- **So there are three ways to use native rendering:**
  1. A **native render worker** for Render mode: the same scene document, a Rust renderer with ray tracing or path
     tracing, frames straight into ffmpeg. The editor keeps three.js. Costs a second renderer kept at parity with the
     first (the spike shows parity is reachable but is real work, §1–6).
  2. A **native viewport in the editor** (this probe): the panels stay HTML, the viewport is Rust. The time core
     (`evaluate`) can stay JavaScript and send each frame's state over `invoke` (about 1 ms), or be ported. Costs the
     whole three.js renderer and every TSL look ported to Rust and WGSL, plus glTF loading, skinning and the 2D layers
     (the chat is Canvas 2D today).
  3. **Stay WebGPU and trace in software** where it's cheap enough (Black Page shadows: 1.8 ms), keeping one renderer.
- **Recommendation:** for the open Shadows work, try option 3 first (a software BVH in WGSL inside the three.js
  renderer; this probe's tracer is a starting point). Reach for native when a scene needs it (dense arch-viz models,
  characters, path-traced stills), and then as option 1, a Render-mode worker, before considering option 2. Option 2 is
  the "becomes a native app" decision: proven to work here, but it trades the browser and artifact path and the
  three.js ecosystem for full control of the GPU.

**GPU log.** The probes ran under `.gpu.lock` in short runs (seconds each; the longest about a minute), with
`nvidia-smi` at 11–17% before each and no other holder, while Connor worked in Virtual Cut Dev. The test windows stayed
on top without taking focus for about 6 s each.

## 11. The Black Page renderer run natively (branch `spike-rust-tauri`)

Connor's ask: use native hardware and Rust for as much of the rendering as possible, to see how much faster it gets.
Rather than re-port the look by hand (weeks of parity work), the spike ran **the renderer's exact GPU work natively**:
`desktop/capture/gpu_capture.js` records every WebGPU call three.js makes while the viewer renders (the WGSL it
generates, pipelines, buffers, texture uploads, every pass and draw), and `desktop/replay` (Rust, wgpu 30) executes
the same calls on Vulkan or DX12. Same shaders, same data, same passes, so the timings compare the platforms, not
two different renderers.

**Answer.** The same rendering is not meaningfully faster natively. On Vulkan, Render-quality frames took 2–18% less GPU
time than in Chrome and the Play-quality frame 10% more; through wgpu's DX12 backend everything heavy took about 1.8×
as long. Turning off bounds
checks changed nothing. The GPU cost is the look's own work (the haze march is 93% of f720 at Render quality), and
Chrome already runs it on the same GPU with little overhead. What native did buy: **exports in 10–26% less time**
(rendering, readback and ffmpeg overlapped, so it runs at the GPU's own speed), **hardware ray tracing** (§10), and
the picture drawn straight into the app window. Bigger speedups have to come from changing the work (the haze march
especially), which helps in the browser just as much.

### How faithful the replay is

- 4 frames (720 and 1100 at Render quality, 720 at Play, 300 at Render) and two 120-frame ranges (f600–719 at Play
  and at Render quality) captured in headless Chrome 155: 2,302 to 52,838 WebGPU calls and 89 MB to 1.5 GB of data
  (the chat canvas is re-uploaded every frame, 12.7 MB).
- The native frames match the browser's own: 86.7–95.3 dB on the four frames (largest difference 1–3/255), 81–94 dB
  on the range's reference frames. three.js's generated WGSL compiled in wgpu's naga without changes.

### Per-pass GPU time, same shaders (median ms, RTX 4090)

| Frame | Pass | Chrome 155 (Dawn, D3D12) | WebView2 155 | wgpu Vulkan | wgpu Vulkan, no bounds checks | wgpu DX12 |
|---|---|---|---|---|---|---|
| f720 Render | whole frame | 114.6 | 114.4 | 112.0–112.6 | 111.9 | 194.0 |
| | haze march | 106.4 | 106.1 | 104.8–105.1 | 104.6 | 186.5 |
| | depth of field | 7.97 | 8.00 | 7.23–7.25 | 7.08 | 7.26 |
| f720 Play | whole frame | 5.15 | 5.18 | 5.62–5.69 | 5.72 | 11.55 |
| | haze march | 3.71 | 3.74 | 4.20–4.22 | 4.29 | 6.48 |
| | depth of field | 1.27 | 1.25 | 1.20 | 1.18 | 3.49 |
| f300 Render | whole frame | 31.9 | 31.8 | 30.6–31.0 | 30.6 | 49.7 |
| f1100 Render | whole frame | 133.9 | 134.2 | 109.8–125.3 | 116.7 | 239.2 |

- The scene pass (all the PSX models, 4× MSAA at 2880×1620) is 0.07–0.15 ms everywhere; lens, focus, light grid and
  composite are under 0.04 ms each. The look's two passes are the whole bill on every platform.
- f1100 varied between native runs (109.8 and 125.3 ms); the others were stable within 1%.
- CPU: three.js's `renderFrame` (including the Canvas 2D chat) took 1.1–2.8 ms in the browser. The replay's 2.6–5 ms
  is an interpreter walking JSON, not what a native renderer would cost, so it isn't a comparison.

### Export without the browser

Render quality, read back and piped into ffmpeg as ProRes 4444, Vulkan:

| Frames | Native replay | Browser (Chrome headless, Blob uploads to Node's ffmpeg route) |
|---|---|---|
| f600–719, in order (120) | 14.6 s (8.2 fps) | 16.1 s (7.4 fps) |
| f720, f300, f1100 cycled (240) | 19.8–20.0 s (12.0–12.1 fps) | 27.0 s (8.9 fps) |

- Native ran at its GPU floor (f600–719: 120 × 113.7 ms median = 13.6 s of GPU work) by keeping three frames in
  flight while earlier ones were read back. The browser waits on each frame's `getImageData`. A WebGPU readback ring
  (`copyTextureToBuffer` and `mapAsync`) would recover some of that in the browser too.
- The two f600–719 masters match at 81 dB mean per frame, except the first five native frames (25–39 dB): the replay
  starts that sequence from the state the timing pass left behind, not the one the browser started from.

### The real look in the editor window

`--native-viewport=replay` runs the captured f600–719 Play-quality frames through wgpu on Vulkan every shot frame (60
fps, looping) and draws them under the transparent editor layout from §10. It's the actual Black Page final look
(the ringing remote, haze, depth of field, pops) drawn by the Rust process: 5.78 ms of GPU a shot frame (p95 5.98),
presented at the display's 160 Hz (interval p50 6.37 ms, p95 10.1 ms; the p95 is the replay waiting on its own timing
readback). Capture: `rust_tauri\native_view\window_replay.png`.

### What this means

- **Moving the existing look to native buys no rendering speed.** The rewrite would cost the three.js ecosystem and
  the artifact path for a few percent, or a 1.8× loss on wgpu's DX12 backend.
- **Native earns its keep with what the browser can't do:** hardware ray tracing (§10), the export pipeline, the app
  window, and later vendor features (denoisers, NVENC from GPU memory). The capture/replay path also shows that a
  native Render-mode worker could run the three.js look bit-close without porting it, as long as the frames it renders
  are recorded from the editor (it replays work, it doesn't author it).
- **The performance lever is the haze march**: 75–94% of a Render-quality frame on every platform. Precomputing the
  Cycles noise into a 3D texture, fewer steps with temporal accumulation, or a half-resolution march with an upsample
  would cut it far more than any platform change, in the browser and natively alike.

**Disk and GPU.** Captures and exports for §9–11 use 7.1 GB in `Virtual Shot spike\rust_tauri\` (the two 1.5 GB range
captures and the export tests are most of it). The GPU work ran in short locked steps (the longest about 2 minutes)
with no other lock holder.

## Running the spike

```
npm install                        # three 0.186.1, exact pin
node server/serve.mjs              # http://localhost:8790/src/index.html  (?f=<frame>, ?look=engine, ?webgl, ?bg for background tabs, ?gputime)
node tools/import_blackpage.mjs    # rebuild scenes/black_page.scene.json from opener_final.json + data/engine_dump.json
node tools/check_camera.mjs        # time core vs cams_final.json
node tools/compare.mjs <run> [frames]       # side-by-side + difference images (ImageMagick)
node tools/metrics_all.mjs <run>            # per-frame metrics for a whole run
node tools/build_artifact.mjs      # dist/artifact (gitignored: holds copies of the models)
node tools/bake_haze_levels.mjs    # after VS.measureHaze(frames): calibrate and bake haze levels into data/haze_levels.json
node tools/headless.mjs "/src/index.html?f=300" "await VS.exportFrames([...], 'run')" --low   # run it in a separate headless Chrome
                                   # (from Git Bash, prefix MSYS_NO_PATHCONV=1; --shot=<png> saves a screenshot)
http://localhost:8790/src/editor/index.html   # the editor
```

The final master is decoded to `ref_final\` with ffmpeg (BT.709, limited range); `REF=<dir>` points the comparison
tools at it. In the page: `await VS.exportFrames([...frames], '<run>')` writes PNGs to
`G:\Claude\Virtual Legacy\Channel\Virtual Shot spike\<run>\`. `tools/dump_engine.js` runs inside the Black Page page
(`/bp/final/test.html` on the same server) and writes `data/engine_dump.json`.

| Path | What |
|---|---|
| `scenes/black_page.scene.json` | The scene document |
| `src/core/` | Time core: tracks and curves, `evaluate(doc, t, geo)` |
| `src/layers/chat2d.js` | The chat as a 2D layer |
| `src/render/` | three.js renderer: TSL materials, lens and DOF passes, haze (`haze.js`, `cycles_noise.js`), final composite |
| `src/layers/pops2d.js` | The pops as a 2D layer |
| `src/app.js`, `src/index.html` | Viewer: scrub, play, export hooks |
| `src/editor/` | The editor: outliner, inspector, viewport, timeline and graph editor |
| `src/core/commands.js` | Named commands on the scene document, with undo |
| `src/artifact.html` | The artifact page |
| `server/serve.mjs` | Local server: read-only mounts of the Black Page folder, the PSX pack and the Wii Remote; PNG writes to G: |
| `tools/` | Engine dump, importer, checks, comparisons, artifact build |
