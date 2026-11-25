"""mesh's scene files: a .blend (or FBX, glTF, OBJ, USD) read through Blender, and split into printable parts.

Blender reads the file (blend_dump.py, run headless with nothing in the file allowed to run) and hands over every
triangle it shows, with its object, its material and the colour it shows there (a plain colour, or sampled from its
texture or colour attribute). Here those triangles become parts: one per material, per colour (the colours found in
its textures, clustered), per object, or one. Each separate body goes whole into the part most of its surface is, so a
part is closed when its bodies are; a body painted in two colours on one surface can't be cut into closed parts, and
says so. Then the parts are put at the size asked (or the file's own units, read as best they can be), turned with the
side asked on the bed, and written as STLs with their colours and a picture.

It runs in the worker's environment (numpy, trimesh, scipy); Blender is found on this Mac.
"""

import json
import math
import os
import re
import shutil
import subprocess

import numpy as np
import trimesh

import geom
from geom import r

HERE = os.path.dirname(os.path.abspath(__file__))
DUMP = os.path.join(HERE, "blend_dump.py")
VIA_BLENDER = (".blend", ".fbx", ".usd", ".usda", ".usdc", ".usdz")
"""Files only Blender reads here: report, view and section take them too."""
SCENE_EXTS = VIA_BLENDER + (".glb", ".gltf", ".obj")
"""Files with materials and textures worth splitting: convert and scene read these through Blender."""
SPLITS = ("auto", "material", "color", "object", "none")
UNIT_MM = {"mm": 1.0, "millimeter": 1.0, "millimeters": 1.0, "cm": 10.0, "centimeter": 10.0, "centimeters": 10.0,
           "m": 1000.0, "meter": 1000.0, "meters": 1000.0, "in": 25.4, "inch": 25.4, "inches": 25.4, '"': 25.4,
           "ft": 304.8, "foot": 304.8, "feet": 304.8}
BLENDER_UNITS = {"MILLIMETERS": "mm", "CENTIMETERS": "cm", "METERS": "m", "KILOMETERS": "km", "MICROMETERS": "µm",
                 "INCHES": "in", "FEET": "ft", "THOU": "thou", "MILES": "mi", "ADAPTIVE": "adaptive"}
MAJORITY = 0.85
"""A body under this much one part is reported as mixed (it still goes whole into one part unless bodies is cut)."""
MERGE_DIGITS = 4
"""Vertices within 0.0001 mm are one: a modifier's float noise doesn't break a body in two or leave it open."""
PLAUSIBLE = (3.0, 300.0)
"""A printed part's longest side, mm, that reads as meant: outside it, the units are likely wrong."""


class NoBlender(geom.Unreadable):
    pass


def blender():
    for p in (os.environ.get("MESH_BLENDER"), "/Applications/Blender.app/Contents/MacOS/Blender",
              os.path.expanduser("~/Applications/Blender.app/Contents/MacOS/Blender"), shutil.which("blender"),
              "/opt/homebrew/bin/blender"):
        if p and os.access(p, os.X_OK):
            return p
    raise NoBlender("reading this needs Blender, which isn't on this Mac (brew install --cask blender)")


def blender_version():
    try:
        out = subprocess.run([blender(), "-b", "--factory-startup", "--version"], capture_output=True, text=True, timeout=60).stdout
        m = re.search(r"Blender (\S+(?: LTS)?)", out)
        return m.group(1) if m else None
    except Exception:
        return None


def is_scene(path, splitting=False):
    low = path.lower()
    return low.endswith(SCENE_EXTS if splitting else VIA_BLENDER)


def extract(path, include=None, exclude=None, timeout=900, name=None):
    """What Blender shows of the file: (info, arrays) with arrays {verts (Blender units, world), faces, tri_obj,
    tri_mat, tri_rgb} or None when nothing in it is kept."""
    work = path + ".scene"
    os.makedirs(work, exist_ok=True)
    ext = os.path.splitext((name or "").lower())[1]
    if ext in SCENE_EXTS and not path.lower().endswith(ext):  # a blob came without its name: Blender goes by the ending
        linked = os.path.join(work, "model" + ext)
        if not os.path.exists(linked):
            os.symlink(os.path.abspath(path), linked)
        path = linked
    job_path, out_json, out_npz = (os.path.join(work, n) for n in ("job.json", "out.json", "out.npz"))
    with open(job_path, "w") as f:
        json.dump({"file": os.path.abspath(path), "include": include or [], "exclude": exclude or []}, f)
    cmd = [blender(), "-b", "--factory-startup", "--disable-autoexec"]
    if path.lower().endswith(".blend"):
        cmd.append(os.path.abspath(path))
    cmd += ["--python", DUMP, "--", job_path, out_json, out_npz]
    env = {k: v for k, v in os.environ.items() if not k.startswith("PYTHON")}
    try:
        p = subprocess.run(cmd, cwd=work, capture_output=True, text=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        raise geom.Unreadable(f"Blender took more than {timeout // 60} minutes to read {os.path.basename(path)}")
    if not os.path.exists(out_json):
        tail = (p.stderr or p.stdout or "").strip()[-600:]
        raise geom.Unreadable(f"Blender couldn't read {os.path.basename(path)} (exit {p.returncode}): {tail}")
    with open(out_json) as f:
        info = json.load(f)
    if not info.get("ok"):
        raise geom.Unreadable(f"Blender couldn't read {os.path.basename(path)}: {info.get('error')}")
    arrays = None
    if os.path.exists(out_npz):
        with np.load(out_npz) as z:
            arrays = {k: z[k] for k in z.files}
    return info, arrays


# Units and size


def unit_factor(info, units, extent_bu, ext):
    """(mm per unit of the file, how it was read, whether that's a guess)."""
    units = (units or "auto").strip().lower()
    if units in UNIT_MM:
        return UNIT_MM[units], f"read as {units} (as asked)", False
    u = info.get("units") or {}
    s = float(u.get("scale_length") or 1.0)
    shown = BLENDER_UNITS.get(u.get("length_unit"), str(u.get("length_unit") or "").lower())
    if units == "scene":
        return (1.0 if u.get("system") == "NONE" else s * 1000.0), "as the scene's unit settings say", False
    if units != "auto":
        raise ValueError(f"units is auto, scene, mm, cm, m, in or ft, not {units!r}")
    if ext in (".glb", ".gltf", ".fbx") or ext.startswith(".usd"):
        return s * 1000.0, f"in metres, as {ext[1:].upper()} files are", False
    if ext == ".obj":
        if PLAUSIBLE[0] <= extent_bu <= 2000:
            return 1.0, "as millimetres (OBJ files carry no units)", True
        return 1000.0, "as metres (OBJ files carry no units; as millimetres it'd be tiny)", True
    # a .blend
    if u.get("system") == "NONE":
        return 1.0, "as millimetres (the scene has no units: one Blender unit is one mm, as its STL export writes)", True
    if abs(s - 1.0) > 1e-9:
        mm = s * 1000.0
        return mm, f"as the scene's unit scale says ({s:g}: one Blender unit is {mm:g} mm)", False
    if shown and shown not in ("m", "adaptive"):
        return 1000.0, f"in metres, shown in {shown} (the scene's display unit)", False
    # Blender's default scene: metres, which nobody chose. One unit is a mm when that gives a likely size (Blender's
    # STL export writes units as mm, so models meant for print are often made that way), else a metre.
    as_mm, as_m = extent_bu, extent_bu * 1000.0
    if 8 <= as_mm <= 600:
        return 1.0, "as millimetres, one Blender unit to one mm as Blender's STL export writes it (the scene is Blender's default, metres)", True
    if 8 <= as_m <= 2000:
        return 1000.0, "in metres, as Blender's default scene has it (as millimetres it'd be tiny)", True
    if abs(math.log(max(as_mm, 1e-9) / 60)) <= abs(math.log(max(as_m, 1e-9) / 60)):
        return 1.0, "as millimetres, one Blender unit to one mm (neither mm nor metres gives a likely size)", True
    return 1000.0, "in metres, as Blender's default scene has it (neither mm nor metres gives a likely size)", True


LENGTH = re.compile(r"^\s*([0-9]*\.?[0-9]+)\s*([a-z\"]*)\s*$", re.I)
AXES = {"x": 0, "y": 1, "z": 2, "width": 0, "depth": 1, "height": 2, "tall": 2, "longest": None, "long": None}


def mm_of(v):
    if isinstance(v, (int, float)):
        return float(v)
    m = LENGTH.match(str(v))
    if not m:
        raise ValueError(f"can't read {v!r} as a length: give mm, or like \"30mm\", \"1.2 in\", \"3cm\"")
    unit = (m.group(2) or "mm").lower()
    if unit not in UNIT_MM:
        raise ValueError(f"can't read the unit in {v!r}: mm, cm, m, in or ft")
    return float(m.group(1)) * UNIT_MM[unit]


def size_target(size):
    """(axis or None for the longest side, mm) from 30, "1.2 in", {"z": 30} or {"height": "1.2in"}."""
    if size is None:
        return None
    if isinstance(size, dict):
        if len(size) != 1:
            raise ValueError("size names one side, like {\"z\": 30} (as it sits on the bed) or {\"longest\": 30}")
        (k, v), = size.items()
        k = str(k).lower()
        if k not in AXES:
            raise ValueError(f"size's side is x, y, z (height), or longest, not {k!r}")
        return AXES[k], mm_of(v)
    return None, mm_of(size)


# Colours


def srgb_to_lab(rgb):
    c = np.clip(np.asarray(rgb, np.float64), 0, 1)
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    M = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = lin @ M.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[:, 1] - 16, 500 * (f[:, 0] - f[:, 1]), 200 * (f[:, 1] - f[:, 2])], axis=1)


NAMED = {"black": "1A1A1A", "dark gray": "4A4A4A", "gray": "8A8A8A", "light gray": "C8C8C8", "white": "F4F4F4",
         "red": "C8202A", "dark red": "7A1A1E", "orange": "E8731C", "yellow": "F2D22E", "gold": "C9A23A",
         "brown": "6B4226", "dark brown": "3E2516", "tan": "C2A37A", "beige": "E6D7B9", "green": "3A9A3E",
         "dark green": "1F4D2A", "olive": "7A7A2E", "lime": "9BD13B", "teal": "1E8C85", "cyan": "3CC8DC",
         "light blue": "8EC5EC", "blue": "2A5CC8", "navy": "1C2A5A", "purple": "6E3AA8", "lavender": "B9A3E0",
         "pink": "F2A0B8", "magenta": "C8308E", "skin": "E8B898", "silver": "B4B8BC", "bronze": "9A6A32"}
NAMED_LAB = srgb_to_lab(np.array([[int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)] for h in NAMED.values()]))


def hexof(rgb):
    return "".join(f"{int(round(float(x) * 255)):02X}" for x in np.clip(rgb, 0, 1)[:3])


def rgb_of(hexs):
    return np.array([int(hexs[i:i + 2], 16) / 255 for i in (0, 2, 4)])


def color_name(rgb):
    lab = srgb_to_lab(np.asarray(rgb, float).reshape(1, 3))[0]
    d = np.linalg.norm(NAMED_LAB - lab, axis=1)
    return list(NAMED)[int(d.argmin())]


def typical(rgb, area):
    """The colour a set of triangles mostly shows: the area-weighted median of each channel."""
    if not len(rgb):
        return np.array([0.72, 0.75, 0.8])
    out = []
    order_w = area / max(area.sum(), 1e-12)
    for ch in range(3):
        o = np.argsort(rgb[:, ch])
        cw = np.cumsum(order_w[o])
        out.append(rgb[o[min(len(o) - 1, int(np.searchsorted(cw, 0.5)))], ch])
    return np.array(out)


def kmeans(x, w, k, seed=0, iters=40):
    """Weighted k-means (k-means++ start): (centres, labels)."""
    rng = np.random.default_rng(seed)
    p = w / w.sum()
    centres = [x[rng.choice(len(x), p=p)]]
    for _ in range(1, k):
        d2 = np.min([((x - c) ** 2).sum(1) for c in centres], axis=0)
        q = d2 * w
        if q.sum() <= 0:
            break
        centres.append(x[rng.choice(len(x), p=q / q.sum())])
    c = np.array(centres)
    labels = np.zeros(len(x), int)
    for _ in range(iters):
        d = ((x[:, None, :] - c[None, :, :]) ** 2).sum(2)
        new = d.argmin(1)
        if _ and np.array_equal(new, labels):
            break
        labels = new
        for j in range(len(c)):
            sel = labels == j
            if sel.any():
                c[j] = (x[sel] * w[sel, None]).sum(0) / w[sel].sum()
    return c, labels


LAB_W = np.array([0.5, 1.0, 1.0])
"""Colours are clustered in Lab with lightness counted half: a texture's baked shading makes one colour lighter and
darker, while another filament differs in hue and chroma too."""


def color_groups(rgb, area, k=None, max_k=6):
    """The distinct colours the triangles show, clustered in Lab (lightness counted half) by area: (labels per
    triangle, centres in that space, how). Without k, as many as stand clearly apart: each a real share of the
    surface, far from the others, and each one more explaining much of what's left."""
    lab = srgb_to_lab(rgb) * LAB_W
    w = np.maximum(area, 1e-12)
    n = len(lab)
    if n > 150_000:  # cluster a sample by area, then give every triangle its nearest centre
        rng = np.random.default_rng(1)
        idx = rng.choice(n, 150_000, replace=False, p=w / w.sum())
        xs, ws = lab[idx], np.ones(len(idx))
    else:
        xs, ws = lab, w
    total = ws.sum()

    def fit(kk):
        c, lab_s = kmeans(xs, ws, kk)
        inertia = float((((xs - c[lab_s]) ** 2).sum(1) * ws).sum() / total)
        share = np.bincount(lab_s, weights=ws, minlength=len(c)) / total
        return c, inertia, share

    if k:
        c, _, _ = fit(int(k))
        how = f"{len(c)} colours, as asked"
    else:
        c, inertia, _ = fit(1)
        how = "one colour"
        for kk in range(2, max_k + 1):
            c2, in2, share = fit(kk)
            if len(c2) < kk:  # k-means++ found no colour left apart from the centres it had: no more to split
                break
            gaps =[np.linalg.norm(c2[i] - c2[j]) for i in range(len(c2)) for j in range(i + 1, len(c2))]
            if share.min() < 0.005 or min(gaps) < 14 or in2 > inertia * 0.55:
                break
            c, inertia, how = c2, in2, f"{kk} colours stand apart"
    d = ((lab[:, None, :] - c[None, :, :]) ** 2).sum(2)
    return d.argmin(1), c, how


def lab_to_srgb(lab):
    lab = np.atleast_2d(lab)
    fy = (lab[:, 0] + 16) / 116
    fx, fz = fy + lab[:, 1] / 500, fy - lab[:, 2] / 200
    f = np.stack([fx, fy, fz], 1)
    xyz = np.where(f ** 3 > 0.008856, f ** 3, (f - 16 / 116) / 7.787) * np.array([0.95047, 1.0, 1.08883])
    M = np.linalg.inv(np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]]))
    lin = np.clip(xyz @ M.T, 0, 1)
    return np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055)


# Splitting


def body_labels(verts, faces, tri_obj):
    """Each triangle's body: the connected pieces of each object, vertices at one place merged (a UV seam doesn't
    split a body)."""
    out = np.empty(len(faces), np.int64)
    nxt = 0
    for oi in np.unique(tri_obj):
        sel = np.nonzero(tri_obj == oi)[0]
        m = trimesh.Trimesh(verts, faces[sel], process=False)
        m.merge_vertices(merge_tex=True, merge_norm=True, digits_vertex=MERGE_DIGITS)
        lab = trimesh.graph.connected_component_labels(m.face_adjacency, node_count=len(m.faces))
        out[sel] = lab + nxt
        nxt += int(lab.max()) + 1 if len(lab) else 0
    return out


def safe(text, fallback="part"):
    s = re.sub(r"-+", "-", re.sub(r"[^A-Za-z0-9._-]+", "-", str(text or ""))).strip("-.")
    return (s or fallback)[:48]


def material_spread(rgb, area, tri_mat, materials):
    """For each material: its typical colour, and whether its own surface shows more than one colour (a painted texture)."""
    out = {}
    for g in np.unique(tri_mat):
        sel = tri_mat == g
        info = materials[g] if 0 <= g < len(materials) else {"name": None, "source": "none"}
        t = typical(rgb[sel], area[sel])
        multi = None
        if info.get("source") in ("texture", "attribute") and sel.sum() >= 8:
            lab, cs, _ = color_groups(rgb[sel], area[sel], max_k=4)
            if len(cs) > 1:
                shares = np.bincount(lab, weights=area[sel], minlength=len(cs)) / area[sel].sum()
                multi = [{"hex": hexof(lab_to_srgb(c / LAB_W)[0]), "name": color_name(lab_to_srgb(c / LAB_W)[0]), "share": r(s, 3)}
                         for c, s in sorted(zip(cs, shares), key=lambda t: -t[1])]
        out[int(g)] = {"hex": hexof(t), "name": color_name(t), "colors": multi,
                       "area_share": r(area[sel].sum() / area.sum(), 3)}
    return out


def labels_for(split, data, info, area, colors=None):
    """Each triangle's part, and each part's {key, name, hex}, for the split asked ("auto" decided here). Also says how."""
    rgb, tri_mat, tri_obj = data["tri_rgb"], data["tri_mat"], data["tri_obj"]
    materials = info["materials"]
    spread = material_spread(rgb, area, tri_mat, materials)
    used = sorted(spread)
    how = None
    if split == "auto":
        painted = [materials[g]["name"] or "its material" for g in used if spread[g]["colors"]]
        if painted:
            who = painted[0] if len(painted) == 1 else ", ".join(painted[:-1]) + " and " + painted[-1]
            split, how = "color", f"by colour: {who} {'is' if len(painted) == 1 else 'are'} painted in several colours"
        elif len(used) > 1:
            split, how = "material", f"by material: {len(used)} materials"
        else:
            split, how = "none", "one part: one material, one colour"
    if split == "material":
        keys = tri_mat.astype(np.int64)
        parts = {}
        for g in used:
            nm = (materials[g]["name"] if 0 <= g < len(materials) else None) or "no material"
            parts[g] = {"name": nm, "hex": spread[g]["hex"], "color": spread[g]["name"], "material": nm,
                        "painted": spread[g]["colors"]}
        how = how or f"by material: {len(used)} material{'s' if len(used) != 1 else ''}"
    elif split == "color":
        keys, centres, found = color_groups(rgb, area, k=colors)
        parts = {}
        for j, c in enumerate(centres):
            sel = keys == j
            t = typical(rgb[sel], area[sel]) if sel.any() else lab_to_srgb(c / LAB_W)[0]
            parts[j] = {"name": color_name(t), "hex": hexof(t), "color": color_name(t)}
        how = how or f"by colour: {found}"
    elif split == "object":
        keys = tri_obj.astype(np.int64)
        parts = {}
        for oi in np.unique(tri_obj):
            sel = tri_obj == oi
            t = typical(rgb[sel], area[sel])
            parts[int(oi)] = {"name": info["kept"][oi], "hex": hexof(t), "color": color_name(t), "object": info["kept"][oi]}
        how = how or f"by object: {len(parts)}"
    elif split == "none":
        keys = np.zeros(len(tri_mat), np.int64)
        t = typical(rgb, area)
        parts = {0: {"name": "all", "hex": hexof(t), "color": color_name(t)}}
        how = how or "one part, as asked"
    else:
        raise ValueError(f"split is one of {', '.join(SPLITS)}")
    return keys, parts, split, how, spread


def assign_bodies(keys, bodies, area, lightness, majority=MAJORITY, clear=0.75, lit=0.4):
    """Each body whole into one part, so parts are closed where bodies are: the part most of its surface is when
    that's at least `clear` of it; else the part most of its best-lit `lit` share is (a texture's baked shadow only
    darkens, so the lit surface shows what colour it's meant to be). Answers the new keys and the bodies that
    weren't at least `majority` one part, with their shares, what they went into and why."""
    nb = int(bodies.max()) + 1 if len(bodies) else 0
    kmax = int(keys.max()) + 1 if len(keys) else 1
    share = np.zeros((nb, kmax))
    np.add.at(share, (bodies, keys), area)
    tot = np.maximum(share.sum(1), 1e-12)
    frac = share / tot[:, None]
    top = frac.argmax(1)
    went = top.copy()
    why = ["most of its surface"] * nb
    for b in np.nonzero(frac.max(1) < clear)[0]:
        sel = np.nonzero(bodies == b)[0]
        L, a = lightness[sel], area[sel]
        o = np.argsort(L)
        cw = np.cumsum(a[o]) / a.sum()
        brightest = sel[o[np.searchsorted(cw, 1 - lit):]]
        v = np.bincount(keys[brightest], weights=area[brightest], minlength=kmax)
        if v.sum() > 0:
            went[b] = int(v.argmax())
            why[b] = f"{v.max() / v.sum():.0%} of its best-lit surface (the rest reads as shading)"
    mixed = []
    for b in np.nonzero(frac.max(1) < majority)[0]:
        mixed.append({"body": int(b), "area": float(tot[b]), "went": int(went[b]), "why": why[b],
                      "shares": {int(k): r(v, 3) for k, v in enumerate(frac[b]) if v >= 0.005}})
    return went[bodies], mixed


def place(verts_mm, down, size, faces):
    """The one transform for every part: the side asked on the bed, at the size asked, at z=0. Answers
    (4x4, scale applied, down used, orientation table)."""
    whole = trimesh.Trimesh(verts_mm, faces, process=False)
    table = None
    if down == "auto":
        probe = whole
        if len(whole.faces) > 300_000:
            probe = whole.simplify_quadric_decimation(face_count=200_000) if hasattr(whole, "simplify_quadric_decimation") else whole
        down, table = geom.orientations(probe)
    if down not in geom.DOWNS:
        raise ValueError(f"down is one of {', '.join(geom.DOWNS)} or auto")
    T = np.eye(4)
    rot = geom.DOWNS[down]
    if rot is not None:
        T = trimesh.transformations.rotation_matrix(rot[0], rot[1])
    v = verts_mm @ T[:3, :3].T
    ext = v.max(0) - v.min(0)
    k = 1.0
    if size is not None:
        axis, mm = size
        have = float(ext.max() if axis is None else ext[axis])
        if have <= 0:
            raise ValueError("it has no extent to size")
        k = mm / have
    S = np.diag([k, k, k, 1.0])
    T = S @ T
    v = verts_mm @ T[:3, :3].T
    T[:3, 3] = [0, 0, -v[:, 2].min()]
    return T, k, down, table


def part_mesh(verts, faces):
    m = trimesh.Trimesh(verts, faces, process=False)
    m.merge_vertices(merge_tex=True, merge_norm=True, digits_vertex=MERGE_DIGITS)
    m.remove_unreferenced_vertices()
    return m


def facts_of(m):
    h = geom.mesh_health(m)
    try:
        nb = len(trimesh.graph.connected_components(m.face_adjacency, nodes=np.arange(len(m.faces)), min_len=1))
    except Exception:
        nb = None
    vol = abs(float(m.volume)) if h["watertight"] else None
    return {"size_mm": [r(x) for x in m.extents], "triangles": int(len(m.faces)), "watertight": h["watertight"],
            "open_edges": h["open_edges"], "bodies": nb, "volume_cm3": r(vol / 1000, 3) if vol is not None else None}


def render_sheet(meshes, out_path, title, views=("iso", "front", "top"), parts=None, size=600):
    """One picture: the whole thing in its colours from a few sides, and each part on its own under it."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as P
    whole = trimesh.util.concatenate([m for m, _ in meshes]) if len(meshes) > 1 else meshes[0][0]
    face_rgb = np.concatenate([np.asarray(c, float) if np.ndim(c) == 2 else np.tile(np.asarray(c, float), (len(m.faces), 1))
                               for m, c in meshes])
    solo = (parts or [])[:4]
    cols = max(len(views), len(solo))
    rows = 2 if solo else 1
    fig, axs = P.subplots(rows, cols, figsize=(cols * size / 100, rows * size * 0.78 / 100 + 0.5), dpi=100, squeeze=False)
    for ax in axs.flat:
        ax.axis("off")
    titles = {"iso": "As printed", "front": "From the front", "top": "From above"}
    for k, v in enumerate(views):
        img, _ = geom.render(whole, v, width=size, height=int(size * 0.75), face_rgb=face_rgb)
        axs[0][k].imshow(img)
        axs[0][k].set_title(titles.get(v, v), fontsize=11, fontweight="bold")
    for k, (m, rgb, label) in enumerate(solo):
        img, _ = geom.render(m, "iso", width=size, height=int(size * 0.75), face_rgb=np.tile(np.asarray(rgb, float), (len(m.faces), 1)))
        axs[1][k].imshow(img)
        axs[1][k].set_title(label, fontsize=10)
    fig.suptitle(title, fontsize=13, fontweight="bold", x=0.01, ha="left")
    fig.tight_layout(rect=(0, 0, 1, 0.95))
    fig.savefig(out_path, dpi=100)
    P.close(fig)
    return out_path


def objects_summary(info):
    """Every object in a few words: kept or why not, for the answer."""
    rows = []
    for o in info["objects"]:
        if o["type"] in ("camera", "light", "empty", "lightprobe", "speaker", "armature") and not o.get("kept_as"):
            continue
        rows.append({"name": o["name"], "type": o["type"], "kept": bool(o.get("kept_as")), "why_not": o["why_not"] or None,
                     "note": o.get("note"),
                     "collection": o.get("collection"), "materials": [m for m in o["materials"] if m] or None,
                     "modifiers": [m["type"] for m in o["modifiers"]] or None, "triangles": o.get("triangles"),
                     "size_bu": o.get("size_bu"), "instances": o.get("instances") or None})
    return rows


def read_scene(path, name, include=None, exclude=None, units="auto"):
    """The file read and measured, before any split: info, arrays, area per triangle, the factor to mm and how."""
    info, data = extract(path, include, exclude, name=name)
    if data is None or not len(data["faces"]):
        shown = [o for o in objects_summary(info) if o["type"] in ("mesh", "curve", "font", "surface", "meta")]
        names = ", ".join(f"{o['name']} ({'; '.join(o['why_not'] or [])})" for o in shown[:10])
        raise geom.Unreadable(f"nothing in {name} to print with what was asked" + (f": it has {names}" if names else "")
                              + ("; give include with the objects' names" if shown else ""))
    v = data["verts"].astype(np.float64)
    ext_bu = float((v.max(0) - v.min(0)).max())
    ext = os.path.splitext(name.lower())[1] or os.path.splitext(path.lower())[1]
    mm, how, guessed = unit_factor(info, units, ext_bu, ext)
    vm = v * mm
    tris = vm[data["faces"]]
    area = np.linalg.norm(np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0]), axis=1) / 2
    return info, data, vm, area, {"mm_per_unit": mm, "how": how, "guessed": guessed, "extent_units": r(ext_bu, 4),
                                   "modeled_mm": [r(x, 1) for x in (vm.max(0) - vm.min(0))]}


def materials_out(info, spread):
    return [{"name": m["name"], "source": m["source"], "hex": spread.get(i, {}).get("hex", m["hex"]),
             "colors": spread.get(i, {}).get("colors"), "image": m.get("image"), "note": m.get("note"),
             "area_share": spread.get(i, {}).get("area_share")} for i, m in enumerate(info["materials"]) if i in spread]


def mixed_out(mixed, parts, bodies, faces, verts):
    """The bodies that weren't one part, in words a reader can place: how big, where, what they read as, where they went."""
    out = []
    for b in sorted(mixed, key=lambda b: -b["area"]):
        v = verts[np.unique(faces[bodies == b["body"]])]
        lo, hi = v.min(0), v.max(0)
        out.append({"size_mm": [r(x, 1) for x in hi - lo], "center": [r(x, 1) for x in (lo + hi) / 2],
                    "reads": {parts[k]["name"]: s for k, s in b["shares"].items() if k in parts},
                    "went": parts[b["went"]]["name"] if b["went"] in parts else None, "why": b["why"]})
    return out


def split_scene(job):
    """convert for a scene file: STLs per part, their colours, a picture, and how the slicer takes them."""
    path, name = job["file"], job["name"]
    info, data, vm, area, units = read_scene(path, name, job.get("include"), job.get("exclude"), job.get("units"))
    faces = data["faces"].astype(np.int64)
    split = (job.get("split") or "auto").lower()
    keys, parts, split_used, how, spread = labels_for(split, data, info, area, job.get("colors"))
    bodies = body_labels(vm, faces, data["tri_obj"])
    mode = (job.get("bodies") or "whole").lower()
    if mode not in ("whole", "cut"):
        raise ValueError("bodies is whole (each body into one part: closed parts) or cut (cut along the colours: open surfaces)")
    mixed = []
    if split_used != "none":
        whole_keys, mixed = assign_bodies(keys, bodies, area, srgb_to_lab(data["tri_rgb"])[:, 0], float(job.get("majority") or MAJORITY))
        if mode == "whole":
            keys = whole_keys
    scale_given = job.get("scale")
    size = size_target(job.get("size"))
    if scale_given and size:
        raise ValueError("give size or scale, not both")
    if scale_given:
        vm = vm * float(scale_given)
        units["how"] += f", then scaled ×{float(scale_given):g}"
    T, k, down, table = place(vm, job.get("down") or "z-", size, faces)
    vt = vm @ T[:3, :3].T + T[:3, 3]
    if job.get("center"):
        c = (vt.max(0) + vt.min(0)) / 2
        vt[:, 0] -= c[0]
        vt[:, 1] -= c[1]
    os.makedirs(job["out_dir"], exist_ok=True)
    stem = safe(job.get("stem") or os.path.splitext(name)[0], "model")
    out, meshes, solo = [], [], []
    present = [kk for kk in parts if (keys == kk).any()]
    present.sort(key=lambda kk: -area[keys == kk].sum())
    used_names = {}
    for kk in present:
        sel = np.nonzero(keys == kk)[0]
        p = parts[kk]
        m = part_mesh(vt, faces[sel])
        base = safe(p["name"])
        used_names[base] = used_names.get(base, 0) + 1
        if used_names[base] > 1:
            base = f"{base}-{used_names[base]}"
        fname = f"{stem}.stl" if len(present) == 1 else f"{stem}-{base}.stl"
        fpath = os.path.join(job["out_dir"], fname)
        m.export(fpath)
        rgb = rgb_of(p["hex"])
        meshes.append((m, rgb))
        solo.append((m, rgb, f"{fname} · {p['color']} #{p['hex']}"))
        entry = {"name": fname, "path": fpath, "part": p["name"], "hex": p["hex"], "color": p["color"], **facts_of(m),
                 "area_share": r(area[sel].sum() / area.sum(), 3)}
        for key in ("material", "object"):
            if p.get(key):
                entry[key] = p[key]
        out.append(entry)
    # How the slicer takes them: one object of these parts kept in place, each colour its own filament, biggest first
    filament_of, colors = {}, []
    for e in out:
        if e["hex"] not in filament_of:
            filament_of[e["hex"]] = len(colors) + 1
            colors.append(e["hex"])
        e["filament"] = filament_of[e["hex"]]
    joined = "+".join(e["name"] + (f"@{e['filament']}" if e["filament"] > 1 else "") for e in out)
    slicer = {"parts": [joined], "color": colors if len(colors) > 1 else colors[0], "machine": "p1s" if len(colors) > 1 else "p1p"}
    whole = trimesh.Trimesh(vt, faces, process=False)
    total = {"size_mm": [r(x) for x in whole.extents], "mm_per_unit": r(k * units["mm_per_unit"] * float(scale_given or 1), 6),
             "down": down, "bed": geom.bed_fit(whole.extents)}
    sheet = None
    if job.get("sheet"):
        sheet = render_sheet(meshes, job["sheet"], f"{name}: {len(out)} part{'s' if len(out) != 1 else ''}, "
                             f"{' × '.join(f'{x:g}' for x in total['size_mm'])} mm", parts=solo if len(solo) > 1 else None)
    return {"files": out, "stem": stem, "split": split_used, "how": how, "bodies_mode": mode, "asked": bool(job.get("include")), "units": units, "total": total,
            "slicer": slicer, "mixed": mixed_out(mixed, parts, bodies, faces, vt), "materials": materials_out(info, spread),
            "objects": objects_summary(info), "kept": info["kept"], "blender": info.get("blender"), "sheet": sheet,
            "orientations": table, "bodies": int(bodies.max()) + 1 if len(bodies) else 0}


def look(job):
    """scene: what's in the file and what convert would make of it by default, with a picture in its own colours."""
    path, name = job["file"], job["name"]
    info, data, vm, area, units = read_scene(path, name, job.get("include"), job.get("exclude"), job.get("units"))
    faces = data["faces"].astype(np.int64)
    keys, parts, split_used, how, spread = labels_for("auto", data, info, area)
    bodies = body_labels(vm, faces, data["tri_obj"])
    mixed = []
    if split_used != "none":
        keys, mixed = assign_bodies(keys, bodies, area, srgb_to_lab(data["tri_rgb"])[:, 0])
    T, _, _, _ = place(vm, "z-", None, faces)
    vt = vm @ T[:3, :3].T + T[:3, 3]
    whole = trimesh.Trimesh(vt, faces, process=False)
    sheet = None
    if job.get("sheet"):
        sheet = render_sheet([(whole, data["tri_rgb"].astype(float))], job["sheet"],
                             f"{name}: as Blender shows it, {' × '.join(f'{r(e, 1):g}' for e in whole.extents)} mm as read")
    would = []
    for kk in sorted(parts, key=lambda kk: -area[keys == kk].sum()):
        sel = keys == kk
        if sel.any():
            would.append({"part": parts[kk]["name"], "hex": parts[kk]["hex"], "area_share": r(area[sel].sum() / area.sum(), 3)})
    per_object = []
    for oi, label in enumerate(info["kept"]):
        sel = data["tri_obj"] == oi
        v = vt[np.unique(faces[sel])]
        per_object.append({"object": label, "size_mm": [r(x, 1) for x in (v.max(0) - v.min(0))], "triangles": int(sel.sum()),
                           "area_share": r(area[sel].sum() / area.sum(), 3)})
    return {"units": units, "size_mm": [r(x, 1) for x in whole.extents], "triangles": int(len(faces)),
            "bodies": int(bodies.max()) + 1 if len(bodies) else 0, "kept": per_object, "objects": objects_summary(info),
            "materials": materials_out(info, spread),
            "would_split": {"split": split_used, "how": how, "parts": would, "mixed": mixed_out(mixed, parts, bodies, faces, vt)},
            "blender": info.get("blender"), "sheet": sheet}


def load_models(path, name, objects="each"):
    """geom.load for a scene file: one model per object Blender shows (or one of them all), in mm as read."""
    info, data, vm, area, units = read_scene(path, name)
    faces = data["faces"].astype(np.int64)
    note = f"read through Blender, {units['how']}"
    if objects == "merged" or len(info["kept"]) == 1:
        m = part_mesh(vm, faces)
        return [{"name": name, "mesh": m, "source": name, "left_out": [], "note": note, "units_read": units}]
    out = []
    for oi, label in enumerate(info["kept"]):
        sel = data["tri_obj"] == oi
        out.append({"name": f"{name} › {label}", "mesh": part_mesh(vm, faces[sel]), "source": name, "left_out": [],
                    "note": note, "units_read": units})
    return out
