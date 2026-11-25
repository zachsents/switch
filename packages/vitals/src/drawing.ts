// A machine drawn isometric, as SVG, for the vitals widget's picture: what each extension draws its
// machines with (their picture.ts), to their sizes in millimetres, lit from the front left. Each
// part is an extruded rounded rectangle; its sides and top are shaded by which way they face, its
// sides as one band whose gradient follows them round their corners.
export type V3 = readonly [number, number, number]

export const C = Math.cos(Math.PI / 6)

/** World (x right, y toward the front, z up) to the picture's plane, y down. */
export const iso = ([x, y, z]: V3): readonly [number, number] => [(x - y) * C, (x + y) / 2 - z]

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const unit = (a: V3) => scale(a, 1 / Math.hypot(...a))

/** Toward the viewer, and toward the light. */
const VIEWER = unit([1, 1, 1])
const LIGHT = unit([-0.2, 0.55, 1])

const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
const hex = (c: readonly number[]) =>
  `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`

/** A finish: its colour turned fully away from the light, and fully toward it. */
export interface Finish {
  readonly dark: string
  readonly lit: string
}
/** What a machine stands on, set in under it. */
export const UNDERSIDE: Finish = { dark: "#151516", lit: "#4a4b4e" }

/** `color` moved `t` of the way toward white, or toward black when `t` is negative. */
export const tint = (color: string, t: number) =>
  hex(rgb(color).map((v) => (t >= 0 ? v + (255 - v) * t : v * (1 + t))))

export const shade = (finish: Finish, normal: V3) => {
  const t = 0.4 + 0.6 * Math.max(0, dot(unit(normal), LIGHT))
  const [d, l] = [rgb(finish.dark), rgb(finish.lit)]
  return hex(d.map((v, i) => v + ((l[i] ?? v) - v) * t))
}

/** A rounded rectangle's outline, counter-clockwise in its plane, each point with its outward normal. */
export const outline = (w: number, h: number, r: number) => {
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
export interface Plane {
  readonly at: V3
  readonly u: V3
  readonly v: V3
  readonly n: V3
}

export const FLAT: Omit<Plane, "at"> = { u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] }
/** On a front face, looking toward +y. */
export const FRONT: Omit<Plane, "at"> = { u: [1, 0, 0], v: [0, 0, 1], n: [0, 1, 0] }

export const point = (p: Plane, a: number, b: number, t = 0): V3 =>
  add(add(add(p.at, scale(p.u, a)), scale(p.v, b)), scale(p.n, t))

export const path = (points: readonly (readonly [number, number])[]) =>
  `M${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join("L")}Z`

/** What's drawn so far, back to front, and how far it reaches on the page. */
export class Drawing {
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
export const shadow = (drawing: Drawing, w: number, d: number, r: number) => {
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
