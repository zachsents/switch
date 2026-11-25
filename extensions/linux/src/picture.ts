// This machine drawn isometric, as SVG, with the vitals widget's drawing
// (vitals-widget/drawing.ts): an Intel NUC or a plain box, to its look's size in millimetres.
import type { Look } from "./look.ts"
import { Drawing, FLAT, FRONT, UNDERSIDE, shadow } from "./vitals-widget/drawing.ts"
import type { Finish } from "./vitals-widget/drawing.ts"

/** Its shell: the NUC's graphite sides, and a plain dark box's. */
const GRAPHITE: Finish = { dark: "#1d1e21", lit: "#6a6c72" }
/** The NUC's lid, a gloss black. */
const LID: Finish = { dark: "#08080a", lit: "#3a3b40" }

/** A port on a box's front: a slot, or a round jack, a shade lighter at its lip; `r` rounds its
 * corners (a jack's whole). */
const port = (
  drawing: Drawing,
  d: number,
  x: number,
  z: number,
  w: number,
  h: number,
  r = Math.min(w, h) / 2,
) => {
  drawing.face({ at: [x, d / 2 + 0.04, z], ...FRONT }, w + 0.5, h + 0.5, r + 0.25, "#3a3b3e")
  drawing.face({ at: [x, d / 2 + 0.06, z], ...FRONT }, w, h, r, "#0e0e10")
  if (w !== h) {
    // A USB port's tongue, along it.
    const [tw, th] = w > h ? [w * 0.62, h * 0.28] : [w * 0.28, h * 0.62]
    drawing.face({ at: [x, d / 2 + 0.08, z + h * 0.14], ...FRONT }, tw, th, 0.2, "#2a2b2e")
  }
}

/** How each form's corners round (of its width), the foot it stands on and how far that's set in,
 * mm. A NUC's corners are tight, on a thin rubber foot; its lid is a separate black panel. */
const FORMS = {
  nuc: { corner: 0.07, foot: 2, inset: 8, lid: 3 },
  box: { corner: 0.04, foot: 3, inset: 12, lid: 0 },
} as const

/** This machine's picture, as SVG markup. */
export const picture = (look: Look) => {
  const [w, d, h] = look.mm
  const drawing = new Drawing()
  const { corner, foot, inset, lid } = FORMS[look.form]
  const r = w * corner
  shadow(drawing, w, d, r)
  drawing.slab({ at: [0, 0, 0], ...FLAT }, w - 2 * inset, d - 2 * inset, r, foot + 0.5, UNDERSIDE)
  drawing.slab({ at: [0, 0, foot], ...FLAT }, w, d, r, h - foot - lid, GRAPHITE, 0.6)
  if (look.form === "nuc") {
    drawing.slab({ at: [0, 0, h - lid], ...FLAT }, w, d, r, lid, LID, 0.8)
    // As Intel's front picture places them: the power button at the left, two USB-A ports (the
    // charging one's tongue yellow), the headphone jack and the IR window at the right.
    const z = foot + (h - foot - lid) * 0.5
    drawing.face({ at: [-w * 0.37, d / 2 + 0.06, z], ...FRONT }, 5, 5, 2.5, "#2a2b2e")
    drawing.face({ at: [-w * 0.37, d / 2 + 0.08, z], ...FRONT }, 1.4, 1.4, 0.7, "#5aa9ff")
    port(drawing, d, -w * 0.16, z, 12.5, 5, 0.6)
    drawing.face({ at: [-w * 0.16, d / 2 + 0.1, z + 0.7], ...FRONT }, 7.7, 1.4, 0.2, "#d8b400")
    port(drawing, d, w * 0.02, z, 12.5, 5, 0.6)
    port(drawing, d, w * 0.2, z, 4.3, 4.3)
    drawing.face({ at: [w * 0.36, d / 2 + 0.06, z], ...FRONT }, 9, 4, 1.2, "#3b1015")
  }
  return drawing.svg(Math.max(w, d) * 0.06)
}
