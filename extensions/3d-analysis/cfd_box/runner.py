#!/usr/bin/env python3
"""The CFD box's own scheduler: runs a study's case matrix a few cases at a time, judges each case's
convergence from its solver log and monitors, runs the unconverged ones further, and keeps status.json
current for the cfd appendage to read over ssh. Standard library only (the box's python3).

  runner.py serve  --home /root/cfd     # the loop (its systemd unit runs this)
  runner.py once   --home DIR           # one pass, for tests
  runner.py status --home DIR           # status.json as it would write it now
  runner.py files  --home DIR [--fields] [--include GLOB]... [--exclude GLOB]...   # what a fetch takes

The home holds study.json (written by the appendage: every case's commands already expanded), status.json,
and jobs/<case>/ (each phase's script, pid, exit status and log; state.json; request.json, a request the
appendage drops there: {"cancel": true}, {"extend": {"to": N | "by": N, "averages": ...}}, {"rerun": true}).
Case folders live in the study's cases_dir. A case's job runs in a session of its own, so the runner can be
restarted under it: on start it reads each case's state back from jobs/ and carries on.
"""

import argparse
import fnmatch
import glob
import json
import math
import os
import re
import shlex
import signal
import subprocess
import sys
import time

TERMINAL = ("done", "failed", "cancelled")
PHASES = ("build", "run", "extend", "post")
TAIL_BYTES = 512 * 1024
NUM = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"


def now():
    return time.time()


def read_text(path):
    with open(path) as f:
        return f.read()


def read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, data):
    tmp = f"{path}.tmp{os.getpid()}"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=1, default=str)
    os.replace(tmp, path)


def tail(path, size=TAIL_BYTES):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            n = f.tell()
            f.seek(max(0, n - size))
            data = f.read()
    except OSError:
        return ""
    text = data.decode("utf-8", "replace")
    if n > size:  # drop the partial first line
        text = text.split("\n", 1)[-1]
    return text


# ---------------------------------------------------------------------------------------------
# Reading a case: its controlDict, solver log and monitors


def dict_entry(path, key):
    """A top-level entry of an OpenFOAM dictionary (endTime, application), as text, or None."""
    try:
        text = read_text(path)
    except OSError:
        return None
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    m = re.search(rf"^\s*{re.escape(key)}\s+([^;]+);", text, flags=re.M)
    return m.group(1).strip() if m else None


def number(text):
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


def solver_log(case_dir, pattern=None):
    """The log the solver is writing (or last wrote): the newest of `pattern` (a glob in the case), else of
    log.<application>* (application from controlDict), else of log.* that holds a 'Time = ' line."""
    if pattern:
        found = glob.glob(os.path.join(case_dir, pattern))
    else:
        app = dict_entry(os.path.join(case_dir, "system", "controlDict"), "application")
        found = glob.glob(os.path.join(case_dir, f"log.{app}*")) if app else []
        if not found:
            found = [p for p in glob.glob(os.path.join(case_dir, "log.*")) if "\nTime = " in tail(p, 64 * 1024)]
    found = [p for p in found if os.path.isfile(p)]
    return max(found, key=os.path.getmtime) if found else None


TIME_RE = re.compile(rf"^Time = ({NUM})s?\s*$", re.M)
RES_RE = re.compile(rf"Solving for (\w+), Initial residual = ({NUM}), Final residual = ({NUM})")
EXEC_RE = re.compile(rf"ExecutionTime = ({NUM}) s")
# every OpenFOAM banner says "Floating point exception trapping enabled": only the signal itself is a crash
FATAL_RE = re.compile(r"(FOAM FATAL (?:IO )?ERROR|Floating point exception(?! trapping)|Segmentation fault|mpirun noticed|"
                      r"MPI_ABORT|Killed|bad_alloc)")


def parse_log(path):
    """Where a solver log stands: the last time step, each field's initial residual there, seconds per step,
    whether it ended (End) or met its residual controls, and a fatal error's lines if it has one."""
    out = {"log": path, "time": None, "residuals": {}, "sec_per_step": None, "ended": False,
           "solver_converged": False, "fatal": None, "nan": False}
    text = tail(path)
    if not text:
        return out
    times = list(TIME_RE.finditer(text))
    if times:
        last = times[-1]
        out["time"] = float(last.group(1))
        block = text[last.end():]
        res = {}
        for m in RES_RE.finditer(block):
            res.setdefault(m.group(1), float(m.group(2)))  # the first solve of each field in the step
        if not res and len(times) > 1:  # the newest step hasn't solved anything yet: use the one before
            for m in RES_RE.finditer(text[times[-2].end():last.start()]):
                res.setdefault(m.group(1), float(m.group(2)))
        out["residuals"] = res
        out["nan"] = any(not math.isfinite(v) for v in res.values()) or bool(re.search(r"Initial residual = -?nan", block))
    ex = [float(m.group(1)) for m in EXEC_RE.finditer(text)]
    steps = len(times)
    if len(ex) >= 2 and steps >= 2:
        span = min(len(ex), steps) - 1
        out["sec_per_step"] = round((ex[-1] - ex[-1 - span]) / span, 4) if span > 0 else None
    out["ended"] = bool(re.search(r"^End\s*$", text, re.M))
    out["solver_converged"] = bool(re.search(r"solution converged in \S+ iterations|^\s*\w+: [Cc]onverged in ", text, re.M))
    fatal = FATAL_RE.search(text)
    if fatal:
        lines = text[fatal.start():].strip().splitlines()
        out["fatal"] = "\n".join(lines[:12])[:1500]
    return out


COLUMN_RE = re.compile(r"\([^)]*\)|\S+")


def read_dat(paths):
    """Rows of function-object .dat files (several from restarts, joined by time, a later start winning where
    they overlap), each vector's components in columns of their own, and {header name: its first column}."""
    rows, names = [], {}
    for p in sorted(paths, key=lambda q: number(os.path.basename(os.path.dirname(q))) or 0.0):
        chunk, head, widths = [], [], None
        for line in tail(p).splitlines():
            s = line.strip()
            if not s:
                continue
            if s.startswith("#"):
                cols = [x.strip() for x in re.split(r"\t+|\s{2,}", s.lstrip("#").strip()) if x.strip()]
                if cols and cols[0].lower() in ("time", "iter", "iteration"):
                    head = cols
                continue
            toks = COLUMN_RE.findall(s)
            try:
                parts = [[float(x) for x in t.strip("()").split()] for t in toks]
            except ValueError:
                continue
            widths = widths or [len(x) for x in parts]
            chunk.append([x for part in parts for x in part])
        if chunk:
            start = chunk[0][0]
            rows = [r for r in rows if r[0] < start] + chunk
        if head and widths and len(head) == len(widths):
            names = {h: sum(widths[:i]) for i, h in enumerate(head)}
    return rows, names


def monitor(case_dir, spec, end_time=None):
    """One monitor's verdict over its window: the value's mean, spread and drift (the mean of the window's
    last fifth less its first fifth), and whether the drift (and spread, given std_tol) is within tol of the
    mean. spec: {name, file (glob in the case), column (index in a row, the time being 0, or a header's
    words), window (in time units: the last N), tol, std_tol?, floor?}."""
    name = spec.get("name") or spec.get("file")
    out = {"name": name, "ok": None}
    paths = [p for p in glob.glob(os.path.join(case_dir, spec["file"])) if os.path.isfile(p)]
    if not paths:
        out["why"] = f"no file matches {spec['file']}"
        return out
    rows, names = read_dat(paths)
    if not rows:
        out["why"] = "no rows yet"
        return out
    col = spec.get("column", 1)
    if isinstance(col, str):
        want = col.lower()
        hits = [i for h, i in names.items() if h.lower() == want] or [i for h, i in names.items() if want in h.lower()]
        if not hits:
            out["why"] = f"no column named {col!r} (its header: {', '.join(names) or 'none'})"
            return out
        col = hits[0]
    rows = [r for r in rows if len(r) > col]
    if not rows:
        out["why"] = f"no row has a column {col}"
        return out
    last_t = rows[-1][0]
    window = float(spec.get("window") or 0)
    win = [r for r in rows if r[0] > last_t - window] if window else rows
    vals = [r[col] for r in win]
    n = len(vals)
    mean = sum(vals) / n
    std = math.sqrt(sum((v - mean) ** 2 for v in vals) / n)
    k = max(1, n // 5)
    drift = sum(vals[-k:]) / k - sum(vals[:k]) / k
    scale = max(abs(mean), float(spec.get("floor") or 0.0)) or 1e-300
    out.update(value=vals[-1], mean=mean, std=std, drift=drift, rel_drift=abs(drift) / scale, rel_std=std / scale,
               rows=n, from_time=win[0][0], to_time=last_t)
    covered = (last_t - rows[0][0]) >= window * 0.95 if window else True
    tol = spec.get("tol")
    if tol is None:
        out["ok"] = None
        return out
    ok = out["rel_drift"] <= float(tol)
    if spec.get("std_tol") is not None:
        ok = ok and out["rel_std"] <= float(spec["std_tol"])
    if not covered:
        ok = False
        out["why"] = f"its window isn't full yet ({last_t - rows[0][0]:g} of {window:g})"
    out["ok"] = ok
    return out


def judge(case_dir, converge, log):
    """Whether a case's run converged: (verdict, why, monitors). verdict is True or False, or None when
    nothing says what converged means for it (no residual targets, no monitors, no residual control)."""
    converge = converge or {}
    mons = [monitor(case_dir, m) for m in converge.get("monitors") or []]
    whys, verdicts = [], []
    targets = converge.get("residuals") or {}
    if log.get("nan"):
        return False, "its residuals went NaN", mons
    if targets:
        res = log.get("residuals") or {}
        bad = []
        for field, limit in targets.items():
            hits = {k: v for k, v in res.items() if k == field or (k.startswith(field) and len(k) == len(field) + 1)}
            if not hits:
                bad.append(f"{field}: no residual in the log")
            for k, v in hits.items():
                if v > float(limit):
                    bad.append(f"{k} {v:.2e} > {float(limit):.0e}")
        verdicts.append(not bad)
        if bad:
            whys.append("residuals " + ", ".join(bad))
    for m in mons:
        verdicts.append(bool(m["ok"]))
        if not m["ok"]:
            if m.get("rel_drift") is not None:
                whys.append(f"{m['name']} drifts {m['rel_drift']:.2%} over its window" + (f" ({m['why']})" if m.get("why") else ""))
            else:
                whys.append(f"{m['name']}: {m.get('why') or 'no verdict'}")
    if log.get("solver_converged") and converge.get("trust_solver", True) and not verdicts:
        return True, "the solver met its residual controls", mons
    if not verdicts:
        return None, "nothing to judge it by", mons
    if all(verdicts):
        return True, "converged", mons
    if log.get("solver_converged"):
        whys.append(f"its residualControl stopped it at {log.get('time'):g}" if log.get("time") is not None
                    else "its residualControl stopped it")
    return False, "; ".join(whys), mons


# ---------------------------------------------------------------------------------------------
# The runner


class Runner:
    def __init__(self, home):
        self.home = os.path.abspath(home)
        self.jobs = os.path.join(self.home, "jobs")
        os.makedirs(self.jobs, exist_ok=True)
        self.children = {}
        self.study = None
        self.study_mtime = None
        self.load()

    # -- the study

    def load(self):
        path = os.path.join(self.home, "study.json")
        m = os.path.getmtime(path)
        if m != self.study_mtime:
            self.study = read_json(path)
            self.study_mtime = m
            os.makedirs(self.study["cases_dir"], exist_ok=True)

    def cases(self):
        return self.study.get("cases") or {}

    def case_dir(self, name):
        return os.path.join(self.study["cases_dir"], name)

    def job_dir(self, name):
        d = os.path.join(self.jobs, name)
        os.makedirs(d, exist_ok=True)
        return d

    def state(self, name):
        return read_json(os.path.join(self.job_dir(name), "state.json"), {"state": "queued", "extensions": 0, "history": []})

    def save(self, name, st):
        write_json(os.path.join(self.job_dir(name), "state.json"), st)

    def log(self, line):
        with open(os.path.join(self.home, "runner.log"), "a") as f:
            f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {line}\n")

    # -- phases

    def env_lines(self, name, spec):
        lines = ["set -o pipefail"]
        bashrc = self.study.get("of_bashrc") or ""
        if bashrc:
            lines.append(f"source {shlex.quote(bashrc)} >/dev/null 2>&1 || true")
        path_add = self.study.get("path") or []
        if path_add:
            lines.append("export PATH=" + ":".join(shlex.quote(p) for p in path_add) + ":$PATH")
        env = dict(self.study.get("env") or {})
        env.update(spec.get("env") or {})
        env.update(CASE=self.case_dir(name), NAME=name, NP=str(spec.get("np", 1)), STUDY=self.study["study_dir"],
                   CFD_HOME=self.home, CFD_STAGES=os.path.join(self.job_dir(name), "stages"),
                   CFD_TOOLS=os.path.join(self.home, "bin"))
        for k, v in env.items():
            lines.append(f"export {k}={shlex.quote(str(v))}")
        return lines

    def launch(self, name, phase, command, cwd):
        """Starts one phase of a case in a session of its own: <phase>.sh writes <phase>.rc when it ends."""
        spec = self.cases()[name]
        jd = self.job_dir(name)
        for ext in ("rc", "pid"):
            try:
                os.remove(os.path.join(jd, f"{phase}.{ext}"))
            except FileNotFoundError:
                pass
        script = os.path.join(jd, f"{phase}.sh")
        rc = os.path.join(jd, f"{phase}.rc")
        body = self.env_lines(name, spec) + [
            f"mkdir -p {shlex.quote(cwd)} && cd {shlex.quote(cwd)} || {{ echo 97 > {shlex.quote(rc)}.tmp; mv {shlex.quote(rc)}.tmp {shlex.quote(rc)}; exit 97; }}",
            "( " + command + " )",
            "code=$?",
            f"echo $code > {shlex.quote(rc)}.tmp && mv {shlex.quote(rc)}.tmp {shlex.quote(rc)}",
            "exit $code",
        ]
        with open(script, "w") as f:
            f.write("#!/bin/bash\n" + "\n".join(body) + "\n")
        logf = open(os.path.join(jd, f"{phase}.log"), "ab")
        p = subprocess.Popen(["bash", script], stdout=logf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                             start_new_session=True, cwd=self.home)
        logf.close()
        with open(os.path.join(jd, f"{phase}.pid"), "w") as f:
            f.write(str(p.pid))
        self.children[p.pid] = p
        self.log(f"{name}: {phase} started (pid {p.pid})")
        return p.pid

    def alive(self, name, phase):
        if self.exit_code(name, phase) is not None:  # it wrote how it ended: over, whatever its pid says
            child = self.children.pop(self.pid_of(name, phase), None)
            if child is not None:
                child.poll()
            return False
        jd = self.job_dir(name)
        try:
            pid = int(read_text(os.path.join(jd, f"{phase}.pid")).strip())
        except (OSError, ValueError):
            return False
        child = self.children.get(pid)
        if child is not None:
            return child.poll() is None
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        try:  # a pid reused since: not our job
            return os.path.join(jd, f"{phase}.sh") in read_text(f"/proc/{pid}/cmdline").replace("\0", " ")
        except OSError:
            return True

    def pid_of(self, name, phase):
        try:
            return int(read_text(os.path.join(self.job_dir(name), f"{phase}.pid")).strip())
        except (OSError, ValueError):
            return None

    def exit_code(self, name, phase):
        try:
            return int(read_text(os.path.join(self.job_dir(name), f"{phase}.rc")).strip())
        except (OSError, ValueError):
            return None

    def kill(self, name, phase):
        try:
            pid = int(read_text(os.path.join(self.job_dir(name), f"{phase}.pid")).strip())
            os.killpg(pid, signal.SIGTERM)
        except (OSError, ValueError, ProcessLookupError):
            pass

    def start_phase(self, name, st, phase, end=None, averages=None):
        spec = self.cases()[name]
        case = self.case_dir(name)
        tools = os.path.join(self.home, "bin")
        if phase == "build":
            cmd, cwd = spec["build"], self.study["study_dir"]
        elif phase == "run":
            cmd, cwd = spec.get("run") or f"bash {shlex.quote(os.path.join(tools, 'of-run.sh'))}", case
        elif phase == "extend":
            custom = spec.get("extend_cmd")
            if custom:
                cmd = f"END={shlex.quote(str(end))} AVERAGES={shlex.quote(averages or 'continue')} ; {custom}"
            else:
                cmd = f"bash {shlex.quote(os.path.join(tools, 'of-extend.sh'))} {shlex.quote(str(end))} {shlex.quote(averages or 'continue')}"
            cwd = case
            st["extensions"] = st.get("extensions", 0) + 1
            st["extend_to"] = end
        else:
            cmd, cwd = spec["post"], self.study["study_dir"]
        st.update(state={"build": "building", "run": "running", "extend": "extending", "post": "post"}[phase], phase=phase)
        st.setdefault("started", now())
        st["phase_started"] = now()
        self.launch(name, phase, cmd, cwd)
        self.save(name, st)

    def next_phase(self, name, st):
        """What follows a phase that ended well: judge the run, run it further, post, or finish."""
        spec = self.cases()[name]
        phase = st.get("phase")
        if phase == "build":
            return self.start_phase(name, st, "run")
        if phase in ("run", "extend"):
            case = self.case_dir(name)
            log = parse_log(solver_log(case, (spec.get("converge") or {}).get("log")) or "")
            verdict, why, mons = judge(case, spec.get("converge"), log)
            st.update(converged=verdict, why=why, time=log.get("time"))
            st["history"] = (st.get("history") or []) + [{"phase": phase, "time": log.get("time"), "converged": verdict,
                                                          "why": why, "at": now(),
                                                          "monitors": {m["name"]: m.get("rel_drift") for m in mons}}]
            manual = st.pop("manual_extend", None)
            ext = spec.get("extend") or {}
            end = number(dict_entry(os.path.join(case, "system", "controlDict"), "endTime"))
            if verdict is False and not manual and ext and end is not None:
                cap = float(ext.get("max") or end)
                step = float(ext.get("by") or 0)
                if step > 0 and end < cap:
                    new_end = min(cap, end + step)
                    self.log(f"{name}: not converged at {end:g} ({why}); running on to {new_end:g}")
                    return self.start_phase(name, st, "extend", end=fmt_num(new_end), averages=ext.get("averages"))
            if spec.get("post"):
                return self.start_phase(name, st, "post")
            return self.finish(name, st, "done")
        if phase == "post":
            st["post"] = post_output(os.path.join(self.job_dir(name), "post.log"))
            return self.finish(name, st, "done")

    def finish(self, name, st, state, error=None):
        st.update(state=state, ended=now())
        if error:
            st["error"] = error
        self.save(name, st)
        self.log(f"{name}: {state}" + (f" ({error})" if error else ""))

    def failure(self, name, st, phase, code):
        """Why a phase failed, in a few lines: the fatal error in the newest log it wrote, else its own output."""
        case = self.case_dir(name)
        since = st.get("phase_started") or 0  # an earlier phase's logs aren't this one's failure
        logs = [p for p in glob.glob(os.path.join(case, "log.*")) if os.path.isfile(p) and os.path.getmtime(p) >= since]
        if logs and phase in ("run", "extend"):
            newest = max(logs, key=os.path.getmtime)
            fatal = parse_log(newest).get("fatal")
            if fatal:
                return f"{os.path.basename(newest)}: {fatal}"
            stage_tail = tail(newest, 4000).strip().splitlines()[-8:]
            if stage_tail:
                return f"exit {code}; {os.path.basename(newest)} ends: " + "\n".join(stage_tail)
        own = tail(os.path.join(self.job_dir(name), f"{phase}.log"), 4000).strip().splitlines()[-10:]
        return f"{phase} exited {code}" + (": " + "\n".join(own) if own else "")

    # -- requests the appendage drops in a case's job folder

    def requests(self, name, st):
        path = os.path.join(self.job_dir(name), "request.json")
        req = read_json(path)
        if req is None:
            return st
        running = st.get("state") not in TERMINAL and st.get("state") != "queued"
        if req.get("cancel"):
            if running:
                self.kill(name, st.get("phase"))
            os.remove(path)
            self.finish(name, st, "cancelled")
            return st
        if req.get("rerun"):
            if running:
                self.kill(name, st.get("phase"))
                time.sleep(1)
            os.remove(path)
            for f in os.listdir(self.job_dir(name)):
                if f != "request.json":
                    os.remove(os.path.join(self.job_dir(name), f))
            st = {"state": "queued", "extensions": 0, "history": [], "queued": now()}
            self.save(name, st)
            self.log(f"{name}: queued again")
            return st
        if req.get("extend") and st.get("state") in TERMINAL:
            os.remove(path)
            e = req["extend"]
            case = self.case_dir(name)
            end = number(dict_entry(os.path.join(case, "system", "controlDict"), "endTime"))
            to = e.get("to") or ((end or 0) + float(e.get("by") or 0))
            st.pop("error", None)
            st["manual_extend"] = True
            st.pop("ended", None)
            self.log(f"{name}: extending to {to} as asked")
            self.start_phase(name, st, "extend", end=fmt_num(float(to)), averages=e.get("averages"))
            return st
        return st

    # -- one pass

    def tick(self):
        self.load()
        slots = int(self.study.get("slots") or os.cpu_count() or 1)
        used = 0
        queued = []
        for name in self.cases():
            st = self.state(name)
            st = self.requests(name, st)
            s = st.get("state")
            if s == "queued":
                queued.append(name)
                continue
            if s in TERMINAL:
                continue
            phase = st.get("phase")
            if self.alive(name, phase):
                used += int(self.cases()[name].get("np", 1))
                continue
            code = self.exit_code(name, phase)
            if code is None:  # gone without a word (the box restarted under it)
                self.finish(name, st, "failed", f"its {phase} stopped without an exit status")
            elif code != 0:
                self.finish(name, st, "failed", self.failure(name, st, phase, code))
            else:
                self.next_phase(name, st)
                if self.state(name).get("state") not in TERMINAL:
                    used += int(self.cases()[name].get("np", 1))
        for name in queued:
            np_ = int(self.cases()[name].get("np", 1))
            if used + np_ > slots and used > 0:
                continue
            st = self.state(name)
            st["queued_at"] = st.get("queued_at") or now()
            self.start_phase(name, st, "build" if self.cases()[name].get("build") else "run")
            used += np_
        status = self.status(used=used, slots=slots)
        write_json(os.path.join(self.home, "status.json"), status)
        return status

    # -- what it says

    def case_status(self, name):
        spec = self.cases()[name]
        st = self.state(name)
        case = self.case_dir(name)
        out = {"name": name, "state": st.get("state"), "np": spec.get("np", 1), "extensions": st.get("extensions", 0),
               "converged": st.get("converged"), "why": st.get("why"), "error": st.get("error"),
               "started": st.get("started"), "ended": st.get("ended")}
        stages = tail(os.path.join(self.job_dir(name), "stages"), 4000).strip().splitlines()
        if stages and st.get("state") in ("running", "extending"):
            out["stage"] = stages[-1].split(" ", 1)[-1]
        end = number(dict_entry(os.path.join(case, "system", "controlDict"), "endTime"))
        out["end_time"] = end
        if st.get("state") in ("running", "extending", "post", "done", "failed", "cancelled"):
            path = solver_log(case, (spec.get("converge") or {}).get("log"))
            if path:
                log = parse_log(path)
                out.update(time=log["time"], residuals={k: float(f"{v:.3g}") for k, v in log["residuals"].items()},
                           sec_per_step=log["sec_per_step"], log=os.path.relpath(path, case))
                if log["time"] is not None and end:
                    out["progress"] = round(min(1.0, log["time"] / end), 4)
                if st.get("state") in ("running", "extending"):
                    mons = [monitor(case, m) for m in (spec.get("converge") or {}).get("monitors") or []]
                    out["monitors"] = {m["name"]: compact(m) for m in mons}
                    if log.get("fatal"):
                        out["fatal"] = log["fatal"]
        if st.get("state") in TERMINAL and st.get("history"):
            last = st["history"][-1]
            out["monitors"] = {k: {"rel_drift": v} for k, v in (last.get("monitors") or {}).items()}
        if st.get("post") is not None:
            out["post"] = st["post"]
        if out["started"]:
            out["elapsed_s"] = round((out["ended"] or now()) - out["started"])
        return out

    def status(self, used=None, slots=None):
        cases = [self.case_status(n) for n in self.cases()]
        counts = {}
        for c in cases:
            counts[c["state"]] = counts.get(c["state"], 0) + 1
        done = bool(cases) and all(c["state"] in TERMINAL for c in cases)
        load = None
        try:
            load = round(os.getloadavg()[0], 2)
        except OSError:
            pass
        return {"study": self.study.get("id"), "round": self.study.get("round", 1), "updated": now(),
                "state": "done" if done else "running", "counts": counts, "slots": slots, "cores_used": used,
                "load": load, "cases": cases}

    def serve(self, every=10.0):
        self.log("runner started")
        while True:
            try:
                self.tick()
            except Exception as e:  # one bad pass (a case folder half-written) mustn't stop the matrix
                self.log(f"pass failed: {type(e).__name__}: {e}")
            time.sleep(every)


def compact(m):
    keep = ("value", "mean", "std", "rel_drift", "rel_std", "ok", "why", "rows", "to_time")
    return {k: (float(f"{m[k]:.4g}") if isinstance(m.get(k), float) else m.get(k)) for k in keep if k in m}


def fmt_num(x):
    return str(int(x)) if float(x).is_integer() else f"{x:g}"


def post_output(path):
    """A post command's answer: the last line of its output that parses as JSON (cut to 4 KB), else its last lines."""
    text = tail(path, 64 * 1024).strip()
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line.startswith("{") or line.startswith("["):
            try:
                data = json.loads(line)
            except ValueError:
                continue
            raw = json.dumps(data)
            return data if len(raw) <= 4096 else {"truncated": raw[:4000]}
    return {"output": "\n".join(text.splitlines()[-5:])[-1000:]} if text else None


# ---------------------------------------------------------------------------------------------
# What a fetch takes

TIME_DIR = re.compile(rf"^{NUM}$")
DEFAULT_EXCLUDE = ["processor*", "constant/polyMesh", "constant/extendedFeatureEdgeMesh", "*.eMesh", "dynamicCode",
                   "core", "core.*", "*.foam"]


def fetch_files(cases_dir, names, fields=False, include=(), exclude=()):
    """Paths (relative to cases_dir) a fetch brings back: each case less its mesh, processor folders and time
    folders (the latest kept with fields), plus what include globs name; exclude globs leave more out."""
    out = []
    excl = list(DEFAULT_EXCLUDE) + list(exclude)
    for name in names:
        root = os.path.join(cases_dir, name)
        if not os.path.isdir(root):
            continue
        times = [d for d in os.listdir(root) if TIME_DIR.match(d) and os.path.isdir(os.path.join(root, d))]
        latest = max(times, key=float) if times else None
        for dirpath, dirnames, filenames in os.walk(root):
            rel_dir = os.path.relpath(dirpath, root)
            keep_dirs = []
            for d in dirnames:
                rel = os.path.normpath(os.path.join(rel_dir, d))
                if rel_dir == "." and TIME_DIR.match(d):
                    if not (fields and d == latest) and not any(fnmatch.fnmatch(rel, g) for g in include):
                        continue
                if any(fnmatch.fnmatch(rel, g) or fnmatch.fnmatch(d, g) for g in excl) and not any(fnmatch.fnmatch(rel, g) for g in include):
                    continue
                keep_dirs.append(d)
            dirnames[:] = keep_dirs
            for f in filenames:
                rel = os.path.normpath(os.path.join(rel_dir, f))
                if any(fnmatch.fnmatch(rel, g) or fnmatch.fnmatch(f, g) for g in excl) and not any(fnmatch.fnmatch(rel, g) for g in include):
                    continue
                out.append(os.path.join(name, rel))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["serve", "once", "status", "files"])
    ap.add_argument("--home", default="/root/cfd")
    ap.add_argument("--every", type=float, default=10.0)
    ap.add_argument("--fields", action="store_true")
    ap.add_argument("--include", action="append", default=[])
    ap.add_argument("--exclude", action="append", default=[])
    ap.add_argument("--case", action="append", default=[])
    a = ap.parse_args(argv)
    r = Runner(a.home)
    if a.cmd == "serve":
        r.serve(a.every)
    elif a.cmd == "once":
        print(json.dumps(r.tick()))
    elif a.cmd == "status":
        print(json.dumps(r.status()))
    else:
        names = a.case or list(r.cases())
        files = fetch_files(r.study["cases_dir"], names, a.fields, a.include, a.exclude)
        sizes = 0
        for f in files:
            try:
                sizes += os.path.getsize(os.path.join(r.study["cases_dir"], f))
            except OSError:
                pass
        print(json.dumps({"files": files, "bytes": sizes}))


if __name__ == "__main__":
    sys.exit(main())
