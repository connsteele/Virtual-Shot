# Virtual Shot spike: learnings

The spike rebuilt the Black Page cold open on the architecture sketch's plan: a scene document (JSON, every object
placed as data), a time core (`evaluate`), three.js pinned at r186 (`WebGPURenderer` + TSL), the CRT screen, lens,
squint and depth of field, a timeline scrub and frame export. It reached parity with the Black Page engine frames.

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
    ~0.4 s; compressing in the page (`CompressionStream`) and letting the server wrap the PNG chunks brought it to
    0.06 s (flat) and 0.16–0.19 s (3D) a frame. The full 1176 frames export in 186 s.
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
17. **Play mode at Render quality is borderline.** On the RTX 4090 a full-quality frame costs 13–24 ms of GPU time,
    and almost all of it is the DOF gather: without DOF the frame takes 0.1–0.3 ms (see [Performance](#performance)).
    60 fps playback needs a cheaper DOF in Play mode. The doc's promise should be "framing and timing hold between
    Play and Render", with quality presets named per mode.

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
   → "Framing and timing are identical in every mode. Play mode uses a cheaper quality preset (DOF, buffer scale),
   because the Black Page shot's DOF alone costs 13–24 ms of GPU time a frame on an RTX 4090."
7. **Render mode → Passes:** replace "beauty, depth, normals and an object ID mask" with "beauty, distance from the
   camera (Euclidean, multisampled like colour; additive effects don't write it), normals and an object ID mask".
   Add a bullet: "Internal resolution follows the lens: the buffer grows with barrel-distortion overscan (1×–2×)."
8. **Render mode → Writing to disk:** replace with "The page reads pixels back, compresses them (`CompressionStream`)
   and a small local server writes the PNGs: 0.16 s a frame at 1080p (toBlob was ~1 s). Render mode never depends on
   `requestAnimationFrame` or `<img>.decode()`, which stall in background tabs. The File System Access API is the
   alternative for the local copy (untested); Electron later."
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

## Performance

RTX 4090, Chrome 152 in the Claude desktop browser pane, 1920×1080, background tab.

| Measure | Result |
|---|---|
| GPU time per frame, full quality (timestamp queries) | 24.1 ms at the reveal, 16.8 ms in the stare, 12.9 ms near the end |
| GPU time per frame, DOF off | 0.1–0.3 ms |
| Export, WebGPU, all 1176 frames (render, read back, compress, write PNG) | 186 s (0.16 s a frame) |
| Export, WebGL2 fallback, all 1176 frames | 322 s (0.27 s a frame) |
| Engine time per frame as seen from the page | 60–130 ms, inflated by background-tab scheduling; GPU time above is the real cost |

## WebGL2 fallback

`?webgl` forces three's WebGL2 backend with the same TSL graphs. After one fix (readback rows are bottom-up on WebGL2),
it matched the Black Page engine more closely than WebGPU did: worst 3D frame 66.4 dB, median 83.0 dB, no frame with
more than 0.016% of pixels off by more than 8/255, largest single-pixel difference 55/255. WebGL2 rasterises like the
old engine (also WebGL2), so this pins the WebGPU residuals on the backend's rasterisation and MSAA, not on the port.
The fallback works, but frame export from a hidden tab needs `?bg` (see §1.15).

## Running the spike

```
npm install                        # three 0.186.1, exact pin
node server/serve.mjs              # http://localhost:8790/src/index.html  (?f=<frame>, ?webgl, ?bg for background tabs, ?gputime)
node tools/import_blackpage.mjs    # rebuild scenes/black_page.scene.json from opener_final.json + data/engine_dump.json
node tools/check_camera.mjs        # time core vs cams_final.json
node tools/compare.mjs <run> [frames]       # side-by-side + difference images (ImageMagick)
node tools/metrics_all.mjs <run>            # per-frame metrics for a whole run
node tools/build_artifact.mjs      # dist/artifact (gitignored: holds copies of the models)
```

In the page: `await VS.exportFrames([...frames], '<run>')` writes PNGs to
`G:\Claude\Virtual Legacy\Channel\Virtual Shot spike\<run>\`. `tools/dump_engine.js` runs inside the Black Page page
(`/bp/final/test.html` on the same server) and writes `data/engine_dump.json`.

| Path | What |
|---|---|
| `scenes/black_page.scene.json` | The scene document |
| `src/core/` | Time core: tracks and curves, `evaluate(doc, t, geo)` |
| `src/layers/chat2d.js` | The chat as a 2D layer |
| `src/render/` | three.js renderer: TSL materials, lens and DOF passes |
| `src/app.js`, `src/index.html` | Viewer: scrub, play, export hooks |
| `src/artifact.html` | The artifact page |
| `server/serve.mjs` | Local server: read-only mounts of the Black Page folder, the PSX pack and the Wii Remote; PNG writes to G: |
| `tools/` | Engine dump, importer, checks, comparisons, artifact build |
