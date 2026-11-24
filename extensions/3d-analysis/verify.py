"""verify: whether a sliced plate is what was asked for, checked rather than eyeballed.

A plate goes wrong in ways its picture hides: it was sliced from an earlier version of the part (the chamfer asked for
lives in a folder nobody sliced), the slicer closed a slot or ran the brim into it, the settings drifted from the plate
that was approved, a copy is missing. So, for one sliced .gcode.3mf:

- each object on the plate against the model it should be: laid on it (the 24 quarter turns, then ICP) and measured
  surface to surface both ways, so a 0.3 mm chamfer that isn't there shows, with where; and against earlier versions
  named, so the answer says which version it is;
- features as a spec states them, in the model's own coordinates: a gap or a wall measured along a line (calipers), a
  point that must be empty or solid, a hole's diameter in a section, the size, the volume. Each is measured on the
  model, on the plate's own object, and (for gaps, holes and empty points) in the G-code of every copy at that height,
  where the beads must leave it open;
- settings (filament, color, printer, layer height, walls, infill, brim, supports, any raw key), the number of copies,
  and whether anything is off the bed; or every setting against another plate's.

Runs in mesh's worker environment, like the rest of geom.
"""

import itertools
import json
import math
import re
import zipfile

import numpy as np
import trimesh

import geom
from geom import r

ROTATIONS = [M for M in (np.array([[s[i] if p[i] == j else 0 for j in range(3)] for i in range(3)], float)
                         for p in itertools.permutations(range(3)) for s in itertools.product((1, -1), repeat=3))
             if np.linalg.det(M) > 0]
"""The 24 ways to turn a part a quarter turn at a time: how a design file and the plate's copy of it can differ when
the part was laid on another side."""
SAME_FRAME_MM = 0.02
"""A model whose median surface point is this close to the plate's part, as it sits, is in the part's own frame."""
GAP_EDGE = 0.12
"""How far into a gap a wall's bead may reach at each end and still leave it open (squish, the round end of a line)."""
FEATURE_KINDS = ("gap", "wall", "empty", "solid", "hole", "size", "volume")


# Plates


def plate_objects(path, plate=None):
    """The plate's objects: [{name, mesh (placed), frame (in its own coordinates, the file it was sliced from), T}]."""
    out = []
    for m in geom.read_3mf(path):
        if m.get("plate") and plate and str(m["plate"]) != str(plate):
            continue
        T = np.asarray(m.get("transform") if m.get("transform") is not None else np.eye(4), float)
        frame = m["mesh"].copy()
        frame.apply_transform(np.linalg.inv(T))
        out.append({"name": m["name"], "mesh": m["mesh"], "frame": frame, "T": T})
    return out


def plate_facts(path, plate):
    """What the slicer wrote about the plate: its settings, the filaments it uses, time, weight, objects, off-bed."""
    facts = {"settings": {}, "filaments": [], "objects": [], "outside": None, "seconds": None, "grams": None}
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        if "Metadata/project_settings.config" in names:
            try:
                facts["settings"] = json.loads(z.read("Metadata/project_settings.config"))
            except ValueError:
                pass
        if "Metadata/slice_info.config" in names:
            text = z.read("Metadata/slice_info.config").decode("utf-8", "replace")
            blocks = re.findall(r"<plate>(.*?)</plate>", text, re.S)
            block = blocks[0] if blocks else text
            for b in blocks:
                if re.search(r'key="index" value="%s"' % (plate or 1), b):
                    block = b
            md = dict(re.findall(r'<metadata key="([^"]+)" value="([^"]*)"', block))
            facts["outside"] = md.get("outside") == "true"
            facts["seconds"] = float(md["prediction"]) if md.get("prediction") else None
            facts["grams"] = float(md["weight"]) if md.get("weight") else None
            facts["support_used"] = md.get("support_used") == "true"
            for a in re.findall(r"<filament\b([^>]*)/>", block):
                d = dict(re.findall(r'(\w+)="([^"]*)"', a))
                facts["filaments"].append({"id": d.get("id"), "type": d.get("type"), "color": d.get("color"),
                                           "g": float(d["used_g"]) if d.get("used_g") else None})
            for a in re.findall(r"<object\b([^>]*)/>", block):
                d = dict(re.findall(r'(\w+)="([^"]*)"', a))
                facts["objects"].append({"name": d.get("name"), "skipped": d.get("skipped") == "true"})
    return facts


# Laying a model on a plate's object


def surface_points(m, n, seed):
    """Points on a mesh's surface: its corners (where a chamfer or a cut shows first) and n spread over its area."""
    v = m.vertices
    if len(v) > 30000:
        v = v[np.random.default_rng(seed).choice(len(v), 30000, replace=False)]
    s, _ = trimesh.sample.sample_surface(m, n, seed=seed)
    return np.vstack([v, s]), len(v)


def nearest(m, pts):
    _, d, _ = trimesh.proximity.closest_point(m, pts)
    return np.asarray(d)


def register(model, obj):
    """The rigid motion that lays model on obj (4x4, model frame to obj's): the quarter turns that give it obj's box,
    each moved box centre to box centre, the closest by median surface distance, refined by ICP only when that brings
    the median closer. The median, not the mean: where the two really differ (a chamfer one has and the other hasn't),
    fitting those spots too would pull every other surface off and hide where the difference is."""
    me, oe = model.extents, obj.extents
    oc = obj.bounds.mean(axis=0)
    # Spread by area, not by corners: a fillet's many little triangles sit where versions differ, and would outvote
    # the plain faces that show where the part sits.
    probe, _ = trimesh.sample.sample_surface(model, 2400, seed=7)

    def cost(T):
        return float(np.median(nearest(obj, trimesh.transform_points(probe, T))))
    # A sliced plate keeps each part in its own file's coordinates, and a design's versions share theirs: so the part
    # as it is, or only moved box to box, wins when it fits. A turned fit can't be told from it on a part that's nearly
    # symmetric (a round holder with two slots: turned half round, only the slots disagree), so it isn't tried then.
    same_box = np.eye(4)
    same_box[:3, 3] = oc - model.bounds.mean(axis=0)
    for T in (np.eye(4), same_box):
        c = cost(T)
        if c < SAME_FRAME_MM:
            return refine(probe, obj, T, c, cost)
    best = None
    for R in ROTATIONS:
        if np.max(np.abs(np.abs(R) @ me - oe)) > max(0.6, 0.03 * float(oe.max())):
            continue
        T = np.eye(4)
        T[:3, :3] = R
        T[:3, 3] = oc - R @ model.bounds.mean(axis=0)
        c = cost(T)
        if best is None or c < best[0]:
            best = (c, T)
    if best is None or best[0] > 1.0:
        try:
            T, _ = trimesh.registration.mesh_other(model, obj, samples=500, scale=False, icp_first=10, icp_final=40)
            c = cost(T)
            if best is None or c < best[0]:
                best = (c, T)
        except Exception:
            pass
    if best is None:
        return np.eye(4), None
    return refine(probe, obj, best[1], best[0], cost)


def refine(probe, obj, T, c, cost):
    """ICP from a fit, kept only when it brings the median distance closer (an exact fit is left as it is)."""
    if c <= 0.002:
        return T, c
    try:
        T2, _, _ = trimesh.registration.icp(probe, obj, initial=T, threshold=1e-8, max_iterations=40,
                                            reflection=False, translation=True, scale=False)
        c2 = cost(T2)
        if c2 < c:
            return T2, c2
    except Exception:
        pass
    return T, c


def clusters(points, values, link=1.2, limit=5):
    """Points that differ, gathered into places: each one's centre, box, largest value and count, biggest first."""
    if not len(points):
        return []
    from scipy.sparse.csgraph import connected_components
    from scipy.spatial import cKDTree
    pairs = cKDTree(points).query_pairs(link, output_type="ndarray")
    from scipy.sparse import coo_matrix
    n = len(points)
    g = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(n, n)) if len(pairs) else coo_matrix((n, n))
    _, labels = connected_components(g, directed=False)
    out = []
    for k in np.unique(labels):
        sel = labels == k
        p, v = points[sel], values[sel]
        out.append({"at": [r(x, 1) + 0.0 for x in p[np.argmax(v)]], "box": [[r(x, 1) + 0.0 for x in p.min(0)], [r(x, 1) + 0.0 for x in p.max(0)]],
                    "max_mm": r(v.max(), 3), "points": int(sel.sum())})
    out.sort(key=lambda c: -(c["max_mm"] * math.sqrt(c["points"])))
    return out[:limit]


def compare(model, obj, tol, seed=0):
    """How far apart a model and a plate's object are once laid on each other: surface to surface both ways (corners
    and 6000 points each), the largest and 99th percentile, the area that's off, and where (in the model's frame)."""
    T, _ = register(model, obj)
    Tinv = np.linalg.inv(T)
    placed = model.copy()
    placed.apply_transform(T)
    pa, nva = surface_points(placed, 6000, seed)
    pb, nvb = surface_points(obj, 6000, seed + 1)
    da, db = nearest(obj, pa), nearest(placed, pb)
    d = np.concatenate([da, db])
    laid = ("as it sits" if np.allclose(T, np.eye(4), atol=1e-6) else
            "moved" if np.allclose(T[:3, :3], np.eye(3), atol=1e-6) else "turned")
    out = {"max_mm": r(d.max(), 3), "p99_mm": r(np.percentile(d, 99), 3), "mean_mm": r(d.mean(), 4),
           "same": bool(d.max() <= tol), "laid": laid, "transform": [[r(x, 5) for x in row] for row in T]}
    off_area = float(np.mean(da[nva:] > tol) * placed.area + np.mean(db[nvb:] > tol) * obj.area) / 2
    out["off_mm2"] = r(off_area, 1)
    vol = model.volume if model.is_volume else None
    ovol = obj.volume if obj.is_volume else None
    if vol and ovol:
        out["volume_diff_mm3"] = r(ovol - vol, 1)
    out["triangles"] = {"model": int(len(model.faces)), "plate": int(len(obj.faces))}
    if not out["same"]:
        # Where: points of the model's surface off the plate's (the plate lacks them, or covers them) and the plate's
        # off the model's, back in the model's frame.
        far_a, far_b = da > tol, db > tol
        pts = np.vstack([trimesh.transform_points(pa[far_a], Tinv), trimesh.transform_points(pb[far_b], Tinv)])
        vals = np.concatenate([da[far_a], db[far_b]])
        places = clusters(pts, vals)
        if obj.is_watertight and far_a.any():
            inside = obj.contains(pa[far_a])
            sides = np.concatenate([np.where(inside, 1, -1), np.zeros(int(far_b.sum()))])
            for c in places:
                near = np.linalg.norm(pts - np.array(c["at"]), axis=1) <= max(1.5, 0.5 * float(np.max(np.subtract(c["box"][1], c["box"][0]))))
                s = sides[near]
                if (s == 1).sum() > (s == -1).sum():
                    c["plate_has"] = "more material"
                elif (s == -1).sum():
                    c["plate_has"] = "less material"
        out["where"] = places
    return out, T


# Features


def along(mesh, a, b):
    """What a line through a and b crosses: [(t0, t1, solid)] in mm from a toward b, from far before a to far past b."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    L = float(np.linalg.norm(b - a))
    if L <= 0:
        raise ValueError("a line needs two different points")
    u = (b - a) / L
    reach = float(np.linalg.norm(mesh.extents)) + L + 10
    locs, _, _ = mesh.ray.intersects_location([a - u * reach], [u], multiple_hits=True)
    ts = np.sort((np.asarray(locs) - a) @ u) if len(locs) else np.array([])
    cuts = []
    for t in ts:
        if not cuts or t - cuts[-1] > 1e-4:
            cuts.append(float(t))
    edges = [-math.inf, *cuts, math.inf]
    spans = [[edges[i], edges[i + 1], i % 2 == 1] for i in range(len(edges) - 1)]
    if mesh.is_watertight and cuts:
        mids = [(s[0] + s[1]) / 2 for s in spans[1:-1]]
        if mids:
            inside = mesh.contains(a + np.outer(mids, u))
            for s, solid in zip(spans[1:-1], inside):
                s[2] = bool(solid)
    merged = []
    for s in spans:
        if merged and merged[-1][2] == s[2]:
            merged[-1][1] = s[1]
        else:
            merged.append(list(s))
    return [tuple(s) for s in merged], u, L


def solid_at(mesh, p):
    p = np.asarray(p, float)
    if mesh.is_watertight:
        return bool(mesh.contains([p])[0])
    spans, _, _ = along(mesh, p, p + np.array([1.0, 0.0, 0.0]))
    return next(s[2] for s in spans if s[0] <= 0 <= s[1])


def section_at(mesh, z):
    g, _ = geom.section_polys(mesh, [0, 0, z], [0, 0, 1], [0, 1, 0])
    if g is None:
        return None
    return geom.in_world(g, {"axis": 2, "normal": np.array([0, 0, 1.0]), "up": [0, 1, 0], "origin": np.array([0, 0, z])})


def want_text(f):
    if f.get("mm") is not None and f["kind"] != "size":
        return f"{f['mm']:g} ± {f.get('tol', 0.1):g} mm"
    if f["kind"] == "size" and f.get("mm") is not None:
        return " × ".join("any" if v is None else f"{v:g}" for v in f["mm"]) + f" ± {f.get('tol', 0.1):g} mm"
    if f["kind"] == "volume" and f.get("cm3") is not None:
        return f"{f['cm3']:g} cm³ ± {f.get('tol', 0.01 * f['cm3']):g}"
    bits = []
    if f.get("min") is not None:
        bits.append(f"≥ {f['min']:g} mm")
    if f.get("max") is not None:
        bits.append(f"≤ {f['max']:g} mm")
    return " and ".join(bits) or "present"


def judge(value, f):
    if value is None:
        return False
    if f["kind"] == "size":
        if f.get("mm") is None:
            return True
        tol = float(f.get("tol", 0.1))
        return all(w is None or abs(v - float(w)) <= tol for v, w in zip(value, f["mm"]))
    if f["kind"] == "volume":
        if f.get("cm3") is None:
            return True
        return abs(value - float(f["cm3"])) <= float(f.get("tol", 0.01 * float(f["cm3"])))
    ok = True
    if f.get("mm") is not None:
        ok &= abs(value - float(f["mm"])) <= float(f.get("tol", 0.1))
    if f.get("min") is not None:
        ok &= value >= float(f["min"]) - 1e-9
    if f.get("max") is not None:
        ok &= value <= float(f["max"]) + 1e-9
    return bool(ok)


def normalize_feature(f, n):
    f = dict(f)
    kind = str(f.get("kind") or "").lower()
    if kind not in FEATURE_KINDS:
        raise ValueError(f"feature {f.get('name') or n}: kind is one of {', '.join(FEATURE_KINDS)}")
    f["kind"] = kind
    f["name"] = str(f.get("name") or f"{kind} {n}")
    for k in ("d", "w"):
        if f.get(k) is not None and f.get("mm") is None:
            f["mm"] = f[k]
    if kind in ("gap", "wall") and (f.get("from") is None or f.get("to") is None):
        raise ValueError(f"feature {f['name']}: a {kind} is measured along a line: give from and to, [x, y, z] each")
    if kind in ("empty", "solid") and f.get("at") is None:
        raise ValueError(f"feature {f['name']}: give at, the point [x, y, z]")
    if kind == "hole" and f.get("z") is None and f.get("at") is None:
        raise ValueError(f"feature {f['name']}: a hole is found in a section: give z (and near [x, y]), or at [x, y, z]")
    if kind == "hole" and f.get("at") is not None:
        f.setdefault("z", f["at"][2])
        f.setdefault("near", f["at"][:2])
    return f


def measure_feature(f, mesh):
    """One feature measured on one mesh, in that mesh's frame: {value, ok, words, draw}."""
    kind = f["kind"]
    if kind in ("gap", "wall"):
        spans, u, L = along(mesh, f["from"], f["to"])
        a = np.asarray(f["from"], float)
        mid = L / 2
        s = next(x for x in spans if x[0] <= mid <= x[1])
        want_solid = kind == "wall"
        if s[2] != want_solid:
            words = "solid there: no gap at all" if kind == "gap" else "empty there: no wall at all"
            return {"value": 0.0, "ok": judge(0.0, f) if kind == "gap" else False, "words": words,
                    "draw": {"line": [list(a), list(f["to"])]}}
        t0, t1 = max(s[0], 0.0), min(s[1], L)
        value = t1 - t0
        open_ends = [x for x, cut in (("before from", s[0] < 0), ("past to", s[1] > L)) if cut]
        p0, p1 = a + u * t0, a + u * t1
        words = f"{kind} {value:.2f} mm" + (f" (and more: it carries on {' and '.join(open_ends)})" if open_ends else "")
        return {"value": r(value, 3), "ok": judge(value, f) and not open_ends, "words": words,
                "draw": {"line": [list(a), list(f["to"])], "span": [[r(x, 3) for x in p0], [r(x, 3) for x in p1]]}}
    if kind in ("empty", "solid"):
        solid = solid_at(mesh, f["at"])
        ok = solid == (kind == "solid")
        return {"value": solid, "ok": ok, "words": "solid there" if solid else "empty there", "draw": {"point": list(f["at"])}}
    if kind == "hole":
        g = section_at(mesh, float(f["z"]) + 1e-4)
        if g is None:
            return {"value": None, "ok": False, "words": f"nothing at z {f['z']:g}", "draw": {}}
        near = np.asarray(f.get("near") or [0, 0], float)
        rings = [ring for p in getattr(g, "geoms", [g]) for ring in p.interiors]
        found = []
        for ring in rings:
            h = geom.ring_shape(ring)
            if geom.real_hole(h):
                continue
            from shapely.geometry import Point, Polygon
            dist = Polygon(ring).exterior.distance(Point(near)) if not Polygon(ring).contains(Point(near)) else 0.0
            found.append((dist, h, ring))
        if not found:
            return {"value": None, "ok": False, "words": f"no hole at z {f['z']:g}", "draw": {}}
        dist, h, ring = min(found, key=lambda x: x[0])
        if dist > max(2.0, 0.5 * (f.get("mm") or 0)):
            return {"value": None, "ok": False, "words": f"no hole near ({near[0]:g}, {near[1]:g}) at z {f['z']:g}: the nearest is "
                    f"{dist:.1f} mm off, at ({h['at'][0]:g}, {h['at'][1]:g})", "draw": {}}
        value = h.get("d") if h["shape"] == "round" else h.get("w")
        words = (f"Ø{value:.2f} mm" if h["shape"] == "round" else f"slot {h['w']:.2f} × {h['l']:.2f} mm") + f" at ({h['at'][0] + 0.0:g}, {h['at'][1] + 0.0:g})"
        return {"value": value, "ok": judge(value, f), "words": words,
                "draw": {"ring": [[r(x, 3), r(y, 3), float(f["z"])] for x, y in np.asarray(ring.coords)], "z": float(f["z"])}}
    if kind == "size":
        ext = [r(x, 3) for x in mesh.extents]
        return {"value": ext, "ok": judge(ext, f), "words": " × ".join(f"{x:g}" for x in ext) + " mm", "draw": {}}
    if kind == "volume":
        v = mesh.volume / 1000 if mesh.is_volume else None
        return {"value": r(v, 3), "ok": judge(v, f), "words": f"{v:.3f} cm³" if v is not None else "not a closed solid", "draw": {}}
    raise ValueError(kind)


# The G-code


def layer_index(layers, z):
    """The layer that prints height z: its top at or above z, its bottom below."""
    for i, L in enumerate(layers):
        top, h = L["z"], L["height"] or 0.2
        if top - h - 1e-6 < z <= top + 1e-6:
            return i
    return None


def beads_near(segs, window):
    """The extrusions inside a window as one shape, each bead as wide as its line: (shape, [(line, feature)])."""
    from shapely.geometry import LineString
    from shapely.ops import unary_union
    x0, y0, x1, y1 = window
    shapes, lines = [], []
    for ax, ay, bx, by, feat, width in segs:
        if max(ax, bx) < x0 or min(ax, bx) > x1 or max(ay, by) < y0 or min(ay, by) > y1:
            continue
        line = LineString([(ax, ay), (bx, by)]) if (ax, ay) != (bx, by) else None
        if line is None:
            continue
        shapes.append(line.buffer(width / 2))
        lines.append((line.buffer(width / 2), feat))
    return (unary_union(shapes) if shapes else None), lines


def gcode_check(f, measured, to_plate, layers, segs):
    """Whether the G-code leaves a gap, a hole or an empty point open where this copy prints it."""
    from shapely.geometry import LineString, Point, Polygon
    d = measured["draw"]
    if f["kind"] == "gap" and d.get("span"):
        p = trimesh.transform_points(np.asarray(d["span"], float), to_plate)
    elif f["kind"] == "empty":
        p = trimesh.transform_points(np.asarray([d["point"]], float), to_plate)
    elif f["kind"] == "hole" and d.get("ring"):
        p = trimesh.transform_points(np.asarray(d["ring"], float), to_plate)
    else:
        return None
    z = float(np.mean(p[:, 2]))
    i = layer_index(layers, z)
    if i is None:
        return {"ok": None, "words": f"no layer prints z {z:.2f}"}
    L = layers[i]
    pad = 1.0
    window = (p[:, 0].min() - pad, p[:, 1].min() - pad, p[:, 0].max() + pad, p[:, 1].max() + pad)
    beads, lines = beads_near(segs.get(i, []), window)
    where = f"layer {i + 1} (z {L['z']:.2f})"
    if f["kind"] == "gap":
        line = LineString(p[:, :2])
        n = line.length
        test = line if n <= 2 * GAP_EDGE + 0.05 else LineString([line.interpolate(GAP_EDGE).coords[0], line.interpolate(n - GAP_EDGE).coords[0]])
        covered = test.intersection(beads).length if beads is not None else 0.0
        feats = sorted({ft for shp, ft in lines if shp.intersects(test)})
        ok = covered <= 0.05
        words = (f"open in the G-code at {where}" if ok else
                 f"the G-code lays {covered:.2f} mm of {', '.join(feats) or 'extrusion'} across it at {where}")
        return {"ok": ok, "words": words, "layer": i + 1, "covered_mm": r(covered, 3), "window": [r(x, 2) for x in window],
                "plate_line": [[r(x, 3) for x in q] for q in p]}
    if f["kind"] == "empty":
        pt = Point(p[0, :2])
        hit = beads is not None and beads.contains(pt)
        feats = sorted({ft for shp, ft in lines if shp.contains(pt)})
        return {"ok": not hit, "layer": i + 1, "window": [r(x, 2) for x in window], "plate_point": [r(x, 3) for x in p[0]],
                "words": f"empty in the G-code at {where}" if not hit else f"the G-code prints {', '.join(feats)} there at {where}"}
    ring = Polygon(p[:, :2])
    inner = ring.buffer(-GAP_EDGE * 2)
    if inner.is_empty:
        return {"ok": None, "words": "too small to check in the G-code"}
    covered = inner.intersection(beads).area if beads is not None else 0.0
    ok = covered <= max(0.05, 0.01 * inner.area)
    feats = sorted({ft for shp, ft in lines if shp.intersects(inner)})
    return {"ok": ok, "layer": i + 1, "window": [r(x, 2) for x in window], "covered_mm2": r(covered, 3),
            "plate_ring": [[r(x, 3) for x in q] for q in p],
            "words": f"open in the G-code at {where}" if ok else f"the G-code fills {covered:.2f} mm² of it with {', '.join(feats)} at {where}"}


# Settings


EXPECT = {
    "filament": "filament_type", "color": "filament_colour", "printer": "printer_model", "layer": "layer_height",
    "walls": "wall_loops", "infill": "sparse_infill_density", "brim": "brim_width", "brim_type": "brim_type",
    "supports": "enable_support", "nozzle": "nozzle_diameter", "plate_type": "curr_bed_type",
    "nozzle_c": "nozzle_temperature", "seam": "seam_position", "top_layers": "top_shell_layers",
    "bottom_layers": "bottom_shell_layers", "infill_pattern": "sparse_infill_pattern", "ironing": "ironing_type",
}
"""Plain names for the settings a job's spec usually pins, and Bambu's keys for them (settings takes any raw key)."""
NOISE = {"different_settings_to_system", "inherits_group", "upward_compatible_machine", "filament_settings_id",
         "print_settings_id", "printer_settings_id", "name", "from", "version", "compatible_printers",
         "compatible_prints", "filament_vendor", "filament_ids", "setting_id", "inherits", "print_compatible_printers"}
"""Keys that differ between two slices of the same job without changing what prints (preset names, lineage)."""


def norm_value(v):
    if isinstance(v, bool):
        return "1" if v else "0"
    s = str(v).strip().lower().rstrip("%")
    if s in ("true", "yes", "on"):
        return "1"
    if s in ("false", "no", "off", "none"):
        return "0" if s != "none" else s
    try:
        return f"{float(s):g}"
    except ValueError:
        return s.lstrip("#") if re.fullmatch(r"#?[0-9a-f]{6}(?:[0-9a-f]{2})?", s) else s


def values_match(want, got, contains=False):
    wants = want if isinstance(want, list) else None
    gots = got if isinstance(got, list) else [got]
    if wants is not None:
        return len(wants) <= len(gots) and all(values_match(w, g, contains) for w, g in zip(wants, gots))
    w = norm_value(want)
    for g in gots:
        g = norm_value(g)
        if not (w in g if contains else w == g):
            return False
    return bool(gots)


def settings_checks(expect, facts, copies):
    out = []
    s = facts["settings"]
    used = [f for f in facts["filaments"] if (f.get("g") or 0) > 0] or facts["filaments"]
    for key, want in (expect or {}).items():
        if want is None:
            continue
        if key == "copies":
            out.append({"what": "copies", "want": want, "got": copies, "ok": int(want) == copies})
            continue
        if key == "settings":
            for k, w in want.items():
                got = s.get(k)
                out.append({"what": k, "want": w, "got": got, "ok": got is not None and values_match(w, got)})
            continue
        if key in ("filament", "color"):
            got = [f.get("type" if key == "filament" else "color") for f in used]
            out.append({"what": key, "want": want, "got": got if len(got) != 1 else got[0], "ok": values_match(want, got)})
            continue
        k = EXPECT.get(key, key)
        got = s.get(k)
        contains = key in ("printer", "plate_type")
        out.append({"what": key, "key": k, "want": want, "got": got, "ok": got is not None and values_match(want, got, contains)})
    return out


def settings_diff(a, b):
    """Every setting that differs between two plates, preset names and lineage left out."""
    out = []
    for k in sorted(set(a) | set(b)):
        if k in NOISE:
            continue
        va, vb = a.get(k), b.get(k)
        if va != vb and not (va is not None and vb is not None and values_match(vb, va) and values_match(va, vb)):
            out.append({"key": k, "this": va, "other": vb})
    return out


# The whole check


def model_meshes(entries):
    out = []
    for e in entries or []:
        ms = geom.load(e["path"], objects="merged", name=e["name"])
        m = ms[0]["mesh"]
        out.append({"name": e["name"], "mesh": m, "role": e.get("role")})
    return out


def fingerprint(m):
    return (len(m.faces), round(float(m.area), 1), tuple(np.round(m.extents, 1)))


def op_verify(job):
    path, name = job["file"], job["name"]
    tol = float(job.get("tol") or 0.05)
    text, plate = geom.gcode_text(path, job.get("plate"))
    layers, _ = geom.parse_layers(text)
    if not layers:
        raise ValueError(f"{name} has no G-code layers in it: is it sliced?")
    facts = plate_facts(path, plate)
    objs = plate_objects(path, plate)
    if not objs:
        raise ValueError(f"{name} has no objects on its plate")
    models = model_meshes(job.get("models"))
    others = model_meshes(job.get("others"))
    features = [normalize_feature(f, n + 1) for n, f in enumerate(job.get("features") or [])]
    checks = []

    # Which part each object on the plate is: the model it should be, or an earlier version.
    groups = {}
    for o in objs:
        groups.setdefault(fingerprint(o["frame"]), []).append(o)
    objects = []
    for g in groups.values():
        o = g[0]
        entry = {"name": o["name"], "copies": len(g), "size_mm": [r(x) for x in o["frame"].extents]}
        best, best_T = None, None
        for m in models:
            cmp, T = compare(m["mesh"], o["frame"], tol)
            entry.setdefault("against", []).append({"model": m["name"], **{k: v for k, v in cmp.items() if k != "transform"}})
            if best is None or cmp["p99_mm"] < best[1]["p99_mm"]:
                best, best_T = (m, cmp), T
        version = None
        for m in others:
            cmp, _ = compare(m["mesh"], o["frame"], tol)
            entry.setdefault("versions", []).append({"version": m["name"], "same": cmp["same"], "max_mm": cmp["max_mm"],
                                                     "p99_mm": cmp["p99_mm"]})
            if cmp["same"] and (version is None or cmp["max_mm"] < version[1]):
                version = (m["name"], cmp["max_mm"])
        if best is not None:
            m, cmp = best
            entry["model"] = m["name"]
            entry["same"] = cmp["same"]
            for x in g:
                x["model"], x["model_T"], x["matched"] = m, best_T, cmp["same"]
            if cmp["same"]:
                words = f"{o['name']}{' ×' + str(len(g)) if len(g) > 1 else ''} is {m['name']}: the same surface to {cmp['max_mm']:.3f} mm"
            else:
                where = cmp.get("where") or []
                at = "; ".join(f"up to {c['max_mm']:g} mm around ({', '.join(f'{v:g}' for v in c['at'])})"
                               + (f", where the plate's part has {c['plate_has']}" if c.get("plate_has") else "") for c in where[:3])
                words = (f"{o['name']}{' ×' + str(len(g)) if len(g) > 1 else ''} is NOT {m['name']}: it differs by up to "
                         f"{cmp['max_mm']:g} mm over about {cmp['off_mm2']:g} mm²" + (f" ({at}, in the model's coordinates)" if at else "")
                         + (f"; volume {cmp['volume_diff_mm3']:+g} mm³" if cmp.get("volume_diff_mm3") else ""))
            if version:
                words += f"; it is {version[0]}, an earlier version" if not cmp["same"] else f" (and also matches {version[0]})"
            checks.append({"what": "model", "ok": cmp["same"], "words": words})
        elif version:
            checks.append({"what": "model", "ok": False, "words": f"{o['name']} is {version[0]}, an earlier version"})
        objects.append(entry)
    for m in models:
        if not any(o.get("model") is m for o in objs):
            checks.append({"what": "model", "ok": False, "words": f"{m['name']} isn't on the plate"})
        elif not any(o.get("model") is m and o.get("matched") for o in objs):
            pass  # said above, object by object

    # Features: on the model, on the plate's own part, and in the G-code of every copy that prints it.
    want_layers = set()
    for o in objs:
        o["to_plate"] = o["T"] @ (o.get("model_T") if o.get("model_T") is not None else np.eye(4))
    results = []
    placed_shift = {}
    if features:
        from worker import align_to_gcode
        moved = align_to_gcode([{"name": o["name"], "mesh": o["mesh"].copy()} for o in objs], text, layers)
        for o, mv in zip(objs, moved):
            shift = np.eye(4)
            if mv.get("moved"):
                shift[:2, 3] = mv["moved"]
            placed_shift[id(o)] = shift
            o["to_plate"] = shift @ o["to_plate"]
    for f in features:
        part = f.get("part")
        targets = [o for o in objs if part is None or (o.get("model") is not None and str(part).lower() in o["model"]["name"].lower())
                   or (o.get("model") is None and str(part).lower() in o["name"].lower())]
        if not targets:
            results.append({"name": f["name"], "kind": f["kind"], "ok": False, "want": want_text(f),
                            "words": f"no part on the plate is {part}"})
            continue
        first = targets[0]
        res = {"name": f["name"], "kind": f["kind"], "want": want_text(f), "copies": len(targets)}
        if first.get("model") is not None:
            res["model"] = measure_feature(f, first["model"]["mesh"])
        frame = first["frame"].copy()
        frame.apply_transform(np.linalg.inv(first.get("model_T") if first.get("model_T") is not None else np.eye(4)))
        res["plate"] = measure_feature(f, frame)
        res["_targets"], res["_f"] = targets, f
        if f["kind"] in ("gap", "empty", "hole") and f.get("gcode", True) and res["plate"]["draw"]:
            for o in targets:
                pts = res["plate"]["draw"].get("span") or ([res["plate"]["draw"]["point"]] if res["plate"]["draw"].get("point") else res["plate"]["draw"].get("ring"))
                if pts:
                    zz = float(np.mean(trimesh.transform_points(np.asarray(pts, float), o["to_plate"])[:, 2]))
                    i = layer_index(layers, zz)
                    if i is not None:
                        want_layers.add(i)
        results.append(res)
    segs = geom.parse_layers(text, want=sorted(want_layers))[1] if want_layers else {}
    for res in results:
        targets = res.pop("_targets", None)
        if not targets:
            checks.append({"what": "feature", "name": res["name"], "ok": False, "words": f"{res['name']}: {res['words']}"})
            continue
        f = res.pop("_f")
        res["_first"] = targets[0]
        gcode = []
        if f["kind"] in ("gap", "empty", "hole") and f.get("gcode", True) and res["plate"]["draw"]:
            for k, o in enumerate(targets):
                g = gcode_check(f, res["plate"], o["to_plate"], layers, segs)
                if g is not None:
                    g["copy"] = k + 1
                    gcode.append(g)
        res["gcode"] = gcode
        ok = bool(res["plate"]["ok"]) and all(g["ok"] is not False for g in gcode)
        res["ok"] = ok
        bits = [f"{res['name']}: want {res['want']}; the plate's part: {res['plate']['words']}"]
        if res.get("model") is not None and res["model"]["words"] != res["plate"]["words"]:
            bits.append(f"the model: {res['model']['words']}")
        elif res.get("model") is not None and not res["model"]["ok"]:
            bits.append("the model doesn't have it either")
        bad = [g for g in gcode if g["ok"] is False]
        if bad:
            bits.append(f"copy {bad[0]['copy']}: {bad[0]['words']}" + (f" (and {len(bad) - 1} more copies)" if len(bad) > 1 else ""))
        elif gcode and all(g["ok"] for g in gcode):
            bits.append(gcode[0]["words"] + (f", in all {len(gcode)} copies" if len(gcode) > 1 else ""))
        checks.append({"what": "feature", "name": res["name"], "ok": ok, "words": "; ".join(bits)})

    # Settings, copies, the bed.
    copies = len(objs)
    for s in settings_checks(job.get("expect"), facts, copies):
        got = s["got"]
        s["words"] = f"{s['what']}: {got if not isinstance(got, list) else ', '.join(map(str, got))}" + (
            "" if s["ok"] else f" (want {s['want'] if not isinstance(s['want'], list) else ', '.join(map(str, s['want']))})")
        checks.append({"what": "setting", **s})
    if facts.get("outside"):
        checks.append({"what": "bed", "ok": False, "words": "the slicer says part of it is off the bed"})
    diff = None
    if job.get("compare"):
        other = plate_facts(job["compare"]["path"], None)
        diff = settings_diff(facts["settings"], other["settings"])
        ocount = len(plate_objects(job["compare"]["path"]))
        words = (f"same settings as {job['compare']['name']}" if not diff else
                 f"{len(diff)} setting(s) differ from {job['compare']['name']}: " + "; ".join(
                     f"{d['key']} {d['this']} (was {d['other']})" for d in diff[:8]))
        checks.append({"what": "compare", "ok": not diff, "words": words, "diff": diff[:40],
                       "copies": {"this": copies, "other": ocount}})

    sheet = None
    if job.get("sheet") and (results or any(not c["ok"] for c in checks if c["what"] == "model")):
        sheet = draw_sheet(job, name, objs, results, objects, text, layers, segs)
    passed = all(c["ok"] for c in checks) if checks else None
    used = [f for f in facts["filaments"] if (f.get("g") or 0) > 0] or facts["filaments"]
    return {"name": name, "plate": plate, "pass": passed, "checks": checks, "objects": objects,
            "features": [{k: v for k, v in x.items() if not k.startswith("_")} for x in results], "settings_diff": diff,
            "summary": {"copies": copies, "layers": len(layers), "top_z": r(max(L["z"] for L in layers), 2) if layers else None,
                        "seconds": facts["seconds"], "grams": facts["grams"], "printer": facts["settings"].get("printer_model"),
                        "filaments": used, "layer_height": facts["settings"].get("layer_height"),
                        "walls": facts["settings"].get("wall_loops"), "infill": facts["settings"].get("sparse_infill_density"),
                        "brim": facts["settings"].get("brim_width"), "supports": facts["settings"].get("enable_support")},
            "sheet": sheet}


# The sheet


def draw_sheet(job, name, objs, results, objects, text, layers, segs):
    """One picture: each feature as the G-code lays it down around it (the first copy), with the model's outline
    and what was measured; and where a part differs from its model."""
    from worker import plt
    panels = [x for x in results if x.get("plate") and x.get("gcode")][:6]
    diffs = [(o, e) for e in objects for o in objs if o["name"] == e["name"] and e.get("same") is False][:1]
    n = len(panels) + len(diffs)
    if not n:
        return None
    P = plt()
    cols = min(n, 3)
    rows = math.ceil(n / cols)
    fig, axs = P.subplots(rows, cols, figsize=(6.0 * cols, 5.6 * rows + 0.7), dpi=100, squeeze=False)
    k = 0
    for res in panels:
        ax = axs.flat[k]
        k += 1
        g = res["gcode"][0]
        target = res.get("_first")
        win = g.get("window")
        i = (g.get("layer") or 1) - 1
        if not win:
            ax.axis("off")
            continue
        cx, cy = (win[0] + win[2]) / 2, (win[1] + win[3]) / 2
        half = max(win[2] - win[0], win[3] - win[1]) / 2 + 2.0
        window = (cx - half, cy - half, cx + half, cy + half)
        geom.style_axes(ax, "x (mm)", "y (mm)", window)
        geom.draw_layer(ax, [s for s in segs.get(i, []) if not (max(s[0], s[2]) < window[0] or min(s[0], s[2]) > window[2]
                                                                 or max(s[1], s[3]) < window[1] or min(s[1], s[3]) > window[3])], window)
        L = layers[i]
        mid = L["z"] - (L["height"] or 0.2) / 2
        if target is not None:
            placed = target["frame"].copy()  # the object as this copy prints, in the G-code's place
            placed.apply_transform(target["to_plate"] @ np.linalg.inv(target.get("model_T") if target.get("model_T") is not None else np.eye(4)))
            sec = section_at(placed, mid)
            if sec is not None:
                for p in getattr(sec, "geoms", [sec]):
                    for ring in [p.exterior, *p.interiors]:
                        c = np.asarray(ring.coords)
                        ax.plot(c[:, 0], c[:, 1], color="#111111", lw=1.0, ls=(0, (4, 2)), zorder=3)
            if target.get("model") is not None and target.get("matched") is False:
                spec = target["model"]["mesh"].copy()  # what it should be, where this copy prints
                spec.apply_transform(target["to_plate"])
                sec = section_at(spec, mid)
                if sec is not None:
                    for p in getattr(sec, "geoms", [sec]):
                        for ring in [p.exterior, *p.interiors]:
                            c = np.asarray(ring.coords)
                            ax.plot(c[:, 0], c[:, 1], color="#7b3294", lw=1.6, ls=(0, (1, 1.5)), zorder=4)
                ax.text(0.01, 0.01, "dashes: the plate's part · purple dots: the model", transform=ax.transAxes, fontsize=8,
                        color="#333333", va="bottom", bbox={"fc": "white", "ec": "none", "alpha": 0.85, "pad": 2})
        color = "#1a9850" if res["ok"] else "#d73027"
        if g.get("plate_line"):
            q = np.asarray(g["plate_line"])
            ax.plot(q[:, 0], q[:, 1], color=color, lw=2.4, zorder=5, solid_capstyle="butt")
            ax.plot(q[:, 0], q[:, 1], "o", color=color, ms=3, zorder=6)
        if g.get("plate_point"):
            ax.plot([g["plate_point"][0]], [g["plate_point"][1]], "x", color=color, ms=10, mew=2.5, zorder=6)
        if g.get("plate_ring"):
            q = np.asarray(g["plate_ring"])
            ax.plot(q[:, 0], q[:, 1], color=color, lw=1.8, zorder=5)
        mark = "✓" if res["ok"] else "✗"
        ax.set_title(f"{mark} {res['name']}\n{res['plate']['words']} · {g['words']}", fontsize=9, color=color if not res["ok"] else "#111111")
    for o, e in diffs:
        ax = axs.flat[k]
        k += 1
        model, tol = o["model"]["mesh"], float(job.get("tol") or 0.05)
        where = next((a.get("where") for a in e.get("against") or [] if a.get("model") == o["model"]["name"]), None) or []
        shown, box = model, None
        if where:
            c = np.asarray(where[0]["at"], float)
            box = [*(c - 5.0), *(c + 5.0)]
            try:
                shown = geom.crop(model, box)
            except ValueError:
                shown, box = model, None
        _, fd, _ = trimesh.proximity.closest_point(o["frame"], trimesh.transform_points(shown.triangles_center, o["model_T"]))
        rgb = np.tile(np.array([0.72, 0.75, 0.80]), (len(shown.faces), 1))
        off = fd > tol
        if box is not None:  # the crop's own caps are inside the part, not a surface to compare
            tri = shown.triangles
            lo, hi = np.asarray(box[:3]), np.asarray(box[3:])
            on_cap = np.zeros(len(tri), bool)
            for a in range(3):
                on_cap |= np.all(np.abs(tri[:, :, a] - lo[a]) < 1e-6, axis=1) | np.all(np.abs(tri[:, :, a] - hi[a]) < 1e-6, axis=1)
            off &= ~on_cap
        rgb[off] = [0.86, 0.12, 0.12]
        view = "iso"
        if off.any():
            n = (shown.face_normals[off] * shown.area_faces[off, None]).sum(axis=0)
            if np.linalg.norm(n) > 1e-9:
                n /= np.linalg.norm(n)
                tilt = np.cross(n, [0, 0, 1.0]) if abs(n[2]) < 0.9 else np.array([1.0, 0, 0])
                tilt /= np.linalg.norm(tilt)
                view = list(-n + 0.55 * tilt + (0.35 * np.array([0, 0, -np.sign(n[2]) or -1.0]) if abs(n[2]) < 0.9 else 0))
        try:
            img, _ = geom.render(shown, view, width=600, height=470, face_rgb=rgb, caps=geom.box_planes(box) if box else None)
            ax.imshow(img)
        except Exception as ex:
            ax.text(0.5, 0.5, f"can't draw it: {ex}", ha="center", transform=ax.transAxes)
        ax.axis("off")
        import textwrap
        title = (f"✗ The plate's part isn't {o['model']['name']}" + (f": up to {where[0]['max_mm']:g} mm off around "
                 f"({', '.join(f'{v:g}' for v in where[0]['at'])})" if where else ""))
        ax.set_title("\n".join(textwrap.wrap(title, 70)) + f"\nred: the model's surface more than {tol:g} mm from the plate's part",
                     fontsize=9, color="#d73027")
    for j in range(k, rows * cols):
        axs.flat[j].axis("off")
    fig.suptitle(f"{name}: checked against its spec", fontsize=13, fontweight="bold", x=0.01, ha="left")
    fig.tight_layout(rect=(0, 0, 1, 0.97))
    fig.savefig(job["sheet"], dpi=100)
    P.close(fig)
    return job["sheet"]


def op_features(job):
    """A spec's features measured on its model alone: whether the model has them (and the coordinates are right)."""
    models = model_meshes(job.get("models"))
    if not models:
        raise ValueError("no model to measure")
    out = []
    for n, f in enumerate(job.get("features") or []):
        f = normalize_feature(f, n + 1)
        part = f.get("part")
        m = next((x for x in models if part is None or str(part).lower() in x["name"].lower()), None)
        if m is None:
            out.append({"name": f["name"], "ok": False, "want": want_text(f), "words": f"no model is {part}"})
            continue
        res = measure_feature(f, m["mesh"])
        out.append({"name": f["name"], "kind": f["kind"], "ok": res["ok"], "want": want_text(f), "words": res["words"],
                    "value": res["value"]})
    return {"features": out, "models": [{"name": m["name"], "size_mm": [r(x) for x in m["mesh"].extents],
                                         "triangles": int(len(m["mesh"].faces))} for m in models]}
