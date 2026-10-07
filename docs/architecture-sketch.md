# Virtual Shot: architecture sketch

Oct 7, 2026 · @Connor

## What it is

One browser-based tool of our own for planning and rendering 3D shots, built on three.js. Its working name is Virtual Shot, a pair for Virtual Cut.

It serves three jobs from the same scene:

- **Previz for Virtual Legacy videos.** Block out a shot, fly a free cam with a controller to find the framing and timing, then keyframe it.
- **Final shots.** Render the highest-quality frames it can make and composite them in Resolve, Blender or After Effects.
- **Arch viz.** An interactive showcase clients use to show off their buildings, as a guided tour or a free walk. Final arch viz renders stay offline in Blender or Unreal.

What it is not: a modelling tool (models come from Blender and the asset packs), a game engine (no gameplay logic) or a compositor (Resolve stays the finishing tool). When a shot needs Lumen or Cycles quality, the scene and camera go to Unreal or Blender instead.

## Modes

There are four modes over one scene. Switching modes never changes the scene unless you keep something, such as a recorded take.

| Mode | What you do | What comes out |
| --- | --- | --- |
| Edit | Build the scene, set keys in the graph editor, scrub the timeline | The scene file |
| Play | Fly a free cam with a gamepad or mouse and keyboard, play shots back at real speed, record camera takes | Takes that become editable keyframes |
| Render | Step frame by frame at full quality, independent of screen size or speed | Image sequences plus camera and scene exports |
| Present (later) | A locked-down viewer for clients: guided tour through set shots, or a free walk | A link a client opens |

Play reads controllers through the browser's standard [Gamepad API](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API), so an Xbox or PlayStation pad works without drivers.

## Core architecture

The tool has four layers stacked around one scene file. Editors change the file, and everything else only reads it.

&#91;embedded content: tool architecture · 4 layers around one scene file\]

The viewport, Play mode and Render mode all ask the time core for the scene at time t and hand it to the same renderer. Only the quality settings differ, which is why a previz framing holds in the final render.

## The scene document

The scene is one JSON file that holds everything the renderer shows. No object is placed by code: this fixes the main problem Black Page Studio had, where the desk layout lived in engine code and had to be rebuilt by hand in Blender.

- **Assets:** paths to glTF files, read in place (E:\\Assets stays untouched).
- **Objects:** id, name, type (mesh, light, camera, character, empty), parent, transform, material overrides.
- **Tracks:** a target id, a property path and keys (bezier, linear or hold, with handles).
- **Shots:** camera, in and out frames, fps, resolution.
- **Takes:** recorded free-cam passes, kept until you turn one into keys.

Three rules keep it portable:

1. Any frame is `evaluate(scene, t)`, a pure function of time. Black Page proved this is what makes renders repeatable.
2. Ids are stable, so the Blender and Unreal importers match objects by id instead of by list order.
3. Units follow glTF (metres, Y up). Cameras store focal length in millimetres plus sensor size, so they mean the same thing in Blender and Unreal.

```json
{
  "fps": 60,
  "objects": [
    {"id": "cam_main", "type": "camera", "lens_mm": 35, "sensor_mm": 36},
    {"id": "desk", "type": "mesh", "asset": "psx/tv_table_4.glb", "pos": [0, 0, -0.4]}
  ],
  "tracks": [
    {"target": "cam_main", "prop": "pos", "keys": [[0, [0, 1.2, 2], "bezier"], [120, [0.3, 1.1, 1.2], "hold"]]}
  ]
}
```

## Editors

The editors are borrowed from tools you already use, so nothing needs learning from scratch.

| Panel | Modelled on | What it does |
| --- | --- | --- |
| Outliner | Blender Outliner, UE World Outliner | Scene list of objects, lights and cameras, with hierarchy, visibility and lock |
| Inspector | Blender properties, AE stopwatches | Properties of the selection; a key toggle on every animatable property |
| Viewport | Blender and UE viewports | Move, rotate and scale gizmos, camera view vs. free view, safe-frame overlay |
| Timeline + graph editor | After Effects | Dope sheet and curves. Ports `graph_editor.js` from Black Page: bezier, linear and hold keys, handles, box select |
| Shot list | UE Sequencer shots | Shots with their camera and in and out frames, in edit order |

## Animation

Any number in the scene can be keyed. Cameras and characters get dedicated tools on top of that.

- **Camera:** look-at target, focal length in mm, focus distance and depth of field, a rail or path to follow, and procedural handheld shake as a separate layer you can turn down.
- **Characters:** rigged glTF models with skeletons and animation clips, played by three.js's [animation system](https://threejs.org/docs/#api/en/animation/AnimationMixer). Clips sit on the timeline as blocks you can slide, trim and blend, like an animation track in UE Sequencer.
- **Rigged models are a core requirement**, both your own Blender rigs and library ones like Mixamo. Route: Blender → glTF, which carries the armature, skin weights, shape keys and actions. Mixamo's FBX files go through Blender first; three.js's FBX loader is fine for quick tests.
- **Bake before export:** IK, constraints and drivers don't survive glTF, so actions are baked to keys on export.
- **Retargeting:** putting Mixamo clips on your own rigs, either with three.js's skeleton retargeting utilities or by retargeting in Blender first. Prove this early.
- **Takes:** Play mode records the free cam at frame rate. You keep the take you like, and it's thinned into a few editable keys. The curve fitting already exists in Black Page's graph editor (`fitCubic`).
- **Later:** IK inside the tool for placing feet and hands.

## Render mode and handoff

Render mode trades speed for quality and writes files other tools can use. Each frame is computed from its frame number, never from the clock, so a slow frame can't drift.

- **Quality:** the same raster renderer as the viewport at higher settings and resolution for previz; [three-gpu-pathtracer](https://github.com/gkjohnson/three-gpu-pathtracer) for final stills and short clips.
- **Passes:** beauty, depth, normals and an object ID mask, so Resolve or AE can relight, fog or isolate in compositing. Black Page needed depth for its depth of field; here it would be a standard pass.
- **Formats:** 16-bit PNG, plus EXR for linear passes.
- **Writing to disk:** Chromium's [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker) lets the local copy of the page write straight into a folder you pick on G: (an artifact can't). Electron writes directly. A tiny local server like Black Page's `serve.py` is the fallback.
- **To Blender and Unreal:** the scene and animated camera exported as glTF, which carries [cameras and animation](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html). Both tools import glTF natively. The per-frame camera JSON from Black Page stays as a fallback for exact matches.
- **To Resolve and AE:** image sequences plus the shot's frame range and fps. An AE camera export can come later if it proves useful.

## Arch viz

For arch viz, the tool is the interactive showcase a client uses to show off their building. Final stills and animations stay offline renders in Blender or Unreal, made from the same models and cameras.

- **Its job:** a link the client opens to explore the building and show it to their own clients and buyers.
- **Getting models in:** the same Blender scene used for the offline renders goes out as glTF. Large buildings need mesh and texture compression ([Meshopt or Draco, KTX2](https://threejs.org/docs/#examples/en/loaders/GLTFLoader)).
- **Lighting:** lightmaps baked in Blender Cycles from that same scene, played back through the material's [light map](https://threejs.org/docs/#api/en/materials/MeshStandardMaterial.lightMap). The interactive version then looks close to the offline renders, as long as the light doesn't move. An HDRI plus real-time lights covers quick previews.
- **Shared viewpoints:** the cameras of your hero renders come in as tour stops, so the client can stand exactly where each render was taken.
- **Presenting:** a guided tour plays the stops in order. Free walk has collision and eye-height locking. Notes can be pinned in space.
- **Client devices:** a client may open the link on an old laptop or a phone, so Present mode must also run on the WebGL2 fallback.
- **Confidentiality:** client buildings stay off public links unless the client agrees.

## Tech choices and Black Page lessons

We own the tool and rent the renderer.

| Choice | Default | Why |
| --- | --- | --- |
| Renderer | three.js, one version pinned and bundled | Upgrades happen only when we choose |
| Backend | `WebGPURenderer` with automatic WebGL2 fallback; materials in TSL | One codebase on WebGPU and WebGL2. Drop to `WebGLRenderer` if WebGPU blocks a deadline ([three.js still calls it experimental](https://threejs.org/manual/en/webgpurenderer)) |
| Language and build | TypeScript, a normal multi-file repo | A tool this size outgrows one HTML file |
| Where it runs | Browser first: artifacts for iteration and previews, a local copy of the page for rendering to disk, Electron later | Same loop as Black Page; artifacts can't write to G:, and Electron adds direct disk access |
| Input | Browser Gamepad API, mouse and keyboard | Works with any standard controller |

What Black Page Studio taught us:

- **Keep:** frames as a pure function of time, the graph editor, the camera export, and retries on every file save.
- **Change:** layout lives in the scene file, not in code. One source of truth, with no Blender-only scene edits. A real git repo replaces ordered patch scripts. Cameras use mm and sensor size, so they match other tools without conversion math.

**Claude control:** every UI action is a named command on the scene document, such as add object, set key or render range. That keeps undo simple and makes the tool scriptable from day one. An MCP server that lets Claude drive a running session (load a scene, set keys, screenshot the viewport, start a render) comes later as a thin wrapper over those commands, once the Electron build or a local bridge exists.

**Game link (idea, later):** a small per-game mod streams the game's live camera (position, rotation, FOV) and chosen events to Virtual Shot over a local connection. Virtual Shot renders its own scene from that camera, so our models and graphics line up with real gameplay for compositing. This is the same pattern as the recent AI game-mashup mods, where two games run side by side and one is layered over the other ([VGC](https://videogameschronicle.com/news/ai-game-mashup-videos-on-social-media-spark-debate-and-backlash-among-players-and-modders)). It needs the local or Electron build, single-player or offline games only, and a mod written for each game.

## First milestones and open questions

Rebuilding the Black Page shot in the new tool is the acceptance test. It already has a finished reference to match frame for frame.

1. **Viewer:** load a scene file of glTF assets; orbit camera, plus a free cam on a gamepad. First check: gamepads work inside an artifact.
2. **Time core:** tracks, keys, `evaluate(scene, t)`, scrubbing, and the graph editor ported.
3. **Camera tools and takes:** lens in mm, focus, recording takes and turning them into keys.
4. **Render mode:** frame sequences to G:, depth and ID passes, and camera export to Blender. Then rebuild Black Page in it.
5. **Characters:** rigged glTF clips on the timeline, including a Mixamo clip retargeted onto one of your rigs.
6. **Arch viz:** a baked-lightmap pipeline from Blender, plus Present mode.

Decisions so far, and what's still open:

- [ ] Name: Virtual Shot for now; check for existing products before it goes public.
- [ ] Where it runs: browser first, with artifacts for iteration (decided Oct 7). An Electron desktop build can come later, which would also give Render mode direct disk access.
- [ ] First project: Virtual Legacy video work comes first; arch viz follows once that's solid (decided Oct 7).
- [ ] UI: built by iteration, modelled on Resolve, After Effects, Blender and Unreal (Oct 7). The UI library underneath is still to pick at kickoff.

## Carry into the new project

The new project starts with no memory of this one, so it needs these pointers.

- **Black Page Studio** (the acceptance test and the code to port): `G:\Claude\Virtual Legacy\Videos\Calling (Wii)\Thumbnails & Graphics\Black Page Studio\`. Start with `HANDOFF.md`; the files to port are `source\graph_editor.js` (graph editor, `fitCubic`) and `blender\export_frame.js` with `animate_scene.py` (camera export and Blender import).
- **Final Black Page render to match:** `final\black_page_opener_final_2160p60.mp4` in the same folder.
- **Research behind the choices:** the [Web Graphics Stack](https://claude.ai/artifact/SgrNo4f6ewFuaKtmTXGj4L) page.
- **Rules that carry over:** write only to G:, read E:\\Assets in place, and put creative choices on a review board before applying them.
- **Repository:** the code lives in connsteele/Virtual-Shot (local clone F:\\Repos\\Virtual-Shot), with the first spike on the spike branch.
