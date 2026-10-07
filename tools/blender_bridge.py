# Blender <-> Virtual Shot engine bridge (server/bridge.mjs), message format vsb/1 (docs/engine-bridge.md).
# Standard library only (UDP JSON datagrams), so it runs in any Blender 4.x/5.x without installing anything.
#
# Interactive (in your own Blender, Text editor > Run Script): streams the scene's active camera at 60 Hz while you
# move it, scrub or play; run again to stop.
#     exec(open(r"F:/Repos/Virtual-Shot/tools/blender_bridge.py").read())     # or open it in the Text editor and run
#
# Background demo (makes its own scratch scene; never opens or saves anyone's .blend):
#     blender -b --factory-startup --python tools/blender_bridge.py -- --demo --markers <markers.json> --out <dir>
#         [--port 8799] [--fps 60] [--frames 1-180] [--render 1,90,180] [--no-stream]
#   builds markers at known Black Page scene points and an animated camera (lens and roll change), streams frames
#   1..N in real time as a fixed-step source, writes <out>/blender_truth.json (each marker's pixel position per frame,
#   from Blender's own camera model) and renders the --render frames with Workbench (transparent background) for overlays.
# Background receiver (the reverse direction: Virtual Shot's shot camera into Blender):
#     blender -b --factory-startup --python tools/blender_bridge.py -- --receive --secs 6 --out <dir>
#   joins as a sink in Blender conventions, applies each received pose to a camera, keys it, and writes
#   <out>/blender_received.json; --save also saves the scratch scene as <out>/received_take.blend.
import bpy, json, math, os, socket, sys, time
from mathutils import Matrix, Quaternion, Vector

HOST = "127.0.0.1"

def now_ms():
    return time.time() * 1000.0

def cam_message(scene, cam, frame):
    """The camera as a vsb/1 cam message in Blender conventions (metres, Z up, camera looks -Z local, vertical FOV)."""
    mw = cam.matrix_world
    loc, rot, _ = mw.decompose()
    rx, ry = scene.render.resolution_x * scene.render.pixel_aspect_x, scene.render.resolution_y * scene.render.pixel_aspect_y
    aspect = rx / ry
    d = cam.data
    # Blender's sensor fit: AUTO uses the sensor width on the longer side
    fit = d.sensor_fit if d.sensor_fit != 'AUTO' else ('HORIZONTAL' if aspect >= 1 else 'VERTICAL')
    if fit == 'HORIZONTAL':
        hfov = 2 * math.atan(d.sensor_width / 2 / d.lens); vfov = 2 * math.atan(math.tan(hfov / 2) / aspect)
    else:
        sh = d.sensor_height if d.sensor_fit == 'VERTICAL' else d.sensor_width
        vfov = 2 * math.atan(sh / 2 / d.lens)
    us = scene.unit_settings.scale_length or 1.0
    return {"type": "cam", "id": cam.name, "f": frame, "ts": now_ms(), "p": [v * us for v in loc], "q": [rot.x, rot.y, rot.z, rot.w],
            "fov": math.degrees(vfov), "aspect": aspect, "lens": {"mm": d.lens, "sensor": [d.sensor_width, d.sensor_height], "focus": d.dof.focus_distance}}

def hello(sock, port, role, fps, extra=None):
    m = {"type": "hello", "v": 1, "role": role, "name": "blender", "app": "Blender " + bpy.app.version_string, "conventions": "blender",
         "fps": fps, "timebase": "fixed", "rate": fps}
    if extra: m.update(extra)
    sock.sendto(json.dumps(m).encode(), (HOST, port))

# ---- interactive: a timer streams the active camera while this Blender runs
def _tick():
    st = bpy.app.driver_namespace.get("vsb_stream")
    if not st: return None
    scene = bpy.context.scene; cam = scene.camera
    if cam:
        m = cam_message(scene, cam, scene.frame_current)
        key = (tuple(round(v, 6) for v in m["p"]), tuple(round(v, 6) for v in m["q"]), round(m["fov"], 4), m["f"])
        if key != st.get("last") or time.time() - st.get("sent", 0) > 0.5:   # changed, or a keep-alive twice a second
            st["sock"].sendto(json.dumps(m).encode(), (HOST, st["port"])); st["last"] = key; st["sent"] = time.time()
    return 1 / 60

def toggle_interactive(port=8799):
    st = bpy.app.driver_namespace.get("vsb_stream")
    if st:
        bpy.app.driver_namespace["vsb_stream"] = None; print("Virtual Shot bridge: stopped streaming"); return False
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    hello(s, port, "source", bpy.context.scene.render.fps / bpy.context.scene.render.fps_base)
    bpy.app.driver_namespace["vsb_stream"] = {"sock": s, "port": port}
    bpy.app.timers.register(_tick, first_interval=0.0, persistent=False)
    print(f"Virtual Shot bridge: streaming the active camera to udp {HOST}:{port} (run again to stop)"); return True

# ---- background demo
def gltf_to_blender(p):
    return Vector((p[0], -p[2], p[1]))

def build_demo(markers, fps, f0, f1):
    scene = bpy.context.scene
    for o in list(scene.objects): bpy.data.objects.remove(o, do_unlink=True)
    scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = 1920, 1080, 100
    scene.render.fps, scene.render.fps_base = fps, 1.0
    scene.frame_start, scene.frame_end = f0, f1
    mat = bpy.data.materials.new("marker"); mat.diffuse_color = (1.0, 0.25, 0.1, 1.0)
    for name, p in markers.items():
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.006, location=gltf_to_blender(p), segments=16, ring_count=8)
        o = bpy.context.active_object; o.name = "m_" + name; o.data.materials.append(mat)
    cam_data = bpy.data.cameras.new("GameCam"); cam = bpy.data.objects.new("GameCam", cam_data); scene.collection.objects.link(cam); scene.camera = cam
    cam_data.sensor_fit, cam_data.sensor_width = 'AUTO', 36.0
    cam_data.clip_start, cam_data.clip_end = 0.01, 50
    cam.rotation_mode = 'QUATERNION'
    look = gltf_to_blender(markers["glass_ctr"])
    path = [((0.45, 0.45, 0.95), 0, 30), ((-0.35, 0.34, 0.72), 6, 24), ((0.05, 0.62, 1.15), -4, 40), ((0.38, 0.28, 0.62), 3, 28)]
    n = len(path) - 1
    for i, (pg, roll, lens) in enumerate(path):
        f = round(f0 + (f1 - f0) * i / n); p = gltf_to_blender(pg)
        q = (look - p).to_track_quat('-Z', 'Y') @ Quaternion((0, 0, 1), math.radians(roll))
        cam.location, cam.rotation_quaternion, cam_data.lens = p, q, lens
        cam.keyframe_insert("location", frame=f); cam.keyframe_insert("rotation_quaternion", frame=f); cam_data.keyframe_insert("lens", frame=f)
    return scene, cam

def project(scene, cam, pts):
    from bpy_extras.object_utils import world_to_camera_view
    out = {}
    for name, p in pts.items():
        v = world_to_camera_view(scene, cam, gltf_to_blender(p))
        out[name] = [v.x * 1920, (1 - v.y) * 1080, v.z]
    return out

def demo(a):
    markers = json.load(open(a["markers"]))
    fps = int(a.get("fps", 60)); f0, f1 = (int(x) for x in a.get("frames", "1-180").split("-")); port = int(a.get("port", 8799)); out = a["out"]
    os.makedirs(out, exist_ok=True)
    scene, cam = build_demo(markers, fps, f0, f1)
    truth = {"fps": fps, "frames": {}}
    for f in range(f0, f1 + 1):
        scene.frame_set(f); truth["frames"][f] = {"px": project(scene, cam, markers), "cam": cam_message(scene, cam, f)}
    json.dump(truth, open(os.path.join(out, "blender_truth.json"), "w"))
    if a.get("render"):
        scene.render.engine = 'BLENDER_WORKBENCH'; scene.render.film_transparent = True
        scene.display.shading.light, scene.display.shading.color_type = 'FLAT', 'MATERIAL'
        for f in (int(x) for x in a["render"].split(",")):
            scene.frame_set(f); scene.render.filepath = os.path.join(out, f"blender_f{f:04d}.png"); bpy.ops.render.render(write_still=True)
    if "no-stream" in a: return
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); hello(s, port, "source", fps)
    time.sleep(0.3)
    t0 = time.perf_counter(); sent = 0
    for f in range(f0, f1 + 1):
        scene.frame_set(f); s.sendto(json.dumps(cam_message(scene, cam, f)).encode(), (HOST, port)); sent += 1
        nxt = t0 + (f - f0 + 1) / fps
        while time.perf_counter() < nxt: time.sleep(max(0, min(0.002, nxt - time.perf_counter())))
    print(f"blender_bridge: streamed {sent} frames in {time.perf_counter() - t0:.2f} s")

def receive(a):
    port = int(a.get("port", 8799)); secs = float(a.get("secs", 6)); out = a["out"]; os.makedirs(out, exist_ok=True)
    scene = bpy.context.scene
    for o in list(scene.objects): bpy.data.objects.remove(o, do_unlink=True)
    cam_data = bpy.data.cameras.new("FromVirtualShot"); cam = bpy.data.objects.new("FromVirtualShot", cam_data); scene.collection.objects.link(cam); scene.camera = cam
    cam.rotation_mode = 'QUATERNION'; cam_data.sensor_fit, cam_data.sensor_width = 'VERTICAL', 24.0
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind((HOST, 0)); s.settimeout(0.2)
    hello(s, port, "sink", 60, {"subscribe": ["cam", "hello"], "name": "blender-receiver"})
    got, t_end = [], time.time() + secs
    while time.time() < t_end:
        try: data, _ = s.recvfrom(65536)
        except socket.timeout: continue
        m = json.loads(data)
        if m.get("type") != "cam": continue
        cam.location = Vector(m["p"]); cam.rotation_quaternion = Quaternion((m["q"][3], m["q"][0], m["q"][1], m["q"][2]))
        cam_data.lens = 12.0 / math.tan(math.radians(m["fov"]) / 2)   # vertical FOV on a 24 mm vertical sensor
        f = int(m.get("f", len(got))); cam.keyframe_insert("location", frame=f); cam.keyframe_insert("rotation_quaternion", frame=f); cam_data.keyframe_insert("lens", frame=f)
        got.append({"rx": now_ms(), **m})
    json.dump(got, open(os.path.join(out, "blender_received.json"), "w"))
    print(f"blender_bridge: received {len(got)} camera samples")
    if "save" in a: bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, "received_take.blend"), copy=True)

def parse(argv):
    a, i = {}, 0
    while i < len(argv):
        k = argv[i].lstrip("-")
        if i + 1 < len(argv) and not argv[i + 1].startswith("--"): a[k] = argv[i + 1]; i += 2
        else: a[k] = True; i += 1
    return a

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
args = parse(argv)
if "demo" in args: demo(args)
elif "receive" in args: receive(args)
elif not bpy.app.background: toggle_interactive(int(args.get("port", 8799)))
