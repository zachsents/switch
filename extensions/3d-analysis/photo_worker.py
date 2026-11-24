"""photo-measure's image work, run under mesh-python (numpy, scipy, Pillow; pyobjc's Vision for reading text), so the
server itself stays on the standard library and every heavy step is niced and memory-capped the way mesh's are.

    mesh-python --with pyobjc-framework-Vision --with pyobjc-framework-Quartz -I photo_worker.py <command> < args.json

Commands (their arguments as one JSON object on stdin, their answer as one JSON object on stdout):

- scan: each photo's size, what it is (photo, drawing or infographic) and the text on it (macOS Vision), and a numbered
  contact sheet of them all.
- look: a region of a photo, zoomed, with a grid labelled in the photo's own pixels, for picking points to measure.
- measure: rows of evenly spaced features (pads, pins, holes) found on their own, the part's size along and across
  each row and the features symmetric about it, all in mm against a reference (a known pitch, two points a known
  distance apart, or the part's known length), with a picture of what was measured drawn on it.

Photos are untrusted data: they're only ever opened as images here.
"""

import json
import math
import os
import re
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage
from scipy.spatial import cKDTree

MAX_SIDE = 2000
"""Photos larger than this on their long side are measured at this size (the answer is in the photo's own pixels)."""
FONTS = ["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Helvetica.ttc",
         "/Library/Fonts/Arial.ttf", "/System/Library/Fonts/SFNS.ttf"]


def font(size):
    for f in FONTS:
        if os.path.exists(f):
            try:
                return ImageFont.truetype(f, size)
            except OSError:
                pass
    return ImageFont.load_default()


def load(path):
    im = Image.open(path)
    im.load()
    if im.mode in ("RGBA", "LA", "P"):
        rgba = im.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        im = Image.alpha_composite(bg, rgba)
    return im.convert("RGB")


# --- colour ---------------------------------------------------------------------------------------------------------

def lab(rgb):
    """sRGB (0-255, ...x3) to CIE Lab (D65)."""
    c = rgb.astype(np.float32) / 255.0
    c = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]], np.float32)
    xyz = c @ m.T / np.array([0.95047, 1.0, 1.08883], np.float32)
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    L = 116 * f[..., 1] - 16
    a = 500 * (f[..., 0] - f[..., 1])
    b = 200 * (f[..., 1] - f[..., 2])
    return np.stack([L, a, b], -1)


def background(L):
    """The background's colour: the median of the photo's border."""
    h, w, _ = L.shape
    e = max(2, int(0.015 * min(h, w)))
    border = np.concatenate([L[:e].reshape(-1, 3), L[-e:].reshape(-1, 3), L[:, :e].reshape(-1, 3), L[:, -e:].reshape(-1, 3)])
    return np.median(border, 0)


# --- blobs ----------------------------------------------------------------------------------------------------------

def refine(chan, x, y, r, sign):
    """A blob's own outline: the region around its centre on its side of the midpoint between it and what surrounds
    it, closed within a window around it. What surrounds a feature near an edge is part plate and part background, so
    several levels of the ring around it are tried, middle first. None when it has no outline of its own there."""
    h, w = chan.shape
    R = int(math.ceil(2.2 * r)) + 2
    x0, y0, x1, y1 = max(0, int(x) - R), max(0, int(y) - R), min(w, int(x) + R + 1), min(h, int(y) + R + 1)
    win = chan[y0:y1, x0:x1] * sign
    yy, xx = np.mgrid[y0:y1, x0:x1]
    dd = np.hypot(xx - x, yy - y)
    inner = win[dd <= max(1.0, 0.5 * r)]
    ring = win[(dd >= 1.6 * r) & (dd <= 2.2 * r)]
    if inner.size == 0 or ring.size < 8:
        return None
    cy, cx = int(round(y)) - y0, int(round(x)) - x0
    if not (0 <= cy < win.shape[0] and 0 <= cx < win.shape[1]):
        return None
    hi = float(np.median(inner))
    expect = math.pi * r * r
    for q in (50, 25, 75, 10, 90):
        lo = float(np.percentile(ring, q))
        if hi - lo < 4:
            continue
        m = win > (hi + lo) / 2
        lab_, _ = ndimage.label(m)
        if lab_[cy, cx] == 0:
            continue
        reg = lab_ == lab_[cy, cx]
        ys, xs = np.nonzero(reg)
        if ys.min() == 0 or xs.min() == 0 or ys.max() == m.shape[0] - 1 or xs.max() == m.shape[1] - 1:
            continue
        if len(xs) < 5 or not 0.15 * expect <= len(xs) <= 4 * expect:
            continue
        return xs + x0, ys + y0
    return None


PEAKS = 1500
"""At most this many of the strongest candidates per channel are outlined."""


def log_peaks(img, top, name, sign, chan, floor=6.0):
    """Blobs brighter than their surroundings at every scale up to top (a radius in pixels): Laplacian-of-Gaussian
    peaks found an octave at a time on a halved image, so large scales cost what small ones do."""
    out = []
    level = img.astype(np.float32)
    f = 1
    sig = [1.2, 1.5, 1.9, 2.4, 3.0]
    while True:
        stack = np.stack([-(s ** 2) * ndimage.gaussian_laplace(level, s) for s in sig])
        peaks = (stack == ndimage.maximum_filter(stack, size=(3, 3, 3))) & (stack > floor)
        for k, y, x in zip(*np.nonzero(peaks)):
            out.append((float(stack[k, y, x]), name, sign, chan, int(x * f + (f - 1) / 2), int(y * f + (f - 1) / 2),
                        sig[k] * f * math.sqrt(2)))
        if sig[-1] * f * 1.4 > top or min(level.shape) < 40:
            break
        level = ndimage.gaussian_filter(level, 1.0)[::2, ::2]
        f *= 2
    out.sort(key=lambda q: -q[0])
    return out[:PEAKS]


def find_blobs(rgb, L, bg, mask_boxes=()):
    """Candidate features at every scale (Laplacian of Gaussian on lightness, both ways, and on how colourful it is),
    each outlined on its own, the same feature found twice kept once. Anything inside mask_boxes (text) is left out."""
    h, w, _ = L.shape
    light = L[..., 0]
    chroma = np.hypot(L[..., 1], L[..., 2])
    dist_bg = np.sqrt(((L - bg) ** 2).sum(-1))
    fg = ndimage.binary_opening(dist_bg > 22, iterations=1)
    solid = ndimage.binary_fill_holes(ndimage.binary_closing(fg, iterations=2))
    top = max(4.0, min(h, w) / 6.0)
    found = []
    for name, chan, sign in (("light", light, 1), ("dark", light, -1), ("colour", chroma, 1)):
        if name == "colour" and chroma.max() < 15:
            continue
        found += log_peaks(chan * sign, top, name, sign, chan)
    found.sort(key=lambda f: -f[0])
    out = []
    grid = {}
    cell = 8

    def near(x, y, r):
        cx, cy = int(x // cell), int(y // cell)
        reach = int(r // cell) + 1
        for gx in range(cx - reach, cx + reach + 1):
            for gy in range(cy - reach, cy + reach + 1):
                for b in grid.get((gx, gy), ()):
                    yield b

    for resp, name, sign, chan, x, y, r in found:
        if any(bx0 <= x <= bx1 and by0 <= y <= by1 for bx0, by0, bx1, by1 in mask_boxes):
            continue
        reg = refine(chan, x, y, r, sign)
        if reg is None:
            continue
        xs, ys = reg
        area = len(xs)
        if area > 0.06 * h * w:
            continue
        cx, cy = float(xs.mean()), float(ys.mean())
        d = 2 * math.sqrt(area / math.pi)
        dup = False
        for b in near(cx, cy, d):
            if b["kind"] == name and math.hypot(b["c"][0] - cx, b["c"][1] - cy) < 0.35 * min(b["d"], d) and \
                    max(b["d"], d) / min(b["d"], d) < 1.6:
                b["seen"].add(name)
                dup = True
                break
        if dup:
            continue
        cov = np.cov(np.stack([xs - cx, ys - cy])) if area > 2 else np.eye(2)
        ev = np.linalg.eigvalsh(cov)
        aspect = math.sqrt(max(ev[1], 1e-6) / max(ev[0], 1e-6))
        if aspect > 4:
            continue
        colour = rgb[ys, xs].mean(0)
        b = {"c": (cx, cy), "area": area, "d": d, "cov": cov, "kind": name, "seen": {name}, "response": resp,
             "lab": L[ys, xs].mean(0), "rgb": [int(v) for v in colour],
             "bbox": (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))}
        out.append(b)
        grid.setdefault((int(cx // cell), int(cy // cell)), []).append(b)
    return out, solid, None


# --- rows -----------------------------------------------------------------------------------------------------------

def similar(a, b, ratio=2.2, colour=30.0):
    """Alike enough to be the same kind of feature: their areas within ratio and their colours within colour (Lab)."""
    if max(a["area"], b["area"]) / max(1, min(a["area"], b["area"])) > ratio:
        return False
    return float(np.sqrt(((a["lab"] - b["lab"]) ** 2).sum())) <= colour


def walk(blobs, members, tree, i, j):
    """From i through j, on along the same step (allowed to change slowly, as perspective does) while a like blob
    is where the next one should be."""
    chain = [i, j]
    for direction in (1, -1):
        if direction == 1:
            prev, cur = i, j
        else:
            prev, cur = j, i
        step = np.subtract(blobs[cur]["c"], blobs[prev]["c"])
        while True:
            pred = np.add(blobs[cur]["c"], step)
            s = float(np.hypot(*step))
            ds, idx = tree.query(pred, k=min(24, len(members)))
            ds, idx = np.atleast_1d(ds), np.atleast_1d(idx)
            nxt = None
            for d_, ii in zip(ds, idx):
                if ii >= len(members) or d_ > 0.25 * s:
                    break
                cand = members[ii]
                if cand in chain or not similar(blobs[cand], blobs[i]):
                    continue
                new = np.subtract(blobs[cand]["c"], blobs[cur]["c"])
                ns = float(np.hypot(*new))
                if not 0.8 < ns / s < 1.25:
                    continue
                ang = math.degrees(math.acos(max(-1, min(1, float(np.dot(new, step)) / (ns * s)))))
                if ang > 10:
                    continue
                nxt = cand
                break
            if nxt is None:
                break
            step = np.subtract(blobs[nxt]["c"], blobs[cur]["c"])
            if direction == 1:
                chain.append(nxt)
            else:
                chain.insert(0, nxt)
            prev, cur = cur, nxt
    return chain


def fit_row(blobs, chain):
    P = np.array([blobs[i]["c"] for i in chain])
    mean = P.mean(0)
    u = P[-1] - P[0]
    u = u / np.linalg.norm(u)
    v = np.array([-u[1], u[0]])
    t = (P - mean) @ u
    off = (P - mean) @ v
    idx = np.arange(len(chain))
    A = np.stack([idx, np.ones_like(idx)], 1).astype(float)
    (p, a), res, *_ = np.linalg.lstsq(A, t, rcond=None)
    resid = t - (p * idx + a)
    n = len(chain)
    se = math.sqrt((resid ** 2).sum() / max(1, n - 2) / max(1e-9, ((idx - idx.mean()) ** 2).sum())) if n > 2 else 0.0
    steps = np.diff(t)
    return {"u": u, "v": v, "center": mean, "t": t, "off": off, "pitch_px": float(p), "pitch_se": se, "steps": steps,
            "trend": float((steps[-1] - steps[0]) / p) if n > 2 else 0.0,
            "straight": float(np.abs(off).max() / p), "regular": float(np.abs(resid).max() / p)}


def find_rows(blobs, count=None, limit=4):
    """Rows of three or more like features, evenly spaced along a line: each as its blobs in order and its fit."""
    by_cl = {"all": list(range(len(blobs)))}
    found = {}
    for cl, members in by_cl.items():
        if len(members) < 3:
            continue
        tree = cKDTree(np.array([blobs[i]["c"] for i in members]))
        for i in members:
            ds, idx = tree.query(blobs[i]["c"], k=min(40, len(members)))
            for d_, jj in zip(np.atleast_1d(ds)[1:], np.atleast_1d(idx)[1:]):
                j = members[jj]
                if not similar(blobs[i], blobs[j]):
                    continue
                if d_ < 0.9 * max(blobs[i]["d"], blobs[j]["d"]) or d_ > 15 * max(blobs[i]["d"], blobs[j]["d"]):
                    continue
                chain = walk(blobs, members, tree, i, j)
                if len(chain) >= 3:
                    key = frozenset(chain)
                    if key not in found:
                        found[key] = chain
    def check(chain):
        f = fit_row(blobs, chain)
        if f["straight"] > 0.2 or f["regular"] > 0.18 or abs(f["trend"]) > 0.25:
            return None
        areas = np.array([blobs[i]["area"] for i in chain])
        if areas.max() / areas.min() > 3:
            return None
        fill = float(np.mean([blobs[i]["d"] for i in chain])) / f["pitch_px"]
        if not 0.22 <= fill <= 0.95:
            return None  # specks along an edge, or blobs touching each other
        return dict(f, chain=chain, fill=fill)

    valid = {}
    for key, chain in found.items():
        row = check(chain)
        # a walk can run on past the row's end onto something like it (a magnet's shine): the row is then inside it
        cut = 1
        while row is None and len(chain) - cut >= 3 and cut <= 3:
            for a in range(cut + 1):
                sub = chain[a:len(chain) - (cut - a)]
                row = check(sub)
                if row:
                    key = frozenset(sub)
                    break
            cut += 1
        if row:
            valid[key] = row
    # a row inside a longer valid row is that row, seen in part
    rows = [r for key, r in valid.items() if not any(key < other for other in valid)]
    # the likeliest first: as many features as asked for, then more features, then more substantial ones
    rows.sort(key=lambda r: (count is not None and len(r["chain"]) == count, len(r["chain"]), r["fill"] - r["regular"]),
              reverse=True)
    picked, used = [], set()
    for r in rows:
        if used & set(r["chain"]):
            continue
        if len(r["chain"]) == 3 and r["regular"] > 0.08:
            continue  # three features prove little unless they're very even
        same = False
        mine = np.array([blobs[i]["c"] for i in r["chain"]])
        for q in picked:
            theirs = np.array([blobs[i]["c"] for i in q["chain"]])
            near_ = np.hypot(mine[:, None, 0] - theirs[None, :, 0], mine[:, None, 1] - theirs[None, :, 1]).min(1)
            if abs(q["pitch_px"] - r["pitch_px"]) < 0.1 * q["pitch_px"] and (near_ < 0.4 * q["pitch_px"]).all():
                same = True  # the same features, found in another channel
                break
        if same:
            continue
        picked.append(r)
        used |= set(r["chain"])
        if len(picked) >= limit:
            break
    return picked


# --- measuring along a row ------------------------------------------------------------------------------------------

def run_on(solid, start, direction, gap):
    """How far from start the part goes along direction, crossing background gaps no longer than gap."""
    h, w = solid.shape
    s = 0.0
    last_in = 0.0
    while True:
        s += 0.5
        x = int(round(start[0] + direction[0] * s))
        y = int(round(start[1] + direction[1] * s))
        if not (0 <= x < w and 0 <= y < h):
            return last_in
        if solid[y, x]:
            last_in = s
        elif s - last_in > gap:
            return last_in


def chord(solid, center, u, gap):
    """The part's length through center along u: its two ends' distances from center."""
    a = run_on(solid, center, -u, gap)
    b = run_on(solid, center, u, gap)
    return a, b


def size_along(b, u):
    """A blob's width along a direction (its second moment, as a disc's diameter)."""
    return 4 * math.sqrt(max(float(u @ b["cov"] @ u), 0.0))


def measure_row(row, blobs, solid, scale_mm, ref, parts=None):
    """The row's pitch and features, the part's chord along and across it, its profile at offsets from it, and
    features symmetric about its middle, in mm when there's a scale."""
    u, v, c = row["u"], row["v"], row["center"]
    p = row["pitch_px"]
    gap = max(3.0, 0.2 * p)
    chain = row["chain"]
    # the middle of the row, between its first and last feature
    mid = c + u * (row["t"][0] + row["t"][-1]) / 2
    a, b = chord(solid, mid, u, gap)
    across_a, across_b = chord(solid, mid, v, gap)
    mm = (lambda x: round(x * scale_mm, 2)) if scale_mm else (lambda x: None)
    feats = [blobs[i] for i in chain]
    row_d = float(np.mean([f["d"] for f in feats]))
    f_along = float(np.mean([size_along(f, u) for f in feats]))
    f_across = float(np.mean([size_along(f, v) for f in feats]))
    out = {
        "features": len(chain),
        "pitch_px": round(p, 2),
        "pitch_mm": round(p * scale_mm, 3) if scale_mm else None,
        "steps_px": [round(float(s), 1) for s in row["steps"]],
        "feature_px": [round(f_along, 1), round(f_across, 1)],
        "feature_mm": [mm(f_along), mm(f_across)],
        "kind": feats[0]["kind"],
        "along_px": round(a + b, 1),
        "along_mm": mm(a + b),
        "across_px": round(across_a + across_b, 1),
        "across_mm": mm(across_a + across_b),
        "ends_px": [[round(float(x), 1) for x in mid - u * a], [round(float(x), 1) for x in mid + u * b]],
        "across_ends_px": [[round(float(x), 1) for x in mid - v * across_a], [round(float(x), 1) for x in mid + v * across_b]],
        "center_px": [round(float(mid[0]), 1), round(float(mid[1]), 1)],
        "axis": [round(float(u[0]), 4), round(float(u[1]), 4)],
        "offset_to_middle_px": round(float((a - b) / 2), 1),
    }
    # the part's length along the row at offsets across it (a plate wider than the face, a flange)
    prof = []
    for k in np.arange(-4, 4.01, 0.5):
        off = k * p
        at = mid + v * off
        x, y = int(round(at[0])), int(round(at[1]))
        if not (0 <= x < solid.shape[1] and 0 <= y < solid.shape[0]) or not solid[y, x]:
            continue
        aa, bb = chord(solid, at, u, gap)
        prof.append({"offset_px": round(float(off), 1), "offset_mm": mm(off), "length_px": round(aa + bb, 1),
                     "length_mm": mm(aa + bb)})
    out["profile"] = prof
    # features in pairs either side of the row's middle (magnets, mounting holes, pegs)
    inrow = set(chain)
    t0, t1 = row["t"][0] + c @ u, row["t"][-1] + c @ u
    tm = float(mid @ u)
    cands = []
    own = None
    if parts is not None:
        ids = [parts[int(round(blobs[i]["c"][1])), int(round(blobs[i]["c"][0]))] for i in chain]
        ids = [x for x in ids if x]
        own = max(set(ids), key=ids.count) if ids else None
    row_at = np.array([blobs[i]["c"] for i in chain])
    row_t = (row_at - mid) @ u
    for i, bl in enumerate(blobs):
        q_ = np.array(bl["c"]) - mid
        if np.abs(row_t - q_ @ u).min() < 0.3 * p and abs(q_ @ v) < 0.6 * p:
            continue  # part of one of the row's own features (its ring, its shine), found in another channel
        if own is not None and parts[int(round(bl["c"][1])), int(round(bl["c"][0]))] != own:
            continue  # on another part in the photo
        if i in inrow or bl["d"] < 0.5 * row_d or bl["d"] > 3 * (a + b):
            continue
        q = np.array(bl["c"])
        tt = float(q @ u) - tm
        oo = float((q - mid) @ v)
        if abs(oo) > 4 * p or abs(tt) > 2 * max(a, b) + gap:
            continue
        cands.append((i, tt, oo))
    pairs, taken, seen_pairs = [], set(), []
    for i, tt, oo in sorted(cands, key=lambda x: x[1]):
        if tt >= 0 or i in taken:
            continue
        best = None
        for j, t2, o2 in cands:
            if t2 <= 0 or j in taken or j == i:
                continue
            if abs(t2 + tt) > 0.35 * p or abs(o2 - oo) > 0.35 * p or not similar(blobs[i], blobs[j], 1.8):
                continue
            err = abs(t2 + tt) + abs(o2 - oo)
            if best is None or err < best[0]:
                best = (err, j, t2, o2)
        if best is None:
            continue
        _, j, t2, o2 = best
        if any(abs(q[0] - (t2 - tt)) < 0.2 * p and abs(q[1] - (oo + o2) / 2) < 0.2 * p for q in seen_pairs):
            taken |= {i, j}
            continue  # the same pair, found again in another channel
        seen_pairs.append((t2 - tt, (oo + o2) / 2))
        taken |= {i, j}
        d_along = (size_along(blobs[i], u) + size_along(blobs[j], u)) / 2
        d_across = (size_along(blobs[i], v) + size_along(blobs[j], v)) / 2
        pairs.append({"kind": blobs[i]["kind"], "cc_px": round(t2 - tt, 1), "cc_mm": mm(t2 - tt),
                      "offset_px": round((oo + o2) / 2, 1), "offset_mm": mm((oo + o2) / 2),
                      "size_px": [round(d_along, 1), round(d_across, 1)], "size_mm": [mm(d_along), mm(d_across)],
                      "at_px": [[round(x, 1) for x in blobs[i]["c"]], [round(x, 1) for x in blobs[j]["c"]]]})
    pairs.sort(key=lambda q: -q["cc_px"])
    out["pairs"] = pairs[:6]
    warn = []
    if abs(row["trend"]) > 0.05:
        warn.append(f"seen at an angle: the spacing changes {abs(row['trend']) * 100:.0f}% from one end of the row to the "
                    "other, so lengths along it are good near the row and drift beyond it")
    asp = f_across / max(f_along, 1e-6)
    if asp < 0.8 or asp > 1.25:
        warn.append(f"the features are {asp:.2f}x as wide across the row as along it: if they're round, the face is "
                    "tilted and lengths across the row are foreshortened by about that much")
    if row["regular"] > 0.1:
        warn.append(f"the spacing is uneven by up to {row['regular'] * 100:.0f}% of the pitch")
    out["warnings"] = warn
    if scale_mm:
        rel = row["pitch_se"] / p if ref == "pitch" else 0.0
        out["plus_minus_mm"] = round((a + b) * scale_mm * rel + 2 * scale_mm, 2)
    return out


# --- drawing --------------------------------------------------------------------------------------------------------

def annotate(rgb, rows, results, blobs, points, out_path, scale_label, box_offset):
    """The photo cropped to what was measured, enlarged, with each row, its ends, its pairs and the points drawn on."""
    h, w, _ = rgb.shape
    xs, ys = [], []
    for r in results:
        for e in r["ends_px"] + r["across_ends_px"]:
            xs.append(e[0])
            ys.append(e[1])
        for pr in r["pairs"]:
            for q in pr["at_px"]:
                xs.append(q[0])
                ys.append(q[1])
    for pt in points:
        for q in pt["px"]:
            xs.append(q[0])
            ys.append(q[1])
    if xs:
        span = max(max(xs) - min(xs), max(ys) - min(ys), 40)
        m = 0.18 * span + 20
        x0, y0 = max(0, int(min(xs) - m)), max(0, int(min(ys) - m))
        x1, y1 = min(w, int(max(xs) + m)), min(h, int(max(ys) + m))
    else:
        x0, y0, x1, y1 = 0, 0, w, h
    crop = Image.fromarray(rgb[y0:y1, x0:x1])
    z = max(1.0, min(6.0, 1400 / max(crop.width, crop.height)))
    img = crop.resize((int(crop.width * z), int(crop.height * z)), Image.LANCZOS).convert("RGB")
    d = ImageDraw.Draw(img)
    f = font(max(15, int(img.width / 55)))
    fs = font(max(12, int(img.width / 75)))

    def P(q):
        return ((q[0] - x0) * z, (q[1] - y0) * z)

    def label(at, text, fill, fnt=f):
        x, y = at
        bb = d.textbbox((x, y), text, font=fnt)
        pad = 3
        d.rectangle([bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad], fill=(255, 255, 255))
        d.text((x, y), text, fill=fill, font=fnt)

    colors = [(0, 140, 255), (230, 60, 0), (0, 160, 70), (170, 0, 200), (200, 140, 0), (0, 150, 150)]
    for k, (r, res) in enumerate(zip(rows, results)):
        col = colors[k % len(colors)]
        name = chr(65 + k)
        for n, i in enumerate(r["chain"]):
            cx, cy = P(blobs[i]["c"])
            rad = max(4, blobs[i]["d"] * z / 2 + 3)
            d.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], outline=col, width=2)
        e0, e1 = P(res["ends_px"][0]), P(res["ends_px"][1])
        d.line([e0, e1], fill=col, width=2)
        nrm = (-res["axis"][1], res["axis"][0])
        for e in (e0, e1):
            d.line([(e[0] - nrm[0] * 14, e[1] - nrm[1] * 14), (e[0] + nrm[0] * 14, e[1] + nrm[1] * 14)], fill=col, width=3)
        a0, a1 = P(res["across_ends_px"][0]), P(res["across_ends_px"][1])
        d.line([a0, a1], fill=col, width=1)
        for e in (a0, a1):
            d.line([(e[0] - res["axis"][0] * 8, e[1] - res["axis"][1] * 8), (e[0] + res["axis"][0] * 8, e[1] + res["axis"][1] * 8)], fill=col, width=2)
        for pr in res["pairs"][:3]:
            for q in pr["at_px"]:
                cx, cy = P(q)
                rad = max(5, pr["size_px"][0] * z / 2 + 2)
                d.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], outline=(220, 0, 120), width=2)
        if res["pitch_mm"] is not None:
            line = f"{name}  {res['features']} × {res['pitch_mm']:.2f} mm · {res['along_mm']:.2f} long"
            if not res["warnings"]:
                line += f" · {res['across_mm']:.2f} across"
        elif res.get("along_mm") is not None:
            line = f"{name}  {res['features']} × {res['pitch_px'] * res['along_mm'] / max(res['along_px'], 1e-6):.2f} mm · " \
                   f"{res['along_mm']:.2f} long"
        else:
            line = f"{name}  {res['features']} × {res['pitch_px']:.1f} px · {res['along_px']:.0f} px long"
        top = min(e0[1], e1[1])
        lx = min(e0[0], e1[0])
        label((max(4, lx), max(4, top - 3.2 * f.size)), line, col)
    for pt in points:
        q0, q1 = P(pt["px"][0]), P(pt["px"][1])
        d.line([q0, q1], fill=(220, 0, 120), width=2)
        for q in (q0, q1):
            d.ellipse([q[0] - 4, q[1] - 4, q[0] + 4, q[1] + 4], outline=(220, 0, 120), width=2)
        txt = f"{pt['name']}: {pt['mm']:.2f} mm" if pt.get("mm") is not None else f"{pt['name']}: {pt['px']:.0f} px"
        label(((q0[0] + q1[0]) / 2 + 6, (q0[1] + q1[1]) / 2 + 6), txt, (220, 0, 120), fs)
    if scale_label:
        label((8, img.height - 1.6 * fs.size - 8), scale_label, (60, 60, 60), fs)
    img.save(out_path, quality=88)
    return {"crop_px": [x0 + box_offset[0], y0 + box_offset[1], x1 + box_offset[0], y1 + box_offset[1]], "zoom": round(z, 2)}


# --- commands -------------------------------------------------------------------------------------------------------

def cmd_measure(args):
    """Measure one photo: see the module's docstring."""
    rgb_im = load(args["photo"])
    W, H = rgb_im.size
    box = args.get("box")
    off = (0, 0)
    if box:
        x0, y0, x1, y1 = [int(round(v)) for v in box]
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(W, x1), min(H, y1)
        if x1 - x0 < 10 or y1 - y0 < 10:
            raise ValueError(f"box {box} leaves nothing of a {W}x{H} photo")
        rgb_im = rgb_im.crop((x0, y0, x1, y1))
        off = (x0, y0)
    s = 1.0
    if max(rgb_im.size) > MAX_SIDE:
        s = MAX_SIDE / max(rgb_im.size)
        rgb_im = rgb_im.resize((int(rgb_im.width * s), int(rgb_im.height * s)), Image.LANCZOS)
    rgb = np.asarray(rgb_im)
    L = lab(rgb)
    bg = background(L)
    text = []
    if args.get("ocr", True):
        try:
            for ln in ocr(args["photo"]):
                x0_, y0_, x1_, y1_ = ln["box"]
                text.append(((x0_ - off[0]) * s, (y0_ - off[1]) * s, (x1_ - off[0]) * s, (y1_ - off[1]) * s))
        except Exception:
            text = []
    blobs, solid, _ = find_blobs(rgb, L, bg, text)
    rows = find_rows(blobs, count=args.get("count"))
    ref = args.get("reference") or {}
    if args.get("row") is not None:
        k = int(args["row"])
        if not 0 <= k < len(rows):
            raise ValueError(f"there's no row {k}: {len(rows)} were found")
        rows = [rows[k]]
    elif args.get("count"):
        exact = [r for r in rows if len(r["chain"]) == int(args["count"])]
        rows = exact or rows
    # the scale: mm per pixel of the (cropped, shrunk) photo
    scale, how = None, None
    if ref.get("points") and ref.get("mm"):
        (ax, ay), (bx, by) = ref["points"]
        dpx = math.hypot((bx - ax) * s, (by - ay) * s)
        scale = float(ref["mm"]) / dpx
        how = f"{ref['mm']} mm between the two reference points ({dpx / s:.1f} px)"
    parts, _ = ndimage.label(solid)
    results = []
    for r in rows:
        if ref.get("pitch_mm"):
            sc = float(ref["pitch_mm"]) / r["pitch_px"]
            res = measure_row(r, blobs, solid, sc, "pitch", parts)
            res["scale"] = f"{ref['pitch_mm']} mm pitch"
        elif ref.get("length_mm"):
            pre = measure_row(r, blobs, solid, None, "length", parts)
            sc = float(ref["length_mm"]) / pre["along_px"] if pre["along_px"] else None
            res = measure_row(r, blobs, solid, sc, "length", parts)
            res["scale"] = f"{ref['length_mm']} mm long along the row"
        else:
            res = measure_row(r, blobs, solid, scale, "points", parts)
            if scale:
                res["scale"] = how
        results.append(res)
    # a row whose part runs on far past it is a pattern on something large (a cable's print, a texture), not a part's
    keep = [k for k, res in enumerate(results) if res["along_px"] <= 10 * max(1, res["features"] - 1) * res["pitch_px"]]
    if keep:
        results = [results[k] for k in keep]
        rows = [rows[k] for k in keep]
    # back to the photo's own pixels
    def back(q):
        return [round(q[0] / s + off[0], 1), round(q[1] / s + off[1], 1)]
    for res in results:
        for key in ("ends_px", "across_ends_px"):
            res[key] = [back(q) for q in res[key]]
        res["center_px"] = back(res["center_px"])
        for pr in res["pairs"]:
            pr["at_px"] = [back(q) for q in pr["at_px"]]
            for key in ("cc_px", "offset_px"):
                pr[key] = round(pr[key] / s, 1)
            pr["size_px"] = [round(x / s, 1) for x in pr["size_px"]]
        for key in ("pitch_px", "along_px", "across_px", "offset_to_middle_px"):
            res[key] = round(res[key] / s, 2)
        res["steps_px"] = [round(x / s, 1) for x in res["steps_px"]]
        res["feature_px"] = [round(x / s, 1) for x in res["feature_px"]]
        for pf in res["profile"]:
            pf["offset_px"] = round(pf["offset_px"] / s, 1)
            pf["length_px"] = round(pf["length_px"] / s, 1)
    # points asked for, on the photo's own pixels
    pts = []
    first = None
    if results and results[0].get("pitch_mm") and results[0]["pitch_px"]:
        first = results[0]["pitch_mm"] / results[0]["pitch_px"]
    mm_per_px = (scale * s) if scale else first
    for name, pair in (args.get("points") or {}).items():
        (ax, ay), (bx, by) = pair
        dpx = math.hypot(bx - ax, by - ay)
        pts.append({"name": name, "px": [[ax, ay], [bx, by]], "length_px": round(dpx, 1),
                    "mm": round(dpx * mm_per_px, 2) if mm_per_px else None})
    picture = None
    if args.get("out"):
        draw_rows = []
        for r in rows:
            rr = dict(r)
            draw_rows.append(rr)
        # draw on the cropped (unshrunk) photo, in its own pixels
        full = np.asarray(load(args["photo"]))
        scaled_blobs = []
        for b in blobs:
            bb = dict(b)
            bb["c"] = (b["c"][0] / s + off[0], b["c"][1] / s + off[1])
            bb["d"] = b["d"] / s
            scaled_blobs.append(bb)
        label = None
        if results and results[0].get("scale"):
            label = "scale: " + results[0]["scale"]
        elif mm_per_px:
            label = "scale: " + (how or "")
        picture = annotate(full, draw_rows, results, scaled_blobs,
                           [dict(p, mm=p["mm"], px=p["px"]) for p in pts], args["out"], label, (0, 0))
    return {"size_px": [W, H], "box": box, "rows": results, "points": pts, "picture": picture,
            "mm_per_px": round(mm_per_px, 5) if mm_per_px else None}


def cmd_look(args):
    """A region of a photo, enlarged, with a grid labelled in the photo's own pixels."""
    im = load(args["photo"])
    W, H = im.size
    box = args.get("box") or [0, 0, W, H]
    x0, y0, x1, y1 = [int(round(v)) for v in box]
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
    crop = im.crop((x0, y0, x1, y1))
    z = max(1.0, min(12.0, 1400 / max(crop.width, crop.height)))
    img = crop.resize((int(crop.width * z), int(crop.height * z)), Image.LANCZOS if z < 3 else Image.NEAREST)
    d = ImageDraw.Draw(img, "RGBA")
    span = max(x1 - x0, y1 - y0)
    raw = span / 12.0
    mag = 10 ** math.floor(math.log10(max(raw, 1)))
    step = min((m * mag for m in (1, 2, 5, 10) if m * mag >= raw), default=mag * 10)
    step = max(1, int(step))
    f = font(max(12, int(img.width / 90)))
    gx = (x0 // step + 1) * step
    while gx < x1:
        X = (gx - x0) * z
        d.line([(X, 0), (X, img.height)], fill=(255, 0, 80, 110), width=1)
        d.text((X + 2, 2), str(gx), fill=(255, 0, 80, 255), font=f)
        gx += step
    gy = (y0 // step + 1) * step
    while gy < y1:
        Y = (gy - y0) * z
        d.line([(0, Y), (img.width, Y)], fill=(255, 0, 80, 110), width=1)
        d.text((2, Y + 2), str(gy), fill=(255, 0, 80, 255), font=f)
        gy += step
    img.convert("RGB").save(args["out"], quality=90)
    return {"size_px": [W, H], "box": [x0, y0, x1, y1], "grid_px": step, "zoom": round(z, 2)}


NUMBER = re.compile(r"(?<![\w.])(\d+(?:[.,]\d+)?)\s*(mm|cm|in|inch|inches|\"|″)?", re.I)


def ocr(path):
    """The text on a photo, from macOS Vision: each line with its box in the photo's pixels."""
    import Quartz
    import Vision
    from Foundation import NSURL
    src = Quartz.CGImageSourceCreateWithURL(NSURL.fileURLWithPath_(path), None)
    img = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None) if src else None
    if img is None:
        return []
    W, H = Quartz.CGImageGetWidth(img), Quartz.CGImageGetHeight(img)
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    req.setUsesLanguageCorrection_(False)
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(img, None)
    handler.performRequests_error_([req], None)
    out = []
    for o in req.results() or []:
        c = o.topCandidates_(1)[0]
        bb = o.boundingBox()
        x, y = bb.origin.x * W, (1 - bb.origin.y - bb.size.height) * H
        out.append({"text": str(c.string()), "confidence": round(float(c.confidence()), 2),
                    "box": [round(x), round(y), round(x + bb.size.width * W), round(y + bb.size.height * H)]})
    return out


DIM = re.compile(r"^[\s(]*[⌀Ø∅$φΦR]?\s*\d+(?:[.,]\d+)?\s*(?:[±+₺]\s*-?\s*\d+(?:[.,]\d+)?)?\s*(?:mm|cm|in|\")?[\s)]*$", re.I)


def dimension(line, kind):
    """A line of text with a number, and on a drawing the number it reads as: a value, its tolerance, a diameter.
    Vision reads a drawing's ± as + or ₺ and its ⌀ as $ or φ; the words it read stay as they were."""
    out = {"text": line["text"], "box": line["box"]}
    if kind != "drawing":
        return out
    t = line["text"].replace("₺", "±").replace("±", "±")
    t = re.sub(r"(\d)\s*\+\s*(\d)", r"\1±\2", t)
    m = re.match(r"^\s*([⌀Ø∅$φΦ]|R)?\s*(\d+(?:[.,]\d+)?)\s*(?:±\s*(\d+(?:[.,]\d+)?))?", t)
    if m:
        out["mm"] = float(m.group(2).replace(",", "."))
        if m.group(3):
            out["tol"] = float(m.group(3).replace(",", "."))
        if m.group(1) and m.group(1) != "R":
            out["diameter"] = True
        elif m.group(1) == "R":
            out["radius"] = True
        out["reads"] = ("⌀" if out.get("diameter") else "R" if out.get("radius") else "") + m.group(2) + \
            (f"±{m.group(3)}" if m.group(3) else "")
    return out


def kind_of(rgb, lines):
    """photo, drawing (a dimensioned line drawing) or infographic (a photo with words on it)."""
    small = np.asarray(Image.fromarray(rgb).resize((200, 200)))
    mx, mn = small.max(-1).astype(int), small.min(-1).astype(int)
    white = ((mn > 225)).mean()
    chroma = (mx - mn).mean()
    dims = [ln for ln in lines if DIM.match(ln["text"]) and re.search(r"\d[.,]\d", ln["text"])]
    if len(dims) >= 3 and white > 0.5:
        return "drawing"
    words = sum(len(ln["text"]) for ln in lines if ln["confidence"] >= 0.5)
    if words >= 25:
        return "infographic"
    return "photo" if chroma > 6 or white < 0.9 else "drawing"


def cmd_scan(args):
    """Each photo's size, kind and text, and one numbered contact sheet of them all."""
    photos = []
    want_text = args.get("ocr", True)
    for i, path in enumerate(args["photos"]):
        try:
            im = load(path)
        except Exception as e:
            photos.append({"n": i + 1, "error": f"{type(e).__name__}: {e}"})
            continue
        rgb = np.asarray(im)
        lines = []
        if want_text:
            try:
                lines = ocr(path)
            except Exception as e:
                lines = [{"text": f"(couldn't read text: {type(e).__name__}: {e})", "confidence": 0, "box": [0, 0, 0, 0]}]
        k = kind_of(rgb, lines)
        dims = [dimension(ln, k) for ln in lines if re.search(r"\d", ln["text"])]
        photos.append({"n": i + 1, "size_px": list(im.size), "kind": k, "numbers": dims,
                       "words": [ln["text"] for ln in lines if not re.search(r"\d", ln["text"]) and ln["confidence"] >= 0.5][:20]})
    if args.get("sheet"):
        sheet(args["photos"], photos, args["sheet"])
    return {"photos": photos}


def sheet(paths, photos, out):
    S = 320
    n = len(paths)
    cols = min(5, max(1, n))
    rows = (n + cols - 1) // cols
    img = Image.new("RGB", (cols * S, rows * S), "white")
    d = ImageDraw.Draw(img)
    f = font(26)
    fs = font(16)
    for i, path in enumerate(paths):
        x, y = (i % cols) * S, (i // cols) * S
        try:
            im = load(path)
            im.thumbnail((S - 12, S - 12))
            img.paste(im, (x + (S - im.width) // 2, y + (S - im.height) // 2))
        except Exception:
            pass
        d.rectangle([x, y, x + S - 1, y + S - 1], outline=(220, 220, 220))
        tag = str(i + 1)
        bb = d.textbbox((x + 8, y + 6), tag, font=f)
        d.rectangle([bb[0] - 5, bb[1] - 4, bb[2] + 5, bb[3] + 4], fill=(20, 20, 20))
        d.text((x + 8, y + 6), tag, fill="white", font=f)
        k = photos[i].get("kind") if i < len(photos) else None
        if k and k != "photo":
            bb = d.textbbox((x + 8, y + S - 28), k, font=fs)
            d.rectangle([bb[0] - 4, bb[1] - 3, bb[2] + 4, bb[3] + 3], fill=(0, 110, 220))
            d.text((x + 8, y + S - 28), k, fill="white", font=fs)
    img.save(out, quality=85)


COMMANDS = {"measure": cmd_measure, "look": cmd_look, "scan": cmd_scan}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(f"usage: worker.py {'|'.join(COMMANDS)} < args.json", file=sys.stderr)
        return 2
    args = json.load(sys.stdin)
    try:
        out = COMMANDS[sys.argv[1]](args)
    except Exception as e:
        json.dump({"error": f"{type(e).__name__}: {e}"}, sys.stdout)
        return 1
    json.dump(out, sys.stdout, default=lambda o: o.tolist() if hasattr(o, "tolist") else str(o))
    return 0


if __name__ == "__main__":
    sys.exit(main())
