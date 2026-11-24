"""scope_audit: an OAuth app's Google scopes checked three ways in one step, and its per-scope justification written
from that, instead of comparing lists by hand before each verification round.

The three lists:
- code: the scopes the app's code allows (its allow-list) and the scopes its features actually request, read from the
  code itself at a ref (origin/main by default) by the reader the source names: a script beside it, run as
  `<reader> <tree> <service> <out.json>` with the ref's code at <tree>, which writes
  {allowed, allowed_at?, failed?, requesters: [{kind, name, minimal: [scope], at?}]} to out.json.
- console: the Data Access page as it is now (data_access's reader), every scope by tier and each justification box.
- justifications: the per-scope words kept in a source file next to the submission (scopes.json): what features use
  each scope, the most it can do, why a narrower one won't work, plus which file holds each Console box.

It answers what disagrees (allowed but not on the Console or the reverse, requested but not allowed, allowed but
requested by nothing, scopes with no justification or justifications for scopes that are gone, Console boxes over
Google's limit or not naming a scope of their tier, a box file that differs from what the Console says), writes the
audit and the per-scope justification as markdown beside the source (never over a file it didn't write), records
google-scope-audit:<project>, and hands back set_consent_scopes' arguments for when the Console should change.

The source file (JSON):
    {"project": "my-project", "app": "My App", "repo": "~/code/my-app", "ref": "origin/main",
     "reader": "scopes-reader.ts", "tree": ["package.json", "packages"],
     "service": "google", "video": "https://youtu.be/...", "uses": {"gmail": ["Email productivity"]},
     "boxes": {"sensitive": "field-sensitive.txt", "gmail": "field-gmail.txt"},
     "scopes": {"gmail.send": {"features": "...", "extent": "...", "narrower": "..."}}}
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time

import data_access as da
import oauth
import server
from server import part

app = part("oauth")
app.event("scope_audit", "An OAuth app's Google scopes checked: its code, its consent screen and its per-scope justifications",
          stream="google/oauth", kind="observation")

WRITTEN_PATH = os.path.join(oauth.HOME, "audit-docs-written.json")
SOURCES_PATH = os.path.join(oauth.HOME, "audit-sources.json")
"""Each project's justification source as last given, so later calls needn't say it again."""
SIGN_IN = {da.full(s) for s in ("openid", "email", "profile")}
"""Sign-in scopes: the integration adds them itself, Google doesn't review them, and they need no justification."""
FIELDS = ("features", "extent", "narrower")
LABELS = {"features": "Features", "extent": "Maximum extent", "narrower": "Narrower scope"}

lock = threading.Lock()
state = {"audits": 0, "failed": 0, "last_error": None, "last": {}}


# The source

def load_source(project, source=None):
    known = oauth.read_json(SOURCES_PATH, {})
    path = os.path.expanduser(source or known.get(project) or "")
    if not path:
        raise ValueError(f"no justification source for {project}: give source, a scopes.json path on this Mac")
    if not os.path.exists(path):
        raise ValueError(f"{path} doesn't exist: write the per-scope justifications there first (see scope_audit's description)")
    with open(path, encoding="utf-8") as f:
        src = json.load(f)
    if src.get("project") and src["project"] != project:
        raise ValueError(f"{path} is project {src['project']}'s, not {project}'s")
    words = {}
    for scope, entry in (src.get("scopes") or {}).items():
        if not isinstance(entry, dict):
            raise ValueError(f"{path}: scopes.{scope} must be {{features, extent, narrower}}")
        words[da.full(scope)] = {k: (entry.get(k) or "").strip() for k in FIELDS}
    if known.get(project) != path:
        with lock:
            os.makedirs(oauth.HOME, mode=0o700, exist_ok=True)
            oauth.write_private(SOURCES_PATH, json.dumps({**oauth.read_json(SOURCES_PATH, {}), project: path}))
    src["_path"], src["_dir"], src["_words"] = path, os.path.dirname(path), words
    return src


def box_files(src):
    """{box: path} of the Console's justification boxes, as the source names them (relative to its folder)."""
    return {da.box_key(k): os.path.join(src["_dir"], os.path.expanduser(v)) for k, v in (src.get("boxes") or {}).items()}


# The code

def git(repo, *args, timeout=120):
    r = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, timeout=timeout)
    if r.returncode:
        raise RuntimeError(f"git {' '.join(args[:2])}: {(r.stderr or r.stdout).strip()[:300]}")
    return r.stdout


def runner(path):
    """The command that runs a reader script: bun for TypeScript and JavaScript, python3 for Python, else itself."""
    if path.endswith((".ts", ".tsx", ".js", ".mjs")):
        found = shutil.which("bun") or os.path.expanduser("~/.bun/bin/bun")
        if not os.path.exists(found):
            raise RuntimeError("bun isn't installed on this Mac, and the code reader needs it")
        return [found, path]
    if path.endswith(".py"):
        return [shutil.which("python3") or "python3", path]
    return [path]


def link_modules(checkout, tree):
    """Every node_modules of the checkout (its root's and each workspace's, two folders down at most) linked into
    tree, except that a link back into the checkout (a workspace package) points at tree's copy, so the ref's code
    imports the ref's code and the checkout's dependencies."""
    real = os.path.realpath(checkout) + os.sep

    def one(p, d):
        if os.path.islink(p):
            target = os.path.realpath(p)
            if target.startswith(real) and "node_modules" not in target[len(real):].split(os.sep):
                os.symlink(os.path.join(tree, target[len(real):]), d)
                return
        os.symlink(p, d)

    def link(rel):
        src, dst = os.path.join(checkout, rel, "node_modules"), os.path.join(tree, rel, "node_modules")
        if not os.path.isdir(src) or not os.path.isdir(os.path.join(tree, rel)) or os.path.exists(dst):
            return
        os.makedirs(dst)
        for entry in os.listdir(src):
            p = os.path.join(src, entry)
            if entry.startswith("@") and os.path.isdir(p) and not os.path.islink(p):
                os.makedirs(os.path.join(dst, entry), exist_ok=True)
                for e in os.listdir(p):
                    one(os.path.join(p, e), os.path.join(dst, entry, e))
            else:
                one(p, os.path.join(dst, entry))

    link(".")
    for top in sorted(os.listdir(tree)):
        if top.startswith(".") or top == "node_modules" or not os.path.isdir(os.path.join(tree, top)):
            continue
        link(top)
        for sub in sorted(os.listdir(os.path.join(tree, top))):
            if sub != "node_modules" and os.path.isdir(os.path.join(tree, top, sub)):
                link(os.path.join(top, sub))


def materialize(repo, sha, into, paths=None):
    """The ref's code (only paths, when the source names them) in a folder of its own, with node_modules linked."""
    archive = subprocess.run(["git", "-C", repo, "archive", sha, *(paths or [])], capture_output=True, timeout=120)
    if archive.returncode:
        raise RuntimeError(f"git archive {sha[:8]}: {archive.stderr.decode()[:300]}")
    subprocess.run(["tar", "-x", "-C", into], input=archive.stdout, check=True, timeout=120)
    link_modules(repo, into)


def read_code(src, repo, ref="origin/main", progress=lambda m: None):
    """The code's allow-list and requesters at ref ("checkout" reads the working copy as it is, edits included)."""
    repo = os.path.expanduser(repo)
    if not repo or not os.path.isdir(repo):
        raise ValueError(f"no checkout at {repo or '(none)'}: give repo, or name it in the source")
    if not src.get("reader"):
        raise ValueError(f"{src['_path']} names no reader: a script beside it that reads the code's scopes "
                         "(see scope_audit's description), or give allowed and requested outright")
    reader = os.path.join(src["_dir"], os.path.expanduser(src["reader"]))
    if not os.path.exists(reader):
        raise ValueError(f"the reader {reader} doesn't exist")
    paths = list(src.get("tree") or [])
    out = {"repo": repo, "ref": ref}
    if ref == "checkout":
        tree, sha = repo, git(repo, "rev-parse", "HEAD").strip()
        out["dirty"] = bool(git(repo, "status", "--porcelain", "--", *paths).strip())
    else:
        if ref.startswith("origin/"):
            progress("Fetching origin")
            try:
                git(repo, "fetch", "--quiet", "origin", ref.split("/", 1)[1], timeout=90)
            except Exception as e:  # noqa: BLE001
                out["fetch_failed"] = str(e)[:200]
        sha = git(repo, "rev-parse", "--verify", ref + "^{commit}").strip()
        head = git(repo, "rev-parse", "HEAD").strip()
        clean = not git(repo, "status", "--porcelain", "--", *paths).strip()
        tree = repo if (sha == head and clean) else None
    out["sha"] = sha
    out["subject"] = git(repo, "log", "-1", "--format=%s", sha).strip()
    scratch = None
    try:
        if tree is None:
            progress(f"Checking out {ref} ({sha[:8]})")
            os.makedirs(oauth.HOME, mode=0o700, exist_ok=True)
            scratch = tempfile.mkdtemp(prefix="scope-audit-", dir=oauth.HOME)
            materialize(repo, sha, scratch, paths)
            tree = scratch
        progress("Reading the code's scopes")
        with tempfile.NamedTemporaryFile(suffix=".json", dir=oauth.HOME) as answer:
            r = subprocess.run([*runner(reader), tree, src.get("service") or "google", answer.name],
                               capture_output=True, text=True, timeout=180, cwd=tree)
            if r.returncode:
                raise RuntimeError(f"the code reader failed at {sha[:8]}: {(r.stderr or r.stdout).strip()[-600:]}")
            with open(answer.name, encoding="utf-8") as f:
                facts = json.load(f)
    finally:
        if scratch:
            shutil.rmtree(scratch, ignore_errors=True)
    out.update(facts)
    return out


def given_code(allowed, requested):
    """Code facts said outright, for an app whose code this can't read: requested is {scope: [what requests it]}."""
    reqs = []
    for scope, names in (requested or {}).items():
        for n in names or ["(given)"]:
            reqs.append({"kind": "given", "name": n, "minimal": [scope]})
    return {"ref": "given", "allowed": list(allowed or []), "requesters": reqs}


# The comparison

def mentioned(text):
    """Every scope name a box's words name, its shorthand opened up: calendar.events/.readonly is calendar.events and
    calendar.events.readonly, meetings.space.readonly/settings adds meetings.space.settings, forms.body (+.readonly)
    adds forms.body.readonly, and so does a list before it (documents, spreadsheets, forms.body (+.readonly) adds each
    one's .readonly). Exact names, plus suffixes only of names written as scopes (with a dot or a slash)."""
    item = r"[A-Za-z][\w.]*(?:/\.?[\w.]+)*"

    def spread(m):
        items = re.findall(item, re.sub(r"\band\b", ",", m.group(1)))
        return ", ".join(f"{i}/{m.group(2)}" for i in items)

    t = re.sub(rf"((?:{item}\s*,\s*)*(?:{item}\s*,?\s*and\s+)?{item})\s*\(\+\s*(\.[\w.]+)\)", spread, text or "")
    exact, suffixes = set(), set()
    for token in re.findall(r"[A-Za-z][\w.]*(?:/\.?[\w.]+)*", t):
        token = token.rstrip(".")
        parts = token.split("/")
        base, names = parts[0], {parts[0]}
        for p in parts[1:]:
            names.add(base + p if p.startswith(".") else (base.rsplit(".", 1)[0] + "." + p if "." in base else p))
        exact |= names
        if len(parts) > 1:
            suffixes |= names
        else:
            suffixes |= {n for n in names if "." in n}
    return exact, suffixes


def names(scope, text):
    s = da.short(scope)
    exact, suffixes = mentioned(text)
    return s in exact or any(s.endswith("." + n) for n in suffixes)


def utf16(text):
    return len((text or "").encode("utf-16-le")) // 2


def compare(code, page, src, expected=None):
    """Everything that disagrees, as {kind: [...]}, empty kinds left out; and per scope what's known of it."""
    allowed = da.wanted(code.get("allowed") or [])
    requested = {}
    for r in code.get("requesters") or []:
        for s in r.get("minimal") or []:
            requested.setdefault(da.full(s), []).append(r)
    on_console = da.configured(page) if page else None
    words = src["_words"]
    allowed_set = set(allowed)
    f = {}

    if on_console is not None:
        f["not_on_console"] = [da.short(s) for s in allowed if s not in set(on_console)]
        f["console_only"] = [da.short(s) for s in on_console if s not in allowed_set]
    f["requested_not_allowed"] = [{"scope": da.short(s), "by": sorted(r["name"] for r in rs)}
                                  for s, rs in requested.items() if s not in allowed_set]
    f["allowed_unrequested"] = [da.short(s) for s in allowed if s not in requested and s not in SIGN_IN]
    if expected is not None:
        exp = set(da.wanted(expected))
        f["expected_not_allowed"] = [da.short(s) for s in da.wanted(expected) if s not in allowed_set]
        f["allowed_not_expected"] = [da.short(s) for s in allowed if s not in exp and s not in SIGN_IN]
    reviewed = [s for s in allowed if s not in SIGN_IN]
    f["no_justification"] = [da.short(s) for s in reviewed if s not in words]
    f["incomplete_justification"] = [{"scope": da.short(s), "missing": [k for k in FIELDS if not words[s][k]]}
                                     for s in reviewed if s in words and not all(words[s].values())]
    f["stale_justification"] = [da.short(s) for s in words if s not in allowed_set]

    tiers = tier_of(page) if page else {}
    boxes = {}
    files = box_files(src)
    console_words = (page or {}).get("justifications") or {}
    for box in sorted(set(files) | set(console_words) | {t for t in tiers.values() if t != "non_sensitive"}):
        path = files.get(box)
        text, problems = None, []
        if path and os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                text = fh.read().strip()
        elif path:
            problems.append(f"its file {os.path.basename(path)} doesn't exist")
        else:
            problems.append("the source names no file for it")
        if text is None and console_words.get(box):
            text = console_words[box].strip()
        box_scopes = [s for s, t in tiers.items() if t == box]
        if page and not box_scopes and box in files:
            problems.append("the Console has no scopes in this box's tier")
        unnamed = [s for s in box_scopes if not (text and names(s, text))]
        elsewhere = {}
        for s in unnamed:
            other = [b for b in files if b != box and os.path.exists(files[b]) and names(s, open(files[b], encoding="utf-8").read())]
            if other:
                elsewhere[da.short(s)] = other
        info = {"file": path, "length": utf16(text) if text else 0, "scopes": len(box_scopes)}
        if info["length"] > da.BOX_MAX:
            problems.append(f"{info['length']} characters; Google's box takes {da.BOX_MAX}")
        if unnamed:
            info["unnamed"] = [da.short(s) for s in unnamed]
            problems.append("doesn't name " + ", ".join(
                da.short(s) + (f" (the {', '.join(elsewhere[da.short(s)])} box does)" if da.short(s) in elsewhere else "")
                for s in unnamed))
        if box in console_words and path and os.path.exists(path):
            info["matches_console"] = (console_words[box] or "").strip() == text
            if not info["matches_console"]:
                problems.append("the Console's words differ from the file (set_consent_scopes puts the file's there)")
        if problems:
            info["problems"] = problems
        boxes[box] = info
    f["boxes"] = {b: i["problems"] for b, i in boxes.items() if i.get("problems")}
    return {k: v for k, v in f.items() if v}, {"allowed": allowed, "requested": requested, "tiers": tiers, "boxes": boxes}


def tier_of(page):
    """{scope: its Console tier}: non_sensitive, sensitive, or the restricted API's name (gmail, drive)."""
    t = page.get("tiers") or {}
    out = {da.full(s): "non_sensitive" for s in t.get("non_sensitive") or []}
    out.update({da.full(s): "sensitive" for s in t.get("sensitive") or []})
    for api, rows in (t.get("restricted") or {}).items():
        out.update({da.full(s): da.box_key(api) for s in rows})
    return out


def say(findings):
    """The findings in plain sentences, worst first."""
    out = []
    if findings.get("requested_not_allowed"):
        out.append("Requested by code but not in its allow-list (deployments using these fail): " + "; ".join(
            f"{x['scope']} by {', '.join(x['by'][:4])}{'…' if len(x['by']) > 4 else ''}" for x in findings["requested_not_allowed"]))
    if findings.get("not_on_console"):
        out.append("Allowed in code but not on the Console: " + ", ".join(findings["not_on_console"]))
    if findings.get("console_only"):
        out.append("On the Console but not allowed in code: " + ", ".join(findings["console_only"]))
    if findings.get("allowed_unrequested"):
        out.append("Allowed but requested by nothing in the code (Google asks to drop unused scopes): " + ", ".join(findings["allowed_unrequested"]))
    if findings.get("expected_not_allowed"):
        out.append("Expected but not allowed in code: " + ", ".join(findings["expected_not_allowed"]))
    if findings.get("allowed_not_expected"):
        out.append("Allowed in code but not expected: " + ", ".join(findings["allowed_not_expected"]))
    if findings.get("no_justification"):
        out.append("No justification in the source: " + ", ".join(findings["no_justification"]))
    for x in findings.get("incomplete_justification") or []:
        out.append(f"{x['scope']}'s justification has no {', '.join(x['missing'])}")
    if findings.get("stale_justification"):
        out.append("Justified but no longer allowed: " + ", ".join(findings["stale_justification"]))
    for box, problems in (findings.get("boxes") or {}).items():
        out.append(f"The {box} box: " + "; ".join(problems))
    return out


# The documents

def render_justifications(src, allowed):
    """Per scope, in the order the source keeps them: the scope's URL and its three answers (what Google's reviewers
    asked for, as our replies give it)."""
    words = src["_words"]
    order = [s for s in words if s in set(allowed)] + [s for s in allowed if s not in words and s not in SIGN_IN]
    out = []
    for s in order:
        w = words.get(s)
        out.append(s)
        if not w:
            out.append("- (no justification yet)")
        else:
            out += [f"- {LABELS[k]}: {w[k]}" for k in FIELDS if w[k]]
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def render_audit(project, src, code, page, findings, detail, read_at):
    words, requested, tiers = src["_words"], detail["requested"], detail["tiers"]
    allowed = detail["allowed"]
    day = time.strftime("%b %-d %Y", time.localtime(read_at / 1000))
    head = [f"# Google scope audit: {src.get('app') or project}, {day}", ""]
    where = f"{code.get('ref')} {code['sha'][:8]} ({code.get('subject', '')})" if code.get("sha") else code.get("ref")
    lines = [f"- Code: {where}" + (f", read from {code['repo']}" if code.get("repo") else "") + "."]
    if code.get("allowed_at"):
        lines.append(f"- Allow-list: {code['allowed_at']}: {len(allowed)} scopes, {len([s for s in allowed if s not in SIGN_IN])} "
                     f"for Google's review plus {', '.join(da.short(s) for s in allowed if s in SIGN_IN)}.")
    lines.append(f"- Requested by code: {len(requested)} scopes, by {len(code.get('requesters') or [])} requesters "
                 "(each one's least-permissive choice).")
    if page is not None:
        lines.append(f"- Console (project {project}, read {time.strftime('%b %-d %-I:%M %p', time.localtime(read_at / 1000))}): "
                     f"{len(da.configured(page))} scopes.")
    lines.append(f"- Justifications: {os.path.basename(src['_path'])}, {len(words)} scopes.")
    said = say(findings)
    body = ["", "## Findings", ""] + ([f"- {x}" for x in said] or ["- Code, Console and justifications agree."])
    if detail["boxes"]:
        body += ["", "## Console boxes", ""]
        for box, info in detail["boxes"].items():
            bits = [f"{info['length']}/{da.BOX_MAX} characters", f"{info['scopes']} scopes in its tier"]
            if info.get("matches_console") is not None:
                bits.append("same as the Console" if info["matches_console"] else "differs from the Console")
            name = os.path.basename(info["file"]) if info.get("file") else "no file"
            body.append(f"- {box} ({name}): {', '.join(bits)}" + (f"; {'; '.join(info['problems'])}" if info.get("problems") else ""))
    order = [s for s in words if s in set(allowed)] + [s for s in allowed if s not in words and s not in SIGN_IN]
    order += [s for s in requested if s not in set(order)]
    for s in order:
        body += ["", f"## {da.short(s)}"]
        w = words.get(s)
        if s in tiers:
            body.append(f"- Console tier: {tiers[s].replace('_', '-')}" + (" (restricted)" if tiers[s] not in ("sensitive", "non_sensitive") else ""))
        elif page is not None:
            body.append("- Console tier: not on the Console")
        if s not in set(allowed):
            body.append("- Not in the allow-list")
        if w:
            body += [f"- {LABELS[k]}: {w[k]}" for k in FIELDS if w[k]]
        else:
            body.append("- No justification yet")
        rs = requested.get(s) or []
        if rs:
            body.append("- Requested by (least-permissive choice): " + "; ".join(
                ((r["kind"] + " " if r.get("kind") not in ("action", "given", None) else "") + r["name"] + (f" ({r['at']})" if r.get("at") else ""))
                for r in sorted(rs, key=lambda r: (r.get("kind") != "action", r["name"]))))
        else:
            body.append("- Requested by: nothing")
    return "\n".join(head + lines + body) + "\n"


def written():
    return oauth.read_json(WRITTEN_PATH, {})


def write_doc(path, text):
    """Writes text at path, or beside it (-2, -3...) when a file is there that this didn't write or that someone
    changed since. Answers the path written."""
    with lock:
        mine = written()
        stem, ext = os.path.splitext(path)
        n, target = 1, path
        while os.path.exists(target):
            with open(target, "rb") as f:
                have = hashlib.sha256(f.read()).hexdigest()
            if mine.get(target) == have:
                break
            n += 1
            target = f"{stem}-{n}{ext}"
        with open(target, "w", encoding="utf-8") as f:
            f.write(text)
        mine[target] = hashlib.sha256(text.encode("utf-8")).hexdigest()
        os.makedirs(oauth.HOME, mode=0o700, exist_ok=True)
        oauth.write_private(WRITTEN_PATH, json.dumps(mine))
        return target


# The tool

def audit(project, source=None, ref=None, repo=None, console=True, write=True, expected=None, allowed=None,
          requested=None, account=None, mac=None, progress=lambda m: None):
    src = load_source(project, source)
    if allowed is not None or requested is not None:
        code = given_code(allowed, requested)
    else:
        code = read_code(src, repo or src.get("repo") or "", ref or src.get("ref") or "origin/main", progress)
    page = None
    if console:
        progress("Reading the Console's Data Access page")
        tab = da.tab_for(mac, f"google-scopes-{oauth.slug(project)}-audit")
        try:
            page = da.open_page(tab, project, account)
        finally:
            tab.release()
        da.observe(project, page)
    now = int(time.time() * 1000)
    findings, detail = compare(code, page, src, expected)
    out = {"project": project, "clean": not findings, "findings": say(findings),
           "code": {k: code.get(k) for k in ("ref", "sha", "subject", "fetch_failed", "dirty", "allowed_at") if code.get(k) is not None},
           "counts": {"allowed": len(detail["allowed"]), "requested": len(detail["requested"]),
                      "requesters": len(code.get("requesters") or []), "justified": len(src["_words"]),
                      **({"console": len(da.configured(page))} if page is not None else {})},
           "boxes": {b: {k: v for k, v in i.items() if k != "file"} for b, i in detail["boxes"].items()}}
    if code.get("failed"):
        out["unreadable_components"] = code["failed"]
    if write:
        progress("Writing the audit and the per-scope justification")
        day = time.strftime("%Y-%m-%d", time.localtime(now / 1000))
        out["files"] = {
            "audit": write_doc(os.path.join(src["_dir"], f"scope-audit-{day}.md"),
                               render_audit(project, src, code, page, findings, detail, now)),
            "justifications": write_doc(os.path.join(src["_dir"], f"scope-justifications-{day}.md"),
                                        render_justifications(src, detail["allowed"])),
        }
    files = box_files(src)
    fill = {"project": project, "scopes": [da.short(s) for s in detail["allowed"]],
            "justifications": {b: {"file": p} for b, p in files.items() if os.path.exists(p)}}
    if src.get("video"):
        fill["video"] = src["video"]
    if src.get("uses"):
        fill["uses"] = src["uses"]
    blockers = [k for k in ("requested_not_allowed", "no_justification", "stale_justification") if findings.get(k)]
    blockers += [b for b, ps in (findings.get("boxes") or {}).items() if any("characters" in p or "doesn't exist" in p for p in ps)]
    out["set_consent_scopes"] = fill
    if blockers:
        out["fix_first"] = blockers
    app.emit("scope_audit", {
        "entity": f"google-scope-audit:{project}",
        "summary": (f"{project}'s Google scopes: code, Console and justifications agree ({len(detail['allowed'])} scopes)"
                    if not findings else f"{project}'s Google scopes: {len(say(findings))} finding(s)"),
        "facts": {"project": project, "clean": not findings, "findings": say(findings), "counts": out["counts"],
                  "code": out["code"], "files": out.get("files"), "at": now}},
        about=[f"google-scope-audit:{project}", f"google-consent:{project}"])
    state["last"][project] = {"at": now, "clean": not findings, "findings": len(say(findings))}
    return out


def tracked(fn):
    def call(*a, **k):
        state["audits"] += 1
        try:
            return fn(*a, **k)
        except Exception as e:
            state["failed"] += 1
            state["last_error"] = f"{type(e).__name__}: {e}"[:400]
            raise
    return call


@app.tool(name="scope_audit", read_only=True, schema={"type": "object", "required": ["project"], "properties": {
    "project": da.PROJECT,
    "source": {"type": "string", "description": (
        "The per-scope justification source, a JSON file on the Mac this runs on: {project, app, repo, ref, reader, tree, service, "
        "video, uses, boxes: {sensitive|gmail|drive: file beside it}, scopes: {scope: {features, extent, narrower}}}. "
        "reader is a script beside it, run as `<reader> <tree> <service> <out.json>` on the ref's code, that writes "
        "{allowed, allowed_at?, requesters: [{kind, name, minimal: [scope], at?}]}; tree, the paths of the repo it needs "
        "(default all). Default: the project's source as last given.")},
    "ref": {"type": "string", "description": "The code's git ref to read (default the source's, else origin/main, fetched first); \"checkout\" reads the working copy as it is, edits included."},
    "repo": {"type": "string", "description": "The app's checkout on the Mac this runs on (default the source's repo)."},
    "console": {"type": "boolean", "description": "Read the Console's Data Access page now and compare it too (default true; about 10 s in the Mac's Chrome)."},
    "write": {"type": "boolean", "description": "Write scope-audit-<date>.md and scope-justifications-<date>.md beside the source (default true); never over a file it didn't write."},
    "expected": {"type": "array", "items": {"type": "string"}, "description": "Scopes someone else lists (like Google's email), compared with the allow-list too."},
    "allowed": {"type": "array", "items": {"type": "string"}, "description": "For an app whose code this can't read: its allow-list, said outright."},
    "requested": {"type": "object", "additionalProperties": {"type": "array", "items": {"type": "string"}},
                  "description": "With allowed: {scope: [the features that request it]}."},
    "account": da.ACCOUNT, "mac": da.MAC_ARG}},
    description=(
        "Check an OAuth app's Google scopes three ways in one step and write its per-scope justification: the code's "
        "allow-list and what its features request (read from the code at origin/main by the source's reader, each "
        "requester's least-permissive choice), the Console's Data Access page (tiers and justification "
        "boxes), and the per-scope justification source (features, maximum extent, why not narrower). Answers what "
        "disagrees (allowed but not on the Console or the reverse, requested but not allowed, allowed but unused, scopes "
        "with no justification or stale ones, boxes over 1000 characters, not naming a scope of their tier, or differing "
        "from their file), writes scope-audit-<date>.md (each scope's tier, words and requesters with file:line) and "
        "scope-justifications-<date>.md (the reply's per-scope text) beside the source, records "
        "google-scope-audit:<project>, and answers set_consent_scopes' arguments for making the Console match."))
def scope_audit(project, source=None, ref=None, repo=None, console=True, write=True, expected=None, allowed=None,
                requested=None, account=None, mac=None, ctx=None):
    return tracked(audit)(project, source, ref, repo, console, write, expected, allowed, requested, account, mac,
                          progress=ctx.progress if ctx else (lambda m: None))


def health():
    return dict(state)


server.local["scope_audit_health"] = health
