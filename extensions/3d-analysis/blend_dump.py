"""Runs inside Blender, for mesh's scene files (.blend, and FBX, glTF, OBJ, USD imported into an empty scene):

    Blender -b --factory-startup --disable-autoexec [FILE.blend] --python blend_dump.py -- JOB.json OUT.json OUT.npz

It reads the scene as Blender would show it (modifiers applied, instances made real, curves and text as meshes) and
writes what mesh needs to split it: OUT.json says the scene's units, every object (what it is, whether it's shown,
why it's left out) and every material (its colour and where the colour comes from: a plain colour, an image texture,
a colour attribute, or nodes it can't read); OUT.npz holds the triangles of the objects kept, in Blender units and
world space, with each triangle's object, material and the colour it shows (sRGB, 0..1, sampled from its texture or
colour attribute where it has one). Nothing in the file runs (--disable-autoexec), and nothing is written but OUT.
"""

import json
import math
import os
import sys
import traceback

import bpy
import numpy as np

GEOMETRY = ("MESH", "CURVE", "SURFACE", "FONT", "META")
IMPORTERS = {
    ".fbx": lambda p: bpy.ops.import_scene.fbx(filepath=p),
    ".glb": lambda p: bpy.ops.import_scene.gltf(filepath=p),
    ".gltf": lambda p: bpy.ops.import_scene.gltf(filepath=p),
    ".obj": lambda p: bpy.ops.wm.obj_import(filepath=p),
    ".usd": lambda p: bpy.ops.wm.usd_import(filepath=p),
    ".usda": lambda p: bpy.ops.wm.usd_import(filepath=p),
    ".usdc": lambda p: bpy.ops.wm.usd_import(filepath=p),
    ".usdz": lambda p: bpy.ops.wm.usd_import(filepath=p),
}


def to_srgb(c):
    """Blender keeps colours scene-linear; a filament's colour is said in sRGB."""
    c = np.clip(np.asarray(c, np.float64), 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def hexof(rgb):
    return "".join(f"{int(round(float(x) * 255)):02X}" for x in np.clip(rgb, 0, 1)[:3])


def upstream(socket, depth=0, seen=None):
    """The nodes feeding a socket, nearest first (through mixes, hue and the like)."""
    seen = seen if seen is not None else set()
    out = []
    if depth > 12 or not socket.is_linked:
        return out
    for link in socket.links:
        n = link.from_node
        if n.name in seen:
            continue
        seen.add(n.name)
        out.append((depth, n, link.from_socket))
        for s in n.inputs:
            out += upstream(s, depth + 1, seen)
    return out


def shader_of(mat):
    """The shader node the material's output shows, and its base colour input."""
    if not mat or not mat.use_nodes or not mat.node_tree:
        return None, None
    outs = [n for n in mat.node_tree.nodes if n.type == "OUTPUT_MATERIAL"]
    out = next((n for n in outs if n.is_active_output), outs[0] if outs else None)
    if not out or not out.inputs["Surface"].is_linked:
        return None, None
    for _, n, _ in [(0, out.inputs["Surface"].links[0].from_node, None)] + upstream(out.inputs["Surface"]):
        for key in ("Base Color", "Color"):
            if key in n.inputs and n.type in ("BSDF_PRINCIPLED", "BSDF_DIFFUSE", "EMISSION", "BSDF_GLOSSY", "PRINCIPLED_VOLUME",
                                              "SUBSURFACE_SCATTERING", "BSDF_SHEEN", "BSDF_TRANSLUCENT", "BSDF_TOON"):
                return n, n.inputs[key]
    return None, None


def describe_material(mat):
    """How a material is coloured: {name, hex, source: plain|texture|attribute|procedural|none, image?, attribute?, uv?}."""
    if mat is None:
        return {"name": None, "hex": "B8BEC8", "source": "none"}
    node, base = shader_of(mat)
    viewport = hexof(to_srgb(mat.diffuse_color[:3]))
    if base is None:
        return {"name": mat.name, "hex": viewport, "source": "plain", "note": "no shader node with a base colour; its viewport colour"}
    if not base.is_linked:
        return {"name": mat.name, "hex": hexof(to_srgb(base.default_value[:3])), "source": "plain"}
    found = upstream(base)
    for _, n, _ in found:
        if n.type == "TEX_IMAGE" and n.image is not None:
            uv = None
            vec = n.inputs.get("Vector")
            if vec is not None and vec.is_linked:
                src = vec.links[0].from_node
                if src.type == "UVMAP" and src.uv_map:
                    uv = src.uv_map
            return {"name": mat.name, "hex": viewport, "source": "texture", "image": n.image.name, "uv": uv,
                    "_image": n.image, "projection": n.projection}
    for _, n, _ in found:
        if n.type in ("ATTRIBUTE", "VERTEX_COLOR"):
            name = getattr(n, "attribute_name", None) or getattr(n, "layer_name", None) or ""
            return {"name": mat.name, "hex": viewport, "source": "attribute", "attribute": name}
    rgb = [n for _, n, _ in found if n.type == "RGB"]
    if rgb and len(found) == 1:
        return {"name": mat.name, "hex": hexof(to_srgb(rgb[0].outputs[0].default_value[:3])), "source": "plain"}
    kinds = sorted({n.type.lower() for _, n, _ in found})[:4]
    return {"name": mat.name, "hex": viewport, "source": "procedural",
            "note": f"its colour comes from nodes ({', '.join(kinds)}); the viewport colour stands in for it"}


IMAGE_CACHE = {}


def image_pixels(img):
    """An image's pixels as (H, W, 4) floats in sRGB, or None when it isn't there (not packed, path missing)."""
    if img.name in IMAGE_CACHE:
        return IMAGE_CACHE[img.name]
    px = None
    try:
        w, h = img.size
        if w and h:
            a = np.empty(w * h * img.channels, np.float32)
            img.pixels.foreach_get(a)
            a = a.reshape(h, w, img.channels)
            if img.channels < 3:
                a = np.repeat(a[..., :1], 3, axis=2)
            a = a[..., :3]
            if img.is_float or img.colorspace_settings.name.lower() in ("linear", "linear rec.709", "non-color", "linear srgb"):
                a = to_srgb(a).astype(np.float32)
            px = a
    except Exception:
        px = None
    IMAGE_CACHE[img.name] = px
    return px


def sample_image(px, uv):
    """Nearest pixel at each uv (n, 2), repeating outside 0..1 as Blender's default does."""
    h, w = px.shape[:2]
    x = np.clip((np.mod(uv[:, 0], 1.0) * w).astype(np.int64), 0, w - 1)
    y = np.clip((np.mod(uv[:, 1], 1.0) * h).astype(np.int64), 0, h - 1)
    return px[y, x]


def tri_colors(me, info, tri_loops, tri_verts, nt):
    """Each triangle's colour for one material's triangles (sRGB), and a note when it couldn't be read."""
    base = np.array([int(info["hex"][i:i + 2], 16) / 255 for i in (0, 2, 4)], np.float32)
    src = info["source"]
    if src == "texture":
        px = image_pixels(info["_image"])
        layer = None
        if info.get("uv") and info["uv"] in me.uv_layers:
            layer = me.uv_layers[info["uv"]]
        elif me.uv_layers:
            layer = next((u for u in me.uv_layers if u.active_render), None) or me.uv_layers.active
        if px is None:
            info["note"] = f"its texture {info['image']} isn't in the file (not packed); its viewport colour stands in"
        elif layer is None:
            info["note"] = "it has a texture but no UV map; its viewport colour stands in"
        else:
            uv = np.empty(len(me.loops) * 2, np.float32)
            layer.data.foreach_get("uv", uv)
            uv = uv.reshape(-1, 2)[tri_loops.reshape(-1, 3)]  # (nt, 3, 2)
            c = uv.mean(axis=1)
            pts = [c] + [uv[:, k] * (2 / 3) + c * (1 / 3) for k in range(3)]  # the middle and three points toward the corners
            samples = np.stack([sample_image(px, p) for p in pts], axis=1)  # (nt, 4, 3)
            return np.median(samples, axis=1).astype(np.float32)
    if src == "attribute":
        attrs = me.color_attributes
        a = attrs.get(info.get("attribute") or "") if info.get("attribute") else None
        a = a or attrs.active_color or (attrs[0] if len(attrs) else None)
        if a is None:
            info["note"] = "it reads a colour attribute the mesh doesn't have; its viewport colour stands in"
        else:
            vals = np.empty(len(a.data) * 4, np.float32)
            try:
                a.data.foreach_get("color_srgb", vals)
            except Exception:
                a.data.foreach_get("color", vals)
                vals = to_srgb(vals).astype(np.float32)
            vals = vals.reshape(-1, 4)[:, :3]
            idx = tri_loops if a.domain == "CORNER" else tri_verts
            return vals[idx.reshape(-1, 3)].mean(axis=1).astype(np.float32)
    return np.tile(base, (nt, 1))


def modifiers_of(ob):
    return [{"type": m.type.lower(), "name": m.name, "on": bool(m.show_viewport and m.show_render)} for m in ob.modifiers]


def cutters():
    """Objects other objects cut with (Boolean modifiers): left out unless asked for."""
    used = {}
    for ob in bpy.data.objects:
        for m in getattr(ob, "modifiers", []):
            if m.type == "BOOLEAN" and m.show_render:
                if getattr(m, "operand_type", "OBJECT") == "OBJECT" and m.object is not None:
                    used.setdefault(m.object.name, ob.name)
                elif getattr(m, "collection", None) is not None:
                    for o in m.collection.all_objects:
                        used.setdefault(o.name, ob.name)
    return used


def picker(all_names, words):
    """Which names a list of words picks: each word picks the object named exactly that (any case), else every
    object whose name has it in it."""
    picked = set()
    if isinstance(words, str):
        words = [words]
    for w in words or []:
        w = str(w).strip().lower()
        exact = {n for n in all_names if n.lower() == w}
        picked |= exact or {n for n in all_names if w and w in n.lower()}
    return picked


def reveal(names):
    """Objects asked for by name are shown, even when hidden or in a collection left out of the view layer."""
    def walk(lc):
        yield lc
        for c in lc.children:
            yield from walk(c)
    layer = bpy.context.view_layer
    for ob in bpy.data.objects:
        if ob.name not in names:
            continue
        ob.hide_viewport = False
        for lc in walk(layer.layer_collection):
            if ob.name in lc.collection.all_objects:
                lc.exclude = False
                lc.hide_viewport = False
                lc.collection.hide_viewport = False
        if ob.name in layer.objects:
            ob.hide_set(False)
    layer.update()


def main():
    args = sys.argv[sys.argv.index("--") + 1:]
    job_path, out_json, out_npz = args[:3]
    with open(job_path) as f:
        job = json.load(f)
    imported = None
    ext = os.path.splitext(job["file"])[1].lower()
    if ext != ".blend":
        bpy.ops.wm.read_factory_settings(use_empty=True)
        if ext not in IMPORTERS:
            raise ValueError(f"Blender here doesn't import {ext} files")
        IMPORTERS[ext](job["file"])
        imported = ext
    names = [ob.name for ob in bpy.data.objects]
    include, exclude = picker(names, job.get("include")), picker(names, job.get("exclude"))
    if job.get("include") and not include:
        raise ValueError(f"nothing in it is named like {', '.join(map(str, job['include']))}: it has "
                         + ", ".join(n for n in names if bpy.data.objects[n].type in GEOMETRY)[:600])
    scene = bpy.context.scene
    us = scene.unit_settings
    cut_by = cutters()

    # Every object, and whether it's kept (as the file has it: one shown because it was asked for still says it was hidden)
    objects = {}
    for ob in bpy.data.objects:
        reasons = []
        shown = bool(ob.visible_get()) if ob.name in bpy.context.view_layer.objects else False
        if ob.type not in GEOMETRY:
            reasons.append(f"a {ob.type.lower()}, not geometry")
        if not shown:
            reasons.append("hidden in the viewport" if ob.name in bpy.context.view_layer.objects else "not in the scene's view layer")
        if ob.hide_render:
            reasons.append("hidden from renders")
        if ob.display_type in ("WIRE", "BOUNDS"):
            reasons.append(f"shown as {ob.display_type.lower()} only (a helper)")
        if ob.name in cut_by:
            reasons.append(f"cuts {cut_by[ob.name]} (a Boolean's cutter)")
        objects[ob.name] = {"name": ob.name, "type": ob.type.lower(), "shown": shown, "render": not ob.hide_render,
                            "collection": ob.users_collection[0].name if ob.users_collection else None,
                            "parent": ob.parent.name if ob.parent else None, "modifiers": modifiers_of(ob),
                            "materials": [s.material.name if s.material else None for s in ob.material_slots],
                            "why_not": reasons, "instances": 0}

    for n in include:
        if n in objects and objects[n]["why_not"]:
            objects[n]["note"] = "shown because it was asked for: " + "; ".join(objects[n]["why_not"])
            objects[n]["why_not"] = [w for w in objects[n]["why_not"] if "not geometry" in w]
    reveal(include)

    def keep(names, default_ok):
        if any(n in exclude for n in names):
            return False, "left out as asked"
        if include:
            return (True, None) if any(n in include for n in names) else (False, "not among those asked for")
        return default_ok, None

    # Their geometry, as Blender shows it
    dg = bpy.context.evaluated_depsgraph_get()
    materials, mat_index = [], {}
    verts, faces, t_obj, t_mat, t_rgb = [], [], [], [], []
    kept_names, offset = [], 0
    seen_eval = set()
    for inst in dg.object_instances:
        ob = inst.object
        orig = ob.original
        if ob.type not in GEOMETRY:
            continue
        holder = inst.parent.original if inst.is_instance and inst.parent is not None else orig
        rec = objects.get(orig.name)
        hold = objects.get(holder.name) if holder is not orig else rec
        if rec is None:
            continue
        if inst.is_instance:
            rec["instances"] += 1
            default_ok = hold is not None and not [w for w in hold["why_not"] if "not geometry" not in w]
            label = f"{orig.name} (in {holder.name})"
        else:
            default_ok = not rec["why_not"]
            label = orig.name
        ok, why = keep([orig.name, holder.name] if inst.is_instance else [orig.name], default_ok)
        if not ok:
            if why and why not in rec["why_not"]:
                rec["why_not"].append(why)
            continue
        try:
            me = ob.to_mesh()
        except Exception as e:
            rec["why_not"].append(f"Blender couldn't make a mesh of it: {e}")
            continue
        if me is None or not len(me.polygons):
            if me is not None:
                ob.to_mesh_clear()
            rec["why_not"].append("it has no faces")
            continue
        me.calc_loop_triangles()
        nt = len(me.loop_triangles)
        nv = len(me.vertices)
        co = np.empty(nv * 3, np.float32)
        me.vertices.foreach_get("co", co)
        M = np.array(inst.matrix_world, np.float64)
        co = co.reshape(-1, 3).astype(np.float64) @ M[:3, :3].T + M[:3, 3]
        tv = np.empty(nt * 3, np.int32)
        me.loop_triangles.foreach_get("vertices", tv)
        tl = np.empty(nt * 3, np.int32)
        me.loop_triangles.foreach_get("loops", tl)
        tm = np.empty(nt, np.int32)
        me.loop_triangles.foreach_get("material_index", tm)
        tri = tv.reshape(-1, 3)
        if np.linalg.det(M[:3, :3]) < 0:  # mirrored by a negative scale: keep the faces facing out
            tri = tri[:, ::-1]
            tl = tl.reshape(-1, 3)[:, ::-1].reshape(-1)
            tv = tri.reshape(-1)
        slots = [s.material for s in ob.material_slots]
        gm = np.full(nt, -1, np.int32)
        rgb = np.zeros((nt, 3), np.float32)
        for local in np.unique(tm):
            sel = tm == local
            mat = slots[local] if 0 <= local < len(slots) else None
            key = mat.name if mat else None
            if key not in mat_index:
                mat_index[key] = len(materials)
                materials.append(describe_material(mat))
            g = mat_index[key]
            gm[sel] = g
            info = materials[g]
            cols = tri_colors(me, info, tl.reshape(-1, 3)[sel].reshape(-1), tv.reshape(-1, 3)[sel].reshape(-1), int(sel.sum()))
            rgb[sel] = cols
        oi = len(kept_names)
        kept_names.append(label)
        verts.append(co.astype(np.float32))
        faces.append(tri.astype(np.int64) + offset)
        t_obj.append(np.full(nt, oi, np.int32))
        t_mat.append(gm)
        t_rgb.append(rgb)
        offset += nv
        rec.setdefault("kept_as", []).append(oi)
        rec["triangles"] = rec.get("triangles", 0) + nt
        lo, hi = co.min(axis=0), co.max(axis=0)
        rec["size_bu"] = [round(float(x), 6) for x in (hi - lo)]
        ob.to_mesh_clear()
        seen_eval.add(orig.name)

    for m in materials:
        m.pop("_image", None)
    info = {"blender": bpy.app.version_string, "imported": imported,
            "units": {"system": us.system, "scale_length": us.scale_length, "length_unit": us.length_unit},
            "objects": list(objects.values()), "kept": kept_names, "materials": materials}
    if verts:
        np.savez(out_npz, verts=np.concatenate(verts), faces=np.concatenate(faces).astype(np.int32),
                 tri_obj=np.concatenate(t_obj), tri_mat=np.concatenate(t_mat), tri_rgb=np.concatenate(t_rgb))
    info["ok"] = True
    with open(out_json, "w") as f:
        json.dump(info, f)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        out_json = sys.argv[sys.argv.index("--") + 2]
        with open(out_json, "w") as f:
            json.dump({"ok": False, "error": f"{type(e).__name__}: {e}", "traceback": traceback.format_exc()[-3000:]}, f)
