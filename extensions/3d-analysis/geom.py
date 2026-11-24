"""mesh's geometry: loading models (STL, 3MF with its plate placement and Bambu part types, OBJ, PLY, STEP, zips of
them), measuring what matters for printing them, cutting sections, rendering views and drawing sliced G-code layers.

It runs in the worker's own environment (numpy, trimesh with Embree, shapely, scipy, matplotlib, pillow), never in
the MCP server's. Every length is in millimetres, and z is up, as the printer has it.
"""

import io
import json
import math
import os
import re
import xml.etree.ElementTree as ET
import zipfile

import numpy as np
import trimesh

BED = (float(os.environ.get("MESH_BED_MM") or 256),) * 3
"""The printer's bed, 256 mm each way (a Bambu P1 or X1): MESH_BED_MM sets another."""
NOZZLE = 0.4
MODEL_EXTS = (".stl", ".3mf", ".obj", ".ply", ".off", ".glb", ".gltf", ".step", ".stp", ".blend", ".fbx", ".usd", ".usda",
              ".usdc", ".usdz")
UNITS = {"micron": 0.001, "millimeter": 1.0, "centimeter": 10.0, "inch": 25.4, "foot": 304.8, "meter": 1000.0}
DENSITY = {"PLA": 1.24, "PETG": 1.27, "ASA": 1.07, "ABS": 1.04, "TPU": 1.21}
BANDS = ((45, 60), (60, 75), (75, 90))
OFF_FACE = 0.0137
"""Sections are cut this far off the height asked for when a flat face lies exactly there: a cut along a face gives
slivers, not the part."""
SLIVER = 0.1
"""Walls and gaps thinner than this are faces lying on each other (overlapping bodies, a doubled face), not walls."""


class Unreadable(ValueError):
    pass


# Loading


def model_files(root):
    """Every model file under a folder, skipping macOS's ._ files and what a zip of a Mac folder carries."""
    found = []
    for d, dirs, files in os.walk(root):
        dirs[:] = sorted(x for x in dirs if not x.startswith((".", "__MACOSX")))
        for f in sorted(files):
            if f.startswith("._") or not f.lower().endswith(MODEL_EXTS):
                continue
            found.append(os.path.join(d, f))
    return found


def unzip_safely(path, dest):
    """A customer's zip, unpacked without letting a name climb out of dest."""
    with zipfile.ZipFile(path) as z:
        total = 0
        for info in z.infolist():
            name = info.filename
            if info.is_dir() or name.startswith("__MACOSX/") or os.path.basename(name).startswith("._"):
                continue
            target = os.path.realpath(os.path.join(dest, name))
            if not target.startswith(os.path.realpath(dest) + os.sep):
                continue
            total += info.file_size
            if total > 3e9:
                raise Unreadable("the zip unpacks to more than 3 GB")
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(info) as src, open(target, "wb") as out:
                while chunk := src.read(1 << 20):
                    out.write(chunk)
    return dest


def is_3mf(path):
    return path.lower().endswith(".3mf")


def load(path, objects="each", name=None):
    """The models in one file: [{name, mesh, source, note, left_out}], each mesh in mm with z up. A 3MF gives one per
    object on its build plate, placed where the plate has it (or one merged, with objects="merged")."""
    low = path.lower()
    base = name or os.path.basename(path)
    if low.endswith((".blend", ".fbx", ".usd", ".usda", ".usdc", ".usdz")) or base.lower().endswith((".blend", ".fbx", ".usd", ".usda", ".usdc", ".usdz")):
        import scenes  # Blender reads these: one model per object it shows, in mm as read
        return scenes.load_models(path, base, objects)
    if is_3mf(low):
        models = read_3mf(path)
        if not models:
            raise Unreadable(f"{base} has no printable objects")
        if objects == "merged" and len(models) > 1:
            mesh = trimesh.util.concatenate([m["mesh"] for m in models])
            left = sorted({x for m in models for x in m["left_out"]})
            return [{"name": base, "mesh": mesh, "source": base, "objects": [m["name"] for m in models],
                     "left_out": left, "note": f"{len(models)} objects merged, as placed on the plate"}]
        for m in models:
            m["source"] = base
        return models
    if low.endswith((".step", ".stp")):
        try:
            import cascadio  # noqa: F401  (trimesh reads STEP through it)
        except ImportError:
            raise Unreadable("reading STEP needs cascadio, which isn't in this environment")
        scene = trimesh.load(path)
        mesh = as_mesh(scene)
        scale = UNITS.get(str(getattr(scene, "units", "") or "").rstrip("s"), None)
        if scale is None and mesh.extents.max() < 2.0:
            scale = 1000.0  # cascadio hands its tessellation over in metres
        if scale and scale != 1.0:
            mesh.apply_scale(scale)
        mesh.merge_vertices()
        return [{"name": base, "mesh": mesh, "source": base, "left_out": [], "note": "tessellated from STEP"}]
    try:
        loaded = trimesh.load(path, force="mesh") if not low.endswith((".glb", ".gltf")) else as_mesh(trimesh.load(path))
    except Exception as e:
        raise Unreadable(f"can't read {base}: {e}")
    if not isinstance(loaded, trimesh.Trimesh) or len(loaded.faces) == 0:
        raise Unreadable(f"{base} has no triangles")
    return [{"name": base, "mesh": loaded, "source": base, "left_out": [], "note": None}]


def as_mesh(scene):
    if isinstance(scene, trimesh.Trimesh):
        return scene
    meshes = [g for g in scene.dump() if isinstance(g, trimesh.Trimesh)] if hasattr(scene, "dump") else []
    if not meshes:
        raise Unreadable("no triangles in it")
    return trimesh.util.concatenate(meshes)


CORE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
PROD = "http://schemas.microsoft.com/3dmanufacturing/production/2015/06"
VERTEX = re.compile(rb'<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"')
TRIANGLE = re.compile(rb'<triangle\s+v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"')


def matrix_3mf(text):
    """A 3MF transform ("m00 m01 m02 m10 ... m32", row vectors) as a 4x4 for column vectors."""
    if not text:
        return np.eye(4)
    v = [float(x) for x in text.split()]
    if len(v) != 12:
        return np.eye(4)
    m = np.array(v).reshape(4, 3)
    out = np.eye(4)
    out[:3, :3] = m[:3].T
    out[:3, 3] = m[3]
    return out


def mesh_3mf(data, obj_id):
    """One object's mesh out of a model file's bytes, by its id (regex for speed, ElementTree when that's unsure)."""
    m = re.search(rb'<object\b[^>]*\bid="%s"[^>]*>(.*?)</object>' % obj_id.encode(), data, re.S)
    if not m or b"<mesh" not in m.group(1):
        return None
    body = m.group(1)
    v = np.array(VERTEX.findall(body), dtype=float)
    t = np.array(TRIANGLE.findall(body), dtype=np.int64)
    if len(v) != body.count(b"<vertex") or len(t) != body.count(b"<triangle"):
        root = ET.fromstring(b"<object xmlns='%s'>" % CORE.encode() + body + b"</object>")
        v = np.array([[float(e.get(k)) for k in "xyz"] for e in root.iter(f"{{{CORE}}}vertex")], dtype=float)
        t = np.array([[int(e.get(k)) for k in ("v1", "v2", "v3")] for e in root.iter(f"{{{CORE}}}triangle")], dtype=np.int64)
    if not len(v) or not len(t):
        return None
    return v, t


def bambu_parts(z):
    """Bambu's object and part settings: names, and each part's subtype (normal, modifier, negative, support...)."""
    try:
        root = ET.fromstring(z.read("Metadata/model_settings.config"))
    except (KeyError, ET.ParseError):
        return {}, {}, {}
    names, parts, plates = {}, {}, {}
    for o in root.findall("object"):
        oid = o.get("id")
        for md in o.findall("metadata"):
            if md.get("key") == "name":
                names[oid] = md.get("value")
        for p in o.findall("part"):
            pname = next((md.get("value") for md in p.findall("metadata") if md.get("key") == "name"), None)
            parts[(oid, p.get("id"))] = {"subtype": p.get("subtype") or "normal_part", "name": pname}
    for plate in root.findall("plate"):
        pid = next((md.get("value") for md in plate.findall("metadata") if md.get("key") == "plater_id"), None)
        for inst in plate.findall("model_instance"):
            oid = next((md.get("value") for md in inst.findall("metadata") if md.get("key") == "object_id"), None)
            if oid:
                plates.setdefault(oid, pid)
    return names, parts, plates


def read_3mf(path):
    """Each build item of a 3MF as a mesh where the plate has it, its components resolved (Bambu keeps them in
    3D/Objects/*.model), modifier, negative and support-blocker parts left out and named."""
    try:
        z = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        raise Unreadable(f"{os.path.basename(path)} isn't a 3MF (not a zip)")
    with z:
        names = {n.lstrip("/"): n for n in z.namelist()}
        main_name = next((n for n in names if n.lower() == "3d/3dmodel.model"), None) or next(
            (n for n in names if n.lower().endswith(".model")), None)
        if not main_name:
            raise Unreadable("no 3D model in the 3MF")
        cache = {}

        def data_of(p):
            p = (p or main_name).lstrip("/")
            if p not in cache:
                cache[p] = z.read(names.get(p, p))
            return cache[p]

        main = data_of(main_name)
        root = ET.fromstring(main)
        unit = UNITS.get(root.get("unit") or "millimeter", 1.0)
        objects = {o.get("id"): o for o in root.iter(f"{{{CORE}}}object")}
        obj_names, part_types, plates = bambu_parts(z)

        def resolve(oid, file, T, top, out, left, depth=0):
            if depth > 8:
                return
            if file and file.lstrip("/") != main_name:
                d = data_of(file)
                got = mesh_3mf(d, oid)
                if got is not None:
                    out.append((got, T))
                    return
                inner = re.search(rb'<object\b[^>]*\bid="%s"[^>]*>(.*?)</object>' % oid.encode(), d, re.S)
                comps = re.findall(rb"<component\b([^>]*)/?>", inner.group(1)) if inner else []
                for c in comps:
                    a = dict(re.findall(rb'(\S+?)="([^"]*)"', c))
                    resolve(a.get(b"objectid", b"").decode(), (a.get(b"p:path") or file.encode()).decode(),
                            T @ matrix_3mf(a.get(b"transform", b"").decode()), top, out, left, depth + 1)
                return
            o = objects.get(oid)
            if o is None:
                return
            if o.find(f"{{{CORE}}}mesh") is not None:
                got = mesh_3mf(main, oid)
                if got is not None:
                    out.append((got, T))
                return
            comps = o.find(f"{{{CORE}}}components")
            for c in (comps if comps is not None else []):
                cid = c.get("objectid")
                sub = part_types.get((top, cid), {}).get("subtype", "normal_part") if depth == 0 else "normal_part"
                if sub != "normal_part":
                    left.append(f"{part_types[(top, cid)].get('name') or 'part ' + cid} ({sub.replace('_', ' ')})")
                    continue
                resolve(cid, c.get(f"{{{PROD}}}path"), T @ matrix_3mf(c.get("transform")), top, out, left, depth + 1)

        models = []
        build = root.find(f"{{{CORE}}}build")
        items = build.findall(f"{{{CORE}}}item") if build is not None else []
        for n, item in enumerate(items):
            if item.get("printable") == "0":
                continue
            oid = item.get("objectid")
            pieces, left = [], []
            resolve(oid, item.get(f"{{{PROD}}}path"), matrix_3mf(item.get("transform")), oid, pieces, left)
            meshes = []
            for (v, t), T in pieces:
                v = v * unit
                v = trimesh.transform_points(v, T) if not np.allclose(T, np.eye(4)) else v
                meshes.append(trimesh.Trimesh(vertices=v, faces=t, process=True))
            if not meshes:
                continue
            mesh = trimesh.util.concatenate(meshes) if len(meshes) > 1 else meshes[0]
            label = obj_names.get(oid) or o_name(objects.get(oid)) or f"object {oid}"
            models.append({"name": label, "mesh": mesh, "left_out": left, "object_id": oid, "plate": plates.get(oid),
                           "note": None, "transform": matrix_3mf(item.get("transform"))})
        # The same name on several objects (eight copies of one glide): number them so each can be told apart.
        seen = {}
        for m in models:
            seen[m["name"]] = seen.get(m["name"], 0) + 1
        counts = dict(seen)
        for m in reversed(models):
            if counts[m["name"]] > 1:
                m["name"] = f"{m['name']} #{seen[m['name']]}"
                seen[m["name"].rsplit(' #', 1)[0]] -= 1
        return models


def o_name(o):
    return o.get("name") if o is not None else None


def plate_boxes(path, plate=1):
    """What a sliced 3MF says each object occupies on the plate, from Metadata/plate_N.json: [(name, [x0,y0,x1,y1])]."""
    try:
        with zipfile.ZipFile(path) as z:
            j = json.loads(z.read(f"Metadata/plate_{plate}.json"))
        return [(b.get("name"), b.get("bbox")) for b in j.get("bbox_objects", []) if b.get("bbox")]
    except Exception:
        return []


# Measuring


def r(x, n=2):
    return None if x is None or (isinstance(x, float) and not math.isfinite(x)) else round(float(x), n)


def mesh_health(m):
    """Whether it's a closed, consistent solid, and what isn't."""
    edges = m.edges_sorted
    if len(edges):
        _, counts = np.unique(edges, axis=0, return_counts=True)
        open_edges, nonmanifold = int((counts == 1).sum()), int((counts > 2).sum())
    else:
        open_edges = nonmanifold = 0
    areas = m.area_faces
    degenerate = int((areas < 1e-10).sum())
    watertight = bool(m.is_watertight)
    volume = float(m.volume) if watertight else None
    return {"watertight": watertight, "winding_consistent": bool(m.is_winding_consistent), "open_edges": open_edges,
            "nonmanifold_edges": nonmanifold, "degenerate_faces": degenerate,
            "inside_out": bool(watertight and volume is not None and volume < 0)}


def split_bodies(m, limit=40):
    """The separate solids in it, biggest first, each with what it is and whether it sits inside another."""
    try:
        parts = m.split(only_watertight=False)
    except Exception:
        parts = [m]
    if len(parts) > 2000:  # a scan or a broken export: thousands of specks
        return {"count": len(parts), "bodies": [], "specks": len(parts)}
    info = []
    for p in parts:
        vol = abs(float(p.volume)) if p.is_watertight else None
        info.append({"mesh": p, "volume": vol, "extents": p.extents, "bounds": p.bounds, "faces": len(p.faces),
                     "watertight": bool(p.is_watertight)})
    info.sort(key=lambda b: -(b["volume"] if b["volume"] is not None else float(np.prod(b["extents"]))))
    bodies = []
    for i, b in enumerate(info[:limit]):
        inside = None
        for j, other in enumerate(info[:limit]):
            if j == i or not other["watertight"]:
                continue
            lo, hi = other["bounds"]
            if np.all(b["bounds"][0] >= lo - 1e-6) and np.all(b["bounds"][1] <= hi + 1e-6):
                try:
                    if other["mesh"].contains(b["mesh"].vertices[:1])[0]:
                        inside = j + 1
                        break
                except Exception:
                    pass
        tiny = (b["volume"] is not None and b["volume"] < 1.0) or float(b["extents"].max()) < 0.5
        bodies.append({"body": i + 1, "size": [r(x) for x in b["extents"]], "min": [r(x) for x in b["bounds"][0]],
                       "max": [r(x) for x in b["bounds"][1]], "volume_mm3": r(b["volume"], 1), "faces": b["faces"],
                       "watertight": b["watertight"], "inside_body": inside, "speck": bool(tiny)})
    specks = sum(1 for b in bodies if b["speck"])
    return {"count": len(parts), "bodies": bodies, "specks": specks}


def bed_fit(extents, bed=BED):
    """Whether it fits the bed as it is, on another side, or turned on the plate."""
    e = np.asarray(extents, float)
    b = np.asarray(bed, float)
    if np.all(e <= b + 1e-6):
        return {"fits": True, "how": "as it is"}
    for perm in ((0, 2, 1), (2, 1, 0), (1, 0, 2), (1, 2, 0), (2, 0, 1)):
        if np.all(e[list(perm)] <= b + 1e-6):
            return {"fits": True, "how": "only on another side"}
    if e[2] <= b[2]:
        # turned about z: the diagonal of the footprint may still fit the square bed.
        w, d = sorted(e[:2])
        for a in np.radians(np.arange(1, 90, 1)):
            if w * math.cos(a) + d * math.sin(a) <= b[0] and w * math.sin(a) + d * math.cos(a) <= b[1]:
                return {"fits": True, "how": f"turned {round(math.degrees(a))}° on the plate"}
    return {"fits": False, "how": f"too big: {r(e.max(), 1)} mm is over the {b[0]:.0f} mm bed; it needs splitting"}


def overhangs(m, zmin):
    """Downward-facing area by steepness, as it's oriented now (the bed's own contact left out), and the area on the bed."""
    n = m.face_normals
    a = m.area_faces
    cz = m.triangles_center[:, 2]
    lowest = m.vertices[m.faces][:, :, 2].max(axis=1)
    on_bed = (n[:, 2] < -0.999) & (lowest < zmin + 0.05)
    angle = np.degrees(np.arcsin(np.clip(-n[:, 2], -1, 1)))  # 90 = a flat ceiling, 0 = a wall
    out = {}
    for lo, hi in BANDS:
        sel = (~on_bed) & (angle >= lo) & (angle < hi + (1e-9 if hi == 90 else 0)) & (cz > zmin + 0.05)
        out[f"{lo}-{hi}°"] = r(a[sel].sum(), 1)
    return out, r(a[on_bed].sum(), 1)


DOWNS = {"z-": None, "z+": (math.pi, [1, 0, 0]), "y+": (-math.pi / 2, [1, 0, 0]), "y-": (math.pi / 2, [1, 0, 0]),
         "x+": (math.pi / 2, [0, 1, 0]), "x-": (-math.pi / 2, [0, 1, 0])}
"""The six ways to lay a part down, by the side that goes on the bed (z- is as it is)."""
SIDE_WORDS = {"z-": "as it is", "z+": "upside down", "y+": "on its back (+y) side", "y-": "on its front (-y) side",
              "x+": "on its right (+x) side", "x-": "on its left (-x) side"}


def turned(mesh, down):
    """A copy of the mesh with that side on the bed (at z=0)."""
    m = mesh.copy()
    rot = DOWNS[down]
    if rot is not None:
        m.apply_transform(trimesh.transformations.rotation_matrix(rot[0], rot[1]))
    m.apply_translation([0, 0, -m.bounds[0, 2]])
    return m


def orientations(mesh):
    """Each side down: its overhang by steepness, its area on the bed and its height, and a score (lower is better:
    steep overhang weighs most, area on the bed counts for it). Answers the best side and the table."""
    table = {}
    for d in DOWNS:
        m = turned(mesh, d)
        bands, bed = overhangs(m, 0.0)
        score = (bands["75-90°"] or 0) * 3 + (bands["60-75°"] or 0) * 1.5 + (bands["45-60°"] or 0) * 0.5 - (bed or 0) * 0.3
        table[d] = {"overhang_mm2": bands, "bed_mm2": bed, "height_mm": r(m.extents[2], 1), "score": r(score, 1)}
    return min(table, key=lambda d: table[d]["score"]), table


def sample_rays(m, n, seed=0):
    pts, fi = trimesh.sample.sample_surface(m, n, seed=seed)
    normals = m.face_normals[fi]
    return pts, fi, normals


FACING = 0.5
"""A wall's far side (or a gap's) must face within 60° of straight back along the ray. A ray from near a sharp edge
grazes the face beyond the edge at a slant (a 110° corner meets it at cos 0.34): that's a corner, not a wall, while
a knife edge narrower than 60° still reads as the thin wall it is."""
MAX_HITS = 10


def crossings(m, origins, dirs, src_faces):
    """Every face each ray crosses, nearest first: (ray, distance, step, facing, truncated). step is -1 where it
    leaves material (the face looks along the ray) and +1 where it enters; facing is how squarely it meets the face;
    truncated marks rays that met MAX_HITS faces, whose count can't be trusted."""
    n = len(origins)
    none = (np.zeros(0, int), np.zeros(0), np.zeros(0, int), np.zeros(0), np.zeros(n, bool))
    if not n:
        return none
    eps = 2e-3
    o = origins + dirs * eps
    tri, ray, loc = m.ray.intersects_id(o, dirs, multiple_hits=True, return_locations=True, max_hits=MAX_HITS)
    if not len(tri):
        return none
    truncated = np.bincount(ray, minlength=n) >= MAX_HITS
    d = np.einsum("ij,ij->i", loc - o[ray], dirs[ray]) + eps
    ok = (tri != src_faces[ray]) & (d > 1e-4)
    ray, d, tri = ray[ok], d[ok], tri[ok]
    c = np.einsum("ij,ij->i", m.face_normals[tri], dirs[ray])
    step = np.where(c > 0, -1, 1)
    order = np.lexsort((-step, np.round(d, 5), ray))  # at one distance, entering before leaving: doubled faces cancel
    return ray[order], d[order], step[order], np.abs(c[order]), truncated


def walk(n, hits, start, leaving):
    """Where each ray first leaves material (leaving: depth falls to 0 from start) or reaches it (depth rises to 1),
    counting every face crossed; inf where it never does, or meets that face at a slant."""
    ray, d, step, facing, _ = hits
    dist = np.full(n, np.inf)
    if not len(ray):
        return dist
    first = np.r_[True, ray[1:] != ray[:-1]]
    group = np.cumsum(first) - 1
    cs = np.cumsum(step)
    before = (cs - step)[first]
    depth = start[ray] + cs - before[group]
    idx = np.nonzero(depth <= 0 if leaving else depth >= 1)[0]
    if not len(idx):
        return dist
    idx = idx[np.r_[True, ray[idx][1:] != ray[idx][:-1]]]
    square = facing[idx] >= FACING
    dist[ray[idx][square]] = d[idx][square]
    return dist


def clusters(points, values, keep, radius, per_sample_area, limit=8, kind="wall"):
    """Groups the samples kept into regions (samples within radius of each other), thinnest first."""
    idx = np.nonzero(keep)[0]
    if not len(idx):
        return []
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    from scipy.spatial import cKDTree
    pts = points[idx]
    pairs = cKDTree(pts).query_pairs(radius, output_type="ndarray")
    g = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(len(idx), len(idx))) if len(pairs) else \
        coo_matrix((len(idx), len(idx)))
    _, labels = connected_components(g, directed=False)
    out = []
    for lab in np.unique(labels):
        sel = labels == lab
        v = values[idx][sel]
        p = pts[sel]
        k = int(np.argmin(v))
        out.append({kind: r(np.percentile(v, 10) if len(v) >= 10 else v.min()), "min": r(v.min()),
                    "area_mm2": r(sel.sum() * per_sample_area, 1), "at": [r(x, 1) for x in p[k]],
                    "from": [r(x, 1) for x in p.min(0)], "to": [r(x, 1) for x in p.max(0)], "samples": int(sel.sum())})
    out = [c for c in out if c["samples"] >= 3]
    out.sort(key=lambda c: (c[kind], -c["area_mm2"]))
    return out[:limit]


def thickness(m, samples=None, thin=0.8, gap_max=3.0, gap_flag=0.5):
    """Wall thickness and narrow gaps, by rays: from points spread evenly over the surface, inward along the normal to
    the far side of the wall, and outward to the next surface across a gap (holes, slots, clearances)."""
    area = float(m.area)
    n = int(samples or min(150000, max(6000, area / 0.25)))
    pts, fi, nrm = sample_rays(m, n)
    per = area / n
    out_hits = crossings(m, pts, nrm, fi)
    # How deep in material the point just outside each sample is: every ray ends outside, so it's minus the faces it
    # crosses on the way out. Above zero, the sample is a face buried inside the part (overlapping bodies, an inner
    # shell): no wall or gap is measured from it.
    total = np.bincount(out_hits[0], weights=out_hits[2], minlength=n) if len(out_hits[0]) else np.zeros(n)
    depth_out = np.where(out_hits[4], 0, -np.round(total)).astype(int)
    buried = depth_out >= 1
    inward = walk(n, crossings(m, pts, -nrm, fi), np.maximum(depth_out + 1, 1), leaving=True)
    outward = walk(n, out_hits, np.minimum(depth_out, 0), leaving=False)
    inward[buried] = np.inf
    outward[buried] = np.inf
    wall = np.where(np.isfinite(inward), inward, np.nan)
    hit = np.isfinite(wall)
    out = {"samples": n, "missed": int((~hit & ~buried).sum()), "buried": int(buried.sum())}
    if hit.any():
        w = wall[hit]
        w = w[w >= SLIVER] if (w >= SLIVER).any() else w
        out.update({"min": r(w.min()), "p1": r(np.percentile(w, 1)), "p5": r(np.percentile(w, 5)),
                    "median": r(np.median(w)),
                    "under_mm2": {f"{t:g}": r((w < t).sum() * per, 1) for t in (0.4, 0.8, 1.2)}})
    radius = max(1.0, 2.5 * math.sqrt(per))
    wv = np.nan_to_num(wall, nan=1e9)
    out["thin"] = clusters(pts, wv, hit & (wv >= SLIVER) & (wv < thin), radius, per, kind="wall")
    out["slivers_mm2"] = r((hit & (wv < SLIVER)).sum() * per, 1)
    g = np.where(outward <= gap_max, outward, np.nan)
    gv = np.nan_to_num(g, nan=1e9)
    real = np.isfinite(g) & (gv >= SLIVER)
    out["gap_min"] = r(gv[real].min()) if real.any() else None
    out["gaps"] = clusters(pts, gv, real & (gv < gap_flag), radius, per, kind="gap")
    out["touching_mm2"] = r((np.isfinite(g) & (gv < SLIVER)).sum() * per, 1)
    face_wall = np.full(len(m.faces), np.nan)
    if hit.any():
        tmp = np.full(len(m.faces), np.inf)
        np.minimum.at(tmp, fi[hit], wall[hit])
        face_wall = np.where(np.isfinite(tmp), tmp, np.nan)
    out["thin_mm2"] = r((hit & (wv >= SLIVER) & (wv < thin)).sum() * per, 1)
    out["_face_wall"] = face_wall
    out["_samples"] = (pts, nrm, wall, g)
    out["_spacing"] = math.sqrt(per)
    return out


def z_sections(m, step=None, max_planes=300):
    """Horizontal sections up the part: [(z, shapely geometry)], for holes and islands that start in mid-air."""
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    zmin, zmax = m.bounds[:, 2]
    h = zmax - zmin
    if h <= 0:
        return []
    step = step or max(0.2, h / max_planes)
    heights = np.arange(zmin + step / 2, zmax, step) + OFF_FACE
    try:
        lines, to3d, _ = trimesh.intersections.mesh_multiplane(m, [0, 0, 0], [0, 0, 1], heights)
    except Exception:
        return []
    out = []
    for z, segs, T in zip(heights, lines, to3d):
        if segs is None or not len(segs):
            continue
        flat = segs.reshape(-1, 2)
        p3 = trimesh.transform_points(np.c_[flat, np.zeros(len(flat))], T)[:, :2].reshape(-1, 2, 2)
        try:
            path = trimesh.load_path(p3)
            polys = [p for p in path.polygons_full if p is not None and p.area > 1e-6]
        except Exception:
            continue
        if polys:
            out.append((float(z), unary_union([Polygon(p.exterior, p.interiors) for p in polys])))
    return out


def ring_shape(ring):
    """A hole's shape: a circle with its diameter, or a slot with its width and length."""
    from shapely.geometry import Polygon
    p = Polygon(ring)
    a, per = p.area, p.length
    c = p.centroid
    circ = 4 * math.pi * a / (per * per) if per else 0
    if circ > 0.85:
        return {"shape": "round", "d": r(2 * math.sqrt(a / math.pi)), "at": [r(c.x, 1), r(c.y, 1)], "area": a}
    rect = p.minimum_rotated_rectangle
    xy = np.asarray(rect.exterior.coords)[:4]
    sides = sorted(np.linalg.norm(xy[1:] - xy[:-1], axis=1)[:2]) if len(xy) >= 3 else [0, 0]
    return {"shape": "slot", "w": r(sides[0]), "l": r(sides[1]), "at": [r(c.x, 1), r(c.y, 1)], "area": a}


def real_hole(h):
    """True for what isn't a hole: a sliver left where two faces lie on each other, or a seam."""
    return h["area"] < 0.02 or (h.get("w") or h.get("d") or 0) < 2 * SLIVER


def holes_and_islands(sections, step):
    """Vertical holes (through the layers), merged from height to height, smallest first; and islands that begin in
    mid-air (nothing under them in the section below), which print only on supports or as bridges."""
    holes = []
    floating = []
    prev = None
    for z, geom in sections:
        polys = list(getattr(geom, "geoms", [geom]))
        for p in polys:
            for ring in p.interiors:
                h = ring_shape(ring)
                if real_hole(h):
                    continue
                key = None
                for k in holes:
                    if k["shape"] == h["shape"] and abs(k["at"][0] - h["at"][0]) < 0.4 and abs(k["at"][1] - h["at"][1]) < 0.4 \
                            and abs(k["z_to"] - z) <= step * 1.6:
                        key = k
                        break
                if key is None:
                    holes.append({**h, "z_from": z, "z_to": z})
                else:
                    key["z_to"] = z
                    for f in ("d", "w"):
                        if f in h and h[f] is not None and key.get(f) is not None:
                            key[f] = min(key[f], h[f])
            if prev is not None and not p.intersects(prev) and p.area > 0.2:
                c = p.centroid
                floating.append({"z": r(z, 1), "at": [r(c.x, 1), r(c.y, 1)], "area_mm2": r(p.area, 1)})
        prev = geom
    for h in holes:
        h["z_from"], h["z_to"] = r(h["z_from"] - step / 2, 1), r(h["z_to"] + step / 2, 1)
        h.pop("area", None)
    holes.sort(key=lambda h: h.get("d") or h.get("w") or 0)
    floating.sort(key=lambda f: -f["area_mm2"])
    return holes, floating


def measure(model, thin=0.8, samples=None):
    """Everything report says about one model, and what the sheet draws from."""
    m = model["mesh"]
    lo, hi = m.bounds
    ext = m.extents
    health = mesh_health(m)
    out = {"name": model["name"], "source": model.get("source"), "triangles": int(len(m.faces)),
           "size_mm": [r(x) for x in ext], "min": [r(x) for x in lo], "max": [r(x) for x in hi],
           **health, "volume_cm3": None, "area_cm2": r(m.area / 100, 1)}
    if model.get("left_out"):
        out["left_out"] = model["left_out"]
    if model.get("note"):
        out["note"] = model["note"]
    if health["watertight"]:
        vol = abs(float(m.volume))
        out["volume_cm3"] = r(vol / 1000, 2)
        out["solid_grams"] = {k: r(vol / 1000 * d, 1) for k, d in DENSITY.items()}
    out["bodies"] = split_bodies(m)
    out["bed"] = bed_fit(ext)
    out["on_bed"] = bool(abs(lo[2]) < 0.01)
    out["overhang_mm2"], out["bed_contact_mm2"] = overhangs(m, lo[2])
    best, table = orientations(m)
    out["best_down"], out["orientations"] = best, table
    if ext.max() < 3:
        out["units_hint"] = f"only {r(ext.max(), 2)} mm across: if it should be bigger, it was saved in inches (x25.4) or metres (x1000)"
    elif ext.max() > 3000:
        out["units_hint"] = f"{r(ext.max(), 0)} mm across: maybe saved in microns or tenths"
    t = thickness(m, samples=samples, thin=thin) if len(m.faces) else {}
    out["wall"] = {k: v for k, v in t.items() if not k.startswith("_") and k not in ("thin", "gaps", "gap_min", "touching_mm2", "slivers_mm2")}
    out["wall"]["under_thin_mm2"] = out["wall"].pop("thin_mm2", None)
    out["touching_mm2"] = t.get("touching_mm2")
    out["sliver_mm2"] = t.get("slivers_mm2")
    out["thin_walls"] = t.get("thin", [])
    out["gap_min"] = t.get("gap_min")
    out["narrow_gaps"] = t.get("gaps", [])
    step = max(0.2, ext[2] / 300)
    secs = z_sections(m, step=step)
    holes, floating = holes_and_islands(secs, step)
    out["holes"] = holes[:12]
    out["hole_count"] = len(holes)
    out["floating"] = floating[:8]
    out["floating_count"] = len(floating)
    out["problems"] = problems(out, thin)
    return out, {"face_wall": t.get("_face_wall"), "samples": t.get("_samples"), "spacing": t.get("_spacing"),
                 "sections": secs}


def problems(o, thin):
    """What could go wrong printing it, in plain words, worst first."""
    p = []
    if not o["bed"]["fits"]:
        p.append(o["bed"]["how"])
    if o.get("units_hint"):
        p.append(o["units_hint"])
    if not o["watertight"]:
        if o["open_edges"]:
            p.append(f"not a closed solid: {o['open_edges']} open edges"
                     + (f" and {o['nonmanifold_edges']} shared by more than two faces" if o["nonmanifold_edges"] else "")
                     + " (the slicer repairs small holes; check its preview)")
        elif o["nonmanifold_edges"]:
            p.append(f"{o['nonmanifold_edges']} edges are shared by more than two faces, where pieces touch along an edge "
                     "(usually harmless: the slicer merges them)")
        else:
            p.append("not a closed solid (its faces don't wind consistently)")
    if o.get("inside_out"):
        p.append("its faces point inward (inside out)")
    b = o["bodies"]
    if b.get("specks", 0) and b["count"] > 1:
        p.append(f"{b['specks']} stray speck(s) besides the part (near-zero size; harmless, the slicer drops them)")
    nested = [x["body"] for x in b.get("bodies", []) if x.get("inside_body")]
    if nested:
        p.append(f"body {', '.join(map(str, nested))} sits inside another (a hidden shell or a duplicate)")
    w = o.get("wall") or {}
    if o["thin_walls"]:
        worst = o["thin_walls"][0]
        under4 = (w.get("under_mm2") or {}).get("0.4") or 0
        total = w.get("under_thin_mm2") or sum(c["area_mm2"] for c in o["thin_walls"])
        p.append(f"walls under {thin:g} mm over {total:g} mm²: thinnest {worst['wall']} mm near {worst['at']}"
                 + (f"; {under4:g} mm² is under one 0.4 mm line and won't print" if under4 >= 1 else ""))
    if o["narrow_gaps"]:
        g = o["narrow_gaps"][0]
        p.append(f"gaps under 0.5 mm (they may fuse shut): narrowest {g['gap']} mm near {g['at']}")
    if (o.get("touching_mm2") or 0) >= 1:
        p.append(f"{o['touching_mm2']:g} mm² of faces lie on each other (overlapping or touching pieces; the slicer unites them)")
    small = [h for h in o["holes"] if (h.get("d") or h.get("w") or 9) < 1.0]
    if small:
        h = small[0]
        p.append(f"{len(small)} vertical hole(s) under 1 mm: smallest {'Ø' + str(h['d']) if h.get('d') else str(h['w']) + ' mm wide'}"
                 f" at {h['at']} (they print undersize; drill or ream)")
    if o["floating"]:
        f = o["floating"][0]
        p.append(f"{o['floating_count']} island(s) start in mid-air as it's oriented (the first at z {f['z']}, near {f['at']}): "
                 "supports or a bridge")
    now, best = o["orientations"]["z-"], o["orientations"][o["best_down"]]
    steep_now, steep_best = (now["overhang_mm2"]["75-90°"] or 0) + (now["overhang_mm2"]["60-75°"] or 0), \
        (best["overhang_mm2"]["75-90°"] or 0) + (best["overhang_mm2"]["60-75°"] or 0)
    if o["best_down"] != "z-" and steep_now >= 30 and steep_best <= steep_now * 0.6:
        p.append(f"{steep_now:g} mm² overhangs past 60° as it's oriented (supports or bridges); "
                 f"{SIDE_WORDS[o['best_down']]} it has {steep_best:g} mm²")
    elif steep_now >= 30:
        p.append(f"{steep_now:g} mm² overhangs past 60° (supports or bridges); no other side down does much better")
    if not o["on_bed"]:
        p.append(f"it doesn't sit on z=0 (its bottom is at z {o['min'][2]}); the slicer drops it onto the bed")
    return p


# Drawing


def plane_frame(normal, up_hint=None):
    """Two axes in a plane with this normal, for drawing it: u to the right, v up."""
    n = np.asarray(normal, float)
    n = n / np.linalg.norm(n)
    hint = np.array(up_hint if up_hint is not None else ([0, 0, 1] if abs(n[2]) < 0.9 else [0, 1, 0]), float)
    v = hint - n * (hint @ n)
    v /= np.linalg.norm(v)
    u = np.cross(v, n)
    return u, v, n


VIEWS = {
    "iso": ([-1, 1, -0.8], [0, 0, 1]), "iso-back": ([1, -1, -0.8], [0, 0, 1]),
    "top": ([0, 0, -1], [0, 1, 0]), "bottom": ([0, 0, 1], [0, 1, 0]),
    "front": ([0, 1, 0], [0, 0, 1]), "back": ([0, -1, 0], [0, 0, 1]),
    "left": ([1, 0, 0], [0, 0, 1]), "right": ([-1, 0, 0], [0, 0, 1]),
}
"""Where each named view looks (the direction from the eye into the scene) and which way is up. front looks along +y,
as Bambu Studio's front view does."""


def view_dir(view):
    if isinstance(view, str):
        if view not in VIEWS:
            raise ValueError(f"unknown view {view!r}: use {', '.join(VIEWS)} or a direction [x, y, z]")
        d, up = VIEWS[view]
    else:
        d, up = list(view), [0, 0, 1]
        if abs(np.dot(np.asarray(d, float) / np.linalg.norm(d), [0, 0, 1])) > 0.95:
            up = [0, 1, 0]
    d = np.asarray(d, float)
    return d / np.linalg.norm(d), np.asarray(up, float)


def box_planes(box):
    lo, hi = np.asarray(box[:3], float), np.asarray(box[3:], float)
    planes = []
    for axis in range(3):
        n = np.zeros(3)
        n[axis] = 1
        planes += [(lo, n), (hi, n)]
    return planes


def crop(m, box):
    """The part of a mesh inside a box [x0, y0, z0, x1, y1, z1], cut faces capped when it's closed."""
    lo, hi = np.asarray(box[:3], float), np.asarray(box[3:], float)
    out = m
    cap = bool(m.is_watertight)
    for axis in range(3):
        for sign, val in ((1, lo[axis]), (-1, hi[axis])):
            n = np.zeros(3)
            n[axis] = sign
            o = np.zeros(3)
            o[axis] = val
            try:
                out = out.slice_plane(o, n, cap=cap)
            except Exception:
                out = out.slice_plane(o, n, cap=False)
            if out is None or not len(out.faces):
                raise ValueError(f"nothing of the model is inside the box {list(box)}")
    return out


def cut(m, origin, normal):
    """The mesh with what's on the normal's far side cut away, the cut capped when it's closed: a half-section."""
    n = -np.asarray(normal, float)
    try:
        return m.slice_plane(origin, n, cap=bool(m.is_watertight))
    except Exception:
        return m.slice_plane(origin, n, cap=False)


def render(m, view="iso", width=900, height=None, face_rgb=None, caps=None, margin=0.06, samples=None, frame=None):
    """A shaded orthographic picture of the mesh by ray casting (Embree): faces lit from over the eye's shoulder,
    outlines where depth jumps and creases where faces turn, the inside of the shell (seen through a cut or an open
    mesh) in a salmon pink. face_rgb colours faces (n, 3) in 0..1; samples (points, normals, rgb) colour each pixel
    as the nearest sample facing the same way, so a big triangle spanning thick and thin shows both. Answers the
    image and how to place points on it. frame: points to fit the picture to instead of the mesh's own (so pictures
    of different meshes from one side line up)."""
    d, up = view_dir(view)
    right = np.cross(d, up)
    right /= np.linalg.norm(right)
    upv = np.cross(right, d)
    pts = m.vertices if frame is None else np.asarray(frame, float)
    pu, pv = pts @ right, pts @ upv
    u0, u1, v0, v1 = pu.min(), pu.max(), pv.min(), pv.max()
    span_u, span_v = max(u1 - u0, 1e-3), max(v1 - v0, 1e-3)
    pad = max(span_u, span_v) * margin
    u0, u1, v0, v1 = u0 - pad, u1 + pad, v0 - pad, v1 + pad
    if height is None:
        height = int(width * (v1 - v0) / (u1 - u0))
        height = max(120, min(height, int(width * 1.4)))
    scale = max((u1 - u0) / width, (v1 - v0) / height)
    cu, cv = (u0 + u1) / 2, (v0 + v1) / 2
    xs = (np.arange(width) + 0.5 - width / 2) * scale + cu
    ys = (height / 2 - np.arange(height) - 0.5) * scale + cv
    gu, gv = np.meshgrid(xs, ys)
    depth0 = float(min((pts @ d).min(), (m.vertices @ d).min())) - 10
    origins = gu.reshape(-1, 1) * right + gv.reshape(-1, 1) * upv + depth0 * d
    dirs = np.tile(d, (len(origins), 1))
    tri, ray, loc = m.ray.intersects_id(origins, dirs, multiple_hits=False, return_locations=True)
    H, W = height, width
    face = np.full(H * W, -1)
    depth = np.full(H * W, np.inf)
    face[ray] = tri
    depth[ray] = (loc - origins[ray]) @ d
    face, depth = face.reshape(H, W), depth.reshape(H, W)
    hit = face >= 0
    img = np.ones((H, W, 3))
    nrm = np.zeros((H, W, 3))
    nrm[hit] = m.face_normals[face[hit]]
    facing = -(nrm @ d)
    light = -d + 0.6 * upv - 0.35 * right
    light /= np.linalg.norm(light)
    lam = np.abs(nrm @ light)
    shade = 0.32 + 0.68 * lam
    base = np.tile(np.array([0.72, 0.75, 0.80]), (H, W, 1))
    if face_rgb is not None:
        base[hit] = face_rgb[face[hit]]
    if samples is not None and len(samples[0]) and hit.any():
        from scipy.spatial import cKDTree
        spts, snrm, srgb = samples
        where = np.zeros((H * W, 3))
        where[ray] = loc
        flat = hit.reshape(-1)
        k = min(6, len(spts))
        _, idx = cKDTree(spts).query(where[flat], k=k)
        idx = idx.reshape(len(idx), -1)
        agree = np.einsum("ijk,ik->ij", snrm[idx], m.face_normals[face.reshape(-1)[flat]]) > 0.5
        pick = idx[np.arange(len(idx)), np.where(agree.any(1), agree.argmax(1), 0)]
        b = base.reshape(-1, 3)
        b[flat] = srgb[pick]
        base = b.reshape(H, W, 3)
    back = hit & (facing < 0)
    base[back] = [0.93, 0.55, 0.50]
    if caps:
        fc = m.triangles_center[face[hit]]
        fn = m.face_normals[face[hit]]
        on = np.zeros(len(fc), bool)
        for o, n in caps:
            o, n = np.asarray(o, float), np.asarray(n, float) / np.linalg.norm(n)
            on |= (np.abs((fc - o) @ n) < 1e-4) & (np.abs(fn @ n) > 0.999)
        sel = np.zeros_like(hit)
        sel[hit] = on
        base[sel] = [0.93, 0.55, 0.50]
        # hatch the cut, as a drawing would
        yy, xx = np.nonzero(sel)
        stripe = ((xx + yy) // 4) % 3 == 0
        base[yy[stripe], xx[stripe]] = [0.80, 0.36, 0.32]
    img[hit] = base[hit] * shade[hit, None]
    # outlines: depth jumps and background edges, then creases
    edge = np.zeros((H, W), bool)
    crease = np.zeros((H, W), bool)
    dz = np.where(hit, depth, 1e9)
    jump = scale * 4
    for dy, dx in ((0, 1), (1, 0)):
        a, b = dz[: H - dy, : W - dx], dz[dy:, dx:]
        e = np.abs(a - b) > jump
        edge[: H - dy, : W - dx] |= e
        na, nb = nrm[: H - dy, : W - dx], nrm[dy:, dx:]
        c = (np.einsum("ijk,ijk->ij", na, nb) < 0.82) & ~e
        crease[: H - dy, : W - dx] |= c
    img[crease & hit] *= 0.6
    img[edge] = [0.1, 0.1, 0.12]
    proj = {"right": right, "up": upv, "cu": cu, "cv": cv, "scale": scale, "W": W, "H": H, "d": d, "depth": depth,
            "depth0": depth0, "face": face}
    return (np.clip(img, 0, 1) * 255).astype(np.uint8), proj


def to_pixel(proj, p):
    """Where a point lands on a rendered view, and whether it's in sight there (not behind something)."""
    p = np.asarray(p, float)
    x = (p @ proj["right"] - proj["cu"]) / proj["scale"] + proj["W"] / 2
    y = proj["H"] / 2 - (p @ proj["up"] - proj["cv"]) / proj["scale"]
    xi, yi = int(x), int(y)
    seen = False
    if 0 <= xi < proj["W"] and 0 <= yi < proj["H"]:
        d = p @ proj["d"] - proj["depth0"]
        seen = bool(d <= proj["depth"][yi, xi] + max(1.0, proj["scale"] * 6))
    return x, y, seen


def wall_colors(face_wall, thin=0.8):
    """Faces coloured by wall thickness: red under one 0.4 mm line, orange under the threshold, yellow under 1.5x it."""
    n = len(face_wall)
    rgb = np.tile(np.array([0.72, 0.75, 0.80]), (n, 1))
    w = np.nan_to_num(face_wall, nan=1e9)
    rgb[w < thin * 1.5] = [0.98, 0.85, 0.35]
    rgb[w < thin] = [0.97, 0.55, 0.15]
    rgb[w < NOZZLE] = [0.86, 0.12, 0.12]
    return rgb


def overhang_colors(m, zmin):
    n = m.face_normals
    angle = np.degrees(np.arcsin(np.clip(-n[:, 2], -1, 1)))
    rgb = np.tile(np.array([0.72, 0.75, 0.80]), (len(n), 1))
    above = m.triangles_center[:, 2] > zmin + 0.05
    rgb[above & (angle >= 45)] = [0.98, 0.85, 0.35]
    rgb[above & (angle >= 60)] = [0.97, 0.55, 0.15]
    rgb[above & (angle >= 75)] = [0.86, 0.12, 0.12]
    return rgb


def body_colors(m):
    palette = np.array([[0.40, 0.62, 0.86], [0.95, 0.60, 0.25], [0.45, 0.75, 0.45], [0.85, 0.40, 0.55],
                        [0.65, 0.55, 0.85], [0.55, 0.80, 0.80], [0.85, 0.75, 0.40], [0.60, 0.60, 0.60]])
    labels = trimesh.graph.connected_component_labels(m.face_adjacency, node_count=len(m.faces))
    sizes = np.bincount(labels)
    rank = np.argsort(-sizes)
    order = np.empty_like(rank)
    order[rank] = np.arange(len(rank))
    return palette[order[labels] % len(palette)]


def colors_for(m, mode, thin=0.8, face_wall=None):
    if mode in (None, "plain"):
        return None
    if mode == "thickness":
        if face_wall is None:
            face_wall = thickness(m, thin=thin)["_face_wall"]
        return wall_colors(face_wall, thin)
    if mode == "overhang":
        return overhang_colors(m, m.bounds[0, 2])
    if mode == "bodies":
        return body_colors(m)
    raise ValueError(f"unknown color {mode!r}: plain, thickness, overhang or bodies")


# Sections


def section_polys(m, origin, normal, up_hint=None):
    """A plane's cut through the mesh as shapely geometry in the plane's own (u, v) coordinates, and that frame."""
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    u, v, n = plane_frame(normal, up_hint)
    o = np.asarray(origin, float)
    segs = trimesh.intersections.mesh_plane(m, n, o)
    if segs is None or not len(segs):
        return None, (o, u, v, n)
    d = segs - o
    uv = np.stack([d @ u, d @ v], axis=-1)
    try:
        path = trimesh.load_path(uv)
        polys = [Polygon(p.exterior, p.interiors) for p in path.polygons_full if p is not None and p.area > 1e-8]
    except Exception:
        polys = []
    if not polys:
        return None, (o, u, v, n)
    return unary_union(polys), (o, u, v, n)


def ray_widths(geom, outward=False, spacing=None, reach=5.0):
    """Across the material (or across the gaps, outward) from points along every edge of a section: the shortest
    crossing and where it is. [(width, p, q)] sorted, thinnest first."""
    from shapely.geometry.polygon import orient
    polys = [orient(p, 1.0) for p in getattr(geom, "geoms", [geom]) if p.area > 0]
    A, B = [], []
    for p in polys:
        for ring in [p.exterior, *p.interiors]:
            c = np.asarray(ring.coords)
            A.append(c[:-1])
            B.append(c[1:])
    if not A:
        return []
    A, B = np.vstack(A), np.vstack(B)
    E = B - A
    L = np.linalg.norm(E, axis=1)
    good = L > 1e-9
    A, B, E, L = A[good], B[good], E[good], L[good]
    span = max(np.ptp(np.vstack([A, B]), axis=0).max(), 1e-3)
    h = spacing or max(span / 800, 0.01)
    reps = np.maximum(1, np.floor(L / h).astype(int))
    seg = np.repeat(np.arange(len(A)), reps)
    t = (np.concatenate([np.arange(k) for k in reps]) + 0.5) / np.repeat(reps, reps)
    P = A[seg] + E[seg] * t[:, None]
    N = np.stack([-E[seg, 1], E[seg, 0]], axis=1) / L[seg, None]  # material is on the left of every ring now
    if outward:
        N = -N
    best = np.full(len(P), np.inf)
    for s in range(0, len(P), 400):
        p, nv = P[s:s + 400, None, :], N[s:s + 400, None, :]
        q, e = A[None], E[None]
        denom = nv[..., 0] * e[..., 1] - nv[..., 1] * e[..., 0]
        qp = q - p
        with np.errstate(divide="ignore", invalid="ignore"):
            tt = (qp[..., 0] * e[..., 1] - qp[..., 1] * e[..., 0]) / denom
            ss = (qp[..., 0] * nv[..., 1] - qp[..., 1] * nv[..., 0]) / denom
        ok = (np.abs(denom) > 1e-12) & (ss >= 0) & (ss <= 1) & (tt > SLIVER)
        ok &= np.arange(len(A))[None, :] != seg[s:s + 400, None]
        tt = np.where(ok, tt, np.inf)
        best[s:s + 400] = tt.min(axis=1)
    if outward:
        best[best > reach] = np.inf
    fin = np.isfinite(best)
    if not fin.any():
        return []
    order = np.argsort(best)
    out = []
    for i in order[:200]:
        if not np.isfinite(best[i]):
            break
        out.append((float(best[i]), P[i], P[i] + N[i] * best[i]))
    return out


def outline_points(geom2d, spacing):
    """Points evenly spread along every ring of a section, and the outward normal in the plane at each."""
    from shapely.geometry.polygon import orient
    P, N = [], []
    for p in getattr(geom2d, "geoms", [geom2d]):
        if p.is_empty or p.area <= 0:
            continue
        p = orient(p, 1.0)  # material on the left of every ring
        for ring in [p.exterior, *p.interiors]:
            c = np.asarray(ring.coords)
            a, e = c[:-1], c[1:] - c[:-1]
            L = np.linalg.norm(e, axis=1)
            ok = L > 1e-9
            a, e, L = a[ok], e[ok], L[ok]
            if not len(a):
                continue
            reps = np.maximum(1, np.ceil(L / spacing).astype(int))
            seg = np.repeat(np.arange(len(a)), reps)
            t = (np.concatenate([np.arange(k) for k in reps]) + 0.5) / np.repeat(reps, reps)
            P.append(a[seg] + e[seg] * t[:, None])
            N.append(np.stack([e[seg, 1], -e[seg, 0]], axis=1) / L[seg, None])
    if not P:
        return np.zeros((0, 2)), np.zeros((0, 2))
    return np.vstack(P), np.vstack(N)


def lifter(plane):
    """Section coordinates (as in_world gives them) back into the model's 3D: points, and directions."""
    o = np.asarray(plane["origin"], float)
    if plane["axis"] is None:
        u, v, _ = plane_frame(plane["normal"], plane["up"])
        return (lambda P: o + P[:, :1] * u + P[:, 1:2] * v), (lambda N: N[:, :1] * u + N[:, 1:2] * v)
    a = plane["axis"]
    i, j = {0: (1, 2), 1: (0, 2), 2: (0, 1)}[a]

    def lift(P, along=True):
        X = np.zeros((len(P), 3))
        X[:, i], X[:, j] = P[:, 0], P[:, 1]
        if along:
            X[:, a] = o[a]
        return X
    return lift, (lambda N: lift(N, along=False))


def surface_values(points3, normals3, samples, reach):
    """The 3D wall thickness and gap at points on the surface, from the nearest thickness sample facing their way
    (nan where none is within reach)."""
    from scipy.spatial import cKDTree
    spts, snrm, wall, gap = samples
    wall_out = np.full(len(points3), np.nan)
    gap_out = np.full(len(points3), np.nan)
    if not len(points3) or not len(spts):
        return wall_out, gap_out
    k = min(8, len(spts))
    _, idx = cKDTree(spts).query(points3, k=k, distance_upper_bound=reach)
    idx = idx.reshape(len(points3), -1)
    valid = idx < len(spts)
    safe = np.where(valid, idx, 0)
    agree = valid & (np.einsum("ijk,ik->ij", snrm[safe], normals3) > 0.0)
    has = agree.any(axis=1)
    pick = safe[np.arange(len(safe)), agree.argmax(axis=1)]
    wall_out[has] = wall[pick[has]]
    gap_out[has] = gap[pick[has]]
    return wall_out, gap_out


def section_facts(geom, plane=None, samples=None, spacing=None, window=None):
    """What a section holds: its islands, its holes (round with a diameter, or slots), its thinnest wall and narrowest
    gap, with where each is. With the model's thickness samples, walls and gaps are the model's own, measured in 3D at
    each point of the outline (a cut that crosses a wall at a slant still reads the wall's true thickness); without,
    they're measured across the section in its plane. window (x0, y0, x1, y1) keeps only what's inside it."""
    if window is not None:
        from shapely.geometry import box as sbox
        whole, geom = geom, geom.intersection(sbox(*window))
    polys = [p for p in getattr(geom, "geoms", [geom]) if getattr(p, "area", 0) > 0]
    minx, miny, maxx, maxy = geom.bounds
    holes = []
    for p in polys:
        for ring in p.interiors:
            h = ring_shape(ring)
            if not real_hole(h):
                holes.append(h)
    for h in holes:
        h.pop("area", None)
    holes.sort(key=lambda h: h.get("d") or h.get("w") or 0)
    out = {"islands": len(polys), "area_mm2": r(geom.area, 1), "width": r(maxx - minx), "height": r(maxy - miny),
           "from": [r(minx), r(miny)], "to": [r(maxx), r(maxy)], "holes": holes[:12]}
    if samples is not None and plane is not None:
        span = max(maxx - minx, maxy - miny, 1e-3)
        P, N = outline_points(whole if window is not None else geom, min(span / 600, max(0.05, (spacing or 0.5) / 2)))
        if window is not None:
            inside = (P[:, 0] > window[0]) & (P[:, 0] < window[2]) & (P[:, 1] > window[1]) & (P[:, 1] < window[3])
            P, N = P[inside], N[inside]
        lift, lift_dir = lifter(plane)
        wall, gap = surface_values(lift(P), lift_dir(N), samples, reach=max(1.0, 3 * (spacing or 0.5)))
        out["_outline"] = (P, N, wall, gap)
        out["measured"] = "3d"
        ok = np.isfinite(wall) & (wall >= SLIVER)
        if ok.any():
            i = int(np.nanargmin(np.where(ok, wall, np.inf)))
            out["thinnest_wall"] = {"mm": r(wall[i]), "at": [r(P[i, 0]), r(P[i, 1])],
                                    "toward": [r(P[i, 0] - N[i, 0] * wall[i]), r(P[i, 1] - N[i, 1] * wall[i])]}
        okg = np.isfinite(gap) & (gap >= SLIVER)
        if okg.any():
            i = int(np.nanargmin(np.where(okg, gap, np.inf)))
            out["narrowest_gap"] = {"mm": r(gap[i]), "at": [r(P[i, 0]), r(P[i, 1])],
                                    "toward": [r(P[i, 0] + N[i, 0] * gap[i]), r(P[i, 1] + N[i, 1] * gap[i])]}
        out.setdefault("thinnest_wall", None)
        out.setdefault("narrowest_gap", None)
        return out
    walls = ray_widths(geom)
    gaps = ray_widths(geom, outward=True)
    w = walls[0] if walls else None
    g = gaps[0] if gaps else None
    out["measured"] = "in the plane"
    out["thinnest_wall"] = None if not w else {"mm": r(w[0]), "at": [r(w[1][0]), r(w[1][1])], "toward": [r(w[2][0]), r(w[2][1])]}
    out["narrowest_gap"] = None if not g else {"mm": r(g[0]), "at": [r(g[1][0]), r(g[1][1])], "toward": [r(g[2][0]), r(g[2][1])]}
    return out


def draw_geom(ax, geom, face="#3d4654", edge="#111111", lw=0.8, alpha=1.0, fill=True, ls="-"):
    from matplotlib.patches import PathPatch
    from matplotlib.path import Path
    for p in getattr(geom, "geoms", [geom]):
        if p.is_empty:
            continue
        verts, codes = [], []
        for ring in [p.exterior, *p.interiors]:
            c = np.asarray(ring.coords)
            verts.append(c)
            codes += [Path.MOVETO] + [Path.LINETO] * (len(c) - 2) + [Path.CLOSEPOLY]
        path = Path(np.vstack(verts), codes)
        ax.add_patch(PathPatch(path, facecolor=face if fill else "none", edgecolor=edge, lw=lw, alpha=alpha, ls=ls))


def style_axes(ax, xlabel, ylabel, window):
    from matplotlib.ticker import AutoMinorLocator
    x0, y0, x1, y1 = window
    ax.set_xlim(x0, x1)
    ax.set_ylim(y0, y1)
    ax.set_aspect("equal")
    ax.grid(True, which="major", color="#c9ced6", lw=0.6)
    ax.grid(True, which="minor", color="#e6e9ee", lw=0.4)
    ax.xaxis.set_minor_locator(AutoMinorLocator())
    ax.yaxis.set_minor_locator(AutoMinorLocator())
    ax.set_xlabel(xlabel, fontsize=9)
    ax.set_ylabel(ylabel, fontsize=9)
    ax.tick_params(labelsize=8)
    ax.set_axisbelow(True)


def annotate_section(ax, facts, small_hole=5.0, thin=0.8):
    """The thin stretches of the outline in the thickness colours, the thinnest wall and narrowest gap with a line
    across each, and the small holes' sizes."""
    if facts.get("_outline") is not None:
        P, _, wall, _ = facts["_outline"]
        sel = np.isfinite(wall) & (wall >= SLIVER) & (wall < thin * 1.5)
        if sel.any():
            ax.scatter(P[sel, 0], P[sel, 1], c=wall_colors(wall[sel], thin), s=7, lw=0, zorder=3)
    w, g = facts.get("thinnest_wall"), facts.get("narrowest_gap")
    if w:
        ax.plot([w["at"][0], w["toward"][0]], [w["at"][1], w["toward"][1]], color="#e0281f", lw=2.4, solid_capstyle="butt", zorder=4)
        ax.plot([w["at"][0]], [w["at"][1]], "o", ms=11, mfc="none", mec="#e0281f", mew=1.8, zorder=4)
        ax.annotate(f"wall {w['mm']}", (w["at"][0], w["at"][1]), xytext=(8, 8), textcoords="offset points",
                    color="#c41e16", fontsize=9, fontweight="bold", zorder=5,
                    bbox=dict(boxstyle="round,pad=0.2", fc="white", ec="#e0281f", lw=0.8, alpha=0.9))
    if g:
        ax.plot([g["at"][0], g["toward"][0]], [g["at"][1], g["toward"][1]], color="#1f6fe0", lw=2.4, solid_capstyle="butt", zorder=4)
        ax.plot([g["at"][0]], [g["at"][1]], "o", ms=11, mfc="none", mec="#1f6fe0", mew=1.8, zorder=4)
        ax.annotate(f"gap {g['mm']}", (g["at"][0], g["at"][1]), xytext=(8, -16), textcoords="offset points",
                    color="#1556b0", fontsize=9, fontweight="bold", zorder=5,
                    bbox=dict(boxstyle="round,pad=0.2", fc="white", ec="#1f6fe0", lw=0.8, alpha=0.9))
    x0, x1 = ax.get_xlim()
    placed = []
    for h in facts.get("holes", []):
        size = h.get("d") or h.get("w")
        if size is None or size > small_hole or len(placed) >= 8:
            continue
        if any(math.hypot(h["at"][0] - a, h["at"][1] - b) < (x1 - x0) * 0.05 for a, b in placed):
            continue
        placed.append(tuple(h["at"]))
        label = f"Ø{h['d']}" if h.get("d") else f"{h['w']}×{h['l']}"
        ax.annotate(label, (h["at"][0], h["at"][1]), xytext=(0, 0), textcoords="offset points", ha="center",
                    va="center", fontsize=7.5, color="#0f6a2e", fontweight="bold", zorder=5,
                    bbox=dict(boxstyle="round,pad=0.12", fc="white", ec="none", alpha=0.75))


def window_of(geom, box2=None, pad=0.08):
    if box2 is not None:
        return box2
    minx, miny, maxx, maxy = geom.bounds
    span = max(maxx - minx, maxy - miny, 0.5)
    p = span * pad
    return (minx - p, miny - p, maxx + p, maxy + p)


AXES = {"x": 0, "y": 1, "z": 2}


def off_face(m, axis, at):
    """A section's position moved a hair off a flat face lying exactly there (a cut along a face gives slivers)."""
    flat = np.abs(m.face_normals[:, axis]) > 0.999
    if flat.any() and np.any(np.abs(m.triangles_center[flat, axis] - at) < 2e-3):
        return at + OFF_FACE
    return at


def plane_spec(spec, m):
    """One section's plane from what was asked: {axis, at}, {origin, normal}, or a name like "z=5.4"."""
    if isinstance(spec, str):
        mt = re.fullmatch(r"\s*([xyz])\s*=\s*(-?[\d.]+)\s*", spec)
        if not mt:
            raise ValueError(f"can't read the section {spec!r}: give z=5.4, or {{origin, normal}}")
        spec = {"axis": mt[1], "at": float(mt[2])}
    if "axis" in spec:
        a = AXES[spec["axis"]]
        n = np.zeros(3)
        n[a] = 1
        o = m.bounds.mean(axis=0).copy()
        o[a] = off_face(m, a, float(spec["at"]))
        up = [0, 0, 1] if a != 2 else [0, 1, 0]
        names = {0: ("y", "z"), 1: ("x", "z"), 2: ("x", "y")}[a]
        return {"origin": o, "normal": n, "up": up, "label": f"{spec['axis']} = {o[a]:.4g} mm", "axis": a,
                "names": names}
    o = np.asarray(spec["origin"], float)
    n = np.asarray(spec["normal"], float)
    return {"origin": o, "normal": n / np.linalg.norm(n), "up": spec.get("up"),
            "label": f"through ({', '.join(f'{x:g}' for x in o)}) facing ({', '.join(f'{x:.2g}' for x in n)})",
            "axis": None, "names": ("u", "v")}


def in_world(geom, plane):
    """A section's geometry in the model's own coordinates when the plane is axis-aligned (x-y for z cuts, x-z for y
    cuts, y-z for x cuts); in the plane's (u, v) from its origin otherwise."""
    if plane["axis"] is None:
        return geom
    u, v, _ = plane_frame(plane["normal"], plane["up"])
    i, j = {0: (1, 2), 1: (0, 2), 2: (0, 1)}[plane["axis"]]
    from shapely import affinity
    # (u, v) -> world: world_i = o_i + u_i*U + v_i*V, with u and v along the world axes i and j (up to sign).
    o = plane["origin"]
    return affinity.affine_transform(geom, [u[i], v[i], u[j], v[j], o[i], o[j]])


def box_window(plane, box):
    """The part of a crop box a section's drawing shows, in the section's own axes."""
    if box is None or plane["axis"] is None:
        return None
    i, j = {0: (1, 2), 1: (0, 2), 2: (0, 1)}[plane["axis"]]
    return (box[i], box[j], box[3 + i], box[3 + j])


def around_box(around, radius):
    c = np.asarray(around, float)
    return [*(c - radius), *(c + radius)]


# G-code layers

FEATURE_COLORS = {
    "outer wall": "#e8412c", "external perimeter": "#e8412c", "inner wall": "#f39a2b", "perimeter": "#f39a2b",
    "overhang wall": "#c2185b", "overhang perimeter": "#c2185b", "sparse infill": "#b0b6bf", "internal infill": "#b0b6bf",
    "internal solid infill": "#8e44ad", "solid infill": "#8e44ad", "top surface": "#22a7c9", "top solid infill": "#22a7c9",
    "bottom surface": "#7a5230", "bridge": "#2c5fe8", "bridge infill": "#2c5fe8", "internal bridge": "#5b7fe8",
    "gap infill": "#222222", "support": "#3aa655", "support interface": "#9be05a", "support transition": "#2a7a3e",
    "brim": "#5d6d7e", "skirt": "#5d6d7e", "floating vertical shell": "#e8c32c", "ironing": "#77c9d4",
    "prime tower": "#999999", "wipe tower": "#999999", "custom": "#cccccc",
}


def gcode_text(path, plate=None):
    """A sliced plate's G-code: a .gcode file as it is, or Metadata/plate_N.gcode out of a .gcode.3mf."""
    if path.lower().endswith(".3mf") or zipfile.is_zipfile(path):  # a blob comes without its name
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if re.fullmatch(r"Metadata/plate_\d+\.gcode", n)]
            if not names:
                raise Unreadable("this 3MF isn't sliced: there's no G-code in it (slice it first)")
            want = f"Metadata/plate_{plate}.gcode" if plate else sorted(names)[0]
            if want not in names:
                raise Unreadable(f"it has no plate {plate}: it holds {', '.join(sorted(names))}")
            return z.read(want).decode("utf-8", "replace"), int(re.search(r"plate_(\d+)", want)[1])
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read(), None


NUM = re.compile(r"([XYZEIJRF])(-?\d*\.?\d+)")


def parse_layers(text, want=None, box=None, arc_step=0.15):
    """The layers of a G-code: [{z, height}] for every one, and for the indexes in want, every extruding move as a
    segment (x0, y0, x1, y1, feature, width), arcs (G2/G3, I/J or R) cut into short chords, within box (x0, y0, x1,
    y1) when given."""
    layers = []
    segs = {}
    want = set(want or ())
    x = y = 0.0
    z = 0.0
    absolute_e = False
    last_e = 0.0
    feature = ""
    width = NOZZLE * 1.05
    cur = -1
    for line in text.splitlines():
        if not line:
            continue
        c = line[0]
        if c == ";":
            s = line[1:].strip()
            low = s.lower()
            try:
                if low in ("change_layer", "layer_change"):  # the marker alone: the config's layer_change_gcode isn't one
                    cur = len(layers)
                    layers.append({"z": None, "height": None, "z_move": None})
                elif low.startswith(("z_height:", "z:")) and cur >= 0 and layers[cur]["z"] is None:
                    layers[cur]["z"] = float(s.split(":", 1)[1])
                elif low.startswith(("layer_height:", "height:")) and cur >= 0 and layers[cur]["height"] is None:
                    layers[cur]["height"] = float(s.split(":", 1)[1])
                elif low.startswith(("feature:", "type:")):
                    feature = s.split(":", 1)[1].strip()
                elif low.startswith(("line_width:", "width:")):
                    width = float(s.split(":", 1)[1])
            except ValueError:
                pass
            continue
        if c not in "GM":
            continue
        code = line.split(";", 1)[0].split()
        if not code:
            continue
        cmd = code[0]
        if cmd == "M82":
            absolute_e = True
            continue
        if cmd == "M83":
            absolute_e = False
            continue
        if cmd == "G92":
            for k, v in NUM.findall(line.split(";", 1)[0]):
                if k == "E":
                    last_e = float(v)
            continue
        if cmd not in ("G0", "G1", "G2", "G3"):
            continue
        args = dict(NUM.findall(line.split(";", 1)[0]))
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
        extruding = e is not None and e > 0 and cmd != "G0"
        if extruding and cur >= 0 and layers[cur]["z_move"] is None:
            layers[cur]["z_move"] = z
        if extruding and cur in want:
            pts = [(x, y)]
            if cmd in ("G2", "G3"):
                pts = arc_points(x, y, nx, ny, args, cmd == "G2", arc_step)
            else:
                pts.append((nx, ny))
            for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
                if box is not None and (max(ax, bx) < box[0] or min(ax, bx) > box[2] or max(ay, by) < box[1] or min(ay, by) > box[3]):
                    continue
                segs.setdefault(cur, []).append((ax, ay, bx, by, feature, width))
        x, y = nx, ny
    for i, L in enumerate(layers):
        if L["z"] is None:
            L["z"] = L["z_move"] if L["z_move"] is not None else (layers[i - 1]["z"] if i else 0.0)
        if L["height"] is None:
            L["height"] = (L["z"] - layers[i - 1]["z"]) if i else L["z"]
    return layers, segs


def arc_points(x0, y0, x1, y1, args, clockwise, step):
    """An arc move as points from its start to its end: centre from I/J (relative to the start) or radius R; a full
    circle when it ends where it began."""
    if "I" in args or "J" in args:
        cx, cy = x0 + float(args.get("I", 0)), y0 + float(args.get("J", 0))
    elif "R" in args:
        rr = float(args["R"])
        mx, my = (x0 + x1) / 2, (y0 + y1) / 2
        dx, dy = x1 - x0, y1 - y0
        q = math.hypot(dx, dy)
        if q == 0 or abs(rr) < q / 2:
            return [(x0, y0), (x1, y1)]
        hgt = math.sqrt(rr * rr - (q / 2) ** 2)
        sgn = 1 if (rr > 0) != clockwise else -1
        cx, cy = mx - sgn * hgt * dy / q, my + sgn * hgt * dx / q
    else:
        return [(x0, y0), (x1, y1)]
    rad = math.hypot(x0 - cx, y0 - cy)
    a0 = math.atan2(y0 - cy, x0 - cx)
    a1 = math.atan2(y1 - cy, x1 - cx)
    if clockwise:
        sweep = a0 - a1
        if sweep <= 1e-9:
            sweep += 2 * math.pi
        sweep = -sweep
    else:
        sweep = a1 - a0
        if sweep <= 1e-9:
            sweep += 2 * math.pi
    n = max(2, int(abs(sweep) * rad / step) + 1, int(abs(sweep) / math.radians(8)) + 1)
    ts = np.linspace(0, 1, n + 1)
    return [(cx + rad * math.cos(a0 + sweep * t), cy + rad * math.sin(a0 + sweep * t)) for t in ts]


def feature_color(name):
    return FEATURE_COLORS.get((name or "").strip().lower(), "#888888")


def draw_layer(ax, segs, window, fig_px_per_mm=None):
    """Extrusions drawn as beads as wide as the G-code says, coloured by feature."""
    from matplotlib.collections import LineCollection
    if not segs:
        return {}
    arr = np.array([(a, b, c, d) for a, b, c, d, _, _ in segs])
    feats = [s[4] for s in segs]
    widths = np.array([s[5] for s in segs])
    x0, y0, x1, y1 = window
    ax.set_xlim(x0, x1)
    ax.set_ylim(y0, y1)
    ax.set_aspect("equal")
    ax.figure.canvas.draw()
    bbox = ax.get_window_extent()
    pts_per_mm = (bbox.width / ax.figure.dpi * 72) / (x1 - x0)
    lines = arr.reshape(-1, 2, 2)
    colors = [feature_color(f) for f in feats]
    ax.add_collection(LineCollection(lines, colors=colors, linewidths=np.maximum(widths * pts_per_mm * 0.92, 0.3),
                                     capstyle="round", alpha=0.95, zorder=2))
    length = {}
    seglen = np.hypot(arr[:, 2] - arr[:, 0], arr[:, 3] - arr[:, 1])
    for f, L in zip(feats, seglen):
        length[f] = length.get(f, 0.0) + float(L)
    return {k: r(v, 1) for k, v in sorted(length.items(), key=lambda kv: -kv[1])}
