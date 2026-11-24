"""One job for mesh, run in its own process with its own environment (uv gives it numpy, trimesh, Embree...):

    uv run --no-project --python 3.12 --with ... python -I worker.py JOB.json RESULT.json

JOB.json is {"op": warm|report|section|view|layers|supports|convert|coupon|scene|verify|drawing|variants, ...}; RESULT.json gets {"ok", "error", ...the op's own
fields}. Pictures go where the job says; nothing big comes back in the result.
"""

import json
import math
import os
import re
import sys
import time
import traceback
import warnings
import zipfile

warnings.filterwarnings("ignore")  # numpy's divide-by-zero notes from trimesh on open meshes say nothing to anyone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # -I leaves the script's own folder out; geom.py lives beside it

import numpy as np  # noqa: E402

import coupon  # noqa: E402
import drawing  # noqa: E402
import geom  # noqa: E402
import scenes  # noqa: E402
import supports  # noqa: E402
import support_3d  # noqa: E402
import variants  # noqa: E402
import verify  # noqa: E402
from geom import r  # noqa: E402

DPI = 100


def plt():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as p
    p.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9, "axes.titlesize": 10, "axes.titleweight": "bold"})
    return p


# Picking models


def fingerprint(m):
    return (len(m.faces), round(float(m.area), 1), tuple(np.round(np.sort(m.extents), 1)))


def models_of(path, name, objects="each"):
    """The models in a file, identical copies on a plate folded into one with how many there are."""
    models = geom.load(path, objects=objects, name=name)
    if objects == "merged" or len(models) < 2:
        for m in models:
            m.setdefault("copies", 1)
        return models
    groups = {}
    for m in models:
        groups.setdefault(fingerprint(m["mesh"]), []).append(m)
    out = []
    for group in groups.values():
        first = group[0]
        first["copies"] = len(group)
        if len(group) > 1:
            first["name"] = first["name"].rsplit(" #", 1)[0]
        out.append(first)
    return out


def pick(path, name, obj=None):
    """The one model a section or view works on: an object by number or name, else everything as placed."""
    models = geom.load(path, objects="each", name=name)
    if obj in (None, "", "all", "merged"):
        if len(models) == 1:
            return models[0]
        import trimesh
        mesh = trimesh.util.concatenate([m["mesh"] for m in models])
        return {"name": f"{name} (all {len(models)} objects as placed)", "mesh": mesh, "left_out": [], "note": None}
    if isinstance(obj, int) or (isinstance(obj, str) and obj.isdigit()):
        i = int(obj) - 1
        if not 0 <= i < len(models):
            raise ValueError(f"{name} has {len(models)} object(s); there's no object {obj}")
        return models[i]
    found = [m for m in models if str(obj).lower() in m["name"].lower()]
    if not found:
        raise ValueError(f"no object named like {obj!r} in {name}: it has {', '.join(m['name'] for m in models)}")
    return found[0]


# report


def fmt_size(s):
    return " × ".join(f"{x:g}" for x in s) + " mm"


def facts_line(o):
    bits = [fmt_size(o["size_mm"])]
    if o.get("copies", 1) > 1:
        bits.append(f"{o['copies']} copies on the plate")
    bits.append("closed solid" if o["watertight"] else "NOT closed")
    if o.get("volume_cm3") is not None:
        bits.append(f"{o['volume_cm3']:g} cm³ ({o['solid_grams']['PLA']:g} g solid PLA)")
    b = o["bodies"]["count"]
    bits.append(f"{b} bod{'y' if b == 1 else 'ies'}")
    w = o.get("wall") or {}
    if w.get("min") is not None:
        bits.append(f"walls {w.get('p1')}–{w.get('median')} mm (1st pct–median)")
    bits.append(f"{o['triangles']:,} triangles")
    bits.append("fits the bed " + o["bed"]["how"] if o["bed"]["fits"] else o["bed"]["how"])
    return " · ".join(bits)


def interesting_heights(o, sections, n=4):
    """Heights worth a section: the thinnest wall, the smallest hole, the first island in mid-air, then spread out."""
    zmin, zmax = o["min"][2], o["max"][2]
    picks = []
    if o["thin_walls"]:
        picks.append(o["thin_walls"][0]["at"][2])
    small = [h for h in o["holes"] if (h.get("d") or h.get("w") or 99) < 3]
    if small:
        picks.append((small[0]["z_from"] + small[0]["z_to"]) / 2)
    if o["floating"]:
        picks.append(o["floating"][0]["z"] + 0.3)
    for f in (0.5, 0.25, 0.75, 0.1, 0.9):
        picks.append(zmin + (zmax - zmin) * f)
    out = []
    for z in picks:
        z = min(max(z, zmin + 0.05), zmax - 0.05) + geom.OFF_FACE
        if all(abs(z - q) > max(0.6, (zmax - zmin) * 0.08) for q in out):
            out.append(z)
        if len(out) == n:
            break
    return sorted(out)


def legend_thickness(ax, thin):
    from matplotlib.patches import Patch
    hs = [Patch(color=(0.86, 0.12, 0.12), label=f"wall < {geom.NOZZLE:g} mm"),
          Patch(color=(0.97, 0.55, 0.15), label=f"< {thin:g} mm"),
          Patch(color=(0.98, 0.85, 0.35), label=f"< {thin * 1.5:g} mm"),
          Patch(color=(0.93, 0.55, 0.50), label="inside / cut")]
    ax.legend(handles=hs, loc="lower left", fontsize=7, frameon=True, framealpha=0.85, ncol=2)


def legend_overhang(ax):
    from matplotlib.patches import Patch
    hs = [Patch(color=(0.98, 0.85, 0.35), label="overhang 45–60°"), Patch(color=(0.97, 0.55, 0.15), label="60–75°"),
          Patch(color=(0.86, 0.12, 0.12), label="75–90° (ceilings)")]
    ax.legend(handles=hs, loc="lower left", fontsize=7, frameon=True, framealpha=0.85)


def markers(o):
    """The places the sheet points at: the thinnest walls (W1...) and narrowest gaps (G1...)."""
    out = [(f"W{i + 1}", c["at"], "#d7191c") for i, c in enumerate(o["thin_walls"][:3])]
    out += [(f"G{i + 1}", c["at"], "#1f6fe0") for i, c in enumerate(o["narrow_gaps"][:2])]
    return out


def mark(ax, proj, marks):
    """Rings the places on a view, one label for those that land on the same spot (G1 G2)."""
    spots = []
    for label, at, color in marks:
        x, y, seen = geom.to_pixel(proj, at)
        if not seen:
            continue
        near = next((s for s in spots if math.hypot(s[0] - x, s[1] - y) < 22), None)
        if near:
            near[2].append(label)
            continue
        spots.append([x, y, [label], color])
    for x, y, labels, color in spots:
        ax.plot([x], [y], "o", ms=13, mfc="none", mec=color, mew=2.2)
        ax.annotate(" ".join(labels), (x, y), xytext=(9, 7), textcoords="offset points", color=color, fontsize=9,
                    fontweight="bold", bbox=dict(boxstyle="round,pad=0.15", fc="white", ec=color, lw=0.7, alpha=0.9))


def wrap(text, width):
    import textwrap
    return "\n".join(textwrap.wrap(text, width))


def thickness_samples(samples, thin):
    """Thickness samples as the renderer colours by them: (points, normals, rgb)."""
    if samples is None:
        return None
    pts, nrm, wall, _ = samples
    return pts, nrm, geom.wall_colors(wall, thin)


def public(facts):
    """A section's facts without what only drawing it needs."""
    return {k: v for k, v in facts.items() if not k.startswith("_")}


def report_sheet(o, model, extra, thin, out_path):
    P = plt()
    m = model["mesh"]
    walls = thickness_samples(extra.get("samples"), thin)
    over = geom.overhang_colors(m, m.bounds[0, 2])
    views = []
    for view, colors, title in (("iso", None, "Wall thickness, front right"), ("iso-back", None, "Wall thickness, back left"),
                                ("top", None, "From above"), ("bottom", over, "From below: overhangs")):
        img, proj = geom.render(m, view, width=640, face_rgb=colors, samples=walls if colors is None else None)
        views.append((view, img, proj, title))
    view_aspect = max(img.shape[0] / img.shape[1] for _, img, _, _ in views)
    heights = interesting_heights(o, extra.get("sections") or [])
    lo, hi = o["min"], o["max"]
    span = max(hi[0] - lo[0], hi[1] - lo[1], 1)
    win = (lo[0] - span * 0.04, lo[1] - span * 0.04, hi[0] + span * 0.04, hi[1] + span * 0.04)
    sec_aspect = min(1.25, max(0.35, (win[3] - win[1]) / (win[2] - win[0])))
    col_w = 20 / 4
    head_h, view_h, sec_h = 1.55, col_w * view_aspect + 0.35, col_w * sec_aspect + 0.7
    fig_h = head_h + view_h + (sec_h if heights else 0)
    fig = P.figure(figsize=(20, fig_h), dpi=DPI)
    rows = [head_h, view_h] + ([sec_h] if heights else [])
    gs = fig.add_gridspec(len(rows), 4, height_ratios=rows, hspace=0.18, wspace=0.14, left=0.035, right=0.99,
                          top=1 - 0.12 / fig_h, bottom=0.45 / fig_h)
    head = fig.add_subplot(gs[0, :])
    head.axis("off")
    head.text(0, 1, o["name"], fontsize=17, fontweight="bold", va="top")
    head.text(0, 0.66, facts_line(o), fontsize=10.5, va="top", color="#333")
    probs = o["problems"]
    text = ("Watch: " + " · ".join(probs[:5])) if probs else "Nothing in the geometry stands in the way of printing it as it is."
    head.text(0, 0.36, wrap(text, 210), fontsize=10, va="top", color="#b3261e" if probs else "#1a7a3a", linespacing=1.4)
    marks = markers(o)
    for col, (view, img, proj, title) in enumerate(views):
        ax = fig.add_subplot(gs[1, col])
        ax.imshow(img)
        ax.set_title(title)
        ax.axis("off")
        mark(ax, proj, marks)
        if col == 0:
            legend_thickness(ax, thin)
        if col == 3:
            legend_overhang(ax)
    secs = []
    for col, z in enumerate(heights):
        ax = fig.add_subplot(gs[2, col])
        plane = geom.plane_spec({"axis": "z", "at": z}, m)
        g, _ = geom.section_polys(m, plane["origin"], plane["normal"], plane["up"])
        if g is None:
            ax.axis("off")
            continue
        g = geom.in_world(g, plane)
        f = geom.section_facts(g, plane, extra.get("samples"), extra.get("spacing"))
        geom.draw_geom(ax, g)
        geom.style_axes(ax, "x (mm)", "y (mm)", win)
        geom.annotate_section(ax, f, thin=thin)
        w = f["thinnest_wall"]
        ax.set_title(f"Section at z {plane['origin'][2]:.2f}" + (f" · thinnest wall {w['mm']} mm" if w else ""))
        secs.append({"z": r(plane["origin"][2]), **public(f)})
    fig.savefig(out_path, dpi=DPI)
    P.close(fig)
    return secs


def op_report(job):
    thin = float(job.get("thin") or 0.8)
    results = []
    for f in job["files"]:
        started = time.time()
        try:
            models = models_of(f["path"], f["name"], job.get("objects") or "each")
        except geom.Unreadable as e:
            results.append({"name": f["name"], "error": str(e)})
            continue
        for i, model in enumerate(models[: int(job.get("max_models") or 12)]):
            o, extra = geom.measure(model, thin=thin, samples=job.get("samples"))
            o["copies"] = model.get("copies", 1)
            if f.get("label"):
                o["label"] = f["label"]
            if job.get("sheet_dir") and i < int(job.get("max_sheets") or 8):
                safe = "".join(c if c.isalnum() or c in "._-" else "-" for c in o["name"])[:80]
                path = os.path.join(job["sheet_dir"], f"{len(results) + 1:02d}-{safe}.png")
                o["sections"] = report_sheet(o, model, extra, thin, path)
                o["sheet"] = path
            o["seconds"] = r(time.time() - started, 1)
            results.append(o)
        if len(models) > int(job.get("max_models") or 12):
            results.append({"name": f["name"], "note": f"{len(models) - int(job.get('max_models') or 12)} more object(s) not reported"})
    return {"models": results}


# section


def section_planes(job, m):
    planes = []
    for p in job.get("planes") or []:
        planes.append(geom.plane_spec(p, m))
    if job.get("through") is not None:
        x, y, z = [float(v) for v in job["through"]]
        planes += [geom.plane_spec({"axis": "z", "at": z}, m), geom.plane_spec({"axis": "y", "at": y}, m),
                   geom.plane_spec({"axis": "x", "at": x}, m)]
    axis = job.get("axis") or "z"
    for at in job.get("at") or []:
        planes.append(geom.plane_spec({"axis": axis, "at": float(at)}, m))
    if not planes:
        a = geom.AXES[axis]
        lo, hi = m.bounds[0, a], m.bounds[1, a]
        n = int(job.get("count") or 4)
        for k in range(n):
            planes.append(geom.plane_spec({"axis": axis, "at": round(lo + (hi - lo) * (k + 0.5) / n, 2)}, m))
    if len(planes) > 12:
        raise ValueError(f"{len(planes)} sections is too many for one sheet: ask for 12 at most")
    return planes


def crop_box(job):
    if job.get("box"):
        b = [float(v) for v in job["box"]]
        if len(b) != 6:
            raise ValueError("box is [x0, y0, z0, x1, y1, z1]")
        return [min(b[0], b[3]), min(b[1], b[4]), min(b[2], b[5]), max(b[0], b[3]), max(b[1], b[4]), max(b[2], b[5])]
    if job.get("around") is not None:
        return geom.around_box([float(v) for v in job["around"]], float(job.get("radius") or 10))
    return None


VERSION_COLORS = ("#d1495b", "#2e7fd6", "#2a9d5b", "#8e44ad")
"""Each version's outline in a compare, first to last."""
BOTH = "#c3c9d2"
"""What every compared version has, filled."""


def tint(hex_color, k=0.55):
    """A colour washed toward white, for filling what only one version has."""
    c = np.array([int(hex_color[i:i + 2], 16) for i in (1, 3, 5)], float) / 255
    return tuple(c + (1 - c) * k)


def version_label(name):
    base = os.path.basename(str(name))
    return re.sub(r"\.(stl|3mf|step|stp|obj|ply)$", "", base, flags=re.I) or base


def short_labels(names):
    """What tells versions' file names apart: the words they share at the start and end dropped (syec-flex-n8-t1.0-rc4.5
    and syec-flex-n6-t1.2-rc4.5 are n8-t1.0 and n6-t1.2), and the stem they share, like syec-flex-…-rc4.5. Names
    that differ in nothing keep their whole names."""
    split = [re.split(r"([-_ ]+)", n) for n in names]
    words = [s[0::2] for s in split]
    if len(names) < 2 or len(set(names)) < len(names):
        return list(names), None
    lo = 0
    while all(len(x) > lo + 1 for x in words) and len({x[lo] for x in words}) == 1:
        lo += 1
    hi = 0
    while all(len(x) > lo + hi + 1 for x in words) and len({x[-1 - hi] for x in words}) == 1:
        hi += 1
    if lo == 0 and hi == 0:
        return list(names), None
    out = []
    for s in split:
        keep = s[2 * lo: len(s) - 2 * hi]
        out.append("".join(keep).strip("-_ ") or "".join(s))
    first = split[0]
    return out, "".join(first[:2 * lo]) + "…" + "".join(first[len(first) - 2 * hi:])


def versions_of(job):
    """The model and each version to compare with it, with its label, moved to line up with the first when align asks."""
    asked = [{"path": job["file"], "name": job["name"]}] + list(job.get("compare") or [])
    labels = list(job.get("labels") or [])
    if len(labels) > len(asked):
        raise ValueError(f"{len(labels)} labels for {len(asked)} version(s): give one per version, the file's first")
    out, seen = [], set()
    shorts, stem = short_labels([version_label(v["name"]) for v in asked])
    job["_stem"] = stem if not any(str(x or "").strip() for x in labels) else None
    for k, v in enumerate(asked):
        model = pick(v["path"], v["name"], job.get("object"))
        label = str(labels[k]).strip() if k < len(labels) and str(labels[k] or "").strip() else shorts[k]
        while label in seen:
            label += f" ({k + 1})"
        seen.add(label)
        out.append({"model": model, "mesh": model["mesh"], "label": label, "name": v["name"], "shift": None})
    if job.get("align") not in (None, "", "placed", "center"):
        raise ValueError(f"align is placed (as each file has it) or center, not {job['align']!r}")
    if job.get("align") == "center" and len(out) > 1:
        def anchor(m):
            b = m.bounds
            return np.array([(b[0, 0] + b[1, 0]) / 2, (b[0, 1] + b[1, 1]) / 2, b[0, 2]])
        to = anchor(out[0]["mesh"])
        for v in out[1:]:
            d = to - anchor(v["mesh"])
            if np.linalg.norm(d) > 1e-4:
                v["mesh"] = v["mesh"].copy()
                v["mesh"].apply_translation(d)
                v["shift"] = [r(x, 3) for x in d]
    return out


def circle_specs(job):
    out = []
    for c in job.get("circles") or []:
        c = {"d": c} if isinstance(c, (int, float)) else dict(c)
        try:
            d = float(c["d"])
        except (KeyError, TypeError, ValueError):
            raise ValueError(f"a circle is {{d, at?, label?}} with its diameter d in mm, not {c!r}")
        if d <= 0:
            raise ValueError(f"a circle's diameter must be more than 0, not {d:g}")
        at = c.get("at")
        if at is not None and (len(at) != 2 or not all(isinstance(x, (int, float)) for x in at)):
            raise ValueError(f"a circle's at is [a, b] in the cut's own axes (x, y for a z cut), not {at!r}")
        out.append({"d": d, "at": [float(x) for x in at] if at is not None else None, "label": c.get("label") or f"Ø{d:g}"})
    if len(out) > 4:
        raise ValueError(f"{len(out)} circles: give 4 at most")
    return out


def circle_reach(g, center, d):
    """How a section sits against a circle about center: the diameter its outline reaches about that centre (where
    it reaches farthest), how far that is past the circle (less than 0: inside it by that much), the area outside it,
    and, when the centre is clear of material, the diameter left clear around it."""
    from shapely.geometry import Point
    polys = [p for p in getattr(g, "geoms", [g]) if not p.is_empty and p.area > 0]
    pts = np.vstack([np.asarray(p.exterior.coords) for p in polys])
    dist = np.hypot(pts[:, 0] - center[0], pts[:, 1] - center[1])
    i = int(dist.argmax())
    c = Point(*center)
    out = {"reaches_d": r(2 * dist[i]), "past": r(dist[i] - d / 2), "at": [r(pts[i, 0]), r(pts[i, 1])],
           "outside_mm2": r(g.difference(c.buffer(d / 2, quad_segs=128)).area, 1)}
    if not g.contains(c):
        out["clear_d"] = r(2 * g.distance(c))
    return out


def outlines_apart(a, b, spacing):
    """How far apart two sections' outlines get: the farthest any point of either outline is from the other's, where,
    and the nearest point on the other."""
    import shapely
    from shapely.ops import nearest_points
    best = None
    for src, dst in ((a, b), (b, a)):
        P, _ = geom.outline_points(src, spacing)
        if not len(P):
            continue
        pts = shapely.points(P)
        dist = shapely.distance(pts, dst.boundary)
        i = int(np.argmax(dist))
        if best is None or dist[i] > best[0]:
            q = nearest_points(dst.boundary, pts[i])[0]
            best = (float(dist[i]), P[i], (q.x, q.y))
    if best is None:
        return None
    return {"mm": r(best[0]), "at": [r(best[1][0]), r(best[1][1])], "toward": [r(best[2][0]), r(best[2][1])]}


def version_diff(first, other, spacing):
    """One version's cut against the first's: the area each has that the other doesn't, and how far apart the outlines
    get."""
    a, b = first.get("_shown"), other.get("_shown")
    out = {"version": other["version"], "against": first["version"]}
    if a is None or b is None:
        out["only_in_first_mm2"] = r(a.area, 1) if a is not None else 0.0
        out["only_in_this_mm2"] = r(b.area, 1) if b is not None else 0.0
        out["area_change_mm2"] = r((b.area if b is not None else 0) - (a.area if a is not None else 0), 1)
        out["same"] = a is None and b is None
        return out
    removed, added = a.difference(b).area, b.difference(a).area
    out.update({"area_change_mm2": r(b.area - a.area, 1), "only_in_first_mm2": r(removed, 1), "only_in_this_mm2": r(added, 1)})
    out["same"] = removed + added < max(0.01, 1e-4 * max(a.area, b.area))
    if not out["same"]:
        out["apart"] = outlines_apart(a, b, spacing)
    return out


CIRCLE_STYLES = ((0, (5, 3)), (0, (1.5, 2)), (0, (8, 2, 1.5, 2)), (0, (3, 1.5)))
"""Each reference circle's dash, so two of them tell apart in the legend that names them."""


def draw_circles(ax, circles):
    """The reference circles, dashed, each named in the legend (a name on the drawing lands on the part)."""
    from matplotlib.lines import Line2D
    handles = []
    for k, c in enumerate(circles):
        (cx, cy), d = c["at"], c["d"]
        t = np.linspace(0, 2 * np.pi, 361)
        ls = CIRCLE_STYLES[k % len(CIRCLE_STYLES)]
        ax.plot(cx + d / 2 * np.cos(t), cy + d / 2 * np.sin(t), color="#222222", lw=1.3, ls=ls, zorder=4)
        handles.append(Line2D([], [], color="#222222", lw=1.3, ls=ls, label=c["label"]))
    return handles


def circles_window(win, circles, pad=0.04):
    if not circles:
        return win
    x0, y0, x1, y1 = win
    for c in circles:
        (cx, cy), h = c["at"], c["d"] / 2
        x0, y0, x1, y1 = min(x0, cx - h), min(y0, cy - h), max(x1, cx + h), max(y1, cy + h)
    p = max(x1 - x0, y1 - y0) * pad
    return (x0 - p, y0 - p, x1 + p, y1 + p * 3)


def draw_overlay(ax, cut, circles):
    """Every version's cut in one frame: with two, what both have in gray and what only one has tinted in its colour;
    each outline in its version's colour, and where they're farthest apart marked."""
    from matplotlib.lines import Line2D
    from matplotlib.patches import Patch
    vs = [v for v in cut["versions"] if v.get("_shown") is not None]
    handles = []
    if len(cut["versions"]) == 2 and len(vs) == 2:
        a, b = vs
        geom.draw_geom(ax, a["_shown"].intersection(b["_shown"]), face=BOTH, edge="none", lw=0)
        for v, other in ((a, b), (b, a)):
            only = v["_shown"].difference(other["_shown"])
            if not only.is_empty:
                geom.draw_geom(ax, only, face=tint(v["_color"]), edge="none", lw=0)
        handles.append(Patch(facecolor=BOTH, edgecolor="none", label="both"))
        handles += [Patch(facecolor=tint(v["_color"]), edgecolor=v["_color"], label=f"only {v['version']}") for v in (a, b)]
    elif vs:
        geom.draw_geom(ax, vs[0]["_shown"], face=BOTH, edge="none", lw=0)
        handles.append(Patch(facecolor=BOTH, edgecolor=vs[0]["_color"], ls=(0, (4, 2)), label=vs[0]["version"]))
    for k, v in enumerate(vs):
        geom.draw_geom(ax, v["_shown"], fill=False, edge=v["_color"], lw=1.6 if k else 1.3, ls="-" if k else (0, (4, 2)))
    if len(cut["versions"]) != 2 or len(vs) != 2:
        handles += [Line2D([], [], color=v["_color"], lw=1.6, label=v["version"]) for v in vs[1:]]
    x0, y0, x1, y1 = cut["_window"]
    colors = {v["version"]: v["_color"] for v in cut["versions"]}
    for d in cut["diffs"]:
        ap = d.get("apart")
        # Pointed at only where the change is too thin to see in the tints: a big one shows itself.
        if ap and 0.05 <= ap["mm"] < 0.06 * max(x1 - x0, y1 - y0):
            c = colors.get(d["version"], "#111111")
            ax.plot([ap["at"][0], ap["toward"][0]], [ap["at"][1], ap["toward"][1]], color=c, lw=2.2,
                    solid_capstyle="butt", zorder=6)
            ax.annotate(f"{ap['mm']:g} apart", (ap["at"][0], ap["at"][1]), xytext=(7, 7), textcoords="offset points",
                        fontsize=9, fontweight="bold", color=c, zorder=7,
                        bbox=dict(boxstyle="round,pad=0.2", fc="white", ec=c, lw=0.8, alpha=0.9))
    handles += draw_circles(ax, circles)
    legend_below(ax, handles)


def legend_below(ax, handles):
    """The legend under the drawing, where it covers nothing."""
    if handles:
        ax.legend(handles=handles, loc="upper center", bbox_to_anchor=(0.5, -0.09), ncol=min(len(handles), 2),
                  fontsize=9, frameon=False, handlelength=2.4, columnspacing=1.6)


def op_section(job):
    versions = versions_of(job)
    if len(versions) > 4:
        raise ValueError(f"{len(versions)} versions: compare 4 at most in one sheet")
    first = versions[0]
    thin = float(job.get("thin") or 0.8)
    planes = section_planes(job, first["mesh"])
    box = crop_box(job)
    circles = circle_specs(job)
    many = len(versions) > 1
    apart = bool(job.get("apart")) and many
    for k, v in enumerate(versions):
        t = geom.thickness(v["mesh"], thin=thin)
        v["samples"], v["spacing"] = t["_samples"], t["_spacing"]
        v["color"] = VERSION_COLORS[k % len(VERSION_COLORS)]
    cols = (1 + len(versions)) if apart else min(len(planes), 3 if len(planes) != 4 else 2)
    rows = len(planes) if apart else math.ceil(len(planes) / cols)
    if rows * cols > 15:
        raise ValueError(f"{len(planes)} cuts of {len(versions)} versions apart is {rows * cols} pictures: ask for fewer")
    P = plt()
    fig, axs = P.subplots(rows, cols, figsize=((6.6 if apart else 7.2) * cols, (7.0 if circles or many else 6.4) * rows + 0.6),
                          dpi=DPI, squeeze=False)
    out = []
    for k, plane in enumerate(planes):
        cut = {"plane": plane["label"], "versions": [], "diffs": []}
        win = geom.box_window(plane, box)
        for v in versions:
            g, _ = geom.section_polys(v["mesh"], plane["origin"], plane["normal"], plane["up"])
            if g is not None:
                g = geom.in_world(g, plane)
                shown = g
                if win is not None:
                    from shapely.geometry import box as sbox
                    shown = g.intersection(sbox(*win))
                if shown.is_empty:
                    g = None
            if g is None:
                cut["versions"].append({"version": v["label"], "empty": True, "_shown": None, "_color": v["color"]})
                continue
            f = geom.section_facts(g, plane, v["samples"], v["spacing"], window=win)
            f.update({"version": v["label"], "_shown": shown, "_color": v["color"]})
            cut["versions"].append(f)
        drawn = [f["_shown"] for f in cut["versions"] if f.get("_shown") is not None]
        if drawn:
            from shapely.ops import unary_union
            whole = unary_union(drawn)
            mid = cut["versions"][0].get("_shown")
            mid = (mid if mid is not None else whole).centroid
            centre = (mid.x, mid.y)
            here = [{**c, "at": c["at"] or [r(centre[0]) + 0.0, r(centre[1]) + 0.0]} for c in circles]
            for f in cut["versions"]:
                if f.get("_shown") is not None and here:
                    f["circles"] = [{"label": c["label"], "d": c["d"], "center": c["at"],
                                     **circle_reach(f["_shown"], c["at"], c["d"])} for c in here]
            span = max(whole.bounds[2] - whole.bounds[0], whole.bounds[3] - whole.bounds[1], 0.5)
            cut["diffs"] = [version_diff(cut["versions"][0], f, span / 500) for f in cut["versions"][1:]]
            window = circles_window(geom.window_of(whole, win), here if win is None else [])
            cut["_window"] = window
        names = plane["names"]
        row = [axs[k, c] for c in range(cols)] if apart else [axs.flat[k]]
        ax = row[0]
        if not drawn:
            ax.set_title(f"{plane['label']}: " + ("nothing inside the box" if win is not None else
                                                  ("misses every version" if many else "misses the model")))
            ax.axis("off")
            for extra in row[1:]:
                extra.axis("off")
        elif many:
            draw_overlay(ax, cut, here)
            geom.style_axes(ax, f"{names[0]} (mm)", f"{names[1]} (mm)", window)
            ax.set_title(plane["label"])
            for extra, f in zip(row[1:], cut["versions"]):
                if f.get("_shown") is None:
                    extra.set_title(f"{f['version']}: misses it")
                    extra.axis("off")
                    continue
                geom.draw_geom(extra, f["_shown"])
                geom.style_axes(extra, f"{names[0]} (mm)", f"{names[1]} (mm)", window)
                geom.annotate_section(extra, f, small_hole=float(job.get("label_holes_under") or 5), thin=thin)
                legend_below(extra, draw_circles(extra, here))
                w, gp = f["thinnest_wall"], f["narrowest_gap"]
                extra.set_title(f["version"] + (f" · wall {w['mm']}" if w else "") + (f" · gap {gp['mm']}" if gp else ""),
                                color=f["_color"])
        else:
            f = cut["versions"][0]
            geom.draw_geom(ax, f["_shown"])
            geom.style_axes(ax, f"{names[0]} (mm)", f"{names[1]} (mm)", window)
            geom.annotate_section(ax, f, small_hole=float(job.get("label_holes_under") or 5), thin=thin)
            legend_below(ax, draw_circles(ax, here))
            w, gp = f["thinnest_wall"], f["narrowest_gap"]
            ax.set_title(plane["label"] + (f" · wall {w['mm']}" if w else "") + (f" · gap {gp['mm']}" if gp else ""))
        if many:
            cut["versions"] = [public(f) for f in cut["versions"]]
            out.append(public(cut))
        else:
            f = public(cut["versions"][0])
            f.pop("version", None)
            out.append({"plane": plane["label"], **({"empty": True} if f.get("empty") else f)})
    if not apart:
        for k in range(len(planes), rows * cols):
            axs.flat[k].axis("off")
    labels = [v["label"] for v in versions]
    title = ((job.get("labels") or [None])[0] or first["model"]["name"]) + ": sections" if not many else \
        ((job["_stem"] + ": " if job.get("_stem") else "")
         + (" vs ".join(labels) if len(labels) == 2 else ", ".join(labels[:-1]) + " and " + labels[-1]))
    fig.suptitle(title, fontsize=14, fontweight="bold", x=0.01, ha="left")
    fig.tight_layout(rect=(0, 0, 1, 0.97))
    fig.savefig(job["sheet"], dpi=DPI, bbox_inches="tight", pad_inches=0.15)
    P.close(fig)
    m = first["mesh"]
    res = {"name": first["model"]["name"], "sections": out, "bounds": [[r(x) for x in m.bounds[0]], [r(x) for x in m.bounds[1]]]}
    if many:
        res["versions"] = [{"label": v["label"], "name": v["model"]["name"],
                            "bounds": [[r(x) for x in v["mesh"].bounds[0]], [r(x) for x in v["mesh"].bounds[1]]],
                            **({"moved": v["shift"]} if v["shift"] else {})} for v in versions]
    return res


# view


def op_view(job):
    model = pick(job["file"], job["name"], job.get("object"))
    full = model["mesh"]
    thin = float(job.get("thin") or 0.8)
    color = job.get("color") or "thickness"
    box = crop_box(job)
    m = full
    caps = []
    walls = None
    if color == "thickness":
        walls = thickness_samples(geom.thickness(full, thin=thin)["_samples"], thin)
    if box is not None:
        m = geom.crop(full, box)
        caps += geom.box_planes(box)
    cut_plane = None
    if job.get("cut"):
        c = geom.plane_spec(job["cut"], full)
        m = geom.cut(m, c["origin"], c["normal"])
        if m is None or not len(m.faces):
            raise ValueError("the cut leaves nothing")
        caps.append((c["origin"], c["normal"]))
        cut_plane = c
    colors = None
    if color not in ("thickness", "plain"):
        colors = geom.colors_for(m, color, thin)
    views = job.get("views") or None
    titles = {}
    if not views:
        if cut_plane is not None:
            n = cut_plane["normal"]
            side = np.cross(n, [0, 0, 1]) if abs(n[2]) < 0.9 else np.array([1.0, 0, 0])
            views = [list(-n * 1.0 - 0.35 * np.array([0, 0, 1.0]) * (abs(n[2]) < 0.9) + 0.3 * side), list(-n)]
            titles = {0: "The cut, at an angle", 1: "Straight at the cut"}
        else:
            views = ["iso", "iso-back", "top", "bottom"]
    if len(views) > 6:
        raise ValueError("six views at most")
    P = plt()
    cols = min(len(views), 2 if len(views) in (2, 4) else 3)
    rows = math.ceil(len(views) / cols)
    size = int(job.get("size") or (900 if cols <= 2 else 700))
    fig, axs = P.subplots(rows, cols, figsize=(size * cols / DPI, size * 0.8 * rows / DPI + 0.5), dpi=DPI, squeeze=False)
    for k, v in enumerate(views):
        ax = axs.flat[k]
        img, _ = geom.render(m, v, width=size, height=int(size * 0.78), face_rgb=colors, caps=caps, samples=walls)
        ax.imshow(img)
        ax.axis("off")
        ax.set_title(titles.get(k) or (v if isinstance(v, str) else "looking along (" + ", ".join(f"{x:.2g}" for x in v) + ")"))
        if k == 0:
            if color == "thickness":
                legend_thickness(ax, thin)
            elif color == "overhang":
                legend_overhang(ax)
    for k in range(len(views), rows * cols):
        axs.flat[k].axis("off")
    what = model["name"] + (f", inside {[round(x, 1) for x in box]}" if box else "") + (
        f", cut at {cut_plane['label']}" if cut_plane else "")
    fig.suptitle(what, fontsize=13, fontweight="bold", x=0.01, ha="left")
    fig.tight_layout(rect=(0, 0, 1, 0.96))
    fig.savefig(job["sheet"], dpi=DPI)
    P.close(fig)
    return {"name": model["name"], "views": [v if isinstance(v, str) else [r(x, 3) for x in v] for v in views],
            "triangles_shown": int(len(m.faces)), "box": box, "cut": cut_plane["label"] if cut_plane else None}


# layers


def plate_models(path, plate):
    """The objects of a sliced 3MF on its plate, each where its 3MF transform puts it: [{name, mesh}]."""
    try:
        models = geom.read_3mf(path)
    except Exception:
        return []
    return [m for m in models if not m.get("plate") or str(m.get("plate")) == str(plate or 1)]


def wall_points(segs, step=0.5):
    """Points every step mm along the outer-wall extrusions of a layer."""
    pts = []
    for x0, y0, x1, y1, feat, _ in segs:
        if feat.lower() not in ("outer wall", "external perimeter"):
            continue
        n = max(1, int(math.hypot(x1 - x0, y1 - y0) / step))
        t = (np.arange(n) + 0.5) / n
        pts.append(np.c_[x0 + (x1 - x0) * t, y0 + (y1 - y0) * t])
    return np.vstack(pts) if pts else np.zeros((0, 2))


def align_to_gcode(models, text, layers):
    """Moves each object to where its G-code prints it: its outline fitted to the outer walls of a few layers (a shift
    in x and y only). A sliced 3MF can hold an object moved after it was sliced, and then its transform and its
    G-code disagree. Answers what moved each, and how well they fit after (median mm from wall line to outline)."""
    from scipy.spatial import cKDTree
    n = len(layers)
    picks = sorted({int(n * f) for f in (0.15, 0.4, 0.65, 0.9)} - {0})
    _, segs = geom.parse_layers(text, want=picks)
    walls = {i: wall_points(segs.get(i, [])) for i in picks}
    out = []
    for model in models:
        m = model["mesh"]
        lo, hi = m.bounds[0, :2] - 4, m.bounds[1, :2] + 4
        P, Q = [], []
        for i in picks:
            w = walls[i]
            w = w[np.all((w >= lo) & (w <= hi), axis=1)] if len(w) else w
            z = layers[i]["z"] - (layers[i]["height"] or 0.2) / 2
            if not len(w) or not (m.bounds[0, 2] < z < m.bounds[1, 2]):
                continue
            g, _ = geom.section_polys(m, [0, 0, z], [0, 0, 1], [0, 1, 0])
            if g is None:
                continue
            g = geom.in_world(g, {"axis": 2, "normal": np.array([0, 0, 1.0]), "up": [0, 1, 0], "origin": np.array([0, 0, z])})
            q, _ = geom.outline_points(g, 0.1)
            P.append(np.c_[w, np.full(len(w), i)])
            Q.append(np.c_[q, np.full(len(q), i)])
        if not P:
            out.append({"name": model["name"], "moved": None, "fit_mm": None})
            continue
        P, Q = np.vstack(P), np.vstack(Q)
        trees = {i: cKDTree(Q[Q[:, 2] == i][:, :2]) for i in np.unique(Q[:, 2])}

        def dists(shift):
            d = np.empty(len(P))
            for i, tree in trees.items():
                sel = P[:, 2] == i
                d[sel], _ = tree.query(P[sel, :2] - shift)
            return d
        before = float(np.median(dists(np.zeros(2))))
        # The wall line runs half a line inside the outline all the way round, so the mean of the offsets (strays from
        # a neighbour left out) settles where it's centred; trimming the far side would hug one wall instead.
        shift = np.zeros(2)
        for _ in range(80):
            nearest = np.empty((len(P), 2))
            for i, tree in trees.items():
                sel = P[:, 2] == i
                _, j = tree.query(P[sel, :2] - shift)
                nearest[sel] = tree.data[j]
            gap = (P[:, :2] - shift) - nearest
            d = np.linalg.norm(gap, axis=1)
            keep = d <= max(1.5, 3 * float(np.median(d)))
            step = gap[keep].mean(axis=0) if keep.any() else np.zeros(2)
            shift = shift + step
            if np.linalg.norm(step) < 2e-4:
                break
        after = float(np.median(dists(shift)))
        moved = None
        if after < before * 0.7 and np.linalg.norm(shift) > 0.1 and np.linalg.norm(shift) < 25:
            m.apply_translation([shift[0], shift[1], 0])
            moved = [r(shift[0]), r(shift[1])]
        out.append({"name": model["name"], "moved": moved, "fit_mm": r(after if moved else before)})
    return out


def op_layers(job):
    text, plate = geom.gcode_text(job["file"], job.get("plate"))
    layers, _ = geom.parse_layers(text)
    if not layers:
        raise ValueError("no layers in it (no ; CHANGE_LAYER or ;LAYER_CHANGE comments)")
    zs = np.array([L["z"] for L in layers])
    want = []
    for z in job.get("z") or []:
        want.append(int(np.argmin(np.abs(zs - float(z)))))
    for i in job.get("layers") or []:
        i = int(i) - 1
        if not 0 <= i < len(layers):
            raise ValueError(f"it has {len(layers)} layers; there's no layer {i + 1}")
        want.append(i)
    box = None
    if job.get("box"):
        b = [float(v) for v in job["box"]]
        box = [b[0], b[1], b[3], b[4]] if len(b) == 6 else b
        box = [min(box[0], box[2]), min(box[1], box[3]), max(box[0], box[2]), max(box[1], box[3])]
    elif job.get("around") is not None:
        c = [float(v) for v in job["around"]]
        rad = float(job.get("radius") or 10)
        box = [c[0] - rad, c[1] - rad, c[0] + rad, c[1] + rad]
        if len(c) >= 3 and not want:
            want.append(int(np.argmin(np.abs(zs - c[2]))))
    if not want:
        n = int(job.get("count") or 6)
        want = sorted({int(round(k)) for k in np.linspace(0, len(layers) - 1, n)})
    want = sorted(dict.fromkeys(want))[:12]
    _, segs = geom.parse_layers(text, want=want, box=box)
    model, note, placed = None, None, []
    if job.get("model", True) and (job["file"].lower().endswith(".3mf") or zipfile.is_zipfile(job["file"])):
        objs = plate_models(job["file"], plate)
        if objs:
            import trimesh
            placed = align_to_gcode(objs, text, layers)
            model = trimesh.util.concatenate([o["mesh"] for o in objs])
            moved = [p for p in placed if p["moved"]]
            if moved:
                note = ("the G-code prints " + ("its objects" if len(moved) == len(placed) else f"{len(moved)} of its {len(placed)} objects")
                        + " a little off from where the 3MF's own transform puts them, so each outline is drawn where the "
                        + "G-code has it: " + "; ".join(f"{p['name']} moved ({p['moved'][0]:+g}, {p['moved'][1]:+g}) mm, "
                                                        f"then within {p['fit_mm']} mm of its walls" for p in moved[:4]))
    feats_only = {f.lower() for f in job.get("features") or []}
    P = plt()
    n = len(want)
    cols = min(n, 3 if n != 4 else 2)
    rows = math.ceil(n / cols)
    fig, axs = P.subplots(rows, cols, figsize=(7.2 * cols, 6.6 * rows + 1.4), dpi=DPI, squeeze=False)
    all_xy = [np.array([(s[0], s[1]) for s in segs.get(i, [])] + [(s[2], s[3]) for s in segs.get(i, [])]) for i in want]
    all_xy = [a for a in all_xy if len(a)]
    if box is not None:
        win = tuple(box)
    elif all_xy:
        a = np.vstack(all_xy)
        lo, hi = a.min(0), a.max(0)
        pad = max(hi - lo) * 0.04 + 0.5
        win = (lo[0] - pad, lo[1] - pad, hi[0] + pad, hi[1] + pad)
    else:
        win = (0, 0, 256, 256)
    out = []
    seen_feats = set()
    for k, i in enumerate(want):
        ax = axs.flat[k]
        L = layers[i]
        ss = [s for s in segs.get(i, []) if not feats_only or s[4].lower() in feats_only]
        seen_feats |= {s[4] for s in ss}
        geom.style_axes(ax, "x (mm)", "y (mm)", win)
        lengths = geom.draw_layer(ax, ss, win)
        mid = L["z"] - (L["height"] or 0.2) / 2
        if model is not None:
            g, _ = geom.section_polys(model, [0, 0, mid], [0, 0, 1], [0, 1, 0])
            if g is not None:
                g = geom.in_world(g, {"axis": 2, "normal": np.array([0, 0, 1.0]), "up": [0, 1, 0], "origin": np.array([0, 0, mid])})
                for p in getattr(g, "geoms", [g]):
                    for ring in [p.exterior, *p.interiors]:
                        c = np.asarray(ring.coords)
                        ax.plot(c[:, 0], c[:, 1], color="#111111", lw=1.0, ls=(0, (4, 2)), zorder=3)
        ax.set_title(f"Layer {i + 1} of {len(layers)} · z {L['z']:.2f} ({L['height']:.2f})")
        out.append({"layer": i + 1, "z": r(L["z"], 3), "height": r(L["height"], 3), "extruded_mm": lengths})
    for k in range(n, rows * cols):
        axs.flat[k].axis("off")
    from matplotlib.lines import Line2D
    handles = [Line2D([0], [0], color=geom.feature_color(f), lw=4, label=f) for f in sorted(seen_feats)]
    if model is not None:
        handles.append(Line2D([0], [0], color="#111111", lw=1.2, ls=(0, (4, 2)), label="model at mid-layer"))
    legend_rows = math.ceil(len(handles) / 7) if handles else 0
    if handles:
        fig.legend(handles=handles, loc="lower center", ncol=min(len(handles), 7), fontsize=9, frameon=False,
                   bbox_to_anchor=(0.5, 0.0))
    fig.suptitle(f"{job['name']}: sliced layers" + (f" (plate {plate})" if plate else ""), fontsize=14,
                 fontweight="bold", x=0.01, ha="left")
    fig.tight_layout(rect=(0, (0.3 + 0.28 * legend_rows) / fig.get_figheight(), 1, 0.97))
    fig.savefig(job["sheet"], dpi=DPI)
    P.close(fig)
    return {"name": job["name"], "plate": plate, "layer_count": len(layers), "top_z": r(float(zs.max()), 2),
            "layers": out, "window": [r(x) for x in win], "model_overlay": model is not None, "overlay_note": note,
            "objects": placed}


# convert


def op_convert(job):
    if scenes.is_scene(job["name"], splitting=True) or scenes.is_scene(job["file"], splitting=True):
        return scenes.split_scene(job)
    objects = job.get("objects") or "merged"
    models = geom.load(job["file"], objects=objects, name=job["name"])
    os.makedirs(job["out_dir"], exist_ok=True)
    stem = job.get("stem") or os.path.splitext(job["name"].replace(".gcode.3mf", ".3mf"))[0]
    out = []
    for i, model in enumerate(models):
        m = model["mesh"]
        down = job.get("down") or "z-"
        table = None
        if down == "auto":
            down, table = geom.orientations(m)
        if down not in geom.DOWNS:
            raise ValueError(f"down is one of {', '.join(geom.DOWNS)} or auto")
        m = geom.turned(m, down) if (down != "z-" or job.get("drop", True)) else m
        if job.get("center"):
            c = m.bounds.mean(axis=0)
            m.apply_translation([-c[0], -c[1], 0])
        safe = re.sub(r"-+", "-", "".join(ch if ch.isalnum() or ch in "._-" else "-" for ch in model["name"])).strip("-")
        name = f"{stem}.stl" if len(models) == 1 else f"{stem}-{i + 1:02d}-{safe[:40]}.stl"
        path = os.path.join(job["out_dir"], name)
        m.export(path)
        out.append({"name": name, "path": path, "object": model["name"], "size_mm": [r(x) for x in m.extents],
                     "triangles": int(len(m.faces)), "watertight": bool(m.is_watertight), "down": down,
                     "orientations": table, "left_out": model.get("left_out") or []})
    return {"files": out}


WARM_PACKAGES = ("trimesh", "numpy", "scipy", "shapely", "matplotlib", "embreex", "cascadio", "rtree", "networkx", "lxml",
                 "pillow", "mapbox_earcut", "manifold3d")


def op_warm(job):
    """The environment works: each package's version, Embree's ray casting, and a box measured end to end."""
    from importlib.metadata import PackageNotFoundError, version

    import trimesh
    versions = {"python": sys.version.split()[0]}
    for p in WARM_PACKAGES:
        try:
            versions[p] = version(p)
        except PackageNotFoundError:
            versions[p] = None
    box = {"name": "box", "mesh": trimesh.creation.box((20, 10, 5)), "left_out": []}
    o, _ = geom.measure(box)
    try:
        blender = {"path": scenes.blender(), "version": scenes.blender_version()}
    except scenes.NoBlender as e:
        blender = {"path": None, "version": None, "error": str(e)}
    try:
        coupon_ok = coupon.works()
    except Exception as e:
        coupon_ok = False
        print(f"the coupon check failed: {e}", file=sys.stderr)
    return {"versions": versions, "embree": "embree" in type(box["mesh"].ray).__module__,
            "step": versions.get("cascadio") is not None, "box_ok": o["watertight"] and o["size_mm"] == [20, 10, 5],
            "coupon_ok": coupon_ok, "blender": blender}


def op_scene(job):
    return scenes.look(job)


def op_coupon(job):
    return coupon.op_coupon(job, pick, plt, legend_thickness)


def progress_to(path):
    """Says how far the job is, a line at a time, in a file the server reads while it waits."""
    def say(line):
        if not path:
            return
        with open(path, "a") as f:
            f.write(str(line).replace("\n", " ") + "\n")
    return say


def op_variants(job):
    return variants.op_variants(job, {"progress": progress_to(job.get("progress_file")), "plt": plt,
                                      "thickness_samples": thickness_samples, "legend": legend_thickness, "wrap": wrap,
                                      "public": public})


OPS = {"warm": op_warm, "report": op_report, "section": op_section, "view": op_view, "layers": op_layers,
       "convert": op_convert, "scene": op_scene, "verify": verify.op_verify, "features": verify.op_features,
       "supports": supports.op_supports, "support_model": support_3d.op_support_model, "drawing": drawing.op_drawing, "coupon": op_coupon,
       "variants": op_variants}


def main():
    job_path, result_path = sys.argv[1], sys.argv[2]
    with open(job_path) as f:
        job = json.load(f)
    try:
        result = OPS[job["op"]](job)
        result["ok"] = True
    except (ValueError, geom.Unreadable) as e:
        result = {"ok": False, "error": str(e)}
    except Exception as e:
        result = {"ok": False, "error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc()[-4000:]}
    with open(result_path, "w") as f:
        json.dump(result, f, default=lambda x: x.tolist() if hasattr(x, "tolist") else str(x))


if __name__ == "__main__":
    main()
