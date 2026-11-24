#!/usr/bin/env python3
"""The FEA box's own scheduler: runs a study's cases as the box's threads and memory allow (each in a memory share
of its own, started only once that share is free, so a heavy case runs alone), keeps status.json current for the fea appendage to read over ssh, and once a round's cases are all
finished draws the study's comparison. Standard library only (the box's python3).

  runner.py serve  --home /root/fea     # the loop (its systemd unit runs this)
  runner.py once   --home DIR           # one pass, for tests
  runner.py files  --home DIR [--case NAME]... [--frd]   # what a fetch takes, as JSON

The home holds study.json (written by the appendage), status.json, cases/<name>/ (case.json and the part, from
the appendage; what the engine writes) and jobs/<name>/ (state.json, the engine's log, its exit status, and
request.json, a request the appendage drops there: {"cancel": true} or {"rerun": true}). Each job runs in a
session of its own, so the runner can restart under it and pick it up again from jobs/.
"""

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time

TERMINAL = ("done", "failed", "cancelled")
POLL_S = float(os.environ.get("FEA_RUNNER_POLL_S") or 3)


def now():
    return time.time()


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


def tail(path, n=2000):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - n))
            return f.read().decode("utf-8", "replace")
    except OSError:
        return ""


def alive(pid):
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
    except (OSError, ValueError):
        return False
    try:  # a zombie isn't running
        with open(f"/proc/{int(pid)}/stat") as f:
            return f.read().split(")")[-1].split()[0] != "Z"
    except OSError:
        return True


def kill_group(pid):
    try:
        os.killpg(int(pid), signal.SIGKILL)
    except (OSError, ValueError):
        try:
            os.kill(int(pid), signal.SIGKILL)
        except (OSError, ValueError):
            pass


def mem_total_mb():
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) // 1024
    except OSError:
        pass
    return None


class Runner:
    def __init__(self, home):
        self.home = os.path.abspath(home)
        self.jobs = os.path.join(self.home, "jobs")
        self.cases = os.path.join(self.home, "cases")
        os.makedirs(self.jobs, exist_ok=True)
        os.makedirs(self.cases, exist_ok=True)
        self.procs = {}

    def study(self):
        return read_json(os.path.join(self.home, "study.json"))

    def job_dir(self, name):
        d = os.path.join(self.jobs, name)
        os.makedirs(d, exist_ok=True)
        return d

    def state(self, name):
        return read_json(os.path.join(self.job_dir(name), "state.json"), {"state": "queued", "round": 0})

    def save_state(self, name, st):
        write_json(os.path.join(self.job_dir(name), "state.json"), st)

    # ---- one pass

    def once(self):
        study = self.study()
        if not study:
            return None
        rnd = int(study.get("round") or 1)
        slots = int(study.get("slots") or os.cpu_count() or 4)
        names = list((study.get("cases") or {}).keys())
        states = {}
        for name in names:
            cfg = study["cases"][name]
            st = self.state(name)
            st = self.requests(name, st)
            if st.get("round", 0) < int(cfg.get("round") or 1) and st["state"] in TERMINAL + ("queued",):
                st = {"state": "queued", "round": int(cfg.get("round") or 1)}  # added or changed for this round
                self.clear(name)
                self.save_state(name, st)
            if st["state"] == "running":
                st = self.check(name, st, cfg)
            states[name] = st
        # a case starts only when its threads and its memory are both free, so cases never split the box's
        # memory between them beyond what each was given
        box_mem = int(study.get("mem_mb") or (mem_total_mb() or 0) * 0.9) or None
        running = [n for n, s in states.items() if s["state"] == "running"]
        used = sum(int(study["cases"][n].get("threads") or 1) for n in running)
        used_mem = sum(int(study["cases"][n].get("mem_mb") or 0) for n in running)
        for name in names:
            st = states[name]
            if st["state"] != "queued":
                continue
            need = int(study["cases"][name].get("threads") or 1)
            need_mem = int(study["cases"][name].get("mem_mb") or 0)
            if used and used + need > slots:
                continue
            if used_mem and box_mem and used_mem + need_mem > box_mem:
                continue
            st = self.launch(name, st, study)
            states[name] = st
            used += need
            used_mem += need_mem
        status = self.status(study, states)
        if status["state"] == "done" and not status.get("compare") and status["round"] == rnd:
            status["compare"] = self.compare(study, names)
        write_json(os.path.join(self.home, "status.json"), status)
        return status

    def requests(self, name, st):
        path = os.path.join(self.job_dir(name), "request.json")
        req = read_json(path)
        if not req:
            return st
        os.remove(path)
        if req.get("cancel") and st["state"] not in TERMINAL:
            if st.get("pid"):
                kill_group(st["pid"])
            st.update(state="cancelled", ended=now())
        elif req.get("rerun"):
            if st.get("pid") and alive(st["pid"]):
                kill_group(st["pid"])
            self.clear(name)
            st = {"state": "queued", "round": st.get("round", 0)}
        self.save_state(name, st)
        return st

    def clear(self, name):
        d = os.path.join(self.cases, name)
        for f in ("result.json", "progress.json", "job.frd", "job.dat", "job.sta", "job.cvg", "ccx.log", "setup.png",
                  "strain.png", "curve.png"):
            try:
                os.remove(os.path.join(d, f))
            except OSError:
                pass
        try:
            os.remove(os.path.join(self.job_dir(name), "exit"))
        except OSError:
            pass

    def launch(self, name, st, study):
        cfg = study["cases"][name]
        case_dir = os.path.join(self.cases, name)
        jd = self.job_dir(name)
        log = open(os.path.join(jd, "engine.log"), "w")
        python = study.get("python") or sys.executable
        engine = study.get("engine") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "engine.py")
        inner = f"{sh(python)} {sh(engine)} run {sh(case_dir)}; echo $? > {sh(os.path.join(jd, 'exit'))}"
        argv = ["bash", "-c", inner]
        mem = cfg.get("mem_mb")
        if mem and shutil.which("systemd-run") and os.geteuid() == 0:
            argv = ["systemd-run", "--scope", "-q", "-p", f"MemoryMax={int(mem)}M", "-p", "MemorySwapMax=0", "--"] + argv
        env = dict(os.environ, OMP_NUM_THREADS=str(cfg.get("threads") or 1), MPLBACKEND="Agg")
        p = subprocess.Popen(argv, cwd=case_dir, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                             start_new_session=True, env=env)
        self.procs[name] = p
        st = {"state": "running", "round": st.get("round") or int(cfg.get("round") or 1), "pid": p.pid, "started": now(),
              "mem_mb": mem}
        self.save_state(name, st)
        return st

    def check(self, name, st, cfg):
        p = self.procs.get(name)
        if p is not None:
            p.poll()
        jd = self.job_dir(name)
        exit_path = os.path.join(jd, "exit")
        running = alive(st.get("pid")) and not os.path.exists(exit_path)
        limit = float(cfg.get("timeout_s") or 5400) + 900
        if running and now() - (st.get("started") or now()) > limit:
            kill_group(st["pid"])
            st.update(state="failed", ended=now(), error=f"it ran past {limit / 60:.0f} minutes and was stopped")
            self.save_state(name, st)
            return st
        if running:
            return st
        result = read_json(os.path.join(self.cases, name, "result.json"))
        code = None
        try:
            code = int(open(exit_path).read().strip())
        except (OSError, ValueError):
            pass
        st["ended"] = now()
        st["exit"] = code
        if result and result.get("ok"):
            st["state"] = "done"
        else:
            st["state"] = "failed"
            if result and result.get("error"):
                st["error"] = result["error"]
            elif code in (137, None) and st.get("mem_mb"):
                st["error"] = (f"it was stopped (exit {code}): most likely it ran out of its {st['mem_mb']} MB memory "
                               "share; a coarser mesh (mesh.budget)")
            else:
                st["error"] = f"the engine stopped (exit {code}): " + tail(os.path.join(jd, "engine.log"), 800).strip()[-600:]
        self.procs.pop(name, None)
        self.save_state(name, st)
        return st

    def status(self, study, states):
        rows = []
        counts = {}
        for name, st in states.items():
            row = {"name": name, "state": st["state"], "round": st.get("round")}
            prog = read_json(os.path.join(self.cases, name, "progress.json")) or {}
            if st["state"] == "running":
                row.update(stage=prog.get("stage"), fraction=prog.get("fraction"), elements=prog.get("elements"),
                           increments=prog.get("increments"))
            if st.get("started"):
                row["elapsed_s"] = round((st.get("ended") or now()) - st["started"], 1)
            if st.get("error"):
                row["error"] = st["error"]
            if st["state"] == "done":
                r = read_json(os.path.join(self.cases, name, "result.json")) or {}
                row["headline"] = r.get("headline")
                s = r.get("strain") or {}
                if s:
                    row["strain_pct"] = round((s.get("strain_clear") or s.get("strain_max") or 0) * 100, 3)
                    if s.get("of_strength") is not None:
                        row["of_strength"] = s["of_strength"]
                row["complete"] = r.get("complete")
                row["reached"] = r.get("reached")
                row["warnings"] = r.get("warnings")
                row["elements"] = (r.get("mesh") or {}).get("elements")
                row["mass_g"] = r.get("mass_g")
            counts[st["state"]] = counts.get(st["state"], 0) + 1
            rows.append(row)
        rnd = int(study.get("round") or 1)
        done = bool(rows) and all(r["state"] in TERMINAL for r in rows)
        prev = read_json(os.path.join(self.home, "status.json")) or {}
        out = {"state": "done" if done else "running", "round": rnd, "counts": counts, "cases": rows,
               "slots": study.get("slots"), "updated": now()}
        try:
            out["load"] = os.getloadavg()[0]
        except OSError:
            pass
        if done and prev.get("round") == rnd and prev.get("state") == "done" and prev.get("compare"):
            out["compare"] = prev["compare"]
        return out

    def compare(self, study, names):
        python = study.get("python") or sys.executable
        engine = study.get("engine") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "engine.py")
        dirs = [os.path.join(self.cases, n) for n in names]
        argv = [python, engine, "compare", self.home] + dirs
        if study.get("reference"):
            argv += ["--reference", study["reference"]]
        if study.get("target"):
            argv += ["--target", json.dumps(study["target"])]
        try:
            done = subprocess.run(argv, capture_output=True, text=True, timeout=600)
        except subprocess.TimeoutExpired:
            return {"error": "drawing the comparison took over 10 minutes"}
        out = read_json(os.path.join(self.home, "compare.json"))
        if done.returncode != 0 or not out:
            return {"error": (done.stderr or done.stdout or "compare failed").strip()[-800:]}
        return out

    def serve(self):
        while True:
            try:
                self.once()
            except Exception as e:  # keep serving; say what went wrong where the appendage reads
                write_json(os.path.join(self.home, "runner-error.json"), {"at": now(), "error": f"{type(e).__name__}: {e}"})
            time.sleep(POLL_S)


def sh(s):
    import shlex
    return shlex.quote(str(s))


def files(home, cases=None, frd=False):
    """What a fetch brings: each case's results, its deck and logs (and job.frd with frd), the study's comparison."""
    out, size = [], 0
    keep_names = {"result.json", "case.json", "progress.json", "setup.png", "strain.png", "curve.png", "job.inp",
                  "job.sta", "ccx.log", "job.dat"} | ({"job.frd"} if frd else set())
    for top in ("compare.json", "compare.png", "status.json", "study.json"):
        p = os.path.join(home, top)
        if os.path.exists(p):
            out.append(top)
            size += os.path.getsize(p)
    root = os.path.join(home, "cases")
    for name in sorted(os.listdir(root)) if os.path.isdir(root) else []:
        if cases and name not in cases:
            continue
        for f in sorted(os.listdir(os.path.join(root, name))):
            if f in keep_names or f.endswith((".stl", ".step", ".stp")):
                rel = os.path.join("cases", name, f)
                out.append(rel)
                size += os.path.getsize(os.path.join(home, rel))
    return {"files": out, "bytes": size}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["serve", "once", "files"])
    ap.add_argument("--home", required=True)
    ap.add_argument("--case", action="append")
    ap.add_argument("--frd", action="store_true")
    a = ap.parse_args()
    if a.cmd == "files":
        print(json.dumps(files(a.home, a.case, a.frd)))
        return
    r = Runner(a.home)
    if a.cmd == "once":
        print(json.dumps(r.once()))
    else:
        r.serve()


if __name__ == "__main__":
    main()
