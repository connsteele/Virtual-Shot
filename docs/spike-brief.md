# Handoff: Virtual Shot spike (Black Page parity)

**For:** a fresh, higher-effort thread in the Virtual Legacy project. **From:** Channel · 3D graphics research. **As of:** Oct 7, 2026.

## What this is

A deliberately crude, one-shot test build of **Virtual Shot**, Connor's planned reusable 3D shot tool. The goal is to rebuild the Black Page cold open in it until the picture matches, then report what the plan got wrong. The spike is throwaway. Its main deliverable is the learnings, which get folded back into the architecture doc before the real project starts at a slower pace.

**Read first:** the architecture sketch, a Claude Doc: https://claude.ai/code/artifact/8d3dff7c-e6fc-49fa-bc6d-3eee72db0784 (read it with the Claude Docs tools). Background research: https://claude.ai/artifact/SgrNo4f6ewFuaKtmTXGj4L

## The goal: parity with the Black Page engine picture

Parity means the **engine frames**, not the final video. The final video adds Cycles haze and a pops layer, and both are out of scope.

- **Reference frames:** `blender\export\final_engine\f00000.png` … `f01175.png`. That's 1176 frames, 1920×1080, 60 fps, 19.6 s, with pops off.
- **Reference camera:** `blender\export\cams_final.json` (eye, target, up, FOV, lens amount and squint per frame, from `BPX.exportCams`).
- **The scene and timing it must reproduce:** `final\opener_final.json`. This is the final script: chat messages, camera channels, focus keys, ghosts, LED, polaroid, Wii model, chaos curve, lighting.
- **The engine to match:** `source\engine.html` (v4.8.1, already patched). It covers the WebGL2 scene, the CRT screen shader, Canvas 2D chat, lens, squint, depth of field, ring light and bounce. The built page is `final\test.html`.

All paths are relative to `G:\Claude\Virtual Legacy\Videos\Calling (Wii)\Thumbnails & Graphics\Black Page Studio\`. Read `HANDOFF.md` and `blender\README.md` there first. They explain the engine, the camera export and the coordinate conventions (glTF Y up; engine matrices are column-major).

**Done means:** side-by-side and difference images at about 6 key frames, chosen from the reveal (~5 s), the head turn (~10.4 s), the stare/squint (~12 s), the ghost flash (18.3 s) and the last frame (1175). Framing must match, and look must be close. Note any part that can't reach parity and why.

## Scope

**In:** the scene document (JSON, every object placed as data), the time core (`evaluate(scene, t)`), three.js rendering pinned to one version, the camera from the scene's tracks, the CRT screen and lens look, a basic timeline scrub, and frame export.

**Out:** characters, arch viz, Present mode, the MCP server, the game link, a polished UI, and haze. A rough graph editor port from `source\graph_editor.js` is optional.

**Your calls to make, and say which:** WebGPURenderer with TSL vs. WebGLRenderer; how the Canvas 2D chat becomes a texture; whether to port the GLSL shaders as-is or rewrite them in TSL.

## Where the work goes

- **Work in Connor's local clone:** `F:\Repos\Virtual-Shot`, on the `spike` branch (already on GitHub; run `git fetch` then `git switch spike`). Run as a Remote Control session in that folder, so builds, the dev server, git and GPU renders all happen on Connor's PC (RTX 4090). Code and `LEARNINGS.md` live here; commit and push as you go.
- **Rendered frames and comparison images:** `G:\Claude\Virtual Legacy\Channel\Virtual Shot spike\`, not the repo, because they're large.

## Rules

- **Write only to the repo folder on F: and to the new folder** `G:\Claude\Virtual Legacy\Channel\Virtual Shot spike\`. Never change anything in the Black Page folder. Never rebuild over `blender\black_page_anim.blend`, and keep `blender\export\atmos_final` and `seq_screen`.
- **Read models in place** from `E:\Assets\Asset Packs\PSX Humble Bundle\PSX Mega Pack 3.1.3\Models\GLB (recommended)`. Never copy, move or reorganise anything on E:. Astra's Wii Remote is at `G:\GPT\Projectless\2026-10-04\gen\outputs\Wii_Remote_LowPoly\Wii_Remote_LowPoly.glb`.
- **Browser first:** iterate as a claude.ai artifact where possible. Rendering frames to disk runs from a local copy of the page (Black Page used `blender\serve.py` plus POST uploads with retries).
- **Creative look is Connor's call:** match the existing look; don't redesign it.
- **Links:** give Connor file links as %20-encoded paths, e.g. `[x](G:/Claude/Virtual%20Legacy/...)`.

## Deliverable: `LEARNINGS.md` on the spike branch

Keep it updated as you go, not only at the end:

1. Where the doc's plan was wrong or vague (scene format, time core, layers, tech defaults).
2. What took longest, and what three.js gave for free or fought against.
3. What could not reach parity, and why.
4. Recommended changes to the doc, as concrete edits.
5. Effort per milestone: how many attempts or rewrites each one took.

Finish with a short reply to Connor: the comparison images, a link to `LEARNINGS.md` on the branch, and the top five doc changes.
