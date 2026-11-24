"""mesh-python: Python in mesh's own environment (pyenv.py: trimesh, manifold3d, numpy, scipy, shapely, matplotlib and the
rest, pinned), for anyone's geometry scripts, instead of a python3 that lacks them or a venv made by hand:

    mesh-python glide.py --n 8          mesh-python -c "import trimesh; ..."          mesh-python - <<'EOF' ... EOF
    mesh-python --with build123d --with pymupdf clip.py        (packages beyond the pins, for that run; uv keeps each set)

Everything after the --with options is python's own command line, run where it's called from, with its stdin, stdout
and stderr, and mesh-python exits as python did. It runs the way mesh runs its worker: niced, its memory watched as
macOS counts it against MESH_MAX_GB (5 GB by default), and everything under it stopped
once it outgrows that or mesh-python is stopped itself. mesh writes the command (~/.local/bin/mesh-python) and
writes it again whenever it's gone or differs.

Kept to Python 3.9, so whichever python3 a shell finds first can run it.
"""

import os
import signal
import subprocess
import sys
import time

import procguard
import pyenv

NICE = 15
GRACE_S = 2.0


def parse(argv):
    """The packages asked for with --with (before anything else) and python's own arguments after them."""
    extra, i = [], 0
    while i < len(argv):
        a = argv[i]
        if a == "--with" and i + 1 < len(argv):
            extra.append(argv[i + 1])
            i += 2
        elif a.startswith("--with="):
            extra.append(a.split("=", 1)[1])
            i += 1
        else:
            break
    return extra, argv[i:]


def stop(pids, sig):
    for pid in pids:
        try:
            os.kill(pid, sig)
        except (ProcessLookupError, PermissionError, OSError):
            pass


def stop_tree(p, grace=GRACE_S):
    """Everything under p, and p: asked to stop, then killed after grace seconds."""
    pids = procguard.tree_pids(p.pid)
    stop(pids, signal.SIGTERM)
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline and p.poll() is None:
        time.sleep(0.05)
    stop(procguard.tree_pids(p.pid) if p.poll() is None else pids, signal.SIGKILL)
    try:
        p.wait(timeout=5)
    except Exception:
        pass


def main(argv=None):
    extra, args = parse(list(sys.argv[1:] if argv is None else argv))
    try:
        cmd = pyenv.command(args, extra)
    except RuntimeError as e:
        print(f"mesh-python: {e}", file=sys.stderr)
        return 127
    nice = "/usr/bin/nice"
    if os.access(nice, os.X_OK):
        cmd = [nice, "-n", str(NICE), *cmd]
    env = dict(os.environ)
    env.setdefault("MPLBACKEND", "Agg")
    limit = procguard.limit_bytes("MESH_MAX_GB", 5)
    # Left in the caller's process group, so a stop aimed at the caller's group (Ctrl-C, a cancelled exec) reaches it
    # too; what it started is found by parent instead, to measure and stop.
    p = subprocess.Popen(cmd, env=env)
    stopped = {}

    def on_signal(sig, _frame):
        stopped["sig"] = sig
        stop_tree(p)

    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, on_signal)
    watch = procguard.Watch(p, limit, every=1.0, tree=True)
    try:
        while p.poll() is None:
            if watch.check():
                print(f"mesh-python: {watch.message('the script')} (MESH_MAX_GB sets how much)", file=sys.stderr)
                stop_tree(p, grace=0)
                return 137
            time.sleep(0.2)
    finally:
        if p.poll() is None:
            stop_tree(p)
    if "sig" in stopped:
        return 128 + stopped["sig"]
    return p.returncode if p.returncode >= 0 else 128 - p.returncode


if __name__ == "__main__":
    sys.exit(main())
