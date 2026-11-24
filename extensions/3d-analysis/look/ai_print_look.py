#!/usr/bin/env python3
"""Make a product render look like a real FDM 3D print with one AI image edit (Vercel AI Gateway).

Adds fine layer lines, a matte/satin sheen and slightly softened edges to the printed part only and
asks the model to keep shape, colors, lighting, graphics and background as rendered. Stdlib only;
the result is resized back to the input's exact pixel size with Pillow if it is installed, else
with macOS `sips` (if neither exists the model's own size is kept and a note is printed).

Usage:
  python3 look/ai_print_look.py IN.png OUT.png --part "the red top lid shell" \\
      [--model google/gemini-3-pro-image] [--layer-mm 0.2] [--z-dir "..."] [--material pla_matte|petg|silk|asa|asa_smoothed] \\
      [--bed-face "the big flat top face"] [--keep "the black console shells, the backdrop"] \\
      [--notes "more sentences about this image"] [--seam] [--print-prompt]

Needs AI_GATEWAY_API_KEY in the environment (never printed). Prints time, sizes and cost.

Models (tested 2026-10-22):
  google/gemini-3-pro-image      default; most faithful on hard-surface parts. ~$0.14, ~30 s.
                                 Tends to smooth sculpted/organic micro-detail (bumpy bone, antlers).
  openai/gpt-image-2.5-sunburst  keeps sculpted surface detail best; on flat parts it can darken the
                                 color a little and streak flat faces. ~$0.05-0.10, ~35 s.
  google/gemini-nano-banana-2.1  cheaper (~$0.06) but erased a molded crease on the 3DS lid.

Examples:
  python3 look/ai_print_look.py lid-A.png lid-A-print.png \\
      --part "the red top lid shell of the closed handheld game console (the big flat red top surface \\
with the green and black pixel-art inlay, plus the lid's thin rounded red side walls down to the first \\
black seam)" --bed-face "the big flat top face (inlay included)" \\
      --notes "The lid is about 160 mm wide and its side walls are about 8 mm tall, so each side wall \\
carries about 40 layers packed into a few dozen pixels: a tight hairline striation wrapping around the \\
edge and corners. The two small round camera holes in the lid keep their exact size and shape." \\
      --keep "the black inner shells and hinge, the metallic red bottom shell and battery cover below \\
the black seam, the camera lenses, the ports, and the backdrop, all smooth and glossy"

  python3 look/ai_print_look.py deer.png deer-print.png --model openai/gpt-image-2.5-sunburst \\
      --part "the deer skull with antlers" --keep "the grey seamless backdrop and the soft floor shadow" \\
      --notes "It is about 45 cm tall, so its layers are finer than a pixel here: a faint, dense \\
horizontal hairline striation, and faint stepped contour terraces only on the gently sloped top of the skull."
"""

import argparse
import base64
import importlib.util
import json
import os
import shutil
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request

GATEWAY = "https://ai-gateway.vercel.sh/v1"

MATERIALS = {
    "pla_matte": (
        "matte PLA",
        "a soft satin-matte sheen; highlights become broader and softer than in the render, with no glossy, "
        "wet or injection-molded look",
    ),
    "petg": (
        "PETG",
        "a smooth semi-gloss sheen with crisp but slightly softened highlights; the layer lines catch the light "
        "a little more than on PLA",
    ),
    "silk": (
        "silk PLA",
        "a pearly, silky satin sheen with bright, streaky highlights that run along the layer lines",
    ),
    "asa": ("ASA", "a flat, very matte, slightly chalky finish with dull, broad highlights and no gloss"),
    "asa_smoothed": (
        "acetone vapor-smoothed ASA",
        "a smooth, glossy, almost molded finish with clean reflections: the vapor has melted the layer lines down "
        "until they are barely visible, only a very faint soft ripple caught in grazing highlights; keep the gloss, "
        "reflections and highlights as rendered (do not make it matte)",
    ),
}

PROMPT = """Edit this product render so the 3D-printed part looks like a real FDM 3D print in a real studio photo. This is a subtle surface-finish retouch, not a redesign: change only the surface micro-texture and sheen of the printed part.

{part}

On the printed part only:
- Layer lines: {layer} mm FDM layers stacked along the print's Z axis, which is {z_dir}. They follow the surface curvature. They are extremely fine and dense: from this camera distance they read only as a tight, subtle striated sheen that is mostly visible in the highlights and is too fine to count; a viewer should have to look closely to notice it. Never draw a handful of thick ribs, raised rings, stacked bands, steps, grooves or stripes, and never change the part's outline to show them.
- Material: {material}.
- Edges very slightly softened, as on a real print.{seam}

Keep everything else pixel-identical to the input: the exact shape, silhouette, outline, proportions, size, position, framing, crop, camera angle and perspective; the same hue, saturation and overall brightness (matte only spreads and softens the highlights, it does not darken the part); the same lighting, shadows and background; every graphic and pixel-art square exactly in place with crisp edges. Do not add, remove, move or redraw anything. No new objects, no text, no logos, no watermark. Everything that is not printed keeps its original smooth surface with no texture and no layer lines."""


def build_prompt(a):
    """Assemble the edit prompt from the CLI options."""
    name, sheen = MATERIALS[a.material]
    bed = (
        f" It was printed face-down on a textured PEI plate, so {a.bed_face} has no lines of any kind, not "
        "horizontal and not diagonal, only an even, very fine bead-blasted micro-grain (about one pixel, like "
        "fine sandpaper with a faint sparkle; not pebbled leather, not orange peel, not scratches or streaks) "
        "and a soft matte finish."
        if a.bed_face
        else ""
    )
    part = (
        f"ONLY {a.part} is the 3D print, in {name}.{bed}"
        + (f" {a.notes}" if a.notes else "")
        + " Its existing surface detail (bumps, pits, ridges, creases, holes, raised or engraved features) is "
        "real modeled geometry that the print has too: keep every detail exactly where it is, at the same size "
        "and contrast, and lay the layer lines over it. Do not smooth, polish, simplify or re-sculpt it."
        + " Everything else is not printed and must stay exactly as rendered"
        + (f": {a.keep}." if a.keep else ".")
    )
    seam = (
        "\n- One faint vertical seam line, where each layer starts, on a side facing away from the light."
        if a.seam
        else ""
    )
    return PROMPT.format(part=part, layer=a.layer_mm, material=f"{name}, {sheen}", seam=seam, z_dir=a.z_dir)


def gateway(method, path, body=None, timeout=600):
    """Call the AI Gateway; return (HTTP status, parsed JSON). The key is only placed in the header."""
    key = os.environ.get("AI_GATEWAY_API_KEY")
    if not key:
        sys.exit("AI_GATEWAY_API_KEY is not set.")
    req = urllib.request.Request(
        GATEWAY + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        # error bodies are JSON with a message; surface them instead of a bare status code
        return e.code, json.loads(e.read() or b"{}")


def imaging():
    """Return 'pil', 'sips' or None depending on which image tool is available for resizing."""
    if importlib.util.find_spec("PIL"):
        return "pil"
    return "sips" if shutil.which("sips") else None


def image_size(path, tool):
    """Pixel (width, height) of an image: PNG header via stdlib, other formats via Pillow or sips."""
    with open(path, "rb") as f:
        head = f.read(24)
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return struct.unpack(">II", head[16:24])
    if tool == "pil":
        from PIL import Image

        return Image.open(path).size
    if tool == "sips":
        cmd = ["sips", "-g", "pixelWidth", "-g", "pixelHeight", path]
        out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
        vals = [int(line.split(":")[1]) for line in out.splitlines() if "pixel" in line]
        return vals[0], vals[1]
    return None


def fit(path, size, tool):
    """Resize the image at `path` in place to exactly `size` and store it in the format its extension names."""
    w, h = size
    if tool == "pil":
        from PIL import Image

        Image.open(path).convert("RGB").resize((w, h), Image.LANCZOS).save(path)
    else:
        fmt = "jpeg" if path.lower().endswith((".jpg", ".jpeg")) else "png"
        cmd = ["sips", "-s", "format", fmt, "-z", str(h), str(w), path, "--out", path]
        subprocess.run(cmd, capture_output=True, check=True)


def edit(a, prompt, data_url, in_size):
    """Send the edit request; return (image bytes, generation id)."""
    if a.model.startswith("google/"):
        status, resp = gateway(
            "POST",
            "/chat/completions",
            {
                "model": a.model,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "image_url", "image_url": {"url": data_url}},
                            {"type": "text", "text": prompt},
                        ],
                    }
                ],
                "modalities": ["text", "image"],
                "providerOptions": {"google": {"imageConfig": {"imageSize": a.image_size}}},
            },
        )
        message = (resp.get("choices") or [{}])[0].get("message", {})
        # Gemini Pro may also return a smaller interim "thought" image first; the last image is the final one
        images = [im["image_url"]["url"].split(",", 1)[1] for im in message.get("images") or []]
        gen_id = resp.get("id")
        refusal = message.get("content")
    else:
        body = {"model": a.model, "prompt": prompt, "images": [{"image_url": data_url}], "n": 1}
        if a.model.startswith("openai/") and in_size:
            # OpenAI wants both sides divisible by 16; keep the long edge <= 2048 and fix the aspect after
            scale = min(1.0, 2048 / max(in_size))
            body |= {"size": "x".join(str(max(16, round(v * scale / 16) * 16)) for v in in_size), "quality": "high"}
        status, resp = gateway("POST", "/images/edits", body)
        images = [d["b64_json"] for d in resp.get("data") or [] if d.get("b64_json")]
        gen_id = ((resp.get("providerMetadata") or {}).get("gateway") or {}).get("generationId")
        refusal = None
    if status != 200 or not images:
        error = resp.get("error")
        detail = error.get("message") if isinstance(error, dict) else error
        sys.exit(f"Edit failed (HTTP {status}): {detail or refusal or 'no image returned'}")
    return base64.b64decode(images[-1]), gen_id


def lookup_cost(gen_id):
    """USD cost of a generation from GET /v1/generation (usage is ingested a few seconds late)."""
    for _ in range(10):
        status, resp = gateway("GET", f"/generation?id={gen_id}", timeout=30)
        if status == 200:
            return (resp.get("data") or resp).get("total_cost")
        time.sleep(2)
    return None


def main():
    """CLI entry point."""
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("input")
    p.add_argument("output")
    p.add_argument("--part", required=True, help='which object is printed, e.g. "the red top lid shell"')
    p.add_argument("--model", default="google/gemini-3-pro-image")
    p.add_argument("--layer-mm", default="0.2")
    p.add_argument("--z-dir", default="image-vertical, so the lines run horizontally",
                   help='where the print Z axis points in the image when the part is posed differently, e.g. '
                        '"along the cone\'s long axis, so the lines wrap around it as rings"')
    p.add_argument("--material", default="pla_matte", choices=sorted(MATERIALS))
    p.add_argument("--bed-face", help="face printed against the textured PEI plate (gets plate grain, no lines)")
    p.add_argument("--keep", help="non-printed things to list explicitly as untouched")
    p.add_argument("--notes", help="extra sentences for this image (scale, features to protect, ...)")
    p.add_argument("--seam", action="store_true", help="ask for a faint vertical Z seam")
    p.add_argument("--image-size", default="2K", help="Gemini output size class: 1K, 2K or 4K")
    p.add_argument("--print-prompt", action="store_true", help="print the prompt and exit without calling the API")
    a = p.parse_args()

    prompt = build_prompt(a)
    if a.print_prompt:
        print(prompt)
        return

    tool = imaging()
    in_size = image_size(a.input, tool)
    ext = os.path.splitext(a.input)[1].lower().lstrip(".")
    mime = {"jpg": "jpeg", "jpeg": "jpeg", "webp": "webp"}.get(ext, "png")
    with open(a.input, "rb") as f:
        data_url = f"data:image/{mime};base64," + base64.b64encode(f.read()).decode()

    t0 = time.time()
    raw, gen_id = edit(a, prompt, data_url, in_size)
    seconds = time.time() - t0
    with open(a.output, "wb") as f:
        f.write(raw)
    returned = image_size(a.output, tool)
    if in_size and tool and returned != tuple(in_size):
        fit(a.output, in_size, tool)
        size_note = f"{returned[0]}x{returned[1]} returned, resized to {in_size[0]}x{in_size[1]}"
    else:
        size_note = f"{returned[0]}x{returned[1]}" if returned else "size unknown"
        if not tool and returned != in_size:
            size_note += " (install Pillow or use macOS to resize to the input size)"
    cost = lookup_cost(gen_id) if gen_id else None
    print(f"{a.model}: {seconds:.1f} s, {size_note}, cost " + (f"${cost:.4f}" if cost is not None else "unknown"))
    print(f"wrote {a.output}")


if __name__ == "__main__":
    main()
