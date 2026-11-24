// This Mac drawn isometric, as SVG: a MacBook open, a Mac mini or a Mac Studio, to its look's size
// in millimetres, in its finish lit from the front left. Each part is an extruded rounded
// rectangle; its sides and top are shaded by which way they face, its sides as one band whose
// gradient follows them round their corners.
import type { Look } from "./look.ts"

type V3 = readonly [number, number, number]

const C = Math.cos(Math.PI / 6)

/** World (x right, y toward the front, z up) to the picture's plane, y down. */
const iso = ([x, y, z]: V3): readonly [number, number] => [(x - y) * C, (x + y) / 2 - z]

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const unit = (a: V3) => scale(a, 1 / Math.hypot(...a))

/** Toward the viewer, and toward the light. */
const VIEWER = unit([1, 1, 1])
const LIGHT = unit([-0.2, 0.55, 1])

const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
const hex = (c: readonly number[]) =>
  `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`

/** A finish: its colour turned fully away from the light, and fully toward it. */
interface Finish {
  readonly dark: string
  readonly lit: string
}
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
const UNDERSIDE: Finish = { dark: "#151516", lit: "#4a4b4e" }

/** `color` moved `t` of the way toward white, or toward black when `t` is negative. */
const tint = (color: string, t: number) =>
  hex(rgb(color).map((v) => (t >= 0 ? v + (255 - v) * t : v * (1 + t))))

const shade = (finish: Finish, normal: V3) => {
  const t = 0.4 + 0.6 * Math.max(0, dot(unit(normal), LIGHT))
  const [d, l] = [rgb(finish.dark), rgb(finish.lit)]
  return hex(d.map((v, i) => v + ((l[i] ?? v) - v) * t))
}

/** A rounded rectangle's outline, counter-clockwise in its plane, each point with its outward normal. */
const outline = (w: number, h: number, r: number) => {
  const c = Math.max(0.01, Math.min(r, w / 2, h / 2))
  const steps = 10
  const corners = [
    [w / 2 - c, h / 2 - c, 0],
    [-(w / 2 - c), h / 2 - c, 90],
    [-(w / 2 - c), -(h / 2 - c), 180],
    [w / 2 - c, -(h / 2 - c), 270],
  ] as const
  return corners.flatMap(([a, b, from]) =>
    Array.from({ length: steps + 1 }, (_, i) => {
      const t = ((from + (90 * i) / steps) * Math.PI) / 180
      return { a: a + c * Math.cos(t), b: b + c * Math.sin(t), na: Math.cos(t), nb: Math.sin(t) }
    }),
  )
}

/** Where a rounded rectangle lies: its centre, its two in-plane axes and its normal. */
interface Plane {
  readonly at: V3
  readonly u: V3
  readonly v: V3
  readonly n: V3
}

const FLAT: Omit<Plane, "at"> = { u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] }
/** On a front face, looking toward +y. */
const FRONT: Omit<Plane, "at"> = { u: [1, 0, 0], v: [0, 0, 1], n: [0, 1, 0] }

const point = (p: Plane, a: number, b: number, t = 0): V3 =>
  add(add(add(p.at, scale(p.u, a)), scale(p.v, b)), scale(p.n, t))

const path = (points: readonly (readonly [number, number])[]) =>
  `M${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join("L")}Z`

/** What's drawn so far, back to front, and how far it reaches on the page. */
class Drawing {
  readonly parts: string[] = []
  readonly defs: string[] = []
  minX = Infinity
  minY = Infinity
  maxX = -Infinity
  maxY = -Infinity

  project(p: V3) {
    const q = iso(p)
    this.minX = Math.min(this.minX, q[0])
    this.maxX = Math.max(this.maxX, q[0])
    this.minY = Math.min(this.minY, q[1])
    this.maxY = Math.max(this.maxY, q[1])
    return q
  }

  /** A flat rounded rectangle in `plane`, `t` along its normal. */
  face(plane: Plane, w: number, h: number, r: number, fill: string, extra = "") {
    const points = outline(w, h, r).map((o) => this.project(point(plane, o.a, o.b)))
    this.parts.push(`<path d="${path(points)}" fill="${fill}"${extra}/>`)
  }

  /**
   * A rounded rectangle in `plane` drawn out `depth` along its normal (or back, when negative):
   * its sides toward the viewer, then its cap toward the viewer. With `round`, the edge of the cap
   * is rounded over that far.
   */
  slab(plane: Plane, w: number, h: number, r: number, depth: number, finish: Finish, round = 0) {
    const ring = outline(w, h, r)
    const up = depth >= 0 ? plane.n : scale(plane.n, -1)
    const capT = depth
    const sideT = depth - Math.sign(depth) * round
    const normal = (o: { na: number; nb: number }) =>
      add(scale(plane.u, o.na), scale(plane.v, o.nb))
    const facing = ring.map((o) => dot(normal(o), VIEWER) > 0)
    // The visible side, as a run round the ring from where it turns toward the viewer.
    const start = facing.findIndex(
      (f, i) => f && facing[(i - 1 + ring.length) % ring.length] !== true,
    )
    const run: number[] = []
    if (start !== -1) {
      run.push((start - 1 + ring.length) % ring.length)
      for (let k = 0; k < ring.length && facing[(start + k) % ring.length] === true; k += 1) {
        run.push((start + k) % ring.length)
      }
      run.push((run.at(-1) ?? 0) + 1)
    }
    const band = (from: number, to: number, inset: number, tilt: number) => {
      const lower = run.map((i) => {
        const o = ring[i % ring.length]
        return o ? this.project(point(plane, o.a, o.b, from)) : ([0, 0] as const)
      })
      const upper = run.map((i) => {
        const o = ring[i % ring.length]
        return o
          ? this.project(point(plane, o.a - o.na * inset, o.b - o.nb * inset, to))
          : ([0, 0] as const)
      })
      const colors = run.map((i) => {
        const o = ring[i % ring.length]
        return shade(finish, o ? add(normal(o), scale(up, tilt)) : up)
      })
      const xs = lower.map((p) => p[0])
      // Upright, it runs left to right, so one gradient across it shades it smoothly; tilted (a
      // lid's edge), it's drawn piece by piece, each piece's edge in its own colour over the seams.
      if (xs.every((x, k) => k === 0 || x >= (xs[k - 1] ?? x))) {
        const id = `g${this.defs.length}`
        const x1 = Math.min(...xs)
        const x2 = Math.max(...xs)
        const stops = colors.map((c, k) => {
          const at = x2 > x1 ? ((xs[k] ?? x1) - x1) / (x2 - x1) : 0
          return `<stop offset="${at.toFixed(4)}" stop-color="${c}"/>`
        })
        this.defs.push(
          `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1.toFixed(2)}" x2="${x2.toFixed(2)}" y1="0" y2="0">${stops.join("")}</linearGradient>`,
        )
        this.parts.push(`<path d="${path([...lower, ...upper.toReversed()])}" fill="url(#${id})"/>`)
        return
      }
      for (let k = 0; k + 1 < run.length; k += 1) {
        const quad = [lower[k], lower[k + 1], upper[k + 1], upper[k]].flatMap((p) => (p ? [p] : []))
        const c = colors[k] ?? "#000"
        this.parts.push(
          `<path d="${path(quad)}" fill="${c}" stroke="${c}" stroke-width="1" vector-effect="non-scaling-stroke"/>`,
        )
      }
    }
    if (run.length > 0) {
      band(0, sideT, 0, 0)
      if (round > 0) {
        band(sideT, capT, round, 1)
      }
    }
    if (dot(up, VIEWER) > 0) {
      const cap = outline(w - 2 * round, h - 2 * round, r - round).map((o) =>
        this.project(point(plane, o.a, o.b, capT)),
      )
      // Brushed light across it, brightest at the back left.
      const id = `g${this.defs.length}`
      const xs = cap.map((p) => p[0])
      const ys = cap.map((p) => p[1])
      const color = shade(finish, up)
      this.defs.push(
        `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${Math.min(...xs).toFixed(2)}" y1="${Math.min(...ys).toFixed(2)}" x2="${Math.max(...xs).toFixed(2)}" y2="${Math.max(...ys).toFixed(2)}"><stop offset="0" stop-color="${tint(color, 0.35)}"/><stop offset="0.55" stop-color="${color}"/><stop offset="1" stop-color="${tint(color, -0.06)}"/></linearGradient>`,
      )
      this.parts.push(`<path class="cap" d="${path(cap)}" fill="url(#${id})"/>`)
    }
  }

  svg(margin: number) {
    const x = this.minX - margin
    const y = this.minY - margin
    const w = this.maxX - this.minX + 2 * margin
    const h = this.maxY - this.minY + 2 * margin
    return `<svg viewBox="${x.toFixed(1)} ${y.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}" role="img" aria-hidden="true"><defs>${this.defs.join("")}</defs>${this.parts.join("")}</svg>`
  }
}

/** A soft shadow under a footprint `w` × `d`, its strength the page's `--shadow`. */
const shadow = (drawing: Drawing, w: number, d: number, r: number) => {
  drawing.defs.push(
    `<filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${(Math.max(w, d) * 0.035).toFixed(1)}"/></filter>`,
  )
  drawing.face(
    { at: [0, 0, 0], ...FLAT },
    w * 1.02,
    d * 1.02,
    r,
    "#000",
    ' filter="url(#soft)" style="opacity:var(--shadow)"',
  )
}

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
