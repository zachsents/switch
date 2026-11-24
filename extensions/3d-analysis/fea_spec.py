"""What a study asks, checked here before anything is rented: the materials (from the makers' datasheets), each
part's STL (read, measured and its bodies counted, in plain Python), the load and its selectors (tried on the
part's own vertices, so one that takes nothing fails now, not on the box).
"""

import math
import os
import re
import struct

# Every value from the maker's technical data sheet (ISO 527 tensile tests on printed bars, 100% infill), the
# in-plane (X-Y) modulus as the default; Z (across layers) is lower and the strength across layers is what fails
# first. Poisson's ratio isn't on these sheets: the usual figure for each polymer.
MATERIALS = {
    "pla": {"name": "PLA", "E": 2680.0, "nu": 0.35, "model": "linear", "density": 1.24, "strength": 39.0,
            "strength_z": 35.0, "elongation": 0.122, "E_z": 2160.0,
            "source": "Bambu PLA Basic TDS v2: Young's modulus 2680 MPa X-Y, 2160 Z; tensile strength 39 / 35 MPa"},
    "petg": {"name": "PETG", "E": 2311.0, "nu": 0.38, "model": "linear", "density": 1.27, "strength": 47.9,
             "strength_z": 45.7, "elongation": 0.093, "E_z": 2200.0,
             "source": "Overture PETG TDS v5.2 (Dec 2025): Young's modulus 2311 MPa X-Y, 2200 Z; tensile strength 47.9 / 45.7 MPa"},
    "asa": {"name": "ASA", "E": 2450.0, "nu": 0.35, "model": "linear", "density": 1.05, "strength": 52.0,
            "strength_z": 35.0, "elongation": 0.092, "E_z": 2120.0,
            "source": "Bambu ASA TDS v2: Young's modulus 2450 MPa X-Y, 2120 Z; tensile strength 52 / 35 MPa"},
    "tpu": {"name": "TPU 95A", "E": 26.0, "nu": 0.45, "model": "neo-hooke", "density": 1.21, "strength": 29.1,
            "elongation": 3.32,
            "source": "TPU 95A: tensile modulus 26 MPa (Ultimaker TPU 95A TDS, molded bars). Printed 95A runs 56-67 MPa "
                      "at small strain (Ultimaker's newer TDS); the 9-10 MPa on Bambu's and Overture's sheets is the "
                      "stress at 100% stretch. Overture TPU TDS: strength 29.1 MPa, 332% to break"},
}
ALIASES = {"tpu95a": "tpu", "tpu-95a": "tpu", "flex": "tpu", "pla+": "pla", "pla-basic": "pla", "petg-hf": "petg"}

LOAD_TYPES = ("press", "bore", "pin")
SELECTOR_KEYS = {"side", "depth", "box", "near", "radius", "cylinder", "all", "any", "not", "surface"}
LOAD_KEYS = {
    "press": {"type", "fix", "move", "direction", "travel", "rigid", "steps", "nonlinear", "at", "frames", "large", "solver"},
    "bore": {"type", "diameter", "axis", "center", "span", "fix", "friction", "slide", "from_end", "entry_radius", "pull",
             "depth", "at", "steps", "frames", "penalty", "nonlinear", "solver"},
}
LOAD_KEYS["pin"] = LOAD_KEYS["bore"]
MESH_KEYS = {"size", "min", "max", "per_wall", "budget", "body", "check"}
PART_EXT = (".stl", ".step", ".stp")
NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


class SpecError(ValueError):
    pass


def material(spec):
    """A material by name (pla, petg, asa, tpu) or as {E, nu, model?, density?, strength?, ...}, which may also
    start from one by name ({base: "petg", E: 2000})."""
    if spec is None:
        raise SpecError("material: name one (pla, petg, asa, tpu) or give {E, nu}")
    if isinstance(spec, str):
        key = ALIASES.get(spec.strip().lower(), spec.strip().lower())
        if key not in MATERIALS:
            raise SpecError(f"material {spec!r}: one of {', '.join(MATERIALS)}, or {{E, nu}} for another")
        return dict(MATERIALS[key], key=key)
    if not isinstance(spec, dict):
        raise SpecError("material: a name or an object")
    base = {}
    if spec.get("base"):
        base = material(spec["base"])
    out = dict(base)
    out.update({k: v for k, v in spec.items() if k != "base"})
    for k in ("E", "nu"):
        if out.get(k) is None:
            raise SpecError(f"material: {k} is missing")
        out[k] = float(out[k])
    if not 0 < out["E"] < 1e6:
        raise SpecError("material: E is in MPa (PETG is about 2300)")
    if not 0 <= out["nu"] < 0.5:
        raise SpecError("material: nu (Poisson's ratio) is between 0 and 0.5")
    out.setdefault("model", "linear")
    if out["model"] not in ("linear", "neo-hooke"):
        raise SpecError("material.model: linear or neo-hooke")
    out.setdefault("name", out.get("key") or "custom")
    if not base:
        out["source"] = out.get("source") or "given"
    elif any(k in spec for k in ("E", "nu", "model")):
        out["source"] = f"{base.get('source')}; changed: " + ", ".join(f"{k} {spec[k]}" for k in ("E", "nu", "model") if k in spec)
    return out


# ---------------------------------------------------------------------------------------------
# STL


def read_stl(path):
    """An STL's triangles as [(v0, v1, v2)] of float triples, binary or ASCII."""
    with open(path, "rb") as f:
        data = f.read()
    if len(data) < 84:
        raise SpecError(f"{os.path.basename(path)} is too short to be an STL")
    n = struct.unpack_from("<I", data, 80)[0]
    if len(data) == 84 + 50 * n:
        tris = []
        for i in range(n):
            v = struct.unpack_from("<12f", data, 84 + 50 * i)
            tris.append(((v[3], v[4], v[5]), (v[6], v[7], v[8]), (v[9], v[10], v[11])))
        return tris
    text = data.decode("ascii", "replace")
    if "facet" not in text[:2000] and "vertex" not in text[:4000]:
        raise SpecError(f"{os.path.basename(path)} isn't an STL (neither binary nor ASCII)")
    vs = [tuple(float(x) for x in m.groups()) for m in
          re.finditer(r"vertex\s+(\S+)\s+(\S+)\s+(\S+)", text)]
    if len(vs) % 3:
        raise SpecError(f"{os.path.basename(path)}: its ASCII facets don't come in threes")
    return [(vs[i], vs[i + 1], vs[i + 2]) for i in range(0, len(vs), 3)]


def stl_stats(path):
    """What a part is: its triangles, size, volume, separate bodies and whether it's closed, and its vertices."""
    tris = read_stl(path)
    if not tris:
        raise SpecError(f"{os.path.basename(path)} holds no triangles")
    index, verts = {}, []
    faces = []
    for t in tris:
        ids = []
        for v in t:
            key = (round(v[0] * 1e4), round(v[1] * 1e4), round(v[2] * 1e4))
            i = index.get(key)
            if i is None:
                i = index[key] = len(verts)
                verts.append(v)
            ids.append(i)
        if len(set(ids)) == 3:
            faces.append(ids)
    parent = list(range(len(verts)))

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    edges = {}
    vol = 0.0
    for a, b, c in faces:
        for x, y in ((a, b), (b, c), (c, a)):
            k = (x, y) if x < y else (y, x)
            edges[k] = edges.get(k, 0) + 1
        ra, rb, rc = root(a), root(b), root(c)
        parent[rb] = ra
        parent[root(c)] = ra
        p, q, r = verts[a], verts[b], verts[c]
        vol += (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6
    roots = [root(f[0]) for f in faces]
    body_vol = {}
    for f, rt in zip(faces, roots):
        p, q, r = verts[f[0]], verts[f[1]], verts[f[2]]
        body_vol[rt] = body_vol.get(rt, 0.0) + (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0])
                                                + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6
    bodies = len(body_vol)
    lo = [min(v[k] for v in verts) for k in range(3)]
    hi = [max(v[k] for v in verts) for k in range(3)]
    open_edges = sum(1 for c in edges.values() if c != 2)
    return {"triangles": len(tris), "bbox": [lo, hi], "size": [round(hi[k] - lo[k], 3) for k in range(3)],
            "volume_mm3": round(abs(vol), 2), "bodies": bodies, "watertight": open_edges == 0,
            "open_edges": open_edges, "vertices": verts, "faces": faces, "_roots": roots,
            "_bodies": sorted(body_vol, key=lambda k: -abs(body_vol[k]))}


def pick_body(stats, index):
    """The stats of one body of a file holding several (0 the largest by volume), as the box picks it."""
    if index is None or stats["bodies"] <= 1:
        return stats
    if index >= stats["bodies"]:
        raise SpecError(f"mesh.body {index}: the file has only {stats['bodies']} bodies")
    want = stats["_bodies"][index]
    faces = [f for f, rt in zip(stats["faces"], stats["_roots"]) if rt == want]
    used = sorted({i for f in faces for i in f})
    verts = [stats["vertices"][i] for i in used]
    renum = {i: k for k, i in enumerate(used)}
    lo = [min(v[k] for v in verts) for k in range(3)]
    hi = [max(v[k] for v in verts) for k in range(3)]
    return dict(stats, vertices=verts, faces=[[renum[i] for i in f] for f in faces], bbox=[lo, hi],
                size=[round(hi[k] - lo[k], 3) for k in range(3)], bodies=1, body=index)


# ---------------------------------------------------------------------------------------------
# Selectors, tried on the part's vertices


AXES = {"x": 0, "y": 1, "z": 2}


def side(text):
    m = re.fullmatch(r"([+-]?)([xyz])", str(text).strip().lower())
    if not m:
        raise SpecError(f"side {text!r}: +x, -x, +y, -y, +z or -z")
    return AXES[m.group(2)], -1 if m.group(1) == "-" else 1


def check_selector(sel, where):
    if not isinstance(sel, dict) or not sel:
        raise SpecError(f"{where}: a selector like {{side: '-z', depth: 0.5}}")
    unknown = set(sel) - SELECTOR_KEYS
    if unknown:
        raise SpecError(f"{where}: no {', '.join(sorted(unknown))} in a selector (side, depth, box, near, radius, "
                        "cylinder, all, any, not, surface)")
    if not set(sel) & {"side", "box", "near", "cylinder", "all", "any", "not"}:
        raise SpecError(f"{where}: say what to take: side, box, near, cylinder, all, any or not")
    if "side" in sel:
        side(sel["side"])
    if "box" in sel:
        if not isinstance(sel["box"], dict) or set(sel["box"]) - set(AXES):
            raise SpecError(f"{where}.box: {{x: [lo, hi], y: .., z: ..}}, null for no bound")
    if "near" in sel and (not isinstance(sel["near"], list) or len(sel["near"]) != 3):
        raise SpecError(f"{where}.near: a point [x, y, z]")
    for k in ("all", "any"):
        if k in sel:
            if not isinstance(sel[k], list) or not sel[k]:
                raise SpecError(f"{where}.{k}: a list of selectors")
            for i, s in enumerate(sel[k]):
                check_selector(s, f"{where}.{k}[{i}]")
    if "not" in sel:
        check_selector(sel["not"], f"{where}.not")


def selects(sel, v, lo, hi):
    """Whether a selector takes a point (by the engine's own rules)."""
    ok = True
    if "all" in sel:
        ok &= all(selects(s, v, lo, hi) for s in sel["all"])
    if "any" in sel:
        ok &= any(selects(s, v, lo, hi) for s in sel["any"])
    if "not" in sel:
        ok &= not selects(sel["not"], v, lo, hi)
    if "side" in sel:
        ax, sign = side(sel["side"])
        depth = float(sel.get("depth", 0.5))
        ok &= v[ax] <= lo[ax] + depth if sign < 0 else v[ax] >= hi[ax] - depth
    if "box" in sel:
        for k, rng in sel["box"].items():
            a, b = (list(rng) + [None, None])[:2]
            if a is not None and v[AXES[k]] < float(a):
                ok = False
            if b is not None and v[AXES[k]] > float(b):
                ok = False
    if "near" in sel:
        p = sel["near"]
        ok &= math.dist(v, p) <= float(sel.get("radius", 1.0))
    if "cylinder" in sel:
        c = sel["cylinder"]
        ax = AXES[c.get("axis", "z")]
        center = c.get("center") or [(lo[k] + hi[k]) / 2 for k in range(3)]
        o = [k for k in range(3) if k != ax]
        r = math.hypot(v[o[0]] - center[o[0]], v[o[1]] - center[o[1]])
        s = v[ax] - center[ax]
        for val, key in ((r, "r"), (s, "s")):
            rng = c.get(key)
            if rng:
                if rng[0] is not None and val < float(rng[0]):
                    ok = False
                if rng[1] is not None and val > float(rng[1]):
                    ok = False
    return ok


def count(sel, stats):
    lo, hi = stats["bbox"]
    return sum(1 for v in stats["vertices"] if selects(sel, v, lo, hi))


# ---------------------------------------------------------------------------------------------
# The load


def load(spec):
    if not isinstance(spec, dict):
        raise SpecError("load: an object, {type: press | bore | pin, ...}")
    t = spec.get("type")
    if t not in LOAD_TYPES:
        raise SpecError(f"load.type: press (push one region, hold another), bore (into a rigid hole) or pin (over a "
                        f"rigid pin), not {t!r}")
    unknown = set(spec) - LOAD_KEYS[t]
    if unknown:
        raise SpecError(f"load: {t} takes no {', '.join(sorted(unknown))} (it takes {', '.join(sorted(LOAD_KEYS[t] - {'type'}))})")
    out = dict(spec)
    if t == "press":
        for k in ("fix", "move"):
            check_selector(spec.get(k), f"load.{k}")
        d = spec.get("direction")
        if isinstance(d, str):
            side(d)
        elif not (isinstance(d, list) and len(d) == 3 and any(float(x) for x in d)):
            raise SpecError("load.direction: an axis like -z, or a vector [x, y, z]")
        if not spec.get("travel") or float(spec["travel"]) <= 0:
            raise SpecError("load.travel: how far the move region goes, in mm (more than 0)")
    else:
        if not spec.get("diameter") or float(spec["diameter"]) <= 0:
            raise SpecError(f"load.diameter: the {t}'s diameter in mm")
        if str(spec.get("axis", "z")) not in AXES:
            raise SpecError("load.axis: x, y or z (turn the part so its axis is one of them)")
        out["axis"] = str(spec.get("axis", "z"))
        if spec.get("fix") is not None:
            check_selector(spec["fix"], "load.fix")
        elif spec.get("slide"):
            raise SpecError("load.fix: sliding needs what holds the part (its foot, say {side: '-z', depth: 1})")
        if spec.get("span") is not None and (not isinstance(spec["span"], list) or len(spec["span"]) != 2):
            raise SpecError("load.span: [from, to] along the axis, where the wall reaches")
        if spec.get("center") is not None and (not isinstance(spec["center"], list) or len(spec["center"]) != 3):
            raise SpecError("load.center: a point [x, y, z] on the axis")
        if not 0 <= float(spec.get("friction", 0.5)) <= 2:
            raise SpecError("load.friction: a coefficient, 0 to 2")
        if str(spec.get("from_end", "+")) not in ("+", "-"):
            raise SpecError("load.from_end: + (the wall comes from the axis's + end) or -")
    return out


def check_against(load_, stats, name):
    """What a load does to this part, before anything's rented: errors for a selector that takes nothing or a fit
    that doesn't touch; warnings for what looks wrong."""
    warnings = []
    if load_["type"] == "press":
        nf, nm = count(load_["fix"], stats), count(load_["move"], stats)
        if not nf:
            raise SpecError(f"{name}: load.fix takes none of the part's vertices (its box is {fmt_box(stats)})")
        if not nm:
            raise SpecError(f"{name}: load.move takes none of the part's vertices (its box is {fmt_box(stats)})")
        return {"fix_vertices": nf, "move_vertices": nm}, warnings
    ax = AXES[load_["axis"]]
    lo, hi = stats["bbox"]
    center = load_.get("center") or [(lo[k] + hi[k]) / 2 for k in range(3)]
    o = [k for k in range(3) if k != ax]
    span = load_.get("span")
    shift = center[ax] if load_.get("center") else 0.0
    verts = stats["vertices"]
    rs = []
    for f in stats["faces"]:  # every triangle that reaches into the span, by its corners
        ss = [verts[i][ax] - shift for i in f]
        if span and (max(ss) < float(span[0]) - 1e-6 or min(ss) > float(span[1]) + 1e-6):
            continue
        rs += [math.hypot(verts[i][o[0]] - center[o[0]], verts[i][o[1]] - center[o[1]]) for i in f]
    if not rs:
        raise SpecError(f"{name}: none of the part lies along the axis in span {span}")
    D = float(load_["diameter"])
    out = {"part_outside_mm": round(2 * max(rs), 3), "part_inside_mm": round(2 * min(rs), 3)}
    if load_["type"] == "bore" and 2 * max(rs) <= D:
        raise SpecError(f"{name}: the part is {2 * max(rs):.3f} mm across there, no bigger than the {D} mm bore: nothing touches")
    if load_["type"] == "pin" and 2 * min(rs) >= D:
        raise SpecError(f"{name}: its hole is {2 * min(rs):.3f} mm across, no smaller than the {D} mm pin: nothing touches")
    if load_["type"] == "pin" and min(rs) < 0.3:
        raise SpecError(f"{name}: there's no hole along that axis for a pin")
    if load_.get("fix"):
        if not count(load_["fix"], stats):
            raise SpecError(f"{name}: load.fix takes none of the part's vertices (its box is {fmt_box(stats)})")
    interference = (2 * max(rs) - D) if load_["type"] == "bore" else (D - 2 * min(rs))
    if interference > 0.25 * D:
        warnings.append(f"{name}: {interference:.2f} mm of interference on a {D} mm fit is a lot: check the diameter")
    out["interference_mm"] = round(interference, 3)
    return out, warnings


def fmt_box(stats):
    lo, hi = stats["bbox"]
    return "[" + ", ".join(f"{a:.1f}..{b:.1f}" for a, b in zip(lo, hi)) + "]"


def mesh(spec):
    spec = dict(spec or {})
    unknown = set(spec) - MESH_KEYS
    if unknown:
        raise SpecError(f"mesh: no {', '.join(sorted(unknown))} (size, min, max, per_wall, budget, body, check)")
    for k in ("size", "min", "max", "per_wall"):
        if spec.get(k) is not None and float(spec[k]) <= 0:
            raise SpecError(f"mesh.{k}: more than 0")
    if spec.get("budget") is not None and not 1000 <= int(spec["budget"]) <= 600_000:
        raise SpecError("mesh.budget: elements, 1,000 to 600,000")
    return spec


def safe_name(text):
    s = NAME_RE.sub("-", str(text)).strip("-.")[:40]
    if not s:
        raise SpecError(f"part name {text!r}: give it letters or digits")
    return s


def merge(base, over):
    out = dict(base or {})
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict) and k not in ("fix", "move"):
            out[k] = merge(out[k], v)
        else:
            out[k] = v
    return out


def parts_list(parts):
    """The parts as [(name, source, overrides)]: a list of paths, or {name: path | {file, material?, load?, mesh?}}."""
    if isinstance(parts, str):
        parts = [parts]
    out = []
    if isinstance(parts, list):
        for p in parts:
            if isinstance(p, dict):
                src = p.get("file")
                name = p.get("name") or os.path.splitext(os.path.basename(str(src)))[0]
                out.append((safe_name(name), src, {k: v for k, v in p.items() if k in ("material", "load", "mesh")}))
            else:
                out.append((safe_name(os.path.splitext(os.path.basename(str(p).split(":")[-1]))[0]), p, {}))
    elif isinstance(parts, dict):
        for name, p in parts.items():
            if isinstance(p, dict):
                out.append((safe_name(name), p.get("file"), {k: v for k, v in p.items() if k in ("material", "load", "mesh")}))
            else:
                out.append((safe_name(name), p, {}))
    else:
        raise SpecError("parts: a list of files, or {name: file | {file, material?, load?, mesh?}}")
    if not out:
        raise SpecError("parts: at least one")
    names = [n for n, _, _ in out]
    dup = {n for n in names if names.count(n) > 1}
    if dup:
        raise SpecError(f"parts: two are called {', '.join(sorted(dup))}: name them ({{name: file}})")
    for n, src, _ in out:
        if not src:
            raise SpecError(f"part {n}: no file")
    return out
