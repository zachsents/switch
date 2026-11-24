"""coupon: a printable fit coupon cut from a model, so testing how one feature fits never means a hand-written script.

It keeps the part of the model that matters for the fit (a height range, any x/y/z ranges, a box or a cube around a
point) exactly as modelled, cut with manifold3d so the coupon is a closed solid. What was cut away on the bed side can
come back as a thin base of its own footprint (the solid foot under a glide's ribs swapped for a 2 mm disc, so the
ribs stay joined and sit as they would), or its hull, a disc or a rectangle around it; and a band can be taken out and
the gap closed (shorten), so a long part keeps both ends. The coupon is laid on the side asked, measured as report
measures (walls, bodies, mid-air islands, grams) and drawn: the model's section with what's kept, the coupon's, and
the coupon itself.
"""

import math
import os
import re

import numpy as np
import trimesh

import geom
from geom import r

AX = {"x": 0, "y": 1, "z": 2}
SHAPES = ("outline", "hull", "disc", "rect")
EPS = 1e-3
NUDGE = 1e-4
OVERLAP = 0.01
"""Pieces joined (a base under the coupon, the two ends of a shortened part) overlap this much, mm, so they fuse into
one solid: faces that only touch can miss each other by a rounding error and stay apart."""


# Solids


def solid(mesh):
    """The mesh as a manifold3d solid: whole when it's a closed manifold (cavities and all), else body by body (each
    closed one, unioned), saying how many bodies had to be left out."""
    from manifold3d import Error, Manifold, Mesh, OpType

    def one(m):
        mm = Manifold(Mesh(vert_properties=np.ascontiguousarray(m.vertices, np.float32),
                           tri_verts=np.ascontiguousarray(m.faces, np.uint32)))
        return mm if mm.status() == Error.NoError and not mm.is_empty() else None

    if mesh.is_watertight and mesh.volume < 0:
        mesh = mesh.copy()
        mesh.invert()  # inside out: a solid all the same
    whole = one(mesh)
    if whole is not None:
        parts = whole.decompose()
        if len(parts) > 1 and all(p.volume() > 0 for p in parts):
            whole = Manifold.batch_boolean(parts, OpType.Add)  # overlapping shells (a peg sunk into a base) as one solid
        return whole, 0
    parts, left = [], 0
    for b in mesh.split(only_watertight=False):
        if not b.is_watertight:
            left += 1
            continue
        if b.volume < 0:
            b.invert()
        mm = one(b)
        if mm is None:
            left += 1
        else:
            parts.append(mm)
    if not parts:
        raise ValueError("the model isn't a closed solid anywhere (report says where it's open), so a coupon can't be cut "
                         "from it: repair it first")
    return Manifold.batch_boolean(parts, OpType.Add), left


def to_trimesh(mm):
    m = mm.to_mesh()
    return trimesh.Trimesh(np.asarray(m.vert_properties)[:, :3].astype(float), np.asarray(m.tri_verts), process=True)


def cube(lo, hi):
    from manifold3d import Manifold
    lo, hi = np.asarray(lo, float), np.asarray(hi, float)
    return Manifold.cube(list(hi - lo)).translate(list(lo))


# What was asked


def span(v, name):
    """A range as given: [lo, hi] (either may be null: the model's own end), "lo..hi" ("31.." or "..12"), or {from, to}."""
    if v is None:
        return None
    if isinstance(v, dict):
        v = [v.get("from"), v.get("to")]
    if isinstance(v, str):
        m = re.fullmatch(r"\s*(-?[\d.]*)\s*(?:\.\.|to|:)\s*(-?[\d.]*)\s*", v)
        if not m:
            raise ValueError(f"can't read {name} {v!r}: give [lo, hi], with null for the model's own end, or \"lo..hi\"")
        v = [m[1] or None, m[2] or None]
    if not isinstance(v, (list, tuple)) or len(v) != 2:
        raise ValueError(f"{name} is [lo, hi] (null for the model's own end)")
    lo, hi = (None if x in (None, "") else float(x) for x in v)
    if lo is not None and hi is not None and hi <= lo:
        raise ValueError(f"{name} runs from {lo:g} to {hi:g}: the second end must be the higher")
    return [lo, hi]


def keep_box(job, bounds):
    """The region kept, as [lo, hi] per axis with None for the model's own end, from x/y/z ranges, a box or around."""
    want = [[None, None] for _ in range(3)]
    if job.get("box") is not None:
        b = [float(x) for x in job["box"]]
        if len(b) != 6:
            raise ValueError("box is [x0, y0, z0, x1, y1, z1]")
        want = [[min(b[a], b[a + 3]), max(b[a], b[a + 3])] for a in range(3)]
    elif job.get("around") is not None:
        c = [float(x) for x in job["around"]]
        rad = float(job.get("radius") or 10)
        want = [[c[a] - rad, c[a] + rad] for a in range(3)]
    for name, a in AX.items():
        s = span(job.get(name), name)
        if s is not None:
            want[a] = s
    lo, hi = bounds
    for a in range(3):  # an end beyond the model is as good as its own end
        a0 = lo[a] if want[a][0] is None else max(want[a][0], lo[a])
        a1 = hi[a] if want[a][1] is None else min(want[a][1], hi[a])
        if a1 - a0 < EPS:
            n = "xyz"[a]
            raise ValueError(f"the model runs {r(lo[a])}..{r(hi[a])} mm in {n}; {n} {want[a]} keeps none of it")
    return want


def shorten_band(v):
    """The band taken out: [a, b] along z, or {"x"|"y"|"z": [a, b]}."""
    if v is None:
        return None
    axis = "z"
    if isinstance(v, dict) and len(v) == 1 and next(iter(v)) in AX:
        axis, v = next(iter(v.items()))
    s = span(v, "shorten")
    if s is None or None in s:
        raise ValueError("shorten is the band to take out, [a, b] with both ends (or {\"x\": [a, b]})")
    return axis, s


def flat_levels(mesh, a):
    """Where the model has flat faces across axis a (a shoulder, a step, a floor): {level: area mm²}, 1 mm² and up."""
    sel = np.abs(mesh.face_normals[:, a]) > 0.999
    out = {}
    for level, area in zip(np.round(mesh.triangles_center[sel, a], 3), mesh.area_faces[sel]):
        out[float(level)] = out.get(float(level), 0.0) + float(area)
    return {k: v for k, v in out.items() if v >= 1.0}


def snap_cuts(mesh, want, lo, hi, tol):
    """Each cut moved onto a flat face of the model within tol of it (a cut meant for the top of a foot lands on it,
    not a hair into the ribs above), saying where it went."""
    notes = []
    if not tol:
        return notes
    for a in range(3):
        levels = None
        for k in (0, 1):
            v = want[a][k]
            if v is None or not lo[a] + EPS < v < hi[a] - EPS:
                continue
            levels = flat_levels(mesh, a) if levels is None else levels
            near = [x for x in levels if abs(x - v) <= float(tol) and lo[a] + EPS < x < hi[a] - EPS]
            if not near or min(abs(x - v) for x in near) < 1e-3:
                continue
            x = min(near, key=lambda q: abs(q - v))
            want[a][k] = x
            notes.append(f"cut at {'xyz'[a]} {x:g}, on the model's flat face {abs(x - v):.2g} mm from the {v:g} asked "
                         "(snap: 0 cuts exactly where asked)")
    return notes


# The cut


def rotation(down):
    if down not in geom.DOWNS:
        raise ValueError(f"down is one of {', '.join(geom.DOWNS)}")
    rot = geom.DOWNS[down]
    return np.eye(4) if rot is None else trimesh.transformations.rotation_matrix(rot[0], rot[1])


def turn(mm, R):
    return mm.transform(np.ascontiguousarray(R[:3, :4]))


def footprint(removed, shape, margin):
    """What was cut away on the bed side, seen from above, as the base's outline."""
    from manifold3d import CrossSection, JoinType
    shadow = removed.project()
    if shadow.is_empty() or shadow.area() < 1e-3:
        return None
    if shape == "hull":
        shadow = shadow.hull()
    elif shape in ("disc", "rect"):
        x0, y0, x1, y1 = shadow.bounds()
        if shape == "rect":
            return CrossSection.square([x1 - x0 + 2 * margin, y1 - y0 + 2 * margin]).translate([x0 - margin, y0 - margin])
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        pts = np.vstack([np.asarray(p) for p in shadow.to_polygons()])
        rad = float(np.max(np.hypot(pts[:, 0] - cx, pts[:, 1] - cy))) + margin
        return CrossSection.circle(rad, max(64, int(rad * 8))).translate([cx, cy])
    return shadow.offset(margin, JoinType.Round) if margin else shadow


def cut(model_mesh, job):
    """The coupon, in the frame it prints in, and what was done to make it."""
    from manifold3d import Manifold
    M, left_out = solid(model_mesh)
    down = job.get("down") or "z-"
    R = rotation(down)
    lo0, hi0 = model_mesh.bounds
    want = keep_box(job, (lo0, hi0))
    notes = snap_cuts(model_mesh, want, lo0, hi0, 0.5 if job.get("snap") is None else job["snap"])
    # The kept box in the model's own frame (open ends a little past the model, so they cut nothing), then turned.
    pad = 1.0 + 0.01 * float(np.max(hi0 - lo0))
    # A cut on a flat face of the model leaves a film of it, no thicker than nothing, joining what it should part:
    # each cut sits a tenth of a micron inside what's kept instead.
    blo = np.array([lo0[a] - pad if want[a][0] is None else want[a][0] + NUDGE for a in range(3)])
    bhi = np.array([hi0[a] + pad if want[a][1] is None else want[a][1] - NUDGE for a in range(3)])
    corners = np.array([[x, y, z] for x in (blo[0], bhi[0]) for y in (blo[1], bhi[1]) for z in (blo[2], bhi[2])])
    tc = corners @ R[:3, :3].T
    tlo, thi = tc.min(axis=0), tc.max(axis=0)
    T = turn(M, R)
    b = T.bounding_box()
    mlo, mhi = np.array(b[:3]), np.array(b[3:])
    W = T ^ cube(tlo, thi)
    if W.is_empty():
        raise ValueError("nothing of the model is inside what was asked to keep")
    cuts = {f"{'xyz'[a]}{'-+'[k]}": True for a in range(3) for k in (0, 1)
            if want[a][k] is not None and (lo0[a] + EPS < want[a][k] < hi0[a] - EPS)}
    base = None
    t = float(job.get("base") or 0)
    if t > 0:
        shape = job.get("base_shape") or "outline"
        if shape not in SHAPES:
            raise ValueError(f"base_shape is one of {', '.join(SHAPES)}")
        margin = float(job.get("margin") or 0)
        if tlo[2] > mlo[2] + EPS:
            # What was cut away under the coupon, inside the kept box's other sides.
            under = T ^ cube([tlo[0], tlo[1], mlo[2] - 1], [thi[0], thi[1], tlo[2]])
            outline = footprint(under, shape, margin) if not under.is_empty() else None
            if outline is None:
                notes.append("nothing was cut away under the coupon, so it has no base")
            else:
                slab = Manifold.extrude(outline, t + OVERLAP).translate([0, 0, tlo[2] - t])
                W = W + slab
                x0, y0, x1, y1 = outline.bounds()
                base = {"mm": r(t), "shape": shape, "margin": r(margin), "size_mm": [r(x1 - x0), r(y1 - y0)],
                        "area_mm2": r(outline.area(), 1), "replaces_mm": r(tlo[2] - mlo[2])}
                if shape == "disc":
                    base["d"] = r(x1 - x0)
        else:
            notes.append(f"its {down} side is the model's own, not a cut, so it needs no base")
    band = shorten_band(job.get("shorten"))
    short = None
    if band is not None:
        axis, (a, b2) = band
        e = np.zeros(3)
        e[AX[axis]] = 1
        d = R[:3, :3] @ e
        k = int(np.argmax(np.abs(d)))
        s = float(np.sign(d[k]))
        lo_t, hi_t = sorted((a * s, b2 * s))
        n = np.zeros(3)
        n[k] = 1
        low = W.trim_by_plane(list(-n), -(lo_t + OVERLAP))
        high = W.trim_by_plane(list(n), hi_t)
        if low.is_empty() or high.is_empty():
            raise ValueError(f"shorten {axis} {a:g}..{b2:g} leaves nothing on one side of the band: keep a range instead")
        shift = np.zeros(3)
        shift[k] = -(hi_t - lo_t)
        W = low + high.translate(list(shift))
        short = {"axis": axis, "from": r(a), "to": r(b2), "taken_out_mm": r(b2 - a)}
    out_lo = np.array(W.bounding_box()[:3])
    move = np.array([0.0, 0.0, -out_lo[2]])
    if job.get("center"):
        bb = W.bounding_box()
        move[:2] = [-(bb[0] + bb[3]) / 2, -(bb[1] + bb[4]) / 2]
    W = W.translate(list(move))
    kept = {"xyz"[a]: [r(max(blo[a], lo0[a])), r(min(bhi[a], hi0[a]))] for a in range(3)}
    return {"solid": W, "model": M, "R": R, "move": move, "kept": kept, "cuts": sorted(cuts), "base": base,
            "shorten": short, "down": down, "left_out_bodies": left_out, "notes": notes,
            "model_volume": float(M.volume()), "model_bounds": [lo0, hi0], "box": (blo, bhi)}


# The sheet


FRAME = {0: (1, 2), 1: (0, 2), 2: (0, 1)}
"""The two axes a picture along each axis shows, the second one up."""


def silhouette(mm, i, j):
    """A solid's outline seen along the third axis, in (axis i, axis j) coordinates, as shapely geometry."""
    from functools import reduce

    from shapely.geometry import Polygon
    if mm.is_empty():
        return None
    T = np.zeros((3, 4))
    T[0, i] = T[1, j] = T[2, 3 - i - j] = 1
    polys = [Polygon(c).buffer(0) for c in mm.transform(T).project().to_polygons() if len(c) >= 3]
    polys = [q for q in polys if not q.is_empty]
    return reduce(lambda a, b: a.symmetric_difference(b), polys) if polys else None


def kept_solid(made):
    """What the coupon keeps of the model, where it was in the model (before a base, a shortening or turning)."""
    blo, bhi = made["box"]
    K = made["model"] ^ cube(blo, bhi)
    s = made["shorten"]
    if s:
        n = np.zeros(3)
        n[AX[s["axis"]]] = 1
        K = K.trim_by_plane(list(-n), -s["from"]) + K.trim_by_plane(list(n), s["to"])
    return K


def section_axis(model_mesh, made, asked):
    """The side the pictures look from: the one asked, else whichever of y and x cuts more of what's kept."""
    if asked:
        return asked
    blo, bhi = made["box"]
    lo0, hi0 = made["model_bounds"]
    c = [(max(blo[a], lo0[a]) + min(bhi[a], hi0[a])) / 2 for a in range(3)]
    best, area = None, -1.0
    for a in (1, 0):
        spec = f"{'xyz'[a]}={c[a]:.4f}"
        pl = geom.plane_spec(spec, model_mesh)
        g, _ = geom.section_polys(model_mesh, pl["origin"], pl["normal"], pl["up"])
        got = g.area if g is not None else 0.0
        if got > area * 1.15:
            best, area = spec, got
    return best


def sheet(P, legend, name, model_mesh, coupon_mesh, made, o, extra, thin, out_path, plane_spec=None):
    """Three panels: the model from the side with what's kept, the coupon from the same side with its section, and
    the coupon from an angle coloured by wall thickness."""
    from matplotlib.patches import Patch
    plane = geom.plane_spec(section_axis(model_mesh, made, plane_spec), model_mesh)
    if plane["axis"] is None:
        raise ValueError("plane is an axis cut for the coupon's sheet, like y=0 or x=3")
    i, j = FRAME[plane["axis"]]
    lo0, hi0 = made["model_bounds"]
    blo, bhi = made["box"]
    # The model: its outline from the side, what's kept in blue, the cuts dashed.
    whole = silhouette(made["model"], i, j)
    kept = silhouette(kept_solid(made), i, j)
    # The coupon from the same side, turned as it was: its outline, and its section where the model's was taken.
    R, move = made["R"], made["move"]
    k2 = int(np.argmax(np.abs(R[:3, :3] @ np.asarray(plane["normal"], float))))
    i2, j2 = FRAME[k2]
    c = coupon_mesh.bounds.mean(axis=0)
    p0 = R[:3, :3] @ np.asarray(plane["origin"], float) + move
    at = p0[k2] if coupon_mesh.bounds[0, k2] < p0[k2] < coupon_mesh.bounds[1, k2] else c[k2]
    cp = geom.plane_spec(f"{'xyz'[k2]}={at:.4f}", coupon_mesh)
    outline2 = silhouette(made["solid"], i2, j2)
    g2, _ = geom.section_polys(coupon_mesh, cp["origin"], cp["normal"], cp["up"])
    g2 = geom.in_world(g2, cp) if g2 is not None else None
    win1 = geom.window_of(whole) if whole is not None else (0, 0, 1, 1)
    win2 = geom.window_of(outline2 if outline2 is not None else g2) if (outline2 is not None or g2 is not None) else (0, 0, 1, 1)
    ratios = [max(0.45, (w[2] - w[0]) / max(w[3] - w[1], 1e-3)) for w in (win1, win2)] + [760 / 600]
    ratios = [min(x, 2.2) for x in ratios]
    fig = P.figure(figsize=(min(26.0, 1.6 + 6.2 * sum(ratios)), 7.4), dpi=100)
    gs = fig.add_gridspec(1, 3, width_ratios=ratios)
    axs = [fig.add_subplot(gs[0, k]) for k in range(3)]
    ax = axs[0]
    if whole is not None:
        geom.draw_geom(ax, whole, face="#d5d9e0", edge="#8a93a3", lw=0.6)
        if kept is not None:
            geom.draw_geom(ax, kept, face="#2f6fd6", edge="#123a7a", lw=0.8)
        geom.style_axes(ax, f"{'xyz'[i]} (mm)", f"{'xyz'[j]} (mm)", win1)
        for a, k in made["cuts"]:
            ai = AX[a]
            v = blo[ai] if k == "-" else bhi[ai]
            if ai == i:
                ax.axvline(v, color="#c0392b", lw=1.2, ls="--")
            elif ai == j:
                ax.axhline(v, color="#c0392b", lw=1.2, ls="--")
        s = made["shorten"]
        if s and AX[s["axis"]] in (i, j):
            line = ax.axvline if AX[s["axis"]] == i else ax.axhline
            line(s["from"], color="#8e44ad", lw=1.2, ls=":")
            line(s["to"], color="#8e44ad", lw=1.2, ls=":")
        ax.legend(handles=[Patch(fc="#2f6fd6", ec="#123a7a", label="kept"),
                           Patch(fc="#d5d9e0", ec="#8a93a3", label="cut away")], loc="upper right", fontsize=8)
    else:
        ax.axis("off")
    ax.set_title(f"Model · from {'-' if plane['normal'][plane['axis']] > 0 else '+'}{'xyz'[plane['axis']]}")
    ax = axs[1]
    if outline2 is not None or g2 is not None:
        if outline2 is not None:
            geom.draw_geom(ax, outline2, face="#c9daf5", edge="#5b84c4", lw=0.6)
        if g2 is not None:
            f = geom.section_facts(g2, cp, extra.get("samples"), extra.get("spacing"))
            geom.draw_geom(ax, g2, face="#3d4654", edge="#111111")
            geom.annotate_section(ax, f, thin=thin)
        geom.style_axes(ax, f"{'xyz'[i2]} (mm)", f"{'xyz'[j2]} (mm)", win2)
        if made["base"] and j2 == 2:
            ax.axhline(made["base"]["mm"], color="#c0392b", lw=1.0, ls="--")
        ax.legend(handles=[Patch(fc="#3d4654", label=f"section {cp['label']}"),
                           Patch(fc="#c9daf5", ec="#5b84c4", label="outline")], loc="upper right", fontsize=8)
    else:
        ax.axis("off")
    ax.set_title("Coupon · on the bed")
    ax = axs[2]
    colors = geom.wall_colors(extra["face_wall"], thin) if extra.get("face_wall") is not None else None
    img, _ = geom.render(coupon_mesh, "iso", width=760, height=600, face_rgb=colors)
    ax.imshow(img)
    ax.axis("off")
    legend(ax, thin)
    ax.set_title("Coupon · walls")
    size = " × ".join(f"{x:g}" for x in o["size_mm"])
    fig.suptitle(f"{name} → {size} mm coupon" + (f", {o['volume_cm3']:g} cm³" if o.get("volume_cm3") else ""),
                 fontsize=14, fontweight="bold", x=0.01, ha="left")
    fig.tight_layout(rect=(0, 0, 1, 0.95))
    fig.savefig(out_path, dpi=100, bbox_inches="tight", pad_inches=0.15)
    P.close(fig)
    return {"model_view": f"along {'xyz'[plane['axis']]}", "coupon_section": cp["label"]}


def works():
    """A 20 × 10 × 5 box cut at z 2 with a 1 mm base comes out a closed 20 × 10 × 4 block: the warm check."""
    box = trimesh.creation.box((20, 10, 5))
    box.apply_translation([0, 0, 2.5])
    made = cut(box, {"z": [2, None], "base": 1, "snap": 0})
    m = to_trimesh(made["solid"])
    return bool(m.is_watertight) and [r(x) for x in m.extents] == [20, 10, 4] and abs(m.volume - 800) < 1


def op_coupon(job, pick, plt, legend):
    model = pick(job["file"], job["name"], job.get("object"))
    m = model["mesh"]
    thin = float(job.get("thin") or 0.8)
    made = cut(m, job)
    coupon_mesh = to_trimesh(made["solid"])
    if not len(coupon_mesh.faces):
        raise ValueError("the cut leaves nothing")
    stem = job.get("stem") or os.path.splitext(job["name"].replace(".gcode.3mf", ".3mf"))[0] + "-coupon"
    os.makedirs(job["out_dir"], exist_ok=True)
    path = os.path.join(job["out_dir"], f"{stem}.stl")
    coupon_mesh.export(path)
    o, extra = geom.measure({"name": f"{stem}.stl", "mesh": coupon_mesh, "left_out": []}, thin=thin)
    vol = abs(float(made["solid"].volume()))
    out = {"name": f"{stem}.stl", "path": path, "model": model["name"], "size_mm": o["size_mm"],
           "model_size_mm": [r(x) for x in m.extents], "watertight": o["watertight"], "triangles": o["triangles"],
           "volume_cm3": r(vol / 1000, 2), "solid_grams": {k: r(vol / 1000 * d, 1) for k, d in geom.DENSITY.items()},
           "of_model": r(vol / made["model_volume"], 3) if made["model_volume"] else None,
           "bodies": o["bodies"]["count"], "wall": {k: o["wall"].get(k) for k in ("min", "p1", "median") if o.get("wall")},
           "thin_walls": o.get("thin_walls", [])[:3], "floating": o.get("floating", [])[:3],
           "problems": o.get("problems", []), "bed": o["bed"], "kept": made["kept"], "cuts": made["cuts"],
           "base": made["base"], "shorten": made["shorten"], "down": made["down"], "notes": made["notes"],
           "left_out_bodies": made["left_out_bodies"]}
    if out["bodies"] > 1:
        out["problems"].insert(0, f"it comes apart in {out['bodies']} pieces" + (
            ": give it a base (base: 2) so they stay joined" if not made["base"] else
            ": the base doesn't reach them all; try base_shape hull or disc"))
    if job.get("sheet"):
        out["sheet"] = sheet(plt(), legend, model["name"], m, coupon_mesh, made, o, extra, thin, job["sheet"],
                             job.get("plane"))
    return out

