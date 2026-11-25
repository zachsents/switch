"""render: photoreal renders of 3D models in a standard scene, in one call, instead of composing Blender scenes by hand.

`render` takes a model (STL, 3MF, STEP, OBJ, PLY, a .blend or glTF: paths or URLs), puts it in a standard setting (an
oak desk, a stone table, a light or dark studio sweep, a cut-out with only its shadow, or a wall it's mounted on), on a
prop when asked (a glass candle jar fitted to the model's bore, with wax and wicks; a phone, by model; or any model file
as glass, aluminium, steel...), lets it settle onto whatever is under it, frames each shot to fit (hero, close, front,
side, back, top, low, a detail around a point), and renders it in Cycles on this machine's GPU with the printed-plastic
shader (layer lines along its print axis, the bed's texture on the face that printed down). Each shot is checked from
the render's object pass (how much of the frame the part fills, whether it runs off it, blown out or crushed), the
exposure is metered on the part itself, and the pictures come back inline and as files (PNG, and a JPEG under 1 MB),
with a contact sheet. `ai_look` adds an AI print-look pass (an image edit through the AI Gateway connection,
$0.05-0.14 a shot) and a side by side to check it against.

The Blender side is scene.py, run once a job (`blender -b --factory-startup -P scene.py -- job.json`); this server
needs only the standard library. The shader is look/printed_material.py.
"""

import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid

import mesh
import sbmcp
from server import app, config, key, part_home

NAME = "render"
HERE = os.path.dirname(os.path.abspath(__file__))
HOME = part_home(NAME)
JOBS_DIR = os.path.join(HOME, "jobs")
HEARTBEAT_S = float(os.environ.get("RENDER_HEARTBEAT_S") or 600)
KEEP_DAYS = float(os.environ.get("RENDER_KEEP_DAYS") or 7)
"""Job folders older than this go (save_to keeps pictures anywhere else)."""
STL_EXTS = (".stl",)
CONVERT_EXTS = (".3mf", ".step", ".stp", ".obj", ".ply", ".blend", ".fbx", ".glb", ".gltf", ".usd", ".usdz", ".usdc",
                ".off")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"


def blender():
    """Blender: config's blender, else the app where macOS keeps it, else on PATH."""
    for p in (config().get("blender"), "/Applications/Blender.app/Contents/MacOS/Blender",
              os.path.expanduser("~/Applications/Blender.app/Contents/MacOS/Blender"), shutil.which("blender")):
        if p and os.access(os.path.expanduser(p), os.X_OK):
            return os.path.expanduser(p)
    return "blender"


LOCK = threading.Lock()
"""One Blender at a time: the GPU is one, and a second render only slows the first."""

SCENES = {
    "desk": "An oak desk (a CC0 oak scan, at true scale) under soft window light, a pale wall far behind. The default.",
    "table": "A warm stone tabletop and a warm grey wall.",
    "studio": "A seamless light grey paper sweep and soft boxes: a neutral product shot.",
    "dark": "A charcoal sweep with rim lights: for light-coloured, silk or translucent parts.",
    "cutout": "No background: the model and its soft shadow on transparency (PNG with alpha; the JPEG is on white), to "
              "put on a page or another picture.",
    "wall": "A plaster wall the model is mounted on (its against face flat to the wall), lit to throw its shadow on it: "
            "for hooks, brackets, mounts.",
}
PROPS = {
    "jar": "A glass candle jar with wax poured in it. diameter (mm across the rim, or \"fit\", the default: from the "
           "model's own bore less clearance 0.5 mm), height (default 1.15 x diameter), wall (3.2), fill (wax height mm "
           "from the bottom, default 75% of height; 0 for empty), wax (colour), glass (colour), wicks (a count, or "
           "[[x, y], ...] mm from the jar's axis: the model sits centred on it). The model settles onto the rim.",
    "phone": "A phone lying on the desk, back up (face: down, the default) or screen up (face: up), its top end away "
             "from the camera, by model: " + ", ".join(
                 ["iphone-13", "iphone-13-pro", "iphone-14", "iphone-14-pro", "iphone-15", "iphone-15-pro",
                  "iphone-16", "iphone-16-pro", "iphone-17"]) + " (close, not exact: for a part that must fit one "
             "exactly, give the phone as a file). With place.on \"camera\" the model goes over its camera module.",
    "file": "Any model file as the thing the part goes on or with: {file, material (glass, frosted glass, aluminum, "
            "anodized, steel, chrome, brass, gold, silver, copper, wood, rubber, ceramic, concrete, leather, fabric, "
            "paper, wax, plastic, or a printed one like pla), color, rotate, offset}. With place.mode as_is the "
            "model and it share coordinates (an assembly); else it stands centred on the desk and the model settles on it.",
}
SHOT_NAMES = {
    "hero": "3/4 from the front left, a little above, everything framed (70 mm lens)",
    "close": "steeper and nearer, the model alone filling the frame (90 mm)",
    "detail": "a close-up around a point: give around [x, y, z] in the model's own mm and radius (mm)",
    "front": "straight on from the front, low", "side": "from the right", "left": "from the left",
    "back": "from behind", "back_hero": "3/4 from behind", "low": "low and wide, nearly at desk height",
    "top": "straight down",
}
MATERIALS = ("pla, pla_matte (matte pla), petg, silk (silk pla), asa (abs), asa_smoothed (vapor-smoothed asa), tpu, "
             "nylon, cf: printed, with layer lines along print_up and the bed's texture on the face that printed down "
             "(finish \"smooth\" drops them: the CAD look). Not printed: resin, glass, aluminum, anodized, steel, chrome, "
             "brass, gold, silver, copper, wood, rubber, ceramic, concrete, plastic (injection-molded).")

SHOT = {"anyOf": [{"type": "string"}, {"type": "object", "properties": {
    "name": {"type": "string"}, "view": {"type": "string", "description": "A named view to start from (hero, close...)."},
    "azimuth": {"type": "number", "description": "Degrees from the front, + toward the right."},
    "elevation": {"type": "number", "description": "Degrees above the desk."},
    "lens": {"type": "number", "description": "Focal length, mm (36 mm sensor)."},
    "around": {"type": "array", "items": {"type": "number"}, "description": "A detail shot's centre [x, y, z] in the model's own mm."},
    "radius": {"type": "number", "description": "How much around it to frame, mm (default 10)."},
    "fstop": {"type": "number"}, "dof": {"type": "boolean"},
    "margin": {"type": "number", "description": "Room around what's framed (1.1 is 10%)."},
    "distance_scale": {"type": "number", "description": "Further (>1) or nearer (<1) than the fit."}}}]}
MODEL_FILE = {"anyOf": [{"type": "string"}, {"type": "object", "properties": {
    "file": {"type": "string", "description": "A path or https URL."},
    "name": {"type": "string"}, "material": {"type": "string"}, "color": {"type": "string"},
    "finish": {"type": "string", "enum": ["printed", "smooth"]},
    "layer_mm": {"type": "number"}, "print_up": {"type": "array", "items": {"type": "number"},
                                                  "description": "Its own axis that pointed up off the bed (default [0, 0, 1])."},
    "rotate": {"type": "array", "items": {"type": "number"}}, "offset": {"type": "array", "items": {"type": "number"}}}, "required": ["file"]}]}
PROP = {"anyOf": [{"type": "string", "description": "jar, phone, iphone-15-pro..., or a model file (path or URL)."},
                  {"type": "object", "properties": {
                      "kind": {"type": "string", "enum": ["jar", "phone", "file"]},
                      "diameter": {"type": ["number", "string"], "description": "Jar: mm across the rim, or fit (default)."},
                      "height": {"type": "number"}, "wall": {"type": "number"}, "fill": {"type": "number"},
                      "clearance": {"type": "number"}, "wax": {"type": "string"}, "glass": {"type": "string"},
                      "wicks": {"type": ["integer", "array"], "description": "Jar: a count, or [[x, y], ...] mm from its axis."},
                      "model": {"type": "string", "description": "Phone: iphone-13 ... iphone-17, -pro."},
                      "face": {"type": "string", "enum": ["down", "up"]},
                      "file": {"type": "string"}, "material": {"type": "string"}, "color": {"type": "string"},
                      "rotate": {"type": "array", "items": {"type": "number"}},
                      "offset": {"type": "array", "items": {"type": "number"}}, "name": {"type": "string"}}}]}
RENDER_SCHEMA = {"type": "object", "properties": {
    "files": {"type": "array", "items": MODEL_FILE, "description": "The model's parts: paths, URLs, or {file, name, material, color, finish, layer_mm, print_up, rotate, offset}. STL as is; 3MF, STEP, OBJ, PLY, .blend, glTF, FBX, USD through convert."},
    "material": {"type": "string", "description": "For every part that doesn't say: pla (default), pla_matte, petg, silk, asa, asa_smoothed, tpu, resin, glass, aluminum, steel, wood..."},
    "color": {"type": "string", "description": "A name (black, white, light grey, navy...) or #rrggbb."},
    "finish": {"type": "string", "enum": ["printed", "smooth"], "description": "printed (default: layer lines, bed texture) or smooth (the CAD look)."},
    "scene": {"type": "string", "enum": list(SCENES), "description": "desk (default: an oak desk), table, studio, dark, cutout, wall."},
    "on": {"anyOf": [PROP, {"type": "array", "items": PROP}], "description": "What it sits on or goes with: jar, phone, a model file, or one described."},
    "place": {"type": "object", "properties": {
        "mode": {"type": "string", "enum": ["drop", "as_is", "wall"]},
        "down": {"type": "string", "enum": ["z-", "z+", "x+", "x-", "y+", "y-"]},
        "rotate": {"type": "array", "items": {"type": "number"}}, "spin": {"type": "number"},
        "at": {"type": "array", "items": {"type": "number"}}, "on": {"type": "string", "enum": ["center", "camera"]},
        "against": {"type": "string", "enum": ["z-", "z+", "x+", "x-", "y+", "y-"]}},
        "description": "drop (default: settles onto the prop or desk), as_is (the files' coordinates), wall; down, rotate, spin, at [x, y] mm, on camera, against."},
    "assembly": {"type": "boolean", "description": "The parts and a file prop share coordinates: keep them (place.mode as_is)."},
    "arrange": {"type": "string", "enum": ["row"], "description": "Set the parts side by side on the desk."},
    "shots": {"type": "array", "items": SHOT, "description": "hero, close, detail, front, side, left, back, back_hero, low, top, or one described (default hero, plus close with a prop)."},
    "size": {"type": ["string", "array"], "description": "1600x1200 (default), square, portrait, wide, or WxH."},
    "preview": {"type": "boolean", "description": "Half size, 32 samples, ~10 s a shot: frame it with this first."},
    "samples": {"type": "integer", "description": "Default 160 (32 in a preview)."},
    "exposure": {"type": ["string", "number"], "description": "auto (default: metered on the part) or EV."},
    "light": {"type": "number", "description": "A multiplier on every light (default 1)."},
    "dof": {"type": "boolean", "description": "Depth of field (default on: the model sharp, the background soft)."},
    "layer_mm": {"type": "number", "description": "Layer height for the printed look (default 0.2)."},
    "print_up": {"type": "array", "items": {"type": "number"}, "description": "The parts' own axis that pointed up off the bed (default [0, 0, 1])."},
    "ai_look": {"type": ["boolean", "array"], "description": "An AI print-look pass on these shots (true: all), with a side by side to check: $0.05-0.14 each, on the AI Gateway key."},
    "describe": {"type": "string", "description": "The part in words, for the AI pass (default from its names, material and colour)."},
    "ai_model": {"type": "string", "description": "The AI pass's model (default google/gemini-3-pro-image; openai/gpt-image-2.5-sunburst keeps sculpted detail)."},
    "save_to": {"type": "string", "description": "Also put the pictures in this folder."},
    "about": {"type": "array", "items": {"type": "string"}, "description": "Entities the render is for, on its event."},
    "show": {"type": "integer", "description": "Pictures to show inline (default 4)."}}}


app.event("render", "A render made: its model, scene and pictures", stream="media/renders", kind="observation")

state = {"started_at": int(time.time() * 1000), "calls": 0, "renders": 0, "shots": 0, "failed": 0, "last_error": None,
         "last_render": None, "busy": None}


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def safe_name(name, default="model"):
    name = re.sub(r"[^A-Za-z0-9._ -]+", "-", os.path.basename(str(name or "")).strip()).strip(" .-")
    return name or default


def bring(source, dest_dir):
    """One file here, from an https URL or a path on this machine. Its path here."""
    source = str(source).strip()
    os.makedirs(dest_dir, exist_ok=True)
    if re.match(r"https?://", source):
        name = safe_name(urllib.parse.unquote(os.path.basename(urllib.parse.urlparse(source).path)), "download")
        dest = os.path.join(dest_dir, name)
        req = urllib.request.Request(source, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=180) as r, open(dest, "wb") as f:
            shutil.copyfileobj(r, f)
        return dest
    dest = os.path.join(dest_dir, safe_name(source.rstrip("/")))
    path = os.path.expanduser(source)
    try:
        shutil.copyfile(path, dest)
    except FileNotFoundError:
        raise ValueError(f"no such file: {path}")
    except PermissionError:
        raise ValueError(f"macOS keeps {path} from this process: give it Full Disk Access, or move the file")
    return dest


def sniff(path):
    """A model's kind from its bytes, for a link that came without a name."""
    with open(path, "rb") as f:
        head = f.read(512)
    if head.startswith(b"PK"):
        return ".3mf"
    if b"ISO-10303" in head:
        return ".step"
    if head.startswith(b"ply"):
        return ".ply"
    if head.startswith(b"BLENDER"):
        return ".blend"
    if head.startswith(b"glTF"):
        return ".glb"
    if head.lstrip().startswith((b"v ", b"o ", b"mtllib", b"# ")) and b"\nv " in head:
        return ".obj"
    return ".stl"


class _Quiet:
    """A context for convert when render's own caller gave none."""
    work = None
    cancelled = threading.Event()

    def progress(self, *a, **k):
        pass


def as_stls(path, name, ctx):
    """A model brought here as STL parts: itself, or what mesh's convert makes of a 3MF, STEP, OBJ, .blend... Each
    (path, name, colour or None)."""
    ext = os.path.splitext(path)[1].lower()
    if ext not in STL_EXTS + CONVERT_EXTS:
        ext = sniff(path)
    if ext in STL_EXTS:
        return [(path, name, None)]
    if ctx is not None:
        ctx.progress(f"Converting {name} to STL")
    out = mesh.convert(path, ctx or _Quiet(), objects="each", show=False).structured or {}
    files = out.get("files") or []
    if not files:
        raise RuntimeError(f"couldn't turn {name} into STL")
    res = []
    for k, f in enumerate(files):
        dest = os.path.join(os.path.dirname(path), f"{os.path.splitext(name)[0]}-{k}.stl")
        shutil.copyfile(f["file"], dest)
        res.append((dest, f.get("name") or f"{name}-{k}", f.get("color")))
    return res


def look_dir():
    """The printed-look shader's folder, and where it came from."""
    return os.path.join(HERE, "look"), "look/printed_material.py"


# ---------------------------------------------------------------------------------------------------------------
# reading what was asked


def parse_size(size):
    if size is None:
        return [1600, 1200]
    if isinstance(size, (list, tuple)):
        w, h = int(size[0]), int(size[1])
    else:
        m = re.fullmatch(r"\s*(\d+)\s*[x×*, ]\s*(\d+)\s*", str(size))
        if not m:
            named = {"square": (1400, 1400), "portrait": (1200, 1500), "wide": (1920, 1080), "4k": (3840, 2160),
                     "landscape": (1600, 1200)}
            if str(size).lower() in named:
                return list(named[str(size).lower()])
            raise ValueError(f"size {size!r}: like \"1600x1200\", square, portrait, wide or landscape")
        w, h = int(m.group(1)), int(m.group(2))
    if not (64 <= w <= 6000 and 64 <= h <= 6000):
        raise ValueError("size: each side 64 to 6000 px")
    return [w, h]


def as_list(x):
    if x is None:
        return []
    return list(x) if isinstance(x, (list, tuple)) else [x]


def gather_parts(files, material, color, finish, layer_mm, print_up, folder, ctx):
    """Every part to render as {path, name, material, color, ...}, and the notes on where they came from."""
    parts, notes = [], []
    os.makedirs(folder, exist_ok=True)
    for f in as_list(files):
        spec = dict(f) if isinstance(f, dict) else {"file": f}
        src = spec.pop("file", None) or spec.pop("path", None)
        if not src:
            raise ValueError("each file needs file (a path or URL)")
        path = bring(src, folder)
        label = spec.pop("name", None) or os.path.splitext(os.path.basename(str(src)))[0]
        for p, nm, col in as_stls(path, os.path.basename(path), ctx):
            part = {"path": p, "name": label if nm == os.path.basename(path) else nm}
            part.update({k: v for k, v in spec.items() if v is not None})
            if col and not spec.get("color") and not color:
                part["color"] = col
            parts.append(part)
    if not parts:
        raise ValueError("give files (paths or URLs)")
    seen = {}
    for p in parts:  # names must be unique: they're how each part's stats come back
        base = safe_name(p["name"], "part")[:60]
        seen[base] = seen.get(base, 0) + 1
        p["name"] = base if seen[base] == 1 else f"{base}-{seen[base]}"
        p.setdefault("material", material)
        p["material"] = p.get("material") or material or "pla"
        p["color"] = p.get("color") or color or "grey"
        if finish and not p.get("finish"):
            p["finish"] = finish
        if layer_mm and not p.get("layer_mm"):
            p["layer_mm"] = layer_mm
        if print_up and not p.get("print_up"):
            p["print_up"] = print_up
    return parts, notes


def gather_props(on, folder, ctx):
    props = []
    for p in as_list(on):
        if isinstance(p, str):
            kind = p.strip().lower()
            if kind in ("jar", "candle", "candle jar"):
                props.append({"kind": "jar"})
            elif kind.startswith("iphone") or kind == "phone":
                props.append({"kind": "phone", **({"model": kind} if kind.startswith("iphone") else {})})
            else:  # a path or URL of a model file
                props.append(file_prop({"file": p}, folder, ctx))
            continue
        p = dict(p)
        kind = (p.get("kind") or ("file" if p.get("file") else "")).lower()
        if kind in ("jar", "candle"):
            p["kind"] = "jar"
            props.append(p)
        elif kind == "phone":
            props.append(p)
        elif kind == "file" or p.get("file"):
            props.append(file_prop(p, folder, ctx))
        else:
            raise ValueError(f"on: jar, phone, or a model file ({p})")
    return props


def file_prop(p, folder, ctx):
    src = p.get("file") or p.get("path")
    path = bring(src, os.path.join(folder, "props"))
    stls = as_stls(path, os.path.basename(path), ctx)
    out = {k: v for k, v in p.items() if k != "file"}
    out.update({"kind": "file", "path": stls[0][0], "name": p.get("name") or os.path.splitext(os.path.basename(
        str(src)))[0], "material": p.get("material") or "plastic"})
    if len(stls) > 1:
        out["note"] = f"used the first of its {len(stls)} parts"
    return out


# ---------------------------------------------------------------------------------------------------------------
# running Blender


def run_blender(job_path, ctx, timeout=1500):
    """scene.py on one job, its progress passed on; result.json's contents."""
    cmd = ["nice", "-n", "5", blender(), "-b", "--factory-startup", "-t", "4", "-P", os.path.join(HERE, "scene.py"), "--",
           job_path]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    tail, last_sample = [], 0.0
    deadline = time.time() + timeout
    killer = threading.Timer(timeout, p.kill)
    killer.start()
    try:
        for line in p.stdout:
            line = line.rstrip()
            tail = (tail + [line])[-60:]
            if line.startswith("RENDER: ") and ctx is not None:
                ctx.progress(line[8:])
            elif "Sample " in line and ctx is not None and time.time() - last_sample > 8:
                m = re.search(r"Sample (\d+)/(\d+)", line)
                if m:
                    last_sample = time.time()
                    ctx.progress(f"sample {m.group(1)} of {m.group(2)}")
            if ctx is not None and ctx.cancelled.is_set():
                p.kill()
                raise RuntimeError("the asker gave up; the render was stopped")
        p.wait()
    finally:
        killer.cancel()
        p.stdout.close()
    if time.time() > deadline:
        raise RuntimeError(f"Blender took longer than {timeout}s and was stopped")
    res_path = os.path.join(os.path.dirname(job_path), "result.json")
    if not os.path.exists(res_path):
        raise RuntimeError("Blender stopped without an answer: " + " | ".join(
            l for l in tail if l and "Sample" not in l and "Fra:" not in l)[-1200:])
    with open(res_path) as f:
        res = json.load(f)
    if not res.get("ok"):
        raise RuntimeError(f"the scene failed: {res.get('error')}\n{res.get('traceback', '')[-1500:]}")
    return res


def ai_pass(shot, parts, props, scene, look, describe, model, ctx):
    """The AI print-look edit on one shot, and a side by side with the render to check it against."""
    script = os.path.join(look, "ai_print_look.py")
    out = shot["png"].replace(".png", "-ai.png")
    mats = sorted({str(p.get("material") or "pla").lower() for p in parts})
    preset = {"abs": "asa", "matte": "pla_matte", "pla matte": "pla_matte", "silk pla": "silk"}.get(mats[0], mats[0])
    if preset not in ("pla_matte", "pla", "petg", "silk", "asa", "asa_smoothed"):
        preset = "pla_matte"
    part = describe or " and ".join(f"the {p.get('color')} {p.get('material', '').upper()} {p['name']}" for p in parts)
    keep = {"desk": "the oak desk and the wall", "table": "the stone table and the wall", "studio": "the grey backdrop",
            "dark": "the dark backdrop", "cutout": "the white background and the soft shadow",
            "wall": "the plaster wall"}.get(scene, "the background")
    prop_words = {"jar": "the glass jar, the wax and the wicks", "phone": "the phone", "file": "the other objects"}
    keep = ", ".join([prop_words.get(p.get("kind"), "the other objects") for p in props] + [keep])
    cmd = [sys.executable, script, shot["png"], out, "--part", part, "--material", preset, "--keep", keep]
    if model:
        cmd += ["--model", model]
    if ctx is not None:
        ctx.progress(f"AI print-look pass on {shot['name']}")
    gateway = key("ai-gateway")
    if not gateway:
        raise ValueError("ai_look needs the AI Gateway key: connect it in Switch's connections")
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=300, env={**os.environ, "AI_GATEWAY_API_KEY": gateway})
    if p.returncode != 0 or not os.path.exists(out):
        raise RuntimeError(f"the AI pass failed: {(p.stderr or p.stdout).strip()[-600:]}")
    cost = re.search(r"\$\s?([0-9.]+)", p.stdout + p.stderr)
    return out, (float(cost.group(1)) if cost else None)


def compose(images, out, labels=None):
    """A side by side of pictures through scene.py's sheet maker (Blender's OpenImageIO): for checking an AI pass."""
    job = os.path.join(os.path.dirname(out), "compose.json")
    with open(job, "w") as f:
        json.dump({"compose": images, "out": out, "labels": labels or []}, f)
    subprocess.run([blender(), "-b", "--factory-startup", "-P", os.path.join(HERE, "scene.py"), "--", job],
                   capture_output=True, timeout=180)
    return out if os.path.exists(out) else None


# ---------------------------------------------------------------------------------------------------------------
# the tools


@app.tool(schema=RENDER_SCHEMA)
def render(ctx, files: list = None, material: str = None, color: str = None,
           finish: str = None, scene: str = "desk", on: list = None, place: dict = None, assembly: bool = False,
           arrange: str = None, shots: list = None, size: str = None, preview: bool = False, samples: int = None,
           exposure: str = "auto", light: float = None, dof: bool = True, layer_mm: float = None, print_up: list = None,
           ai_look: bool = False, describe: str = None, ai_model: str = None, save_to: str = None, about: list = None,
           show: int = 4):
    """Render a 3D model photoreal in a standard scene, in one call: Cycles on this machine's GPU, the
    printed-plastic shader on printed parts, each shot framed to fit and checked, the exposure metered on the part.

    files: the model's parts, each a path, https URL, or {file, name, material, color, finish, layer_mm, print_up,
    rotate [x,y,z] deg, offset [x,y,z] mm}. STL as is; 3MF, STEP, OBJ, PLY, .blend, glTF, FBX, USD go through convert
    (a .blend or GLB splits by colour, each part keeping its colour).
    material, color: for every part that doesn't say (scenes lists them; color is a name or #rrggbb).
    scene: desk (default), table, studio, dark, cutout, wall.
    on: what it sits on or goes with: "jar", "phone" (or "iphone-15-pro"...), a model file, or {kind: jar, diameter,
    height, fill, wax, glass, wicks}, {kind: phone, model, face, color}, {file, material, color, rotate, offset}.
    place: {mode: drop (default: centred over the prop and lowered until it rests on it, or on the desk) | as_is (the
    files' own coordinates: the model and a file prop as an assembly) | wall, down: the side on the desk ("z-" as
    printed, "z+", "y-"...), rotate [x,y,z] deg, spin (deg about the vertical), at [x,y] mm off the prop's centre, on:
    "camera" (a phone's camera module), against: the face on the wall}. assembly: true is place.mode as_is.
    arrange: "row" sets the parts side by side on the desk instead of where their files put them.
    shots: names (hero, close, detail, front, side, left, back, back_hero, low, top) or {name, view, azimuth,
    elevation, lens, around [x,y,z] model mm, radius mm, fstop, dof, margin}; default hero, plus close with a prop.
    size: "1600x1200" (default), square, portrait, wide, or WxH. preview: half size, 32 samples, ~10 s a shot: frame
    it with this first. samples: default 160. exposure: auto (metered on the part) or EV. light: a multiplier on the
    lights. dof: depth of field (default on: the model sharp through, the background soft).
    ai_look: an AI print-look pass on the shots (true, or a list of shot names), with a side by side to check it:
    $0.05-0.14 each. describe: the part in words for it. save_to: also put the pictures in this folder."""
    state["calls"] += 1
    t0 = time.time()
    job_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    folder = os.path.join(JOBS_DIR, job_id)
    os.makedirs(folder, exist_ok=True)
    try:
        scene = (scene or "desk").lower()
        if scene not in SCENES:
            raise ValueError(f"scene {scene!r}: one of {', '.join(SCENES)}")
        wh = parse_size(size)
        parts, notes = gather_parts(files, material, color, finish, layer_mm, print_up, os.path.join(folder, "in"), ctx)
        props = gather_props(on, folder, ctx)
        place = dict(place or {})
        if assembly:
            place["mode"] = "as_is"
        shot_list = as_list(shots) or None
        look, look_from = look_dir()
        job = {"out_dir": os.path.join(folder, "out"), "scene": scene, "parts": parts, "props": props, "place": place,
               "arrange": arrange, "shots": shot_list, "size": wh, "preview": bool(preview), "samples": samples,
               "exposure": exposure if exposure not in (None, "") else "auto", "light": light, "dof": dof,
               "look_dir": look}
        job_path = os.path.join(folder, "job.json")
        with open(job_path, "w") as f:
            json.dump(job, f, indent=1)
        if LOCK.locked() and ctx is not None:
            ctx.progress(f"Waiting for the render before it ({state['busy']})")
        with LOCK:
            state["busy"] = f"{job_id}, since {time.strftime('%H:%M:%S')}"
            try:
                res = run_blender(job_path, ctx)
            finally:
                state["busy"] = None
        ai_shots = []
        if ai_look:
            want = set(as_list(ai_look)) if not isinstance(ai_look, bool) else {s["name"] for s in res["shots"]}
            for s in res["shots"]:
                if s["name"] in want:
                    out, cost = ai_pass(s, parts, props, scene, look, describe, ai_model, ctx)
                    side = compose([s["png"], out], out.replace("-ai.png", "-ai-check.jpg"), ["render", "AI pass"])
                    s["ai"] = {"png": out, "check": side, "cost_usd": cost}
                    ai_shots.append(s["name"])
        sheet = res.get("sheet")
        saved = save_pictures(res, save_to) if save_to else None
        res["notes"] = notes + res.get("notes", [])
        state["renders"] += 1
        state["shots"] += len(res["shots"])
        state["last_render"] = {"id": job_id, "at": int(time.time() * 1000), "seconds": round(time.time() - t0, 1),
                                "shots": len(res["shots"]), "scene": scene}
        record(job_id, res, parts, props, scene, sheet, about, preview)
        return answer(job_id, res, parts, props, scene, sheet, saved, look_from, preview, show, ai_shots,
                      round(time.time() - t0, 1))
    except Exception as e:
        state["failed"] += 1
        state["last_error"] = f"{type(e).__name__}: {e}"[:600]
        raise


def save_pictures(res, save_to):
    folder = os.path.abspath(os.path.expanduser(save_to))
    os.makedirs(folder, exist_ok=True)
    saved = []
    for s in res["shots"]:
        for src, name in ((s.get("jpg"), s["name"] + ".jpg"), (s.get("png"), s["name"] + ".png"),
                          ((s.get("ai") or {}).get("png"), s["name"] + "-ai.png")):
            if src and os.path.exists(src):
                shutil.copyfile(src, os.path.join(folder, name))
                saved.append(os.path.join(folder, name))
    return {"paths": saved}


def record(job_id, res, parts, props, scene, sheet, about, preview):
    with contextlib.suppress(Exception):
        names = ", ".join(p["name"] for p in parts)
        on = " on " + ", ".join(p.get("kind") if p.get("kind") != "file" else p.get("name", "a model")
                                for p in props) if props else ""
        app.emit("render", {"entity": f"render:{job_id}", "summary": f"Rendered {names}{on} ({scene}, "
                            f"{len(res['shots'])} shot{'s' * (len(res['shots']) != 1)}{', preview' if preview else ''})",
                            "facts": {"parts": [{k: p.get(k) for k in ("name", "material", "color")} for p in parts],
                                      "props": res.get("props"), "scene": scene, "preview": preview,
                                      "shots": [{"name": s["name"], "jpg": s.get("jpg"), "png": s.get("png"),
                                                 "ai": (s.get("ai") or {}).get("png"), "camera": s.get("camera")}
                                                for s in res["shots"]], "sheet": sheet,
                                      "seconds": res.get("timing", {}).get("total_s")}},
                 about=list(about or []) + [f"render:{job_id}"])


def answer(job_id, res, parts, props, scene, sheet, saved, look_from, preview, show, ai_shots, seconds):
    lines = []
    m = res.get("model") or {}
    lines.append(f"Rendered {', '.join(p['name'] for p in parts)} ({' x '.join(str(x) for x in m.get('size_mm', []))} "
                 f"mm) in the {scene} scene, resting on {m.get('rests_on')}: {len(res['shots'])} shot"
                 f"{'s' * (len(res['shots']) != 1)}{' (preview: half size, few samples)' if preview else ''} in "
                 f"{seconds:.0f} s on {res.get('device', 'the GPU')}.")
    for p in res.get("props") or []:
        if p.get("kind") == "jar":
            lines.append(f"Jar: {p['diameter_mm']} mm across the rim, {p['height_mm']} mm tall, wax to {p['wax_mm']} mm"
                         + (f" ({p['note']})" if p.get("note") else "") + ".")
        elif p.get("kind") == "phone":
            lines.append(f"Phone: {p['model']}, {p['face']}, {' x '.join(str(x) for x in p['size_mm'])} mm.")
        elif p.get("kind") == "wicks":
            lines.append(f"Wicks: {p['count']} at {p['at_mm']} mm.")
        elif p.get("kind") == "file":
            lines.append(f"{p['name']}: {p['material']}, {' x '.join(str(x) for x in p['size_mm'])} mm.")
    if res.get("exposure_ev"):
        lines.append(f"Exposure {res['exposure_ev']:+.2f} EV (metered on the part).")
    for s in res["shots"]:
        st = (s.get("stats") or {})
        fill = (st.get("_model") or {}).get("coverage")
        cam = s.get("camera") or {}
        lines.append(f"- {s['name']}: {cam.get('lens_mm')} mm lens at {cam.get('distance_mm')} mm, f/{cam.get('fstop')}"
                     + (f", the model fills {fill:.0%} of the frame" if fill is not None else "")
                     + (f"; {'; '.join(s['warnings'])}" if s.get("warnings") else "")
                     + (f"; AI pass ${s['ai']['cost_usd']}" if s.get("ai", {}).get("cost_usd") else "")
                     + f" ({s['seconds']:.0f} s)")
    for n in res.get("notes") or []:
        lines.append(f"Note: {n}")
    if ai_shots:
        lines.append("AI pass: check each against its render (the -ai-check side by side: silhouette, holes, text, "
                     "colours) before using it; regenerate if anything major moved.")
    if saved:
        lines.append(f"Saved: {', '.join(saved['paths'])}")
    lines.append(f"Shader: {look_from}.")
    content = [sbmcp.text("\n".join(lines))]
    shown = 0
    for s in res["shots"]:
        if shown >= (show if show is not None else 4):
            break
        content.append(sbmcp.image(s["jpg"], "image/jpeg"))
        shown += 1
        if s.get("ai", {}).get("check") and shown < show:
            content.append(sbmcp.image(s["ai"]["check"], "image/jpeg"))
            shown += 1
    shots = []
    for s in res["shots"]:
        shots.append({"name": s["name"], "jpg": s.get("jpg"), "png": s.get("png"),
                      "camera": s.get("camera"), "warnings": s.get("warnings"),
                      "fill": ((s.get("stats") or {}).get("_model") or {}).get("coverage"),
                      "parts": {k: v for k, v in (s.get("stats") or {}).items() if k != "_model"},
                      **({"ai": {k: v for k, v in s["ai"].items() if k in ("png", "check", "cost_usd")}}
                         if s.get("ai") else {})})
    structured = {"summary": "\n".join(lines), "id": f"render:{job_id}", "scene": scene, "model": res.get("model"), "props": res.get("props"),
                  "shots": shots, "sheet": sheet, "exposure_ev": res.get("exposure_ev"), "notes": res.get("notes"),
                  "warnings": res.get("warnings"), "seconds": seconds, "folder": os.path.dirname(res["shots"][0]["png"])
                  if res["shots"] else None, "saved": saved}
    return sbmcp.content(*content, structured=structured)


@app.tool(name="render_scenes", read_only=True)
def scenes():
    "What render can do: its scenes, props, shots and materials, each with what it is and takes."
    return {"scenes": SCENES, "props": PROPS, "shots": SHOT_NAMES, "materials": MATERIALS,
            "colors": "a name (black, white, grey, light grey, dark grey, silver, red, orange, yellow, gold, green, "
                      "teal, blue, light blue, navy, purple, pink, brown, tan, beige, ivory, natural, clear...) or "
                      "#rrggbb",
            "coordinates": "mm; z up; the desk is z = 0; the camera's azimuth is from the front, + toward +x; a detail "
                           "shot's around is in the model's own coordinates, as mesh's report gives them",
            "times": "on an M4 Mac: a preview ~10 s a shot, the full 1600x1200 at 160 samples ~40-60 s a shot "
                     "(a glass jar ~60 s), plus ~10 s to build and meter"}


def blender_version():
    try:
        p = subprocess.run([blender(), "--version"], capture_output=True, text=True, timeout=60)
        return (p.stdout.splitlines() or ["?"])[0].strip()
    except Exception as e:  # noqa: BLE001
        return f"not runnable: {e}"


def health():
    """How render itself is: Blender's version, the renders it made and failed, its last error, what it keeps on disk."""
    v = blender_version()
    look, look_from = look_dir()
    jobs = sorted(os.listdir(JOBS_DIR)) if os.path.isdir(JOBS_DIR) else []
    size = 0
    for root, _, fs in os.walk(JOBS_DIR):
        for f in fs:
            with contextlib.suppress(OSError):
                size += os.path.getsize(os.path.join(root, f))
    du = shutil.disk_usage(HOME)
    problems = []
    if not v.startswith("Blender"):
        problems.append(f"Blender isn't runnable at {blender()}")
    ai_key = bool(key("ai-gateway"))
    if not ai_key:
        problems.append("no AI Gateway key: ai_look can't run")
    return {"ok": not [p for p in problems if "Blender" in p], "blender": v, "shader": look_from,
            "ai_key": ai_key, "jobs_kept": len(jobs),
            "jobs_mb": round(size / 1e6, 1), "disk_free_gb": round(du.free / 1e9, 1), "problems": problems,
            **{k: state[k] for k in ("started_at", "calls", "renders", "shots", "failed", "last_error", "last_render",
                                      "busy")}}


def sweep():
    """Job folders past KEEP_DAYS go."""
    if not os.path.isdir(JOBS_DIR):
        return
    for d in os.listdir(JOBS_DIR):
        p = os.path.join(JOBS_DIR, d)
        with contextlib.suppress(OSError):
            if time.time() - os.path.getmtime(p) > KEEP_DAYS * 86400:
                shutil.rmtree(p, ignore_errors=True)


def heartbeat():
    """Says how it is."""
    f = health()
    last = f.get("last_render") or {}
    summary = (("Ready" if f["ok"] else "Can't render: " + "; ".join(f["problems"]))
               + f": {f['blender']}, {f['renders']} renders ({f['shots']} shots), {f['failed']} failed"
               + (f", last {last.get('scene')} in {last.get('seconds')} s" if last else "")
               + (f"; last error: {f['last_error']}" if f.get("last_error") else ""))
    facts = dict(f)
    facts.pop("last_error", None) if not f.get("last_error") else None
    # What's wrong now: render can't run. A render that failed was its caller's answer (its error went back with
    # it), not the sense failing; it stays in last_error and the summary.
    facts["failing"] = "; ".join(p for p in f["problems"] if "Blender" in p) or None
    app.emit("heartbeat", {"entity": f"sense:{NAME}", "summary": summary, "facts": facts}, about=[f"sense:{NAME}"])


@app.background
def beat():
    while True:
        with contextlib.suppress(Exception):
            sweep()
        heartbeat()
        time.sleep(HEARTBEAT_S)
