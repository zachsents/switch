"""supports: where a sliced plate's supports meet its model, read from the G-code, the way it will print.

What the slicer's preview can't show and its settings don't promise: the gap it actually left between the top of the
support and the model over it (tree supports round a 0.3 mm gap asked for down to one 0.2 mm layer, which is where TPU
fuses to its supports), where the support touches the model and how much of each overhang it reaches, where support
stands on the model rather than the bed, and the layer heights the beads were laid at. So, for each sliced plate:

- every extrusion is read with its own bead height (Bambu and Orca write `; LAYER_HEIGHT:` per feature, so a support
  bead of 0.27 mm and a model bead of 0.2 mm in the same layer each keep theirs; PrusaSlicer's `;HEIGHT:` too), its
  width and its feature; arcs are cut into chords;
- the beads are laid into columns on an XY grid (0.1 mm cells by default, each bead as wide as its line), lowest first,
  and each column remembers the top of the last model bead and of the last support bead under it;
- a model bead whose column has support on top (closer than the model) is a contact: its gap is the bead's bottom minus
  the support's top. A support bead whose column has model on top is support standing on the model, with its gap. A
  model bead with neither under it within reach, and no model bead close enough beside it to hold it up (the support
  threshold angle), is an overhang nothing holds (a bridge, or one the support doesn't reach);
- contacts and the overhangs around them are grouped into zones in 3D, so stacked fins are each their own.

Runs in mesh's worker environment (numpy, scipy, matplotlib).
"""

import math
import re
import zipfile

import numpy as np

import geom
from geom import r

SUPPORT = re.compile(r"(?i)support")
LEFT_OUT = re.compile(r"(?i)^$|brim|skirt|prime tower|wipe tower|purge|custom|wipe|unknown")
NUM = re.compile(r"([XYZEIJR])(-?\d*\.?\d+)")
TOL = 0.02
"""Heights this close are the same (the G-code's rounding: 0.199999 and 0.200001)."""
MAX_CELLS = 6_000_000
FOOTING_MM2 = 1.0
"""A place where support stands on the model this big is a footing; smaller ones are a branch's edge over a surface."""
STAND_MM = 0.5
"""Support whose bottom is at most this far over the model stands on it (the bottom gap is 0.1 to 0.35 mm); a tree
branch leaning out farther over a surface passes over it instead."""
SETTING_KEYS = (
    "enable_support", "support_type", "support_style", "support_top_z_distance", "support_bottom_z_distance",
    "support_object_xy_distance", "support_interface_top_layers", "support_interface_bottom_layers",
    "support_interface_spacing", "support_interface_pattern", "support_base_pattern_spacing",
    "independent_support_layer_height", "support_on_build_plate_only", "support_threshold_angle",
    "support_critical_regions_only", "enable_support_ironing", "support_filament", "support_interface_filament",
    "tree_support_branch_diameter", "tree_support_branch_angle", "tree_support_wall_count",
    "layer_height", "initial_layer_print_height", "filament_type", "filament_settings_id", "print_settings_id",
    # PrusaSlicer's names for the same
    "support_material", "support_material_contact_distance", "support_material_bottom_contact_distance",
    "support_material_style", "support_material_interface_layers", "support_material_synchronize_layers",
    "first_layer_height",
)


# Reading


def plate_text(path, plate=None):
    """The plate's G-code and its number, and the slicer's settings: the 3MF's project_settings.config, else the
    G-code's own CONFIG_BLOCK (or a PrusaSlicer footer of `; key = value` lines)."""
    text, number = geom.gcode_text(path, plate)
    settings = {}
    if path.lower().endswith(".3mf") or zipfile.is_zipfile(path):
        import json
        with zipfile.ZipFile(path) as z:
            if "Metadata/project_settings.config" in z.namelist():
                try:
                    settings = json.loads(z.read("Metadata/project_settings.config"))
                except ValueError:
                    settings = {}
    if not settings:
        for m in re.finditer(r"(?m)^; ([a-z0-9_]+) = (.*)$", text):
            settings.setdefault(m.group(1), m.group(2).strip())
    return text, number, settings


def first(v):
    """A setting's value: the first of a per-filament list, as a number when it is one."""
    if isinstance(v, list):
        v = v[0] if v else None
    if isinstance(v, str):
        s = v.split(",")[0].strip().rstrip("%")
        try:
            return float(s) if s and s.replace(".", "", 1).replace("-", "", 1).isdigit() else v.strip()
        except ValueError:
            return v.strip()
    return v


def asked(settings):
    """The support settings as asked, in plain names."""
    s = {k: first(settings[k]) for k in SETTING_KEYS if k in settings}
    top = s.get("support_top_z_distance", s.get("support_material_contact_distance"))
    bottom = s.get("support_bottom_z_distance", s.get("support_material_bottom_contact_distance"))
    on = s.get("enable_support", s.get("support_material"))
    stype = s.get("support_type") or s.get("support_material_style")
    return {
        "supports": None if on is None else str(on) in ("1", "1.0", "true", "True"),
        "type": stype, "style": s.get("support_style"),
        "top_gap": top if isinstance(top, float) else None,
        "bottom_gap": (bottom if isinstance(bottom, float) and bottom > 0 else top if isinstance(top, float) else None),
        "xy_distance": s.get("support_object_xy_distance"),
        "interface_top_layers": s.get("support_interface_top_layers", s.get("support_material_interface_layers")),
        "interface_bottom_layers": s.get("support_interface_bottom_layers"),
        "independent_layer_height": (str(s["independent_support_layer_height"]) in ("1", "1.0", "true")
                                     if "independent_support_layer_height" in s else None),
        "build_plate_only": (str(s["support_on_build_plate_only"]) in ("1", "1.0", "true")
                             if "support_on_build_plate_only" in s else None),
        "threshold_angle": s.get("support_threshold_angle"),
        "layer_height": s.get("layer_height"),
        "first_layer_height": s.get("initial_layer_print_height", s.get("first_layer_height")),
        "filament": s.get("filament_type"),
        "process": s.get("print_settings_id"),
        "raw": s,
    }


def parse(text, arc_step=0.2):
    """Every extruding move as a segment with its own bead: arrays x0, y0, x1, y1, z (its top), h (its height), w,
    kind (0 model, 1 support, 2 left out: brim, skirt, purge, prime tower) and feature (its index in names)."""
    x = y = z = 0.0
    absolute_e = False
    last_e = 0.0
    feature = ""
    h_feat = None  # the bead height the G-code last said: Bambu and Orca write it only when it changes, so it carries on
    ex_z = prev_ex_z = None  # the heights of the last two layers anything was extruded at, for a G-code that says none
    width = geom.NOZZLE * 1.05
    names, codes = [], {}
    rows = []
    kinds = {}
    for line in text.splitlines():
        if not line:
            continue
        c = line[0]
        if c == ";":
            s = line[1:].strip()
            low = s[:16].lower()
            if low.startswith(("feature:", "type:")):
                feature = s.split(":", 1)[1].strip()
            elif low.startswith(("layer_height:", "height:")):
                try:
                    h_feat = float(s.split(":", 1)[1])
                except ValueError:
                    pass
            elif low.startswith(("line_width:", "width:")):
                try:
                    width = float(s.split(":", 1)[1])
                except ValueError:
                    pass
            continue
        if c != "G" and c != "M":
            continue
        code = line.split(";", 1)[0]
        head = code[:4].rstrip()
        if head.startswith("M82"):
            absolute_e = True
            continue
        if head.startswith("M83"):
            absolute_e = False
            continue
        cmd = code.split(None, 1)[0] if code.strip() else ""
        if cmd == "G92":
            for k, v in NUM.findall(code):
                if k == "E":
                    last_e = float(v)
            continue
        if cmd not in ("G0", "G1", "G2", "G3"):
            continue
        args = dict(NUM.findall(code))
        nx = float(args["X"]) if "X" in args else x
        ny = float(args["Y"]) if "Y" in args else y
        if "Z" in args:
            z = float(args["Z"])
        e = None
        if "E" in args:
            ev = float(args["E"])
            e = ev - last_e if absolute_e else ev
            if absolute_e:
                last_e = ev
        if e is not None and e > 0 and cmd != "G0" and (nx != x or ny != y):
            fid = codes.get(feature)
            if fid is None:
                fid = codes[feature] = len(names)
                names.append(feature)
                kinds[fid] = 1 if SUPPORT.search(feature) else 2 if LEFT_OUT.search(feature) else 0
            if ex_z is None or z > ex_z + 1e-6:
                prev_ex_z, ex_z = ex_z, z
            h = h_feat if h_feat is not None else (ex_z - prev_ex_z if prev_ex_z is not None else ex_z)
            if cmd in ("G2", "G3"):
                pts = geom.arc_points(x, y, nx, ny, args, cmd == "G2", arc_step)
                for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
                    rows.append((ax, ay, bx, by, z, h, width, fid))
            else:
                rows.append((x, y, nx, ny, z, h, width, fid))
        x, y = nx, ny
    if not rows:
        raise ValueError("nothing is extruded in it")
    a = np.array(rows, dtype=np.float64)
    kind = np.array([kinds[int(f)] for f in a[:, 7]], dtype=np.int8)
    return {"x0": a[:, 0], "y0": a[:, 1], "x1": a[:, 2], "y1": a[:, 3], "z": np.round(a[:, 4], 4), "h": a[:, 5],
            "w": a[:, 6], "fid": a[:, 7].astype(np.int32), "kind": kind, "names": names}


def raster(S, idx, X0, Y0, c, nx, ny):
    """The cells the beads idx cover: (flat cell, which bead) for every sample along and across each bead."""
    x0, y0 = S["x0"][idx], S["y0"][idx]
    dx, dy = S["x1"][idx] - x0, S["y1"][idx] - y0
    L = np.hypot(dx, dy)
    n = np.maximum(1, np.ceil(L / (0.5 * c)).astype(np.int64)) + 1
    rep = np.repeat(np.arange(len(idx)), n)
    starts = np.cumsum(n) - n
    t = (np.arange(int(n.sum())) - np.repeat(starts, n)) / np.repeat(n - 1, n)
    px, py = x0[rep] + t * dx[rep], y0[rep] + t * dy[rep]
    ux, uy = -dy / L, dx / L
    half = np.maximum(S["w"][idx] / 2 - c / 2, 0.0)
    m = max(1, int(math.ceil(float(S["w"][idx].max()) / c)))
    fr = np.linspace(-1.0, 1.0, m) if m > 1 else np.array([0.0])
    cells, beads = [], []
    for f in fr:
        qx = px + f * half[rep] * ux[rep]
        qy = py + f * half[rep] * uy[rep]
        ix = np.floor((qx - X0) / c).astype(np.int64)
        iy = np.floor((qy - Y0) / c).astype(np.int64)
        ok = (ix >= 0) & (ix < nx) & (iy >= 0) & (iy < ny)
        cells.append(ix[ok] * ny + iy[ok])
        beads.append(idx[rep[ok]])
    return np.concatenate(cells), np.concatenate(beads)


def per_cell(cells, values, lowest=True):
    """One value per cell: its lowest (or highest), and which sample gave it."""
    if not len(cells):
        return cells, np.array([], dtype=np.int64)
    q = np.round(np.asarray(values, np.float64) * 1e4).astype(np.int64)
    q = (q - q.min()) if lowest else (q.max() - q)
    order = np.argsort((cells.astype(np.int64) << 24) | np.minimum(q, (1 << 24) - 1), kind="stable")
    cs = cells[order]
    keep = np.ones(len(cs), bool)
    keep[1:] = cs[1:] != cs[:-1]
    return cs[keep], order[keep]


# Measuring


def analyse(path, plate=None, cell=0.1, reach=1.0, box=None):
    """One plate: what its supports touch, at what gap, and at which layer heights. Answers the facts and what the
    sheet draws."""
    text, number, settings = plate_text(path, plate)
    ask = asked(settings)
    S = parse(text)
    kind, z, h = S["kind"], S["z"], S["h"]
    seg_len = np.hypot(S["x1"] - S["x0"], S["y1"] - S["y0"])
    keep = seg_len > 1e-6
    model_i = np.nonzero(keep & (kind == 0))[0]
    sup_i = np.nonzero(keep & (kind == 1))[0]
    out = {"plate": number, "settings": {k: v for k, v in ask.items() if k != "raw"}, "raw_settings": ask["raw"],
           "layers": layer_heights(S, model_i, sup_i), "features": feature_lengths(S, seg_len)}
    first_top = float(z[model_i].min()) if len(model_i) else 0.2
    out["first_layer_top"] = r(first_top, 3)
    if not len(sup_i):
        out.update({"has_support": False, "contact": None, "zones": [], "on_model": None, "on_model_zones": [],
                    "unsupported": None, "draw": None})
        return out
    out["has_support"] = True

    # The grid: around the supports, and only that far (the model beyond them can't meet them).
    pad = 2.0
    xs = np.concatenate([S["x0"][sup_i], S["x1"][sup_i]])
    ys = np.concatenate([S["y0"][sup_i], S["y1"][sup_i]])
    X0, Y0, X1, Y1 = xs.min() - pad, ys.min() - pad, xs.max() + pad, ys.max() + pad
    if box is not None:
        X0, Y0, X1, Y1 = max(X0, box[0]), max(Y0, box[1]), min(X1, box[2]), min(Y1, box[3])
        if X1 <= X0 or Y1 <= Y0:
            raise ValueError("no support inside that box")
    c = float(cell)
    while ((X1 - X0) / c) * ((Y1 - Y0) / c) > MAX_CELLS:
        c *= 1.25
    nx, ny = int(math.ceil((X1 - X0) / c)), int(math.ceil((Y1 - Y0) / c))
    inside = lambda idx: idx[(np.maximum(S["x0"][idx], S["x1"][idx]) >= X0) & (np.minimum(S["x0"][idx], S["x1"][idx]) <= X1)
                             & (np.maximum(S["y0"][idx], S["y1"][idx]) >= Y0) & (np.minimum(S["y0"][idx], S["y1"][idx]) <= Y1)]
    model_i, sup_i = inside(model_i), inside(sup_i)
    if not len(sup_i):
        raise ValueError("no support inside that box")

    thr = ask.get("threshold_angle")
    thr = float(thr) if isinstance(thr, float) and thr > 0 else 30.0
    slope = 1.0 / math.tan(math.radians(max(15.0, min(thr, 75.0))))  # how far a bead may lean out over the one below
    top_model = np.full(nx * ny, -np.inf, dtype=np.float32)
    top_sup = np.full(nx * ny, -np.inf, dtype=np.float32)
    sup_feat = np.full(nx * ny, -1, dtype=np.int32)
    ever_model = np.zeros(nx * ny, bool)
    ever_sup = np.zeros(nx * ny, bool)
    levels = np.unique(np.concatenate([z[model_i], z[sup_i]]))
    side_model = np.zeros((nx, len(levels)), bool)
    side_sup = np.zeros((nx, len(levels)), bool)
    side_model_y = np.zeros((ny, len(levels)), bool)
    side_sup_y = np.zeros((ny, len(levels)), bool)
    by_level_m = split_by(z[model_i], model_i, levels)
    by_level_s = split_by(z[sup_i], sup_i, levels)
    contacts, rests, loose = [], [], []
    for k, lz in enumerate(levels):
        mi, si = by_level_m.get(k), by_level_s.get(k)
        m_cells = s_cells = None
        if mi is not None:
            cells, beads = raster(S, mi, X0, Y0, c, nx, ny)
            bottoms = z[beads] - h[beads]
            m_cells, pick = per_cell(cells, bottoms)
            m_beads = beads[pick]
            b = (z[m_beads] - h[m_beads]).astype(np.float32)
            tm, ts = top_model[m_cells], top_sup[m_cells]
            on_model = tm >= b - TOL
            over_sup = ~on_model & (ts > tm) & (b - ts <= reach)
            if over_sup.any():
                sel = np.nonzero(over_sup)[0]
                contacts.append(np.stack([m_cells[sel].astype(np.float64), b[sel], (b - ts)[sel],
                                          sup_feat[m_cells[sel]], S["fid"][m_beads[sel]], h[m_beads[sel]],
                                          np.full(len(sel), lz)], 1))
            open_ = ~on_model & ~over_sup & (b > first_top + TOL)
            if open_.any():
                sel = np.nonzero(open_)[0]
                held = held_beside(top_model, m_cells[sel], b[sel], h[m_beads[sel]] * slope, c, nx, ny)
                sel = sel[~held]
                if len(sel):
                    loose.append(np.stack([m_cells[sel].astype(np.float64), b[sel], np.full(len(sel), lz)], 1))
        if si is not None:
            cells, beads = raster(S, si, X0, Y0, c, nx, ny)
            bottoms = z[beads] - h[beads]
            s_cells, pick = per_cell(cells, bottoms)
            s_beads = beads[pick]
            s_top_feat = feature_at_top(S, cells, beads, s_cells)
            b = (z[s_beads] - h[s_beads]).astype(np.float32)
            tm, ts = top_model[s_cells], top_sup[s_cells]
            on_sup = ts >= b - TOL
            on_mod = ~on_sup & (tm > ts) & (b - tm <= min(reach, STAND_MM) + TOL) & (b > first_top + TOL)
            if on_mod.any():
                sel = np.nonzero(on_mod)[0]
                rests.append(np.stack([s_cells[sel].astype(np.float64), b[sel], (b - tm)[sel],
                                       S["fid"][s_beads[sel]], h[s_beads[sel]], np.full(len(sel), lz)], 1))
        if m_cells is not None:
            top_model[m_cells] = np.maximum(top_model[m_cells], lz)
            ever_model[m_cells] = True
            side_model[m_cells // ny, k] = True
            side_model_y[m_cells % ny, k] = True
        if s_cells is not None:
            top_sup[s_cells] = np.maximum(top_sup[s_cells], lz)
            sup_feat[s_cells] = s_top_feat
            ever_sup[s_cells] = True
            side_sup[s_cells // ny, k] = True
            side_sup_y[s_cells % ny, k] = True

    cs = np.concatenate(contacts) if contacts else np.zeros((0, 7))
    rs = np.concatenate(rests) if rests else np.zeros((0, 6))
    ls = np.concatenate(loose) if loose else np.zeros((0, 3))
    area = c * c
    names = S["names"]
    grid = {"X0": X0, "Y0": Y0, "c": c, "nx": nx, "ny": ny}
    zones, contact_zone = contact_zones(cs, ls, grid, names, ask, area)
    out["cell_mm"] = r(c, 3)
    out["reach_mm"] = reach
    out["contact"] = contact_summary(cs, ls, zones, ask, area, names)
    out["zones"] = zones
    out["on_model"], out["on_model_zones"], footing, rest_zone = rest_summary(rs, grid, ask, area, names)
    out["unsupported"] = {"mm2": r(len(ls) * area, 1),
                          "outside_zones_mm2": r(max(0.0, len(ls) * area - sum(zz["unsupported_mm2"] for zz in zones)), 1)}
    out["draw"] = {"grid": grid, "contacts": cs, "contact_zone": contact_zone, "rests": rs, "rest_zone": rest_zone,
                   "footing": footing, "loose": ls, "ever_model": ever_model.reshape(nx, ny),
                   "ever_sup": ever_sup.reshape(nx, ny), "levels": levels, "side_model": side_model,
                   "side_sup": side_sup, "side_model_y": side_model_y, "side_sup_y": side_sup_y}
    return out


def split_by(values, idx, levels):
    """The beads at each level: {level index: bead indexes}."""
    if not len(idx):
        return {}
    k = np.searchsorted(levels, values)
    order = np.argsort(k, kind="stable")
    ks, ids = k[order], idx[order]
    cut = np.nonzero(np.diff(ks))[0] + 1
    return {int(group[0]): ids_g for group, ids_g in zip(np.split(ks, cut), np.split(ids, cut))}


def feature_at_top(S, cl, beads, cells):
    """Which support feature tops each of cells at this height (an interface outranks plain support)."""
    by_fid = np.array([2 if re.search(r"(?i)interface|ironing", n) else 1 for n in S["names"]] or [1])
    rank = by_fid[S["fid"][beads]] if len(beads) else np.zeros(0)
    uc, pick = per_cell(cl, rank, lowest=False)
    pos = np.searchsorted(uc, cells)
    pos = np.clip(pos, 0, max(len(uc) - 1, 0))
    return np.where(uc[pos] == cells, S["fid"][beads[pick]][pos], -1) if len(uc) else np.full(len(cells), -1)


def held_beside(top_model, cells, bottoms, margins, c, nx, ny):
    """Whether a model bead with nothing under it is held up by the model beside it, within margins (the support
    threshold angle: a wall leaning out less than that needs nothing under it)."""
    from scipy.ndimage import maximum_filter
    held = np.zeros(len(cells), bool)
    if not len(cells):
        return held
    grid = top_model.reshape(nx, ny)
    ix, iy = cells // ny, cells % ny
    m = int(math.ceil(float(margins.max()) / c))
    if m <= 0:
        return held
    x0, x1 = max(0, ix.min() - m), min(nx, ix.max() + m + 1)
    y0, y1 = max(0, iy.min() - m), min(ny, iy.max() + m + 1)
    win = grid[x0:x1, y0:y1]
    win = np.where(np.isfinite(win), win, -1e9)
    near = maximum_filter(win, size=2 * m + 1, mode="constant", cval=-1e9)
    return near[ix - x0, iy - y0] >= bottoms - TOL


# Summing up


def gap_bins(gaps, area):
    """Area by gap, rounded to 0.01 mm: [{gap, mm2, share}], biggest share first; a gap under nothing is 0."""
    if not len(gaps):
        return []
    g = np.round(np.maximum(gaps, 0.0), 2)
    vals, counts = np.unique(g, return_counts=True)
    total = counts.sum()
    rows = [{"gap": float(v), "mm2": r(float(n) * area, 1), "share": r(float(n) / total, 3)} for v, n in zip(vals, counts)]
    return sorted(rows, key=lambda x: -x["share"])


def touching(bins, least=0.05):
    """The gap where the support's top is: the closest one that holds a real share of the contact (the rest is
    farther: between the support's top lines, or under the next step of a sloped underside)."""
    real = [b for b in bins if b["share"] >= least]
    return min(real, key=lambda b: b["gap"]) if real else (max(bins, key=lambda b: b["share"]) if bins else None)


def share_words(bins, top=3):
    rows = [b for b in bins if b["share"] >= 0.01][:top] or bins[:1]
    return ", ".join(f"{b['gap']:.2f} mm on {b['share'] * 100:.0f}%" for b in rows)


def contact_summary(cs, ls, zones, ask, area, names):
    if not len(cs):
        return {"mm2": 0.0, "zones": 0, "gaps": [], "words": "the support touches the model nowhere"}
    gaps = cs[:, 2]
    bins = gap_bins(gaps, area)
    want = ask.get("top_gap")
    under = None
    if want is not None:
        under = float(np.sum(np.maximum(gaps, 0) < want - TOL)) * area
    fused = float(np.sum(gaps < 0.05)) * area
    s = {"mm2": r(len(cs) * area, 1), "zones": len(zones), "gaps": bins,
         "touching": touching(bins), "median": r(float(np.median(np.maximum(gaps, 0))), 3),
         "min": r(float(max(0.0, gaps.min())), 3),
         "max": r(float(gaps.max()), 3), "asked": want,
         "under_asked_mm2": r(under, 1) if under is not None else None,
         "under_asked_share": r(under / (len(cs) * area), 3) if under is not None else None,
         "fused_mm2": r(fused, 1), "overlapping_mm2": r(float(np.sum(gaps < -TOL)) * area, 1),
         "support_features": feature_shares(cs[:, 3], names), "model_features": feature_shares(cs[:, 4], names),
         "model_bead_heights": height_shares(cs[:, 5])}
    reached = s["mm2"] + sum(z["unsupported_mm2"] for z in zones)
    s["reaches"] = r(s["mm2"] / reached, 3) if reached else None
    return s


def feature_shares(fids, names):
    fids = fids.astype(int)
    fids = fids[fids >= 0]
    if not len(fids):
        return {}
    vals, counts = np.unique(fids, return_counts=True)
    tot = counts.sum()
    return {names[v]: r(float(n) / tot, 3) for v, n in sorted(zip(vals, counts), key=lambda t: -t[1])}


def height_shares(hs):
    vals, counts = np.unique(np.round(hs, 3), return_counts=True)
    tot = counts.sum()
    return {f"{v:g}": r(float(n) / tot, 3) for v, n in sorted(zip(vals, counts), key=lambda t: -t[1])}


def labels3d(points_xyz, grid, xy=0.5, dz=0.6):
    """Which zone each point is in: points joined when they're within a coarse cell of each other in 3D."""
    from scipy.ndimage import label
    if not len(points_xyz):
        return np.zeros(0, int), 0
    q = np.stack([np.floor((points_xyz[:, 0] - grid["X0"]) / xy), np.floor((points_xyz[:, 1] - grid["Y0"]) / xy),
                  np.floor(points_xyz[:, 2] / dz)], 1).astype(np.int64)
    lo = q.min(0)
    q -= lo
    shape = tuple(int(v) + 1 for v in q.max(0))
    vol = np.zeros(shape, bool)
    vol[q[:, 0], q[:, 1], q[:, 2]] = True
    lab, n = label(vol, structure=np.ones((3, 3, 3), bool))
    return lab[q[:, 0], q[:, 1], q[:, 2]], n


def cell_xy(cells, grid):
    ny, c = grid["ny"], grid["c"]
    ix, iy = cells.astype(np.int64) // ny, cells.astype(np.int64) % ny
    return grid["X0"] + (ix + 0.5) * c, grid["Y0"] + (iy + 0.5) * c


def contact_zones(cs, ls, grid, names, ask, area, limit=12):
    """The places support meets the model: contacts and the overhang around them that nothing holds, each place its
    own zone in 3D; biggest first. Also answers each contact's zone number (0: one too small to count, or past limit)."""
    if not len(cs):
        return [], np.zeros(0, int)
    cx, cy = cell_xy(cs[:, 0], grid)
    lx, ly = cell_xy(ls[:, 0], grid) if len(ls) else (np.zeros(0), np.zeros(0))
    pts = np.concatenate([np.stack([cx, cy, cs[:, 1]], 1), np.stack([lx, ly, ls[:, 1]], 1)])
    lab, n = labels3d(pts, grid)
    lc, ll = lab[:len(cs)], lab[len(cs):]
    zones = []
    want = ask.get("top_gap")
    for z_id in np.unique(lc):
        sel = lc == z_id
        g = cs[sel, 2]
        if sel.sum() * area < 0.2 and len(zones) >= 1:
            continue
        loose_n = int(np.sum(ll == z_id))
        bins = gap_bins(g, area)
        x, y, zb = cx[sel], cy[sel], cs[sel, 1]
        zone = {"mm2": r(float(sel.sum()) * area, 1), "unsupported_mm2": r(loose_n * area, 1),
                "reaches": r(float(sel.sum()) / (sel.sum() + loose_n), 3),
                "center": [r(float(x.mean()), 1), r(float(y.mean()), 1)],
                "box": [r(float(x.min()), 1), r(float(y.min()), 1), r(float(x.max()), 1), r(float(y.max()), 1)],
                "z": [r(float(zb.min()), 2), r(float(zb.max()), 2)],
                "gap": {"touching": touching(bins), "median": r(float(np.median(np.maximum(g, 0))), 3),
                        "min": r(float(max(0.0, g.min())), 3), "max": r(float(g.max()), 3), "bins": bins},
                "under_asked_share": (r(float(np.mean(np.maximum(g, 0) < want - TOL)), 3) if want is not None else None),
                "support_features": feature_shares(cs[sel, 3], names), "model_features": feature_shares(cs[sel, 4], names)}
        zones.append((zone, z_id))
    zones.sort(key=lambda zz: -zz[0]["mm2"])
    zone_of = np.zeros(len(cs), int)
    for i, (zz, z_id) in enumerate(zones[:limit]):
        zz["zone"] = i + 1
        zone_of[lc == z_id] = i + 1
    return [zz for zz, _ in zones[:limit]], zone_of


def rest_summary(rs, grid, ask, area, names, limit=8):
    """Where support stands on the model rather than the bed: area, gap, and each place."""
    if not len(rs):
        return {"mm2": 0.0, "gaps": [], "words": "no support stands on the model"}, [], np.zeros(0, bool), np.zeros(0, int)
    x, y = cell_xy(rs[:, 0], grid)
    lab, n = labels3d(np.stack([x, y, rs[:, 1]], 1), grid)
    zones = []
    footing = np.zeros(len(rs), bool)
    for z_id in np.unique(lab):
        sel = lab == z_id
        if sel.sum() * area >= FOOTING_MM2:
            footing |= sel
        if sel.sum() * area < 0.2:
            continue
        g = rs[sel, 2]
        zones.append({"mm2": r(float(sel.sum()) * area, 1), "center": [r(float(x[sel].mean()), 1), r(float(y[sel].mean()), 1)],
                      "box": [r(float(x[sel].min()), 1), r(float(y[sel].min()), 1), r(float(x[sel].max()), 1), r(float(y[sel].max()), 1)],
                      "z": [r(float(rs[sel, 1].min()), 2), r(float(rs[sel, 1].max()), 2)],
                      "gap": {"median": r(float(np.median(np.maximum(g, 0))), 3), "bins": gap_bins(g, area)}, "_label": z_id})
    zones.sort(key=lambda zz: -zz["mm2"])
    zone_of = np.zeros(len(rs), int)
    for i, zz in enumerate(zones[:limit]):
        zz["zone"] = i + 1
        zone_of[lab == zz.pop("_label")] = i + 1
    for zz in zones[limit:]:
        zz.pop("_label")
    s = {"mm2": r(len(rs) * area, 1), "gaps": gap_bins(rs[:, 2], area),
         "median": r(float(np.median(np.maximum(rs[:, 2], 0))), 3), "asked": ask.get("bottom_gap"),
         "support_features": feature_shares(rs[:, 3], names)}
    return s, zones[:limit], footing, zone_of


def layer_heights(S, model_i, sup_i):
    """The heights beads were laid at: the model's in runs up the print, the support's, and how the support's layers
    sit against the model's (the same layers, or their own between them)."""
    out = {}
    z, h = S["z"], S["h"]
    if len(model_i):
        lv = np.unique(z[model_i])
        hh = []
        for v in lv:  # each level's commonest model bead height
            sel = model_i[z[model_i] == v]
            vals, counts = np.unique(np.round(h[sel], 3), return_counts=True)
            hh.append(float(vals[np.argmax(counts)]))
        runs = []
        for v, hv in zip(lv, hh):
            if runs and abs(runs[-1]["height"] - hv) <= TOL:
                runs[-1]["to_z"] = r(float(v), 3)
                runs[-1]["layers"] += 1
            else:
                runs.append({"height": r(hv, 3), "from_z": r(float(v), 3), "to_z": r(float(v), 3), "layers": 1})
        out["model"] = runs
        out["model_layers"] = int(len(lv))
        out["first"] = r(hh[0], 3)
    if len(sup_i):
        vals, counts = np.unique(np.round(h[sup_i], 3), return_counts=True)
        sl = np.unique(z[sup_i])
        ml = set(np.round(np.unique(z[model_i]), 3).tolist()) if len(model_i) else set()
        own = [v for v in np.round(sl, 3).tolist() if v not in ml]
        out["support"] = [{"height": float(v), "share": r(float(n) / counts.sum(), 3)}
                          for v, n in sorted(zip(vals, counts), key=lambda t: -t[1]) if n / counts.sum() >= 0.01]
        out["support_layers"] = int(len(sl))
        out["support_own_layers"] = len(own)
        out["support_z"] = [r(float(sl.min()), 3), r(float(sl.max()), 3)]
    return out


def feature_lengths(S, seg_len):
    out = {}
    for f, L in zip(S["fid"], seg_len):
        out[f] = out.get(f, 0.0) + float(L)
    return {S["names"][f]: r(v / 1000, 2) for f, v in sorted(out.items(), key=lambda kv: -kv[1])}


# Words


def mm(v, nd=2):
    return f"{v:.{nd}f}".rstrip("0").rstrip(".") if v is not None else "?"


def layer_words(L):
    """The model's layer heights in words: "0.2 mm", or "first 0.2, then 0.16 mm"."""
    runs = L.get("model") or []
    if not runs:
        return None
    if len(runs) > 1 and runs[0]["layers"] == 1:
        return f"first {mm(runs[0]['height'])}, then " + ", ".join(f"{mm(x['height'])}" for x in runs[1:4]) + " mm"
    return ", ".join(f"{mm(x['height'])}" for x in runs[:3]) + " mm"


def support_heights(L, n=3):
    seen = []
    for x in L.get("support") or []:
        v = round(x["height"], 2)
        if v not in seen:
            seen.append(v)
    return seen[:n]


def shown_zones(p, most=6):
    """The zones worth a line: each with at least 2% of the contact (or the biggest), and what's left."""
    zones = p.get("zones") or []
    total = sum(z["mm2"] for z in zones) or 1
    shown = [z for z in zones if z["mm2"] / total >= 0.02][:most] or zones[:1]
    return shown, zones[len(shown):]


def touch_words(t, asked_gap=None):
    """'0.2 mm (61% of the contact)', with how it stands against what was asked."""
    if not t:
        return "?"
    s = f"{mm(t['gap'])} mm under it on {t['share'] * 100:.0f}% of that"
    if asked_gap is not None:
        if t["gap"] < asked_gap - TOL:
            s += f": closer than the {mm(asked_gap)} asked"
        elif t["gap"] > asked_gap + TOL:
            s += f": wider than the {mm(asked_gap)} asked"
        else:
            s += ", as asked"
    return s


def verdict(p):
    """One plate in a few sentences."""
    st, L = p["settings"], p["layers"]
    what = []
    if st.get("type"):
        what.append(str(st["type"]) + (" from the bed only" if st.get("build_plate_only") else ""))
    lw = layer_words(L)
    if lw:
        what.append(f"layers {lw}")
    sh = support_heights(L)
    if sh:
        what.append(f"support beads {'/'.join(mm(v) for v in sh)} mm" +
                    (f" (on {L['support_own_layers']} layers of their own)" if L.get("support_own_layers") else ""))
    if st.get("top_gap") is not None:
        what.append(f"top gap asked {mm(st['top_gap'])} mm")
    head = f"{p['name']}: " + "; ".join(what)
    if not p.get("has_support"):
        return [head, "  no support in this plate."]
    lines = [head]
    c = p["contact"]
    if not c or not c.get("mm2"):
        lines.append("  the support touches the model nowhere (it holds nothing up).")
    else:
        t = c.get("touching") or {}
        s = (f"  where the support touches the model ({c['zones']} place{'s' if c['zones'] != 1 else ''}, {c['mm2']:g} mm²), "
             f"its top is {touch_words(t, c.get('asked'))}")
        farther = [b for b in c["gaps"] if b["gap"] > t.get("gap", 0) + TOL and b["share"] >= 0.05]
        closer = [b for b in c["gaps"] if b["gap"] < t.get("gap", 0) - TOL]
        if farther:
            s += "; farther under the rest (" + ", ".join(f"{mm(b['gap'])} on {b['share'] * 100:.0f}%" for b in sorted(farther, key=lambda b: b["gap"])[:3]) + ")"
        if sum(b["mm2"] for b in closer) >= 0.5:
            s += f"; {sum(b['mm2'] for b in closer):.1f} mm² is closer still (" + ", ".join(f"{mm(b['gap'])}" for b in sorted(closer, key=lambda b: b["gap"])[:3]) + ")"
        if c.get("fused_mm2"):
            s += f"; {c['fused_mm2']:g} mm² has no gap at all (it will fuse)"
        if c.get("reaches") is not None:
            s += f". It reaches {c['reaches'] * 100:.0f}% of the overhang around those places"
        lines.append(s + ".")
        shown, rest = shown_zones(p)
        for zz in shown:
            sf = ", ".join(list(zz["support_features"])[:2]) or "support"
            mf = ", ".join(list(zz["model_features"])[:2]) or "the model"
            lines.append(f"    {zz['zone']}. z {mm(zz['z'][0])}–{mm(zz['z'][1])} around ({zz['center'][0]:g}, {zz['center'][1]:g}): "
                         f"{zz['mm2']:g} mm², gap {share_words(zz['gap']['bins'], 2)}; {sf} under {mf}; reaches {zz['reaches'] * 100:.0f}%")
        if rest:
            lines.append(f"    and {len(rest)} small place{'s' if len(rest) != 1 else ''}, {sum(z['mm2'] for z in rest):g} mm² in all.")
    o = p["on_model"]
    if o and o.get("mm2"):
        big = [zz for zz in p["on_model_zones"] if zz["mm2"] >= FOOTING_MM2]
        if big:
            where = "; ".join(f"z {mm(zz['z'][0])} around ({zz['center'][0]:g}, {zz['center'][1]:g}) {zz['mm2']:g} mm²" for zz in big[:4])
            lines.append(f"  support stands on the model on {o['mm2']:g} mm², gap {share_words(o['gaps'])}" +
                         (f" (asked {mm(o['asked'])})" if o.get("asked") is not None else "") + f": {where}.")
        else:
            lines.append(f"  support stands on the model only in scraps, {o['mm2']:g} mm² in bits under 1 mm² each "
                         f"(gap {share_words(o['gaps'], 2)}): a branch's edge over a surface, not a footing.")
    else:
        lines.append("  no support stands on the model: it all starts on the bed.")
    u = p.get("unsupported") or {}
    if (u.get("outside_zones_mm2") or 0) >= 1:
        lines.append(f"  elsewhere {u['outside_zones_mm2']:g} mm² of overhang has nothing under it (bridges, or what the support misses).")
    return lines


def table_row(p):
    c, o, st = p.get("contact") or {}, p.get("on_model") or {}, p["settings"]
    big = [zz for zz in p.get("on_model_zones") or [] if zz["mm2"] >= FOOTING_MM2]
    return {"plate": p["name"], "type": st.get("type"), "build_plate_only": st.get("build_plate_only"),
            "layers": layer_words(p["layers"]), "support_beads": support_heights(p["layers"]),
            "asked_top_gap": st.get("top_gap"), "touching_gap": (c.get("touching") or {}).get("gap"),
            "touching_share": (c.get("touching") or {}).get("share"),
            "gaps": [{"gap": b["gap"], "share": b["share"]} for b in (c.get("gaps") or [])[:4]],
            "contact_mm2": c.get("mm2"), "under_asked_share": c.get("under_asked_share"), "fused_mm2": c.get("fused_mm2"),
            "reaches": c.get("reaches"), "on_model_mm2": r(sum(zz["mm2"] for zz in big), 1) if big else 0.0}


def table_lines(rows):
    """Several plates side by side, a line each."""
    out = ["Side by side:"]
    for t in rows:
        gap = (f"support top {mm(t['touching_gap'])} under the model ({t['touching_share'] * 100:.0f}%)"
               if t.get("touching_gap") is not None else "touches nothing")
        bits = [str(t["type"] or "?") + (" from the bed" if t.get("build_plate_only") else ""), f"layers {t['layers'] or '?'}",
                f"asked {mm(t['asked_top_gap'])}" if t["asked_top_gap"] is not None else None, gap,
                f"{t['contact_mm2']:g} mm² touching" if t.get("contact_mm2") else None,
                f"{t['under_asked_share'] * 100:.0f}% closer than asked" if (t.get("under_asked_share") or 0) >= 0.01 else None,
                f"reaches {t['reaches'] * 100:.0f}% of the overhang" if t.get("reaches") is not None else None,
                f"stands on the model on {t['on_model_mm2']:g} mm²" if t.get("on_model_mm2") else "nothing stands on the model"]
        out.append(f"  {t['plate']}: " + " · ".join(b for b in bits if b))
    return out


# Drawing


GREY, GREEN, PURPLE, PINK = (0.78, 0.80, 0.84), (0.80, 0.92, 0.80), "#7b3294", "#f4a6c0"


RED, ORANGE, GREEN_GAP, BLUE, PALE_PURPLE = "#d7191c", "#f39233", "#1a9641", "#2b83ba", "#c9a6d9"


def gap_colors(gaps, asked_gap):
    """Each gap's colour, as the legend says: red no gap, orange closer than asked, green as asked, blue wider."""
    g = np.maximum(np.asarray(gaps, float), 0)
    if asked_gap is None:
        return np.where(g < 0.05, RED, BLUE)
    return np.select([g < 0.05, g < asked_gap - TOL, g <= asked_gap + TOL], [RED, ORANGE, GREEN_GAP], BLUE)


def side_image(levels, present, n, step=0.1, most=1.0):
    """A side view of one kind of bead: each level filled down to the level of that kind below it (at most most mm)."""
    zmax = float(levels.max()) if len(levels) else 1.0
    rows = max(2, int(math.ceil(zmax / step)) + 1)
    img = np.zeros((rows, n), bool)
    prev = 0.0
    for k, z in enumerate(levels):
        col = present[:, k]
        if not col.any():
            continue
        lo = max(prev, z - most)
        a, b = int(math.floor(lo / step + 1e-6)), int(math.ceil(z / step - 1e-6))
        img[max(0, a):max(a + 1, b), :] |= col[None, :]
        prev = z
    return img, rows * step


def draw(plates, path, title):
    """A band per plate: from above (where support meets the model, coloured by gap), from the side, and the gap's
    spread against what was asked."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as P
    from matplotlib.lines import Line2D
    from matplotlib.patches import Patch
    rows = [p for p in plates if p.get("draw")]
    if not rows:
        return None
    band = 5.4
    fig = P.figure(figsize=(17, band * len(rows) + 1.2), dpi=90)
    subs = fig.subfigures(len(rows) + 1, 1, height_ratios=[band] * len(rows) + [1.2], squeeze=False)[:, 0]
    for sf, p in zip(subs, rows):
        d = p["draw"]
        g = d["grid"]
        c = g["c"]
        ext = [g["X0"], g["X0"] + g["nx"] * c, g["Y0"], g["Y0"] + g["ny"] * c]
        want = p["settings"].get("top_gap")
        cs, rs, ls = d["contacts"], d["rests"], d["loose"]
        axs = sf.subplots(1, 3, gridspec_kw={"width_ratios": [1.0, 1.15, 0.85]})
        con = p.get("contact") or {}
        sub = " · ".join(x for x in [
            str(p["settings"].get("type") or ""), f"layers {layer_words(p['layers'])}" if layer_words(p["layers"]) else "",
            f"support beads {'/'.join(mm(v) for v in support_heights(p['layers']))} mm",
            f"top gap asked {mm(want)}" if want is not None else "",
            (f"support top {mm((con.get('touching') or {}).get('gap'))} under the model on {con.get('mm2'):g} mm²"
             if con.get("mm2") else "touching nothing"),
            (f"{con['under_asked_share'] * 100:.0f}% closer than asked" if (con.get("under_asked_share") or 0) >= 0.01 else "")] if x)
        sf.suptitle(f"{p['name']}\n{sub}", x=0.01, ha="left", fontsize=11.5, fontweight="bold", y=0.995)

        ax = axs[0]
        base = np.zeros((g["ny"], g["nx"], 4))
        base[d["ever_model"].T] = (*GREY, 1)
        base[d["ever_sup"].T & ~d["ever_model"].T] = (*GREEN, 1)
        ax.imshow(base, origin="lower", extent=ext, interpolation="nearest")
        if len(ls):
            x, y = cell_xy(ls[:, 0], g)
            ax.scatter(x, y, s=1.2, c=PINK, marker="s", lw=0, zorder=2)
        foot = d["footing"]
        if len(rs):
            x, y = cell_xy(rs[:, 0], g)
            ax.scatter(x, y, s=1.6, c=np.where(foot, PURPLE, PALE_PURPLE), marker="s", lw=0, zorder=3)
        if len(cs):
            o = np.argsort(-cs[:, 1])  # the lowest contact in each column drawn last, on top
            x, y = cell_xy(cs[o, 0], g)
            ax.scatter(x, y, s=1.6, c=gap_colors(cs[o, 2], want), marker="s", lw=0, zorder=4)
        ax.set_xlim(ext[0], ext[1])
        ax.set_ylim(ext[2], ext[3])
        ax.set_aspect("equal")
        ax.set_xlabel("x (mm)")
        ax.set_ylabel("y (mm)")
        ax.set_title("From above", fontsize=10)

        ax = axs[1]
        levels = d["levels"]
        ix = cs[:, 0].astype(np.int64) // g["ny"] if len(cs) else np.zeros(0, int)
        iy = cs[:, 0].astype(np.int64) % g["ny"] if len(cs) else np.zeros(0, int)
        use_y = len(cs) and np.ptp(iy) > np.ptp(ix)
        sm, ss, lo, n = ((d["side_model_y"], d["side_sup_y"], g["Y0"], g["ny"]) if use_y else
                         (d["side_model"], d["side_sup"], g["X0"], g["nx"]))
        sup_img, ztop = side_image(levels, ss, n)
        mod_img, _ = side_image(levels, sm, n)
        img = np.zeros(sup_img.shape + (4,))
        img[sup_img] = (*GREEN, 1)
        img[mod_img] = (*GREY, 1)
        ax.imshow(img, origin="lower", extent=[lo, lo + n * c, 0, ztop], aspect="equal", interpolation="nearest")
        if len(rs):
            x, y = cell_xy(rs[:, 0], g)
            ax.scatter(y if use_y else x, rs[:, 1], s=2, c=np.where(foot, PURPLE, PALE_PURPLE), lw=0, zorder=3)
        if len(cs):
            x, y = cell_xy(cs[:, 0], g)
            ax.scatter(y if use_y else x, cs[:, 1], s=2.5, c=gap_colors(cs[:, 2], want), lw=0, zorder=4)
        shown, _ = shown_zones(p)
        for zz in shown:
            ax.annotate(str(zz["zone"]), (zz["box"][2 if not use_y else 3] + 1.0, (zz["z"][0] + zz["z"][1]) / 2), fontsize=9,
                        fontweight="bold", ha="left", va="center", annotation_clip=False,
                        bbox=dict(boxstyle="circle,pad=0.15", fc="white", ec="black", lw=0.8), zorder=6)
        zs = [zz["z"] for zz in p["zones"]] + [zz["z"] for zz in p["on_model_zones"]]
        if zs:
            ax.set_ylim(max(0, min(a for a, b in zs) - 3), min(ztop, max(b for a, b in zs) + 3))
        ax.set_xlim(lo, lo + n * c)
        ax.set_xlabel(("y" if use_y else "x") + " (mm)")
        ax.set_ylabel("z (mm)")
        ax.set_title("From the side (all of it seen through): each contact at its model bead's bottom", fontsize=10)

        ax = axs[2]
        bins = sorted(con.get("gaps") or [], key=lambda b: b["gap"])
        rb = sorted((p["on_model"] or {}).get("gaps") or [], key=lambda b: b["gap"])
        if bins:
            ax.bar([b["gap"] for b in bins], [b["mm2"] for b in bins], width=0.014,
                   color=list(gap_colors([b["gap"] for b in bins], want)))
            for b in bins:
                if b["share"] >= 0.03:
                    ax.annotate(f"{b['share'] * 100:.0f}%", (b["gap"], b["mm2"]), ha="center", va="bottom", fontsize=9)
        if rb:
            ax.bar([b["gap"] + 0.014 for b in rb], [b["mm2"] for b in rb], width=0.014, color=PURPLE, alpha=0.85,
                   label="standing on the model")
        if want is not None:
            ax.axvline(want, color="#333333", ls="--", lw=1.2)
            ax.annotate(f" asked {mm(want)}", (want, 1.0), xycoords=("data", "axes fraction"), ha="left", va="top", fontsize=9)
        ax.set_xlim(-0.03, max(0.45, 2.1 * (want or 0.2), max([b["gap"] for b in bins + rb], default=0) + 0.06))
        ax.set_xlabel("gap (mm): support top to the model bead's bottom")
        ax.set_ylabel("area (mm²)")
        ax.set_title("How much at each gap", fontsize=10)
        if rb:
            ax.legend(fontsize=8, frameon=False, loc="upper right")
    leg = subs[-1]
    handles = [Patch(color=GREY, label="model"), Patch(color=GREEN, label="support"),
               Line2D([0], [0], marker="s", ls="", color=RED, label="touching, no gap"),
               Line2D([0], [0], marker="s", ls="", color=ORANGE, label="closer than asked"),
               Line2D([0], [0], marker="s", ls="", color=GREEN_GAP, label="at the gap asked"),
               Line2D([0], [0], marker="s", ls="", color=BLUE, label="wider"),
               Line2D([0], [0], marker="s", ls="", color=PURPLE, label="support standing on the model"),
               Line2D([0], [0], marker="s", ls="", color=PALE_PURPLE, label="a branch's edge over it"),
               Line2D([0], [0], marker="s", ls="", color=PINK, label="overhang nothing holds")]
    leg.legend(handles=handles, loc="center", ncol=5, fontsize=9.5, frameon=False)
    fig.suptitle(title, fontsize=14, fontweight="bold", x=0.01, ha="left", y=1.0 + 0.35 / fig.get_figheight())
    fig.savefig(path, dpi=90, bbox_inches="tight")
    P.close(fig)
    return path


def slim(p):
    """What an asker needs of a plate, not every bin of every place: the answer stays a few KB a plate."""
    c = p.get("contact") or {}
    if c.get("gaps"):
        c["gaps"] = c["gaps"][:6]
    for zz in (p.get("zones") or [])[:8]:
        zz["gap"]["bins"] = zz["gap"]["bins"][:4]
    p["zones"] = (p.get("zones") or [])[:8]
    o = p.get("on_model") or {}
    if o.get("gaps"):
        o["gaps"] = o["gaps"][:4]
    for zz in p.get("on_model_zones") or []:
        zz["gap"] = {"median": zz["gap"]["median"], "touching": touching(zz["gap"]["bins"])}
    p["on_model_zones"] = (p.get("on_model_zones") or [])[:6]


# The job


def op_supports(job):
    """{files: [{path, name}], plate, cell, reach, box, sheet}: each plate read, and one sheet of them all."""
    box = None
    if job.get("box"):
        b = [float(v) for v in job["box"]]
        b = [b[0], b[1], b[3], b[4]] if len(b) == 6 else b
        box = [min(b[0], b[2]), min(b[1], b[3]), max(b[0], b[2]), max(b[1], b[3])]
    elif job.get("around") is not None:
        cxy = [float(v) for v in job["around"]]
        rad = float(job.get("radius") or 10)
        box = [cxy[0] - rad, cxy[1] - rad, cxy[0] + rad, cxy[1] + rad]
    plates = []
    for f in job["files"]:
        try:
            p = analyse(f["path"], job.get("plate"), cell=float(job.get("cell") or 0.1),
                        reach=float(job.get("reach") or 1.0), box=box)
        except (ValueError, geom.Unreadable) as e:
            plates.append({"name": f["name"], "error": str(e)})
            continue
        p["name"] = f["name"]
        plates.append(p)
    good = [p for p in plates if not p.get("error")]
    sheet = None
    if job.get("sheet") and good:
        title = ("Support gap: " + good[0]["name"]) if len(good) == 1 else f"Support gap: {len(good)} plates side by side"
        sheet = draw(good, job["sheet"], title)
    for p in plates:
        p.pop("draw", None)
        p.pop("raw_settings", None)
        slim(p)
    table = [table_row(p) for p in good]
    lines = table_lines(table) if len(good) > 1 else []
    for p in plates:
        lines += [f"{p['name']}: can't read it: {p['error']}"] if p.get("error") else verdict(p)
    return {"plates": plates, "table": table, "words": lines, "sheet": sheet}
