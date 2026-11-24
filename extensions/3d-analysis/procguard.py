"""Keeps a worker from outliving its job or running the Mac out of memory.

A worker started through `uv run` is uv's child: killing the Popen kills uv and leaves the Python it started running,
which is how one mesh verify kept growing to 12.5 GB for 14 minutes after its call gave up and took a 16 GB machine down
(Nov 17, 13:16-13:34). So a worker is started in a process group of its own (start_new_session=True), the whole group
is killed when it's stopped, and its memory is watched as macOS counts it (the physical footprint, compressed pages
included, as Activity Monitor and jetsam do; RSS alone shrinks as pages get compressed) against a ceiling.
"""

import contextlib
import ctypes
import os
import signal
import subprocess
import time

_LIBPROC = None


def _libproc():
    global _LIBPROC
    if _LIBPROC is None:
        try:
            _LIBPROC = ctypes.CDLL("/usr/lib/libproc.dylib")
        except OSError:
            _LIBPROC = False
    return _LIBPROC


def footprint(pid):
    """A process's physical footprint in bytes (rusage_info_v0's ri_phys_footprint), else its RSS, else None."""
    lib = _libproc()
    if lib:
        buf = ctypes.create_string_buffer(512)
        if lib.proc_pid_rusage(int(pid), 0, buf) == 0:
            return int.from_bytes(buf.raw[72:80], "little")
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(int(pid))], capture_output=True, text=True, timeout=5).stdout
        return int(out.strip()) * 1024 if out.strip() else None
    except Exception:
        return None


def group_pids(pgid):
    """The processes in a process group (the worker and everything it started)."""
    try:
        out = subprocess.run(["ps", "-axo", "pid=,pgid="], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return [pgid]
    pids = [int(a) for a, b in (line.split() for line in out.splitlines() if len(line.split()) == 2) if b == str(pgid)]
    return pids or [pgid]


def tree_pids(root):
    """A process and every process under it, by parent, whatever group or session each one is in."""
    try:
        out = subprocess.run(["ps", "-axo", "pid=,ppid="], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return [root]
    kids = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2:
            kids.setdefault(int(parts[1]), []).append(int(parts[0]))
    seen, todo = [], [root]
    while todo:
        pid = todo.pop()
        if pid not in seen:
            seen.append(pid)
            todo.extend(kids.get(pid, []))
    return seen


def group_bytes(pgid):
    return sum(b for b in (footprint(pid) for pid in group_pids(pgid)) if b)


def tree_bytes(root):
    return sum(b for b in (footprint(pid) for pid in tree_pids(root)) if b)


def limit_bytes(env_name, default_gb):
    """The ceiling: env_name's GB if it's set to a number, else default_gb."""
    try:
        gb = float(os.environ.get(env_name) or default_gb)
    except ValueError:
        gb = float(default_gb)
    return int(gb * 2**30)


def kill_tree(p):
    """Kill the worker's whole process group (uv and the Python under it), then reap it."""
    with contextlib.suppress(ProcessLookupError, PermissionError, OSError):
        os.killpg(p.pid, signal.SIGKILL)
    with contextlib.suppress(Exception):
        p.kill()
    with contextlib.suppress(Exception):
        p.wait(timeout=5)


class Watch:
    """Looks at a worker's group (or with tree=True, everything under it, for one left in its caller's group) every
    `every` seconds: check() is True once it's past `limit` bytes; peak is the most it was seen using."""

    def __init__(self, p, limit, every=1.0, tree=False):
        self.p, self.limit, self.every = p, limit, every
        self.measure = tree_bytes if tree else group_bytes
        self.peak, self._last = 0, 0.0

    def check(self):
        now = time.monotonic()
        if now - self._last < self.every:
            return False
        self._last = now
        used = self.measure(self.p.pid)
        self.peak = max(self.peak, used)
        return used > self.limit

    def message(self, what="the job"):
        return (f"stopped {what} at {self.peak / 2**30:.1f} GB: past the {self.limit / 2**30:.0f} GB one may use on this "
                f"Mac, so it couldn't run it out of memory")
