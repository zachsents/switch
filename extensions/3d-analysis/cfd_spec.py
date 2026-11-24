"""A study's case matrix: checked and expanded here, before any box is rented, into what the box's runner
runs (every case's commands written out in full).

A matrix is {"defaults": {...}, "vars": {...}, "cases": {name: {...}} or [{"name": ..., ...}]}, each case's
fields over the defaults':
  np          ranks (and cores it holds while it runs), default 1
  copy        a case folder in the study folder to start from (a template), or
  build       a command, run in the study folder, that makes the case folder ($CASE)
  set         {"system/controlDict": {"endTime": 500}}: entries set in the case after copy or build
  run         the command that meshes and solves it, run in the case folder (default: the builtin pipeline:
              blockMesh, surface features, snappyHexMesh, 0.orig, decompose, solver, reconstruct)
  potential   true runs potentialFoam before the solver in the builtin pipeline
  post        a command, run in the study folder once the case is done, whose last JSON line is kept
  converge    {"monitors": [{"name", "file" (a glob in the case), "column" (index, time being 0, or a header's
              words), "window" (the last N time units), "tol" (drift within this fraction of the mean),
              "std_tol"?, "floor"?}], "residuals": {"p": 1e-4}, "log": glob of the solver log}
  extend      {"by": 300, "max": 2400, "averages": "continue"|"restart"}: an unconverged case runs on by `by`
              until it converges or reaches `max`
  extend_cmd  a command that runs the case on instead of the builtin one (gets $END and $AVERAGES)
  env, vars   environment for its commands; vars fill {name} placeholders in commands
Commands also see $CASE, $NAME, $NP, $STUDY. Placeholders: {case}, {name}, {np}, {study} and vars.
"""

import copy as _copy
import json
import os
import re
import shlex

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$")
KNOWN = {"np", "copy", "build", "set", "run", "potential", "post", "converge", "extend", "extend_cmd", "env", "vars", "name"}
PLACEHOLDER = re.compile(r"(?<!\$)\{([a-z_][a-z0-9_]*)\}")


class SpecError(ValueError):
    pass


def load(matrix, study_dir):
    """The matrix as given: a dict, a JSON string, or a file's path (relative to the study folder)."""
    if isinstance(matrix, dict):
        return matrix
    if isinstance(matrix, str) and matrix.strip().startswith("{"):
        try:
            return json.loads(matrix)
        except ValueError as e:
            raise SpecError(f"cases isn't JSON: {e}")
    path = matrix or "matrix.json"
    full = path if os.path.isabs(path) else os.path.join(study_dir, path)
    try:
        with open(full) as f:
            return json.load(f)
    except FileNotFoundError:
        raise SpecError(f"no matrix: give cases, or put {path} in the study folder")
    except ValueError as e:
        raise SpecError(f"{path} isn't JSON: {e}")


def merge(base, over):
    out = _copy.deepcopy(base)
    for k, v in (over or {}).items():
        if k in ("env", "vars", "converge", "extend", "set") and isinstance(v, dict) and v and isinstance(out.get(k), dict):
            merged = dict(out[k])
            merged.update(v)
            out[k] = merged
        else:
            out[k] = _copy.deepcopy(v)
    return out


def fill(text, values, where):
    def sub(m):
        key = m.group(1)
        if key in values:
            return str(values[key])
        raise SpecError(f"{where}: {{{key}}} isn't a var (vars: {', '.join(sorted(values)) or 'none'})")
    return PLACEHOLDER.sub(sub, text)


def expand(matrix, study_dir, box_study, box_cases, slots=None):
    """Checks the matrix against the study folder and writes every case out: (cases, warnings), cases being
    {name: {np, build, run, post, extend_cmd, env, converge, extend}} in order, with box paths."""
    if not isinstance(matrix, dict):
        raise SpecError("cases must be an object: {defaults, vars, cases}")
    raw = matrix.get("cases")
    if isinstance(raw, list):
        items = []
        for i, c in enumerate(raw):
            if not isinstance(c, dict) or not c.get("name"):
                raise SpecError(f"cases[{i}] needs a name")
            items.append((c["name"], c))
    elif isinstance(raw, dict):
        items = list(raw.items())
    else:
        raise SpecError("cases needs its cases: {name: {...}} or [{name, ...}]")
    if not items:
        raise SpecError("cases has no cases")
    defaults = matrix.get("defaults") or {}
    top_vars = matrix.get("vars") or {}
    out, warnings, seen = {}, [], set()
    for name, c in items:
        if not NAME_RE.match(str(name)):
            raise SpecError(f"{name!r} can't name a case: letters, digits, _ . - (up to 63)")
        if name in seen:
            raise SpecError(f"{name} is in the matrix twice")
        seen.add(name)
        c = merge(defaults, c if isinstance(c, dict) else {})
        unknown = set(c) - KNOWN
        if unknown:
            raise SpecError(f"{name}: {', '.join(sorted(unknown))} isn't a case field ({', '.join(sorted(KNOWN - {'name'}))})")
        np_ = c.get("np", 1)
        if not isinstance(np_, int) or np_ < 1:
            raise SpecError(f"{name}: np must be a whole number of ranks")
        if slots and np_ > slots:
            raise SpecError(f"{name}: np {np_} is more than the box's {slots} cores")
        case_dir = f"{box_cases}/{name}"
        values = dict(top_vars)
        values.update(c.get("vars") or {})
        values.update(case=case_dir, name=name, np=np_, study=box_study)
        build = None
        if c.get("copy") and c.get("build"):
            raise SpecError(f"{name}: give copy or build, not both")
        if c.get("copy"):
            src = c["copy"].rstrip("/")
            local = os.path.join(study_dir, src)
            if not os.path.isfile(os.path.join(local, "system", "controlDict")):
                raise SpecError(f"{name}: copy names {src}, which has no system/controlDict in the study folder")
            build = f"rm -rf {shlex.quote(case_dir)} && cp -r {shlex.quote(box_study + '/' + src)} {shlex.quote(case_dir)}"
        elif c.get("build"):
            build = fill(str(c["build"]), values, f"{name}'s build")
        elif not c.get("run"):
            raise SpecError(f"{name}: give copy (a case folder in the study folder) or build (a command that makes it)")
        sets = c.get("set") or {}
        if sets:
            if not isinstance(sets, dict):
                raise SpecError(f"{name}: set is {{file: {{entry: value}}}}")
            lines = []
            for rel, entries in sets.items():
                if not isinstance(entries, dict):
                    raise SpecError(f"{name}: set's {rel} must be {{entry: value}}")
                for entry, value in entries.items():
                    v = value if isinstance(value, str) else json.dumps(value)
                    lines.append(f"foamDictionary -entry {shlex.quote(entry)} -set {shlex.quote(v)} "
                                 f"{shlex.quote(case_dir + '/' + rel)} > /dev/null")
            build = " && ".join(([build] if build else []) + lines)
        conv = c.get("converge") or {}
        if not isinstance(conv, dict):
            raise SpecError(f"{name}: converge is {{monitors, residuals, log}}")
        for i, m in enumerate(conv.get("monitors") or []):
            if not isinstance(m, dict) or not m.get("file"):
                raise SpecError(f"{name}: converge.monitors[{i}] needs a file (a glob in the case, like postProcessing/p_out/*/surfaceFieldValue.dat)")
            if m.get("tol") is not None and not isinstance(m["tol"], (int, float)):
                raise SpecError(f"{name}: converge.monitors[{i}].tol must be a number (a fraction: 0.005 is 0.5%)")
            if m.get("tol") is None:
                warnings.append(f"{name}: monitor {m.get('name') or m['file']} has no tol, so it's reported, never judged")
        for field, limit in (conv.get("residuals") or {}).items():
            if not isinstance(limit, (int, float)):
                raise SpecError(f"{name}: converge.residuals.{field} must be a number")
        ext = c.get("extend") or {}
        if ext:
            if not isinstance(ext, dict) or not isinstance(ext.get("by"), (int, float)) or ext["by"] <= 0:
                raise SpecError(f"{name}: extend needs by (how far each extension runs on, in time units)")
            if ext.get("max") is not None and ext["max"] < ext["by"]:
                raise SpecError(f"{name}: extend.max is the end time it may run to, at least by")
            if ext.get("averages", "continue") not in ("continue", "restart"):
                raise SpecError(f"{name}: extend.averages is continue or restart")
            if not conv.get("monitors") and not conv.get("residuals"):
                warnings.append(f"{name}: extend is set but nothing judges convergence (converge.monitors or residuals), so it never runs on")
        env = {str(k): str(v) for k, v in (c.get("env") or {}).items()}
        if c.get("potential"):
            env["POTENTIAL"] = "1"
        out[name] = {
            "np": np_,
            "build": build,
            "run": fill(str(c["run"]), values, f"{name}'s run") if c.get("run") else None,
            "post": fill(str(c["post"]), values, f"{name}'s post") if c.get("post") else None,
            "extend_cmd": fill(str(c["extend_cmd"]), values, f"{name}'s extend_cmd") if c.get("extend_cmd") else None,
            "env": env,
            "converge": conv,
            "extend": ext,
        }
    return out, warnings
