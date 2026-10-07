# Engine bridge: message format `vsb/1`

The engine bridge streams a live camera (and chosen events) from another program into Virtual Shot, or Virtual Shot's
shot camera out to another program. It is the architecture sketch's "game link": a game mod, an emulator script,
Blender or Unreal sends its camera; Virtual Shot draws its own scene from that camera in step, so its layers line up
with the game footage for compositing.

```
 game mod / emulator / Blender ──udp or ws──▶ server/bridge.mjs ──ws──▶ Virtual Shot editor (Live ▾)
                                         ◀── (reverse: shot camera) ◀──
```

- **Bridge:** `node server/bridge.mjs [port=8799] [--log=<file.jsonl>]`. WebSocket on `ws://127.0.0.1:<port>/`, JSON
  datagrams on `udp 127.0.0.1:<port>`, status on `http://127.0.0.1:<port>/status`. No dependencies. Listens on
  127.0.0.1 only.
- **Editor:** viewport bar, **Live ▾** → Connect → tick "Shot camera follows the stream". Nothing connects until you
  press Connect, and the scene document never changes except through Record.
- **Senders in the repo:** `tools/sim_game.mjs` (a simulated game, Unreal conventions, realistic frame timing),
  `tools/blender_bridge.py` (Blender: stream the active camera, or receive Virtual Shot's camera).

## Transport

- One JSON object per WebSocket text frame or per UDP datagram (keep datagrams under ~1400 bytes; a cam message is about
  300).
- The first message from each client should be a `hello`. A UDP sender that never says hello is treated as a pure
  source in glTF conventions and gets nothing back.
- The bridge stamps every message with `rx` (its receive time), converts `cam` messages from the sender's conventions
  to canonical, then forwards them to every other client in **that client's** declared conventions. So a Blender
  receiver gets Blender coordinates, and a game sending Unreal coordinates needs no conversion code of its own.

## Canonical frame (what Virtual Shot works in)

glTF conventions, as in the scene document: **metres, right-handed, +Y up**. A camera looks down its local **−Z**, with
**+Y** up and **+X** right. `p` is the camera position, `q` the camera's rotation `[x, y, z, w]` (camera local to
world), `fov` the **vertical** field of view in degrees. Times are **milliseconds on the sender's clock**, epoch based
(`Date.now()` or better). The receiver maps the sender's clock to its own by the smallest receive−send offset seen
(no clock sync needed).

## Messages

### `hello` (every client, first)

```json
{ "type": "hello", "v": 1, "role": "source", "name": "dolphin-sms", "app": "Dolphin 2412 + script",
  "conventions": "unreal", "rate": 60, "fps": 60, "timebase": "fixed", "aspect": 1.7778,
  "subscribe": ["cam", "event", "hello", "bye"] }
```

| Field | Meaning |
| --- | --- |
| `role` | `source`, `sink` or `both` (informational; any client may send and receive) |
| `name` | unique source name; forwarded messages carry it as `src` |
| `conventions` | `gltf` (default), `blender`, `unreal`, `unity`, or `{ "preset": "unreal", "units": 0.0254, ... }`, or a full object (below) |
| `rate` | camera samples per second it intends to send (informational) |
| `fps`, `timebase` | `timebase: "fixed"` with `fps`: the source steps a fixed tick (an emulator, Blender, a fixed-step game). Takes are then placed by frame number `f`, not by time, so a hitch in sending can't stretch a take |
| `aspect` | picture aspect, used to turn a horizontal FOV into a vertical one |
| `subscribe` | message types this client wants forwarded to it (default: all) |

The bridge answers `{ "type": "welcome", "id", "tb", "conventions" }`, tells the others
`{ "type": "hello", "src", "role", "conventions", ...extras }`, and replays the hellos of everyone already connected to
the newcomer. When a WebSocket client leaves, the others get `{ "type": "bye", "src" }`.

### `cam` (a camera sample)

```json
{ "type": "cam", "id": "main", "f": 18231, "ts": 1791371752622.4,
  "p": [120.5, -40.2, 180.0], "r": [-12.0, 95.5, 0.0], "fov": 90, "aspect": 1.7778,
  "lens": { "mm": 35, "sensor": [36, 24], "focus": 3.2, "fstop": 2.8 } }
```

| Field | Meaning |
| --- | --- |
| `id` | which camera of the source (`main` by default) |
| `f` | the sender's frame number (game frame, emulator field, Blender frame). Gaps show dropped samples |
| `ts` | sender time of the frame the pose belongs to (sample time, not send time), ms |
| `p` | position in the sender's conventions |
| `q` | rotation `[x, y, z, w]` in the sender's coordinates, **or** `r`: Unreal FRotator `[pitch, yaw, roll]` degrees (`conventions` with `rot: "ue"`) |
| `fov` | field of view in degrees, on the axis the conventions name (`vertical` or `horizontal`) |
| `cut` | optional `true` on the first sample after a camera cut or teleport: receivers never interpolate or extrapolate across it |
| `lens` | optional: `mm` + `sensor` [w, h] (used when `fov` is missing), `focus` distance (m), `fstop` |

### `event`

```json
{ "type": "event", "ts": 1791371752622.4, "f": 18231, "name": "hit", "data": { "damage": 12 } }
```

Chosen game events (a hit, a cutscene start, a checkpoint). The editor lists the last few; Record writes the ones inside
the take as markers (`doc.events.markers`, `{ t, name, data }`), which `evaluate()` ignores.

### `ping` / `pong`

`{ "type": "ping", "t0": <your clock> }` → `{ "type": "pong", "t0", "tb": <bridge clock> }`, for senders that want to
measure their round trip.

## Conventions

A conventions object: `basis` (3×3 rows taking source world coordinates to canonical; may flip handedness), `units`
(metres per source unit), `fwd` and `up` (the camera's look and up axes in its own local frame), `fov`
(`vertical`|`horizontal`), `rot` (`quat`|`ue`).

| Preset | Units | Up | Hand | Camera looks | Rotation | FOV |
| --- | --- | --- | --- | --- | --- | --- |
| `gltf` | m | +Y | right | −Z | quaternion | vertical |
| `blender` | m (unit scale 1) | +Z | right | −Z local (`matrix_world`) | quaternion | vertical |
| `unreal` | cm | +Z | left | +X | FRotator pitch/yaw/roll | horizontal |
| `unity` | m | +Y | left | +Z | quaternion | vertical (`Camera.fieldOfView`) |

Anything else (Source engine inches, a game's own Z-up left-handed frame, a console game's raw view matrix) is a
preset plus overrides, e.g. `{ "preset": "unreal", "units": 0.0254 }`. A game that only exposes a view matrix sends the
inverse of it as the camera's world rotation and position.

## Aligning a game's world with the scene

A game's origin is not the scene's. In the editor, **Align to shot camera** moves and turns (about +Y) the stream's
world so the stream's current camera sits exactly where the shot camera is keyed now; scale stays 1 unless set in
code (`VS.live.align = { p, yaw, s }`). For real compositing the scene is built to match the game's geometry, and the
alignment is a fixed transform you keep with the shot.

## In the editor

- **Live** (follow the stream): each drawn frame takes the stream's pose for that moment, by play-out mode:
  `Interpolate, fixed delay` (default 50 ms: smooth, adds the delay), `Latest sample` (lowest latency, judders when the
  sample clock and the display beat), `Extrapolate` (predicts up to 50 ms ahead; overshoots on stops and hitches).
  The pose becomes rig values (`poseToRig` in `src/core/evaluate.js`, including roll) passed to `evaluate()` as an
  override, like a gamepad take; the lens warp is off by default (a game's straight lens).
- **Record**: plays the shot from the playhead in step with the stream; Stop resamples the raw samples once per shot
  frame (by frame number for a fixed-step source) and writes them through the named command `writeCameraTake`
  (thinned to Bézier keys, one undo). `evaluate()` stays a pure function of t.
- **Send the shot camera out**: publishes the shot camera every drawn frame as a `cam` message (`id: "shot"`), for a
  Blender or Unreal receiver.
- Scripting: `VS.live.connect()`, `.start()`, `.stop()`, `.startRecord()`, `.stopRecord()`, `.report()`,
  `VS.cmd('writeCameraTake', { samples: [{ t, rig }], markers })`.
