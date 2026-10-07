# Proposed architecture changes from the spike

The spike's job was to find where the architecture sketch (`docs/architecture-sketch.md`, a copy of the Claude Doc
https://claude.ai/code/artifact/8d3dff7c-e6fc-49fa-bc6d-3eee72db0784) was wrong or vague before the real build. Connor's
plan was to fold these into the sketch before starting; they're collected here so the new project can do that. Each
item names the section of the sketch it changes and the section of `LEARNINGS.md` with the evidence.

## Confirmed by the spike (keep)

- **Own the tool, rent the renderer:** three.js pinned (0.186.1), `WebGPURenderer` with TSL and the automatic WebGL2
  fallback. The Black Page look ported to TSL in one pass; the WebGL2 fallback matched the old GLSL engine (median
  83 dB). (LEARNINGS §2, WebGL2 fallback)
- **One JSON scene, every frame a pure function of time.** The rebuild matched the Black Page engine at 58.8 dB or
  better from the document alone. (§1, §3)
- **Named commands on the document.** Snapshot undo per command (the document is about 50 KB) made undo, live drags
  and scripting one mechanism; `VS.cmd(...)` let Claude drive the editor headless with no extra code, which is the
  MCP idea working early. (§7)
- **Editors modelled on Blender, After Effects, Resolve and Unreal** worked as a layout; plain DOM and CSS grid were
  enough for the spike. (§7)

## The scene document

1. **More kinds of content.** Add to the list after "Takes": empties and attachment points (named frames on or between
   objects, like a screen's glass), events (things that start at a time with parameters: a chat message, a flash, a
   ringing phone, a clip), layers (2D programs rendered as a function of t, full-frame or as a texture), parameters
   (global animated values several things read, like Black Page's `chaos`), and looks (named custom materials and
   post passes with their parameters). (§4.1)
2. **Tracks.** "A target id, a property path, a value type and keys. Keys are `{t, v, curve, hi, ho}`: `t` in seconds;
   `curve` shapes the segment into the key and is bezier, linear, hold or a named preset (smooth, ease-in, ease-out,
   exp, back, soft-back, settle); handles are `[dt, dv]` offsets. A track can interpolate geometrically (distance,
   FOV). Values can be numbers, vectors, colours or records (a focus key names a target object)." Update the JSON
   example. (§4.2)
3. **Rule 1** becomes "Any frame is `evaluate(scene, t, assets)`, a pure function of the document, the loaded assets
   and time. Assets supply derived geometry (bounds centres, part centroids) that behaviours such as focus need." (§4.3)
4. **Rule 3 (cameras):** store the lens the way it is keyed (vertical FOV or focal length) with the interpolation space
   explicit; a camera can be a rig (head-on to a frame, orbit, rail) with keyed parameters; mm plus sensor size is what
   the Blender and Unreal exports write. (§4.4)
5. **Derived and baked data.** Some data is computed from the document (focus centres, ring-light positions) or from
   an analysis pass (the haze levels measured per frame). It goes stale when an edit changes the picture. Rule: derived
   data is recomputed on change; baked analysis data is stored in the document, marked stale on edits that affect it,
   and re-run. Analysis passes write into the document so `evaluate` stays pure. (§6, §7)
6. **Stable seeds.** Random seeds come from stable ids, never list positions (the pops only matched once seeds followed
   the original list). (§6)

## Core architecture

7. **Layer stack.** Add a box between the renderer and Render output: "2D layers + 3D render + overlays, blend modes
   and opacity tracks", blended in linear light, with a haze (volume) layer as well as 2D layers. Add "Look modules
   (custom materials, post passes)" beside the renderer. (§4.5, §6)
8. **Quality is a policy, not a look.** Replace "Only the quality settings differ…" with: framing, timing and look
   settings are identical in every mode; quality presets change sampling only (haze steps and resolution, DOF taps,
   buffer scale). The Black Page final look costs 140–190 ms a frame at Render quality and 7–9 ms at Play quality on
   an RTX 4090. The editor draws Play quality on every change and refines to Render quality progressively when idle. (§4.6, §7.1)
9. **Expensive passes must be sliceable.** Anything that can't finish in a frame (the haze march; path tracing or
   bakes later) renders in pieces that a new edit can drop. A scissored full-screen pass was enough. (§7.1)
10. **Budgets per pass, not per scene.** The 3D scene cost 0.1–0.2 ms; the look's passes (haze march, depth of field)
    were the whole bill. The renderer should name its passes and expose GPU timings itself (the spike had to work
    around three.js's timestamp keys). (§7.2)
11. **Precompile pipelines at load.** The first playback froze for about 9 s in a fresh browser profile while shaders
    compiled; three's `compileAsync` doesn't cover full-screen passes. (§7.2)
12. **Viewport visibility is editor state.** Show toggles and hidden objects live with the editor, not in the
    document, and never change renders (Blender's eye versus its render toggle). Render-time switches, if needed, are
    document settings of their own. (§7.1)

## Render mode and output

13. **Passes:** "beauty, distance from the camera (Euclidean, multisampled like colour; additive effects don't write
    it), normals and an object ID mask". Internal resolution follows the lens: the buffer grows with barrel-distortion
    overscan (1×–2×). (§4.7)
14. **Writing to disk:** each frame is drawn from the WebGPU canvas into a 2D canvas in the same task as the render,
    encoded with `toDataURL`, and a small local server writes the PNG: 1176 frames at 1080p in 50 s (the old engine
    took 61 s). Never depend on `requestAnimationFrame` or `<img>.decode()` for rendering; both stall in background tabs.
    File System Access is the untested alternative; Electron later. Renders can be stopped, keeping finished frames.
    (§4.8, Performance)
15. **The player is clocked by the shot's frame rate**, not the display's: a 120–165 Hz monitor otherwise draws each
    frame two or three times. Frame-rate caps per view are editor settings; browsers are always V-Synced. (§7.2)

## Tech choices

16. **Supported browser: Chrome / Chromium** (including the Claude app's browser). Firefox copies Canvas 2D into WebGPU
    about 20× slower and has coarse timers. (§7.2)
17. **Canvas 2D only for layers that change rarely.** A layer that animates every frame (the chat) should be drawn on
    the GPU (glyph atlas or SDF text); its per-frame upload was the editor's biggest CPU cost. (§7.2)
18. **Colour pipeline:** display-referred with colour management off for ported looks; linear for new work and EXR.
    (§4.9)
19. **Artifacts:** modules published beside the page; three.js from jsDelivr at the pinned version; models as base64
    text (artifacts refuse .glb). Artifacts can't write to disk or render frames. (§4.9)
20. **Testing:** a separate headless Chrome driven over DevTools (`tools/headless.mjs`) for renders and editor tests,
    so the user's machine and the Claude app stay responsive. Headless and hidden tabs hide real costs (a 200 ms
    per-frame upload measured 1 ms there), so the editor carries its own stats and Record / Stop captures the user can
    hand back. (§7.2)

## Black Page lessons and milestones

21. **Keep:** the dump hooks (reading the old engine's state from the running page is the migration path for any
    legacy scene). **Change:** MRT blend modes are set on the renderer's MRT. (§4.10)
22. **Milestones:** "rebuild Black Page" is its own milestone after the time core, and is done (engine parity at 58.8 dB
    or better; final look at 40 dB or better against the master, median 46, haze and pops included). Budget the next
    milestones for the importer, the layer stack and export plumbing; the renderer was the cheap part. A first editor
    exists. (§4.11, §5, §6, §7)
23. **Volumetrics:** the engine can replace an offline volumetric pass for single-scattering haze: about 20× faster
    than Cycles and at parity, from a fragment-shader ray march with Blender's noise ported exactly. Port Blender's
    procedural textures rather than imitating them. (§6)

## Still open

- Shadows (none yet; haze light shafts recommended first), GPU text for animated 2D layers, a cheaper Render-quality
  depth of field, gamepad free cam and takes, characters and retargeting (not started), the UI library for the real
  build, and whether gamepads work inside an artifact (the readout was never checked).
