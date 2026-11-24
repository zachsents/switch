"""The one Python environment mesh's geometry runs in: its worker's, and mesh-python's (meshpython.py) for anyone's own
scripts. uv builds it once from these pins on its own Python 3.12 (never Homebrew's, which an upgrade swaps out) and
keeps it in its cache; a pruned cache only means the next run builds it again.
"""

import os
import shutil

DEPS = ("trimesh==5.2.1", "numpy==2.5.5", "scipy==1.18.1", "shapely==2.2.0", "matplotlib==3.11.2", "embreex==4.4.0.post1",
        "cascadio==0.1.1", "rtree==1.4.1", "networkx==3.7", "lxml==6.1.3", "pillow==13.0.0", "mapbox_earcut==2.1.0",
        "manifold3d==3.5.5")
"""Pinned so a report reads the same next month."""
PYTHON = "3.12"


def uv():
    found = os.environ.get("MESH_UV") or shutil.which("uv") or next(
        (p for p in ("/opt/homebrew/bin/uv", "/usr/local/bin/uv", os.path.expanduser("~/.local/bin/uv")) if os.access(p, os.X_OK)),
        None)
    if not found:
        raise RuntimeError("uv isn't installed on this Mac (brew install uv)")
    return found


def command(args, extra=()):
    """uv's command line that runs python with args in the environment, extra packages added (uv keeps each set)."""
    deps = [*DEPS, *extra]
    return [uv(), "run", "--no-project", "--quiet", "--python", PYTHON, *[a for d in deps for a in ("--with", d)], "python",
            *args]
