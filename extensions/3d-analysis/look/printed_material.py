"""
Make Blender renders of our parts look 3D printed (FDM) instead of injection molded.

One node group, "Printed Surface", turns a part's print orientation into surface detail:
  - layer beads on walls, following the print Z axis (not the render pose), with per-layer irregularity and slow
    banding, and stair-step terraces (contour lines) on shallow slopes
  - diagonal top-skin lines on flat tops, alternating 45/-45 degrees with the layer
  - textured-PEI grain (or smooth-plate gloss) on the face that sat on the bed
  - a faint Z seam, slightly softened edges (Cycles bevel), patchy matte roughness, a slight tone change per layer
  - anisotropic sheen along the layers, which carries the look once the lines are smaller than a pixel

Level of detail: real 0.2 mm lines are sub-pixel in most mockups and drawn as-is would shimmer into moire. A
render_pre handler (update_lod) works out the camera's pixel size, and the shader fades the regular patterns (beads,
creases, top skin) out between 1.2 and 4 px per period, handing walls over to anisotropic sheen. The random parts
(per-layer tilt and tone, banding, plate pebbles, seam) stay on, so far shots show faint irregular striations and
close-ups show real ridges, like a photo.

Cycles only (the bevel and the LOD math are Cycles features; EEVEE renders it without the edge rounding).

Usage, inside a Blender script:
    sys.path.insert(0, "/path/to/brand/render")
    from printed_material import apply_printed_material, add_print_surface

    apply_printed_material(obj, "pla_matte", "#e8e1d0", layer_mm=0.2, print_up=(0, 0, 1))
    # a part that was printed face-down, in a scene where 1 Blender unit = 100 mm:
    apply_printed_material(lid, "petg", "#9e1b25", print_up=(0, 0, -1), mm_per_unit=100)
    # keep an existing material (texture-driven color etc.) and just add the print surface to its Principled BSDF:
    add_print_surface(mat, obj, "pla_matte", print_up=(0, 0, -1), mm_per_unit=100)

print_up is in the object's own (mesh) axes: the direction that pointed away from the bed when it printed. Export
STLs in print orientation and it is (0, 0, 1). mm_per_unit is how many real millimetres one Blender (world) unit is in
the scene; the object's scale is read in the shader, so a model shown at 0.8x prints 0.2 mm lines at the shown size.
"""

import math

import bpy
from mathutils import Vector

GROUP = "Printed Surface"
GROUP_VERSION = 10

PRESETS = {
    # roughness/specular/etc. go on the Principled BSDF; the rest are the group's inputs
    "pla_matte": dict(roughness=0.6, specular=0.4, subsurface=0.03, anisotropy=0.3, relief=0.7, rough_var=0.05,
                      top_rough=0.06),
    "pla": dict(roughness=0.38, specular=0.5, subsurface=0.03, anisotropy=0.45, relief=0.55, rough_var=0.04,
                top_rough=0.08),
    "petg": dict(roughness=0.2, specular=0.55, subsurface=0.1, anisotropy=0.55, relief=0.45, rough_var=0.03,
                 top_rough=0.06),
    "silk": dict(roughness=0.26, specular=0.6, metallic=0.6, anisotropy=0.8, relief=0.5, rough_var=0.03,
                 top_rough=0.05),
    "asa": dict(roughness=0.66, specular=0.35, anisotropy=0.25, relief=0.7, rough_var=0.06, top_rough=0.05),
    # ASA after acetone vapor smoothing: glossy, layer lines melted down to a faint soft ripple. Pair with
    # bed="smooth", banding/layer_jitter/layer_shade around 0.3, top_lines ~0.15 and edge_mm ~0.8 (edges round over).
    "asa_smoothed": dict(roughness=0.09, specular=0.55, anisotropy=0.06, relief=0.07, rough_var=0.015, top_rough=0.0),
}
BED_ROUGHNESS = {"textured": 0.62, "smooth": 0.12}
BED_SPARKLE = {"textured": 0.25, "smooth": 0.0}

_INPUTS = [
    # name, type, default
    ("Layer Height mm", "Float", 0.2),
    ("Line Width mm", "Float", 0.42),
    ("Print Up", "Vector", (0.0, 0.0, 1.0)),
    ("Axis A", "Vector", (1.0, 0.0, 0.0)),
    ("Axis B", "Vector", (0.0, 1.0, 0.0)),
    ("Center", "Vector", (0.0, 0.0, 0.0)),
    ("mm per Unit", "Float", 1.0),
    ("Pixel Angle", "Float", 0.0006),
    ("Ortho Pixel", "Float", 0.0),
    ("LOD Min px", "Float", 1.2),
    ("LOD Max px", "Float", 4.0),
    ("Relief", "Float", 0.55),
    ("Bead Angle", "Float", 1.15),
    ("Banding", "Float", 1.0),
    ("Layer Jitter", "Float", 1.0),
    ("Layer Shade", "Float", 1.0),
    ("Top Lines", "Float", 1.0),
    ("Bed Grain", "Float", 1.0),
    ("Bed Sparkle", "Float", 0.25),
    ("Seam", "Float", 1.0),
    ("Seam Angle", "Float", math.pi / 2),
    ("Seam Width mm", "Float", 0.5),
    ("Edge Radius mm", "Float", 0.4),
    ("Roughness", "Float", 0.6),
    ("Roughness Variation", "Float", 0.05),
    ("Top Roughness Add", "Float", 0.06),
    ("Bed Roughness", "Float", 0.72),
    ("Anisotropy", "Float", 0.3),
]
_OUTPUTS = [("Normal", "Vector"), ("Roughness", "Float"), ("Anisotropic", "Float"), ("Tangent", "Vector"), ("Shade", "Float"),
            ("Wall", "Float"), ("Top", "Float"), ("Bed", "Float"), ("Line Visibility", "Float")]


def srgb(hex_color, alpha=1.0):
    """Hex sRGB ("#rrggbb") to Blender's linear RGBA."""
    c = [int(hex_color[i : i + 2], 16) / 255 for i in (1, 3, 5)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c] + [alpha]


class _Tree:
    """Small builder for shader node trees. Every helper takes sockets or plain numbers/tuples and returns a socket."""

    def __init__(self, tree):
        self.tree = tree

    def node(self, kind, **props):
        n = self.tree.nodes.new(kind)
        for key, value in props.items():
            setattr(n, key, value)
        return n

    def feed(self, socket, value):
        if isinstance(value, bpy.types.NodeSocket):
            self.tree.links.new(value, socket)
        else:
            socket.default_value = value

    def math(self, op, a, b=0.0, c=0.0, clamp=False):
        n = self.node("ShaderNodeMath", operation=op, use_clamp=clamp)
        for socket, value in zip(n.inputs, (a, b, c)):
            self.feed(socket, value)
        return n.outputs[0]

    def add(self, *xs):
        out = xs[0]
        for x in xs[1:]:
            out = self.math("ADD", out, x)
        return out

    def mul(self, *xs):
        out = xs[0]
        for x in xs[1:]:
            out = self.math("MULTIPLY", out, x)
        return out

    def lerp(self, a, b, f):
        """a + (b - a) * f, for floats."""
        return self.math("MULTIPLY_ADD", self.math("SUBTRACT", b, a), f, a)

    def smooth(self, x, lo, hi):
        """Smoothstep from lo to hi, clamped to 0..1."""
        n = self.node("ShaderNodeMapRange", interpolation_type="SMOOTHSTEP", clamp=True)
        for socket, value in zip(n.inputs[:3], (x, lo, hi)):
            self.feed(socket, value)
        return n.outputs["Result"]

    def vec(self, op, a, b=(0.0, 0.0, 0.0), scale=None):
        n = self.node("ShaderNodeVectorMath", operation=op)
        self.feed(n.inputs[0], a)
        self.feed(n.inputs[1], b)
        if scale is not None:
            self.feed(n.inputs[3], scale)
        return n.outputs["Value" if op in ("DOT_PRODUCT", "LENGTH", "DISTANCE") else "Vector"]

    def vlerp(self, a, b, f):
        """a + (b - a) * f, for vectors with a float factor."""
        return self.vec("ADD", a, self.vec("SCALE", self.vec("SUBTRACT", b, a), scale=f))

    def to_world(self, v):
        """An object-space direction in world space (keeps the object's scale in its length)."""
        n = self.node("ShaderNodeVectorTransform", vector_type="VECTOR", convert_from="OBJECT", convert_to="WORLD")
        self.feed(n.inputs[0], v)
        return n.outputs[0]

    def noise(self, vector=None, w=None, scale=1.0, detail=2.0, roughness=0.5):
        """Perlin noise around 0.5: 3D from vector, or 1D from w."""
        n = self.node("ShaderNodeTexNoise", noise_dimensions="1D" if w is not None else "3D")
        self.feed(n.inputs["W"] if w is not None else n.inputs["Vector"], w if w is not None else vector)
        self.feed(n.inputs["Scale"], scale)
        self.feed(n.inputs["Detail"], detail)
        self.feed(n.inputs["Roughness"], roughness)
        return n.outputs[0]

    def hash1(self, w):
        """A random 0..1 per integer w."""
        n = self.node("ShaderNodeTexWhiteNoise", noise_dimensions="1D")
        self.feed(n.inputs["W"], w)
        return n.outputs["Value"]


def _build_group():
    ng = bpy.data.node_groups.new(GROUP, "ShaderNodeTree")
    ng["printed_version"] = GROUP_VERSION
    for name, kind, default in _INPUTS:
        sock = ng.interface.new_socket(name, in_out="INPUT", socket_type=f"NodeSocket{kind}")
        sock.default_value = default
    for name, kind in _OUTPUTS:
        ng.interface.new_socket(name, in_out="OUTPUT", socket_type=f"NodeSocket{kind}")
    t = _Tree(ng)
    gi = t.node("NodeGroupInput").outputs
    go = t.node("NodeGroupOutput")
    geo = t.node("ShaderNodeNewGeometry").outputs
    obj_co = t.node("ShaderNodeTexCoord").outputs["Object"]
    view_dist = t.node("ShaderNodeCameraData").outputs["View Distance"]
    layer, mm_per_unit = gi["Layer Height mm"], gi["mm per Unit"]
    world_per_mm = t.math("DIVIDE", 1.0, mm_per_unit)

    # Shading normal with softened edges.
    bevel = t.node("ShaderNodeBevel", samples=6)
    t.feed(bevel.inputs["Radius"], t.mul(gi["Edge Radius mm"], world_per_mm))
    n = bevel.outputs["Normal"]

    # Print frame: up in world space, and positions in real (printed) mm. The object's scale along up turns object
    # units into world units, so a scaled-down model still gets layers of the real height.
    up_world = t.to_world(gi["Print Up"])
    up = t.vec("NORMALIZE", up_world)
    mm_per_obj = t.mul(t.vec("LENGTH", up_world), mm_per_unit)
    p = t.vec("SUBTRACT", obj_co, gi["Center"])
    z = t.mul(t.vec("DOT_PRODUCT", p, gi["Print Up"]), mm_per_obj)
    x = t.mul(t.vec("DOT_PRODUCT", p, gi["Axis A"]), mm_per_obj)
    y = t.mul(t.vec("DOT_PRODUCT", p, gi["Axis B"]), mm_per_obj)
    p_mm = t.vec("SCALE", p, scale=mm_per_obj)

    c = t.vec("DOT_PRODUCT", n, up)  # 1 faces print-up (a top), 0 a wall, -1 the bed face
    wall = t.math("SUBTRACT", 1.0, t.mul(c, c), clamp=True)  # sin^2: 1 on walls, 0 on flat tops/bottoms
    sin_slope = t.math("SQRT", wall)
    facing_up = t.math("GREATER_THAN", c, 0.0)
    top = t.smooth(c, 0.985, 0.997)
    bed = t.smooth(t.math("MULTIPLY", c, -1.0), 0.985, 0.997)

    # Pixel footprint (world units per pixel here) and how many pixels one layer period spans along the slope.
    footprint = t.math("MULTIPLY_ADD", view_dist, gi["Pixel Angle"], gi["Ortho Pixel"])
    upslope = t.vec("NORMALIZE", t.vec("SUBTRACT", up, t.vec("SCALE", n, scale=c)))
    g_dot_v = t.vec("DOT_PRODUCT", upslope, geo["Incoming"])
    foreshorten = t.math("SQRT", t.math("SUBTRACT", 1.0, t.mul(g_dot_v, g_dot_v), clamp=True))
    period_px = t.math("DIVIDE", t.mul(layer, world_per_mm, foreshorten),
                       t.mul(t.math("MAXIMUM", sin_slope, 0.04), footprint))
    lod_lo, lod_hi = gi["LOD Min px"], gi["LOD Max px"]
    vis = t.smooth(period_px, lod_lo, lod_hi)

    # Layer beads and terraces. Within each layer a fraction `wall` of the surface is the bead's rounded outer face
    # (normal sweeping from down-out to up-out), the rest is the flat terrace on top (or underside, on overhangs).
    zl = t.math("DIVIDE", z, layer)
    layer_i = t.math("FLOOR", zl)
    f = t.math("FRACT", zl)
    rnd = t.hash1(layer_i)
    rnd2 = t.hash1(t.add(layer_i, 37.0))
    k = t.math("MAXIMUM", wall, 0.02)
    bead_max = gi["Bead Angle"]
    outer = t.lerp(math.pi / 2, bead_max, wall)  # how far the bead rolls over into its own terrace
    lo = t.lerp(t.math("MULTIPLY", outer, -1.0), t.math("MULTIPLY", bead_max, -1.0), facing_up)
    hi = t.lerp(bead_max, outer, facing_up)
    u_up = t.math("DIVIDE", f, k)
    u_dn = t.math("DIVIDE", t.add(f, k, -1.0), k)
    u = t.math("MINIMUM", t.math("MAXIMUM", t.lerp(u_dn, u_up, facing_up), 0.0), 1.0)
    in_bead = t.lerp(t.math("GREATER_THAN", f, t.math("SUBTRACT", 1.0, k)), t.math("LESS_THAN", f, k), facing_up)
    # never more than ~72 degrees off the surface's own tilt: past that the bead is hidden in the crease, and on
    # rounded edges it would shade as a dark outline
    psi = t.math("ARCSINE", c)
    phi = t.math("MAXIMUM", t.math("MINIMUM", t.lerp(lo, hi, u), t.add(psi, 1.25)), t.math("SUBTRACT", psi, 1.25))
    out_dir = t.vec("NORMALIZE", t.vec("SUBTRACT", n, t.vec("SCALE", up, scale=c)))
    bead_n = t.vec("ADD", t.vec("SCALE", out_dir, scale=t.math("COSINE", phi)), t.vec("SCALE", up, scale=t.math("SINE", phi)))
    terrace_n = t.vec("SCALE", up, scale=t.math("MULTIPLY_ADD", facing_up, 2.0, -1.0))
    micro = t.vlerp(terrace_n, bead_n, in_bead)
    # irregular: per-layer strength, slow along-the-layer patches; none on truly flat faces
    patch = t.noise(vector=p_mm, scale=0.3, detail=1.0)
    strength = t.mul(gi["Relief"], vis, t.math("MULTIPLY_ADD", rnd, 0.5, 0.75), t.math("MULTIPLY_ADD", patch, 0.6, 0.7),
                     t.smooth(wall, 0.0005, 0.004))
    n_layers = t.vec("NORMALIZE", t.vlerp(n, micro, t.math("MINIMUM", strength, 1.0)))
    # Irregular layers: each layer and each few-mm band tilts a little up or down. These are random, not periodic,
    # so they stay on when the beads are sub-pixel and read as the faint striations a photo shows at a distance.
    band_noise = t.math("SUBTRACT", t.noise(w=t.math("DIVIDE", z, 0.9), scale=1.0, detail=3.0, roughness=0.65), 0.5)
    jitter = t.mul(t.math("SUBTRACT", t.hash1(t.add(layer_i, 71.0)), 0.5), gi["Layer Jitter"], 0.22)
    tilt = t.mul(t.math("MULTIPLY_ADD", band_noise, t.mul(gi["Banding"], 0.5), jitter), wall)
    # and each layer's tone differs a touch (light scatters a little differently in each), the "lines" you see on
    # white and translucent prints from across the room
    shade = t.math("MULTIPLY_ADD", t.math("SUBTRACT", t.hash1(t.add(layer_i, 113.0)), 0.5), 0.1, t.mul(band_noise, 0.12))
    # the crease between layers holds a little shadow; periodic, so only once the layers are resolved
    crease = t.math("SUBTRACT", 1.0, t.smooth(t.math("MINIMUM", f, t.math("SUBTRACT", 1.0, f)), 0.0, 0.14))
    shade = t.math("MULTIPLY_ADD", t.mul(crease, vis, k), -0.12, shade)
    shade = t.math("MULTIPLY_ADD", t.mul(shade, wall), gi["Layer Shade"], 1.0)
    n_layers = t.vec("NORMALIZE", t.vec("ADD", n_layers, t.vec("SCALE", up, scale=tilt)))
    # Textured-plate face: ~0.2 mm pebbles, each tilted at random. Random, so it can stay on at any distance: far away
    # it averages into the plate's frosted sheen, close up it's the pebble grain.
    cells = t.node("ShaderNodeTexVoronoi", voronoi_dimensions="3D", feature="F1")
    t.feed(cells.inputs["Vector"], p_mm)
    t.feed(cells.inputs["Scale"], 6.5)
    pebble = t.vec("SUBTRACT", cells.outputs["Color"], (0.5, 0.5, 0.5))
    pebble = t.vec("SUBTRACT", pebble, t.vec("SCALE", n, scale=t.vec("DOT_PRODUCT", pebble, n)))
    n_layers = t.vec("NORMALIZE", t.vec("ADD", n_layers, t.vec("SCALE", pebble, scale=t.mul(gi["Bed Sparkle"], bed, 2.0))))

    # Height detail through one bump node, in mm: diagonal top-skin lines, bed grain and the seam.
    parity = t.math("FLOORED_MODULO", t.math("ROUND", zl), 2.0)
    diag_a = t.vec("SCALE", t.vec("ADD", gi["Axis A"], gi["Axis B"]), scale=math.sqrt(0.5))
    diag_b = t.vec("SCALE", t.vec("SUBTRACT", gi["Axis A"], gi["Axis B"]), scale=math.sqrt(0.5))
    across = t.mul(t.lerp(t.vec("DOT_PRODUCT", p, diag_b), t.vec("DOT_PRODUCT", p, diag_a), parity), mm_per_obj)
    ridge = t.math("FRACT", t.math("DIVIDE", across, gi["Line Width mm"]))
    ridge = t.math("SUBTRACT", 1.0, t.math("POWER", t.math("MULTIPLY_ADD", ridge, 2.0, -1.0), 2.0))
    n_dot_v = t.math("MAXIMUM", t.math("ABSOLUTE", t.vec("DOT_PRODUCT", n, geo["Incoming"])), 0.25)
    top_vis = t.smooth(t.math("DIVIDE", t.mul(gi["Line Width mm"], world_per_mm, n_dot_v), footprint), lod_lo, lod_hi)
    top_lines = t.mul(ridge, top, top_vis, gi["Top Lines"], 0.012)
    grain_vis = t.smooth(t.math("DIVIDE", t.mul(world_per_mm, 0.35), footprint), lod_lo, lod_hi)
    grain = t.mul(t.math("SUBTRACT", t.noise(vector=p_mm, scale=4.0, detail=3.0, roughness=0.6), 0.5), bed, grain_vis,
                  gi["Bed Grain"], 0.02)
    azimuth = t.math("ARCTAN2", y, x)
    d_az = t.math("SUBTRACT", t.math("FLOORED_MODULO", t.add(t.math("SUBTRACT", azimuth, gi["Seam Angle"]), math.pi),
                                     2 * math.pi), math.pi)
    arc = t.mul(t.math("ABSOLUTE", d_az), t.math("SQRT", t.add(t.mul(x, x), t.mul(y, y))))
    seam_dir = t.vec("NORMALIZE", t.to_world(t.vec("ADD", t.vec("SCALE", gi["Axis A"], scale=t.math("COSINE", gi["Seam Angle"])),
                                                     t.vec("SCALE", gi["Axis B"], scale=t.math("SINE", gi["Seam Angle"])))))
    seam_facing = t.smooth(t.vec("DOT_PRODUCT", out_dir, seam_dir), 0.2, 0.6)
    seam_profile = t.math("MAXIMUM", t.math("SUBTRACT", 1.0, t.math("POWER", t.math("DIVIDE", arc, gi["Seam Width mm"]), 2.0)), 0.0)
    seam = t.mul(seam_profile, seam_facing, wall, t.math("MULTIPLY_ADD", rnd2, 0.7, 0.3), gi["Seam"], 0.06)
    bump = t.node("ShaderNodeBump")
    t.feed(bump.inputs["Strength"], 1.0)
    t.feed(bump.inputs["Distance"], world_per_mm)
    t.feed(bump.inputs["Height"], t.add(top_lines, grain, seam))
    t.feed(bump.inputs["Normal"], n_layers)

    # Roughness: patchy, a little per layer, rougher tops, the bed's own finish underneath.
    rough_patch = t.math("SUBTRACT", t.noise(vector=p_mm, scale=0.25, detail=2.0), 0.5)
    rough = t.math("MULTIPLY_ADD", rough_patch, t.mul(gi["Roughness Variation"], 2.0), gi["Roughness"])
    rough = t.math("MULTIPLY_ADD", t.mul(t.math("SUBTRACT", rnd, 0.5), wall), gi["Roughness Variation"], rough)
    rough = t.math("MULTIPLY_ADD", top, gi["Top Roughness Add"], rough)
    rough = t.lerp(rough, gi["Bed Roughness"], bed)
    rough = t.math("MINIMUM", t.math("MAXIMUM", rough, 0.02), 1.0)

    # Anisotropic sheen across the layers on walls (strongest once the lines are sub-pixel), along the skin on tops.
    diag_world = t.vec("NORMALIZE", t.to_world(t.vec("ADD", t.vec("SCALE", diag_a, scale=parity),
                                                     t.vec("SCALE", diag_b, scale=t.math("SUBTRACT", 1.0, parity)))))
    tangent = t.vec("NORMALIZE", t.vec("ADD", t.vlerp(upslope, diag_world, top), t.vec("SCALE", seam_dir, scale=0.001)))
    aniso = t.mul(gi["Anisotropy"], t.add(t.mul(wall, t.math("MULTIPLY_ADD", vis, -0.5, 1.0)), t.mul(top, 0.5)))

    for name, socket in (("Normal", bump.outputs["Normal"]), ("Roughness", rough), ("Anisotropic", aniso),
                         ("Tangent", tangent), ("Shade", shade), ("Wall", wall), ("Top", top), ("Bed", bed), ("Line Visibility", vis)):
        ng.links.new(socket, go.inputs[name])
    return ng


def printed_group():
    """The shared "Printed Surface" node group, (re)built if missing or from an older version of this module."""
    ng = bpy.data.node_groups.get(GROUP)
    if ng and ng.get("printed_version") == GROUP_VERSION:
        return ng
    if ng:
        ng.name = f"{GROUP} (old)"
    fresh = _build_group()
    if ng:
        ng.user_remap(fresh)
        bpy.data.node_groups.remove(ng)
    return fresh


def _print_axes(print_up):
    """Unit print-up plus two horizontal axes, the object's X and Y flattened onto the print plane where possible, so
    seam angles read as 0 = +X, 90 = +Y."""
    up = Vector(print_up).normalized()
    refs = [Vector(v) for v in ((1, 0, 0), (0, 1, 0), (0, 0, 1))]
    flat = [r - r.dot(up) * up for r in refs]
    a = next(v for v in flat if v.length > 0.3).normalized()
    b = next(v - v.dot(a) * a for v in flat[1:] + flat[:1] if (v - v.dot(a) * a).length > 0.3).normalized()
    return up, a, b


def _local_center(obj):
    """Object-space bounding-box center (the seam is placed by angle around it)."""
    corners = [Vector(c) for c in obj.bound_box]
    return sum(corners, Vector()) / 8


def add_print_surface(material, obj, preset="pla_matte", layer_mm=0.2, print_up=(0, 0, 1), mm_per_unit=1.0,
                      line_mm=0.42, bed="textured", seam=1.0, seam_deg=90.0, edge_mm=0.4, **inputs):
    """Wire the printed-surface group into an existing material's Principled BSDF: it takes over Normal, Roughness,
    Anisotropic and Tangent and leaves color and everything else alone. The preset sets the BSDF's finish only when
    called through apply_printed_material; here it sets the group's roughness/relief/sheen inputs. Extra keyword
    arguments set group inputs by name with spaces as underscores, e.g. relief=0.8, banding=0, top_lines=0.5.
    Returns the group node."""
    preset_values = PRESETS[preset]
    nt = material.node_tree
    bsdf = next(n for n in nt.nodes if n.bl_idname == "ShaderNodeBsdfPrincipled")
    node = nt.nodes.new("ShaderNodeGroup")
    node.node_tree = printed_group()
    node.label = f"Printed {preset} {layer_mm} mm"
    node.location = bsdf.location.x - 300, bsdf.location.y - 200
    up, a, b = _print_axes(print_up)
    values = {
        "Layer Height mm": layer_mm,
        "Line Width mm": line_mm,
        "Print Up": up,
        "Axis A": a,
        "Axis B": b,
        "Center": _local_center(obj),
        "mm per Unit": mm_per_unit,
        "Relief": preset_values["relief"],
        "Seam": seam,
        "Seam Angle": math.radians(seam_deg),
        "Edge Radius mm": edge_mm,
        "Roughness": preset_values["roughness"],
        "Roughness Variation": preset_values["rough_var"],
        "Top Roughness Add": preset_values["top_rough"],
        "Bed Roughness": BED_ROUGHNESS[bed],
        "Bed Sparkle": BED_SPARKLE[bed],
        "Anisotropy": preset_values["anisotropy"],
    }
    by_key = {name.lower().replace(" ", "_"): name for name, _, _ in _INPUTS}
    values.update({by_key[key]: value for key, value in inputs.items()})
    for name, value in values.items():
        node.inputs[name].default_value = value
    for out, into in (("Normal", "Normal"), ("Roughness", "Roughness"), ("Anisotropic", "Anisotropic"),
                      ("Tangent", "Tangent")):
        nt.links.new(node.outputs[out], bsdf.inputs[into])
    tone = nt.nodes.new("ShaderNodeMix")
    tone.data_type, tone.blend_type = "RGBA", "MULTIPLY"
    tone.inputs["Factor"].default_value = 1.0
    tone.location = bsdf.location.x - 200, bsdf.location.y + 150
    color_in = bsdf.inputs["Base Color"]
    if color_in.links:
        nt.links.new(color_in.links[0].from_socket, tone.inputs[6])
    else:
        tone.inputs[6].default_value = color_in.default_value
    nt.links.new(node.outputs["Shade"], tone.inputs[7])
    nt.links.new(tone.outputs[2], color_in)
    if bpy.context.scene.camera:
        _set_lod(node, bpy.context.scene)
    return node


def apply_printed_material(obj, preset="pla_matte", color="#808080", layer_mm=0.2, print_up=(0, 0, 1),
                           mm_per_unit=1.0, **kwargs):
    """Give obj a new printed-plastic material (replacing what it had) and return it. color is "#rrggbb" sRGB or a
    linear RGBA tuple; presets: pla_matte, pla, petg, silk, asa. See add_print_surface for the other options."""
    preset_values = PRESETS[preset]
    mat = bpy.data.materials.new(f"printed-{preset}")
    bsdf = next(n for n in mat.node_tree.nodes if n.bl_idname == "ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = srgb(color) if isinstance(color, str) else color
    bsdf.inputs["Specular IOR Level"].default_value = preset_values["specular"]
    bsdf.inputs["Metallic"].default_value = preset_values.get("metallic", 0.0)
    if preset_values.get("subsurface"):
        bsdf.inputs["Subsurface Weight"].default_value = preset_values["subsurface"]
        bsdf.inputs["Subsurface Radius"].default_value = (1.0, 0.7, 0.45)
        bsdf.inputs["Subsurface Scale"].default_value = 1.0 / mm_per_unit
    add_print_surface(mat, obj, preset, layer_mm, print_up, mm_per_unit, **kwargs)
    if obj.material_slots:
        for slot in obj.material_slots:
            slot.material = mat
    else:
        obj.data.materials.append(mat)
    return mat


def _set_lod(node, scene):
    """Point one group node at the scene camera's pixel size."""
    cam = scene.camera.data
    r = scene.render
    pct = r.resolution_percentage / 100
    w, h = r.resolution_x * r.pixel_aspect_x * pct, r.resolution_y * r.pixel_aspect_y * pct
    fit = cam.sensor_fit if cam.sensor_fit != "AUTO" else ("HORIZONTAL" if w >= h else "VERTICAL")
    pixels = w if fit == "HORIZONTAL" else h
    sensor = cam.sensor_height if cam.sensor_fit == "VERTICAL" else cam.sensor_width
    if cam.type == "ORTHO":
        node.inputs["Pixel Angle"].default_value = 0.0
        node.inputs["Ortho Pixel"].default_value = cam.ortho_scale / pixels
    else:
        node.inputs["Pixel Angle"].default_value = sensor / cam.lens / pixels
        node.inputs["Ortho Pixel"].default_value = 0.0


@bpy.app.handlers.persistent
def update_lod(scene=None, *_):
    """Match every printed surface's level of detail to the active camera and resolution. Runs before each render;
    call it yourself if you change the camera in between without rendering."""
    scene = scene or bpy.context.scene
    if not scene.camera:
        return
    for mat in bpy.data.materials:
        for node in mat.node_tree.nodes if mat.node_tree else ():
            if node.bl_idname == "ShaderNodeGroup" and node.node_tree and node.node_tree.name == GROUP:
                _set_lod(node, scene)


bpy.app.handlers.render_pre[:] = [h for h in bpy.app.handlers.render_pre if h.__name__ != "update_lod"] + [update_lod]
