"""render's Blender side: builds one job's scene from its job.json and renders its shots.

    blender -b --factory-startup -P scene.py -- job.json

Everything is in metres; models come in as STL in millimetres (main.py turns 3MF, STEP, OBJ and PLY into STL first,
through mesh's convert). The ground (desk, table, floor) is z = 0, the backdrop is behind at +Y, and a camera's
azimuth is measured from the front (-Y), positive toward the right (+X).

Lines it prints that start with "RENDER:" are progress for main.py to pass on; the outcome goes to result.json beside
the job, and every image into its out_dir. Lessons from the renders done by hand are built in: lights placed and
powered by the size of what's framed (a 100 mm part under lights meant for 1 m blows black ASA out to white), the
camera's near clip set from its distance (Blender's default 100 mm clips close-ups), a grazing light so layer lines
show, AgX, and the printed-plastic shader (look/printed_material.py) on every printed part.
"""

import json
import math
import os
import sys
import time

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector
from mathutils.bvhtree import BVHTree

ARGV = sys.argv[sys.argv.index("--") + 1:]
JOB_PATH = os.path.abspath(ARGV[0])
JOB = json.load(open(JOB_PATH))
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = JOB.get("out_dir") or os.path.dirname(os.path.abspath(JOB.get("out", JOB_PATH)))
MM = 0.001
T0 = time.time()
RESULT = {"shots": [], "warnings": [], "notes": [], "parts": [], "props": [], "timing": {}}
os.makedirs(OUT, exist_ok=True)
sys.path.insert(0, JOB.get("look_dir") or os.path.join(HERE, "look"))


def say(msg):
    print("RENDER:", msg, flush=True)


def warn(msg):
    RESULT["warnings"].append(msg)
    say("warning: " + msg)


def note(msg):
    RESULT["notes"].append(msg)


bpy.ops.wm.read_factory_settings(use_empty=True)
import printed_material as PM  # noqa: E402  (after the factory reset, which would drop its handler)

SC = bpy.context.scene
MATS = {}

# ---------------------------------------------------------------------------------------------------------------
# colours and materials

COLORS = {
    "black": "#161617", "white": "#f1efe9", "grey": "#8b8e92", "gray": "#8b8e92", "light grey": "#c3c5c8",
    "light gray": "#c3c5c8", "dark grey": "#45484c", "dark gray": "#45484c", "silver": "#b9bcc1", "red": "#b3202a",
    "dark red": "#7d1a22", "orange": "#e2681c", "yellow": "#f0c21a", "gold": "#c79a32", "green": "#2f7d3a",
    "dark green": "#1f4d2b", "olive": "#6b6b3a", "mint": "#9fd8c0", "teal": "#1f7a78", "blue": "#1f4fa3",
    "light blue": "#7fb2e0", "navy": "#1d2a4a", "purple": "#5b3a8c", "lavender": "#b6a3d9", "pink": "#e88aa8",
    "magenta": "#b02a78", "brown": "#6b4a2f", "tan": "#c9a978", "beige": "#d9c8a7", "ivory": "#ece3cc",
    "cream": "#efe6cf", "bone": "#e3d9c2", "wood": "#a8784a", "natural": "#e9e4d6", "transparent": "#e8eef0",
    "clear": "#e8eef0", "glow": "#d6efc2", "copper": "#b06a3c", "bronze": "#8c6a3a", "skin": "#e0b89a",
}

PRINTED = {"pla": "pla", "pla_matte": "pla_matte", "matte": "pla_matte", "matte pla": "pla_matte", "pla matte": "pla_matte",
           "petg": "petg", "silk": "silk", "silk pla": "silk", "asa": "asa", "abs": "asa", "asa_smoothed": "asa_smoothed",
           "smoothed asa": "asa_smoothed", "vapor smoothed asa": "asa_smoothed", "tpu": "pla_matte", "nylon": "pla_matte",
           "pa": "pla_matte", "cf": "asa", "pla-cf": "asa", "petg-cf": "asa", "pc": "petg"}
"""FDM materials, by name, as the printed shader's presets."""

PLAIN = ("resin", "glass", "frosted glass", "aluminum", "anodized", "steel", "chrome", "brass", "gold", "silver",
         "sterling", "copper", "wood", "rubber", "wax", "cotton", "ceramic", "paper", "plastic", "screen", "concrete",
         "leather", "fabric", "emission")


def srgb(c, alpha=1.0):
    if isinstance(c, (list, tuple)):
        return list(c[:3]) + [alpha]
    return PM.srgb(color_hex(c), alpha)


def color_hex(c):
    c = str(c or "").strip().lower()
    if c in COLORS:
        return COLORS[c]
    if not c.startswith("#"):
        c = "#" + c
    if len(c) == 4:
        c = "#" + "".join(ch * 2 for ch in c[1:])
    int(c[1:7], 16)
    return c[:7]


def luma_of(hex_color):
    r, g, b = (int(color_hex(hex_color)[i:i + 2], 16) / 255 for i in (1, 3, 5))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def new_material(name):
    m = bpy.data.materials.new(name)
    if bpy.app.version < (5, 0, 0):
        m.use_nodes = True
    nt = m.node_tree
    b = next(n for n in nt.nodes if n.bl_idname == "ShaderNodeBsdfPrincipled")
    return m, nt, b


def set_in(b, **vals):
    for k, v in vals.items():
        key = k.replace("_", " ")
        if key in b.inputs:
            b.inputs[key].default_value = v


def object_mm_coords(nt, scale=1.0):
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (scale, scale, scale)
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    return mp.outputs[0]


def bump_noise(nt, b, scale, strength, distance=0.0001, detail=4.0):
    n = nt.nodes.new("ShaderNodeTexNoise")
    n.inputs["Scale"].default_value = scale
    n.inputs["Detail"].default_value = detail
    bp = nt.nodes.new("ShaderNodeBump")
    bp.inputs["Strength"].default_value = strength
    bp.inputs["Distance"].default_value = distance
    nt.links.new(n.outputs["Fac"], bp.inputs["Height"])
    nt.links.new(bp.outputs[0], b.inputs["Normal"])
    return n


def plain_material(kind, color=None, name=None):
    """A material that isn't printed plastic: for props, and for parts that are something else."""
    kind = (kind or "plastic").lower()
    key = name or f"{kind}-{color}"
    if key in MATS:
        return MATS[key]
    m, nt, b = new_material(key)
    col = srgb(color) if color else None
    if kind in ("glass", "frosted glass"):
        set_in(b, Base_Color=col or srgb("#f4f7f4"), Roughness=0.25 if kind == "frosted glass" else 0.01,
               Transmission_Weight=1.0, IOR=1.5)
    elif kind == "resin":
        set_in(b, Base_Color=col or srgb("#d9d6cf"), Roughness=0.32, Specular_IOR_Level=0.45, Subsurface_Weight=0.08,
               Subsurface_Scale=0.002)
    elif kind in ("aluminum", "anodized"):
        set_in(b, Base_Color=col or srgb("#c9ccd0"), Metallic=1.0, Roughness=0.3 if kind == "aluminum" else 0.38,
               Anisotropic=0.4)
        bump_noise(nt, b, 900, 0.03)
    elif kind == "steel":
        set_in(b, Base_Color=col or srgb("#b8bbbf"), Metallic=1.0, Roughness=0.24)
    elif kind == "chrome":
        set_in(b, Base_Color=col or srgb("#e6e8ea"), Metallic=1.0, Roughness=0.04)
    elif kind == "brass":
        set_in(b, Base_Color=col or srgb("#d1a54a"), Metallic=1.0, Roughness=0.2)
    elif kind == "gold":
        set_in(b, Base_Color=col or srgb("#f2c060"), Metallic=1.0, Roughness=0.14)
    elif kind in ("silver", "sterling"):
        set_in(b, Base_Color=col or srgb("#e8e8e6"), Metallic=1.0, Roughness=0.12)
    elif kind == "copper":
        set_in(b, Base_Color=col or srgb("#d08a5e"), Metallic=1.0, Roughness=0.18)
    elif kind == "rubber":
        set_in(b, Base_Color=col or srgb("#1b1b1c"), Roughness=0.85, Specular_IOR_Level=0.3)
        bump_noise(nt, b, 1500, 0.05)
    elif kind == "wax":
        set_in(b, Base_Color=col or srgb("#efe3c9"), Roughness=0.42, Subsurface_Weight=0.85, Subsurface_Scale=0.004,
               Specular_IOR_Level=0.35)
        b.inputs["Subsurface Radius"].default_value = (1.0, 0.85, 0.6)
        bump_noise(nt, b, 180, 0.08, 0.0002, 2.0)
    elif kind == "cotton":
        set_in(b, Base_Color=col or srgb("#d8ccb0"), Roughness=1.0, Sheen_Weight=0.6, Sheen_Roughness=0.5)
        bump_noise(nt, b, 3000, 0.4, 0.0002)
    elif kind == "ceramic":
        set_in(b, Base_Color=col or srgb("#efece4"), Roughness=0.12, Coat_Weight=0.6)
    elif kind == "paper":
        set_in(b, Base_Color=col or srgb("#efede6"), Roughness=0.9, Specular_IOR_Level=0.2)
    elif kind == "screen":
        set_in(b, Base_Color=srgb("#050607"), Roughness=0.03, Coat_Weight=1.0)
    elif kind == "concrete":
        set_in(b, Base_Color=col or srgb("#9a9894"), Roughness=0.85)
        bump_noise(nt, b, 120, 0.15, 0.0005, 8.0)
    elif kind == "leather":
        set_in(b, Base_Color=col or srgb("#5a3a26"), Roughness=0.55)
        bump_noise(nt, b, 2500, 0.2)
    elif kind == "fabric":
        set_in(b, Base_Color=col or srgb("#6d6f73"), Roughness=0.95, Sheen_Weight=0.5)
        bump_noise(nt, b, 2200, 0.25)
    elif kind == "wood":
        wood_material(m, nt, b, col)
    elif kind == "emission":
        set_in(b, Base_Color=srgb("#000000"), Emission_Color=col or srgb("#ffffff"), Emission_Strength=3.0)
    else:  # injection-molded plastic: what CAD looks like, smooth and a little glossy
        set_in(b, Base_Color=col or srgb("#8b8e92"), Roughness=0.32, Specular_IOR_Level=0.5)
    MATS[key] = m
    return m


def wood_material(m, nt, b, col=None):
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (60, 6, 6)
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    wave = nt.nodes.new("ShaderNodeTexWave")
    wave.wave_type, wave.bands_direction = "RINGS", "X"
    wave.inputs["Scale"].default_value = 4
    wave.inputs["Distortion"].default_value = 6
    wave.inputs["Detail"].default_value = 4
    nt.links.new(mp.outputs[0], wave.inputs["Vector"])
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    base = col or srgb("#a8784a")
    mix.inputs["A"].default_value = base
    mix.inputs["B"].default_value = [x * 0.6 for x in base[:3]] + [1]
    nt.links.new(wave.outputs["Fac"], mix.inputs["Factor"])
    nt.links.new(mix.outputs[2], b.inputs["Base Color"])
    set_in(b, Roughness=0.55)


def part_material(obj, spec):
    """A part's material: printed plastic through the printed shader (layer lines along its print axis), or a plain one."""
    material = str(spec.get("material") or "pla").lower().strip()
    color = spec.get("color") or "grey"
    finish = (spec.get("finish") or "printed").lower()
    preset = PRINTED.get(material)
    if preset and finish != "smooth":
        kw = {}
        for k in ("seam_deg", "edge_mm", "line_mm", "bed"):
            if spec.get(k) is not None:
                kw[k] = spec[k]
        kw.update({k: v for k, v in (spec.get("shader") or {}).items()})
        PM.apply_printed_material(obj, preset, color_hex(color), layer_mm=float(spec.get("layer_mm") or 0.2),
                                  print_up=tuple(spec.get("print_up") or (0, 0, 1)), mm_per_unit=1000, **kw)
        return preset
    if preset:  # smooth: the same plastic without the printed surface (the CAD look)
        m = plain_material("plastic", color, name=f"smooth-{material}-{color}")
        b = m.node_tree.nodes["Principled BSDF"]
        set_in(b, Roughness=PM.PRESETS[preset]["roughness"], Specular_IOR_Level=PM.PRESETS[preset]["specular"])
        assign(obj, m)
        return f"{material} (smooth)"
    assign(obj, plain_material(material, color))
    return material


def assign(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)


# ---------------------------------------------------------------------------------------------------------------
# geometry helpers


def link(obj):
    SC.collection.objects.link(obj)
    return obj


def mesh_object(name, verts, faces, smooth=True):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
    me.validate()
    me.update()
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
    return link(bpy.data.objects.new(name, me))


def lathe(name, profile, steps=192):
    """Revolve (r, z) points (metres) around Z into a closed mesh."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    verts = [bm.verts.new((r, 0, z)) for r, z in profile]
    for a, b in zip(verts, verts[1:]):
        bm.edges.new((a, b))
    bmesh.ops.spin(bm, geom=bm.verts[:] + bm.edges[:], cent=(0, 0, 0), axis=(0, 0, 1), angle=math.tau, steps=steps,
                   use_merge=True)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-7)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    return link(bpy.data.objects.new(name, me))


def rounded_rect(w, h, r, n=10):
    pts = []
    r = min(r, w / 2 - 1e-6, h / 2 - 1e-6)
    for cx, cy, a0 in ((w / 2 - r, h / 2 - r, 0), (-w / 2 + r, h / 2 - r, 90), (-w / 2 + r, -h / 2 + r, 180),
                       (w / 2 - r, -h / 2 + r, 270)):
        for i in range(n + 1):
            a = math.radians(a0 + 90 * i / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def extrude(name, outline, z0, z1, bevel_m=0.0):
    """A prism of a CCW outline (metres) from z0 to z1, its edges rounded by bevel_m."""
    n = len(outline)
    verts = [(x, y, z0) for x, y in outline] + [(x, y, z1) for x, y in outline]
    faces = [tuple(reversed(range(n))), tuple(range(n, 2 * n))]
    faces += [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    o = mesh_object(name, verts, faces, smooth=False)
    if bevel_m > 0:
        mod = o.modifiers.new("bevel", "BEVEL")
        mod.width, mod.segments, mod.limit_method = bevel_m, 3, "ANGLE"
        mod.angle_limit = math.radians(40)
        wn = o.modifiers.new("normals", "WEIGHTED_NORMAL")
        wn.keep_sharp = True
    return o


def cylinder(name, r, z0, z1, n=64, x=0.0, y=0.0):
    verts = [(x + r * math.cos(2 * math.pi * i / n), y + r * math.sin(2 * math.pi * i / n), z) for z in (z0, z1)
             for i in range(n)]
    faces = [tuple(reversed(range(n))), tuple(range(n, 2 * n))] + [(i, (i + 1) % n, n + (i + 1) % n, n + i)
                                                                   for i in range(n)]
    o = mesh_object(name, verts, faces)
    o.data.polygons[0].use_smooth = o.data.polygons[1].use_smooth = False
    return o


def world_tris(objs):
    """Every triangle of these objects in world space (metres): (vertices N x 3, triangles M x 3)."""
    dg = bpy.context.evaluated_depsgraph_get()
    vs, ts, off = [], [], 0
    for o in objs:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        me.calc_loop_triangles()
        mw = np.array(o.matrix_world)
        v = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get("co", v)
        v = v.reshape(-1, 3) @ mw[:3, :3].T + mw[:3, 3]
        t = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
        me.loop_triangles.foreach_get("vertices", t)
        vs.append(v)
        ts.append(t.reshape(-1, 3) + off)
        off += len(v)
        ev.to_mesh_clear()
    if not vs:
        return np.zeros((0, 3)), np.zeros((0, 3), dtype=np.int64)
    return np.concatenate(vs), np.concatenate(ts)


def bvh_of(objs):
    v, t = world_tris(objs)
    if not len(t):
        return None
    return BVHTree.FromPolygons([tuple(x) for x in v], [tuple(x) for x in t], all_triangles=True)


def surface_points(objs, n=20000, seed=1):
    """Points over these objects' surfaces (area-weighted), and every vertex, in world space."""
    v, t = world_tris(objs)
    if not len(t):
        return np.zeros((0, 3))
    a, b, c = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
    area = np.linalg.norm(np.cross(b - a, c - a), axis=1) / 2
    if area.sum() <= 0:
        return v
    rng = np.random.default_rng(seed)
    pick = rng.choice(len(t), size=n, p=area / area.sum())
    u, w = rng.random(n), rng.random(n)
    flip = u + w > 1
    u[flip], w[flip] = 1 - u[flip], 1 - w[flip]
    pts = a[pick] + (b[pick] - a[pick]) * u[:, None] + (c[pick] - a[pick]) * w[:, None]
    if len(v) > 40000:
        v = v[rng.choice(len(v), 40000, replace=False)]
    return np.concatenate([pts, v])


def bounds(objs):
    v, _ = world_tris(objs)
    if not len(v):
        return np.zeros(3), np.zeros(3)
    return v.min(axis=0), v.max(axis=0)


# ---------------------------------------------------------------------------------------------------------------
# the model


AXES = {"x+": (1, 0, 0), "x-": (-1, 0, 0), "y+": (0, 1, 0), "y-": (0, -1, 0), "z+": (0, 0, 1), "z-": (0, 0, -1)}


def turn_to(axis, target):
    """The rotation that turns a model axis ("z-", "y+"...) onto a world direction."""
    return Vector(AXES[axis]).rotation_difference(Vector(target)).to_matrix().to_4x4()


def load_parts():
    root = bpy.data.objects.new("model", None)
    link(root)
    parts = []
    for i, spec in enumerate(JOB["parts"]):
        before = set(bpy.data.objects)
        bpy.ops.wm.stl_import(filepath=spec["path"])
        new = [o for o in bpy.data.objects if o not in before and o.type == "MESH"]
        if not new:
            raise RuntimeError(f"{spec['name']}: Blender read no mesh from it")
        o = new[0]
        o.name = spec["name"]
        me = o.data
        me.shade_smooth()
        if hasattr(me, "set_sharp_from_angle"):
            me.set_sharp_from_angle(angle=math.radians(float(spec.get("smooth_deg") or 30)))
        local = Matrix.Identity(4)
        if spec.get("rotate"):
            local = Euler([math.radians(a) for a in spec["rotate"]], "XYZ").to_matrix().to_4x4()
        local = Matrix.Translation(Vector(spec.get("offset") or (0, 0, 0)) * MM) @ local @ Matrix.Scale(MM, 4)
        o.parent = root
        o.matrix_parent_inverse = Matrix.Identity(4)
        o.matrix_basis = local
        o.pass_index = i + 1
        shader = part_material(o, spec)
        parts.append(o)
        RESULT["parts"].append({"name": o.name, "material": shader, "color": spec.get("color"),
                                "triangles": len(me.polygons), "index": i + 1})
    if JOB.get("arrange") == "row" and len(parts) > 1:
        bpy.context.view_layer.update()
        boxes = [bounds([o]) for o in parts]
        gap = 0.25 * max(float(np.max(hi - lo)) for lo, hi in boxes)
        widths = [float(hi[0] - lo[0]) for lo, hi in boxes]
        x = -(sum(widths) + gap * (len(parts) - 1)) / 2
        for o, (lo, hi), w in zip(parts, boxes, widths):
            shift = Vector((x - lo[0], -(lo[1] + hi[1]) / 2, -lo[2]))
            o.matrix_basis = Matrix.Translation(shift) @ o.matrix_basis
            x += w + gap
        bpy.context.view_layer.update()
        note(f"set the {len(parts)} parts side by side")
    return root, parts


def pose_model(root, place):
    """The model's pose as a whole: a side down (or a rotation), then a turn about Z."""
    m = Matrix.Identity(4)
    down = (place.get("down") or "z-").lower()
    if place.get("mode") == "wall":
        against = (place.get("against") or "z-").lower()
        m = turn_to(against, (0, 1, 0))
    elif down != "z-":
        m = turn_to(down, (0, 0, -1))
    if place.get("rotate"):
        m = Euler([math.radians(a) for a in place["rotate"]], "XYZ").to_matrix().to_4x4() @ m
    if place.get("spin"):
        m = Matrix.Rotation(math.radians(place["spin"]), 4, "Z") @ m
    root.matrix_world = m
    bpy.context.view_layer.update()


def move(root, d):
    root.matrix_world = Matrix.Translation(Vector(d)) @ root.matrix_world
    bpy.context.view_layer.update()


def drop(root, parts, supports):
    """Lower the model straight down until it rests on what's under it: a prop's rim, a phone's back, the ground.
    Rays go down from points all over the model and up from points all over what it could rest on, so a flange on
    a jar's rim is found even where neither has a vertex."""
    lo, hi = bounds(parts)
    top = max([bounds(supports)[1][2]] if supports else [0.0])
    move(root, (0, 0, top + 0.001 - lo[2]))
    lo, hi = bounds(parts)
    gap = lo[2]  # to the ground
    rest_on = "the ground"
    sup = bvh_of(supports) if supports else None
    mod = bvh_of(parts)
    if sup is not None:
        for p in surface_points(parts, 20000):
            hit = sup.ray_cast(Vector(p), Vector((0, 0, -1)), gap + 1e-4)
            if hit[0] is not None and hit[3] < gap:
                gap, rest_on = hit[3], "a prop"
        for q in surface_points(supports, 30000, seed=2):
            hit = mod.ray_cast(Vector(q), Vector((0, 0, 1)), gap + 1e-4)
            if hit[0] is not None and hit[3] < gap:
                gap, rest_on = hit[3], "a prop"
    move(root, (0, 0, -gap + 0.00002))
    return rest_on


def fit_bore(parts):
    """The bore a model would sit over a jar with: rays out from its axis in its lowest third. Its radius (m), or None."""
    lo, hi = bounds(parts)
    cx, cy = (lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2
    tree = bvh_of(parts)
    best = None
    for k in range(1, 7):
        z = lo[2] + (hi[2] - lo[2]) * 0.33 * k / 7
        radii = []
        for j in range(32):
            a = 2 * math.pi * j / 32
            d = Vector((math.cos(a), math.sin(a), 0))
            hit = tree.ray_cast(Vector((cx, cy, z)), d, 1.0)
            if hit[0] is not None and hit[1].dot(d) < 0:  # met an inner wall facing the axis
                radii.append(hit[3])
        if len(radii) >= 24:
            r = float(np.median(radii))
            best = r if best is None else max(best, r)
    return best, (cx, cy)


# ---------------------------------------------------------------------------------------------------------------
# props: what the model sits on or goes with


def prop_jar(p, parts, index):
    """A glass candle jar, wax poured in it and wicks standing up through the model's slots if asked."""
    d_mm = p.get("diameter")
    fit_note = None
    if d_mm in (None, "fit", "auto"):
        bore, _ = fit_bore(parts)
        if bore:
            d_mm = round(2 * bore / MM - float(p.get("clearance") or 0.5), 2)
            fit_note = f"fitted to the model's bore ({2 * bore / MM:.1f} mm): jar {d_mm} mm across the rim"
        else:
            lo, hi = bounds(parts)
            d_mm = round(min(hi[0] - lo[0], hi[1] - lo[1]) / MM * 0.9, 1)
            fit_note = f"the model has no bore to fit; jar {d_mm} mm across (90% of its footprint)"
    D = float(d_mm) * MM
    H = float(p.get("height") or D / MM * 1.15) * MM
    wall = float(p.get("wall") or 3.2) * MM
    base = float(p.get("base") or max(6.0, D / MM * 0.12)) * MM
    R = D / 2
    rim = [(R - wall / 2 + wall / 2 * math.cos(math.pi * i / 8), H - wall / 2 + wall / 2 * math.sin(math.pi * i / 8))
           for i in range(9)]
    profile = [(0.0, 0.0), (R - 0.004, 0.0), (R - 0.0012, 0.0006), (R, 0.003), (R, H - wall / 2)] + rim + [
        (R - wall, H - wall / 2), (R - wall, base + 0.004), (R - wall - 0.003, base + 0.0003), (0.0, base)]
    jar = lathe("jar", profile)
    assign(jar, plain_material("glass", p.get("glass") or "#f4f7f4", name="jar-glass"))
    objs = [jar]
    fill = p.get("fill")
    fill = H / MM * 0.75 if fill is None else float(fill)
    wax_top = None
    if fill > 0:
        wax_top = min(fill * MM, H - 0.004)
        wr = R - wall + 0.0003  # a hair into the glass, so the wax reads as touching it
        wax = lathe("wax", [(0.0, base - 0.0003), (wr - 0.003, base - 0.0003), (wr, base + 0.004),
                            (wr, wax_top + 0.0008), (wr - 0.002, wax_top + 0.0002), (0.0, wax_top)])
        assign(wax, plain_material("wax", p.get("wax") or "#efe3c9", name="jar-wax"))
        objs.append(wax)
    for o in objs:
        o.pass_index = index
    RESULT["props"].append({"kind": "jar", "diameter_mm": float(d_mm), "height_mm": round(H / MM, 1),
                            "wax_mm": round(wax_top / MM, 1) if wax_top else 0, "note": fit_note})
    if fit_note:
        note(fit_note)
    return objs, {"wicks": p.get("wicks"), "wax_top": wax_top, "radius": R, "floor": base}


def wick_positions(w, radius):
    if not w:
        return []
    if isinstance(w, (int, float)):
        n = int(w)
        if n == 1:
            return [(0.0, 0.0)]
        r = radius * (0.32 if n == 2 else 0.42)
        return [(r * math.cos(math.pi + 2 * math.pi * i / n), r * math.sin(math.pi + 2 * math.pi * i / n))
                for i in range(n)]
    return [(float(x) * MM, float(y) * MM) for x, y in w]


def add_wicks(info, parts, index):
    """Cotton wicks from the wax up past the model's top, leaning a little each its own way."""
    pos = wick_positions(info.get("wicks"), info["radius"])
    if not pos:
        return []
    lo, hi = bounds(parts)
    bottom = (info.get("wax_top") or info["floor"]) - 0.01
    top = hi[2]
    cot = plain_material("cotton", "#d8ccb0", name="wick-cotton")
    objs = []
    rng = np.random.default_rng(7)
    for i, (x, y) in enumerate(pos):
        lean, curl = rng.uniform(-1.4, 1.4) * MM, rng.uniform(-0.7, 0.7) * MM
        cu = bpy.data.curves.new(f"wick{i}", "CURVE")
        cu.dimensions = "3D"
        cu.bevel_mode = "ROUND"
        cu.bevel_depth = 0.00075
        cu.bevel_resolution = 3
        cu.resolution_u = 24
        sp = cu.splines.new("NURBS")
        pts = [(x, y, bottom), (x, y, bottom + 0.015), (x, y, top - 0.006), (x, y, top + 0.004),
               (x + lean * 0.3, y + 0.0002, top + 0.014), (x + lean, y - 0.0006, top + 0.024),
               (x + lean * 1.6 + curl, y - 0.001, top + 0.031)]
        sp.points.add(len(pts) - 1)
        for pt, c in zip(sp.points, pts):
            pt.co = (*c, 1.0)
        sp.order_u = 4
        sp.use_endpoint_u = True
        cu.materials.append(cot)
        ob = link(bpy.data.objects.new(f"wick{i}", cu))
        ob.pass_index = index
        objs.append(ob)
    RESULT["props"].append({"kind": "wicks", "count": len(objs),
                            "at_mm": [[round(x / MM, 1), round(y / MM, 1)] for x, y in pos]})
    return objs


PHONES = {
    # body w, h, t; corner radius; camera module side, its inset from the top and side; lenses; lens ring diameter
    "iphone-13": (71.5, 146.7, 7.65, 10.0, 29.0, 4.6, "diagonal", 10.8),
    "iphone-13-pro": (71.5, 146.7, 7.65, 10.0, 36.0, 4.0, "triangle", 14.0),
    "iphone-14": (71.5, 146.7, 7.8, 10.0, 29.5, 4.6, "diagonal", 11.0),
    "iphone-14-pro": (71.5, 147.5, 7.85, 10.5, 36.5, 4.0, "triangle", 14.5),
    "iphone-15": (71.6, 147.6, 7.8, 10.5, 29.5, 4.6, "diagonal", 11.0),
    "iphone-15-pro": (70.6, 146.6, 8.25, 10.5, 36.0, 4.0, "triangle", 14.5),
    "iphone-16": (71.6, 147.6, 7.8, 10.5, 29.0, 4.6, "vertical", 11.0),
    "iphone-16-pro": (71.5, 149.6, 8.25, 10.5, 37.0, 4.0, "triangle", 14.8),
    "iphone-17": (71.5, 149.6, 7.95, 10.5, 29.0, 4.6, "vertical", 11.0),
}


def prop_phone(p, index):
    """A modern phone lying on the ground (back up by default), long side along Y, its top end at +Y: the
    camera module is then at the back's top left as you look down at it (-X, +Y). Dimensions are close, not exact:
    for a part that must fit one exactly, give the phone itself as a file prop."""
    name = str(p.get("model") or "iphone-15").lower().replace(" ", "-")
    if name not in PHONES:
        raise ValueError(f"phone {name!r}: one of {', '.join(PHONES)}")
    w, h, t, r, side, inset, layout, ring = PHONES[name]
    w, h, t, r, side, inset, ring = (x * MM for x in (w, h, t, r, side, inset, ring))
    color = p.get("color") or ("#2b2d31" if "pro" in name else "#1f2328")
    back_up = (p.get("face") or "down") == "down"
    body = extrude("phone", rounded_rect(w, h, r), 0.0, t, bevel_m=0.0011)
    frame = plain_material("aluminum" if "pro" not in name else "steel", "#3a3d42" if "pro" in name else color,
                           name="phone-frame")
    backm = new_material("phone-back")
    set_in(backm[2], Base_Color=srgb(color), Roughness=0.35 if "pro" in name else 0.08, Coat_Weight=1.0,
           Coat_Roughness=0.25 if "pro" in name else 0.03)
    screen = plain_material("screen", name="phone-screen")
    me = body.data
    for mt in (frame, backm[0], screen):
        me.materials.append(mt)
    for poly in me.polygons:
        nz = poly.normal.z
        poly.material_index = (1 if back_up else 2) if nz > 0.9 else (2 if back_up else 1) if nz < -0.9 else 0
    objs = [body]
    face_z = t if back_up else 0.0
    sgn = 1 if back_up else -1
    mx = -w / 2 + inset + side / 2 if back_up else w / 2 - inset - side / 2
    my = h / 2 - inset - side / 2
    bump_h = 1.2 * MM
    if layout == "vertical":
        mod = extrude("phone-camera", rounded_rect(side * 0.5, side * 1.05, side * 0.25), 0, bump_h, 0.0004)
        lenses = [(0, side * 0.26), (0, -side * 0.26)]
    else:
        mod = extrude("phone-camera", rounded_rect(side, side, side * 0.24), 0, bump_h, 0.0004)
        q = side * 0.24
        lenses = [(-q, q), (q, -q)] if layout == "diagonal" else [(-q, q), (-q, -q), (q, 0)]
    for v in mod.data.vertices:
        v.co = Vector((mx + v.co.x, my + v.co.y, face_z + sgn * v.co.z))
    if not back_up:
        mod.data.flip_normals()
    assign(mod, backm[0])
    objs.append(mod)
    ring_m = plain_material("aluminum", "#5c5f66", name="lens-ring")
    glass = new_material("lens-glass")
    set_in(glass[2], Base_Color=(0.002, 0.002, 0.003, 1), Roughness=0.02, Specular_IOR_Level=0.6)
    for k, (lx, ly) in enumerate(lenses):
        cx, cy = mx + (lx if back_up else -lx), my + ly
        rr = cylinder(f"lens-ring{k}", ring / 2, face_z, face_z + sgn * (bump_h + 1.6 * MM), x=cx, y=cy)
        if not back_up:
            rr.data.flip_normals()
        assign(rr, ring_m)
        gl = cylinder(f"lens-glass{k}", ring / 2 * 0.78, face_z, face_z + sgn * (bump_h + 1.75 * MM), x=cx, y=cy)
        if not back_up:
            gl.data.flip_normals()
        assign(gl, glass[0])
        objs += [rr, gl]
    for o in objs:
        o.pass_index = index
    RESULT["props"].append({"kind": "phone", "model": name, "size_mm": [round(w / MM, 1), round(h / MM, 1),
                                                                        round(t / MM, 2)],
                            "face": "down" if back_up else "up", "camera_at_mm": [round(mx / MM, 1), round(my / MM, 1)]})
    return objs


def prop_file(p, index):
    before = set(bpy.data.objects)
    bpy.ops.wm.stl_import(filepath=p["path"])
    o = [x for x in bpy.data.objects if x not in before and x.type == "MESH"][0]
    o.name = p.get("name") or "prop"
    o.data.shade_smooth()
    if hasattr(o.data, "set_sharp_from_angle"):
        o.data.set_sharp_from_angle(angle=math.radians(30))
    m = Matrix.Scale(MM, 4)
    if p.get("rotate"):
        m = Euler([math.radians(a) for a in p["rotate"]], "XYZ").to_matrix().to_4x4() @ m
    o.matrix_world = Matrix.Translation(Vector(p.get("offset") or (0, 0, 0)) * MM) @ m
    o.pass_index = index
    material = str(p.get("material") or "plastic").lower()
    if material in PRINTED:
        part_material(o, p)
    else:
        assign(o, plain_material(material, p.get("color")))
    bpy.context.view_layer.update()
    lo, hi = bounds([o])
    RESULT["props"].append({"kind": "file", "name": o.name, "material": material,
                            "size_mm": [round(float(x) / MM, 1) for x in hi - lo]})
    return [o]


# ---------------------------------------------------------------------------------------------------------------
# the setting: desk, table, studio, dark, cutout, wall


def world(hdri="interior", strength=0.12, rotate=200, color=None):
    w = bpy.data.worlds.new("world")
    if bpy.app.version < (5, 0, 0):
        w.use_nodes = True
    SC.world = w
    nt = w.node_tree
    bg = next(n for n in nt.nodes if n.type == "BACKGROUND")
    bg.inputs["Strength"].default_value = strength
    if color is not None:
        bg.inputs["Color"].default_value = srgb(color)
        return
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    v = f"{bpy.app.version[0]}.{bpy.app.version[1]}"
    path = os.path.join(os.path.dirname(bpy.app.binary_path), "..", "Resources", v, "datafiles", "studiolights",
                        "world", f"{hdri}.exr")
    env.image = bpy.data.images.load(os.path.abspath(path))
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Rotation"].default_value = (0, 0, math.radians(rotate))
    tc = nt.nodes.new("ShaderNodeTexCoord")
    nt.links.new(tc.outputs["Generated"], mp.inputs["Vector"])
    nt.links.new(mp.outputs[0], env.inputs[0])
    nt.links.new(env.outputs[0], bg.inputs[0])


def plane(name, size, loc, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_plane_add(size=size, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    return o


def oak_desk(size):
    """The desk: a CC0 oak veneer scan, at its true 457 mm a tile, mirrored."""
    o = plane("desk", size, (0, 0, 0))
    m, nt, b = new_material("oak")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (1 / 0.457, 1 / 0.457, 1)
    mp.inputs["Rotation"].default_value = (0, 0, math.radians(90))
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(os.path.join(HERE, "assets", "oak-desk-2k.webp"))
    tex.extension = "MIRROR"
    tex.interpolation = "Cubic"
    nt.links.new(mp.outputs[0], tex.inputs["Vector"])
    hsv = nt.nodes.new("ShaderNodeHueSaturation")  # the scan reads orange under warm light; tame it a little
    hsv.inputs["Saturation"].default_value = 0.75
    hsv.inputs["Value"].default_value = 0.85
    nt.links.new(tex.outputs["Color"], hsv.inputs["Color"])
    nt.links.new(hsv.outputs[0], b.inputs["Base Color"])
    bw = nt.nodes.new("ShaderNodeRGBToBW")
    nt.links.new(tex.outputs["Color"], bw.inputs[0])
    bp = nt.nodes.new("ShaderNodeBump")
    bp.inputs["Strength"].default_value = 0.08
    bp.inputs["Distance"].default_value = 0.0002
    nt.links.new(bw.outputs[0], bp.inputs["Height"])
    nt.links.new(bp.outputs[0], b.inputs["Normal"])
    rr = nt.nodes.new("ShaderNodeMapRange")
    nt.links.new(bw.outputs[0], rr.inputs["Value"])
    rr.inputs["To Min"].default_value, rr.inputs["To Max"].default_value = 0.5, 0.38
    nt.links.new(rr.outputs[0], b.inputs["Roughness"])
    set_in(b, Specular_IOR_Level=0.45, Coat_Weight=0.15, Coat_Roughness=0.25)
    assign(o, m)
    return o


def stone_table(size):
    o = plane("table", size, (0, 0, 0))
    m, nt, b = new_material("stone")
    st = nt.nodes.new("ShaderNodeTexNoise")
    st.inputs["Scale"].default_value = 35.0
    st.inputs["Detail"].default_value = 8.0
    st.inputs["Roughness"].default_value = 0.6
    mx = nt.nodes.new("ShaderNodeMix")
    mx.data_type = "RGBA"
    mx.inputs["A"].default_value = srgb("#bdb4a7")
    mx.inputs["B"].default_value = srgb("#d6cfc4")
    nt.links.new(st.outputs[0], mx.inputs["Factor"])
    nt.links.new(mx.outputs[2], b.inputs["Base Color"])
    bp = nt.nodes.new("ShaderNodeBump")
    bp.inputs["Strength"].default_value = 0.04
    nt.links.new(st.outputs[0], bp.inputs["Height"])
    nt.links.new(bp.outputs[0], b.inputs["Normal"])
    set_in(b, Roughness=0.72)
    assign(o, m)
    return o


def back_wall(y, size, color="#d9d4cb", rough=0.9):
    o = plane("wall", size, (0, y, size / 2 - 0.001), (math.radians(90), 0, 0))
    m, nt, b = new_material("wall-paint")
    set_in(b, Base_Color=srgb(color), Roughness=rough, Specular_IOR_Level=0.3)
    bump_noise(nt, b, 400, 0.05, 0.0002, 6.0)
    assign(o, m)
    return o


def sweep(R, color, name="sweep"):
    """A seamless paper sweep: floor curving up into a wall behind, sized to what's on it."""
    width, depth, rise, bend = 40 * R, 14 * R, 18 * R, 5 * R
    prof = [(-depth, 0.0), (0.0, 0.0)]
    prof += [(bend * math.sin(a), bend - bend * math.cos(a)) for a in np.linspace(0, math.pi / 2, 16)[1:]]
    prof += [(bend, rise)]
    verts, faces = [], []
    for x in (-width / 2, width / 2):
        verts += [(x, y + 6 * R, z) for y, z in prof]
    m = len(prof)
    faces = [(k, k + 1, m + k + 1, m + k) for k in range(m - 1)]
    o = mesh_object(name, verts, faces)
    o.data.flip_normals() if o.data.polygons[0].normal.z < 0 else None
    mat, nt, b = new_material("paper-" + name)
    set_in(b, Base_Color=srgb(color), Roughness=0.9, Specular_IOR_Level=0.25)
    assign(o, mat)
    return o


def area(name, target, az, el, dist, size, power, color=(1.0, 0.98, 0.95), shape="DISK"):
    """An area light at an azimuth (from the front, + toward +X) and elevation around target, aimed at it."""
    a, e = math.radians(az), math.radians(el)
    loc = Vector(target) + dist * Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e)))
    ld = bpy.data.lights.new(name, "AREA")
    ld.shape, ld.size, ld.energy, ld.color = shape, size, power, color
    if shape == "RECTANGLE":
        ld.size_y = size * 0.7
    o = link(bpy.data.objects.new(name, ld))
    o.location = loc
    o.rotation_euler = (Vector(target) - loc).to_track_quat("-Z", "Y").to_euler()
    return o


SCENES = {
    # each light: (name, azimuth, elevation, distance in R, size in R, irradiance, colour)
    "desk": dict(world=("interior", 0.18, 200), lights=[("window", -62, 38, 9, 7.0, 3.6, (1.0, 0.985, 0.965)),
                                                        ("fill", 55, 22, 10, 9.0, 0.9, (0.93, 0.96, 1.0)),
                                                        ("rim", 155, 40, 8, 3.0, 2.2, (1.0, 0.98, 0.95)),
                                                        ("graze", -105, 9, 9, 2.5, 0.9, (1.0, 0.985, 0.965))]),
    "table": dict(world=("interior", 0.12, 200), lights=[("key", -55, 42, 9, 7.0, 3.4, (1.0, 0.97, 0.92)),
                                                         ("fill", 50, 20, 10, 8.0, 0.7, (0.92, 0.95, 1.0)),
                                                         ("rim", 160, 35, 8, 3.0, 2.4, (1.0, 0.98, 0.95)),
                                                         ("graze", -100, 9, 9, 2.5, 0.8, (1.0, 0.97, 0.92))]),
    "studio": dict(world=("studio", 0.25, 0), lights=[("key", -45, 45, 8, 6.0, 1.9, (1.0, 0.99, 0.97)),
                                                      ("fill", 60, 25, 9, 8.0, 0.6, (0.95, 0.97, 1.0)),
                                                      ("rim", 165, 40, 7, 3.0, 1.4, (1.0, 1.0, 1.0)),
                                                      ("top", 0, 85, 10, 8.0, 0.5, (1.0, 1.0, 1.0)),
                                                      ("graze", -100, 8, 9, 2.5, 0.4, (1.0, 0.99, 0.97))]),
    "dark": dict(world=("studio", 0.06, 0), lights=[("key", -50, 40, 8, 5.0, 3.0, (1.0, 0.98, 0.95)),
                                                    ("rim", 150, 35, 7, 2.5, 3.6, (0.95, 0.97, 1.0)),
                                                    ("rim2", -150, 30, 7, 2.5, 1.8, (1.0, 0.97, 0.92)),
                                                    ("graze", -95, 8, 9, 2.0, 0.6, (1.0, 0.98, 0.95))]),
    "cutout": dict(world=("studio", 0.3, 0), lights=[("key", -45, 45, 8, 6.0, 3.4, (1.0, 0.99, 0.97)),
                                                     ("fill", 60, 25, 9, 8.0, 1.1, (0.95, 0.97, 1.0)),
                                                     ("rim", 165, 40, 7, 3.0, 2.4, (1.0, 1.0, 1.0)),
                                                     ("graze", -100, 8, 9, 2.5, 0.7, (1.0, 0.99, 0.97))]),
    "wall": dict(world=("interior", 0.15, 180), lights=[("key", -50, 35, 9, 6.0, 3.2, (1.0, 0.97, 0.92)),
                                                        ("fill", 45, 15, 10, 8.0, 0.9, (0.93, 0.96, 1.0)),
                                                        ("graze", -88, 6, 9, 2.0, 0.8, (1.0, 0.97, 0.92))]),
}
LIGHT_K = float(JOB.get("light_k") or 3.3)
"""Watts per (irradiance unit x metre^2): calibrated on black ASA and white PLA at 20, 100 and 400 mm (see test_scene)."""


def build_setting(name, target, R, ground_z=0.0):
    s = SCENES[name]
    hdri, strength, rot = s["world"]
    world(hdri, strength, rot)
    big = max(3.0, 60 * R)
    if name == "desk":
        oak_desk(big)
        back_wall(max(0.35, 9 * R), big, "#e2ddd4")
    elif name == "table":
        stone_table(big)
        back_wall(max(0.35, 9 * R), big, "#b9b2a6")
    elif name == "studio":
        sweep(R, "#c9cacc")
    elif name == "dark":
        sweep(R, "#26272a", "dark-sweep")
    elif name == "cutout":
        o = plane("catcher", big, (0, 0, 0))
        o.is_shadow_catcher = True
        SC.render.film_transparent = True
    elif name == "wall":
        o = plane("wall", big, (0, 0, 0), (math.radians(90), 0, 0))
        m, nt, b = new_material("plaster")
        set_in(b, Base_Color=srgb("#d3ccc0"), Roughness=0.92, Specular_IOR_Level=0.25)
        bump_noise(nt, b, 260, 0.12, 0.0003, 8.0)
        assign(o, m)
        fl = plane("floor", big, (0, -big / 2, target[2] - 30 * R))
        assign(fl, plain_material("wood", "#9c7a55", name="floor-wood"))
    for (ln, az, el, dist, size, irr, color) in s["lights"]:
        d = dist * R
        area(ln, target, az, el, d, size * R, LIGHT_K * irr * d * d * float(JOB.get("light") or 1.0), color)


# ---------------------------------------------------------------------------------------------------------------
# cameras and framing

SHOTS = {
    # azimuth, elevation, lens (mm), what it frames, margin
    "hero": (-28, 22, 70, "all", 1.12),
    "front": (0, 8, 85, "all", 1.1),
    "side": (90, 8, 85, "all", 1.1),
    "left": (-90, 8, 85, "all", 1.1),
    "back": (180, 15, 85, "all", 1.1),
    "back_hero": (152, 24, 70, "all", 1.12),
    "low": (-22, 4, 50, "all", 1.12),
    "top": (0, 89.5, 85, "all", 1.1),
    "close": (-18, 42, 90, "model", 1.1),
    "detail": (-25, 35, 100, "around", 1.05),
}


def camera_basis(az, el):
    """The camera's axes for an azimuth (from the front, + toward +X) and elevation: (back, right, up), where back
    points from the target to the camera."""
    a, e = math.radians(az), math.radians(el)
    d = Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e)))
    hint = Vector((0, 0, 1)) if abs(el) < 89 else Vector((-math.sin(a), math.cos(a), 0))
    right = hint.cross(d).normalized()
    up = d.cross(right).normalized()
    return d, right, up


def frame(points, az, el, lens, aspect, margin, sensor=36.0):
    """Where a camera at az/el with this lens must stand to fit every point with margin, centred. (location, target,
    distance)."""
    d, right, up = camera_basis(az, el)
    if aspect >= 1:
        tx = (sensor / 2) / lens
        ty = tx / aspect
    else:
        ty = (sensor / 2) / lens
        tx = ty * aspect
    P = np.asarray(points)
    t = Vector(P.mean(axis=0))
    D = 0.0
    for _ in range(4):
        rel = P - np.array(t)
        a_ = rel @ np.array(right)
        b_ = rel @ np.array(up)
        c_ = rel @ np.array(d)
        D = float(max(np.max(c_ + np.abs(a_) * margin / tx), np.max(c_ + np.abs(b_) * margin / ty)))
        depth = D - c_
        x, y = a_ / depth, b_ / depth
        shift_x = (x.max() + x.min()) / 2 * D
        shift_y = (y.max() + y.min()) / 2 * D
        t = t + right * shift_x + up * shift_y
    return t + d * D, t, D


def add_camera(loc, target, lens, az, el):
    cd = bpy.data.cameras.new("cam")
    cd.lens = lens
    cd.sensor_width = 36.0
    cam = SC.camera or link(bpy.data.objects.new("cam", cd))
    cam.data = cd
    SC.camera = cam
    cam.location = loc
    d, right, up = camera_basis(az, el)
    cam.rotation_euler = Matrix((right, up, d)).transposed().to_euler()
    dist = (Vector(target) - Vector(loc)).length
    cd.clip_start = max(0.0002, dist * 0.02)
    cd.clip_end = dist * 80 + 100
    return cam


def auto_fstop(lens_mm, dist_m, depth_m, width_px):
    """The f-stop that keeps depth_m (the model's own depth along the view, around the focus) sharp to about 3 px:
    the model crisp through, and the background as soft as that leaves it (between f/2.8 and f/32)."""
    c = 36.0 / width_px * 3.0 / 1000  # circle of confusion, m
    f = lens_mm / 1000
    n = depth_m * f * f / (2 * c * dist_m * dist_m) if dist_m > 0 else 8
    return float(min(32.0, max(2.8, n)))


# ---------------------------------------------------------------------------------------------------------------
# rendering and checking


def has_glass():
    for m in bpy.data.materials:
        for n in (m.node_tree.nodes if m.node_tree else ()):
            if n.bl_idname == "ShaderNodeBsdfPrincipled" and n.inputs["Transmission Weight"].default_value > 0.5:
                return True
    return False


def setup_render(size, samples, preview):
    r = SC.render
    r.engine = "CYCLES"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "METAL"
        prefs.get_devices()
        gpus = [d for d in prefs.devices if d.type == "METAL"]
        for d in prefs.devices:
            d.use = d.type == "METAL"
        SC.cycles.device = "GPU" if gpus else "CPU"
        RESULT["device"] = ", ".join(d.name for d in gpus) or "CPU"
    except Exception as e:  # noqa: BLE001
        SC.cycles.device = "CPU"
        RESULT["device"] = f"CPU ({e})"
    c = SC.cycles
    c.samples = samples
    c.use_adaptive_sampling = True
    c.adaptive_threshold = 0.02 if preview else 0.012
    c.use_denoising = True
    if hasattr(c, "denoiser"):
        c.denoiser = "OPENIMAGEDENOISE"
    if hasattr(c, "denoising_use_gpu"):
        c.denoising_use_gpu = True
    c.max_bounces, c.diffuse_bounces, c.glossy_bounces = 12, 4, 6
    c.transmission_bounces, c.transparent_max_bounces = 12, 32
    c.caustics_reflective = False
    c.caustics_refractive = has_glass()  # wax in a glass jar is lit only through the glass
    c.sample_clamp_indirect = 6.0
    r.resolution_x, r.resolution_y = size
    r.resolution_percentage = 100
    r.image_settings.file_format = "PNG"
    r.image_settings.color_mode = "RGBA" if r.film_transparent else "RGB"
    r.image_settings.color_depth = "8"
    SC.view_settings.view_transform = "AgX"
    for look in ("AgX - Base Contrast", "Base Contrast", "None"):
        try:
            SC.view_settings.look = look
            break
        except TypeError:
            continue
    SC.view_layers[0].use_pass_object_index = True


def read_image(path):
    import OpenImageIO as oiio
    inp = oiio.ImageInput.open(path)
    if not inp:
        raise RuntimeError(f"can't read {path}: {oiio.geterror()}")
    spec = inp.spec()
    px = inp.read_image(format="float")
    names = list(spec.channelnames)
    inp.close()
    return np.asarray(px).reshape(spec.height, spec.width, spec.nchannels), names


def render_shot(png, exr=None):
    """Render the camera's view: with exr, the render writes every pass there (the object index among them) and the
    picture, as shown, is saved from it to png."""
    st = SC.render.image_settings
    mode = st.color_mode
    if not exr:
        SC.render.filepath = png
        st.file_format = "PNG"
        bpy.ops.render.render(write_still=True)
        return
    if hasattr(st, "media_type"):  # Blender 5: multilayer is a media type of its own
        st.media_type = "MULTI_LAYER_IMAGE"
    st.file_format = "OPEN_EXR_MULTILAYER"
    st.color_depth = "16"
    SC.render.filepath = exr
    bpy.ops.render.render(write_still=True)
    if hasattr(st, "media_type"):
        st.media_type = "IMAGE"
    st.file_format = "PNG"
    st.color_mode = mode
    st.color_depth = "8"
    bpy.data.images["Render Result"].save_render(png, scene=SC)


def read_index(exr):
    """The object-index pass of a multilayer EXR (each pass may be a part of its own)."""
    import OpenImageIO as oiio
    inp = oiio.ImageInput.open(exr)
    if not inp:
        return None
    k = 0
    try:
        while inp.seek_subimage(k, 0):
            names = list(inp.spec().channelnames)
            for c, n in enumerate(names):
                if "Object Index" in n or "IndexOB" in n:
                    spec = inp.spec()
                    px = np.asarray(inp.read_image(format="float")).reshape(spec.height, spec.width, spec.nchannels)
                    return px[:, :, c]
            k += 1
    finally:
        inp.close()
    return None


def shot_stats(png, exr, parts_index):
    """Per part, from the render and its object-index pass: how much of the frame it fills, whether it runs off the
    frame, its middle brightness as shown, and how much of it is blown out or crushed black."""
    rgb, _ = read_image(png)
    idx = read_index(exr)
    if idx is None:
        return None
    idx = np.rint(idx).astype(int)
    if idx.shape != rgb.shape[:2]:
        return None
    luma = 0.2126 * rgb[:, :, 0] + 0.7152 * rgb[:, :, 1] + 0.0722 * rgb[:, :, 2]
    h, w = idx.shape
    out = {}
    any_part = np.zeros_like(idx, dtype=bool)
    for name, i in parts_index.items():
        m = idx == i
        n = int(m.sum())
        any_part |= m
        if n == 0:
            out[name] = {"coverage": 0.0}
            continue
        inner = m.copy()  # the part's own pixels, not those its edges share with what's behind
        inner[1:, :] &= m[:-1, :]
        inner[:-1, :] &= m[1:, :]
        inner[:, 1:] &= m[:, :-1]
        inner[:, :-1] &= m[:, 1:]
        if inner.sum() < 50:
            inner = m
        lm = luma[inner]
        edge = bool(m[0, :].any() or m[-1, :].any() or m[:, 0].any() or m[:, -1].any())
        ys, xs = np.nonzero(m)
        out[name] = {"coverage": round(n / (h * w), 4), "median": round(float(np.median(lm)), 3),
                     "p95": round(float(np.percentile(lm, 95)), 3),
                     "clipped": round(float((rgb[inner][:, :3].max(axis=1) >= 0.985).mean()), 4),
                     "crushed": round(float((lm <= 0.012).mean()), 4), "off_frame": edge,
                     "box": [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]}
    out["_model"] = {"coverage": round(float(any_part.mean()), 4)}
    return out


def expected_luma(hex_color):
    """About how bright a part of this colour reads in a well-lit product photo, as shown (0-1)."""
    return 0.09 + 0.74 * luma_of(hex_color)


def to_linear(v):
    v = max(1e-4, min(1.0, v))
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def meter(stats, specs):
    """The exposure change (EV) that brings the parts to about where their colours should read."""
    num, den = 0.0, 0.0
    for s in specs:
        st = (stats or {}).get(s["name"]) or {}
        if not st.get("coverage") or str(s.get("material", "")).lower() in ("glass", "frosted glass", "chrome",
                                                                              "emission", "screen"):
            continue
        ev = math.log2(to_linear(expected_luma(s.get("color") or "grey")) / to_linear(st["median"]))
        num += ev * st["coverage"]
        den += st["coverage"]
    if den == 0:
        return 0.0
    return max(-2.6, min(1.6, num / den))


def jpeg(png, jpg, limit=1_000_000, background=(1.0, 1.0, 1.0)):
    """A JPEG of the PNG under limit bytes (over white when it has alpha)."""
    import OpenImageIO as oiio
    px, _ = read_image(png)
    if px.shape[2] == 4:
        a = px[:, :, 3:4]
        px = px[:, :, :3] * a + np.array(background) * (1 - a)
    px = np.ascontiguousarray(px[:, :, :3], dtype=np.float32)
    for q in (92, 88, 84, 80, 75, 70, 62):
        spec = oiio.ImageSpec(px.shape[1], px.shape[0], 3, "uint8")
        spec.attribute("CompressionQuality", q)
        spec.attribute("compression", f"jpeg:{q}")
        o = oiio.ImageOutput.create(jpg)
        o.open(jpg, spec)
        o.write_image(px)
        o.close()
        if os.path.getsize(jpg) <= limit:
            return q
    return q


def contact_sheet(pngs, labels, out, width=1800):
    """Every shot in one picture, for a quick look."""
    import OpenImageIO as oiio
    imgs = []
    for p in pngs:
        px, _ = read_image(p)
        if px.shape[2] == 4:
            a = px[:, :, 3:4]
            px = px[:, :, :3] * a + (1 - a)
        imgs.append(px[:, :, :3])
    n = len(imgs)
    cols = 1 if n == 1 else 2 if n <= 4 else 3
    rows = math.ceil(n / cols)
    cw = width // cols
    gap = 8
    cells = []
    for px in imgs:
        buf = oiio.ImageBuf(np.ascontiguousarray(px, dtype=np.float32))
        h = int(px.shape[0] * cw / px.shape[1])
        small = oiio.ImageBufAlgo.resize(buf, roi=oiio.ROI(0, cw, 0, h, 0, 1, 0, 3))
        cells.append(np.asarray(small.get_pixels(oiio.FLOAT)).reshape(h, cw, 3))
    ch = max(c.shape[0] for c in cells)
    sheet = np.full((rows * ch + (rows + 1) * gap, cols * cw + (cols + 1) * gap, 3), 0.12, dtype=np.float32)
    for k, c in enumerate(cells):
        r_, c_ = divmod(k, cols)
        y, x = gap + r_ * (ch + gap), gap + c_ * (cw + gap)
        sheet[y:y + c.shape[0], x:x + cw] = c
    spec = oiio.ImageSpec(sheet.shape[1], sheet.shape[0], 3, "uint8")
    spec.attribute("compression", "jpeg:88")
    o = oiio.ImageOutput.create(out)
    o.open(out, spec)
    o.write_image(np.ascontiguousarray(sheet))
    o.close()
    return out


# ---------------------------------------------------------------------------------------------------------------
# the job


def main():
    size = tuple(JOB.get("size") or (1600, 1200))
    preview = bool(JOB.get("preview"))
    if preview:
        size = (max(320, size[0] // 2), max(240, size[1] // 2))
    samples = int(JOB.get("samples") or (32 if preview else 160))
    scene_name = JOB.get("scene") or "desk"
    place = JOB.get("place") or {}
    if scene_name == "wall":
        place.setdefault("mode", "wall")
    say("building the scene")
    root, parts = load_parts()
    pose_model(root, place)
    # props, and where the model goes on them
    props, anchors, wick_info = [], [], None
    for k, p in enumerate(JOB.get("props") or []):
        kind = p.get("kind")
        if kind == "jar":
            objs, wick_info = prop_jar(p, parts, 101 + k)
            anchors.append((0.0, 0.0))
        elif kind == "phone":
            objs = prop_phone(p, 101 + k)
            cam = RESULT["props"][-1]["camera_at_mm"]
            anchors.append((cam[0] * MM, cam[1] * MM) if place.get("on") == "camera" else (0.0, 0.0))
        elif kind == "file":
            objs = prop_file(p, 101 + k)
            anchors.append(None)
        else:
            raise ValueError(f"unknown prop {kind!r}: jar, phone or file")
        props.append(objs)
    flat_props = [o for objs in props for o in objs]
    specs = JOB.get("props") or []
    file_props = [o for p, objs in zip(specs, props) if p.get("kind") == "file" for o in objs]
    mode = place.get("mode") or "drop"
    bpy.context.view_layer.update()
    if mode == "as_is":
        lift = 0.0
        if not [p for p in specs if p.get("kind") != "file"]:  # nothing built in: the lowest point goes on the ground
            lift = -float(bounds(parts + file_props)[0][2])
        move(root, (0, 0, lift))
        for o in file_props:
            o.matrix_world = Matrix.Translation((0, 0, lift)) @ o.matrix_world
        rest = "its own coordinates" + (" (lifted onto the ground)" if lift else "")
    elif mode == "wall":
        lo, hi = bounds(parts)
        move(root, (-(lo[0] + hi[0]) / 2, -hi[1], -(lo[2] + hi[2]) / 2))
        rest = "the wall"
    else:
        for p, objs, k in zip(specs, props, range(len(specs))):
            if p.get("kind") != "file":
                continue
            lo, hi = bounds(objs)
            dx, dy = (0.0, 0.0) if p.get("offset") else (-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2)
            for o in objs:  # it stands on the ground, centred unless it was given an offset
                o.matrix_world = Matrix.Translation((dx, dy, -lo[2])) @ o.matrix_world
            bpy.context.view_layer.update()
            plo, phi = bounds(objs)
            anchors[k] = ((plo[0] + phi[0]) / 2, (plo[1] + phi[1]) / 2)
        lo, hi = bounds(parts)
        anchor = anchors[0] if anchors else (0.0, 0.0)
        at = place.get("at") or (0, 0)
        move(root, (anchor[0] + at[0] * MM - (lo[0] + hi[0]) / 2, anchor[1] + at[1] * MM - (lo[1] + hi[1]) / 2, 0))
        rest = drop(root, parts, flat_props)
        if rest == "a prop" and specs:
            rest = {"jar": "the jar's rim", "phone": "the phone", "file": specs[0].get("name") or "the prop"}.get(
                specs[0].get("kind"), "a prop")
    if wick_info:
        flat_props += add_wicks(wick_info, parts, 150)
    bpy.context.view_layer.update()
    mlo, mhi = bounds(parts)
    RESULT["model"] = {"size_mm": [round(float(x) / MM, 2) for x in mhi - mlo],
                       "rests_on": rest, "bottom_mm": round(float(mlo[2]) / MM, 2)}
    say(f"model {' x '.join(str(x) for x in RESULT['model']['size_mm'])} mm, resting on {rest}")
    everything = parts + flat_props
    alo, ahi = bounds(everything)
    center = (alo + ahi) / 2
    R = float(np.linalg.norm(ahi - alo)) / 2
    build_setting(scene_name, Vector(center), R)
    setup_render(size, samples, preview)
    # where the points to frame are, for each kind of framing
    pts_all = surface_points(everything, 8000, seed=3)
    pts_model = surface_points(parts, 6000, seed=4)
    model_mw = root.matrix_world
    names = {o.name: o.pass_index for o in parts}
    shots = JOB.get("shots") or (["hero", "close"] if flat_props else ["hero"])
    exposure = JOB.get("exposure", "auto")
    ev = 0.0 if exposure in (None, "auto") else float(exposure)
    if exposure in (None, "auto") and not preview:
        say("metering the exposure")
        s0 = shot_spec(shots[0])
        cam_setup(s0, pts_all, pts_model, model_mw, (size[0] // 2, size[1] // 2), mlo, mhi)
        SC.render.resolution_x, SC.render.resolution_y = size[0] // 2, size[1] // 2
        SC.cycles.samples = 32
        mp, me_ = os.path.join(OUT, "_meter.png"), os.path.join(OUT, "_meter.exr")
        render_shot(mp, me_)
        st = shot_stats(mp, me_, names)
        raw = meter(st, JOB["parts"])
        RESULT["meter"] = {"parts": {k: v.get("median") for k, v in (st or {}).items() if k != "_model"},
                           "ev": round(raw, 2)}
        # only what's well off is corrected: a black top lit by the key reads a little grey, and that's right
        ev = round(math.copysign(max(0.0, abs(raw) - 0.6), raw), 2)
        for f in (mp, me_):
            if os.path.exists(f):
                os.remove(f)
        SC.render.resolution_x, SC.render.resolution_y = size
        SC.cycles.samples = samples
        if ev:
            note(f"metered the parts and set the exposure {ev:+.2f} EV")
    SC.view_settings.exposure = ev
    RESULT["exposure_ev"] = ev
    RESULT["timing"]["build_s"] = round(time.time() - T0, 1)
    pngs = []
    for k, s in enumerate(shots):
        spec = shot_spec(s)
        t1 = time.time()
        say(f"rendering {spec['name']} ({k + 1} of {len(shots)})")
        info = cam_setup(spec, pts_all, pts_model, model_mw, size, mlo, mhi)
        png = os.path.join(OUT, f"{spec['name']}.png")
        exr = os.path.join(OUT, f"{spec['name']}.exr")
        render_shot(png, exr)
        st = shot_stats(png, exr, names) if os.path.exists(exr) else None
        if os.path.exists(exr):
            os.remove(exr)
        jpg = os.path.join(OUT, f"{spec['name']}.jpg")
        jpeg(png, jpg)
        shot = {"name": spec["name"], "png": png, "jpg": jpg, "size": list(size), "seconds": round(time.time() - t1, 1),
                **info, "stats": st}
        shot["warnings"] = check_shot(spec, st)
        RESULT["shots"].append(shot)
        pngs.append(png)
    if len(pngs) > 1:
        RESULT["sheet"] = contact_sheet(pngs, [s["name"] for s in RESULT["shots"]], os.path.join(OUT, "sheet.jpg"))
    RESULT["samples"] = samples
    RESULT["scene"] = scene_name
    RESULT["timing"]["total_s"] = round(time.time() - T0, 1)


def shot_spec(s):
    if isinstance(s, str):
        s = {"name": s}
    s = dict(s)
    base = SHOTS.get(s.get("view") or s["name"]) or SHOTS["hero"]
    az, el, lens, what, margin = base
    if s.get("around"):
        what = "around"
    s.setdefault("azimuth", az)
    s.setdefault("elevation", el)
    s.setdefault("lens", lens)
    s.setdefault("frame", what)
    s.setdefault("margin", margin)
    return s


def cam_setup(s, pts_all, pts_model, model_mw, size, mlo, mhi):
    aspect = size[0] / size[1]
    if s["frame"] == "around" and s.get("around"):
        c = model_mw @ (Vector(s["around"]) * MM)
        r = float(s.get("radius") or 10) * MM
        pts = np.array([[c.x + dx * r, c.y + dy * r, c.z + dz * r] for dx in (-1, 1) for dy in (-1, 1) for dz in (-1, 1)])
    elif s["frame"] == "model":
        pts = pts_model
    else:
        pts = pts_all
    loc, target, dist = frame(pts, s["azimuth"], s["elevation"], s["lens"], aspect, s["margin"])
    if s.get("distance_scale"):
        loc = target + (loc - target) * float(s["distance_scale"])
        dist *= float(s["distance_scale"])
    cam = add_camera(loc, target, s["lens"], s["azimuth"], s["elevation"])
    cd = cam.data
    dof = s.get("dof", JOB.get("dof", True))
    fstop = None
    if dof and JOB.get("scene") != "cutout":
        focus = Vector(((mlo + mhi) / 2).tolist()) if s["frame"] != "around" else model_mw @ (Vector(s["around"]) * MM)
        d, _, _ = camera_basis(s["azimuth"], s["elevation"])
        if s["frame"] == "around":
            depth = 2 * float(s.get("radius") or 10) * MM
        else:  # the model sharp through, and most of what it's on
            depth = max(float(np.ptp(pts_model @ np.array(d))) * 1.15, 0.6 * float(np.ptp(pts @ np.array(d))))
        fdist = (focus - Vector(loc)).length
        fstop = float(s.get("fstop") or auto_fstop(s["lens"], fdist, depth, size[0]))
        cd.dof.use_dof = True
        cd.dof.focus_distance = fdist
        cd.dof.aperture_fstop = fstop
    PM.update_lod(SC)
    return {"camera": {"azimuth": s["azimuth"], "elevation": s["elevation"], "lens_mm": s["lens"],
                       "distance_mm": round(dist / MM, 1), "fstop": round(fstop, 1) if fstop else None,
                       "location_mm": [round(x / MM, 1) for x in loc], "target_mm": [round(x / MM, 1) for x in target]},
            "frames": s["frame"]}


def check_shot(s, st):
    out = []
    if not st:
        return ["couldn't read the object pass to check it"]
    for name, v in st.items():
        if name == "_model":
            continue
        if not v.get("coverage"):
            out.append(f"{name} isn't in view")
            continue
        if v.get("off_frame") and s["frame"] != "around":
            out.append(f"{name} runs off the frame")
        if v.get("clipped", 0) > 0.04:
            out.append(f"{name} is {v['clipped']:.0%} blown out (try exposure -0.7 or light 0.6)")
        if v.get("crushed", 0) > 0.25:
            out.append(f"{name} is {v['crushed']:.0%} crushed black (try exposure +0.7)")
    cov = st.get("_model", {}).get("coverage", 0)
    if cov and cov < 0.02 and s["frame"] == "all":
        out.append(f"the model fills only {cov:.1%} of the frame: add a close shot")
    return out


def compose_only():
    """Pictures side by side (a render and its AI pass), for checking one against the other."""
    imgs = [read_image(p)[0] for p in JOB["compose"]]
    h = min(i.shape[0] for i in imgs)
    cells = []
    for px in imgs:
        if px.shape[2] == 4:
            px = px[:, :, :3] * px[:, :, 3:4] + (1 - px[:, :, 3:4])
        px = px[:, :, :3]
        if px.shape[0] != h:
            ys = (np.arange(h) * px.shape[0] / h).astype(int)
            xs = (np.arange(int(px.shape[1] * h / px.shape[0])) * px.shape[0] / h).astype(int)
            px = px[ys][:, xs]
        cells.append(px)
    gap = 12
    sheet = np.full((h, sum(c.shape[1] for c in cells) + gap * (len(cells) - 1), 3), 1.0, dtype=np.float32)
    x = 0
    for c in cells:
        sheet[:, x:x + c.shape[1]] = c
        x += c.shape[1] + gap
    import OpenImageIO as oiio
    spec = oiio.ImageSpec(sheet.shape[1], sheet.shape[0], 3, "uint8")
    spec.attribute("compression", "jpeg:88")
    o = oiio.ImageOutput.create(JOB["out"])
    o.open(JOB["out"], spec)
    o.write_image(np.ascontiguousarray(sheet))
    o.close()


try:
    if JOB.get("compose"):
        compose_only()
        sys.exit(0)
    main()
    RESULT["ok"] = True
except Exception as e:  # noqa: BLE001
    import traceback
    RESULT["ok"] = False
    RESULT["error"] = f"{type(e).__name__}: {e}"
    RESULT["traceback"] = traceback.format_exc()[-3000:]
    say("failed: " + RESULT["error"])
with open(os.path.join(os.path.dirname(JOB_PATH), "result.json"), "w") as f:
    json.dump(RESULT, f, indent=1)
print("RENDER: done", flush=True)
