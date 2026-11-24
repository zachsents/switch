#!/usr/bin/env python3
"""fea's engine: one case from a part to numbers, run on the box in its venv (gmsh, numpy, scipy, matplotlib,
trimesh, rtree). Millimetres, newtons and MPa throughout.

  engine.py run CASE_DIR                  # case.json there -> mesh, CalculiX deck, solve, result.json, pictures
  engine.py compare OUT_DIR CASE_DIR...   # the study's table and chart: compare.json, compare.png
  engine.py selftest DIR                  # a cantilever against beam theory and a rod squeezed in a bore against
                                          # elasticity, through the whole pipeline

A case folder holds case.json ({name, part, material, mesh, load, threads, keep_frd}) and the part file. run
writes progress.json as it goes ({stage, fraction}), then result.json ({ok: true, ...} or {ok: false, error}),
keeping job.inp, job.dat, job.sta and ccx.log; job.frd goes once it's read, unless keep_frd.

Loads (case.json's load, already checked by the appendage's spec.py):
  press  {fix, move, direction: "-z" | [x,y,z], travel, rigid?, steps?, nonlinear?, at?}
         the move region is pushed `travel` along direction while fix holds: force against displacement.
  bore   {diameter, axis: x|y|z, center?, span?, fix?, friction?, slide?, from_end?, entry_radius?, pull?, at?}
         the part goes into a rigid round hole: squeezed radially from its own outside down to the diameter
         (push = friction x the radial force), or with slide the hole slides on along the axis.
  pin    the same, a rigid pin growing inside the part's hole up to the diameter.
Selectors: {side: "-z", depth}, {box: {x: [lo, hi], y: .., z: ..}}, {near: [x,y,z], radius},
  {cylinder: {axis, center, r: [lo, hi], s: [lo, hi]}}, {all: [..]}, {any: [..]}, {not: sel}; surface: false
  takes interior nodes too (default: boundary nodes only).
"""

import json
import math
import os
import re
import shutil
import subprocess
import sys
import time

import numpy as np

AX = {"x": 0, "y": 1, "z": 2}
# gmsh's 10-node tetrahedron to CalculiX's C3D10: gmsh numbers the edge nodes (0,1) (1,2) (2,0) (3,0) (3,2) (3,1),
# CalculiX (0,1) (1,2) (2,0) (0,3) (1,3) (2,3)
GMSH_TO_CCX = [0, 1, 2, 3, 4, 5, 6, 7, 9, 8]
EDGES = [(0, 1), (1, 2), (2, 0), (0, 3), (1, 3), (2, 3)]
FLIP = [0, 2, 1, 3, 6, 5, 4, 7, 9, 8]  # corners 1 and 2 swapped, with their edges
# C3D10 faces (S1..S4) by corner, with the edge nodes on each
FACES = [(0, 1, 2), (0, 3, 1), (1, 3, 2), (2, 3, 0)]
FACE_MIDS = [(4, 5, 6), (7, 8, 4), (8, 9, 5), (9, 7, 6)]
HEX_FACES = [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]


class CaseError(Exception):
    """What's wrong with a case, in words for whoever asked."""


def read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, data):
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1, default=lambda o: o.tolist() if hasattr(o, "tolist") else str(o))
    os.replace(tmp, path)


class Progress:
    def __init__(self, folder):
        self.path = os.path.join(folder, "progress.json")
        self.t0 = time.time()

    def __call__(self, stage, fraction=None, **more):
        write_json(self.path, dict(stage=stage, fraction=fraction, elapsed_s=round(time.time() - self.t0, 1), **more))


# ---------------------------------------------------------------------------------------------
# The part: cleaned, measured, meshed


def load_part(path, body=None, warnings=None):
    """The part as one clean watertight trimesh: its vertices merged, degenerate faces gone, normals out. A file
    holding several bodies takes `body` (0 the largest by volume) or fails, saying what's there."""
    import trimesh
    m = trimesh.load(path, force="mesh", process=True)
    if m.is_empty or len(m.faces) == 0:
        raise CaseError(f"{os.path.basename(path)} holds no triangles")
    m.merge_vertices()
    for fn in ("nondegenerate_faces", "unique_faces"):
        if hasattr(m, fn):
            m.update_faces(getattr(m, fn)())
    m.remove_unreferenced_vertices()
    bodies = m.split(only_watertight=False)
    if len(bodies) > 1:
        bodies = sorted(bodies, key=lambda b: -abs(b.volume))
        if body is None:
            listing = "; ".join(f"{i}: {abs(b.volume):.0f} mm³ at {np.round(b.bounds.mean(0), 1).tolist()}"
                                for i, b in enumerate(bodies[:8]))
            raise CaseError(f"{os.path.basename(path)} holds {len(bodies)} separate bodies ({listing}): give one part "
                            "per file, or mesh.body to pick one (0 is the largest)")
        if body >= len(bodies):
            raise CaseError(f"mesh.body {body}: the file has only {len(bodies)} bodies")
        m = bodies[body]
    if not m.is_watertight:
        trimesh.repair.fill_holes(m)
        if not m.is_watertight and warnings is not None:
            warnings.append("the part isn't watertight even after filling holes: meshing may fail or leak")
    trimesh.repair.fix_normals(m)
    if m.volume < 0:
        m.invert()
    return m


def thickness_samples(m, n=12000, seed=1):
    """How much room the mesh has at points spread over the surface: the smaller of the wall's thickness (along
    the inward normal to the opposite wall) and the gap outside it (along the outward normal to the next face,
    where two ribs or a slot's walls face each other). Returns (points, room, thickness)."""
    import trimesh
    count = min(n, max(500, len(m.faces) * 2))
    pts, fi = trimesh.sample.sample_surface_even(m, count, seed=seed)
    if len(pts) < 50:
        pts, fi = trimesh.sample.sample_surface(m, count)
    normals = m.face_normals[fi]

    def reach(sign):
        origins = pts + sign * normals * 1e-3
        locs, idx, _ = m.ray.intersects_location(origins, sign * normals, multiple_hits=False)
        out = np.full(len(pts), np.inf)
        if len(idx):
            out[idx] = np.linalg.norm(locs - origins[idx], axis=1)
        return out
    thick, gap = reach(-1.0), reach(1.0)
    room = np.minimum(thick, gap)
    ok = np.isfinite(room) & (room > 1e-3)
    return pts[ok], room[ok], thick[ok]


def mesh_part(case, folder, progress, warnings):
    """Tetrahedra for the part (C3D10, CalculiX's numbering): (nodes Nx3, elements Mx10, info). Sizes follow the
    local wall thickness (mesh.per_wall elements across a wall, default 2) between mesh.min and mesh.max, unless
    mesh.size fixes one size; when the count passes mesh.budget (default 150k) it meshes again coarser."""
    import gmsh
    from scipy.spatial import cKDTree
    spec = case.get("mesh") or {}
    part = os.path.join(folder, case["part"])
    ext = os.path.splitext(part)[1].lower()
    progress("meshing", 0.0)
    info = {"method": None}
    cad = ext in (".step", ".stp", ".brep")
    if cad:
        m = None
        thick_pts = thick = None
    else:
        m = load_part(part, spec.get("body"), warnings)
        clean = os.path.join(folder, "part-clean.stl")
        m.export(clean)
        info["part_volume_mm3"] = round(float(m.volume), 2)
        thick_pts, thick, walls = thickness_samples(m)
        walls = walls[np.isfinite(walls)]
        if len(walls):
            info["wall_mm"] = {"p5": round(float(np.percentile(walls, 5)), 3), "median": round(float(np.median(walls)), 3)}
        if len(thick):
            info["room_mm_p5"] = round(float(np.percentile(thick, 5)), 3)
    diag = float(np.linalg.norm(m.bounds[1] - m.bounds[0])) if m is not None else None
    per_wall = float(spec.get("per_wall") or 2.0)
    fixed = spec.get("size")
    if fixed:
        hmin = hmax = float(fixed)
    else:
        p5 = info.get("room_mm_p5") or (diag / 40 if diag else 1.0)
        hmin = float(spec.get("min") or max(0.15, min(p5 / per_wall, 2.0)))
        hmax = float(spec.get("max") or max(hmin * 4, (diag or 40) / 15))
    budget = int(spec.get("budget") or 150_000)
    tree = cKDTree(thick_pts) if thick is not None and len(thick) else None

    spacing = float(np.median(tree.query(thick_pts, k=2)[0][:, 1])) if tree is not None else 0.0
    # gmsh splits the STL into faces at its sharp edges and meshes each again; where that overlaps itself (a narrow
    # gap meshed too coarse) it's tried finer, then split at other angles, before the STL's own triangles
    tries = [(1.0, 40), (0.8, 40), (1.0, 30), (0.8, 30), (1.0, 55), (0.65, 40)] if not cad else [(1.0, 40)]
    scale, method, X, T = 1.0, None, None, None
    failures = []
    for size_f, angle in tries:
        lo, hi = hmin * size_f, hmax * size_f
        try:
            X, T, method = mesh_once(gmsh, part, None if cad else clean, cad, lo, hi, case, tree, thick, per_wall,
                                     size_f, fixed, spacing, angle)
            break
        except Exception as e:  # gmsh raises plain Exceptions with its own words
            failures.append(f"{size_f:g}x at {angle} deg: {first_line(e)}")
            if cad:
                raise CaseError(f"gmsh couldn't mesh the part: {first_line(e)}")
    if X is None:
        warnings.append("meshing the part's surface again failed every way (" + "; ".join(failures[:3]) +
                        "): meshing its own triangles instead")
        X, T, method = mesh_stl_as_is(gmsh, clean, hmin, hmax, case)
        size_f, angle = 1.0, None
    elif failures:
        info["mesh_retries"] = failures
    lo, hi = hmin * size_f, hmax * size_f
    for _ in range(3):
        n = len(T)
        progress("meshing", 0.9, elements=n)
        if n <= budget or fixed or angle is None:
            break
        factor = (n / budget) ** (1 / 3) * 1.08
        warnings.append(f"{n} elements is over the budget of {budget}: meshing {factor:.2f}x coarser")
        size_f *= factor
        lo, hi = hmin * size_f, hmax * size_f
        try:
            X, T, method = mesh_once(gmsh, part, None if cad else clean, cad, lo, hi, case, tree, thick, per_wall,
                                     size_f, fixed, spacing, angle)
        except Exception as e:
            size_f /= factor
            lo, hi = hmin * size_f, hmax * size_f
            warnings.append(f"meshing it coarser failed ({first_line(e)})")
            break
    if len(T) > budget * 1.25 and not fixed and angle is not None:
        # the budget is what the case's memory and time were sized for: far past it, the solve can't fit, so stop now
        raise CaseError(f"its mesh stayed at {len(T)} elements, over its budget of {budget}: set mesh.min or "
                        "mesh.size coarser, or a larger mesh.budget on a bigger box")
    if len(T) == 0:
        raise CaseError("gmsh made no tetrahedra (is the part closed?)")
    T = orient(X, T, warnings)
    X, straightened = straighten(X, T)
    if straightened:
        info["straightened"] = straightened
    vol = float(tet_volumes(X, T).sum())
    info.update(method=method, nodes=int(len(X)), elements=int(len(T)), size_min=round(lo, 3), size_max=round(hi, 3),
                volume_mm3=round(vol, 2))
    if info.get("part_volume_mm3"):
        err = vol / info["part_volume_mm3"] - 1
        info["volume_error"] = round(err, 4)
        if abs(err) > 0.03:
            warnings.append(f"the mesh's volume is {err * 100:+.1f}% off the part's: features smaller than "
                            f"{lo:.2f} mm may be lost (set mesh.min smaller)")
    return X, T, info


def mesh_once(gmsh, part, clean, cad, lo, hi, case, tree, thick, per_wall, scale, fixed, spacing=0.0, angle=40):
    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.option.setNumber("General.NumThreads", int(case.get("threads") or 2))
        gmsh.model.add("part")
        method = geometry(gmsh, part, clean, cad, angle)
        gmsh.option.setNumber("Mesh.MeshSizeMin", lo)
        gmsh.option.setNumber("Mesh.MeshSizeMax", hi)
        gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 1)
        gmsh.option.setNumber("Mesh.MeshSizeFromPoints", 0)
        gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 0)
        if tree is not None and not fixed:
            def size_at(dim, tag, x, y, z, lc):
                # the room at the nearest surface sample, across per_wall elements; deep inside (further than the
                # samples' own spacing from any) the elements grow with the distance
                d, i = tree.query((x, y, z))
                return float(min(hi, max(lo, thick[i] / per_wall * scale, (d - 2 * spacing) * 0.5)))
            gmsh.model.mesh.setSizeCallback(size_at)
        gmsh.option.setNumber("Mesh.Algorithm", 6)
        gmsh.option.setNumber("Mesh.Algorithm3D", 1)
        gmsh.option.setNumber("Mesh.Optimize", 1)
        gmsh.option.setNumber("Mesh.ElementOrder", 2)
        # edge nodes on the surface itself, not on the straight chord: a fit's interference is a tenth of a mm, and
        # straight-sided elements shave a curved face by about h^2/8R (0.016 mm at 0.8 mm on a 5 mm radius). The few
        # elements curving folds are straightened afterwards (straighten), quicker than gmsh's own optimizer
        gmsh.option.setNumber("Mesh.SecondOrderLinear", 0)
        gmsh.option.setNumber("Mesh.HighOrderOptimize", 0)
        gmsh.model.mesh.generate(3)
        X, T = extract(gmsh)
        if not len(T):
            raise RuntimeError("no tetrahedra")
        return X, T, method
    finally:
        gmsh.finalize()


def first_line(e):
    s = str(e).strip().splitlines()
    return s[0][:300] if s else type(e).__name__


def geometry(gmsh, part, clean, cad, angle=40):
    """The part's geometry in gmsh: a CAD file as it is, or an STL's surface split at its sharp edges and
    reparametrized, so it's meshed again at the sizes asked for."""
    if cad:
        gmsh.model.occ.importShapes(part)
        gmsh.model.occ.synchronize()
        return "cad"
    gmsh.merge(clean)
    gmsh.model.mesh.classifySurfaces(angle * math.pi / 180, True, True, math.pi)
    gmsh.model.mesh.createGeometry()
    surfaces = [s[1] for s in gmsh.model.getEntities(2)]
    loop = gmsh.model.geo.addSurfaceLoop(surfaces)
    gmsh.model.geo.addVolume([loop])
    gmsh.model.geo.synchronize()
    return "remeshed"


def mesh_stl_as_is(gmsh, clean, lo, hi, case):
    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add("stl")
        gmsh.merge(clean)
        surfaces = [s[1] for s in gmsh.model.getEntities(2)]
        loop = gmsh.model.geo.addSurfaceLoop(surfaces)
        gmsh.model.geo.addVolume([loop])
        gmsh.model.geo.synchronize()
        gmsh.option.setNumber("Mesh.MeshSizeMin", lo)
        gmsh.option.setNumber("Mesh.MeshSizeMax", hi)
        gmsh.option.setNumber("Mesh.Algorithm3D", 1)
        gmsh.option.setNumber("Mesh.Optimize", 1)
        gmsh.option.setNumber("Mesh.ElementOrder", 2)
        gmsh.option.setNumber("Mesh.SecondOrderLinear", 1)
        gmsh.model.mesh.generate(3)
        X, T = extract(gmsh)
    except Exception as e:
        raise CaseError(f"gmsh couldn't mesh the part, remeshed or as it is: {first_line(e)}")
    finally:
        gmsh.finalize()
    flat = np.abs(tet_volumes(X, T)) < 1e-6 * max(lo, 1e-3) ** 3
    if flat.any():
        raise CaseError(f"meshing the STL's own triangles left {int(flat.sum())} flat elements (its triangles are too "
                        "long and thin): export it finer, or as STEP")
    return X, T, "stl"


def extract(gmsh):
    """The 10-node tetrahedra gmsh made, renumbered from 0 over the nodes they use, in CalculiX's order."""
    tags, coords, _ = gmsh.model.mesh.getNodes()
    coords = coords.reshape(-1, 3)
    etypes, _, enodes = gmsh.model.mesh.getElements(3)
    conn = None
    for et, en in zip(etypes, enodes):
        if et == 11:
            conn = np.asarray(en, dtype=np.int64).reshape(-1, 10)
        elif et == 4:
            raise RuntimeError("gmsh made linear tetrahedra where quadratic ones were asked for")
    if conn is None:
        return np.zeros((0, 3)), np.zeros((0, 10), dtype=np.int64)
    pos = np.full(int(tags.max()) + 1, -1, dtype=np.int64)
    pos[tags.astype(np.int64)] = np.arange(len(tags))
    conn = pos[conn]
    used = np.unique(conn)
    renum = np.full(len(tags), -1, dtype=np.int64)
    renum[used] = np.arange(len(used))
    X = coords[used]
    T = renum[conn][:, GMSH_TO_CCX]
    check_edges(X, T)
    return X, T


def check_edges(X, T):
    """Every edge node where CalculiX expects it: near the middle of its two corners."""
    if not len(T):
        return
    sample = T[:: max(1, len(T) // 2000)]
    for k, (a, b) in enumerate(EDGES):
        mid = (X[sample[:, a]] + X[sample[:, b]]) / 2
        length = np.linalg.norm(X[sample[:, a]] - X[sample[:, b]], axis=1)
        off = np.linalg.norm(X[sample[:, 4 + k]] - mid, axis=1)
        if np.median(off / np.maximum(length, 1e-12)) > 0.2:
            raise RuntimeError(f"edge node {5 + k} isn't between corners {a + 1} and {b + 1}: the node order is wrong")


def tet_volumes(X, T):
    a, b, c, d = (X[T[:, i]] for i in range(4))
    return np.einsum("ij,ij->i", np.cross(b - a, c - a), d - a) / 6.0


def orient(X, T, warnings):
    v = tet_volumes(X, T)
    neg = v < 0
    if neg.any():
        T = T.copy()
        T[neg] = T[neg][:, FLIP]
    if (np.abs(v) < 1e-12).any():
        warnings.append(f"{int((np.abs(v) < 1e-12).sum())} elements have no volume")
    return T


GAUSS_A, GAUSS_B = 0.5854101966249685, 0.1381966011250105
JAC_POINTS = ([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1], [0.25] * 4]
              + [[GAUSS_A if i == k else GAUSS_B for i in range(4)] for k in range(4)])
DL = np.array([[-1.0, -1.0, -1.0], [1.0, 0, 0], [0, 1.0, 0], [0, 0, 1.0]])


def jacobians(X, T, rows=None):
    """Each 10-node tetrahedron's smallest Jacobian determinant over its corners, centre and integration points
    (where CalculiX checks it)."""
    E = T if rows is None else T[rows]
    out = None
    for L in JAC_POINTS:
        dN = np.zeros((10, 3))
        for i in range(4):
            dN[i] = (4 * L[i] - 1) * DL[i]
        for k, (i, j) in enumerate(EDGES):
            dN[4 + k] = 4 * (L[i] * DL[j] + L[j] * DL[i])
        J = np.einsum("mna,nb->mab", X[E], dN)
        d = np.linalg.det(J)
        out = d if out is None else np.minimum(out, d)
    return out


def straighten(X, T, passes=6):
    """Moves the edge nodes of every element its curved edges fold (a Jacobian at or below zero) back onto the
    straight chord, until none is folded: (nodes, how many elements it straightened)."""
    X = X.copy()
    vol = np.abs(tet_volumes(X, T))
    done = np.zeros(len(T), bool)
    for _ in range(passes):
        bad = jacobians(X, T) <= 1e-3 * vol
        if not bad.any():
            break
        done |= bad
        for k, (a, b) in enumerate(EDGES):
            X[T[bad, 4 + k]] = (X[T[bad, a]] + X[T[bad, b]]) / 2
    return X, int(done.sum())


def boundary_faces(T):
    """The faces on the part's outside: (element index, face index 0..3) for each."""
    corners = np.sort(np.stack([T[:, list(f)] for f in FACES], axis=1), axis=2)  # M x 4 x 3
    flat = corners.reshape(-1, 3)
    _, inv, counts = np.unique(flat, axis=0, return_inverse=True, return_counts=True)
    once = counts[inv.reshape(-1)] == 1
    idx = np.nonzero(once)[0]
    return idx // 4, idx % 4


def face_nodes(T, elems, faces, with_mids=True):
    cols = [list(FACES[f]) + (list(FACE_MIDS[f]) if with_mids else []) for f in range(4)]
    out = np.zeros((len(elems), 6 if with_mids else 3), dtype=np.int64)
    for f in range(4):
        sel = faces == f
        out[sel] = T[elems[sel]][:, cols[f]]
    return out


# ---------------------------------------------------------------------------------------------
# Choosing nodes


def parse_side(side):
    m = re.fullmatch(r"([+-]?)([xyz])", str(side).strip().lower())
    if not m:
        raise CaseError(f"side {side!r}: say +x, -x, +y, -y, +z or -z")
    return AX[m.group(2)], -1 if m.group(1) == "-" else 1


def unit(direction):
    if isinstance(direction, str):
        ax, sign = parse_side(direction)
        v = np.zeros(3)
        v[ax] = sign
        return v
    v = np.asarray(direction, dtype=float)
    n = np.linalg.norm(v)
    if v.shape != (3,) or n == 0:
        raise CaseError(f"direction {direction!r}: an axis like -z or a vector [x, y, z]")
    return v / n


def select(sel, X, lo, hi):
    """Which nodes a selector takes (a boolean mask), by their coordinates in the part's own frame."""
    if not isinstance(sel, dict):
        raise CaseError(f"selector {sel!r}: an object like {{side: '-z', depth: 0.5}}")
    masks = []
    if "all" in sel:
        masks.append(np.logical_and.reduce([select(s, X, lo, hi) for s in sel["all"]]))
    if "any" in sel:
        masks.append(np.logical_or.reduce([select(s, X, lo, hi) for s in sel["any"]]))
    if "not" in sel:
        masks.append(~select(sel["not"], X, lo, hi))
    if "side" in sel:
        ax, sign = parse_side(sel["side"])
        depth = float(sel.get("depth", 0.5))
        masks.append(X[:, ax] <= lo[ax] + depth if sign < 0 else X[:, ax] >= hi[ax] - depth)
    if "box" in sel:
        m = np.ones(len(X), bool)
        for k, rng in sel["box"].items():
            ax = AX[k]
            a, b = (rng + [None, None])[:2] if isinstance(rng, list) else (None, None)
            if a is not None:
                m &= X[:, ax] >= float(a)
            if b is not None:
                m &= X[:, ax] <= float(b)
        masks.append(m)
    if "near" in sel:
        p = np.asarray(sel["near"], dtype=float)
        masks.append(np.linalg.norm(X - p, axis=1) <= float(sel.get("radius", 1.0)))
    if "cylinder" in sel:
        c = sel["cylinder"]
        ax = AX[c.get("axis", "z")]
        center = np.asarray(c.get("center") or ((lo + hi) / 2), dtype=float)
        r, s = radial(X, ax, center)
        m = np.ones(len(X), bool)
        for vals, key in ((r, "r"), (s, "s")):
            rng = c.get(key)
            if rng:
                if rng[0] is not None:
                    m &= vals >= float(rng[0])
                if rng[1] is not None:
                    m &= vals <= float(rng[1])
        masks.append(m)
    if not masks:
        raise CaseError(f"selector {sel!r} names nothing to select by (side, box, near, cylinder, all, any, not)")
    return np.logical_and.reduce(masks)


def radial(X, ax, center):
    others = [i for i in range(3) if i != ax]
    d = X[:, others] - np.asarray(center, dtype=float)[others]
    return np.hypot(d[:, 0], d[:, 1]), X[:, ax] - float(np.asarray(center, dtype=float)[ax])


def node_set(sel, X, lo, hi, surface_mask):
    mask = select(sel, X, lo, hi)
    if sel.get("surface", True):
        mask &= surface_mask
    return np.nonzero(mask)[0]


# ---------------------------------------------------------------------------------------------
# Materials


def material_cards(mat):
    E, nu = float(mat["E"]), float(mat["nu"])
    lines = ["*MATERIAL, NAME=PART"]
    if mat.get("model") == "neo-hooke":
        G, K = E / (2 * (1 + nu)), E / (3 * (1 - 2 * nu))
        lines += ["*HYPERELASTIC, NEO HOOKE", f"{G / 2:.6g}, {2 / K:.6g}"]
    else:
        lines += ["*ELASTIC", f"{E:.6g}, {nu:.6g}"]
    return lines


# ---------------------------------------------------------------------------------------------
# The CalculiX deck


def fmt_nodes(ids, X):
    return "\n".join(f"{i},{x:.6f},{y:.6f},{z:.6f}" for i, (x, y, z) in zip(ids, X))


def fmt_elems(ids, T):
    return "\n".join(f"{e}," + ",".join(str(n) for n in row) for e, row in zip(ids, T))


def fmt_set(name, ids):
    ids = list(ids)
    rows = [",".join(str(i) for i in ids[k:k + 16]) for k in range(0, len(ids), 16)]
    return f"*NSET, NSET={name}\n" + "\n".join(rows)


def ring_profile(load, R_end, s_lo, s_hi, h):
    """The rigid wall's generatrix: (r, s) points along it, the wall's inner surface. Squeezing, a straight
    cylinder over the span; sliding, a tube at the final radius whose entry end is rounded (entry_radius) and
    flared outward (a bore) or inward (a pin), placed just clear of the part."""
    if not load.get("slide"):
        n = max(2, int(math.ceil((s_hi - s_lo) / max(h, 0.5))) + 1)
        return [(R_end, s) for s in np.linspace(s_lo, s_hi, n)]
    Re = float(load.get("entry_radius", 0.5))
    out = 1 if load["type"] == "bore" else -1  # which way the lip curls: away from the part
    pts = []
    for ang in np.linspace(0, math.pi / 2, 9):
        pts.append((R_end + out * Re * (1 - math.cos(ang)), -Re * (1 - math.sin(ang))))  # s from the lip: 0 at top
    return pts


def ring(axis, center, profile, ntheta, thickness=1.0, outward=1):
    """A wall of hexahedra (C3D8) swept around the axis: (nodes, elements, inner-face (element, face) pairs,
    inner node indices). The inner layer lies on the profile; the outer one `thickness` further out (or in)."""
    others = [i for i in range(3) if i != axis]
    th = np.linspace(0, 2 * math.pi, ntheta, endpoint=False)
    nodes = []
    P = len(profile)
    for layer in (0, 1):
        for (r, s) in profile:
            rr = r + (thickness * outward if layer else 0.0)
            pts = np.zeros((ntheta, 3))
            pts[:, others[0]] = center[others[0]] + rr * np.cos(th)
            pts[:, others[1]] = center[others[1]] + rr * np.sin(th)
            pts[:, axis] = center[axis] + s
            nodes.append(pts)
    nodes = np.vstack(nodes)

    def nid(layer, k, j):
        return (layer * P + k) * ntheta + (j % ntheta)

    elems, inner_faces = [], []
    for k in range(P - 1):
        for j in range(ntheta):
            e = [nid(0, k, j), nid(0, k, j + 1), nid(1, k, j + 1), nid(1, k, j),
                 nid(0, k + 1, j), nid(0, k + 1, j + 1), nid(1, k + 1, j + 1), nid(1, k + 1, j)]
            elems.append(e)
    E = np.array(elems, dtype=np.int64)
    # positive volume: the hexahedron's bottom face wound so its normal points to the top
    a, b, d, top = nodes[E[:, 0]], nodes[E[:, 1]], nodes[E[:, 3]], nodes[E[:, 4]]
    neg = np.einsum("ij,ij->i", np.cross(b - a, d - a), top - a) < 0
    E[neg] = E[neg][:, [0, 3, 2, 1, 4, 7, 6, 5]]
    inner = set(range(P * ntheta))
    for ei, e in enumerate(E):
        for fi, f in enumerate(HEX_FACES):
            if all(e[x] in inner for x in f):
                inner_faces.append((ei, fi))
                break
    return nodes, E, inner_faces, np.arange(P * ntheta)


def frames(n):
    return [round((k + 1) / n, 6) for k in range(n)]


def build_deck(case, X, T, minfo, warnings):
    """The .inp and what post needs to read the results: (deck text, meta)."""
    load, mat = case["load"], case["material"]
    lo, hi = X.min(0), X.max(0)
    be, bf = boundary_faces(T)
    surf_nodes = np.unique(face_nodes(T, be, bf))
    surface = np.zeros(len(X), bool)
    surface[surf_nodes] = True
    h = float(minfo.get("size_min") or 0.5)
    hmax = float(minfo.get("size_max") or h)
    nn = len(X)
    meta = {"type": load["type"], "nodes": nn, "sets": {}}
    L = ["*HEADING", f"fea {case.get('name', '')}", "*NODE, NSET=NPART", fmt_nodes(range(1, nn + 1), X),
         "*ELEMENT, TYPE=C3D10, ELSET=EPART", fmt_elems(range(1, len(T) + 1), T + 1)]
    nonlinear = load.get("nonlinear")
    contact = load["type"] in ("bore", "pin")
    hyper = mat.get("model") == "neo-hooke"
    if nonlinear in (None, "auto"):
        nonlinear = contact or hyper or bool(load.get("large"))
    if hyper:
        nonlinear = True
    incremental = bool(nonlinear or contact)
    meta["nonlinear"] = bool(nonlinear)
    meta["incremental"] = bool(nonlinear or contact)
    steps = int(load.get("steps") or (20 if incremental else 1))
    nframes = int(load.get("frames") or (5 if not load.get("slide") else 10))
    bcs, step_bcs, prints, extra_model = [], [], [], []

    if load["type"] == "press":
        d = unit(load["direction"])
        fix = node_set(load["fix"], X, lo, hi, surface)
        move = node_set(load["move"], X, lo, hi, surface)
        move = np.setdiff1d(move, fix)
        if not len(fix):
            raise CaseError("the fix selector takes no nodes")
        if not len(move):
            raise CaseError("the move selector takes no nodes (or only ones fix holds already)")
        meta["sets"] = {"fix": int(len(fix)), "move": int(len(move))}
        meta["direction"] = d.tolist()
        meta["travel"] = float(load["travel"])
        L += [fmt_set("NFIX", fix + 1), fmt_set("NMOVE", move + 1), fmt_set("NREF", [int(move[0]) + 1])]
        axis_aligned = np.count_nonzero(np.abs(d) > 1e-9) == 1
        if axis_aligned:
            ax = int(np.argmax(np.abs(d)))
            val = float(load["travel"]) * float(np.sign(d[ax]))
            step_bcs.append(f"NMOVE, {ax + 1}, {ax + 1}, {val:.6g}")
            if load.get("rigid"):
                for o in range(3):
                    if o != ax:
                        step_bcs.append(f"NMOVE, {o + 1}, {o + 1}, 0.")
        else:
            helper = np.array([1.0, 0, 0]) if abs(d[0]) < 0.9 else np.array([0, 1.0, 0])
            b = np.cross(d, np.cross(helper, d))
            extra_model.append(f"*TRANSFORM, NSET=NMOVE, TYPE=R\n{d[0]:.9f},{d[1]:.9f},{d[2]:.9f},{b[0]:.9f},{b[1]:.9f},{b[2]:.9f}")
            step_bcs.append(f"NMOVE, 1, 1, {float(load['travel']):.6g}")
            if load.get("rigid"):
                step_bcs.append("NMOVE, 2, 3, 0.")
        bcs.append("NFIX, 1, 3, 0.")
        prints += ["*NODE PRINT, NSET=NMOVE, TOTALS=ONLY, GLOBAL=YES\nRF", "*NODE PRINT, NSET=NREF, GLOBAL=YES\nU"]
        constrained = np.concatenate([fix, move])
    else:
        ax = AX[load.get("axis", "z")]
        center = np.asarray(load.get("center") or ((lo + hi) / 2), dtype=float)
        if load.get("center") is None:
            center[ax] = 0.0
        r, s = radial(X, ax, center)
        span = load.get("span") or [float(s.min()), float(s.max())]
        s_lo, s_hi = float(span[0]), float(span[1])
        in_span = (s >= s_lo - 1e-9) & (s <= s_hi + 1e-9)
        if not in_span.any():
            raise CaseError(f"no part along the axis between {s_lo} and {s_hi}")
        R_end = float(load["diameter"]) / 2
        bore = load["type"] == "bore"
        r_out, r_in = float(r[in_span & surface].max()), float(r[in_span & surface].min())
        if bore:
            R0 = r_out + 0.02
            if R_end >= r_out:
                warnings.append(f"the bore ({2 * R_end:.3f} mm) is no smaller than the part ({2 * r_out:.3f} mm across): "
                                "nothing touches it")
        else:
            R0 = r_in - 0.02
            if R_end <= r_in:
                warnings.append(f"the pin ({2 * R_end:.3f} mm) is no bigger than the hole ({2 * r_in:.3f} mm): nothing touches it")
            if R0 <= 0.2:
                raise CaseError("the part has no hole along that axis for a pin")
        meta.update(axis=load.get("axis", "z"), center=center.tolist(), span=[s_lo, s_hi], R_start=R0, R_end=R_end,
                    part_diameter=2 * (r_out if bore else r_in), friction=float(load.get("friction", 0.5)),
                    slide=bool(load.get("slide")))
        # the part's faces that can touch the wall
        fn = face_nodes(T, be, bf, with_mids=False)
        rf = r[fn]
        sf = s[fn]
        reach = 1.0 + abs(R0 - R_end)
        if bore:
            touch = (rf.max(1) >= R_end - reach) & (sf.max(1) >= s_lo - 1e-6) & (sf.min(1) <= s_hi + 1e-6)
        else:
            touch = (rf.min(1) <= R_end + reach) & (sf.max(1) >= s_lo - 1e-6) & (sf.min(1) <= s_hi + 1e-6)
        if load.get("slide"):
            touch = (rf.max(1) >= R_end - reach) if bore else (rf.min(1) <= R_end + reach)
            touch &= (sf.max(1) >= s_lo - 0.5) & (sf.min(1) <= s_hi + 0.5)
        slave = [(int(e) + 1, int(f) + 1) for e, f in zip(be[touch], bf[touch])]
        if not slave:
            raise CaseError("no face of the part can touch the wall")
        # the wall
        circumference = 2 * math.pi * max(R0, R_end)
        ntheta = int(min(720, max(96, math.ceil(circumference / max(0.25, h / 2)))))
        if load.get("slide"):
            lip = ring_profile(load, R_end, s_lo, s_hi, h)  # (r, d): d runs -Re..0, 0 at the lip's very edge
            Re = float(load.get("entry_radius", 0.5))
            enter_from_top = str(load.get("from_end", "+")).strip() != "-"
            n_lip = len(lip)
            if enter_from_top:
                start = s_hi + 0.3  # the lip's edge, just clear of the part's top; the wall slides down
                depth = float(load.get("depth") or (start - s_lo))
                length = depth + 1.0
                prof = [(rr, start - d) for rr, d in reversed(lip)]
                sign = -1.0
            else:
                start = s_lo - 0.3
                depth = float(load.get("depth") or (s_hi - start))
                length = depth + 1.0
                prof = [(rr, start + d) for rr, d in reversed(lip)]
                sign = 1.0
            n_tube = max(2, int(math.ceil(length / max(h, 0.5))))
            for k in range(n_tube):
                prof.append((R_end, prof[n_lip - 1][1] - sign * (k + 1) * length / n_tube))
            meta.update(depth=depth, entry_radius=Re, enter_from=("+" if enter_from_top else "-"), sign=sign)
            R_start = R_end
        else:
            prof = ring_profile(load, R0, s_lo - 0.5, s_hi + 0.5, hmax)
            R_start = R0
        rn, re_, rfaces, rinner = ring(ax, center, prof, ntheta, outward=1 if bore else -1)
        base = nn
        L += ["*NODE, NSET=NRING", fmt_nodes(range(base + 1, base + len(rn) + 1), rn),
              "*ELEMENT, TYPE=C3D8, ELSET=ERING", fmt_elems(range(len(T) + 1, len(T) + len(re_) + 1), re_ + base + 1)]
        L.append(fmt_set("NRIN", rinner + base + 1))
        mid = int(rinner[len(rinner) // 2]) + base + 1
        L.append(fmt_set("NRREF", [mid]))
        a_pt = center.copy()
        b_pt = center.copy()
        b_pt[ax] += 1.0
        extra_model.append("*TRANSFORM, NSET=NRING, TYPE=C\n" + ",".join(f"{v:.6f}" for v in list(a_pt) + list(b_pt)))
        meta.update(ring_nodes=int(len(rn)), ring_elements=int(len(re_)), ntheta=ntheta)
        # the part's supports
        if load.get("fix"):
            fix = node_set(load["fix"], X, lo, hi, surface)
            if not len(fix):
                raise CaseError("the fix selector takes no nodes")
            bcs.append("NFIX, 1, 3, 0.")
            L.append(fmt_set("NFIX", fix + 1))
            meta["sets"]["fix"] = int(len(fix))
            constrained = fix
        else:
            if load.get("slide"):
                raise CaseError("sliding needs fix: what holds the part while the wall slides over it")
            # three nodes that hold it still and nothing more: on the axis mid-span (all), further along the axis
            # (across it), and off it (around it), so the squeeze is the part's own
            s_mid = (s_lo + s_hi) / 2
            A = int(np.argmin(r + 0.25 * np.abs(s - s_mid)))
            far = np.abs(s - s[A])
            B = int(np.argmin(r - 0.5 * far + 100.0 * (far < 0.25 * (s_hi - s_lo))))
            o1 = [i for i in range(3) if i != ax][0]
            o2 = [i for i in range(3) if i != ax][1]
            # C: off the axis along o1, near the plane through the axis (o2 = center): its o2 motion is rotation
            dist_o2 = np.abs(X[:, o2] - center[o2])
            C = int(np.argmin(dist_o2 - 0.3 * (X[:, o1] - center[o1]) + 0.25 * np.abs(s - s[A])))
            if r[C] < 0.5:
                raise CaseError("couldn't find a node off the axis to stop the part turning: give fix")
            L.append(fmt_set("NHOLDA", [A + 1]))
            L.append(fmt_set("NHOLDB", [B + 1]))
            L.append(fmt_set("NHOLDC", [C + 1]))
            bcs += ["NHOLDA, 1, 3, 0.", f"NHOLDB, {o1 + 1}, {o1 + 1}, 0.", f"NHOLDB, {o2 + 1}, {o2 + 1}, 0.",
                    f"NHOLDC, {o2 + 1}, {o2 + 1}, 0."]
            meta["sets"]["fix"] = "3 nodes (held still, nothing more)"
            constrained = np.array([A, B, C])
            meta["hold"] = [X[A].round(3).tolist(), X[B].round(3).tolist(), X[C].round(3).tolist()]
        meta["sets"]["contact_faces"] = len(slave)
        kpen = float(load.get("penalty") or 50.0 * float(mat["E"]) / max(h, 0.1))
        mu = float(load.get("friction", 0.5))
        use_mu = mu if load.get("slide") else 0.0
        L.append("*SURFACE, NAME=SPART, TYPE=ELEMENT\n" + "\n".join(f"{e}, S{f}" for e, f in slave))
        L.append("*SURFACE, NAME=SRING, TYPE=ELEMENT\n" + "\n".join(f"{len(T) + 1 + e}, S{f + 1}" for e, f in rfaces))
        L.append(f"*SURFACE INTERACTION, NAME=SI1\n*SURFACE BEHAVIOR, PRESSURE-OVERCLOSURE=LINEAR\n{kpen:.6g}")
        if use_mu > 0:
            L.append(f"*FRICTION\n{use_mu:.6g}, {kpen * 0.3:.6g}")
        L.append("*CONTACT PAIR, INTERACTION=SI1, TYPE=SURFACE TO SURFACE\nSPART, SRING")
        bcs.append("NRING, 2, 2, 0.")
        if load.get("slide"):
            bcs.append("NRING, 1, 1, 0.")
            step_bcs.append(f"NRING, 3, 3, {sign * meta['depth']:.6g}")
        else:
            bcs.append("NRING, 3, 3, 0.")
            step_bcs.append(f"NRING, 1, 1, {R_end - R_start:.6g}")
        meta["penalty"] = kpen
        prints += ["*NODE PRINT, NSET=NRIN, GLOBAL=YES\nRF", "*NODE PRINT, NSET=NRREF, GLOBAL=YES\nU"]
        L.append("*MATERIAL, NAME=WALL\n*ELASTIC\n1., 0.3\n*SOLID SECTION, ELSET=ERING, MATERIAL=WALL")

    L += material_cards(mat)
    L.append("*SOLID SECTION, ELSET=EPART, MATERIAL=PART")
    L += extra_model
    L.append("*BOUNDARY\n" + "\n".join(bcs))
    # output: the printed totals at every increment's planned time, the fields (big) at every k-th of those. With
    # time points on any request CalculiX writes the .dat only at time points, so both get them
    tpp = frames(steps)
    every = max(1, steps // max(1, nframes))
    tp = tpp[every - 1::every]
    if tp[-1] != 1.0:
        tp.append(1.0)
    if incremental:
        L.append("*TIME POINTS, NAME=TPP\n" + "\n".join(f"{t:.6g}," for t in tpp))
        L.append("*TIME POINTS, NAME=TP\n" + "\n".join(f"{t:.6g}," for t in tp))
        prints = [p.replace("*NODE PRINT, ", "*NODE PRINT, TIME POINTS=TPP, ", 1) for p in prints]
    controls = "*CONTROLS, PARAMETERS=TIME INCREMENTATION\n8, 10, 9, 20, 10, 4, , 6" if (contact or nonlinear) else ""

    # SPOOLES, CalculiX's direct solver, on the case's threads: on a 165k-unknown glide with contact it
    # factors in ~20 s, where CalculiX's own (single-threaded) conjugate gradients took ~100 s a solve. Past ~150k
    # nodes its memory runs away, so iterative there. load.solver says which (direct, iterative)
    choice = str(load.get("solver") or "auto")
    if choice == "auto":
        choice = "iterative" if nn > 150_000 else "direct"
    solver = ", SOLVER=ITERATIVE CHOLESKY" if choice == "iterative" else ""
    meta["solver"] = choice

    def step(bc_lines):
        out = []
        if nonlinear or contact:
            dt = 1.0 / steps
            out.append("*STEP, NLGEOM, INC=10000" if nonlinear else "*STEP, INC=10000")
            out.append(f"*STATIC{solver}\n{dt * (0.5 if contact else 1.0):.6g}, 1., {dt * 1e-4:.6g}, {dt:.6g}")
        else:
            out.append("*STEP")
            out.append(f"*STATIC{solver}")
        if controls:
            out.append(controls.rstrip())
        out.append("*BOUNDARY\n" + "\n".join(bc_lines))
        out += prints
        out.append("*NODE FILE" + (", TIME POINTS=TP" if incremental else "") + "\nU")
        out.append("*EL FILE" + (", TIME POINTS=TP" if incremental else "") + "\nS, E")
        out.append("*END STEP")
        return out

    L += step(step_bcs)
    meta["steps"] = 1
    if load["type"] in ("bore", "pin") and load.get("slide") and load.get("pull", True):
        L += step(["NRING, 3, 3, 0."])  # back to where it started: pulled out
        meta["steps"] = 2
    meta["constrained"] = constrained.tolist() if hasattr(constrained, "tolist") else list(constrained)
    meta["surface_faces"] = int(len(be))
    return "\n".join(L) + "\n", meta, (be, bf)


# ---------------------------------------------------------------------------------------------
# Solving


def ccx_binary():
    for name in ("ccx", "ccx_2.21", "ccx_2.22", "ccx_2.23"):
        p = shutil.which(name)
        if p:
            return p
    for p in sorted(os.listdir("/usr/bin")) if os.path.isdir("/usr/bin") else []:
        if p.startswith("ccx"):
            return os.path.join("/usr/bin", p)
    raise CaseError("CalculiX (ccx) isn't installed on the box")


def read_sta(path):
    """The solver's increments so far: [(step, increment, attempts, iterations, total time, step time)]."""
    rows = []
    try:
        with open(path) as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 7 and parts[0].isdigit():
                    try:
                        rows.append((int(parts[0]), int(parts[1]), parts[2], int(parts[3]), float(parts[4]), float(parts[5])))
                    except ValueError:
                        continue
    except OSError:
        pass
    return rows


def rss_mb(pid):
    """What a process holds in memory now (MB), or None where /proc can't say."""
    try:
        with open(f"/proc/{pid}/status") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) / 1024
    except (OSError, ValueError, IndexError):
        pass
    try:  # no /proc (a Mac running the tests)
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True, timeout=5).stdout
        return int(out.strip()) / 1024 if out.strip() else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def cgroup_mb():
    """What this case's whole memory scope holds now (MB): the cgroup the runner's systemd-run put it in."""
    try:
        with open("/proc/self/cgroup") as f:
            path = f.read().strip().split("::", 1)[-1].split(":")[-1]
        with open(os.path.join("/sys/fs/cgroup", path.lstrip("/"), "memory.current")) as f:
            return int(f.read().strip()) / 1048576
    except (OSError, ValueError):
        return None


# A solve is stopped once it holds this share of its memory (before the kernel kills it with nothing said), or
# once its pace, measured past PACE_AFTER of its time, says it can't reach the end of the load within its time.
MEM_STOP = 0.92
PACE_AFTER = 0.15


def solve(folder, threads, total_time, progress, timeout_s, mem_mb=None):
    env = dict(os.environ, OMP_NUM_THREADS=str(threads), CCX_NPROC_EQUATION_SOLVER=str(threads),
               CCX_NPROC_RESULTS=str(threads), CCX_NPROC_STIFFNESS=str(threads))
    t0 = time.time()
    peak = 0.0
    with open(os.path.join(folder, "ccx.log"), "w") as log:
        p = subprocess.Popen([ccx_binary(), "-i", "job"], cwd=folder, stdout=log, stderr=subprocess.STDOUT, env=env)
        while p.poll() is None:
            time.sleep(3)
            rows = read_sta(os.path.join(folder, "job.sta"))
            done = rows[-1][4] if rows else 0.0
            frac = min(1.0, done / total_time)
            held = cgroup_mb() or rss_mb(p.pid) or 0.0
            peak = max(peak, held)
            progress("solving", round(frac, 3), increments=len(rows), mem_mb=round(held))
            took = time.time() - t0
            stop = None
            if mem_mb and held > mem_mb * MEM_STOP:
                stop = {"out_of_memory": True, "mem_mb": int(mem_mb)}
            elif took > timeout_s * PACE_AFTER and (frac <= 0 or took / frac > timeout_s):
                stop = {"too_slow": True, "projected_s": round(took / frac) if frac > 0 else None}
            elif took > timeout_s:
                stop = {"timed_out": True}
            if stop:
                p.kill()
                p.wait()
                return dict(stop, seconds=round(took, 1), reached=round(frac, 4), peak_mem_mb=round(peak))
    with open(os.path.join(folder, "ccx.log"), errors="replace") as f:
        log = f.read()
    errors = [l.strip() for l in log.splitlines() if "*ERROR" in l]
    out = {"exit": p.returncode, "seconds": round(time.time() - t0, 1), "finished": "Job finished" in log,
           "errors": errors[:5], "warnings": len([l for l in log.splitlines() if "*WARNING" in l]),
           "peak_mem_mb": round(peak)}
    if not out["finished"] and not errors:
        tail = [l for l in log.strip().splitlines() if l.strip()][-6:]
        out["tail"] = tail
    return out


# ---------------------------------------------------------------------------------------------
# Reading the results


HEAD_RE = re.compile(r"^\s*(total force|forces|displacements)\s*\([^)]*\)\s*for set\s+(\S+)\s+and time\s+(\S+)", re.I)


def read_dat(path):
    """The .dat's printed blocks in order: [{kind, set, time, rows: [[node?, v1, v2, v3]]}]."""
    blocks, cur = [], None
    with open(path, errors="replace") as f:
        for line in f:
            m = HEAD_RE.match(line)
            if m:
                cur = {"kind": m.group(1).lower(), "set": m.group(2).upper(), "time": float(m.group(3)), "rows": []}
                blocks.append(cur)
                continue
            if cur is None:
                continue
            parts = line.split()
            if not parts:
                continue
            try:
                vals = [float(x) for x in parts]
            except ValueError:
                cur = None
                continue
            cur["rows"].append(vals)
    return blocks


def read_frd(path, want=("DISP", "STRESS", "TOSTRAIN")):
    """The .frd's result frames: [{time, step_frame, fields: {name: (node ids, values N x k)}}]. Nodes are
    CalculiX's numbers."""
    frames_, cur, field, ids, vals = [], None, None, [], []
    with open(path, errors="replace") as f:
        for line in f:
            key = line[:3]
            if line.startswith("    1PSTEP") or line.startswith("  100C"):
                if line.startswith("  100C"):
                    try:
                        t = float(line[12:24])
                    except ValueError:
                        t = None
                    if cur is None or cur.get("time") != t:
                        cur = {"time": t, "fields": {}}
                        frames_.append(cur)
                continue
            if key == " -4":
                field = line[5:13].strip()
                ids, vals = [], []
                if field not in want:
                    field = "_skip"
                continue
            if key == " -1" and field and field != "_skip" and cur is not None:
                ids.append(int(line[3:13]))
                n = (len(line.rstrip("\n")) - 13) // 12
                vals.append([float(line[13 + 12 * i:25 + 12 * i]) for i in range(n)])
                continue
            if key == " -3" and field and field != "_skip" and cur is not None:
                if ids:
                    width = min(len(v) for v in vals)
                    cur["fields"][field] = (np.array(ids), np.array([v[:width] for v in vals]))
                field = None
    return [fr for fr in frames_ if fr["fields"]]


def tensor(v):
    """N x 6 (xx, yy, zz, xy, yz, zx) as N x 3 x 3."""
    t = np.zeros((len(v), 3, 3))
    t[:, 0, 0], t[:, 1, 1], t[:, 2, 2] = v[:, 0], v[:, 1], v[:, 2]
    t[:, 0, 1] = t[:, 1, 0] = v[:, 3]
    t[:, 1, 2] = t[:, 2, 1] = v[:, 4]
    t[:, 0, 2] = t[:, 2, 0] = v[:, 5]
    return t


def von_mises(s):
    return np.sqrt(0.5 * ((s[:, 0] - s[:, 1]) ** 2 + (s[:, 1] - s[:, 2]) ** 2 + (s[:, 2] - s[:, 0]) ** 2)
                   + 3 * (s[:, 3] ** 2 + s[:, 4] ** 2 + s[:, 5] ** 2))


def interp(xs, ys, at):
    xs, ys = np.asarray(xs, float), np.asarray(ys, float)
    if len(xs) < 2:
        return None
    order = np.argsort(xs)
    xs, ys = xs[order], ys[order]
    if at < xs[0] - 1e-9 or at > xs[-1] + 1e-9:
        return None
    return float(np.interp(at, xs, ys))


def curves(meta, blocks, X):
    """The load path: [{x, force, ...}] by printed increment, in the load's own terms."""
    by_seq = []
    if meta["type"] == "press":
        tot = [b for b in blocks if b["kind"] == "total force" and b["set"] == "NMOVE"]
        disp = [b for b in blocks if b["kind"] == "displacements" and b["set"] == "NREF"]
        d = np.asarray(meta["direction"])
        pts = [{"x": 0.0, "force": 0.0}]
        for tb, db in zip(tot, disp):
            F = np.asarray(tb["rows"][0][-3:])
            u = np.asarray(db["rows"][0][-3:])
            pts.append({"x": float(u @ d), "force": float(F @ d), "time": tb["time"]})
        return pts
    rf = [b for b in blocks if b["kind"] == "forces" and b["set"] == "NRIN"]
    disp = [b for b in blocks if b["kind"] == "displacements" and b["set"] == "NRREF"]
    ax = AX[meta["axis"]]
    center = np.asarray(meta["center"])
    others = [i for i in range(3) if i != ax]
    out = []
    for k, (fb, db) in enumerate(zip(rf, disp)):
        rows = np.asarray(fb["rows"])
        ids = rows[:, 0].astype(int) - 1 - meta["nodes"]
        F = rows[:, 1:4]
        ring_x = meta["_ring_nodes"][ids]
        rv = ring_x[:, others] - center[others]
        rhat = rv / np.maximum(np.linalg.norm(rv, axis=1, keepdims=True), 1e-12)
        Fr = F[:, others[0]] * rhat[:, 0] + F[:, others[1]] * rhat[:, 1]
        Fa = F[:, ax]
        u = np.asarray(db["rows"][0][-3:])
        if meta.get("slide"):
            pos = float(u[ax]) * meta["sign"]
            prev = out[-1] if out else None
            stepno = 1 if prev is None else prev["step"]
            if prev is not None and (fb["time"] < prev["time"] - 1e-9 or (prev["time"] <= 1.0 + 1e-9 < fb["time"])):
                stepno = 2
            out.append({"x": pos, "force": float(Fa.sum()) * meta["sign"], "radial": float(np.abs(Fr.sum())),
                        "time": fb["time"], "step": stepno})
        else:
            uref = np.asarray(meta["_ring_nodes"][meta["_rref"]])
            rv0 = uref[others] - center[others]
            ur = float(u[others] @ (rv0 / np.linalg.norm(rv0)))
            D = 2 * (meta["R_start"] + ur)
            N = float(abs(Fr.sum()))
            out.append({"x": D, "force": N, "push": N * meta["friction"], "time": fb["time"]})
    return out


def strain_field(frames_, X, constrained, h, mat, nonlinear):
    """The governing strain and stress: each frame's largest principal strain (engineering) and von Mises stress,
    over every node and over nodes clear of the supports (where a held node's own singularity doesn't count)."""
    from scipy.spatial import cKDTree
    if not frames_:
        return None, None
    n = len(X)
    clear = np.ones(n, bool)
    if len(constrained):
        tree = cKDTree(X[np.asarray(constrained, dtype=int)])
        d, _ = tree.query(X, k=1)
        clear = d > max(1.5 * h, 0.5)
    best = None
    per_frame = []
    for fr in frames_:
        f = fr["fields"]
        if "TOSTRAIN" not in f:
            continue
        ids, ev = f["TOSTRAIN"]
        keep = ids <= n
        ids, ev = ids[keep] - 1, ev[keep]
        lam = np.linalg.eigvalsh(tensor(ev))
        if nonlinear:  # Green-Lagrange to engineering: stretch = sqrt(1 + 2E)
            lam = np.sqrt(np.maximum(1 + 2 * lam, 0)) - 1
        eng = np.maximum(np.abs(lam[:, 0]), np.abs(lam[:, 2]))  # the largest by size, stretched or squeezed
        vm = None
        if "STRESS" in f:
            sid, sv = f["STRESS"]
            keep = sid <= n
            vm_all = np.zeros(n)
            vm_all[sid[keep] - 1] = von_mises(sv[keep])
            vm = vm_all[ids]
        cl = clear[ids]
        rec = {"time": fr["time"], "strain_max": float(eng.max()), "strain_clear": float(eng[cl].max()) if cl.any() else None,
               "at": X[ids[int(np.argmax(np.where(cl, eng, -1)))]].round(2).tolist() if cl.any() else None}
        if vm is not None:
            rec["stress_max"] = float(vm.max())
            rec["stress_clear"] = float(vm[cl].max()) if cl.any() else None
        per_frame.append(rec)
        if best is None or (rec["strain_clear"] or 0) > (best[0]["strain_clear"] or 0):
            field = np.zeros(n)
            field[ids] = eng
            best = (rec, field, fr)
    if best is None:
        return None, None
    rec, field, fr = best
    disp = np.zeros((n, 3))
    if "DISP" in fr["fields"]:
        did, dv = fr["fields"]["DISP"]
        keep = did <= n
        disp[did[keep] - 1] = dv[keep][:, :3]
    out = dict(rec, frames=per_frame)
    limit = mat.get("elongation")
    if limit:
        out["elongation"] = limit
        out["of_elongation"] = round((rec["strain_clear"] or rec["strain_max"]) / limit, 3)
    strength = mat.get("strength")
    if strength and rec.get("stress_clear") is not None:
        out["strength"] = strength
        out["of_strength"] = round(rec["stress_clear"] / strength, 3)
        if mat.get("strength_z"):
            out["strength_z"] = mat["strength_z"]
            out["of_strength_z"] = round(rec["stress_clear"] / mat["strength_z"], 3)
    return out, (field, disp)


def headline(meta, pts, load):
    """The numbers a redesign is judged by, for this kind of load."""
    out = {}
    if meta["type"] == "press":
        xs = [p["x"] for p in pts]
        fs = [p["force"] for p in pts]
        if len(pts) >= 2 and pts[1]["x"]:
            out["stiffness_N_per_mm"] = round(pts[1]["force"] / pts[1]["x"], 6)
        if pts[-1]["x"]:
            out["secant_N_per_mm"] = round(pts[-1]["force"] / pts[-1]["x"], 6)
        out["force_N"] = round(pts[-1]["force"], 4)
        out["travel_mm"] = round(pts[-1]["x"], 4)
        i = int(np.argmax(fs))
        if i < len(fs) - 1:
            out["peak_N"] = round(fs[i], 4)
            out["peak_at_mm"] = round(xs[i], 4)
        out["at"] = {f"{a:g}": interp(xs, fs, a) for a in load.get("at") or []}
        out["metric"] = "force_N"
    elif meta.get("slide"):
        s1 = [p for p in pts if p.get("step", 1) == 1]
        s2 = [p for p in pts if p.get("step", 1) == 2]
        if s1:
            f1 = [p["force"] for p in s1]
            out["insert_peak_N"] = round(max(f1), 4)
            out["insert_peak_at_mm"] = round(s1[int(np.argmax(f1))]["x"], 3)
            tail = f1[int(len(f1) * 0.8):] or f1[-1:]
            out["seated_slide_N"] = round(float(np.mean(tail)), 4)
            out["travel_mm"] = round(s1[-1]["x"], 3)
        if s2:
            out["pull_peak_N"] = round(max(-p["force"] for p in s2), 4)
        out["metric"] = "insert_peak_N"
    else:
        D = meta["R_end"] * 2
        xs = [p["x"] for p in pts]
        Ns = [p["force"] for p in pts]
        N = interp(xs, Ns, D)
        if N is None and pts:
            N = Ns[-1]
            out["reached_diameter_mm"] = round(xs[-1], 4)
        out["diameter_mm"] = D
        out["radial_N"] = round(N, 4) if N is not None else None
        out["push_N"] = round(N * meta["friction"], 4) if N is not None else None
        out["friction"] = meta["friction"]
        if len(pts) >= 3 and N:
            interference = abs(meta["part_diameter"] - D)
            if interference > 0:
                out["radial_N_per_mm_interference"] = round(N / interference, 4)
        out["at"] = {f"{a:g}": {"radial_N": interp(xs, Ns, a), "push_N": (interp(xs, Ns, a) or 0) * meta["friction"]
                                if interp(xs, Ns, a) is not None else None} for a in load.get("at") or []}
        out["metric"] = "push_N"
    return out


# ---------------------------------------------------------------------------------------------
# Pictures


VIEWS = [("iso", 30, -60), ("side", 0, -90)]


def project(P, elev, azim):
    """Screen x, screen y and depth (larger is further) of points seen from (elevation, azimuth), as matplotlib's
    3D view would place its camera."""
    e, a = math.radians(elev), math.radians(azim)
    eye = np.array([math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e)])
    right = np.array([-math.sin(a), math.cos(a), 0.0])
    up = np.cross(eye, right)
    return P @ right, P @ up, -(P @ eye)


def draw_surface(ax, X, tris, values=None, cmap=None, norm=None, elev=30, azim=-60, base=(0.78, 0.78, 0.80), alpha=1.0):
    from matplotlib.collections import PolyCollection
    sx, sy, depth = project(X, elev, azim)
    P = X[tris]
    nrm = np.cross(P[:, 1] - P[:, 0], P[:, 2] - P[:, 0])
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)
    light = np.array([0.4, -0.5, 0.75])
    light /= np.linalg.norm(light)
    shade = 0.45 + 0.55 * np.abs(nrm @ light)
    order = np.argsort(-depth[tris].mean(1))
    polys = np.stack([sx[tris], sy[tris]], axis=2)[order]
    if values is not None:
        colors = cmap(norm(values[tris].mean(1)))[order][:, :3]
    else:
        colors = np.tile(np.asarray(base), (len(tris), 1))[order]
    colors = colors * shade[order][:, None]
    pc = PolyCollection(polys, facecolors=np.c_[np.clip(colors, 0, 1), np.full(len(colors), alpha)],
                        edgecolors="none", antialiased=False)
    ax.add_collection(pc)
    ax.set_xlim(sx.min() - 1, sx.max() + 1)
    ax.set_ylim(sy.min() - 1, sy.max() + 1)
    ax.set_aspect("equal")
    ax.axis("off")
    return sx, sy


def pictures(folder, case, X, T, faces, meta, strain, field_disp, pts, head):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib import cm, colors as mcolors
    be, bf = faces
    tris = face_nodes(T, be, bf, with_mids=False)
    made = {}
    # setup: what's held and what moves
    fig, axs = plt.subplots(1, 2, figsize=(9, 4.2), dpi=110)
    for axp, (_, el, az) in zip(axs, VIEWS):
        sx, sy = draw_surface(axp, X, tris, elev=el, azim=az)
        con = np.asarray(meta.get("constrained") or [], dtype=int)
        if len(con):
            px, py, _ = project(X[con], el, az)
            axp.scatter(px, py, s=4, c="#1f6feb", lw=0, label="held")
        if meta.get("_move") is not None and len(meta["_move"]):
            px, py, _ = project(X[meta["_move"]], el, az)
            axp.scatter(px, py, s=4, c="#d1242f", lw=0, label="pushed")
        if meta.get("_ring_nodes") is not None:
            rn = meta["_ring_nodes"][meta["_rinner"]]
            px, py, _ = project(rn, el, az)
            axp.scatter(px, py, s=0.3, c="#8250df", lw=0, alpha=0.25)
    axs[0].legend(loc="lower left", fontsize=7, frameon=False, markerscale=3)
    fig.suptitle(f"{case.get('name')}: setup", fontsize=10)
    fig.tight_layout()
    fig.savefig(os.path.join(folder, "setup.png"))
    plt.close(fig)
    made["setup"] = "setup.png"
    # strain on the deformed part
    if strain and field_disp is not None:
        field, disp = field_disp
        vmax = max(float(np.percentile(field, 99.5)), 1e-6)
        norm = mcolors.Normalize(vmin=0, vmax=vmax)
        cmap = matplotlib.colormaps.get_cmap("turbo") if hasattr(matplotlib, "colormaps") else cm.get_cmap("turbo")
        fig, axs = plt.subplots(1, 2, figsize=(9, 4.4), dpi=110)
        Xd = X + disp
        for axp, (_, el, az) in zip(axs, VIEWS):
            draw_surface(axp, Xd, tris, values=np.clip(field, 0, None), cmap=cmap, norm=norm, elev=el, azim=az)
            if strain.get("at"):
                px, py, _ = project(np.asarray([strain["at"]]), el, az)
                axp.scatter(px, py, s=40, facecolors="none", edgecolors="k", lw=1.2)
        sm = cm.ScalarMappable(norm=mcolors.Normalize(vmin=0, vmax=vmax * 100), cmap=cmap)
        fig.colorbar(sm, ax=axs, fraction=0.03, pad=0.02, label="largest principal strain (%)")
        when = "full load" if (strain.get("time") or 1) >= 0.999 else f"{strain['time'] * 100:.0f}% of the load"
        fig.suptitle(f"{case.get('name')}: strain at {when}", fontsize=10)
        fig.savefig(os.path.join(folder, "strain.png"))
        plt.close(fig)
        made["strain"] = "strain.png"
    # the curve
    if len(pts) >= 2:
        fig, axp = plt.subplots(figsize=(6.2, 3.6), dpi=110)
        xs = [p["x"] for p in pts]
        if meta["type"] == "press":
            axp.plot(xs, [p["force"] for p in pts], "-o", ms=3, color="#0969da")
            axp.set_xlabel("travel (mm)")
            axp.set_ylabel("force (N)")
        elif meta.get("slide"):
            axp.plot(xs, [p["force"] for p in pts], "-o", ms=2, color="#0969da")
            axp.axhline(0, color="#888", lw=0.6)
            axp.set_xlabel("travel into the wall (mm)")
            axp.set_ylabel("axial force (N): + pushing in, - pulling out")
        else:
            axp.plot(xs, [p["force"] * meta["friction"] for p in pts], "-o", ms=3, color="#0969da",
                     label=f"push (friction {meta['friction']:g} x radial)")
            axp.axvline(meta["R_end"] * 2, color="#888", lw=0.8, ls="--")
            axp.set_xlabel(("bore" if meta["type"] == "bore" else "pin") + " diameter (mm)")
            axp.set_ylabel("force to push it in (N)")
            if meta["type"] == "bore":
                axp.invert_xaxis()
        axp.grid(alpha=0.3)
        axp.set_title(case.get("name"), fontsize=10)
        fig.tight_layout()
        fig.savefig(os.path.join(folder, "curve.png"))
        plt.close(fig)
        made["curve"] = "curve.png"
    return made


# ---------------------------------------------------------------------------------------------
# One case, start to end


def run(folder):
    folder = os.path.abspath(folder)
    case = read_json(os.path.join(folder, "case.json"))
    if not case:
        raise SystemExit(f"no case.json in {folder}")
    progress = Progress(folder)
    warnings = []
    result = {"case": case.get("name"), "ok": False}
    try:
        X, T, minfo = mesh_part(case, folder, progress, warnings)
        result["mesh"] = minfo
        density = case["material"].get("density")
        if density:
            result["mass_g"] = round(minfo["volume_mm3"] / 1000 * density, 2)
        progress("writing the deck", 0.0)
        deck, meta, faces = build_deck(case, X, T, minfo, warnings)
        with open(os.path.join(folder, "job.inp"), "w") as f:
            f.write(deck)
        result["setup"] = {k: v for k, v in meta.items() if not k.startswith("_") and k not in ("constrained",)}
        total_time = float(meta["steps"])
        timeout_s = float(case.get("timeout_s") or 5400)
        sol = solve(folder, int(case.get("threads") or 4), total_time, progress, timeout_s, case.get("mem_mb"))
        result["solve"] = sol
        els = minfo["elements"]
        at = f"at {sol.get('reached', 0) * 100:.0f}% of the load after {sol.get('seconds', 0) / 60:.0f} min"
        if sol.get("out_of_memory"):
            raise CaseError(f"the solver filled its {sol['mem_mb']} MB {at}, on {els} elements: stopped before it ran "
                            f"out; a coarser mesh (mesh.budget about {max(1000, int(els * 0.5))})")
        if sol.get("too_slow"):
            eta = f"about {sol['projected_s'] / 60:.0f} min" if sol.get("projected_s") else "no progress"
            raise CaseError(f"the solver's pace ({eta} for the whole load, {at}) can't finish within its "
                            f"{timeout_s / 60:.0f} min, on {els} elements: stopped now; a coarser mesh or fewer steps")
        if sol.get("timed_out"):
            raise CaseError(f"the solver ran past its {timeout_s:.0f} s: a coarser mesh or fewer steps")
        progress("reading the results", 0.0)
        dat = os.path.join(folder, "job.dat")
        blocks = read_dat(dat) if os.path.exists(dat) else []
        if load_is_ring(case):
            rn = ring_nodes_from_deck(deck, meta["nodes"])
            meta["_ring_nodes"] = rn
            meta["_rref"] = int(re.search(r"\*NSET, NSET=NRREF\n(\d+)", deck).group(1)) - 1 - meta["nodes"]
            meta["_rinner"] = np.array(set_ids(deck, "NRIN")) - 1 - meta["nodes"]
        else:
            meta["_move"] = np.array(set_ids(deck, "NMOVE")) - 1
        pts = curves(meta, blocks, X)
        result["curve"] = pts
        rows = read_sta(os.path.join(folder, "job.sta"))
        reached = (rows[-1][4] / total_time) if rows else 0.0
        result["reached"] = round(min(1.0, reached), 4) if meta.get("incremental") else (1.0 if sol.get("finished") else 0.0)
        complete = bool(sol.get("finished")) and result["reached"] > 0.999
        result["complete"] = complete
        if not complete:
            if len(pts) < 2:
                why = "; ".join(sol.get("errors") or sol.get("tail") or ["no converged increment"])
                raise CaseError(f"CalculiX didn't solve it: {why}")
            warnings.append(f"the solver stopped at {result['reached'] * 100:.0f}% of the load "
                            f"({'; '.join(sol.get('errors') or ['it stopped converging'])}): the numbers cover that much")
        result["headline"] = headline(meta, pts, case["load"])
        frd = os.path.join(folder, "job.frd")
        fr = read_frd(frd) if os.path.exists(frd) else []
        strain, fd = strain_field(fr, X, meta["constrained"], float(minfo["size_min"]), case["material"], meta.get("nonlinear"))
        result["strain"] = strain
        progress("drawing", 0.0)
        try:
            result["pictures"] = pictures(folder, case, X, T, faces, meta, strain, fd, pts, result["headline"])
        except Exception as e:  # a picture that fails doesn't cost the numbers
            warnings.append(f"couldn't draw the pictures: {first_line(e)}")
        if not case.get("keep_frd") and os.path.exists(frd):
            os.remove(frd)
        result["ok"] = True
    except CaseError as e:
        result["error"] = str(e)
    except Exception as e:
        import traceback
        result["error"] = f"{type(e).__name__}: {e}"
        result["traceback"] = traceback.format_exc()[-3000:]
    result["warnings"] = warnings
    result["elapsed_s"] = round(time.time() - progress.t0, 1)
    write_json(os.path.join(folder, "result.json"), result)
    progress("done" if result["ok"] else "failed", 1.0)
    return 0 if result["ok"] else 1


def load_is_ring(case):
    return case["load"]["type"] in ("bore", "pin")


def set_ids(deck, name):
    m = re.search(rf"\*NSET, NSET={name}\n((?:[\d,]+\n?)+)", deck)
    return [int(x) for x in m.group(1).replace("\n", ",").split(",") if x.strip()] if m else []


def ring_nodes_from_deck(deck, nn):
    m = re.search(r"\*NODE, NSET=NRING\n(.*?)\n\*", deck, re.S)
    rows = [l.split(",") for l in m.group(1).splitlines()]
    return np.array([[float(r[1]), float(r[2]), float(r[3])] for r in rows])


# ---------------------------------------------------------------------------------------------
# A study's table and chart


def compare(out_dir, case_dirs, reference=None, target=None):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    rows, curves_ = [], []
    for d in case_dirs:
        r = read_json(os.path.join(d, "result.json")) or {}
        c = read_json(os.path.join(d, "case.json")) or {}
        name = c.get("name") or os.path.basename(d)
        row = {"case": name, "ok": r.get("ok", False), "error": r.get("error"), "complete": r.get("complete")}
        h = r.get("headline") or {}
        metric = h.get("metric")
        row["metric"] = metric
        row["value"] = h.get(metric) if metric else None
        for k in ("stiffness_N_per_mm", "force_N", "push_N", "radial_N", "insert_peak_N", "pull_peak_N", "seated_slide_N"):
            if h.get(k) is not None:
                row[k] = h[k]
        s = r.get("strain") or {}
        row["strain_pct"] = round((s.get("strain_clear") or s.get("strain_max") or 0) * 100, 2) if s else None
        if s.get("of_strength") is not None:
            row["of_strength"] = s["of_strength"]
        row["mass_g"] = r.get("mass_g")
        row["elements"] = (r.get("mesh") or {}).get("elements")
        rows.append(row)
        if r.get("ok"):
            curves_.append((name, r.get("curve") or [], (r.get("setup") or {}).get("type"), r.get("setup") or {}))
    ref = next((r for r in rows if r["case"] == reference), None) if reference else None
    goal = None
    if target and target.get("value") is not None:
        goal = float(target["value"])
    elif ref and ref.get("value"):
        goal = ref["value"]
    tol = float((target or {}).get("tol", 0.1))
    for r in rows:
        if goal and r.get("value") is not None:
            r["of_target"] = round(r["value"] / goal, 4)
            dev = r["value"] / goal - 1
            r["verdict"] = ("on target" if abs(dev) <= tol else
                            (f"{dev * 100:.0f}% stiffer" if dev > 0 else f"{-dev * 100:.0f}% softer"))
    out = {"rows": rows, "reference": reference, "target": goal, "tol": tol}
    if curves_:
        fig, axp = plt.subplots(figsize=(7.2, 4.2), dpi=120)
        for name, pts, kind, setup in curves_:
            xs = [p["x"] for p in pts]
            if kind == "press" or setup.get("slide"):
                ys = [p["force"] for p in pts]
            else:
                ys = [p["force"] * setup.get("friction", 0.5) for p in pts]
            style = dict(lw=2.4, color="k", ls="--") if name == reference else dict(lw=1.8)
            axp.plot(xs, ys, label=name, **style)
        kind = curves_[0][2]
        setup = curves_[0][3]
        if kind == "press":
            axp.set_xlabel("travel (mm)")
            axp.set_ylabel("force (N)")
        elif setup.get("slide"):
            axp.set_xlabel("travel into the wall (mm)")
            axp.set_ylabel("axial force (N)")
        else:
            axp.set_xlabel(f"{kind} diameter (mm)")
            axp.set_ylabel(f"push-in force (N), friction {setup.get('friction', 0.5):g}")
            axp.axvline(setup.get("R_end", 0) * 2, color="#888", lw=0.8, ls=":")
            if kind == "bore":
                axp.invert_xaxis()
        if goal and kind != "press" and not setup.get("slide"):
            axp.axhspan(goal * (1 - tol), goal * (1 + tol), color="#2da44e", alpha=0.12, lw=0)
        axp.grid(alpha=0.3)
        axp.legend(fontsize=8, frameon=False)
        fig.tight_layout()
        fig.savefig(os.path.join(out_dir, "compare.png"))
        plt.close(fig)
        out["chart"] = "compare.png"
    write_json(os.path.join(out_dir, "compare.json"), out)
    return out


# ---------------------------------------------------------------------------------------------
# Checking itself against theory


def selftest(root):
    import trimesh
    os.makedirs(root, exist_ok=True)
    report = {}
    # 1. a PETG cantilever 40 x 4 x 2 mm, held over its first mm, its free end pushed 0.4 mm down
    d1 = os.path.join(root, "beam")
    os.makedirs(d1, exist_ok=True)
    trimesh.creation.box(extents=(40, 4, 2), transform=trimesh.transformations.translation_matrix((20, 2, 1))).export(
        os.path.join(d1, "beam.stl"))
    E, nu = 2311.0, 0.38
    write_json(os.path.join(d1, "case.json"), {
        "name": "beam", "part": "beam.stl", "threads": 4,
        "material": {"name": "PETG", "E": E, "nu": nu, "model": "linear"},
        "mesh": {"size": 0.7},
        "load": {"type": "press", "fix": {"side": "-x", "depth": 1.0}, "move": {"side": "+x", "depth": 0.01},
                 "direction": "-z", "travel": 0.4}})
    run(d1)
    r = read_json(os.path.join(d1, "result.json"))
    L, b, hh = 39.0, 4.0, 2.0
    I = b * hh ** 3 / 12
    G = E / (2 * (1 + nu))
    k_theory = 1 / (L ** 3 / (3 * E * I) + L / (5 / 6 * G * b * hh))
    k = (r.get("headline") or {}).get("stiffness_N_per_mm")
    report["beam"] = {"ok": r.get("ok"), "k": k, "k_theory": round(k_theory, 5),
                      "off": round(k / k_theory - 1, 4) if k else None, "error": r.get("error")}
    # 2. a rod 10 mm across and 10 long (E 26 MPa, nu 0.45) squeezed in a 9.8 mm bore, frictionless, small strain:
    # uniform pressure p = E u / (R (1 - nu)) all round with free ends, so the wall carries 2 pi L E u / (1 - nu).
    # The STL is a 128-sided prism, so u is from its mean radius
    d2 = os.path.join(root, "rod")
    os.makedirs(d2, exist_ok=True)
    n_sides = 128
    trimesh.creation.cylinder(radius=5.0, height=10.0, sections=n_sides).export(os.path.join(d2, "rod.stl"))
    E2, nu2 = 26.0, 0.45
    write_json(os.path.join(d2, "case.json"), {
        "name": "rod", "part": "rod.stl", "threads": 4,
        "material": {"name": "TPU (linear)", "E": E2, "nu": nu2, "model": "linear"},
        "mesh": {"size": 0.8},
        "load": {"type": "bore", "diameter": 9.8, "axis": "z", "friction": 0.5, "steps": 10, "nonlinear": False}})
    run(d2)
    r2 = read_json(os.path.join(d2, "result.json"))
    R_mean = 5.0 * (1 - (math.pi / n_sides) ** 2 / 6)
    N_theory = 2 * math.pi * 10.0 * E2 * (R_mean - 4.9) / (1 - nu2)
    N = (r2.get("headline") or {}).get("radial_N")
    report["rod"] = {"ok": r2.get("ok"), "radial_N": N, "theory_N": round(N_theory, 2),
                     "off": round(N / N_theory - 1, 4) if N else None, "error": r2.get("error")}
    report["passed"] = bool(report["beam"]["off"] is not None and abs(report["beam"]["off"]) < 0.03
                            and report["rod"]["off"] is not None and abs(report["rod"]["off"]) < 0.03)
    write_json(os.path.join(root, "selftest.json"), report)
    print(json.dumps(report, indent=1))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    cmd = sys.argv[1]
    if cmd == "run":
        sys.exit(run(sys.argv[2]))
    if cmd == "compare":
        args = sys.argv[2:]
        ref = tgt = None
        if "--reference" in args:
            i = args.index("--reference")
            ref = args[i + 1]
            del args[i:i + 2]
        if "--target" in args:
            i = args.index("--target")
            tgt = json.loads(args[i + 1])
            del args[i:i + 2]
        compare(args[0], args[1:], ref, tgt)
        sys.exit(0)
    if cmd == "selftest":
        sys.exit(selftest(sys.argv[2]))
    raise SystemExit(__doc__)
