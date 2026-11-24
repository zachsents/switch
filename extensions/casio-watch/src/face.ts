/// <reference lib="dom" />

// A Casio Wave Ceptor (WVA-M630D) face, drawn in SVG to the measure of a straight-on
// product photo: a charcoal dial with a guilloché disc, a black chapter ring, lumed steel batons
// (doubled at 12), skeleton hands and the LCD at 6 with the weekday in kanji and the date. Runs as
// an MCP App view; time is the system clock. It speaks the two messages of the MCP Apps handshake
// itself: the SDK's App would add 580 KB for them. Lengths are in a viewBox of -200..200, the
// bezel's outer edge at 200.
const NS = "http://www.w3.org/2000/svg"

const R = {
  bezel: 200,
  step: 193,
  crystal: 185,
  ring: 174,
  dial: 145.5,
  disc: 97,
} as const

type Attrs = Record<string, string | number>

const el = (tag: string, attrs: Attrs = {}, parent?: Element): SVGElement => {
  const e = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) {
    e.setAttribute(k, String(v))
  }
  parent?.append(e)
  return e
}

const polar = (r: number, deg: number) => {
  const a = ((deg - 90) * Math.PI) / 180
  return { x: r * Math.cos(a), y: r * Math.sin(a) }
}

const gradient = (
  defs: Element,
  tag: "linearGradient" | "radialGradient",
  id: string,
  attrs: Attrs,
  stops: readonly (readonly [number, string])[],
) => {
  const g = el(tag, { id, ...attrs }, defs)
  for (const [offset, color] of stops) {
    el("stop", { offset, "stop-color": color }, g)
  }
}

const gradients = (defs: Element) => {
  const diagonal = { x1: 0, y1: 0, x2: 1, y2: 1 }
  gradient(defs, "linearGradient", "steel", diagonal, [
    [0, "#f2f2f0"],
    [0.3, "#a3a4a2"],
    [0.55, "#ececea"],
    [0.8, "#858684"],
    [1, "#cfcfcc"],
  ])
  gradient(defs, "linearGradient", "step", { x1: 1, y1: 1, x2: 0, y2: 0 }, [
    [0, "#f4f4f2"],
    [0.4, "#9c9d9b"],
    [0.7, "#dededb"],
    [1, "#8a8b89"],
  ])
  gradient(defs, "linearGradient", "glass", diagonal, [
    [0, "#9a9da1"],
    [0.5, "#7d8085"],
    [1, "#a9acaf"],
  ])
  gradient(defs, "radialGradient", "dial", { cx: 0.42, cy: 0.38, r: 0.7 }, [
    [0, "#53565e"],
    [0.75, "#484b53"],
    [1, "#3c3f46"],
  ])
  gradient(defs, "radialGradient", "disc", { cx: 0.4, cy: 0.35, r: 0.75 }, [
    [0, "#3f4148"],
    [1, "#34363c"],
  ])
  gradient(defs, "linearGradient", "metal", { x1: 0, y1: 0, x2: 1, y2: 0 }, [
    [0, "#f6f6f3"],
    [0.5, "#d4d5d1"],
    [0.5, "#a9aaa6"],
    [1, "#cfd0cc"],
  ])
  gradient(defs, "linearGradient", "lcd", { x1: 0, y1: 0, x2: 0, y2: 1 }, [
    [0, "#9aa3ab"],
    [0.12, "#c4cdd4"],
    [1, "#bcc5cc"],
  ])
}

/** The polished case: a broad bezel with a step, a dark gasket and the crystal's bevelled edge. */
const bezel = (svg: Element) => {
  el("circle", { r: R.bezel, fill: "url(#steel)" }, svg)
  el("circle", { r: R.step, fill: "#6d6e6c" }, svg)
  el("circle", { r: R.step - 0.8, fill: "url(#step)" }, svg)
  el("circle", { r: R.crystal + 0.8, fill: "#161719" }, svg)
  el("circle", { r: R.crystal - 0.4, fill: "url(#glass)" }, svg)
}

/** The guilloché disc: wavy rings, a raised edge, and the little tab under 12. */
const dial = (svg: Element) => {
  el("circle", { r: R.dial, fill: "url(#dial)" }, svg)
  el("circle", { r: R.disc, fill: "url(#disc)" }, svg)
  let d = ""
  for (let r = 3; r < R.disc - 2; r += 1.15) {
    for (let a = 0; a <= 360; a += 3) {
      const t = (a * Math.PI) / 180
      const w = r + 1.3 * Math.sin(9 * t + r * 0.17) + 0.8 * Math.sin(4 * t - r * 0.09)
      d += `${a === 0 ? "M" : "L"}${(w * Math.sin(t)).toFixed(1)} ${(-w * Math.cos(t)).toFixed(1)}`
    }
  }
  el("path", { d, fill: "none", stroke: "#6a6d75", "stroke-width": 0.3, opacity: 0.45 }, svg)
  el("circle", { r: R.disc + 0.6, fill: "none", stroke: "#2b2d33", "stroke-width": 0.9 }, svg)
  el(
    "circle",
    { r: R.disc - 0.4, fill: "none", stroke: "#70747e", "stroke-width": 0.5, opacity: 0.6 },
    svg,
  )
  el("polygon", { points: "-8,-100 8,-100 5.5,-90.5 -5.5,-90.5", fill: "#2a2d33" }, svg)
}

const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif"

/** Upright on the upper half, turned to read from inside on the lower. */
const ringLabel = (svg: Element, text: string, minute: number) => {
  const deg = minute * 6
  const p = polar(166.5, deg)
  const turn = deg > 100 && deg < 250 ? deg + 180 : deg
  el(
    "text",
    {
      x: p.x,
      y: p.y,
      transform: `rotate(${turn} ${p.x} ${p.y})`,
      "font-family": SANS,
      "font-size": 10.5,
      "font-weight": 500,
      fill: "#dcdee1",
      "text-anchor": "middle",
      "dominant-baseline": "central",
    },
    svg,
  ).textContent = text
}

const tick = (svg: Element, deg: number, inner: number, outer: number, width: number) => {
  const a = polar(inner, deg)
  const b = polar(outer, deg)
  el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: "#e2e4e7", "stroke-width": width }, svg)
}

/** The black chapter ring: a tick a minute, a bar and number every five, W and R, the block at 30. */
const ring = (svg: Element) => {
  el(
    "circle",
    {
      r: (R.ring + R.dial) / 2,
      fill: "none",
      stroke: "#18191d",
      "stroke-width": R.ring - R.dial,
    },
    svg,
  )
  const y = Math.sqrt(R.ring ** 2 - 21.5 ** 2)
  el(
    "path",
    { d: `M-21.5 ${R.dial - 1}H21.5V${y}A${R.ring} ${R.ring} 0 0 1 -21.5 ${y}Z`, fill: "#34363c" },
    svg,
  )
  const letters: Record<number, string> = { 47: "W", 43: "R" }
  for (let m = 0; m < 60; m += 1) {
    const letter = letters[m]
    if (m % 5 === 0) {
      ringLabel(svg, m === 0 ? "60" : String(m).padStart(2, "0"), m)
      tick(svg, m * 6, 148, 157.5, 2.9)
    } else if (letter === undefined) {
      tick(svg, m * 6, 161.5, 170, 1.2)
    } else {
      ringLabel(svg, letter, m)
    }
  }
}

/** One applied baton: a steel frame round a lume insert. */
const baton = (
  svg: Element,
  deg: number,
  inner: number,
  outer: number,
  width: number,
  shift = 0,
) => {
  const g = el("g", { transform: `rotate(${deg})` }, svg)
  const h = outer - inner
  const x = shift - width / 2
  el("rect", { x: x + 0.7, y: -outer + 1, width, height: h, fill: "#111216", opacity: 0.7 }, g)
  el(
    "rect",
    {
      x,
      y: -outer,
      width,
      height: h,
      fill: "url(#metal)",
      stroke: "#3a3c41",
      "stroke-width": 0.6,
    },
    g,
  )
  el(
    "rect",
    { x: x + 1.6, y: -outer + 1.6, width: width - 3.2, height: h - 3.2, fill: "#f4f5f2" },
    g,
  )
}

const indices = (svg: Element) => {
  for (let h = 1; h < 12; h += 1) {
    // The LCD shortens 6 and leaves 5 and 7 as stubs, wider than they're long.
    if (h === 6) {
      baton(svg, 180, 121, 140, 9)
    } else if (h === 5 || h === 7) {
      baton(svg, h * 30, 132, 140.5, 13)
    } else {
      baton(svg, h * 30, 105.5, 140, 11.5)
    }
  }
  // 12's pair stands parallel.
  baton(svg, 0, 105.5, 140, 12.5, -7.8)
  baton(svg, 0, 105.5, 140, 12.5, 7.8)
}

/** A line of print, stretched to the width it has on the dial. */
const print = (svg: Element, text: string, x: number, y: number, size: number, width: number) => {
  const t = el(
    "text",
    {
      x,
      y,
      "font-family": SANS,
      "font-size": size,
      "font-weight": 500,
      fill: "#eceef1",
      textLength: width,
      lengthAdjust: "spacingAndGlyphs",
    },
    svg,
  )
  t.textContent = text
  return t
}

const printing = (svg: Element) => {
  print(svg, "CASIO", -30.5, -65.4, 13.6, 61).setAttribute("font-weight", "700")
  const wave = print(svg, "wave ceptor", -42.5, -55, 10.8, 85)
  wave.setAttribute("font-family", "'Arial Rounded MT Bold', ui-rounded, sans-serif")
  print(svg, "MULTI BAND 6", -46, 40.3, 8, 92)
  print(svg, "TOUGH SOLAR", -35.5, 49.7, 7.4, 71)
  print(svg, "WT", 15.5, 62.8, 8.8, 14)
  print(svg, "RCVD", 40.2, 62.8, 8.8, 30.2)
}

// The LCD's dot matrix, a row to a slash: kanji 7 by 7 dots, figures 5 by 5.
const KANJI: Record<string, string> = {
  日: ".#####./.#...#./.#...#./.#####./.#...#./.#...#./.#####.",
  月: ".#####./.#...#./.#####./.#...#./.#####./.#...#./#...##.",
  火: "...#.../.#.#.#./#..#..#/...#.../..#.#../.#...#./#.....#",
  水: "...#.../...#..#/##.#.#./.#.##../.#.#.#./#..#..#/..##...",
  木: "...#.../#######/...#.../..###../.#.#.#./#..#..#/...#...",
  金: "...#.../..#.#../.#####./...#.../.#####./.#.#.#./#######",
  土: "...#.../...#.../.#####./...#.../...#.../...#.../#######",
}
const DIGITS = [
  "#####/#...#/#...#/#...#/#####",
  "..#../.##../..#../..#../.###.",
  "#####/....#/#####/#..../#####",
  "#####/....#/.####/....#/#####",
  "#...#/#...#/#####/....#/....#",
  "#####/#..../#####/....#/#####",
  "#####/#..../#####/#...#/#####",
  "#####/....#/...#./..#../..#..",
  "#####/#...#/#####/#...#/#####",
  "#####/#...#/#####/....#/#####",
]
const WEEK = ["日", "月", "火", "水", "木", "金", "土"]
const PITCH = { x: 4.8, y: 4.8 }
const DOT = { w: 3.8, h: 4 }
const BOTTOM = 102.9

/** Draws a glyph whose bottom row ends at `BOTTOM`, its left column at `x`. */
const matrix = (g: Element, glyph: string, x: number) => {
  const rows = glyph.split("/")
  const top = BOTTOM - DOT.h - (rows.length - 1) * PITCH.y
  for (const [r, row] of rows.entries()) {
    for (let c = 0; c < row.length; c += 1) {
      if (row[c] === "#") {
        el(
          "rect",
          {
            x: x + c * PITCH.x,
            y: top + r * PITCH.y,
            width: DOT.w,
            height: DOT.h,
            fill: "#1d2a42",
          },
          g,
        )
      }
    }
  }
}

/** A closed path through `[x, y, r]` corners, each rounded off with radius about `r`. */
const rounded = (corners: readonly (readonly [number, number, number])[]) => {
  let d = ""
  for (const [i, [x, y, r]] of corners.entries()) {
    const [px, py] = corners.at(i - 1) ?? [x, y]
    const [nx, ny] = corners[(i + 1) % corners.length] ?? [x, y]
    const toward = (tx: number, ty: number) => {
      const len = Math.hypot(tx - x, ty - y)
      const k = Math.min(r, len / 2) / len
      return `${x + (tx - x) * k} ${y + (ty - y) * k}`
    }
    d += `${i === 0 ? "M" : "L"}${toward(px, py)}Q${x} ${y} ${toward(nx, ny)}`
  }
  return `${d}Z`
}

/** The LCD window at 6, returning what draws its weekday and date. */
const lcd = (svg: Element) => {
  // Its top steps down under WT RCVD; its ends are rounded, the bottom corners deepest.
  const window = rounded([
    [-74, 62.5, 7],
    [0, 62.5, 2],
    [7, 66.5, 2],
    [75, 66.5, 6],
    [83, 74, 4],
    [83, 99, 6],
    [69, 113.5, 6],
    [-69, 113.5, 6],
    [-82, 99, 6],
    [-82, 71, 6],
  ])
  el(
    "path",
    {
      d: window,
      fill: "#2a2c31",
      stroke: "#2a2c31",
      "stroke-width": 4.5,
      "stroke-linejoin": "round",
    },
    svg,
  )
  el("path", { d: window, fill: "url(#lcd)", stroke: "#a4adb4", "stroke-width": 1 }, svg)
  const digits = el("g", {}, svg)
  return (now: Date) => {
    digits.replaceChildren()
    matrix(digits, KANJI[WEEK[now.getDay()] ?? "日"] ?? "", -65.7)
    const date = String(now.getDate())
    // Figures are right-aligned, a figure's width and a dot's gap apart.
    const right = 60 - DOT.w - 4 * PITCH.x
    for (const [i, d] of date.split("").entries()) {
      matrix(digits, DIGITS[Number(d)] ?? "", right - (date.length - 1 - i) * 6 * PITCH.x)
    }
  }
}

/** A shape symmetric about the y axis, from its right half. */
const outline = (half: [number, number][]) =>
  `M${[...half, ...half.toReversed().map(([x, y]): [number, number] => [-x, y])].map(([x, y]) => `${x} ${y}`).join("L")}Z`

/**
 * A skeleton hand pointing up: a steel frame round a lume blade `length` to its point, `base` wide
 * near the hub and `tip` wide where its point begins, and a lumed tail `tail` behind the pivot.
 */
const hand = (
  svg: Element,
  length: number,
  base: number,
  tip: number,
  tail: number,
  tailWidth: number,
) => {
  const g = el("g", {}, svg)
  const t = tailWidth / 2
  const shape = outline([
    [t, tail],
    [t, 9],
    [base * 0.36, 6],
    [base * 0.36, -9],
    [base / 2, -13],
    [tip / 2, 9 - length],
    [0, -length],
  ])
  el("path", { d: shape, fill: "#000", opacity: 0.4, transform: "translate(1.4 2)" }, g)
  el(
    "path",
    { d: shape, fill: "#b7b9b8", stroke: "#1f2125", "stroke-width": 1, "stroke-linejoin": "round" },
    g,
  )
  // The frame's lit side.
  el(
    "path",
    { d: `M0 -13L${-base / 2} -13L${-tip / 2} ${9 - length}L0 ${-length}Z`, fill: "#e4e5e2" },
    g,
  )
  const lume = (s: [number, number][]) =>
    el("path", { d: outline(s), fill: "#eff0ec", stroke: "#9b9e9c", "stroke-width": 0.35 }, g)
  lume([
    [base / 2 - 1.3, -15],
    [tip / 2 - 1.2, 9.5 - length],
    [0, 3.2 - length],
  ])
  // Round the pivot, and the tail's frame, the steel is blackened.
  el(
    "path",
    {
      d: outline([
        [t, tail],
        [t, 9],
        [base * 0.36, 6],
        [base * 0.36, -9],
        [base / 2, -13],
        [base / 2 - 0.1, -15],
      ]),
      fill: "#2a2c30",
    },
    g,
  )
  lume([
    [t - 2, tail - 2.2],
    [t - 2, 13],
  ])
  return g
}

const second = (svg: Element) => {
  const g = el("g", {}, svg)
  const shape = "M-0.45 -136L0.45 -136L0.9 0L1.2 17L1.2 41L-1.2 41L-1.2 17L-0.9 0Z"
  el("path", { d: shape, fill: "#000", opacity: 0.3, transform: "translate(1.2 1.8)" }, g)
  el("path", { d: shape, fill: "#eceeed" }, g)
  // The counterweight: a lumed slug behind the pivot.
  el(
    "rect",
    {
      x: -3,
      y: 17,
      width: 6,
      height: 24,
      rx: 3,
      fill: "#e9ebe8",
      stroke: "#26282c",
      "stroke-width": 1.1,
    },
    g,
  )
  return g
}

const draw = () => {
  const svg = el("svg", { viewBox: "-200 -200 400 400", role: "img" })
  gradients(el("defs", {}, svg))
  bezel(svg)
  dial(svg)
  ring(svg)
  printing(svg)
  const showDate = lcd(svg)
  indices(svg)
  // The hour hand stops short of the batons; the minute hand reaches into them.
  const hour = hand(svg, 92, 10.5, 9, 35, 10)
  const minute = hand(svg, 131, 9, 7.5, 40, 11)
  const sec = second(svg)
  el("circle", { r: 7.5, fill: "#222428" }, svg)
  el("circle", { r: 3.8, fill: "#c4c6c5", stroke: "#6e706f", "stroke-width": 0.5 }, svg)
  el("circle", { r: 1.6, fill: "#3a3c3e" }, svg)
  document.body.append(svg)

  let shown = ""
  let last = -1
  const frame = () => {
    const now = new Date()
    const s = now.getSeconds()
    const m = now.getMinutes() + s / 60 + now.getMilliseconds() / 60_000
    const h = (now.getHours() % 12) + m / 60
    hour.setAttribute("transform", `rotate(${h * 30})`)
    minute.setAttribute("transform", `rotate(${m * 6})`)
    // The real hand steps once a second.
    if (s !== last) {
      last = s
      sec.setAttribute("transform", `rotate(${s * 6})`)
    }
    const day = now.toDateString()
    if (day !== shown) {
      shown = day
      showDate(now)
    }
  }
  frame()
  const loop = () => {
    frame()
    setTimeout(loop, 250 - (Date.now() % 250))
  }
  loop()
}

draw()

// MCP Apps' handshake: ask to initialize, then say so once the host answers.
const PROTOCOL = "2026-01-26"
window.addEventListener("message", (e: MessageEvent<{ id?: unknown; result?: unknown }>) => {
  if (e.source === window.parent && e.data.id === 1 && e.data.result !== undefined) {
    window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*")
  }
})
window.parent.postMessage(
  {
    jsonrpc: "2.0",
    id: 1,
    method: "ui/initialize",
    params: {
      appInfo: { name: "watch", version: "1" },
      appCapabilities: {},
      protocolVersion: PROTOCOL,
    },
  },
  "*",
)
