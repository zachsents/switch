"""variants: a parametric model's variants built from its own script and measured side by side, so trying rib counts or
wall thicknesses never means sed on the script and a loop of uv runs that fetch a Python each time.

The script is plain Python that builds a model and exports it (trimesh, manifold3d, numpy, shapely, scipy: the worker's
own environment, built once). Each variant's values reach it however the script reads them:

- a top-level assignment (`N, T, RC = 8, 1.2, 4.5`, `ZFULL = ZB + 12`, inside a top-level if or with too) is pinned:
  `N = 6` goes in right after every statement that assigns N, so the name holds the variant's value wherever it's read
  and what's derived from it follows;
- every value is also in the environment (os.environ["RC"], as text) and in a global dict PARAMS;
- an argv template (["{out}", "--n", "{N}"]) fills sys.argv for a script that reads argparse.

A name the script neither assigns at the top, reads by its quoted name, nor puts in the argv template fails before
anything runs, so a typo never gives a set of identical variants. Each variant runs in its own process (the worker's
Python, no uv on the way), in a folder of its own that is its cwd and OUT, two at a time; the models it writes there are
renamed by what it varied and measured as report measures them (size, bed fit, closed, bodies, volume and grams, walls,
gaps, mid-air islands, steep overhangs, problems); a sheet sets each variant's model side by side, coloured by wall
thickness, with a section at the same plane through each when one's asked for.

Run as a script (python -I variants.py JOB.json) it runs one variant: what op_variants starts for each.
"""

import ast
import fnmatch
import json
import os
import re
import shutil
import string
import subprocess
import sys
import threading
import time
import traceback

MODEL_EXTS = (".stl", ".3mf", ".obj", ".ply", ".off", ".glb", ".gltf", ".step", ".stp")
DEFS = (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)
NOT_LITERAL = object()
MAX_VARIANTS = 24
MAX_MODELS = 48
CONCURRENT = 2
"""Variants built at once: each is a Python with numpy and manifold3d (a few hundred MB), so a 16 GB machine holds a few."""


# The script's knobs


def targets_of(stmt):
    """The plain names a statement assigns: N = …, N, T = …, N: float = …, N += …, (a, (b, c)) = …."""
    names = []

    def walk(t):
        if isinstance(t, ast.Name):
            names.append(t.id)
        elif isinstance(t, (ast.Tuple, ast.List)):
            for e in t.elts:
                walk(e)
        elif isinstance(t, ast.Starred):
            walk(t.value)

    if isinstance(stmt, ast.Assign):
        for t in stmt.targets:
            walk(t)
    elif isinstance(stmt, (ast.AnnAssign, ast.AugAssign)):
        walk(stmt.target)
    return names


def literal(node):
    try:
        return ast.literal_eval(node)
    except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError):
        return NOT_LITERAL


def as_written(stmt, name):
    """The value a statement gives name when it's a literal (8 in `N, T = 8, 1.2`), else NOT_LITERAL."""
    if isinstance(stmt, ast.Assign):
        for t in stmt.targets:
            if isinstance(t, ast.Name) and t.id == name:
                return literal(stmt.value)
            if isinstance(t, (ast.Tuple, ast.List)) and isinstance(stmt.value, (ast.Tuple, ast.List)) \
                    and len(t.elts) == len(stmt.value.elts):
                for te, ve in zip(t.elts, stmt.value.elts):
                    if isinstance(te, ast.Name) and te.id == name:
                        return literal(ve)
    if isinstance(stmt, ast.AnnAssign) and stmt.value is not None:
        return literal(stmt.value)
    return NOT_LITERAL


def inner_bodies(stmt):
    """The statement lists inside a top-level compound statement (if, with, try, for, while, match), never a def's or
    a class's: names assigned there are still the script's own."""
    if isinstance(stmt, DEFS):
        return []
    out = []
    for attr in ("body", "orelse", "finalbody"):
        v = getattr(stmt, attr, None)
        if isinstance(v, list) and v and isinstance(v[0], ast.stmt):
            out.append((stmt, attr))
    for h in getattr(stmt, "handlers", None) or []:
        out.append((h, "body"))
    for c in getattr(stmt, "cases", None) or []:
        out.append((c, "body"))
    return out


def knobs(tree):
    """Every name the script assigns at its top level: the lines, and the value as written when it's a literal."""
    found = {}

    def scan(body):
        for stmt in body:
            for n in targets_of(stmt):
                v = as_written(stmt, n)
                k = found.setdefault(n, {"lines": [], "value": NOT_LITERAL})
                k["lines"].append(stmt.lineno)
                if len(k["lines"]) == 1:
                    k["value"] = v
            for owner, attr in inner_bodies(stmt):
                scan(getattr(owner, attr))

    scan(tree.body)
    return found


def pinned(stmt, name, value):
    """`name = value`, placed at stmt's line so a traceback still points at the script's own lines."""
    a = ast.parse(f"{name} = {value!r}").body[0]
    for node in ast.walk(a):
        if hasattr(node, "lineno"):
            node.lineno = node.end_lineno = stmt.lineno
            node.col_offset, node.end_col_offset = stmt.col_offset, stmt.col_offset
    return a


def pin(tree, params):
    """The script with each of params pinned after every top-level statement that assigns it."""
    def fix(body):
        out = []
        for stmt in body:
            for owner, attr in inner_bodies(stmt):
                setattr(owner, attr, fix(getattr(owner, attr)))
            out.append(stmt)
            for n in targets_of(stmt):
                if n in params:
                    out.append(pinned(stmt, n, params[n]))
        return out

    tree.body = fix(tree.body)
    return tree


def argv_fields(args):
    names = set()
    for a in args or []:
        for _, field, _, _ in string.Formatter().parse(str(a)):
            if field:
                names.add(re.split(r"[.\[]", field, maxsplit=1)[0])
    return names


def how_each(source, tree, names, args):
    """How each name asked for reaches the script, or a ValueError naming those that don't before anything runs."""
    kn = knobs(tree)
    in_argv = argv_fields(args)
    how, unused = {}, []
    for name in names:
        if name in kn:
            v = kn[name]["value"]
            how[name] = {"pinned": kn[name]["lines"], **({"as_written": v} if v is not NOT_LITERAL else {})}
        elif re.search(r"(['\"])%s\1" % re.escape(name), source):
            how[name] = {"env": True}
        elif name in in_argv:
            how[name] = {"argv": True}
        else:
            unused.append(name)
    if unused:
        lits = [f"{n} = {k['value']!r}" for n, k in kn.items() if k["value"] is not NOT_LITERAL
                and isinstance(k["value"], (int, float, str, bool))][:24]
        raise ValueError(f"the script never reads {', '.join(unused)}: it isn't assigned at its top level, read from the "
                         "environment by its quoted name, or in args" + (f". Its values: {', '.join(lits)}" if lits else ""))
    return how


def knob_list(tree):
    """The script's literal top-level values, as it has them: what can be varied."""
    out = []
    for n, k in knobs(tree).items():
        v = k["value"]
        if v is not NOT_LITERAL and isinstance(v, (int, float, str, bool)) and not n.startswith("__"):
            out.append({"name": n, "value": v, "line": k["lines"][0]})
    return out


# One variant, in its own process


def plain(v):
    """A script's value as JSON can carry it (numpy numbers and small arrays included)."""
    try:
        json.dumps(v)
        return v
    except (TypeError, ValueError):
        pass
    if hasattr(v, "tolist"):
        v = v.tolist()
        try:
            s = json.dumps(v)
            return v if len(s) < 4000 else s[:200] + "…"
        except (TypeError, ValueError):
            pass
    if isinstance(v, (tuple, set)):
        return [plain(x) for x in v]
    if isinstance(v, dict):
        return {str(k): plain(x) for k, x in v.items()}
    return str(v)[:200]


def env_text(v):
    return v if isinstance(v, str) else json.dumps(v)


def run_one(job_path):
    """Runs one variant of the script here (cwd and OUT are its folder), with its values pinned, and writes how it went."""
    with open(job_path) as f:
        job = json.load(f)
    result = {"ok": True}
    g = {}
    try:
        with open(job["script"]) as f:
            source = f.read()
        tree = pin(ast.parse(source, filename=job["script"]), job["params"])
        code = compile(ast.fix_missing_locations(tree), job["script"], "exec")
        os.chdir(job["out"])
        sys.argv = [job["script"], *job.get("argv", [])]
        sys.path[:0] = [d for d in job.get("path", []) if d]
        g = {"__name__": "__main__", "__file__": job["script"], "__builtins__": __builtins__, "OUT": job["out"],
             "PARAMS": dict(job["params"])}
        exec(code, g)
    except SystemExit as e:
        if e.code not in (None, 0):
            result = {"ok": False, "error": f"it exited with {e.code}"}
    except BaseException as e:  # noqa: BLE001: whatever the script raises is its answer
        tb = traceback.format_exc()
        result = {"ok": False, "error": f"{type(e).__name__}: {e}"[:600], "traceback": tb[-3000:]}
    read, missing = {}, []
    for name in job.get("read") or []:
        if name in g:
            read[name] = plain(g[name])
        else:
            missing.append(name)
    result["read"] = read
    if missing:
        result["unread"] = missing
    with open(job["result"], "w") as f:
        json.dump(result, f)


def argv_for(args, params, out):
    """sys.argv after the script's name: the args template filled with the variant's values and {out}."""
    fields = {**params, "out": out, "OUT": out}
    try:
        return [str(a).format(**fields) for a in args or []]
    except (KeyError, IndexError, ValueError) as e:
        raise ValueError(f"can't fill args {args!r} for {params}: {e} (it takes {{out}} and the values given)")


def tail(path, lines=12, chars=1500):
    try:
        with open(path, errors="replace") as f:
            text = f.read()
    except OSError:
        return ""
    return "\n".join(text.strip().splitlines()[-lines:])[-chars:]


def build(job, v, root):
    """Runs one variant in its own folder and answers what it made: {tag, params, files, printed, read, error}."""
    run_dir = os.path.join(root, "run", v["tag"] or "as-written")
    os.makedirs(run_dir)
    script = os.path.join(run_dir, job["script_name"])
    shutil.copyfile(job["script"], script)
    params = v["params"] or {}
    one = {"script": script, "params": params, "out": run_dir, "result": run_dir + ".result.json",
           "argv": argv_for(job.get("args"), params, run_dir),
           "read": job.get("read") or [], "path": [run_dir, job.get("script_dir")]}
    job_path = run_dir + ".job.json"
    with open(job_path, "w") as f:
        json.dump(one, f)
    env = {**os.environ, "OUT": run_dir, "MPLBACKEND": "Agg", **{k: env_text(x) for k, x in params.items()}}
    log = run_dir + ".log"
    started = time.time()
    out = {"tag": v["tag"], "label": v["label"], "params": params, "files": []}
    with open(log, "w") as lf:
        p = subprocess.Popen([sys.executable, "-I", os.path.abspath(__file__), job_path], cwd=run_dir, stdout=lf,
                             stderr=subprocess.STDOUT, env=env)
        try:
            p.wait(timeout=float(job.get("timeout") or 120))
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait()
            out["error"] = f"it ran past {float(job.get('timeout') or 120):g} s and was stopped"
    out["seconds"] = round(time.time() - started, 1)
    out["printed"] = tail(log)
    try:
        with open(one["result"]) as f:
            res = json.load(f)
    except (OSError, ValueError):
        res = {"ok": False, "error": out.get("error") or f"its Python stopped (exit {p.returncode})"}
    if not res.get("ok"):
        out["error"] = out.get("error") or res.get("error")
        if res.get("traceback"):
            out["traceback"] = res["traceback"]
    if res.get("read"):
        out["read"] = res["read"]
    if res.get("unread"):
        out["unread"] = res["unread"]
    made = []
    for d, dirs, files in os.walk(run_dir):
        dirs[:] = sorted(x for x in dirs if not x.startswith((".", "__")))
        for name in files:
            path = os.path.join(d, name)
            if name.lower().endswith(MODEL_EXTS) and not name.startswith("._"):
                made.append((os.path.getmtime(path), os.path.relpath(path, run_dir), path))
    made.sort()
    out["files"] = [{"from": rel, "path": path} for _, rel, path in made]
    return out


def wanted(name, patterns):
    if not patterns:
        return True
    low = name.lower()
    return any(fnmatch.fnmatch(low, p.lower()) if any(c in p for c in "*?[") else p.lower() in low for p in patterns)


def own_part(stem, first):
    """What sets a model's name apart from the first one its variant wrote (coupon, of glide-n8 and glide-coupon)."""
    sep = "-_. "
    k = 0
    while k < min(len(stem), len(first)) and stem[k] == first[k]:
        k += 1

    def boundary(k):
        return k == 0 or stem[k - 1] in sep or (k == len(first) and k < len(stem) and stem[k] in sep)

    while not boundary(k):
        k -= 1  # back to a word's start: glide-cap and glide-coupon differ in cap and coupon, not ap and oupon
    return stem[k:].strip(sep) or stem


def final_name(f, v, job, taken, first=None):
    """What a variant's model is called: the name template filled in (the first model it wrote by the template, any
    other with what sets its own name apart added), or its own name with the variant's tag."""
    stem, ext = os.path.splitext(os.path.basename(f["from"]))
    ext = ext.lower()
    params = v["params"] or {}
    if job.get("name"):
        try:
            base = job["name"].format(**{**params, "stem": stem, "tag": v["tag"] or "as-written"})
        except (KeyError, IndexError, ValueError) as e:
            raise ValueError(f"can't fill the name {job['name']!r}: {e} (it takes {{stem}}, {{tag}} and the values given)")
        if first is not None and "{stem}" not in job["name"]:
            base = f"{base}-{own_part(stem, first)}"
    else:
        base = f"{stem}-{v['tag']}" if v["tag"] else stem
    base = re.sub(r"[^A-Za-z0-9._=+-]+", "-", base).strip("-") or "model"
    name, k = base + ext, 2
    while name in taken:
        name, k = f"{base}-{k}{ext}", k + 1
    taken.add(name)
    return name


def fmt(v):
    if isinstance(v, bool):
        return "on" if v else "off"
    if isinstance(v, float):
        return f"{v:g}"
    return str(v)


def sha256(path):
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def differing(a, b):
    keys = sorted(set(a or {}) | set(b or {}))
    return [k for k in keys if (a or {}).get(k) != (b or {}).get(k)]


# The whole set


def op_variants(job, helpers):
    """Builds every variant, measures what each made, and draws them side by side."""
    import geom
    from geom import r

    deadline = float(job.get("deadline") or (time.time() + 540))
    say = helpers["progress"]
    with open(job["script"]) as f:
        source = f.read()
    try:
        tree = ast.parse(source, filename=job["script_name"])
    except SyntaxError as e:
        raise ValueError(f"{job['script_name']} doesn't parse: {e.msg} at line {e.lineno}")
    names = []
    for v in job["variants"]:
        for k in v["params"] or {}:
            if k not in names:
                names.append(k)
    how = how_each(source, tree, names, job.get("args"))
    for v in job["variants"]:
        argv_for(job.get("args"), v["params"] or {}, "out")  # a template it can't fill fails before anything runs
        if job.get("name"):
            final_name({"from": "model.stl"}, v, job, set())
    root = job["work_dir"]
    os.makedirs(root, exist_ok=True)
    variants = job["variants"]
    say(f"Building {len(variants)} variant{'s' if len(variants) != 1 else ''} of {job['script_name']}")
    built = [None] * len(variants)
    late = []
    lock = threading.Lock()
    queue = list(enumerate(variants))

    def worker():
        while True:
            with lock:
                if not queue:
                    return
                i, v = queue.pop(0)
                if time.time() > deadline - 60:
                    late.append(v["label"])
                    continue
            built[i] = build(job, v, root)
            with lock:
                done = sum(1 for b in built if b is not None)
            say(f"Built {done} of {len(variants)}")

    threads = [threading.Thread(target=worker) for _ in range(min(CONCURRENT, len(variants)))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    built = [b for b in built if b is not None]

    # Name what each made, and see which came out the same.
    out_dir = job["out_dir"]
    os.makedirs(out_dir, exist_ok=True)
    taken, warnings = set(), []
    for b in built:
        b["files"] = [f for f in b["files"] if wanted(f["from"], job.get("outputs"))]
        first = os.path.splitext(os.path.basename(b["files"][0]["from"]))[0] if b["files"] else None
        for i, f in enumerate(b["files"]):
            f["name"] = final_name(f, b, job, taken, first if i else None)
            dest = os.path.join(out_dir, f["name"])
            shutil.move(f["path"], dest)
            f["path"] = dest
            f["sha256"] = sha256(dest)
        if not b["files"] and not b.get("error"):
            b["error"] = ("it wrote no model where it ran" + (" matching outputs" if job.get("outputs") else "")
                          + ": write to the current folder or OUT (also in the environment and as {out} in args)")
    same = {}
    for b in built:
        for f in b["files"]:
            same.setdefault((f["from"], f["sha256"]), []).append(b)
    for (made_as, _), group in same.items():
        if len(group) > 1:
            diff = differing(group[0]["params"], group[1]["params"])
            warnings.append(f"{', '.join(g['label'] for g in group)} made the same {made_as}, byte for byte: the script "
                            f"doesn't use {', '.join(diff) or 'what they differ in'} for it")

    # Measure each model.
    thin = float(job.get("thin") or 0.8)
    material = job.get("material") or "PLA"
    total = sum(len(b["files"]) for b in built)
    if total > MAX_MODELS:
        warnings.append(f"they made {total} models; the first {MAX_MODELS} are measured")
    n, unmeasured = 0, 0
    drawn = []
    for b in built:
        pick = draw_pick(b["files"], job.get("draw"))
        for f in b["files"]:
            if n >= MAX_MODELS or time.time() > deadline - 20:
                unmeasured += 1
                continue
            n += 1
            say(f"Measuring {n} of {min(total, MAX_MODELS)}: {f['name']}")
            started = time.time()
            try:
                models = geom.load(f["path"], objects="merged", name=f["name"])
                model = models[0]
                o, extra = geom.measure(model, thin=thin)
            except Exception as e:  # noqa: BLE001: one unreadable model is that model's answer
                f["error"] = f"can't read it: {e}"
                continue
            f.update(facts(o, material, r))
            f["seconds"] = r(time.time() - started, 1)
            if f is pick:
                drawn.append({"variant": b, "file": f, "mesh": model["mesh"], "extra": extra, "o": o})
    if unmeasured:
        warnings.append(f"{unmeasured} model{'s were' if unmeasured != 1 else ' was'} left unmeasured: out of time or "
                        "past the most one call measures")
    if late:
        warnings.append(f"out of time before {', '.join(late)}: ask for fewer at once")

    sections = {}
    if job.get("sheet") and drawn:
        say("Drawing the sheet")
        sections = sheet(job, drawn, how, helpers, thin, material)
    for d in drawn:
        if id(d["file"]) in sections:
            d["file"]["section"] = sections[id(d["file"])]
    for b in built:
        for f in b["files"]:
            f.pop("sha256", None)
    return {"script": job["script_name"], "how": how, "knobs": knob_list(tree), "variants": built,
            "warnings": warnings, "sheet": job.get("sheet") if drawn and job.get("sheet") else None,
            "material": material}


def draw_pick(files, draw):
    """Which of a variant's models the sheet draws: the one draw names, else the first it wrote."""
    if not files:
        return None
    if draw:
        for f in files:
            if wanted(f["from"], [draw]) or wanted(f["name"], [draw]):
                return f
    return files[0]


def facts(o, material, r):
    """A measured model as the answer gives it: what a reader compares across variants."""
    w = o.get("wall") or {}
    z = (o.get("orientations") or {}).get("z-") or {}
    steep = z.get("overhang_mm2") or {}
    out = {"size_mm": o["size_mm"], "watertight": o["watertight"], "bodies": (o.get("bodies") or {}).get("count"),
           "volume_cm3": o.get("volume_cm3"),
           "grams": (o.get("solid_grams") or {}).get(material.upper()),
           "wall": {k: w.get(k) for k in ("min", "p1", "median") if w.get(k) is not None},
           "gap_min": o.get("gap_min"), "floating": o.get("floating_count") or 0,
           "steep_overhang_mm2": r((steep.get("60-75°") or 0) + (steep.get("75-90°") or 0), 1),
           "best_down": o.get("best_down"), "bed": o.get("bed"), "problems": o.get("problems") or [],
           "triangles": o.get("triangles")}
    if not o["watertight"]:
        out["open_edges"] = o.get("open_edges")
    if o.get("thin_walls"):
        out["thin_walls"] = [{"wall": c["wall"], "at": c["at"], "area_mm2": c["area_mm2"]} for c in o["thin_walls"][:2]]
    return out


# The sheet


def sheet(job, drawn, how, h, thin, material):
    """Each variant's model side by side, coloured by wall thickness, under what it varied and how it measures; with a
    plane, the section there through each at one scale beneath. Answers each drawn model's section facts."""
    import math

    import geom

    P = h["plt"]()
    n = len(drawn)
    cols = min(n, 6 if n != 8 else 4)
    rows = math.ceil(n / cols)
    plane_spec = job.get("plane")
    cuts, out = [], {}
    if plane_spec:
        for d in drawn:
            plane = geom.plane_spec(plane_spec, d["mesh"])
            g, _ = geom.section_polys(d["mesh"], plane["origin"], plane["normal"], plane["up"])
            if g is not None:
                g = geom.in_world(g, plane)
                f = geom.section_facts(g, plane, d["extra"].get("samples"), d["extra"].get("spacing"))
                out[id(d["file"])] = {"plane": plane["label"], **h["public"](f)}
            cuts.append((plane, g, f if g is not None else None))
        boxes = [g.bounds for _, g, _ in cuts if g is not None and not g.is_empty]
        if boxes:
            x0, y0 = min(b[0] for b in boxes), min(b[1] for b in boxes)
            x1, y1 = max(b[2] for b in boxes), max(b[3] for b in boxes)
            span = max(x1 - x0, y1 - y0, 0.5)
            pad = span * 0.06
            win = (x0 - pad, y0 - pad, x1 + pad, y1 + pad)
        else:
            win = None
    cell_w = 4.2
    view_h, text_h, cut_h = 3.6, 1.15, (3.9 if plane_spec else 0)
    head_h = 0.75
    fig_h = head_h + rows * (view_h + text_h + cut_h)
    fig = P.figure(figsize=(cell_w * cols, fig_h), dpi=100)
    per = [view_h, text_h] + ([cut_h] if plane_spec else [])
    gs = fig.add_gridspec(rows * len(per), cols, height_ratios=per * rows, hspace=0.12, wspace=0.2,
                          left=0.6 / (cell_w * cols), right=0.995, top=1 - head_h / fig_h, bottom=0.45 / fig_h)
    varied = list(how)
    title = job["script_name"] + (f" · {', '.join(varied)}" if varied else "")
    fig.text(0.01, 1 - 0.1 / fig_h, title, fontsize=14, fontweight="bold", va="top")
    for k, d in enumerate(drawn):
        row, col = divmod(k, cols)
        base = row * len(per)
        m, f, b = d["mesh"], d["file"], d["variant"]
        ax = fig.add_subplot(gs[base, col])
        walls = h["thickness_samples"](d["extra"].get("samples"), thin)
        img, _ = geom.render(m, "iso", width=520, height=440, samples=walls)
        ax.imshow(img)
        ax.axis("off")
        ax.set_title(b["label"], fontsize=12, fontweight="bold")
        if k == 0:
            h["legend"](ax, thin)
        tx = fig.add_subplot(gs[base + 1, col])
        tx.axis("off")
        lines = [" × ".join(f"{x:g}" for x in f["size_mm"]) + " mm",
                 ", ".join(x for x in (f"{f['grams']:g} g {material.upper()}" if f.get("grams") is not None else None,
                                       "closed" if f["watertight"] else "NOT closed",
                                       f"{f['bodies']} bodies" if (f.get("bodies") or 1) > 1 else None) if x)]
        w = f.get("wall") or {}
        if w.get("min") is not None:
            lines.append(f"thinnest wall {w['min']:g} mm")
        tx.text(0.02, 0.98, "\n".join(lines), fontsize=9.5, va="top", family="DejaVu Sans", linespacing=1.35)
        probs = f.get("problems") or []
        if probs:
            tx.text(0.02, 0.12, h["wrap"](probs[0], 52), fontsize=8, va="bottom", color="#b3261e")
        if plane_spec:
            cx = fig.add_subplot(gs[base + 2, col])
            plane, g, sf = cuts[k]
            if g is None or win is None:
                cx.axis("off")
                cx.text(0.5, 0.5, f"nothing at {plane['label']}", ha="center", va="center", color="#777")
                continue
            geom.draw_geom(cx, g)
            geom.style_axes(cx, plane["names"][0] + " (mm)", plane["names"][1] + " (mm)", win)
            geom.annotate_section(cx, sf, thin=thin)
            tw = sf.get("thinnest_wall")
            cx.set_title(f"{plane['label']}" + (f" · thinnest {tw['mm']:g} mm" if tw else ""), fontsize=9.5)
    fig.savefig(job["sheet"], dpi=100)
    P.close(fig)
    return out


if __name__ == "__main__":
    run_one(sys.argv[1])
