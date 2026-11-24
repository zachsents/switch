"""A sliced plate's real supports, to look at: the part as placed on the plate in gray and every bead of support the
G-code lays as its own solid (orange; interface darker), pictured from the angles that show them best, and the marks
they'll leave, each place the support meets the part found on the part's own surface and judged: on a face that shows
(red) or one hidden inside a pocket, a hole or a box (blue), and how thick the part is behind it. Also written as
.usdz (Quick Look on a Mac or iPhone) and .3mf (any slicer), each colour its own object."""

import os
import subprocess
import zipfile

import numpy as np
import trimesh

import geom
import supports
from geom import r

COLORS = {"part": (0.70, 0.71, 0.73), "support": (1.0, 0.45, 0.0), "interface": (0.75, 0.18, 0.0),
          "touch": (0.88, 0.07, 0.10), "touch_hidden": (0.15, 0.42, 0.95)}
OPEN = 0.3
"""A point shows when at least this share of the directions it faces reach open air past the part (the outside of the
part, or a recess shallow enough to see into). Below it, it's inside a pocket, a hole, a box or behind a wall. On
plates seen so far the outside reads 0.5 to 1, the inside of a case 0 to 0.27, and only a shallow tray's floor between."""
THIN = 1.2
"""Part this thin behind a contact (three lines of a 0.4 mm nozzle) can tear or snap when the support comes off."""
PER_ZONE = 400
"""Points of each place judged (spread over it): enough to tell a place half inside a pocket from one outside."""


def plate_model(path, S, model_i):
    """The part's mesh, from the plate's own 3MF, set where the G-code lays it (its footprint centred on the model beads,
    standing on the bed)."""
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
    if not any(n.startswith("3D/") for n in names):
        return None
    loaded = trimesh.load(path, force="scene")
    m = loaded.to_geometry() if hasattr(loaded, "to_geometry") else loaded.dump(concatenate=True)
    xs = np.concatenate([S["x0"][model_i], S["x1"][model_i]])
    ys = np.concatenate([S["y0"][model_i], S["y1"][model_i]])
    (x0, y0, z0), (x1, y1, _) = m.bounds
    m.apply_translation([(xs.min() + xs.max()) / 2 - (x0 + x1) / 2, (ys.min() + ys.max()) / 2 - (y0 + y1) / 2, -z0])
    return m


def samples(S, idx, step=0.2):
    """Points along the beads idx, every step mm, at each bead's mid-height."""
    x0, y0, x1, y1 = S["x0"][idx], S["y0"][idx], S["x1"][idx], S["y1"][idx]
    zc = S["z"][idx] - S["h"][idx] / 2
    L = np.hypot(x1 - x0, y1 - y0)
    n = np.maximum(1, np.ceil(L / step).astype(np.int64))
    rep = np.repeat(np.arange(len(idx)), n)
    start = np.repeat(np.cumsum(n) - n, n)
    t = (np.arange(n.sum()) - start + 0.5) / n[rep]
    return np.stack([x0[rep] + (x1 - x0)[rep] * t, y0[rep] + (y1 - y0)[rep] * t, zc[rep]], 1)


def beads(S, idx, cell=0.4):
    """The beads idx as one solid: every cell of a cell-mm grid a bead passes through, and only the faces between a
    filled cell and an empty one, so a tree of a million moves stays a file a phone opens."""
    P = samples(S, idx, step=cell / 2)
    if not len(P):
        return None
    lo = P.min(0) - cell
    ijk = np.floor((P - lo) / cell).astype(np.int64)
    dims = ijk.max(0) + 3
    G = np.zeros(dims, bool)
    G[ijk[:, 0], ijk[:, 1], ijk[:, 2]] = True
    quads = []
    unit = np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]])
    for ax in range(3):
        for sign in (1, -1):
            nb = np.roll(G, -sign, axis=ax)
            f = np.argwhere(G & ~nb)
            if not len(f):
                continue
            # the face's four corners: the cell's side on +ax (sign 1) or -ax, wound to face outward
            u, v = [a for a in range(3) if a != ax]
            c = np.zeros((4, 3), np.int64)
            c[:, u] = unit[:, 0]
            c[:, v] = unit[:, 1]
            c[:, ax] = 1 if sign > 0 else 0
            if (sign > 0) == (ax == 1):  # u × v points along -y for ax 1, along +x and +z otherwise: wind it outward
                c = c[::-1]
            quads.append(f[:, None, :] + c[None])
    Q = np.concatenate(quads).astype(np.float64) * cell + lo
    V = Q.reshape(-1, 3)
    n = len(Q)
    F = np.concatenate([np.stack([np.arange(n) * 4, np.arange(n) * 4 + 1, np.arange(n) * 4 + 2], 1),
                        np.stack([np.arange(n) * 4, np.arange(n) * 4 + 2, np.arange(n) * 4 + 3], 1)])
    m = trimesh.Trimesh(V, F, process=True)
    return m


def markers(marks, radius):
    """A sphere at each mark, on the part's surface where it is: (touch, touch_hidden), either None when it has none."""
    out = {True: [], False: []}
    for mk in marks:
        s = trimesh.creation.icosphere(subdivisions=2, radius=radius)
        s.apply_translation(mk["at"])
        out[mk["shows"]].append(s)
    return tuple(trimesh.util.concatenate(out[k]) if out[k] else None for k in (True, False))


# Where the support meets the part, on the part


def hemisphere(n=64):
    """n directions spread evenly over the half of the sphere about +z."""
    i = np.arange(n) + 0.5
    z = 1 - i / n
    phi = i * np.pi * (3 - np.sqrt(5))
    s = np.sqrt(1 - z * z)
    return np.stack([s * np.cos(phi), s * np.sin(phi), z], 1)


def turned(dirs, nrm):
    """Directions about +z, turned to lie about each normal: (len(nrm), len(dirs), 3)."""
    a = np.where(np.abs(nrm[:, 2:3]) < 0.9, np.array([[0, 0, 1.0]]), np.array([[1.0, 0, 0]]))
    t = np.cross(nrm, a)
    t /= np.linalg.norm(t, axis=1, keepdims=True)
    b = np.cross(nrm, t)
    return (dirs[None, :, 0, None] * t[:, None] + dirs[None, :, 1, None] * b[:, None] + dirs[None, :, 2, None] * nrm[:, None])


def on_surface(part, pts, up):
    """Where G-code points lie on the part's own surface: straight up to the underside the support holds (up), or
    straight down to the top it stands on. Answers the points, their faces' outward normals, and which were found."""
    n = len(pts)
    d = np.array([0, 0, 1.0 if up else -1.0])
    tri, ray, loc = part.ray.intersects_id(pts, np.tile(d, (n, 1)), multiple_hits=True, return_locations=True)
    P, N, ok = np.zeros((n, 3)), np.zeros((n, 3)), np.zeros(n, bool)
    if len(tri):
        fn = part.face_normals[tri]
        dist = (loc - pts[ray]) @ d
        good = (fn @ d < -0.05) & (dist < 2.5)
        tri, ray, loc, fn, dist = tri[good], ray[good], loc[good], fn[good], dist[good]
        order = np.lexsort((dist, ray))
        ray, loc, fn = ray[order], loc[order], fn[order]
        first = np.r_[True, ray[1:] != ray[:-1]] if len(ray) else np.zeros(0, bool)
        P[ray[first]], N[ray[first]], ok[ray[first]] = loc[first], fn[first], True
    miss = np.nonzero(~ok)[0]
    if len(miss):  # at the edge of a face: the nearest surface, when it's close
        cp, dist, tri = trimesh.proximity.closest_point(part, pts[miss])
        near = dist < 1.0
        P[miss[near]], N[miss[near]], ok[miss[near]] = cp[near], part.face_normals[tri[near]], True
    return P, N, ok


def openness(part, P, N, k=64):
    """The share of the directions each point faces that reach open air past the part."""
    dirs = turned(hemisphere(k), N).reshape(-1, 3)
    origins = np.repeat(P + N * 0.05, k, axis=0)
    hit = part.ray.intersects_any(origins, dirs)
    return 1 - hit.reshape(len(P), k).mean(1)


def wall_behind(part, P, N):
    """How thick the part is behind each point, straight through along its normal (nan where the ray finds no far side)."""
    origins = P - N * 0.02
    loc, ray, _ = part.ray.intersects_location(origins, -N, multiple_hits=False)
    w = np.full(len(P), np.nan)
    if len(ray):
        w[ray] = np.linalg.norm(loc - origins[ray], axis=1) + 0.02
    return w


def marks(part, A, hidden=()):
    """Each place the support meets the part (under it, from A's zones, and standing on it, from its footings), found
    on the part's surface and judged: whether it shows, how thick the part is behind it, and the points to paint.
    hidden: the labels of marks known to be covered in use (a mating face, the inside of a closed case)."""
    from scipy.spatial import cKDTree
    hidden = {str(h).strip().upper() for h in hidden or ()}
    D = A.get("draw")
    if not D:
        return [], np.zeros((0, 3)), np.zeros(0, bool), np.zeros(0, bool)
    grid = D["grid"]
    rng = np.random.default_rng(0)
    out, raw, raw_shows, raw_up = [], [], [], []
    sets = [("under", D["contacts"], D["contact_zone"], True, A.get("zones") or []),
            ("on", D["rests"], D["rest_zone"], False,
             [zz for zz in A.get("on_model_zones") or [] if zz["mm2"] >= supports.FOOTING_MM2])]
    for where, arr, zone_of, up, zones in sets:
        if not len(arr):
            continue
        x, y = supports.cell_xy(arr[:, 0], grid)
        b, gap = arr[:, 1], arr[:, 2]
        if up:  # from inside the gap under the part's underside
            z0 = b - np.maximum(gap, 0.1) - 0.05
        else:  # from the support's bottom, over the top it stands on
            z0 = np.maximum(b, b - gap + 0.15) + 0.05
        for zz in zones:
            members = np.nonzero(zone_of == zz["zone"])[0]
            if not len(members):
                continue
            pick = members if len(members) <= PER_ZONE else rng.choice(members, PER_ZONE, replace=False)
            P, N, ok = on_surface(part, np.c_[x[pick], y[pick], z0[pick]], up)
            if not ok.any():
                continue
            P, N = P[ok], N[ok]
            o = openness(part, P, N)
            w = wall_behind(part, P, N)
            shows_share = float(np.mean(o >= OPEN))
            wall = float(np.nanpercentile(w, 10)) if np.isfinite(w).any() else None
            label = zz["zone"] if up else chr(ord("A") + zz["zone"] - 1)
            said = str(label) in hidden
            if said:
                o = np.zeros_like(o)
            mk = {"zone": label, "where": where, "mm2": zz["mm2"], "said_hidden": said,
                  "shows": not said and shows_share >= 0.5, "shows_share": r(shows_share, 2), "open": r(float(np.median(o)), 2),
                  "wall": r(wall, 2), "thin": wall is not None and wall < THIN,
                  "at": [r(v, 2) for v in P.mean(0)], "_P": P, "_N": N, "_o": o}
            out.append(mk)
            sel = members
            raw.append(np.c_[x[sel], y[sel], b[sel] if up else b[sel] - gap[sel]])
            _, near = cKDTree(P).query(raw[-1])  # each painted point takes the verdict of the judged point nearest it
            raw_shows.append(o[near] >= OPEN)
            raw_up.append(np.full(len(sel), up))
    if not raw:
        return out, np.zeros((0, 3)), np.zeros(0, bool), np.zeros(0, bool)
    return out, np.concatenate(raw), np.concatenate(raw_shows), np.concatenate(raw_up)


# Pictures


def candidates():
    """Eye directions to choose from: around the part every 45°, from above, level and below (the bed isn't drawn)."""
    out = []
    for el in (35, 10, -30):
        for az in range(0, 360, 45):
            a, e = np.radians(az + 22.5), np.radians(el)
            out.append((np.array([np.cos(e) * np.cos(a), np.cos(e) * np.sin(a), np.sin(e)]), el))
    return out


def pick_views(part, scene_mesh, sup, mks, n=3):
    """The n eye directions that show the support and its marks best: first the one that shows the most of both, then
    each one that shows the marks the others miss (the ones that show weigh double), at least 60° apart."""
    cands = candidates()
    E = np.array([e for e, _ in cands])
    # what of the support each direction sees past the part and the rest of the support
    fc, fn = sup.triangles_center, sup.face_normals
    if len(fc) > 3000:
        keep = np.random.default_rng(1).choice(len(fc), 3000, replace=False)
        fc, fn = fc[keep], fn[keep]
    sup_seen = np.zeros(len(E))
    cover = np.zeros((len(E), len(mks)))
    for k, e in enumerate(E):
        facing = fn @ e > 0.1
        if facing.any():
            occl = scene_mesh.ray.intersects_any(fc[facing] + fn[facing] * 0.05, np.tile(e, (int(facing.sum()), 1)))
            sup_seen[k] = float((~occl).sum()) / len(fc)
        for j, mk in enumerate(mks):
            P, N = mk["_P"], mk["_N"]
            f = N @ e > 0.2
            if f.any():
                occl = part.ray.intersects_any(P[f] + N[f] * 0.05, np.tile(e, (int(f.sum()), 1)))
                cover[k, j] = float((~occl).sum()) / len(P)
    w = np.array([np.sqrt(mk["mm2"]) * (2.0 if mk["shows"] else 1.0) for mk in mks])
    w = w / w.sum() if len(w) else w
    sup_n = sup_seen / max(sup_seen.max(), 1e-9)
    val = np.minimum(1.0, cover / 0.6)
    above = np.array([0.05 if el > 0 else 0.0 for _, el in cands])
    picked, best = [], np.zeros(len(mks))
    for i in range(n):
        gain = (np.maximum(0, val - best[None]) * w[None]).sum(1) if len(mks) else np.zeros(len(E))
        score = gain + (0.5 if i == 0 else 0.25) * sup_n + above
        for j in picked:
            score[E @ E[j] > 0.5] = -np.inf
        k = int(np.argmax(score))
        if not np.isfinite(score[k]):
            break
        if i >= 2 and gain[k] < 0.05 and sup_n[k] < 0.35:  # a third that shows nothing the others don't
            break
        picked.append(k)
        if len(mks):
            best = np.maximum(best, val[k])
    return [E[k] for k in picked], [cands[k][1] for k in picked], best


def paint(img, proj, part, raw, raw_shows, raw_up):
    """Paints the marks on a picture of the part: each pixel of the part's surface near a contact point, facing the
    way that contact's face does, red where it shows and blue where it's hidden."""
    if not len(raw):
        return img
    from scipy.spatial import cKDTree
    face = proj["face"]
    hit = face >= 0
    H, W = face.shape
    yy, xx = np.nonzero(hit)
    u = (xx + 0.5 - W / 2) * proj["scale"] + proj["cu"]
    v = (H / 2 - yy - 0.5) * proj["scale"] + proj["cv"]
    loc = (u[:, None] * proj["right"] + v[:, None] * proj["up"] + proj["depth0"] * proj["d"]
           + proj["depth"][yy, xx][:, None] * proj["d"])
    nz = part.face_normals[face[yy, xx]][:, 2]
    dist, idx = cKDTree(raw).query(loc, distance_upper_bound=max(0.35, proj["scale"] * 1.5))
    on = np.isfinite(dist)
    on[on] &= np.where(raw_up[idx[on]], nz[on] < -0.1, nz[on] > 0.1)
    out = img.astype(np.float64)
    for shows, rgb in ((True, COLORS["touch"]), (False, COLORS["touch_hidden"])):
        sel = on.copy()
        sel[on] &= raw_shows[idx[on]] == shows
        px = out[yy[sel], xx[sel]]
        lum = px.mean(1, keepdims=True) / 255.0  # keep the shading under the paint
        out[yy[sel], xx[sel]] = np.clip(np.array(rgb) * 255 * (0.55 + 0.75 * lum), 0, 255)
    return np.clip(out, 0, 255).astype(np.uint8)


def flat_support(img, proj, m, rgb, first):
    """The support's pixels shaded plainly, without the outlines a drawing gives every step of its cells (they'd turn
    a tree's thousands of little faces brown)."""
    face = proj["face"]
    sel = face >= first
    if not sel.any():
        return img
    light = -proj["d"] + 0.6 * proj["up"] - 0.35 * proj["right"]
    light /= np.linalg.norm(light)
    f = face[sel]
    lam = np.abs(m.face_normals[f] @ light)
    out = img.copy()
    out[sel] = (np.clip(rgb[f] * (0.55 + 0.45 * lam[:, None]), 0, 1) * 255).astype(np.uint8)
    return out


LABEL_OFFSETS = [(14, 12), (-14, 12), (14, -12), (-14, -12), (0, 20), (0, -20), (22, 0), (-22, 0), (24, 22), (-24, 22),
                 (24, -22), (-24, -22)]
"""Where a mark's number may sit from it, in points, nearest first."""


def label_offset(x, y, placed, dpi, room=24):
    """The first offset that keeps a mark's number clear of the numbers already placed (in pixels, room apart)."""
    px = dpi / 72
    for dx, dy in LABEL_OFFSETS:
        lx, ly = x + dx * px, y - dy * px
        if all((lx - a) ** 2 + (ly - b) ** 2 >= room ** 2 for a, b in placed):
            placed.append((lx, ly))
            return (dx, dy)
    placed.append((x + 14 * px, y - 12 * px))
    return LABEL_OFFSETS[0]


def sheet(path, title, part, parts, mks, raw, raw_shows, raw_up, width=620, height=500):
    """The pictures: each chosen angle with the supports on (top row) and with them off and their marks painted
    (bottom row), every mark numbered where it's in sight. Answers the angles."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10})
    scene_mesh = trimesh.util.concatenate([m for _, m in parts])
    rgb = np.concatenate([np.tile(COLORS[name], (len(m.faces), 1)) for name, m in parts])
    sup = trimesh.util.concatenate([m for name, m in parts if name in ("support", "interface")])
    eyes, els, cover = pick_views(part, scene_mesh, sup, mks)
    frame = scene_mesh.vertices
    cols = len(eyes)
    dpi = 100
    fig, axs = plt.subplots(2, cols, figsize=(width * cols / dpi, height * 2 / dpi + 0.45), dpi=dpi, squeeze=False)
    part_rgb = np.tile(COLORS["part"], (len(part.faces), 1))
    for c, e in enumerate(eyes):
        img, proj = geom.render(scene_mesh, list(-e), width=width, height=height, face_rgb=rgb, frame=frame, margin=0.05)
        axs[0, c].imshow(flat_support(img, proj, scene_mesh, rgb, len(part.faces)))
        img, proj = geom.render(part, list(-e), width=width, height=height, face_rgb=part_rgb, frame=frame, margin=0.05)
        axs[1, c].imshow(paint(img, proj, part, raw, raw_shows, raw_up))
        placed = []
        for mk in mks:
            P, N = mk["_P"], mk["_N"]
            f = N @ e > 0.2
            if not f.any():
                continue
            seen = f.copy()
            seen[f] = ~part.ray.intersects_any(P[f] + N[f] * 0.05, np.tile(e, (int(f.sum()), 1)))
            if seen.mean() < 0.15:
                continue
            x, y, _ = geom.to_pixel(proj, P[seen].mean(0))
            off = label_offset(x, y, placed, dpi)
            col = COLORS["touch"] if mk["shows"] else COLORS["touch_hidden"]
            axs[1, c].annotate(str(mk["zone"]), (x, y), xytext=off, textcoords="offset points", fontsize=11,
                               fontweight="bold", color="white", ha="center", va="center",
                               bbox={"boxstyle": "circle,pad=0.25", "fc": col, "ec": "white", "lw": 1.2},
                               arrowprops={"arrowstyle": "-", "color": col, "lw": 1.2})
        for ax in axs[:, c]:
            ax.axis("off")
    fig.suptitle(title, fontsize=13, fontweight="bold", x=0.01, ha="left")
    if mks:
        from matplotlib.lines import Line2D
        dot = lambda col, label: Line2D([], [], marker="o", ls="", ms=9, mfc=col, mec="white", label=label)
        fig.legend(handles=[dot(COLORS["touch"], "shows"), dot(COLORS["touch_hidden"], "hidden")], loc="upper right",
                   ncol=2, frameon=False, fontsize=11, bbox_to_anchor=(0.995, 0.995))
    fig.tight_layout(rect=(0, 0, 1, 0.965), pad=0.3, h_pad=0.2, w_pad=0.2)
    fig.savefig(path, dpi=dpi)
    plt.close(fig)
    return [{"looking_from": [r(v, 2) for v in e], "elevation": el} for e, el in zip(eyes, els)], cover


def usda(parts, path):
    """A plain USD stage: one Mesh per part, each bound to its own UsdPreviewSurface colour (Quick Look reads those).
    Y up, as Quick Look and AR expect, and centred on the part so it turns about its middle."""
    lo, hi = parts[0][1].bounds
    mid = np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]])
    yup = lambda p: np.stack([p[:, 0], p[:, 2], -p[:, 1]], 1)
    L = ['#usda 1.0', '(', '    defaultPrim = "Plate"', '    metersPerUnit = 0.001', '    upAxis = "Y"', ')', '',
         'def Xform "Plate"', '{']
    for name, m in parts:
        r, g, b = COLORS[name]
        pts = ", ".join(f"({x:.3f}, {y:.3f}, {z:.3f})" for x, y, z in yup(m.vertices - mid))
        idx = ", ".join(str(int(i)) for i in m.faces.reshape(-1))
        counts = ", ".join("3" for _ in range(len(m.faces)))
        if name in ("support", "interface"):  # cells: flat faces
            nrm = ", ".join(f"({x:.3f}, {y:.3f}, {z:.3f})" for x, y, z in yup(m.face_normals))
            nline = ['        normal3f[] normals = [' + nrm + '] (', '            interpolation = "uniform"', '        )']
        else:  # smooth within a face's crease
            nrm = ", ".join(f"({x:.3f}, {y:.3f}, {z:.3f})" for x, y, z in yup(m.vertex_normals))
            nline = ['        normal3f[] normals = [' + nrm + '] (', '            interpolation = "vertex"', '        )']
        L += [f'    def Mesh "{name}" (', '        prepend apiSchemas = ["MaterialBindingAPI"]', '    )', '    {',
              f'        int[] faceVertexCounts = [{counts}]', f'        int[] faceVertexIndices = [{idx}]',
              f'        point3f[] points = [{pts}]', *nline, '        uniform token subdivisionScheme = "none"',
              '        uniform token orientation = "rightHanded"',
              f'        rel material:binding = </Plate/Looks/{name}>', '    }']
    L += ['    def Scope "Looks"', '    {']
    for name, _ in parts:
        r, g, b = COLORS[name]
        L += [f'        def Material "{name}"', '        {',
              f'            token outputs:surface.connect = </Plate/Looks/{name}/Surface.outputs:surface>',
              '            def Shader "Surface"', '            {', '                uniform token info:id = "UsdPreviewSurface"',
              f'                color3f inputs:diffuseColor = ({r}, {g}, {b})',
              f'                float inputs:roughness = {0.75 if name == "part" else 0.55}',
              '                token outputs:surface', '            }', '        }']
    L += ['    }', '}', '']
    with open(path, "w") as f:
        f.write("\n".join(L))


def colour_3mf(path, names):
    """Give each object of a 3MF trimesh wrote its colour, as a core-spec base material (trimesh writes none)."""
    import re
    import shutil
    with zipfile.ZipFile(path) as z:
        items = {n: z.read(n) for n in z.namelist()}
    key = "3D/3dmodel.model"
    x = items[key].decode()
    hexes = {n: "#%02X%02X%02XFF" % tuple(int(c * 255) for c in COLORS[n]) for n in names}
    mats = '<basematerials id="900">' + "".join(f'<base name="{n}" displaycolor="{hexes[n]}"/>' for n in names) + "</basematerials>"
    x = x.replace("<resources>", "<resources>" + mats, 1)
    for i, n in enumerate(names):
        x = re.sub(rf'(<object [^>]*name="{n}")', rf'\1 pid="900" pindex="{i}"', x, count=1)
    items[key] = x.encode()
    tmp = path + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for n, b in items.items():
            z.writestr(n, b)
    shutil.move(tmp, path)


def op_support_model(job):
    path = job["file"]
    text, number, _ = supports.plate_text(path, job.get("plate"))
    S = supports.parse(text)
    L = np.hypot(S["x1"] - S["x0"], S["y1"] - S["y0"])
    keep = L > 1e-6
    model_i = np.nonzero(keep & (S["kind"] == 0))[0]
    sup_i = np.nonzero(keep & (S["kind"] == 1))[0]
    if not len(sup_i):
        raise ValueError("this plate has no support")
    iface_f = np.array(["interface" in n.lower() for n in S["names"]])
    is_if = iface_f[S["fid"][sup_i]]
    part = plate_model(path, S, model_i)
    if part is None:
        part = beads(S, model_i)
    part = trimesh.graph.smooth_shade(part, angle=np.radians(25))  # sharp edges stay sharp
    parts = [("part", part)]
    for name, sel in (("support", sup_i[~is_if]), ("interface", sup_i[is_if])):
        m = beads(S, sel) if len(sel) else None
        if m is not None:
            parts.append((name, m))
    A = supports.analyse(path, job.get("plate"))
    mks, raw, raw_shows, raw_up = marks(part, A, job.get("hidden"))
    unknown = {str(h).strip().upper() for h in job.get("hidden") or ()} - {str(mk["zone"]) for mk in mks}
    if unknown:
        raise ValueError(f"no mark {', '.join(sorted(unknown))} on this plate: its marks are "
                         f"{', '.join(str(mk['zone']) for mk in mks) or 'none'}")
    shot = None
    if job.get("sheet"):
        if job.get("progress_file"):
            with open(job["progress_file"], "a") as f:
                f.write("Picturing it from the angles that show the supports\n")
        shot, _ = sheet(job["sheet"], job.get("title") or os.path.basename(path), part, parts, mks, raw, raw_shows, raw_up)
    radius = float(np.clip(0.03 * np.linalg.norm(part.extents), 0.8, 2.5))
    for name, mk in zip(("touch", "touch_hidden"), markers(mks, radius)):
        if mk is not None:
            parts.append((name, mk))
    base = job["out"]
    usda(parts, base + ".usda")
    subprocess.run(["/usr/bin/usdzip", os.path.basename(base) + ".usdz", os.path.basename(base) + ".usda"], check=True,
                   capture_output=True, cwd=os.path.dirname(os.path.abspath(base)))
    scene = trimesh.Scene()
    for name, m in parts:
        m = m.copy()
        m.visual = trimesh.visual.ColorVisuals(m, face_colors=[int(c * 255) for c in COLORS[name]] + [255])
        scene.add_geometry(m, node_name=name, geom_name=name)
    scene.export(base + ".3mf")
    colour_3mf(base + ".3mf", [n for n, _ in parts])
    os.remove(base + ".usda")
    gaps = {z["zone"]: z["gap"]["median"] for z in A.get("zones") or []}
    for mk in mks:
        for k in ("_P", "_N", "_o"):
            mk.pop(k)
        if mk["where"] == "under":
            mk["gap"] = gaps.get(mk["zone"])
    return {"ok": True, "plate": number, "usdz": base + ".usdz", "3mf": base + ".3mf", "sheet": job.get("sheet") if shot else None,
            "views": shot, "marks": mks, "triangles": {n: int(len(m.faces)) for n, m in parts}, "words": mark_words(mks)}


def mark_words(mks):
    """A line for the marks, and one for each."""
    if not mks:
        return ["The support touches the part nowhere: it only stands on the bed."]
    shows = [mk for mk in mks if mk["shows"]]
    head = (f"{len(mks)} place{'s' if len(mks) != 1 else ''} where the support meets the part: "
            + (f"{len(shows)} on a face that shows (red)" if shows else "none on a face that shows")
            + (f", {len(mks) - len(shows)} hidden (blue)" if len(mks) > len(shows) else "") + ".")
    lines = [head]
    for mk in mks:
        what = "under the part" if mk["where"] == "under" else "standing on the part's top"
        seen = ("shows" if mk["shows_share"] >= 0.95 else f"shows ({int(round(mk['shows_share'] * 100))}% of it)") if mk["shows"] else (
            "hidden, as you said" if mk["said_hidden"] else "hidden" if mk["shows_share"] <= 0.05
            else f"hidden ({int(round((1 - mk['shows_share']) * 100))}% of it)")
        wall = f", {mk['wall']:g} mm of part behind it" if mk["wall"] is not None else ""
        thin = " (thin: it can tear coming off)" if mk["thin"] else ""
        x, y, z = mk["at"]
        lines.append(f"  {mk['zone']}: {mk['mm2']:g} mm² {what} at x {x:g}, y {y:g}, z {z:g}: {seen}{wall}{thin}")
    return lines
