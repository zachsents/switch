"""drawing: a dimensioned drawing sheet (plan, section and detail views with dimension callouts) from real cuts through
the models, as one PDF and a PNG, so an interface drawing never means a hand-written matplotlib script again.

A job names its parts (loaded models, each placed as asked), its views and the sheet:

- a view cuts a plane through the parts ("z=7.5", or {origin, normal, up, right}) and draws each part's cut face in its
  own colour, or looks at them from a side ("top", "front", a direction) and draws their silhouette with the edges that
  show; hidden outlines (other cuts, dashed), reference lines, labels with leaders and dimensions go on top.
- a dimension is measured off the geometry, never typed in: between two points, across the material or gap a probe
  line's middle is in (calipers), or a hole's diameter. Its words are a template around the measured value.
- the layout is automatic: dimensions stack in tiers outside the view (shortest nearest the part), labels and callouts
  are placed where they hit nothing, the views are packed on the sheet at the largest standard scale that fits, and at
  the end every text is checked against every other text, line and cut face with the renderer's own extents, so the
  answer says what (if anything) still overlaps.

Coordinates in a view are its own horizontal and vertical: for z=c cuts and top views, the model's x and y (seen from
above); for y=c cuts and front views, x and z (seen from the front, -y); for x=c cuts and right views, y and z (seen
from +x). Any point may also be given in 3D model coordinates ([x, y, z]) and is projected into the view.
"""

import datetime
import math
import re

import numpy as np
import trimesh

import geom

INK = "#1b1b1b"
HID = "#555555"
PALETTE = ["#e8b4a8", "#b9c6dc", "#d4a73c", "#c9c9c9", "#cfe3c4", "#e3d3ef", "#f1dfa2", "#a9d4d8"]
"""Cut faces, part by part: salmon for the first (the part the drawing is about), then blue, gold, nickel..."""
NAMED = {"cut": "#e8b4a8", "salmon": "#e8b4a8", "blue": "#b9c6dc", "gold": "#d4a73c", "brass": "#d4a73c",
         "nickel": "#c9c9c9", "steel": "#c9c9c9", "grey": "#c9c9c9", "gray": "#c9c9c9", "green": "#cfe3c4",
         "purple": "#e3d3ef", "yellow": "#f1dfa2", "teal": "#a9d4d8", "white": "#ffffff", "black": "#3a3a3a",
         "red": "#b22222", "dark": "#555555"}
SHEETS = {"a4": (297.0, 210.0), "a3": (420.0, 297.0), "a2": (594.0, 420.0), "letter": (279.4, 215.9),
          "tabloid": (431.8, 279.4), "ledger": (431.8, 279.4)}
SCALES = [20, 10, 8, 6, 5, 4, 3, 2.5, 2, 1.5, 1, 0.75, 0.5, 0.4, 0.25, 0.2, 0.1, 0.05]
"""Standard scales, largest first: the sheet takes the largest at which every view fits."""
PT = 25.4 / 72
FS_DIM, FS_LABEL, FS_TITLE, FS_CAPTION, FS_NOTE = 7.0, 6.8, 9.0, 6.5, 6.6
ARROW_L, ARROW_W = 2.0, 0.65
GAP0, EXT_GAP, EXT_OVER = 3.0, 0.8, 1.5
VIEW_GAP = 8.0
LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"
FIXED = {"z": ((0, 0, 1), (1, 0, 0), (0, 1, 0), "seen from above"),
         "y": ((0, -1, 0), (1, 0, 0), (0, 0, 1), "seen from the front"),
         "x": ((1, 0, 0), (0, 1, 0), (0, 0, 1), "seen from the right")}
"""An axis cut's frame: (toward the viewer, horizontal, vertical), so a view's coordinates are the model's own."""


def r(x, n=2):
    return round(float(x), n)


# Text


_WIDTHS = {}


def text_size(s, fs, bold=False):
    """A text's width and height on paper, mm, as DejaVu Sans sets it (several lines: the widest, and all of them)."""
    from matplotlib.font_manager import FontProperties
    from matplotlib.textpath import TextPath
    lines = str(s).split("\n")
    w = 0.0
    for ln in lines:
        key = (ln, fs, bold)
        if key not in _WIDTHS:
            prop = FontProperties(family="DejaVu Sans", weight="bold" if bold else "normal")
            _WIDTHS[key] = TextPath((0, 0), ln or " ", size=fs, prop=prop).get_extents().width * PT if ln.strip() else 0.0
        w = max(w, _WIDTHS[key])
    return w + 0.6, fs * PT * (1.18 * len(lines) + 0.12)


def wrap(s, width, fs, bold=False):
    """Words broken into lines no wider than width (mm)."""
    out = []
    for para in str(s).split("\n"):
        line = ""
        for word in para.split(" "):
            trial = (line + " " + word) if line else word
            if line and text_size(trial, fs, bold)[0] > width:
                out.append(line)
                line = word
            else:
                line = trial
        out.append(line)
    return "\n".join(out)


# Frames and geometry


def parse_plane(spec):
    """A plane as asked: "z=7.5" (an axis cut, in the model's own coordinates), or {origin, normal, up?, right?}."""
    if isinstance(spec, (int, float)):
        raise ValueError(f"a plane is \"z=7.5\" or {{origin, normal}}, not {spec!r}")
    if isinstance(spec, str):
        mt = re.fullmatch(r"\s*([xyzXYZ])\s*=\s*(-?[\d.]+)\s*", spec)
        if not mt:
            raise ValueError(f"can't read the plane {spec!r}: give z=7.5 (or x=, y=), or {{origin, normal}}")
        axis, at = mt[1].lower(), float(mt[2])
        n, u, v, seen = FIXED[axis]
        o = np.zeros(3)
        o["xyz".index(axis)] = at
        return {"o": o, "n": np.array(n, float), "u": np.array(u, float), "v": np.array(v, float), "axis": axis,
                "at": at, "zero": np.zeros(3), "label": f"{axis.upper()} {at:g}", "seen": seen}
    if not isinstance(spec, dict) or "normal" not in spec:
        raise ValueError(f"can't read the plane {spec!r}: give z=7.5, or {{origin, normal, up?, right?}}")
    o = np.asarray(spec.get("origin") or [0, 0, 0], float)
    n = np.asarray(spec["normal"], float)
    n = n / np.linalg.norm(n)
    if spec.get("right") is not None:
        u = np.asarray(spec["right"], float)
        u = u - n * (u @ n)
        u /= np.linalg.norm(u)
        v = np.cross(n, u)
    else:
        u, v, _ = geom.plane_frame(n, spec.get("up"))
    return {"o": o, "n": n, "u": u, "v": v, "axis": None, "at": None, "zero": o, "seen": "facing its normal",
            "label": f"through ({', '.join(f'{x:g}' for x in o)})"}


def view_frame(view):
    if view.get("cut") is not None and view.get("look") is not None:
        raise ValueError("a view either cuts (cut) or looks (look), not both")
    if view.get("cut") is not None:
        F = parse_plane(view["cut"])
        F["kind"] = "cut"
    else:
        d, up = geom.view_dir(view.get("look") or "top")
        n = -d
        v = up - n * (up @ n)
        v /= np.linalg.norm(v)
        u = np.cross(v, n)
        look = view.get("look") or "top"
        F = {"o": np.zeros(3), "zero": np.zeros(3), "n": n, "u": u, "v": v, "axis": None, "at": None, "kind": "look",
             "label": (look.upper() if isinstance(look, str) else "LOOKING ALONG " + str(list(look))), "seen": ""}
    if view.get("flip"):
        F["u"] = -F["u"]
    return F


def to2d(pts, F):
    d = np.asarray(pts, float).reshape(-1, 3) - F["zero"]
    return np.c_[d @ F["u"], d @ F["v"]]


def at2d(p, F, what="a point"):
    p = list(p)
    if len(p) == 2:
        return np.array(p, float)
    if len(p) == 3:
        return to2d([p], F)[0]
    raise ValueError(f"{what} is [h, v] in the view or [x, y, z] in the model, not {p}")


def off_faces(meshes, F):
    """An axis cut moved a hair off a flat face lying exactly on it (a cut along a face gives slivers)."""
    if F["axis"] is None:
        return F
    a = "xyz".index(F["axis"])
    for m in meshes:
        moved = geom.off_face(m, a, F["at"])
        if moved != F["at"]:
            F = dict(F)
            F["o"] = F["o"].copy()
            F["o"][a] = moved
            return F
    return F


def polylines_of(uv_segs):
    try:
        path = trimesh.load_path(uv_segs)
    except Exception:
        return [], None
    return [np.asarray(p) for p in path.discrete], path


def cut_of(m, plane, F):
    """A mesh cut by a plane, in the view's coordinates: (shapely polygons or None, the outline as polylines)."""
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    segs = trimesh.intersections.mesh_plane(m, plane["n"], plane["o"])
    if segs is None or not len(segs):
        return None, []
    uv = to2d(segs.reshape(-1, 3), F).reshape(-1, 2, 2)
    lines, path = polylines_of(uv)
    polys = []
    if path is not None:
        try:
            polys = [Polygon(p.exterior, p.interiors) for p in path.polygons_full if p is not None and p.area > 1e-8]
        except Exception:
            polys = []
    g = unary_union(polys) if polys else None
    if g is not None and not g.is_valid:
        g = g.buffer(0)
    return g, lines


def silhouette_of(meshes, F, sharp=25.0):
    """What a look sees: each part's silhouette (the union of its faces turned toward the eye) and the sharp edges
    that show, tested by casting a ray at each edge's middle from the eye's side."""
    import shapely
    from shapely.ops import unary_union
    out = []
    every = trimesh.util.concatenate(meshes) if len(meshes) > 1 else meshes[0]
    span = float(np.linalg.norm(every.extents)) or 1.0
    for m in meshes:
        facing = m.face_normals @ F["n"] > 1e-6
        tri = to2d(m.triangles[facing].reshape(-1, 3), F).reshape(-1, 3, 2)
        a = 0.5 * np.abs((tri[:, 1, 0] - tri[:, 0, 0]) * (tri[:, 2, 1] - tri[:, 0, 1])
                         - (tri[:, 2, 0] - tri[:, 0, 0]) * (tri[:, 1, 1] - tri[:, 0, 1]))
        tri = tri[a > 1e-10]
        g = None
        if len(tri):
            polys = shapely.polygons(np.concatenate([tri, tri[:, :1]], axis=1))
            g = unary_union(list(polys)).buffer(0)
        edges = []
        if len(m.face_adjacency):
            sel = m.face_adjacency_angles > math.radians(sharp)
            e = m.face_adjacency_edges[sel]
            if len(e) > 30000:
                e = e[np.random.default_rng(0).choice(len(e), 30000, replace=False)]
            if len(e):
                mid = m.vertices[e].mean(axis=1)
                d = -F["n"]
                origins = mid - d * span * 2
                try:
                    loc, idx, _ = every.ray.intersects_location(origins, np.tile(d, (len(e), 1)), multiple_hits=False)
                    first = np.full(len(e), np.inf)
                    if len(idx):
                        first[idx] = ((loc - origins[idx]) @ d)
                    visible = first >= span * 2 - max(1e-3 * span, 0.02)
                except Exception:
                    visible = np.ones(len(e), bool)
                ends = to2d(m.vertices[e[visible]].reshape(-1, 3), F).reshape(-1, 2, 2)
                edges = [seg for seg in ends]
        out.append((g, edges))
    return out


def ring_parts(g):
    for p in getattr(g, "geoms", [g]):
        if p.is_empty or not hasattr(p, "exterior"):
            continue
        yield p, p.exterior, False
        for ring in p.interiors:
            yield p, ring, True


# Measuring


def fmt(v, dec):
    return f"{v:.{dec}f}"


def words(template, value, prefix=""):
    """A dimension's words: "{}" stands for the measured value; words without it follow the value."""
    shown = f"{prefix}{value}"
    if template is None or template == "":
        return shown
    t = str(template)
    if "{}" in t:
        return t.replace("{}", shown)
    return f"{shown} {t}"


def crossing_ts(line, boundary):
    from shapely.geometry import Point
    hit = line.intersection(boundary)
    pts = []
    for g in getattr(hit, "geoms", [hit]):
        if g.is_empty:
            continue
        if isinstance(g, Point):
            pts.append((g.x, g.y))
        else:
            pts += list(g.coords)
    return pts


def probe(a, b, target):
    """Calipers: where the probe from a to b crosses the outline nearest its middle on each side, and whether its
    middle is in material (a wall) or not (a gap)."""
    from shapely.geometry import LineString, Point
    a, b = np.asarray(a, float), np.asarray(b, float)
    L = float(np.linalg.norm(b - a))
    if L < 1e-9:
        raise ValueError("a probe needs two different points")
    d = (b - a) / L
    pts = crossing_ts(LineString([a, b]), target.boundary)
    ts = sorted({round(float((np.asarray(p) - a) @ d), 6) for p in pts})
    lo = [t for t in ts if t < L / 2 - 1e-9]
    hi = [t for t in ts if t > L / 2 + 1e-9]
    if not lo or not hi:
        where = ", ".join(str([r(x, 2) for x in a + d * t]) for t in ts) or "nowhere"
        inside = target.buffer(0).contains(Point(*(a + d * L / 2)))
        raise ValueError(f"the probe from {[r(x, 3) for x in a]} to {[r(x, 3) for x in b]} doesn't cross the outline "
                         f"on both sides of its middle (it crosses at {where}; its middle is in "
                         f"{'material' if inside else 'the open'}): make it longer, or move it onto the feature")
    t0, t1 = lo[-1], hi[0]
    kind = "wall" if target.buffer(0).contains(Point(*(a + d * L / 2))) else "gap"
    return a + d * t0, a + d * t1, kind


def nearest_ring(target, p, holes_only, reach=None):
    """The hole (or outline) a point names: the smallest one around it, else the nearest within reach; slivers where
    two faces meet aren't holes."""
    from shapely.geometry import Point, Polygon
    pt = Point(*p)
    around, near = [], []
    for poly, ring, inner in ring_parts(target):
        if holes_only and not inner:
            continue
        h = geom.ring_shape(ring)
        if geom.real_hole(h):  # despite its name, true for a sliver, not a hole
            continue
        area = Polygon(ring).area
        if Polygon(ring).contains(pt):
            around.append((area, ring))
        else:
            near.append((pt.distance(ring), ring))
    if around:
        return min(around, key=lambda x: x[0])[1]
    if near:
        dist, ring = min(near, key=lambda x: x[0])
        if reach is None or dist <= reach:
            return ring
        c = ring.centroid
        raise ValueError(f"no {'hole' if holes_only else 'outline'} around {[r(x, 2) for x in p]}: the nearest is "
                         f"{dist:.1f} mm away, centred at {[r(c.x, 2), r(c.y, 2)]}")
    raise ValueError(("no hole" if holes_only else "no outline") + " in this view's cut to dimension")


# Layout of one view, on paper


class Sheet:
    """What one view (or the sheet's frame) draws, in paper mm, with every text's box kept for placing and checking."""

    def __init__(self):
        self.fills = []      # (shapely geometry, colour, hatch)
        self.lines = []      # dict(pts, lw, color, ls, role, owner)
        self.arrows = []     # (tip, direction, color)
        self.texts = []      # dict(x, y, s, fs, ha, va, rot, bold, color, bg, role, owner, box)
        self.dots = []

    def line(self, pts, lw=0.35, color=INK, ls="-", role="line", owner=None, z=4):
        self.lines.append({"pts": np.asarray(pts, float), "lw": lw, "color": color, "ls": ls, "role": role,
                           "owner": owner, "z": z})

    def text(self, x, y, s, fs, ha="left", va="bottom", rot=0, bold=False, color=INK, bg=False, role="text",
             owner=None, check=True):
        w, h = text_size(s, fs, bold)
        if rot:
            box = None
        else:
            x0 = {"left": x, "center": x - w / 2, "right": x - w}[ha]
            y0 = {"bottom": y, "center": y - h / 2, "top": y - h, "baseline": y - h * 0.2}[va]
            box = (x0, y0, x0 + w, y0 + h)
        t = {"x": x, "y": y, "s": s, "fs": fs, "ha": ha, "va": va, "rot": rot, "bold": bold, "color": color, "bg": bg,
             "role": role, "owner": owner, "box": box, "w": w, "h": h, "check": check}
        self.texts.append(t)
        return t

    def bounds(self):
        xs, ys = [], []
        for g, _, _ in self.fills:
            if not g.is_empty:
                b = g.bounds
                xs += [b[0], b[2]]
                ys += [b[1], b[3]]
        for ln in self.lines:
            xs += list(ln["pts"][:, 0])
            ys += list(ln["pts"][:, 1])
        for t in self.texts:
            b = t["box"] or rot_box(t)
            xs += [b[0], b[2]]
            ys += [b[1], b[3]]
        if not xs:
            return (0, 0, 1, 1)
        return (min(xs), min(ys), max(xs), max(ys))

    def moved(self, dx, dy):
        from shapely import affinity
        s = Sheet()
        s.fills = [(affinity.translate(g, dx, dy), c, h) for g, c, h in self.fills]
        s.lines = [{**ln, "pts": ln["pts"] + [dx, dy]} for ln in self.lines]
        s.arrows = [(np.asarray(tip) + [dx, dy], d, c) for tip, d, c in self.arrows]
        s.dots = [(np.asarray(p) + [dx, dy], c) for p, c in self.dots]
        s.texts = []
        for t in self.texts:
            b = t["box"]
            s.texts.append({**t, "x": t["x"] + dx, "y": t["y"] + dy,
                            "box": None if b is None else (b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy)})
        return s


def rot_box(t):
    """A rotated text's box (axis-aligned around it)."""
    a = math.radians(t["rot"])
    w, h = t["w"], t["h"]
    cx, cy = t["x"], t["y"]
    ex = abs(w / 2 * math.cos(a)) + abs(h / 2 * math.sin(a))
    ey = abs(w / 2 * math.sin(a)) + abs(h / 2 * math.cos(a))
    return (cx - ex, cy - ey, cx + ex, cy + ey)


def overlap(b1, b2, pad=0.0):
    return not (b1[2] - pad <= b2[0] + pad or b2[2] - pad <= b1[0] + pad or b1[3] - pad <= b2[1] + pad
                or b2[3] - pad <= b1[1] + pad)


def area_of(b1, b2):
    w = min(b1[2], b2[2]) - max(b1[0], b2[0])
    h = min(b1[3], b2[3]) - max(b1[1], b2[1])
    return max(w, 0) * max(h, 0)


def color_of(c, i):
    if c is None:
        return PALETTE[i % len(PALETTE)]
    c = str(c).strip()
    if re.fullmatch(r"#?[0-9a-fA-F]{6}", c):
        return c if c.startswith("#") else "#" + c
    if c.lower() in NAMED:
        return NAMED[c.lower()]
    return c


def pick_parts(parts, names, what):
    if not names:
        return list(range(len(parts)))
    if isinstance(names, str):
        names = [names]
    out = []
    for nm in names:
        if isinstance(nm, int) or (isinstance(nm, str) and nm.isdigit()):
            i = int(nm) - 1
            if not 0 <= i < len(parts):
                raise ValueError(f"{what}: there's no part {nm} (there are {len(parts)})")
            out.append(i)
            continue
        exact = [i for i, p in enumerate(parts) if p["name"].lower() == str(nm).lower()]
        found = exact or [i for i, p in enumerate(parts) if str(nm).lower() in p["name"].lower()]
        if not found:
            raise ValueError(f"{what}: no part named like {nm!r} (the parts are {', '.join(p['name'] for p in parts)})")
        out += [i for i in found if i not in out]
    return out


class View:
    """One view: its geometry in its own coordinates (measured once), then laid out on paper at a scale."""

    def __init__(self, spec, parts, letter):
        self.spec = spec
        self.letter = spec.get("label") or letter
        self.F = view_frame(spec)
        self.which = pick_parts(parts, spec.get("parts"), f"view {self.letter}")
        meshes = [parts[i]["mesh"] for i in self.which]
        self.F = off_faces(meshes, self.F)
        self.warnings = []
        self.shapes = []  # (part index, shapely geometry or None, outline polylines, edges)
        if self.F["kind"] == "cut":
            for i in self.which:
                g, lines = cut_of(parts[i]["mesh"], self.F, self.F)
                if g is None and lines:
                    self.warnings.append(f"view {self.letter}: {parts[i]['name']} isn't closed where it's cut, so its "
                                         "cut face shows as an outline only")
                self.shapes.append((i, g, lines, []))
            if all(s[1] is None and not s[2] for s in self.shapes):
                raise ValueError(f"view {self.letter}: the cut {self.F['label']} misses every part in it")
        else:
            for i, (g, edges) in zip(self.which, silhouette_of(meshes, self.F)):
                self.shapes.append((i, g, [], edges))
        from shapely.ops import unary_union
        gs = [s[1] for s in self.shapes if s[1] is not None]
        self.union = unary_union(gs) if gs else None
        self.hidden = []
        for k, h in enumerate(spec.get("hidden") or []):
            h = {"cut": h} if isinstance(h, str) or "normal" in h else h
            plane = parse_plane(h["cut"])
            win = h.get("within")
            for i in pick_parts(parts, h.get("parts") or [parts[j]["name"] for j in self.which], f"view {self.letter}'s hidden"):
                _, lines = cut_of(parts[i]["mesh"], plane, self.F)
                for pl in lines:
                    if win is not None:
                        x0, y0, x1, y1 = win
                        if not (pl[:, 0].min() >= min(x0, x1) and pl[:, 0].max() <= max(x0, x1)
                                and pl[:, 1].min() >= min(y0, y1) and pl[:, 1].max() <= max(y0, y1)):
                            continue
                    self.hidden.append(pl)
        self.measure(parts)
        self.window = self.window_of()

    # What it measures

    def target(self, part, parts, cut=None):
        """What a dimension measures: the view's cut faces (or one part's), or another cut's seen in this view (a
        hidden feature's)."""
        if cut is not None:
            from shapely.ops import unary_union
            plane = parse_plane(cut)
            idx = pick_parts(parts, [part], f"view {self.letter}") if part is not None else self.which
            gs = [g for g in (cut_of(parts[i]["mesh"], plane, self.F)[0] for i in idx) if g is not None]
            if not gs:
                raise ValueError(f"view {self.letter}: the cut {cut!r} a dimension measures at misses its parts")
            return unary_union(gs)
        if part is None:
            if self.union is None:
                raise ValueError(f"view {self.letter}: nothing closed to measure (its parts aren't closed solids here)")
            return self.union
        idx = pick_parts(parts, [part], f"view {self.letter}")
        gs = [s[1] for s in self.shapes if s[0] in idx and s[1] is not None]
        if not gs:
            raise ValueError(f"view {self.letter}: {part} has nothing closed in this view to measure")
        from shapely.ops import unary_union
        return unary_union(gs)

    def measure(self, parts):
        self.dims, self.callouts, self.labels, self.refs, self.skipped = [], [], [], [], []
        for k, d in enumerate(self.spec.get("dims") or []):
            name = d.get("text") or d.get("name") or f"#{k + 1}"
            try:
                self.measure_one(d, k, name, parts)
            except ValueError as e:
                self.warnings.append(f"view {self.letter}: dimension {name!r} left off: {e}")
                self.skipped.append({"dim": k + 1, "name": name, "why": str(e)})
        self.measure_rest()

    def measure_one(self, d, k, name, parts):
        dec = int(d.get("decimals", 2))
        if d.get("hole") is not None or d.get("diameter") is not None:
            p = at2d(d.get("hole") if d.get("hole") is not None else d["diameter"], self.F, "a hole's point")
            ring = nearest_ring(self.target(d.get("part"), parts, d.get("cut")), p, d.get("hole") is not None,
                            float(d.get("reach", 2.0)))
            h = geom.ring_shape(ring)
            if h["shape"] == "round":
                value = 2 * math.sqrt(h["area"] / math.pi)
                shown = words(d.get("text"), fmt(value, dec), "Ø")
            else:
                value = h["w"]
                shown = words(d.get("text"), f"{fmt(h['w'], dec)} × {fmt(h['l'], dec)}") + ("" if d.get("text") else " slot")
            c = np.array([ring.centroid.x, ring.centroid.y])
            coords = np.asarray(ring.coords)
            anchor = coords[np.argmax(coords @ np.array([1, 1]))]
            self.callouts.append({"anchor": anchor, "text": shown, "value": value, "kind": h["shape"], "center": c,
                                  "spec": d, "name": name})
            self.check_expect(d, value, shown)
            return
        if d.get("across") is not None:
            a, b = (at2d(p, self.F, "a probe's end") for p in d["across"])
            p0, p1, kind = probe(a, b, self.target(d.get("part"), parts, d.get("cut")))
            direction = b - a
        elif d.get("from") is not None and d.get("to") is not None:
            p0, p1 = at2d(d["from"], self.F, "a dimension's from"), at2d(d["to"], self.F, "a dimension's to")
            kind = "points"
            direction = p1 - p0
            self.on_outline(p0, p1, d, name)
        else:
            raise ValueError("it needs from and to, across [a, b], hole or diameter")
        along = d.get("along")
        if along not in ("h", "v", "aligned", "horizontal", "vertical"):
            dx, dy = abs(direction[0]), abs(direction[1])
            along = "h" if dy <= 0.02 * dx else "v" if dx <= 0.02 * dy else "aligned"
        along = {"horizontal": "h", "vertical": "v"}.get(along, along)
        value = abs(p1[0] - p0[0]) if along == "h" else abs(p1[1] - p0[1]) if along == "v" else float(np.linalg.norm(p1 - p0))
        if value < 1e-6:
            raise ValueError(f"it measures nothing (its ends are the same "
                             f"{'horizontally' if along == 'h' else 'vertically' if along == 'v' else 'point'})")
        shown = words(d.get("text"), fmt(value, dec))
        self.dims.append({"p0": p0, "p1": p1, "along": along, "value": value, "text": shown, "kind": kind,
                          "spec": d, "name": name})
        self.check_expect(d, value, shown)

    def measure_rest(self):
        for lab in self.spec.get("labels") or []:
            self.labels.append({"anchor": at2d(lab["at"], self.F, "a label's point"), "text": str(lab["text"]),
                                "leader": lab.get("leader", True), "color": color_of(lab.get("color") or INK, 0),
                                "bold": bool(lab.get("bold")), "fs": float(lab.get("size") or FS_LABEL)})
        for ln in self.spec.get("lines") or []:
            if ln.get("horizontal") is not None:
                self.refs.append({"dir": "h", "at": float(ln["horizontal"]), "text": ln.get("text") or "",
                                  "color": color_of(ln.get("color") or HID, 0), "ls": ln.get("style") or ":"})
            elif ln.get("vertical") is not None:
                self.refs.append({"dir": "v", "at": float(ln["vertical"]), "text": ln.get("text") or "",
                                  "color": color_of(ln.get("color") or HID, 0), "ls": ln.get("style") or ":"})
            else:
                raise ValueError(f"view {self.letter}: a line is {{horizontal: v}} or {{vertical: h}} in the view's coordinates")

    def check_expect(self, d, value, shown):
        if d.get("expect") is None:
            return
        tol = float(d.get("tol", 0.05))
        if abs(value - float(d["expect"])) > tol:
            self.warnings.append(f"view {self.letter}: {shown!r} measures {value:.3f}, not the {float(d['expect']):g} "
                                 f"expected (±{tol:g})")

    def on_outline(self, p0, p1, d, name):
        if self.union is None or d.get("free") or self.F["kind"] != "cut":
            return
        from shapely.geometry import Point
        b = self.union.boundary
        far = [p for p in (p0, p1) if b.distance(Point(*p)) > 0.05]
        if far:
            self.warnings.append(f"view {self.letter}: dimension {name!r} has an end {b.distance(Point(*far[0])):.2f} mm "
                                 "off any outline in the cut (a typed point, not the geometry's): use across to "
                                 "measure the feature, or free: true if that's meant")

    def window_of(self):
        w = self.spec.get("window")
        if w is not None:
            x0, y0, x1, y1 = [float(v) for v in w]
            return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
        xs, ys = [], []
        for _, g, lines, edges in self.shapes:
            if g is not None and not g.is_empty:
                b = g.bounds
                xs += [b[0], b[2]]
                ys += [b[1], b[3]]
            for pl in lines + [np.asarray(e) for e in edges]:
                xs += list(pl[:, 0])
                ys += list(pl[:, 1])
        for pl in self.hidden:
            xs += list(pl[:, 0])
            ys += list(pl[:, 1])
        for dd in self.dims:
            xs += [dd["p0"][0], dd["p1"][0]]
            ys += [dd["p0"][1], dd["p1"][1]]
        if not xs:
            raise ValueError(f"view {self.letter}: nothing to draw")
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        pad = max(x1 - x0, y1 - y0) * 0.03 + 0.2
        return (x0 - pad, y0 - pad, x1 + pad, y1 + pad)

    def size_mm(self, s):
        x0, y0, x1, y1 = self.window
        return (x1 - x0) * s, (y1 - y0) * s

    # On paper

    def lay(self, s, sheet_scale, parts, max_w):
        """The view drawn at scale s, in paper mm with its footprint's lower left at (0, 0)."""
        from shapely import affinity
        from shapely.geometry import LineString, box as sbox
        P = Sheet()
        self.scale = s
        x0, y0, x1, y1 = self.window
        cw, ch = (x1 - x0) * s, (y1 - y0) * s
        T = lambda pts: (np.asarray(pts, float) - [x0, y0]) * s  # noqa: E731
        win = sbox(x0, y0, x1, y1)
        tg = lambda g: affinity.affine_transform(g, [s, 0, 0, s, -x0 * s, -y0 * s])  # noqa: E731
        solid = []
        for i, g, lines, edges in self.shapes:
            part = parts[i]
            fc = color_of(part.get("color"), i) if self.F["kind"] == "cut" else (color_of(part.get("color"), i) if part.get("color") else "#ececec")
            if g is not None and not g.is_empty:
                shown = g.intersection(win)
                if not shown.is_empty:
                    P.fills.append((tg(shown), fc, "////" if part.get("hatch") else None))
                    solid.append(tg(shown))
                edge = g.boundary.intersection(win)
                for seg in getattr(edge, "geoms", [edge]):
                    if not seg.is_empty and hasattr(seg, "coords"):
                        P.line(T(np.asarray(seg.coords)), lw=0.55, role="edge", z=2)
            else:
                for pl in lines:
                    for seg in clip_line(pl, win):
                        P.line(T(seg), lw=0.55, role="edge", z=2)
            for e in edges:
                for seg in clip_line(np.asarray(e), win):
                    P.line(T(seg), lw=0.3, role="edge", z=2)
        for pl in self.hidden:
            for seg in clip_line(pl, win):
                P.line(T(seg), lw=0.5, color=HID, ls=(0, (3, 1.6)), role="hidden", z=2)
        from shapely.ops import unary_union
        self.solid = unary_union(solid) if solid else None
        # Reference lines, their words beyond the right (or top) edge
        right_room, top_room = 0.0, 0.0
        for k, ref in enumerate(self.refs):
            if ref["dir"] == "h":
                y = (ref["at"] - y0) * s
                P.line([[-1.0, y], [cw + 1.0, y]], lw=0.45, color=ref["color"], ls=ref["ls"], role="ref", owner=("ref", k), z=3)
                if ref["text"]:
                    t = P.text(cw + 1.8, y, ref["text"], FS_CAPTION, va="center", color=ref["color"], role="ref", owner=("ref", k))
                    right_room = max(right_room, t["w"] + 2.5)
            else:
                x = (ref["at"] - x0) * s
                P.line([[x, -1.0], [x, ch + 1.0]], lw=0.45, color=ref["color"], ls=ref["ls"], role="ref", owner=("ref", k), z=3)
                if ref["text"]:
                    t = P.text(x, ch + 1.8, ref["text"], FS_CAPTION, ha="center", color=ref["color"], role="ref", owner=("ref", k))
                    top_room = max(top_room, t["h"] + 2.0)
        self.spread_ref_words(P)
        self.place_dims(P, T, cw, ch, right_room, top_room)
        self.place_notes(P, T, cw, ch)
        # Title and caption over everything
        bx0, by0, bx1, by1 = P.bounds()
        bx0, bx1 = min(bx0, 0), max(bx1, cw)
        title = f"VIEW {self.letter}  {self.spec.get('title') or self.default_title()}"
        if abs(s - sheet_scale) > 1e-9:
            title += f"  (SCALE {scale_words(s)})"
        caption = self.spec.get("caption")
        wrap_w = min(max(bx1 - bx0, 90.0), max_w)
        y = by1 + 2.0
        if caption:
            text = wrap(caption, wrap_w, FS_CAPTION)
            t = P.text(bx0, y, text, FS_CAPTION, role="caption", owner=("caption",))
            y += t["h"] + 0.8
        P.text(bx0, y, wrap(title, wrap_w, FS_TITLE, True), FS_TITLE, bold=True, role="title", owner=("title",))
        fx0, fy0, _, _ = P.bounds()
        return P.moved(-fx0, -fy0), (-fx0, -fy0)

    def default_title(self):
        F = self.F
        if F["kind"] == "cut":
            return f"Section {F['label']}" + (f", {F['seen']}" if F.get("seen") else "")
        return f"Looking from the {F['label'].lower()}" if F["label"] in ("TOP", "BOTTOM", "FRONT", "BACK", "LEFT", "RIGHT") else F["label"].capitalize()

    def spread_ref_words(P):
        """Reference lines' words, nudged apart when two lines lie close."""
        refs = [t for t in P.texts if t["role"] == "ref" and t["box"] is not None]
        refs.sort(key=lambda t: t["y"])
        for a, b in zip(refs, refs[1:]):
            if overlap(a["box"], b["box"], 0.1):
                dy = a["box"][3] + 0.3 - b["box"][1]
                b["y"] += dy
                b["box"] = (b["box"][0], b["box"][1] + dy, b["box"][2], b["box"][3] + dy)

    spread_ref_words = staticmethod(spread_ref_words)

    def place_dims(self, P, T, cw, ch, right_room, top_room):
        """Dimensions: outside the view in tiers (shortest nearest the part, side by side where they don't overlap),
        or where asked (at, or inside); arrows inside or out by room; words on the outer side of the line."""
        sides = {"above": [], "below": [], "left": [], "right": []}
        fixed = []
        for k, d in enumerate(self.dims):
            q0, q1 = T(d["p0"]), T(d["p1"])
            w, h = text_size(d["text"], FS_DIM)
            item = {"k": k, "d": d, "q0": q0, "q1": q1, "w": w, "h": h}
            spec = d["spec"]
            side = spec.get("side")
            if spec.get("at") is not None:
                at = float(spec["at"])
                item["pos"] = (at - self.window[1]) * self.scale if d["along"] == "h" else (at - self.window[0]) * self.scale \
                    if d["along"] == "v" else at
                item["fixed"] = True
                fixed.append(item)
                continue
            if side == "inside":
                item["pos"] = (q0[1] + q1[1]) / 2 if d["along"] == "h" else (q0[0] + q1[0]) / 2 if d["along"] == "v" else 0.0
                item["fixed"] = True
                item["inside"] = True
                fixed.append(item)
                continue
            if d["along"] == "h":
                side = side if side in ("above", "below") else ("above" if (q0[1] + q1[1]) / 2 >= ch / 2 else "below")
            elif d["along"] == "v":
                side = side if side in ("left", "right") else ("right" if (q0[0] + q1[0]) / 2 >= cw / 2 else "left")
            else:
                item["fixed"] = True
                c = np.array([cw / 2, ch / 2])
                mid = (q0 + q1) / 2
                dd = q1 - q0
                nrm = np.array([-dd[1], dd[0]]) / (np.linalg.norm(dd) or 1)
                if side in ("left", "right"):
                    sgn = 1 if side == "left" else -1
                else:
                    sgn = 1 if (mid - c) @ nrm >= 0 else -1
                item["nrm"] = nrm * sgn
                item["pos"] = None
                fixed.append(item)
                continue
            sides[side].append(item)
        for side, items in sides.items():
            horiz = side in ("above", "below")
            items.sort(key=lambda it: abs((it["q1"] - it["q0"])[0 if horiz else 1]))
            tiers = []
            for it in items:
                lo, hi = self.extent(it, horiz)
                for t, used in enumerate(tiers):
                    if all(hi + 1.2 <= a or lo - 1.2 >= b for a, b in used):
                        used.append((lo, hi))
                        it["tier"] = t
                        break
                else:
                    tiers.append([(lo, hi)])
                    it["tier"] = len(tiers) - 1
            if horiz:
                pitch = text_size("0", FS_DIM)[1] + 2.4
                base = (ch + GAP0 + top_room) if side == "above" else -GAP0
                for it in items:
                    it["pos"] = base + it["tier"] * pitch if side == "above" else base - it["tier"] * pitch
                    it["outer"] = 1 if side == "above" else -1
            else:
                widths = [0.0] * len(tiers)
                for it in items:
                    widths[it["tier"]] = max(widths[it["tier"]], it["w"])
                x = (cw + GAP0 + right_room) if side == "right" else -GAP0
                pos = []
                for t in range(len(tiers)):
                    pos.append(x)
                    x = x + widths[t] + 3.2 if side == "right" else x - widths[t] - 3.2
                for it in items:
                    it["pos"] = pos[it["tier"]]
                    it["outer"] = 1 if side == "right" else -1
        for it in [x for v in sides.values() for x in v] + fixed:
            self.draw_dim(P, it, cw, ch)
        self.slide_crowded_words(P)

    def extent(self, it, horiz):
        a = 0 if horiz else 1
        lo, hi = sorted((it["q0"][a], it["q1"][a]))
        span = hi - lo
        size = it["w"] if horiz else it["h"]
        if horiz and size + 1.0 > span:
            hi += 1.5 + size + (ARROW_L if span < 2 * ARROW_L + 1 else 0)
            lo -= ARROW_L + 1.5 if span < 2 * ARROW_L + 1 else 0
        elif not horiz:
            mid = (lo + hi) / 2
            lo, hi = min(lo, mid - size / 2), max(hi, mid + size / 2)
            if span < 2 * ARROW_L + 1:
                lo, hi = lo - ARROW_L - 1.5, hi + ARROW_L + 1.5
        return lo - 0.6, hi + 0.6

    def draw_dim(self, P, it, cw, ch):
        d, q0, q1 = it["d"], it["q0"].copy(), it["q1"].copy()
        owner = ("dim", it["k"])
        ext = not it.get("inside") and d["spec"].get("extension", True)
        if d["along"] in ("h", "v"):
            a = 0 if d["along"] == "h" else 1   # the axis it measures along
            b = 1 - a                           # the axis its line sits at
            pos = it["pos"]
            e0, e1 = q0.copy(), q1.copy()
            e0[b] = e1[b] = pos
            outer = it.get("outer") or (1 if pos >= (q0[b] + q1[b]) / 2 else -1)
            if ext:
                for q, e in ((q0, e0), (q1, e1)):
                    gap = e[b] - q[b]
                    if abs(gap) > EXT_GAP + 0.2:
                        sgn = 1 if gap > 0 else -1
                        st, en = q.copy(), e.copy()
                        st[b] += sgn * EXT_GAP
                        en[b] += sgn * EXT_OVER
                        P.line([st, en], lw=0.3, role="ext", owner=owner)
            lo, hi = sorted((e0[a], e1[a]))
            span = hi - lo
            dirv = np.zeros(2)
            dirv[a] = 1
            start, end = e0.copy(), e0.copy()
            start[a], end[a] = lo, hi
            inside_arrows = span >= 2 * ARROW_L + 1.0
            if inside_arrows:
                P.line([start, end], lw=0.45, role="dim", owner=owner)
                P.arrows += [(start, -dirv, INK), (end, dirv, INK)]
            else:
                s0, s1 = start.copy(), end.copy()
                s0[a] -= ARROW_L + 2.5
                s1[a] += ARROW_L + 2.5
                P.line([s0, s1], lw=0.45, role="dim", owner=owner)
                P.arrows += [(start, dirv, INK), (end, -dirv, INK)]
            mid = (lo + hi) / 2
            if a == 0:
                fits = it["w"] + 1.0 <= span
                tx = mid if fits else hi + (ARROW_L + 2.8 if not inside_arrows else 1.5)
                ty = pos + (0.5 if outer > 0 else -0.5)
                t = P.text(tx, ty, d["text"], FS_DIM, ha="center" if fits else "left", va="bottom" if outer > 0 else "top",
                           bg=True, role="dim", owner=owner)
                t["inside"] = bool(it.get("fixed"))
                if not fits:
                    run = end.copy()
                    run[0] = t["box"][2]
                    P.line([end, run], lw=0.45, role="dim", owner=owner)
                    it["flip"] = (lo, hi, inside_arrows)
            else:
                tx = pos + (0.8 if outer > 0 else -0.8)
                t = P.text(tx, mid, d["text"], FS_DIM, ha="left" if outer > 0 else "right", va="center", bg=True,
                           role="dim", owner=owner)
                t["inside"] = bool(it.get("fixed"))
            return
        # Aligned: offset along its normal, words along the line
        dd = q1 - q0
        L = float(np.linalg.norm(dd))
        u = dd / L
        nrm = it.get("nrm")
        if nrm is None:
            nrm = np.array([-u[1], u[0]])
        off = it["pos"] if it.get("pos") is not None else 4.0
        e0, e1 = q0 + nrm * off, q1 + nrm * off
        if ext and abs(off) > EXT_GAP + 0.2:
            for q, e in ((q0, e0), (q1, e1)):
                P.line([q + nrm * EXT_GAP * np.sign(off), e + nrm * EXT_OVER * np.sign(off)], lw=0.3, role="ext", owner=owner)
        if L >= 2 * ARROW_L + 1:
            P.line([e0, e1], lw=0.45, role="dim", owner=owner)
            P.arrows += [(e0, -u, INK), (e1, u, INK)]
        else:
            P.line([e0 - u * (ARROW_L + 2.5), e1 + u * (ARROW_L + 2.5)], lw=0.45, role="dim", owner=owner)
            P.arrows += [(e0, u, INK), (e1, -u, INK)]
        ang = math.degrees(math.atan2(u[1], u[0]))
        if ang > 90:
            ang -= 180
        elif ang <= -90:
            ang += 180
        side = nrm * np.sign(off or 1)
        c = (e0 + e1) / 2 + side * (text_size("0", FS_DIM)[1] / 2 + 0.5)
        P.text(c[0], c[1], d["text"], FS_DIM, ha="center", va="center", rot=ang, bg=True, role="dim", owner=owner)

    def slide_crowded_words(self, P):
        """A dimension's words that sit on other words, on a line that isn't theirs or on a cut face slide along their
        own dimension line (either way, nearest first) to the first place that's clear; the line runs on under them
        when they end up past its ends."""
        solid = self.solid
        for t in [t for t in P.texts if t["role"] == "dim" and t["box"] is not None and not t.get("inside")]:
            if not crowded(t, P, solid):
                continue
            own = [ln for ln in P.lines if ln["owner"] == t["owner"] and ln["role"] == "dim"]
            if not own:
                continue
            main, runs = own[0], own[1:]
            pts = main["pts"]
            a = 0 if abs(pts[0, 1] - pts[-1, 1]) < 1e-9 else 1
            lo, hi = float(pts[:, a].min()), float(pts[:, a].max())
            size = t["w"] if a == 0 else t["h"]
            reach = (hi - lo) / 2 + size + 14
            old = dict(t)
            steps = [k * 1.2 for k in range(1, int(reach / 1.2) + 1)]
            placed = False
            for off in [x for st in steps for x in (st, -st)]:
                t.update(old)
                b = list(old["box"])
                b[a] += off
                b[a + 2] += off
                t["box"] = tuple(b)
                if a == 0:
                    t["x"] = old["x"] + off
                else:
                    t["y"] = old["y"] + off
                if not crowded(t, P, solid):
                    placed = True
                    break
            if not placed:
                t.update(old)
                continue
            for ln in runs:
                P.lines.remove(ln)
            b = t["box"]
            level = float(pts[0, 1 - a])
            if a == 0:
                if b[2] > hi:
                    P.line([[hi, level], [b[2], level]], lw=0.45, role="dim", owner=t["owner"])
                if b[0] < lo:
                    P.line([[b[0], level], [lo, level]], lw=0.45, role="dim", owner=t["owner"])
            else:
                mid = (b[1] + b[3]) / 2
                if mid > hi:
                    P.line([[level, hi], [level, mid]], lw=0.45, role="dim", owner=t["owner"])
                if mid < lo:
                    P.line([[level, mid], [level, lo]], lw=0.45, role="dim", owner=t["owner"])

    def place_notes(self, P, T, cw, ch):
        """Labels with leaders, and hole callouts: each where its words hit nothing (other words, lines, the cut
        faces), as near its point as that allows."""
        items = [{"anchor": c["anchor"], "text": c["text"], "leader": True, "color": INK, "bold": False, "fs": FS_DIM,
                  "role": "callout", "towards": c["center"]} for c in self.callouts]
        items += [{**lab, "role": "label"} for lab in self.labels]
        solid = self.solid
        for k, it in enumerate(items):
            q = T(it["anchor"])
            owner = (it["role"], k)
            if not it["leader"]:
                P.text(q[0], q[1], it["text"], it["fs"], ha="center", va="center", bold=it["bold"], color=it["color"],
                       role=it["role"], owner=owner, check=True)
                continue
            w, h = text_size(it["text"], it["fs"], it["bold"])
            best = None
            for radius in (5.0, 8.0, 12.0, 17.0, 23.0, 30.0):
                for ang in (45, 135, -45, -135, 0, 180, 90, -90, 22, 158, -22, -158, 68, 112, -68, -112):
                    a = math.radians(ang)
                    px, py = q[0] + radius * math.cos(a), q[1] + radius * math.sin(a)
                    cx, cy = math.cos(a), math.sin(a)
                    bx0 = px if cx > 0.3 else px - w if cx < -0.3 else px - w / 2
                    by0 = py if cy > 0.3 else py - h if cy < -0.3 else py - h / 2
                    box = (bx0, by0, bx0 + w, by0 + h)
                    score = radius * 0.6 + (abs(ang) % 90 not in (45,)) * 0.5
                    for t in P.texts:
                        tb = t["box"] or rot_box(t)
                        if overlap(box, tb, -0.8):
                            score += 400 + 40 * area_of(box, tb)
                    end = leader_end(box, q)
                    for ln in P.lines:
                        if ln["role"] in ("edge",) or len(ln["pts"]) < 2:
                            continue
                        if seg_box(ln["pts"], box, 0.4):
                            score += 120
                        if crosses(ln["pts"], end, q):
                            score += 25
                    if solid is not None:
                        from shapely.geometry import box as sbox, LineString
                        score += 60 * solid.intersection(sbox(*box)).area / max(w * h, 1e-6) * 10
                        try:
                            score += 3 * solid.intersection(LineString([end, q])).length
                        except Exception:
                            pass
                    if best is None or score < best[0]:
                        best = (score, box, end)
            _, box, end = best
            P.line([end, q], lw=0.35, color=it["color"], role="leader", owner=owner, z=5)
            P.dots.append((q, it["color"]))
            P.text(box[0], box[1], it["text"], it["fs"], ha="left", va="bottom", bold=it["bold"], color=it["color"],
                   bg=True, role=it["role"], owner=owner)


def clip_line(pl, win):
    from shapely.geometry import LineString
    pl = np.asarray(pl, float)
    if len(pl) < 2:
        return []
    try:
        g = LineString(pl).intersection(win)
    except Exception:
        return [pl]
    out = []
    for s in getattr(g, "geoms", [g]):
        if not s.is_empty and hasattr(s, "coords") and len(s.coords) >= 2:
            out.append(np.asarray(s.coords))
    return out


def leader_end(box, q):
    """Where a leader leaves its words: the box's nearest corner or edge middle to the point."""
    x0, y0, x1, y1 = box
    xs = x0 if q[0] < x0 else x1 if q[0] > x1 else (x0 + x1) / 2
    if q[0] < x0 or q[0] > x1:
        ys = (y0 + y1) / 2 if y0 <= q[1] <= y1 else (y0 if q[1] < y0 else y1)
    else:
        ys = y0 if q[1] < y0 else y1
    return np.array([xs, ys])


def seg_box(pts, box, pad=0.0):
    from shapely.geometry import LineString, box as sbox
    return LineString(pts).intersects(sbox(box[0] + pad, box[1] + pad, box[2] - pad, box[3] - pad))


def crosses(pts, a, b):
    from shapely.geometry import LineString
    try:
        return LineString(pts).crosses(LineString([a, b]))
    except Exception:
        return False


def crowded(t, P, solid=None):
    """Whether a text's box sits on other words, a line that isn't its own (edges and hidden outlines included) or
    a cut face."""
    from shapely.geometry import box as sbox
    for o in P.texts:
        if o is t:
            continue
        if overlap(t["box"], o["box"] or rot_box(o), 0.15):
            return True
    for ln in P.lines:
        if ln["owner"] == t["owner"] or len(ln["pts"]) < 2:
            continue
        if seg_box(ln["pts"], t["box"], 0.3):
            return True
    if solid is not None and not solid.is_empty:
        b = sbox(*t["box"])
        if solid.intersection(b).area > 0.1 * b.area:
            return True
    return False


def scale_words(s):
    if s >= 1:
        return f"{s:g}:1" if float(s).is_integer() else f"{int(round(s * 2))}:2"
    inv = 1 / s
    return f"1:{inv:g}" if abs(inv - round(inv)) < 1e-6 else f"{s:g}:1"


# The sheet


def frame_parts(job, W, H, sheet_scale):
    """The border, the header, the notes and the title block, in paper mm; and the room left for views."""
    P = Sheet()
    m = 10.0 if W >= 400 else 8.0
    P.line([[m, m], [W - m, m], [W - m, H - m], [m, H - m], [m, m]], lw=1.0, role="frame")
    inner_w = W - 2 * m
    top = H - m - 4.0
    header = job.get("header")
    if header:
        t = P.text(m + 4, top, wrap(header, inner_w - 8, 8.5), 8.5, va="top", role="header", owner=("header",))
        top = t["box"][1] - 4.0
    tb_w = 165.0 if W >= 400 else 125.0
    title = job.get("title") or "Drawing"
    lines = [str(x) for x in (job.get("lines") or [])]
    date = job.get("date") or datetime.date.today().strftime("%b %-d, %Y")
    lines.append(f"Units mm · scale {scale_words(sheet_scale)} unless noted · {date}")
    block = [(wrap(title, tb_w - 8, 11, True), 11, True)] + [(wrap(x, tb_w - 8, 7.5), 7.5, False) for x in lines]
    rows = []
    for s, fs, bold in block:
        w, h = text_size(s, fs, bold)
        rows.append((s, fs, bold, h + 2.4))
    tb_h = sum(rh for *_, rh in rows) + 1.5
    x0 = W - m - tb_w
    P.line([[x0, m], [x0, m + tb_h], [W - m, m + tb_h]], lw=0.8, role="frame")
    y = m + tb_h
    for k, (s, fs, bold, rh) in enumerate(rows):
        P.text(x0 + 4, y - 1.2, s, fs, va="top", bold=bold, role="block", owner=("block", k))
        y -= rh
        if k < len(rows) - 1:
            P.line([[x0, y], [W - m, y]], lw=0.4, role="frame")
    band = tb_h
    notes = job.get("notes") or []
    if notes:
        nw = x0 - m - 8
        y = m + 3.0
        texts = [wrap(str(n), nw, FS_NOTE) for n in notes]
        hs = [text_size(t, FS_NOTE)[1] + 0.8 for t in texts]
        total = sum(hs)
        y = m + 3.0 + total
        for k, (t, h) in enumerate(zip(texts, hs)):
            P.text(m + 4, y, t, FS_NOTE, va="top", role="note", owner=("note", k))
            y -= h
        band = max(band, total + 6.0)
    area = (m + 4.0, m + band + 6.0, W - m - 4.0, top)
    return P, area


def pack(sizes, breaks, area):
    """Views in rows, in order, a new row when one is full (or asked): each view's lower left, or None if they
    don't fit."""
    ax0, ay0, ax1, ay1 = area
    aw, ah = ax1 - ax0, ay1 - ay0
    rows, cur, cur_w = [], [], 0.0
    for i, (w, h) in enumerate(sizes):
        if w > aw + 1e-6:
            return None
        if cur and (cur_w + VIEW_GAP + w > aw or breaks[i]):
            rows.append(cur)
            cur, cur_w = [], 0.0
        cur_w += (VIEW_GAP if cur else 0) + w
        cur.append(i)
    rows.append(cur)
    heights = [max(sizes[i][1] for i in row) for row in rows]
    total = sum(heights) + VIEW_GAP * (len(rows) - 1)
    if total > ah + 1e-6:
        return None
    spare_v = (ah - total) / (len(rows) + 1)
    pos = {}
    y = ay1 - spare_v
    for row, rh in zip(rows, heights):
        row_w = sum(sizes[i][0] for i in row) + VIEW_GAP * (len(row) - 1)
        spare_h = (aw - row_w) / (len(row) + 1)
        x = ax0 + spare_h
        for i in row:
            pos[i] = (x, y - sizes[i][1])
            x += sizes[i][0] + VIEW_GAP + spare_h
        y -= rh + VIEW_GAP + spare_v
    return pos


def load_part(path, name, obj=None):
    """One part's mesh: the file's one model, an object of a 3MF by number or name, or all its objects as placed."""
    models = geom.load(path, objects="each", name=name)
    if not models:
        raise ValueError(f"{name}: nothing in it to draw")
    if obj in (None, "", "all", "merged"):
        if len(models) == 1:
            return models[0]["mesh"].copy()
        return trimesh.util.concatenate([x["mesh"] for x in models])
    if isinstance(obj, int) or (isinstance(obj, str) and obj.isdigit()):
        i = int(obj) - 1
        if not 0 <= i < len(models):
            raise ValueError(f"{name} has {len(models)} object(s); there's no object {obj}")
        return models[i]["mesh"].copy()
    found = [x for x in models if str(obj).lower() in x["name"].lower()]
    if not found:
        raise ValueError(f"no object named like {obj!r} in {name}: it has {', '.join(x['name'] for x in models)}")
    return found[0]["mesh"].copy()


def place_parts(job):
    parts = []
    for k, p in enumerate(job["parts"]):
        m = load_part(p["path"], p["name"], p.get("object"))
        if p.get("transform") is not None:
            M = np.asarray(p["transform"], float)
            if M.shape != (4, 4):
                raise ValueError(f"{p['name']}: transform is a 4×4 matrix")
            m.apply_transform(M)
        if p.get("rotate") is not None:
            rx, ry, rz = [math.radians(float(a)) for a in p["rotate"]]
            m.apply_transform(trimesh.transformations.euler_matrix(rx, ry, rz, "sxyz"))
        if p.get("offset") is not None:
            m.apply_translation([float(v) for v in p["offset"]])
        parts.append({"name": p.get("label") or p["name"], "mesh": m, "color": p.get("color"), "hatch": p.get("hatch"),
                      "bounds": [[r(x) for x in m.bounds[0]], [r(x) for x in m.bounds[1]]]})
    return parts


def op_drawing(job):
    parts = place_parts(job)
    specs = job.get("views") or []
    if not specs:
        raise ValueError("a drawing needs at least one view: {cut: \"z=5\"} or {look: \"top\"}")
    if len(specs) > 9:
        raise ValueError(f"{len(specs)} views is too many for one sheet: 9 at most (make a second sheet)")
    size = str(job.get("size") or "A3").lower()
    if size not in SHEETS:
        raise ValueError(f"unknown sheet size {size!r}: {', '.join(SHEETS)}")
    W, H = SHEETS[size]
    if job.get("portrait"):
        W, H = H, W
    views = [View(sp, parts, LETTERS[i]) for i, sp in enumerate(specs)]
    asked = job.get("scale")
    candidates = [float(asked)] if asked else SCALES
    chosen = None
    for s in candidates:
        frame, area = frame_parts(job, W, H, s)
        laid = []
        for v in views:
            vs = float(v.spec["scale"]) if v.spec.get("scale") else s
            v.scale = vs
            P, _ = v.lay(vs, s, parts, area[2] - area[0])
            b = P.bounds()
            laid.append((P, (b[2] - b[0], b[3] - b[1])))
        pos = pack([x[1] for x in laid], [bool(v.spec.get("new_row")) for v in views], area)
        if pos is not None:
            chosen = (s, frame, laid, pos)
            break
    if chosen is None:
        raise ValueError("the views don't fit on one " + size.upper() + (" sheet at the scale asked" if asked else
                         " sheet at any scale down to 1:20: give fewer views, a window, or a bigger size"))
    s, frame, laid, pos = chosen
    sheet = Sheet()
    sheet.fills, sheet.lines, sheet.texts = list(frame.fills), list(frame.lines), list(frame.texts)
    view_boxes = []
    for i, (P, (w, h)) in enumerate(laid):
        x, y = pos[i]
        M = P.moved(x, y)
        for t in M.texts:
            t["view"] = views[i].letter
            t["kind"] = views[i].F["kind"]
        for ln in M.lines:
            ln["view"] = views[i].letter
        sheet.fills += M.fills
        sheet.lines += M.lines
        sheet.texts += M.texts
        sheet.arrows += M.arrows
        sheet.dots += M.dots
        view_boxes.append((views[i].letter, (x, y, x + w, y + h)))
    overlaps = render(sheet, W, H, job["pdf"], job.get("png"), job.get("dpi") or 160)
    out_views = []
    for v in views:
        out_views.append({
            "label": v.letter, "title": v.spec.get("title") or v.default_title(), "scale": scale_words(v.scale),
            "kind": v.F["kind"], "plane": v.F["label"], "window": [r(x, 3) for x in v.window],
            "parts": [parts[i]["name"] for i in v.which], **({"left_off": v.skipped} if v.skipped else {}),
            "dims": [{"text": d["text"], "value": r(d["value"], 4), "along": d["along"], "by": d["kind"],
                      "from": [r(x, 3) for x in d["p0"]], "to": [r(x, 3) for x in d["p1"]],
                      **({"expect": d["spec"]["expect"]} if d["spec"].get("expect") is not None else {})} for d in v.dims]
            + [{"text": c["text"], "value": r(c["value"], 4), "by": "hole" if c["spec"].get("hole") is not None else "diameter",
                "shape": c["kind"], "at": [r(x, 3) for x in c["center"]]} for c in v.callouts],
        })
    warnings = [w for v in views for w in v.warnings]
    return {"sheet": size.upper() + (" portrait" if job.get("portrait") else ""), "size_mm": [W, H],
            "scale": scale_words(s), "views": out_views, "overlaps": overlaps, "warnings": warnings,
            "parts": [{"name": p["name"], "bounds": p["bounds"]} for p in parts],
            "view_boxes": {k: [r(x, 1) for x in b] for k, b in view_boxes}}


def render(sheet, W, H, pdf_path, png_path, dpi):
    """Draws the sheet, then checks with the renderer's own extents that no words sit on other words, on lines that
    aren't theirs, on a cut face or off the sheet. Answers what does, in words."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.backends.backend_pdf import PdfPages
    from matplotlib.patches import PathPatch, Polygon as MPoly
    from matplotlib.path import Path
    plt.rcParams.update({"font.family": "DejaVu Sans", "pdf.fonttype": 42, "hatch.linewidth": 0.4})
    fig = plt.figure(figsize=(W / 25.4, H / 25.4))
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, W)
    ax.set_ylim(0, H)
    ax.axis("off")
    for g, fc, hatch in sheet.fills:
        for p in getattr(g, "geoms", [g]):
            if p.is_empty or not hasattr(p, "exterior"):
                continue
            verts, codes = [], []
            for ring in [p.exterior, *p.interiors]:
                c = np.asarray(ring.coords)
                verts.append(c)
                codes += [Path.MOVETO] + [Path.LINETO] * (len(c) - 2) + [Path.CLOSEPOLY]
            ax.add_patch(PathPatch(Path(np.vstack(verts), codes), facecolor=fc, edgecolor="none", hatch=hatch, zorder=1))
    for ln in sheet.lines:
        ax.plot(ln["pts"][:, 0], ln["pts"][:, 1], color=ln["color"], lw=ln["lw"], ls=ln["ls"], zorder=ln["z"],
                solid_capstyle="butt")
    for tip, d, c in sheet.arrows:
        d = np.asarray(d, float) / (np.linalg.norm(d) or 1)
        nrm = np.array([-d[1], d[0]])
        tip = np.asarray(tip, float)
        base = tip - d * ARROW_L
        ax.add_patch(MPoly([tip, base + nrm * ARROW_W, base - nrm * ARROW_W], closed=True, fc=c, ec="none", zorder=6))
    for p, c in sheet.dots:
        ax.plot([p[0]], [p[1]], "o", ms=1.6, color=c, zorder=6)
    artists = []
    for t in sheet.texts:
        kw = {}
        if t["bg"]:
            kw["bbox"] = dict(fc="white", ec="none", pad=0.4)
        a = ax.text(t["x"], t["y"], t["s"], fontsize=t["fs"], ha=t["ha"], va=t["va"], rotation=t["rot"],
                    rotation_mode="anchor" if t["rot"] else "default", weight="bold" if t["bold"] else "normal",
                    color=t["color"], zorder=7, linespacing=1.18, **kw)
        artists.append((a, t))
    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    inv = ax.transData.inverted()
    boxes = []
    for a, t in artists:
        bb = a.get_window_extent(renderer)
        (x0, y0), (x1, y1) = inv.transform([[bb.x0, bb.y0], [bb.x1, bb.y1]])
        boxes.append(((x0, y0, x1, y1), t))
    problems = []

    def who(t):
        where = f"view {t['view']}" if t.get("view") else {"block": "the title block", "note": "the notes",
                                                            "header": "the header"}.get(t["role"], "the sheet")
        words = t["s"].replace("\n", " ")
        return f"{where}'s {t['role']} {words[:40]!r}"

    for i in range(len(boxes)):
        bi, ti = boxes[i]
        if bi[0] < 0 or bi[1] < 0 or bi[2] > W or bi[3] > H:
            problems.append(f"{who(ti)} runs off the sheet")
        for j in range(i + 1, len(boxes)):
            bj, tj = boxes[j]
            if overlap(bi, bj, 0.15) and area_of(bi, bj) > 0.05:
                problems.append(f"{who(ti)} overlaps {who(tj)}")
    from shapely.geometry import LineString, box as sbox
    from shapely.ops import unary_union
    solid = unary_union([g for g, _, _ in sheet.fills]) if sheet.fills else None
    for b, t in boxes:
        if not t["check"] or t["role"] in ("block", "header", "note"):
            continue
        tb = sbox(b[0] + 0.3, b[1] + 0.3, b[2] - 0.3, b[3] - 0.3)
        for ln in sheet.lines:
            if ln["role"] == "frame" or ln["owner"] == t["owner"] or len(ln["pts"]) < 2:
                continue
            if ln.get("view") != t.get("view"):
                continue
            if LineString(ln["pts"]).intersects(tb):
                kind = {"edge": "an edge of the part", "hidden": "a hidden outline", "dim": "a dimension line",
                        "ext": "an extension line", "leader": "a leader", "ref": "a reference line"}.get(ln["role"], "a line")
                problems.append(f"{who(t)} sits on {kind}")
                break
        if solid is not None and t["role"] in ("dim", "label", "callout", "ref", "title", "caption") and t.get("view"):
            hit = solid.intersection(tb).area
            if hit > 0.25 * tb.area and not (t["role"] == "label" and not t["bg"]) and not t.get("inside"):
                problems.append(f"{who(t)} sits on " + ("a cut face" if t.get("kind") == "cut" else "the part"))
    seen, out = set(), []
    for p in problems:
        if p not in seen:
            seen.add(p)
            out.append(p)
    with PdfPages(pdf_path) as pdf:
        pdf.savefig(fig)
    if png_path:
        fig.savefig(png_path, dpi=dpi)
    plt.close(fig)
    return out
