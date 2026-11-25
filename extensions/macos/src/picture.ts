// This Mac drawn isometric, as SVG, with the vitals widget's drawing (vitals-widget/drawing.ts): a
// MacBook open, a Mac mini or a Mac Studio, to its look's size in millimetres, in its finish.
import type { Look } from "./look.ts"
import {
  C,
  Drawing,
  FLAT,
  FRONT,
  UNDERSIDE,
  add,
  iso,
  outline,
  path,
  point,
  scale,
  shade,
  shadow,
  tint,
} from "./vitals-widget/drawing.ts"
import type { Finish, Plane, V3 } from "./vitals-widget/drawing.ts"

const ALUMINIUM: Finish = { dark: "#585b60", lit: "#eef0f2" }
/** Apple's enclosure colours, by the names CoreTypes gives them (look.ts); any other is silver. */
const FINISHES: Readonly<Record<string, Finish>> = {
  silver: ALUMINIUM,
  "space-gray": { dark: "#3c3d40", lit: "#a4a6aa" },
  "space-black": { dark: "#1c1c1e", lit: "#5c5d61" },
  midnight: { dark: "#14171c", lit: "#4f5866" },
  starlight: { dark: "#6b665c", lit: "#f2ede3" },
  gold: { dark: "#6e6352", lit: "#f4e7d2" },
  "rose-gold": { dark: "#6f5b57", lit: "#f5ddd5" },
  "sky-blue": { dark: "#545e69", lit: "#dce6ef" },
}
const finishOf = (look: Look) => FINISHES[look.finish ?? "silver"] ?? ALUMINIUM

// A MacBook's keyboard: its rows back to front in key widths; the bottom row's arrows are half height.
const ROWS: readonly (readonly number[])[] = [
  [1.5, ...Array.from({ length: 12 }, () => 1), 1],
  [...Array.from({ length: 13 }, () => 1), 1.5],
  [1.5, ...Array.from({ length: 12 }, () => 1), 1],
  [1.75, ...Array.from({ length: 11 }, () => 1), 1.75],
  [2.25, ...Array.from({ length: 10 }, () => 1), 2.25],
  [1, 1, 1, 1.25, 5, 1.25, 1, 1, 1, 1],
]
const PITCH = 18.6
const KEY_GAP = 3

const KEYS = "#242427"
const GLASS = "#0c0c0d"
const OPEN_DEG = 112

const laptop = (look: Look) => {
  const [w, d, h] = look.mm
  const drawing = new Drawing()
  const base = h * 0.58
  const lid = h - base
  const r = w * 0.032
  const metal = finishOf(look)
  shadow(drawing, w, d, r)

  // The lid first, behind: its face rises from the hinge at the back, its shell behind it.
  const angle = (OPEN_DEG * Math.PI) / 180
  const up: V3 = [0, Math.cos(angle), Math.sin(angle)]
  const out: V3 = [0, Math.sin(angle), -Math.cos(angle)]
  const tall = d - 1
  const hinge: V3 = [0, -d / 2 + 2, base + 0.6]
  const face: Plane = { at: add(hinge, scale(up, tall / 2)), u: [1, 0, 0], v: up, n: out }
  drawing.slab(face, w, tall, r, -lid, metal)
  drawing.face(face, w - 1.6, tall - 1.6, r - 0.8, GLASS)
  const side = w * 0.018
  const top = d * 0.034
  const bottom = d * 0.07
  const screen = { ...face, at: add(face.at, add(scale(up, (bottom - top) / 2), scale(out, 0.05))) }
  drawing.defs.push(
    `<linearGradient id="screen" gradientUnits="userSpaceOnUse" x1="0" y1="${iso(point(screen, 0, (tall - top - bottom) / 2))[1].toFixed(1)}" x2="0" y2="${iso(point(screen, 0, -(tall - top - bottom) / 2))[1].toFixed(1)}"><stop offset="0" stop-color="#262c38"/><stop offset="0.6" stop-color="#12151b"/><stop offset="1" stop-color="#0a0b0e"/></linearGradient>`,
  )
  drawing.face(screen, w - 2 * side, tall - top - bottom, 2.5, "url(#screen)")
  if (look.notch === true) {
    const notchH = d * 0.026
    const notch = {
      ...face,
      at: add(face.at, add(scale(up, tall / 2 - top - notchH / 2 + 0.6), scale(out, 0.1))),
    }
    drawing.face(notch, w * 0.103, notchH + 1.2, 1.4, GLASS)
  }

  // The base, and on its deck the keyboard and the trackpad.
  drawing.slab({ at: [0, 0, 0], ...FLAT }, w, d, r, base, metal)
  const deck = base + 0.05
  const kbBack = -d / 2 + d * 0.05
  const kbWidth = 14.5 * PITCH
  if (look.well === true) {
    drawing.face(
      { at: [0, kbBack + (ROWS.length * PITCH) / 2, deck], ...FLAT },
      kbWidth + 7,
      ROWS.length * PITCH + 7,
      3,
      GLASS,
    )
  }
  const keys: string[] = []
  for (const [row, widths] of ROWS.entries()) {
    let x = -kbWidth / 2
    const y = kbBack + (row + 0.5) * PITCH
    for (const [i, u] of widths.entries()) {
      const kw = u * PITCH - KEY_GAP
      const cx = x + (u * PITCH) / 2
      const arrows = row === ROWS.length - 1 && i >= widths.length - 3
      const half = (PITCH - KEY_GAP * 1.5) / 2
      const cells: (readonly [number, number])[] = arrows
        ? [
            [y + PITCH / 4 - KEY_GAP / 8, half],
            ...(i === widths.length - 2 ? [[y - PITCH / 4 + KEY_GAP / 8, half] as const] : []),
          ]
        : [[y, PITCH - KEY_GAP]]
      for (const [ky, kd] of cells) {
        const corners: V3[] = [
          [cx - kw / 2, ky - kd / 2, deck + 0.1],
          [cx + kw / 2, ky - kd / 2, deck + 0.1],
          [cx + kw / 2, ky + kd / 2, deck + 0.1],
          [cx - kw / 2, ky + kd / 2, deck + 0.1],
        ]
        keys.push(path(corners.map((c) => drawing.project(c))))
      }
      x += u * PITCH
    }
  }
  drawing.parts.push(`<path d="${keys.join("")}" fill="${KEYS}"/>`)
  const padBack = kbBack + ROWS.length * PITCH + d * 0.04
  const padFront = d / 2 - d * 0.045
  const padD = Math.min(padFront - padBack, d * 0.37)
  drawing.face(
    { at: [0, (padBack + padFront) / 2, deck], ...FLAT },
    w * 0.42,
    padD,
    6,
    shade(metal, [0, 0.12, 1]),
    ` stroke="${shade(metal, [0, 1, 0.4])}" stroke-width="1" vector-effect="non-scaling-stroke"`,
  )
  return drawing.svg(Math.max(w, d) * 0.05)
}

/** A port on a box's front: a slot, or a round jack, a shade lighter at its lip. */
const port = (drawing: Drawing, d: number, x: number, z: number, w: number, h: number) => {
  const r = Math.min(w, h) / 2
  drawing.face({ at: [x, d / 2 + 0.04, z], ...FRONT }, w + 0.5, h + 0.5, r + 0.25, "#3a3b3e")
  drawing.face({ at: [x, d / 2 + 0.06, z], ...FRONT }, w, h, r, "#0e0e10")
  if (w !== h) {
    // A USB-C port's tongue, along it.
    const [tw, th] = w > h ? [w * 0.62, h * 0.28] : [w * 0.28, h * 0.62]
    drawing.face({ at: [x, d / 2 + 0.08, z], ...FRONT }, tw, th, Math.min(tw, th) / 2, "#2a2b2e")
  }
}

/** The part of a rounded rectangle's outline at height `z` that faces the viewer, projected. */
const frontRun = (drawing: Drawing, w: number, d: number, r: number, z: number) =>
  outline(w, d, r)
    .filter((o) => o.na + o.nb > 0)
    .toSorted((p, q) => p.na - p.nb - (q.na - q.nb))
    .map((o) => drawing.project([o.a, o.b, z]))

const polyline = (points: readonly (readonly [number, number])[]) =>
  points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ")

// The Apple mark as a plain shape (not Apple's artwork): a body, a leaf and a bite, in units of its
// height, x right and y toward the front.
const APPLE_BODY =
  "M0 -.2C-.1 -.3 -.42 -.32 -.42 .05C-.42 .3 -.22 .55 -.1 .52C-.04 .5 .04 .5 .1 .52C.22 .55 .42 .3 .42 .05C.42 -.32 .1 -.3 0 -.2Z"
const APPLE_LEAF = "M.02 -.26C.02 -.4 .12 -.48 .2 -.48C.2 -.36 .12 -.27 .02 -.26Z"

/** The mark moved `dy` along it, in `fill`. */
const markCopy = (dy: number, fill: string) =>
  `<g transform="translate(0 ${dy.toFixed(4)})"><path d="${APPLE_BODY}" fill="${fill}"/><path d="${APPLE_LEAF}" fill="${fill}"/></g>`

/** The mark debossed in a box's top at height `z`, `size` mm tall: near black, as Apple's photos
 * of the Mac mini show it, its front edge catching the light. */
const mark = (drawing: Drawing, z: number, size: number, top: string) => {
  const id = `m${drawing.defs.length}`
  drawing.defs.push(
    `<mask id="${id}" maskUnits="userSpaceOnUse" x="-1" y="-1" width="2" height="2"><rect x="-1" y="-1" width="2" height="2" fill="#fff"/><circle cx=".49" cy="-.03" r=".15" fill="#000"/></mask>`,
  )
  const t = `matrix(${(C * size).toFixed(3)} ${(size / 2).toFixed(3)} ${(-C * size).toFixed(3)} ${(size / 2).toFixed(3)} 0 ${(-z).toFixed(3)})`
  const shift = 0.45 / size
  drawing.parts.push(
    `<g transform="${t}"><g mask="url(#${id})">${markCopy(shift, tint(top, 0.5))}${markCopy(0, tint(top, -0.86))}</g></g>`,
  )
}

/** Each box's corners (of its width), the foot it stands on, how far its underside is set in, and
 * how far its top edge rounds over, mm. The old mini stands on a round base. The Mac mini's, from
 * Apple's tech specs pictures (support.apple.com/121555): corners about 18% of its width, a sharp
 * top edge, and a dark vented foot about 6 mm tall, set in about 10 mm. */
const BOXES = {
  mini: { corner: 0.18, foot: 6, inset: 10, round: 0 },
  "mini-2010": { corner: 0.13, foot: 3.5, inset: 19.7, round: 2 },
  studio: { corner: 0.15, foot: 5, inset: 8, round: 3 },
} as const

const box = (look: Look & { readonly form: keyof typeof BOXES }) => {
  const [w, d, h] = look.mm
  const drawing = new Drawing()
  const { corner, foot, inset, round } = BOXES[look.form]
  const r = w * corner
  const metal = finishOf(look)
  shadow(drawing, w, d, r)
  const under = look.form === "mini-2010" ? (w - 2 * inset) / 2 : r - inset
  drawing.slab(
    { at: [0, 0, 0], ...FLAT },
    w - 2 * inset,
    d - 2 * inset,
    under,
    foot + 0.5,
    UNDERSIDE,
  )
  if (look.form === "mini") {
    // The vents round its foot: dark slots, upright, close together.
    const run = frontRun(drawing, w - 2 * inset + 0.1, d - 2 * inset + 0.1, under, 0)
    const top = frontRun(drawing, w - 2 * inset + 0.1, d - 2 * inset + 0.1, under, foot)
    const slots = run.flatMap(([x, y], i) => {
      const [tx, ty] = top[i] ?? [x, y]
      return i % 2 === 0
        ? [`M${x.toFixed(2)} ${(y - 0.8).toFixed(2)}L${tx.toFixed(2)} ${(ty + 0.8).toFixed(2)}`]
        : []
    })
    drawing.parts.push(
      `<path d="${slots.join("")}" stroke="#000" stroke-width="1.1" stroke-linecap="round" opacity=".8"/>`,
    )
  }
  drawing.slab({ at: [0, 0, foot], ...FLAT }, w, d, r, h - foot, metal, round)
  if (look.form === "mini") {
    // The shell's lower edge in its own shadow, darker toward the foot.
    drawing.parts.push(
      `<polyline points="${polyline(frontRun(drawing, w, d, r, foot + 0.3))}" fill="none" stroke="#000" stroke-width=".9" opacity=".22" stroke-linecap="round"/>`,
    )
    mark(drawing, h, w * 0.29, shade(metal, [0, 0, 1]))
    // As Apple's front picture places them: the two USB-C ports upright toward the left, the
    // status light right of centre and the headphone jack beyond it, all a little below halfway.
    const z = foot + (h - foot) * 0.37
    port(drawing, d, -w * 0.293, z, 3, 9)
    port(drawing, d, -w * 0.176, z, 3, 9)
    drawing.face({ at: [w * 0.193, d / 2 + 0.06, z], ...FRONT }, 1.6, 1.6, 0.8, "#f4fbf6")
    port(drawing, d, w * 0.284, z, 4.3, 4.3)
  } else if (look.form === "studio") {
    // Two USB-C ports, and the card slot.
    const z = foot + 18
    port(drawing, d, -w * 0.27, z, 8.4, 2.7)
    port(drawing, d, -w * 0.2, z, 8.4, 2.7)
    port(drawing, d, w * 0.22, z, 24, 1.6)
  }
  return drawing.svg(Math.max(w, d) * 0.06)
}

/** This Mac's picture, as SVG markup. */
export const picture = (look: Look) =>
  look.form === "laptop" ? laptop(look) : box({ ...look, form: look.form })
