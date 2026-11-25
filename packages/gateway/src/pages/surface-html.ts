// A surface the agent made, as a page's static HTML: no script, so every part is drawn here, once,
// from its components and data model. Inputs draw as their label and value, Tabs as every tab in
// turn, a Modal as its content, charts as inline SVG. A part this doesn't know draws nothing.
import { SWITCH_CATALOG } from "switch-ext-kit"
import { withMath } from "../math/html.ts"

type Props = Readonly<Record<string, unknown>>

/** What a part reads its properties and children through, at its place in the data model. */
interface Scope {
  /** A property's value, its binding or call worked out. */
  readonly value: (v: unknown) => unknown
  readonly text: (v: unknown) => string
  readonly child: (id: unknown) => string
  readonly children: (list: unknown) => readonly string[]
  readonly media: (url: string) => string | null
}

type Part = (p: Props, s: Scope) => string

interface Surface {
  readonly components: ReadonlyMap<string, Props>
  readonly data: unknown
  readonly catalog: string
  readonly media: (url: string) => string | null
}

/** Deepest a component nests before the rest is left out. */
const DEPTH = 32
/** A chart's drawing width, in its own units; it scales to the page's. */
const W = 480
const HEIGHT = 200
const BAR = 24
const SMALL = 11
const LOCALE = "en-US"

// ---- Reading

const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v))
    : {}

const listOf = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : [])

const numberOf = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null)

const stringOf = (v: unknown) => (typeof v === "string" ? v : "")

/** A value as words: a number or flag as itself, anything else nothing. */
const wordsOf = (v: unknown) => {
  if (typeof v === "string") {
    return v
  }
  if (typeof v === "number" || typeof v === "boolean") {
    return String(v)
  }
  return ""
}

const esc = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

/** A path against the item it's read in: absolute as given, else under the item's. */
const absolute = (path: string, base: string) => {
  if (path.startsWith("/")) {
    return path
  }
  if (base === "" || base === "/") {
    return `/${path}`
  }
  return base.endsWith("/") ? `${base}${path}` : `${base}/${path}`
}

/** What's at a JSON Pointer in the data, or nothing. */
const at = (data: unknown, path: string): unknown => {
  if (path === "" || path === "/") {
    return data
  }
  let here = data
  for (const raw of path.split("/").slice(1)) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~")
    if (Array.isArray(here)) {
      here = /^\d+$/u.test(key) ? here[Number(key)] : undefined
    } else if (typeof here === "object" && here !== null && Object.hasOwn(here, key)) {
      here = Reflect.get(here, key)
    } else {
      return undefined
    }
  }
  return here
}

// ---- A2UI's basic functions, the ones that make a value

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

const two = (n: number) => String(n).padStart(2, "0")

/** A date and time from epoch ms or ISO words, in UTC; none when it can't be read. */
const dateTimeOf = (v: unknown) => {
  const ms = numberOf(v)
  if (ms !== null) {
    return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO("UTC").toPlainDateTime()
  }
  const words = stringOf(v)
  if (words === "") {
    return null
  }
  try {
    return Temporal.Instant.from(words).toZonedDateTimeISO("UTC").toPlainDateTime()
  } catch {
    try {
      return Temporal.PlainDateTime.from(words)
    } catch {
      return null
    }
  }
}

/** One TR35 field of a date ("MMM", "dd", "h"), or the token itself. */
const fieldOf = (d: Temporal.PlainDateTime, token: string) => {
  const hour12 = d.hour % 12 === 0 ? 12 : d.hour % 12
  const month = MONTHS[d.month - 1] ?? ""
  const day = DAYS[d.dayOfWeek - 1] ?? ""
  const fields: Record<string, string> = {
    yyyy: String(d.year),
    yy: two(d.year % 100),
    y: String(d.year),
    MMMM: month,
    MMM: month.slice(0, 3),
    MM: two(d.month),
    M: String(d.month),
    dd: two(d.day),
    d: String(d.day),
    EEEE: day,
    EEE: day.slice(0, 3),
    EE: day.slice(0, 3),
    E: day.slice(0, 3),
    HH: two(d.hour),
    H: String(d.hour),
    hh: two(hour12),
    h: String(hour12),
    mm: two(d.minute),
    m: String(d.minute),
    ss: two(d.second),
    s: String(d.second),
    a: d.hour < 12 ? "AM" : "PM",
  }
  return fields[token] ?? token
}

const formatDate = (v: unknown, pattern: string) => {
  const d = dateTimeOf(v)
  if (d === null) {
    return ""
  }
  let out = ""
  let i = 0
  while (i < pattern.length) {
    const c = pattern.charAt(i)
    if (c === "'") {
      const end = pattern.indexOf("'", i + 1)
      const stop = end === -1 ? pattern.length : end
      out += stop === i + 1 ? "'" : pattern.slice(i + 1, stop)
      i = stop + 1
    } else if (/[a-zA-Z]/u.test(c)) {
      let j = i
      while (pattern.charAt(j) === c) {
        j += 1
      }
      out += fieldOf(d, pattern.slice(i, j))
      i = j
    } else {
      out += c
      i += 1
    }
  }
  return out
}

const formatNumber = (args: Record<string, unknown>, currency?: string) => {
  const value = numberOf(args.value)
  if (value === null) {
    return ""
  }
  const decimals = numberOf(args.decimals)
  const options: Intl.NumberFormatOptions = { useGrouping: args.grouping !== false }
  if (decimals !== null) {
    options.minimumFractionDigits = Math.max(0, Math.min(20, decimals))
    options.maximumFractionDigits = Math.max(0, Math.min(20, decimals))
  }
  if (currency !== undefined) {
    options.style = "currency"
    options.currency = currency
  }
  try {
    return new Intl.NumberFormat(LOCALE, options).format(value)
  } catch {
    return String(value)
  }
}

const pluralize = (args: Record<string, unknown>) => {
  const value = numberOf(args.value) ?? 0
  if (value === 0 && typeof args.zero === "string") {
    return args.zero
  }
  const category = new Intl.PluralRules(LOCALE).select(value)
  const words = args[category]
  return typeof words === "string" ? words : stringOf(args.other)
}

/** The `}` closing the `${` whose inside starts at `from`, or -1. */
const closing = (s: string, from: number) => {
  let depth = 1
  for (let i = from; i < s.length; i += 1) {
    const c = s.charAt(i)
    if (c === "{") {
      depth += 1
    } else if (c === "}") {
      depth -= 1
      if (depth === 0) {
        return i
      }
    }
  }
  return -1
}

/** A call's arguments split at its top-level commas. */
const argumentsOf = (s: string) => {
  const parts: string[] = []
  let depth = 0
  let quoted = false
  let start = 0
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charAt(i)
    if (c === "'") {
      quoted = !quoted
    } else if (!quoted && (c === "{" || c === "(")) {
      depth += 1
    } else if (!quoted && (c === "}" || c === ")")) {
      depth -= 1
    } else if (!quoted && depth === 0 && c === ",") {
      parts.push(s.slice(start, i))
      start = i + 1
    }
  }
  parts.push(s.slice(start))
  return parts.map((p) => p.trim()).filter((p) => p !== "")
}

const call = (name: string, args: Record<string, unknown>): unknown => {
  switch (name) {
    case "formatNumber": {
      return formatNumber(args)
    }
    case "formatCurrency": {
      return formatNumber(args, stringOf(args.currency))
    }
    case "formatDate": {
      return formatDate(args.value, stringOf(args.format))
    }
    case "pluralize": {
      return pluralize(args)
    }
    case "and": {
      return listOf(args.values).every((v) => v === true)
    }
    case "or": {
      return listOf(args.values).some((v) => v === true)
    }
    case "not": {
      return args.value !== true
    }
    case "now": {
      return Temporal.Now.instant().toString()
    }
    default: {
      return undefined
    }
  }
}

// ---- The surface

const BASE = "https://relative.invalid/"

/** A link's href when it's a web, mail, in-page or relative one; else none. */
const safeHref = (href: string) => {
  const url = URL.parse(href, BASE)
  if (url === null) {
    return null
  }
  return ["http:", "https:", "mailto:"].includes(url.protocol) ? href : null
}

const decodeEntities = (s: string) =>
  s
    .replaceAll(/&#x(?<hex>[0-9a-f]+);/giu, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replaceAll(/&#(?<dec>\d+);/gu, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")

/** Markdown as HTML: no HTML of its own, links only safe ones, pictures through `media`. */
const markdownHtml = (text: string, media: (url: string) => string | null) =>
  withMath(text, (markdown) =>
    Bun.markdown.html(markdown, { noHtmlBlocks: true, noHtmlSpans: true, autolinks: true }),
  )
    .html.replaceAll(/<a href="(?<href>[^"]*)"/gu, (_, href: string) => {
      const safe = safeHref(decodeEntities(href))
      return safe === null ? "<a" : `<a href="${esc(safe)}" rel="noreferrer"`
    })
    .replaceAll(/<img\b[^>]*>/gu, (tag) => {
      const src = /\ssrc="(?<src>[^"]*)"/u.exec(tag)?.groups?.src
      const alt = /\salt="(?<alt>[^"]*)"/u.exec(tag)?.groups?.alt ?? ""
      const url = src === undefined ? null : media(decodeEntities(src))
      return url === null ? "" : `<img src="${esc(url)}" alt="${alt}">`
    })

// ---- Numbers as a chart reads them

interface Figures {
  readonly prefix: string
  readonly suffix: string
}

const figuresOf = (p: Props): Figures => ({
  prefix: stringOf(p.prefix),
  suffix: stringOf(p.suffix),
})

const whole = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 })
const short = new Intl.NumberFormat(LOCALE, { notation: "compact", maximumFractionDigits: 1 })

const read = (v: number, f: Figures, format: Intl.NumberFormat) =>
  `${v < 0 ? "-" : ""}${f.prefix}${format.format(Math.abs(v))}${f.suffix}`

/** A value in full: "-$1,284.5". */
const figure = (v: number, f: Figures) => read(v, f, whole)
/** An axis's tick, compact from 1,000. */
const tick = (v: number, f: Figures) => read(v, f, Math.abs(v) >= 1000 ? short : whole)
/** A figure standing alone, compact from 10,000. */
const headline = (v: number, f: Figures) => read(v, f, Math.abs(v) >= 10_000 ? short : whole)
const percent = (part: number) => `${Math.round(part * 100)}%`

/** How wide small words draw, in a chart's units. */
const widthOf = (text: string) => Math.ceil(text.length * SMALL * 0.6)

/** A coordinate to a tenth. */
const n = (v: number) => String(Math.round(v * 10) / 10)

// A value axis: round steps (1, 2, 2.5 or 5 times a power of ten) from below the least to above the
// most, about four apart; bars, areas and counts keep zero in it.
const FACTORS = [1, 2, 2.5, 5, 10]

const roundStep = (raw: number, wholeStep = false) => {
  const power = 10 ** Math.floor(Math.log10(raw))
  const step = (FACTORS.find((f) => f * power >= raw * (1 - 1e-9)) ?? 10) * power
  if (!wholeStep) {
    return step
  }
  if (step < 1) {
    return 1
  }
  return Number.isInteger(step) ? step : step * 2
}

const clean = (v: number) => Number(v.toPrecision(12))

interface Scale {
  readonly lo: number
  readonly hi: number
  readonly ticks: readonly number[]
}

const scaleOf = (min: number, max: number, zero: boolean, wholeStep = false): Scale => {
  let lo = zero ? Math.min(0, min) : min
  let hi = zero ? Math.max(0, max) : max
  if (hi - lo <= 0) {
    lo -= lo === 0 ? 0 : 1
    hi += 1
  }
  const step = roundStep((hi - lo) / 4, wholeStep)
  const from = Math.floor(lo / step + 1e-9)
  const to = Math.ceil(hi / step - 1e-9)
  const ticks = Array.from({ length: to - from + 1 }, (_, k) => clean((from + k) * step))
  return { lo: clean(from * step), hi: clean(to * step), ticks }
}

const extentOf = (values: Iterable<number | null>) => {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const v of values) {
    if (v !== null) {
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
  }
  return min <= max ? { min, max } : null
}

/** Where a value falls between two ends. */
const place = (v: number, lo: number, hi: number, from: number, to: number) =>
  hi === lo ? (from + to) / 2 : from + ((v - lo) / (hi - lo)) * (to - from)

// ---- Chart pieces

const color = (k: number) => `var(--s${(k % 8) + 1})`

interface Named {
  readonly name: string
  readonly values: readonly (number | null)[]
}

const seriesOf = (v: unknown, length: number): readonly Named[] =>
  listOf(v)
    .slice(0, 8)
    .flatMap((s) => {
      const r = record(s)
      if (typeof r.name !== "string" || !Array.isArray(r.values)) {
        return []
      }
      const values = Array.from({ length }, (_, i) => numberOf(listOf(r.values)[i]))
      return [{ name: r.name, values }]
    })

const labelsOf = (v: unknown) => listOf(v).map((l) => wordsOf(l))

const svg = (height: number, body: string, width = W) =>
  `<svg class="s-chart" viewBox="0 0 ${n(width)} ${n(height)}" aria-hidden="true">${body}</svg>`

const words = (x: number, y: number, text: string, anchor: string, cls = "s-tick") =>
  `<text class="${cls}" x="${n(x)}" y="${n(y)}" text-anchor="${anchor}" dominant-baseline="middle">${esc(text)}</text>`

const hline = (x1: number, x2: number, y: number, cls: string) =>
  `<line class="${cls}" x1="${n(x1)}" x2="${n(x2)}" y1="${n(y)}" y2="${n(y)}"/>`

const vline = (x: number, y1: number, y2: number, cls: string) =>
  `<line class="${cls}" x1="${n(x)}" x2="${n(x)}" y1="${n(y1)}" y2="${n(y2)}"/>`

const rect = (x: number, y: number, w: number, h: number, fill: string, extra = "") =>
  `<rect x="${n(x)}" y="${n(y)}" width="${n(Math.max(0, w))}" height="${n(Math.max(0, h))}" fill="${fill}"${extra}/>`

/** A legend over a chart, for two series or more. */
const legend = (names: readonly string[], round = false) =>
  names.length < 2
    ? ""
    : `<ul class="s-legend">${names
        .map(
          (name, k) =>
            `<li><span class="s-key s-c${(k % 8) + 1}${round ? " s-round" : ""}"></span>${esc(name)}</li>`,
        )
        .join("")}</ul>`

const figureBox = (body: string) => `<div class="s-figure">${body}</div>`

/** Every how-many-th label fits along a run. */
const everyOf = (labels: readonly string[], room: number) => {
  let most = 0
  for (const l of labels) {
    most = Math.max(most, widthOf(l))
  }
  const fit = Math.max(1, Math.floor(room / (most + 8)))
  return Math.max(1, Math.ceil(labels.length / fit))
}

/** A value axis down the left: its gridlines and ticks, and where the plot sits beside it. */
const valueAxis = (scale: Scale, f: Figures, top: number, bottom: number) => {
  let left = 0
  for (const t of scale.ticks) {
    left = Math.max(left, widthOf(tick(t, f)))
  }
  left += 8
  const y = (v: number) => place(v, scale.lo, scale.hi, bottom, top)
  const grid = scale.ticks
    .map((t) => hline(left, W, y(t), "s-grid") + words(left - 6, y(t), tick(t, f), "end"))
    .join("")
  return { left, y, grid }
}

/** Labels along the bottom, as many as fit. */
const labelAxis = (
  labels: readonly string[],
  x: (i: number) => number,
  room: number,
  y: number,
) => {
  const every = everyOf(labels, room)
  return labels.map((l, i) => (i % every === 0 ? words(x(i), y, l, "middle") : "")).join("")
}

// ---- Charts

const barChart: Part = (p, s) => {
  const labels = labelsOf(s.value(p.labels))
  const series = seriesOf(s.value(p.series), labels.length)
  if (labels.length === 0 || series.length === 0) {
    return ""
  }
  const f = figuresOf(p)
  const stacked = p.stacked === true
  const sums = labels.map((_, i) => {
    let up = 0
    let down = 0
    for (const ser of series) {
      const v = ser.values[i] ?? 0
      if (v >= 0) {
        up += v
      } else {
        down += v
      }
    }
    return { up, down }
  })
  const extent = stacked
    ? extentOf(sums.flatMap((t) => [t.up, t.down]))
    : extentOf(series.flatMap((ser) => ser.values))
  if (extent === null) {
    return ""
  }
  const scale = scaleOf(extent.min, extent.max, true)
  const body =
    p.horizontal === true
      ? barRows(labels, series, scale, f, stacked)
      : barColumns(p, labels, series, scale, f, stacked, sums)
  return figureBox(legend(series.map((ser) => ser.name)) + body)
}

const barColumns = (
  p: Props,
  labels: readonly string[],
  series: readonly Named[],
  scale: Scale,
  f: Figures,
  stacked: boolean,
  sums: readonly { readonly up: number; readonly down: number }[],
) => {
  const height = numberOf(p.height) ?? HEIGHT
  const peak = stacked || series.length === 1
  const top = peak ? 18 : 8
  const bottom = height - 20
  const axis = valueAxis(scale, f, top, bottom)
  const band = (W - axis.left) / labels.length
  const center = (i: number) => axis.left + band * (i + 0.5)
  const k = series.length
  const thick = stacked ? Math.min(BAR, band * 0.7) : Math.min(BAR, (band * 0.8 - 2 * (k - 1)) / k)
  const zero = axis.y(0)
  let bars = ""
  for (const [i] of labels.entries()) {
    let up = 0
    let down = 0
    for (const [j, ser] of series.entries()) {
      const v = ser.values[i]
      if (v !== null && v !== undefined) {
        let from = 0
        let x = center(i) - thick / 2
        if (stacked) {
          from = v >= 0 ? up : down
          if (v >= 0) {
            up += v
          } else {
            down += v
          }
        } else {
          x = center(i) - (k * thick + 2 * (k - 1)) / 2 + j * (thick + 2)
        }
        const y1 = axis.y(from + v)
        const y0 = axis.y(from)
        bars += rect(x, Math.min(y0, y1), thick, Math.abs(y0 - y1), color(j))
      }
    }
  }
  let peakText = ""
  if (peak) {
    let best = 0
    for (const [i, t] of sums.entries()) {
      if (t.up > (sums[best]?.up ?? 0)) {
        best = i
      }
    }
    const most = sums[best]?.up ?? 0
    if (most > 0) {
      peakText = words(center(best), axis.y(most) - 8, figure(most, f), "middle", "s-label")
    }
  }
  return svg(
    height,
    axis.grid +
      bars +
      hline(axis.left, W, zero, "s-base") +
      labelAxis(labels, center, W - axis.left, height - 8) +
      peakText,
  )
}

const barRows = (
  labels: readonly string[],
  series: readonly Named[],
  scale: Scale,
  f: Figures,
  stacked: boolean,
) => {
  const k = series.length
  const thick = stacked || k === 1 ? 16 : 10
  const band = stacked ? 24 : k * (thick + 2) + 10
  let left = 0
  for (const l of labels) {
    left = Math.max(left, widthOf(l))
  }
  left = Math.min(left, W / 3) + 8
  const top = 4
  const height = top + labels.length * band + 20
  const bottom = height - 20
  const x = (v: number) => place(v, scale.lo, scale.hi, left, W - 8)
  let body = scale.ticks
    .map((t) => vline(x(t), top, bottom, "s-grid") + words(x(t), height - 8, tick(t, f), "middle"))
    .join("")
  for (const [i, label] of labels.entries()) {
    const middle = top + band * (i + 0.5)
    body += words(
      left - 6,
      middle,
      label.length * SMALL * 0.6 > left
        ? `${label.slice(0, Math.floor(left / (SMALL * 0.6)) - 1)}…`
        : label,
      "end",
    )
    let up = 0
    let down = 0
    for (const [j, ser] of series.entries()) {
      const v = ser.values[i]
      if (v !== null && v !== undefined) {
        let from = 0
        let y = middle - thick / 2
        if (stacked) {
          from = v >= 0 ? up : down
          if (v >= 0) {
            up += v
          } else {
            down += v
          }
        } else {
          y = middle - (k * thick + 2 * (k - 1)) / 2 + j * (thick + 2)
        }
        const x0 = x(from)
        const x1 = x(from + v)
        body += rect(Math.min(x0, x1), y, Math.abs(x1 - x0), thick, color(j))
      }
    }
  }
  return svg(height, body + vline(x(0), top, bottom, "s-base"))
}

/** A line through values, broken where one is missing. */
const pathOf = (points: readonly (readonly [number, number] | null)[]) => {
  let d = ""
  let pen = false
  for (const pt of points) {
    if (pt === null) {
      pen = false
    } else {
      d += `${pen ? "L" : "M"}${n(pt[0])} ${n(pt[1])}`
      pen = true
    }
  }
  return d
}

/** Points alone, with no neighbor to draw a line to: a dot each. */
const lonely = (points: readonly (readonly [number, number] | null)[], fill: string) =>
  points
    .map((pt, i) =>
      pt !== null && (points[i - 1] ?? null) === null && (points[i + 1] ?? null) === null
        ? `<circle cx="${n(pt[0])}" cy="${n(pt[1])}" r="3" fill="${fill}"/>`
        : "",
    )
    .join("")

const lineChart =
  (area: boolean): Part =>
  (p, s) => {
    const labels = labelsOf(s.value(p.labels))
    const series = seriesOf(s.value(p.series), labels.length)
    if (labels.length === 0 || series.length === 0) {
      return ""
    }
    const f = figuresOf(p)
    const stacked = area && p.stacked === true
    // Stacked areas draw each series on the ones before it.
    const tops = series.map((ser, k) =>
      ser.values.map((v, i) => {
        if (!stacked || v === null) {
          return v
        }
        let sum = 0
        for (const before of series.slice(0, k + 1)) {
          sum += before.values[i] ?? 0
        }
        return sum
      }),
    )
    const extent = extentOf(tops.flat())
    if (extent === null) {
      return ""
    }
    const scale = scaleOf(extent.min, extent.max, area)
    const height = numberOf(p.height) ?? HEIGHT
    const axis = valueAxis(scale, f, 8, height - 20)
    const room = W - axis.left - 8
    const x = (i: number) =>
      labels.length === 1
        ? axis.left + room / 2
        : axis.left + 4 + (i * (room - 4)) / (labels.length - 1)
    let marks = ""
    for (const [k, values] of tops.entries()) {
      const points = values.map((v, i): readonly [number, number] | null =>
        v === null ? null : [x(i), axis.y(v)],
      )
      if (area) {
        const under = stacked && k > 0 ? (tops[k - 1] ?? []) : values.map(() => 0)
        let wash = ""
        for (const [i, pt] of points.entries()) {
          const next = points[i + 1]
          if (pt !== null && next !== null && next !== undefined) {
            const b0 = axis.y(under[i] ?? 0)
            const b1 = axis.y(under[i + 1] ?? 0)
            wash += `M${n(pt[0])} ${n(pt[1])}L${n(next[0])} ${n(next[1])}L${n(next[0])} ${n(b1)}L${n(pt[0])} ${n(b0)}Z`
          }
        }
        marks += `<path d="${wash}" fill="${color(k)}" fill-opacity="0.15"/>`
      }
      marks += `<path class="s-stroke" d="${pathOf(points)}" stroke="${color(k)}"/>${lonely(points, color(k))}`
    }
    return figureBox(
      legend(series.map((ser) => ser.name)) +
        svg(
          height,
          axis.grid +
            (area ? hline(axis.left, W, axis.y(Math.max(0, scale.lo)), "s-base") : "") +
            marks +
            labelAxis(labels, x, room, height - 8),
        ),
    )
  }

const sparkline: Part = (p, s) => {
  const values = listOf(s.value(p.values)).flatMap((v) => {
    const num = numberOf(v)
    return num === null ? [] : [num]
  })
  const extent = extentOf(values)
  if (extent === null) {
    return ""
  }
  const height = numberOf(p.height) ?? 24
  const x = (i: number) => (values.length === 1 ? W / 2 : 2 + (i * (W - 4)) / (values.length - 1))
  const y = (v: number) => place(v, extent.min, extent.max, height - 2, 2)
  const points = values.map((v, i): readonly [number, number] => [x(i), y(v)])
  return `<div class="s-line"><svg class="s-spark" viewBox="0 0 ${W} ${n(height)}" height="${n(height)}" preserveAspectRatio="none" aria-hidden="true"><path class="s-stroke" vector-effect="non-scaling-stroke" d="${pathOf(points)}" stroke="var(--s1)"/></svg></div>`
}

/** An arc of a ring from one angle to another, in turns from the top, clockwise. */
const arc = (c: number, r: number, from: number, to: number) => {
  const point = (t: number) => [
    c + r * Math.sin(t * 2 * Math.PI),
    c - r * Math.cos(t * 2 * Math.PI),
  ]
  const [x0 = 0, y0 = 0] = point(from)
  const [x1 = 0, y1 = 0] = point(to)
  return `M${n(x0)} ${n(y0)}A${r} ${r} 0 ${to - from > 0.5 ? 1 : 0} 1 ${n(x1)} ${n(y1)}`
}

const donutChart: Part = (p, s) => {
  const all = listOf(s.value(p.slices)).flatMap((v) => {
    const r = record(v)
    const value = numberOf(r.value)
    return typeof r.label === "string" && value !== null && value > 0
      ? [{ label: r.label, value }]
      : []
  })
  if (all.length === 0) {
    return ""
  }
  // Past six, the rest fold into Other.
  const slices = all.slice(0, all.length > 6 ? 5 : 6)
  if (all.length > 6) {
    let rest = 0
    for (const sl of all.slice(5)) {
      rest += sl.value
    }
    slices.push({ label: "Other", value: rest })
  }
  let total = 0
  for (const sl of slices) {
    total += sl.value
  }
  const f = figuresOf(p)
  const size = 140
  const r = 61
  let from = 0
  let ring = ""
  for (const [k, sl] of slices.entries()) {
    const share = sl.value / total
    const fill = all.length > 6 && k === 5 ? "var(--muted)" : color(k)
    ring +=
      share >= 0.9999
        ? `<circle cx="70" cy="70" r="${r}" fill="none" stroke="${fill}" stroke-width="17"/>`
        : `<path d="${arc(size / 2, r, from, from + share)}" fill="none" stroke="${fill}" stroke-width="17"/>`
    from += share
  }
  const rows = slices
    .map(
      (sl, k) =>
        `<li><span class="s-key ${all.length > 6 && k === 5 ? "s-cm" : `s-c${k + 1}`}"></span><span class="s-name">${esc(sl.label)}</span><span class="s-data">${esc(figure(sl.value, f))}</span><span class="s-data">${percent(sl.value / total)}</span></li>`,
    )
    .join("")
  return `<div class="s-donut"><svg class="s-ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">${ring}<text class="s-total" x="70" y="70" text-anchor="middle" dominant-baseline="middle">${esc(headline(total, f))}</text></svg><ul class="s-slices">${rows}</ul></div>`
}

const scatterChart: Part = (p, s) => {
  const series = listOf(s.value(p.series))
    .slice(0, 3)
    .flatMap((v) => {
      const r = record(v)
      if (typeof r.name !== "string") {
        return []
      }
      const points = listOf(r.points).flatMap((pt) => {
        const px = numberOf(listOf(pt)[0])
        const py = numberOf(listOf(pt)[1])
        return px === null || py === null ? [] : [[px, py] as const]
      })
      return [{ name: r.name, points }]
    })
  const xs = extentOf(series.flatMap((ser) => ser.points.map((pt) => pt[0])))
  const ys = extentOf(series.flatMap((ser) => ser.points.map((pt) => pt[1])))
  if (xs === null || ys === null) {
    return ""
  }
  const xLabel = stringOf(p.xLabel)
  const yLabel = stringOf(p.yLabel)
  const height = numberOf(p.height) ?? HEIGHT
  const bare = { prefix: "", suffix: "" }
  const xScale = scaleOf(xs.min, xs.max, false)
  const yScale = scaleOf(ys.min, ys.max, false)
  const top = yLabel === "" ? 8 : 20
  const bottom = height - (xLabel === "" ? 20 : 32)
  const axis = valueAxis(yScale, bare, top, bottom)
  const x = (v: number) => place(v, xScale.lo, xScale.hi, axis.left + 4, W - 8)
  let body = axis.grid + hline(axis.left, W, bottom, "s-base")
  body += xScale.ticks.map((t) => words(x(t), bottom + 12, tick(t, bare), "middle")).join("")
  if (yLabel !== "") {
    body += words(axis.left, 6, yLabel, "start", "s-label")
  }
  if (xLabel !== "") {
    body += words(W - 8, height - 6, xLabel, "end", "s-label")
  }
  for (const [k, ser] of series.entries()) {
    for (const [px, py] of ser.points) {
      body += `<circle cx="${n(x(px))}" cy="${n(axis.y(py))}" r="3.5" fill="${color(k)}"/>`
    }
  }
  return figureBox(
    legend(
      series.map((ser) => ser.name),
      true,
    ) + svg(height, body),
  )
}

interface Bin {
  readonly lo: number
  readonly hi: number
  readonly count: number
}

/** Raw values counted into bins of equal width at round edges: `bins` of them, else Sturges'. */
const binsOf = (values: readonly number[], given: number | null): readonly Bin[] => {
  const extent = extentOf(values)
  if (extent === null) {
    return []
  }
  const { min, max } = extent
  if (min === max) {
    return [{ lo: min - 0.5, hi: max + 0.5, count: values.length }]
  }
  const count = given ?? Math.ceil(Math.log2(values.length)) + 1
  let step = roundStep((max - min) / count)
  let lo = Math.floor(min / step) * step
  if (given !== null) {
    while (lo + given * step < max) {
      step = roundStep(step * (1 + 1e-6))
      lo = Math.floor(min / step) * step
    }
  }
  const length = given ?? Math.max(1, Math.ceil((max - lo) / step))
  const counts = Array.from({ length }, () => 0)
  for (const v of values) {
    const k = Math.min(length - 1, Math.floor((v - lo) / step))
    counts[k] = (counts[k] ?? 0) + 1
  }
  return counts.map((c, k) => ({
    lo: clean(lo + k * step),
    hi: clean(lo + (k + 1) * step),
    count: c,
  }))
}

const histogram: Part = (p, s) => {
  const values = listOf(s.value(p.values)).flatMap((v) => {
    const num = numberOf(v)
    return num === null ? [] : [num]
  })
  const given = numberOf(p.bins)
  const bins = binsOf(values, given !== null && given >= 1 ? Math.round(given) : null)
  const [first] = bins
  const last = bins.at(-1)
  if (first === undefined || last === undefined) {
    return ""
  }
  let most = 0
  for (const b of bins) {
    most = Math.max(most, b.count)
  }
  const f = figuresOf(p)
  const height = numberOf(p.height) ?? HEIGHT
  const bottom = height - 20
  const axis = valueAxis(scaleOf(0, most, true, true), { prefix: "", suffix: "" }, 8, bottom)
  const x = (v: number) => place(v, first.lo, last.hi, axis.left + 4, W - 8)
  let body = axis.grid
  for (const b of bins) {
    body += rect(
      x(b.lo) + 1,
      axis.y(b.count),
      x(b.hi) - x(b.lo) - 2,
      bottom - axis.y(b.count),
      "var(--s1)",
    )
  }
  const edges = [first.lo, ...bins.map((b) => b.hi)]
  const every = everyOf(
    edges.map((e) => tick(e, f)),
    W - axis.left,
  )
  body += edges
    .map((e, i) => (i % every === 0 ? words(x(e), height - 8, tick(e, f), "middle") : ""))
    .join("")
  return figureBox(svg(height, body + hline(axis.left, W, bottom, "s-base")))
}

/** A heatmap's days by date, the readable ones. */
const daysOf = (v: unknown) => {
  const days = new Map<string, number>()
  for (const d of listOf(v)) {
    const r = record(d)
    const value = numberOf(r.value)
    if (typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(r.date) && value !== null) {
      days.set(r.date, value)
    }
  }
  return days
}

const plainDateOf = (s: string | undefined) => {
  if (s === undefined) {
    return null
  }
  try {
    return Temporal.PlainDate.from(s)
  } catch {
    return null
  }
}

/** Under the weeks, the scale from zero to the most. */
const shadeScale = (most: number, f: Figures) =>
  most > 0
    ? `<div class="s-scale"><span>${esc(figure(0, f))}</span>${[0, 1, 2, 3, 4, 5]
        .map((k) => `<span class="s-key s-shade${k}"></span>`)
        .join("")}<span>${esc(figure(most, f))}</span></div>`
    : ""

const calendarHeatmap: Part = (p, s) => {
  const days = daysOf(s.value(p.days))
  const dates = [...days.keys()].toSorted()
  const first = plainDateOf(dates[0])
  const last = plainDateOf(dates.at(-1))
  if (first === null || last === null) {
    return ""
  }
  let most = 0
  for (const v of days.values()) {
    most = Math.max(most, v)
  }
  const square = 12
  const step = 14
  const top = 16
  const start = first.subtract({ days: first.dayOfWeek % 7 })
  const span = start.until(last).days
  const weeks = Math.floor(span / 7) + 1
  let body = ""
  let named = -4
  for (let i = start.until(first).days; i <= span; i += 1) {
    const day = start.add({ days: i })
    const col = Math.floor(i / 7)
    const value = days.get(day.toString()) ?? null
    const shade =
      value === null || value <= 0 || most <= 0 ? 0 : Math.min(5, Math.ceil((value / most) * 5))
    body += rect(
      col * step,
      top + (i % 7) * step,
      square,
      square,
      shade === 0 ? "var(--line)" : "var(--s1)",
      shade === 0 ? ' rx="2"' : ` rx="2" fill-opacity="${shade / 5}"`,
    )
    if ((day.day === 1 || i === start.until(first).days) && col - named >= 4 && col <= weeks - 2) {
      body += `<text class="s-tick" x="${col * step}" y="8" dominant-baseline="middle">${MONTHS[day.month - 1]?.slice(0, 3) ?? ""}</text>`
      named = col
    }
  }
  const width = weeks * step
  const height = top + 7 * step
  return `<div class="s-figure s-calendar"><svg class="s-cal" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true">${body}</svg>${shadeScale(most, figuresOf(p))}</div>`
}

const meter: Part = (p, s) => {
  const value = numberOf(s.value(p.value))
  if (value === null) {
    return ""
  }
  const max = numberOf(p.max) ?? 100
  const share = Math.min(1, Math.max(0, value / max))
  const f = figuresOf(p)
  const label = s.text(p.label)
  const shown = f.prefix === "" && f.suffix === "" ? percent(value / max) : figure(value, f)
  return `<div class="s-line">${label === "" ? "" : `<span class="s-meter-label">${esc(label)}</span>`}<svg class="s-track" height="6" aria-hidden="true"><rect width="100%" height="6" fill="var(--line)"/><rect width="${n(share * 100)}%" height="6" fill="var(--s1)"/></svg><span class="s-data">${esc(shown)}</span></div>`
}

// ---- Marks

const MARKS: Record<string, string> = {
  running: '<circle cx="5" cy="5" r="4" fill="var(--accent)"/>',
  needsYou: '<circle cx="5" cy="5" r="4" fill="var(--s2)"/>',
  stop: '<rect x="1" y="1" width="8" height="8" fill="var(--fg)"/>',
  warn: '<path d="M5 0.5L9.5 9H0.5Z" fill="var(--s8)"/>',
}

const mark = (name: string) => {
  const shape = MARKS[name]
  return shape === undefined
    ? ""
    : `<svg class="s-mark" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">${shape}</svg>`
}

/** Line glyphs for a few of A2UI's icon names, on a 24 box; the rest draw nothing. */
const GLYPHS: Record<string, string> = {
  check: "M5 12l5 5L20 7",
  close: "M6 6l12 12M18 6L6 18",
  add: "M12 5v14M5 12h14",
  arrowForward: "M5 12h14M13 6l6 6-6 6",
  arrowBack: "M19 12H5M11 6l-6 6 6 6",
  warning: "M12 3L22 20H2ZM12 10v4M12 17v.5",
  info: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 11v6M12 7.5v.5",
  error: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 7v6M12 16.5v.5",
  search: "M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13M15.5 15.5L20 20",
  menu: "M4 7h16M4 12h16M4 17h16",
  play: "M7 4l12 8-12 8Z",
  pause: "M8 5v14M16 5v14",
  stop: "M6 6h12v12H6Z",
  star: "M12 3l2.8 5.8 6.2.9-4.5 4.4 1 6.3L12 17.4 6.5 20.4l1-6.3L3 9.7l6.2-.9Z",
  mail: "M3 6h18v12H3ZM3 6l9 7 9-7",
  phone:
    "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2",
  home: "M3 11l9-8 9 8M5 9v11h14V9",
  person: "M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8M4 21a8 8 0 0 1 16 0",
}

const glyph = (d: string) =>
  `<svg class="s-glyph" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="${esc(d)}"/></svg>`

// ---- Parts

const JUSTIFY = new Set([
  "start",
  "center",
  "end",
  "spaceBetween",
  "spaceAround",
  "spaceEvenly",
  "stretch",
])
const ALIGN = new Set(["start", "center", "end", "stretch"])

const flexClasses = (p: Props) => {
  let cls = ""
  if (typeof p.justify === "string" && JUSTIFY.has(p.justify)) {
    cls += ` s-j-${p.justify}`
  }
  if (typeof p.align === "string" && ALIGN.has(p.align)) {
    cls += ` s-a-${p.align}`
  }
  return cls
}

const line = (inside: string) => `<div class="s-line">${inside}</div>`

const name = (text: string, cls = "s-name") => `<span class="${cls}">${esc(text)}</span>`

const data = (text: string) => (text === "" ? "" : `<span class="s-data">${esc(text)}</span>`)

/** A read-only input: its label and value. */
const field = (label: string, value: string) =>
  label === "" && value === ""
    ? ""
    : line(`${label === "" ? "" : name(label, "s-name s-muted")}${data(value)}`)

const IMAGE_VARIANTS = new Set([
  "icon",
  "avatar",
  "smallFeature",
  "mediumFeature",
  "largeFeature",
  "header",
])
const FITS = new Set(["contain", "cover", "fill", "none", "scaleDown"])

/** A link's last part, for a link with nothing else to say. */
const fileOf = (url: string) => {
  const parsed = URL.parse(url, BASE)
  const last = parsed?.pathname.split("/").pop() ?? ""
  try {
    return decodeURIComponent(last) || url
  } catch {
    return last || url
  }
}

/** The words a Button's child says, plain. */
const plain = (html: string) =>
  decodeEntities(html.replaceAll(/<[^>]*>/gu, " "))
    .replaceAll(/\s+/gu, " ")
    .trim()

/** An `https` link a Button opens with A2UI's `openUrl`, or none. */
const openUrlOf = (action: unknown, s: Scope) => {
  const fn = record(record(action).functionCall)
  const named = fn["@call"] ?? fn.call
  if (named !== "openUrl") {
    return null
  }
  const url = s.text(record(fn.args).url)
  return URL.parse(url)?.protocol === "https:" ? url : null
}

const timeOf = (ms: number) => {
  const total = Math.max(0, Math.trunc(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`
}

const BASIC: Record<string, Part> = {
  Text: (p, s) => {
    const text = s.text(p.text)
    if (text.replaceAll(/^ {0,3}#{1,6}(?=[ \t]|$)/gmu, "").trim() === "") {
      return ""
    }
    const variant = stringOf(p.variant)
    if (/^h[1-5]$/u.test(variant)) {
      return `<h2 class="s-h">${esc(text.replace(/^#+\s*/u, ""))}</h2>`
    }
    if (variant === "caption") {
      return `<p class="s-caption">${esc(text)}</p>`
    }
    return `<div class="s-md">${markdownHtml(text, s.media)}</div>`
  },
  Image: (p, s) => {
    const url = s.media(s.text(p.url))
    if (url === null) {
      return ""
    }
    const variant =
      typeof p.variant === "string" && IMAGE_VARIANTS.has(p.variant) ? p.variant : "mediumFeature"
    const fit = typeof p.fit === "string" && FITS.has(p.fit) ? p.fit : "cover"
    return `<img class="s-img s-img-${variant} s-fit-${fit}" src="${esc(url)}" alt="${esc(s.text(p.description))}">`
  },
  Icon: (p, s) => {
    const named = s.value(p.name)
    if (typeof named === "string") {
      const d = GLYPHS[named]
      return d === undefined ? "" : glyph(d)
    }
    const path = s.text(record(named).svgPath)
    return path === "" ? "" : glyph(path)
  },
  Video: (p, s) => {
    const url = s.media(s.text(p.url))
    if (url === null) {
      return ""
    }
    const poster = s.media(s.text(p.posterUrl))
    const inside =
      poster === null
        ? esc(fileOf(url))
        : `<img class="s-img s-img-mediumFeature s-fit-cover" src="${esc(poster)}" alt="${esc(fileOf(url))}">`
    return `<a class="s-media" href="${esc(url)}" rel="noreferrer">${inside}</a>`
  },
  AudioPlayer: (p, s) => {
    const url = s.media(s.text(p.url))
    if (url === null) {
      return ""
    }
    const said = s.text(p.description)
    return line(
      `<a class="s-name" href="${esc(url)}" rel="noreferrer">${esc(said === "" ? fileOf(url) : said)}</a>`,
    )
  },
  Row: (p, s) => `<div class="s-row${flexClasses(p)}">${s.children(p.children).join("")}</div>`,
  Column: (p, s) => `<div class="s-col${flexClasses(p)}">${s.children(p.children).join("")}</div>`,
  List: (p, s) =>
    `<div class="${p.direction === "horizontal" ? "s-row" : "s-col"}${flexClasses(p)}">${s.children(p.children).join("")}</div>`,
  Card: (p, s) => `<div class="s-card">${s.child(p.child)}</div>`,
  Tabs: (p, s) =>
    `<div class="s-col">${listOf(p.tabs)
      .map((t) => {
        const tab = record(t)
        return `<div class="s-tab">${esc(s.text(tab.title))}</div>${s.child(tab.child)}`
      })
      .join("")}</div>`,
  Modal: (p, s) => s.child(p.content),
  Divider: (p) =>
    p.axis === "vertical" ? '<div class="s-divider-v"></div>' : '<hr class="s-divider">',
  Button: (p, s) => {
    const label = plain(s.child(p.child))
    if (label === "") {
      return ""
    }
    const url = openUrlOf(p.action, s)
    const cls = p.variant === "primary" ? "s-button s-primary" : "s-button"
    return url === null
      ? line(`<span class="${cls}">${esc(label)}</span>`)
      : line(`<a class="${cls}" href="${esc(url)}" rel="noreferrer">${esc(label)}</a>`)
  },
  TextField: (p, s) => {
    const value = s.text(p.value)
    return field(
      s.text(p.label),
      p.variant === "obscured" ? "•".repeat(Math.min(12, value.length)) : value,
    )
  },
  CheckBox: (p, s) => {
    const label = s.text(p.label)
    const box =
      s.value(p.value) === true
        ? '<svg class="s-box" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><rect x="0.5" y="0.5" width="13" height="13" fill="none" stroke="var(--fg)"/><path d="M3.5 7l2.5 2.5 4.5-5" fill="none" stroke="var(--fg)" stroke-width="1.6"/></svg>'
        : '<svg class="s-box" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><rect x="0.5" y="0.5" width="13" height="13" fill="none" stroke="var(--muted)"/></svg>'
    return line(`${box}${name(label)}`)
  },
  ChoicePicker: (p, s) => {
    const chosen = new Set(listOf(s.value(p.value)).map((v) => wordsOf(v)))
    const picked = listOf(p.options)
      .map((o) => record(o))
      .filter((o) => chosen.has(wordsOf(o.value)))
      .map((o) => s.text(o.label))
    return field(s.text(p.label), picked.join(", "))
  },
  Slider: (p, s) => {
    const value = numberOf(s.value(p.value))
    return field(s.text(p.label), value === null ? "" : whole.format(value))
  },
  DateTimeInput: (p, s) => field(s.text(p.label), s.text(p.value).replace("T", " ")),
}

const SWITCH: Record<string, Part> = {
  Line: (p, s) => {
    const running = s.value(p.running) === true
    const asOf = numberOf(s.value(p.asOf))
    const since =
      running && asOf !== null ? Math.max(0, Temporal.Now.instant().epochMilliseconds - asOf) : 0
    const left = numberOf(s.value(p.left))
    const elapsed = numberOf(s.value(p.elapsed))
    let time = ""
    if (left !== null) {
      time = timeOf(left - since)
    } else if (elapsed !== null) {
      time = timeOf(elapsed + since)
    }
    const marks =
      (s.value(p.ringing) === true ? mark("needsYou") : "") + (running ? mark("running") : "")
    return line(marks + name(s.text(p.label)) + data(time))
  },
  Slot: (p, s) => {
    const marks =
      (s.value(p.needsYou) === true ? mark("needsYou") : "") +
      (s.value(p.running) === true ? mark("running") : "") +
      (s.value(p.conflict) === true ? mark("warn") : "")
    return line(
      `<span class="s-time">${esc(s.text(p.time))}</span>${marks}${name(s.text(p.title))}`,
    )
  },
  Field: (p, s) =>
    line(
      (s.value(p.alert) === true ? mark("warn") : "") +
        name(s.text(p.label)) +
        data(s.text(p.value)),
    ),
  Title: (p, s) =>
    `<h2 class="s-title">${s.value(p.needsYou) === true ? mark("needsYou") : ""}${esc(s.text(p.label))}</h2>`,
  Row: (p, s) => {
    const label = s.text(p.label)
    const url = safeHref(s.text(p.url))
    const shown =
      url === null || !/^https?:/iu.test(url)
        ? name(label, "s-strong")
        : `<a class="s-strong" href="${esc(url)}" rel="noreferrer">${esc(label)}</a>`
    const detail = s.text(p.detail)
    const values = listOf(s.value(p.values))
      .map((v) => data(wordsOf(v)))
      .join("")
    const endsAt = numberOf(s.value(p.endsAt))
    const ends =
      endsAt === null
        ? ""
        : data(timeOf(endsAt - Temporal.Now.instant().epochMilliseconds).replace(/:\d\d$/u, ""))
    const progress = numberOf(s.value(p.progress))
    const rule =
      progress === null
        ? ""
        : `<svg class="s-progress" height="2" aria-hidden="true"><rect width="${n(Math.min(100, Math.max(0, progress)))}%" height="2" fill="var(--fg)"/></svg>`
    const kids = s.children(p.children)
    const under = kids.length === 0 ? "" : `<div class="s-cells">${kids.join("")}</div>`
    const said =
      detail === ""
        ? ""
        : `<span class="s-detail${s.value(p.alert) === true ? " s-alert" : ""}">${esc(detail)}</span>`
    return `<div class="s-item"><div class="s-line">${mark(s.text(p.mark))}${shown}${said}${values}${ends}</div>${rule}${under}</div>`
  },
  Pick: (p, s) => {
    const swatch = s.text(p.swatch)
    const hex = /^#?[0-9a-f]{6}$/iu.test(swatch) ? `#${swatch.replace("#", "")}` : null
    const box =
      hex === null
        ? ""
        : `<svg class="s-mark" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><rect width="10" height="10" fill="${hex}"/></svg>`
    const current = Object.values(record(s.value(p.current)))
      .map((v) => wordsOf(v))
      .filter((v) => v !== "")
    return line(box + name(s.text(p.label)) + data(current.join(" · ")))
  },
  Gallery: (p, s) => {
    const pictures = listOf(s.value(p.images)).flatMap((v) => {
      const r = record(v)
      const url = typeof r.url === "string" ? s.media(r.url) : null
      return url === null ? [] : [`<img src="${esc(url)}" alt="${esc(stringOf(r.description))}">`]
    })
    return pictures.length === 0 ? "" : `<div class="s-gallery">${pictures.join("")}</div>`
  },
  Check: (p, s) => {
    const done = s.value(p.done) === true
    const ring = `<svg class="s-box" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="${done ? "var(--muted)" : "none"}" stroke="var(--muted)" stroke-width="1.5"/></svg>`
    return `<div class="s-line s-hair">${ring}${name(s.text(p.label), done ? "s-name s-muted" : "s-name")}${data(s.text(p.detail))}</div>`
  },
  BarChart: barChart,
  LineChart: lineChart(false),
  AreaChart: lineChart(true),
  Sparkline: sparkline,
  DonutChart: donutChart,
  ScatterChart: scatterChart,
  Histogram: histogram,
  CalendarHeatmap: calendarHeatmap,
  Meter: meter,
}

/** A component's part, by its catalog, else the surface's, else the other one. */
const partOf = (c: Props, catalog: string) => {
  const part = stringOf(c.component)
  const own = typeof c.catalogId === "string" ? c.catalogId : catalog
  const first = own === SWITCH_CATALOG ? SWITCH : BASIC
  const second = own === SWITCH_CATALOG ? BASIC : SWITCH
  return Object.hasOwn(first, part) ? first[part] : second[part]
}

const weightClass = (p: Props) => {
  const weight = numberOf(p.weight)
  return weight === null || weight <= 0 ? "" : `s-w${Math.min(12, Math.max(1, Math.round(weight)))}`
}

const scopeOf = (
  surface: Surface,
  base: string,
  draw: (id: string, under: string) => string,
): Scope => {
  const value = (v: unknown): unknown => {
    const r = record(v)
    if (typeof r["@path"] === "string") {
      return at(surface.data, absolute(r["@path"], base))
    }
    if (typeof r["@call"] === "string") {
      const args = Object.fromEntries(Object.entries(record(r.args)).map(([k, a]) => [k, value(a)]))
      return r["@call"] === "formatString"
        ? interpolate(stringOf(args.value))
        : call(r["@call"], args)
    }
    return v
  }
  // A `${…}` in formatString: a path, or a call with named arguments.
  const expression = (raw: string): unknown => {
    const expr = raw.trim()
    const fn = /^(?<fn>[A-Za-z_]\w*)\((?<args>.*)\)$/su.exec(expr)
    if (fn === null) {
      return at(surface.data, absolute(expr, base))
    }
    const args: Record<string, unknown> = {}
    for (const arg of argumentsOf(fn.groups?.args ?? "")) {
      const colon = arg.indexOf(":")
      if (colon > 0) {
        args[arg.slice(0, colon).trim()] = literal(arg.slice(colon + 1).trim())
      }
    }
    const named = fn.groups?.fn ?? ""
    return named === "formatString" ? interpolate(stringOf(args.value)) : call(named, args)
  }
  const literal = (s: string): unknown => {
    if (s.startsWith("${") && s.endsWith("}")) {
      return expression(s.slice(2, -1))
    }
    if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
      return s.slice(1, -1)
    }
    if (s === "true" || s === "false") {
      return s === "true"
    }
    const num = Number(s)
    return s !== "" && Number.isFinite(num) ? num : at(surface.data, absolute(s, base))
  }
  const interpolate = (template: string) => {
    let out = ""
    let i = 0
    while (i < template.length) {
      if (template.startsWith("\\${", i)) {
        out += "${"
        i += 3
      } else if (template.startsWith("${", i)) {
        const end = closing(template, i + 2)
        if (end === -1) {
          out += template.slice(i)
          i = template.length
        } else {
          out += wordsOf(expression(template.slice(i + 2, end)))
          i = end + 1
        }
      } else {
        out += template.charAt(i)
        i += 1
      }
    }
    return out
  }
  const children = (list: unknown): readonly string[] => {
    if (Array.isArray(list)) {
      return list.filter((id) => typeof id === "string").map((id) => draw(id, base))
    }
    const template = record(list)
    if (typeof template.componentId !== "string" || typeof template.path !== "string") {
      return []
    }
    const id = template.componentId
    const path = absolute(template.path, base)
    const items = at(surface.data, path)
    const keys = Array.isArray(items) ? items.map((_, i) => String(i)) : Object.keys(record(items))
    return keys.map((key) =>
      draw(id, `${path === "/" ? "" : path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
    )
  }
  return {
    value,
    text: (v) => wordsOf(value(v)),
    child: (id) => (typeof id === "string" ? draw(id, base) : ""),
    children,
    media: surface.media,
  }
}

const render = (surface: Surface, id: string, base: string, seen: ReadonlySet<string>): string => {
  if (seen.has(id) || seen.size >= DEPTH) {
    return ""
  }
  const c = surface.components.get(id)
  const part = c === undefined ? undefined : partOf(c, surface.catalog)
  if (c === undefined || part === undefined) {
    return ""
  }
  const next = new Set(seen).add(id)
  const html = part(
    c,
    scopeOf(surface, base, (child, under) => render(surface, child, under, next)),
  )
  const weight = weightClass(c)
  return weight === "" || html === "" ? html : `<div class="${weight}">${html}</div>`
}

/** A surface's messages (as packages/gateway/src/views.ts `surfaceOf` makes them) as static HTML. `image` maps an image URL as given (a `sha256:…` blob name, `/blobs/sha256:…`, or an https URL) to the URL the page uses, or null to leave the image out. */
export const surfaceHtml = (
  surface: readonly unknown[],
  image: (url: string) => string | null,
): string => {
  const components = new Map<string, Props>()
  let model: unknown = {}
  let catalog = ""
  for (const message of surface) {
    const m = record(message)
    const created = record(m.createSurface)
    if (typeof created.catalogId === "string") {
      catalog = created.catalogId
    }
    for (const c of listOf(record(m.updateComponents).components)) {
      const props = record(c)
      if (typeof props.id === "string") {
        components.set(props.id, props)
      }
    }
    const update = record(m.updateDataModel)
    if ("value" in update) {
      const path = stringOf(update.path)
      if (path === "" || path === "/") {
        model = update.value
      }
    }
  }
  const media = (url: string) => (url === "" ? null : image(url))
  const html = render({ components, data: model, catalog, media }, "root", "", new Set())
  return `<div class="s-surface">${html}</div>`
}

const SERIES_COLORS = [
  "#2a78d6",
  "#eb6834",
  "#1baf7a",
  "#eda100",
  "#e87ba4",
  "#008300",
  "#6250d6",
  "#e34948",
]

const JUSTIFY_CSS: Record<string, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  spaceBetween: "space-between",
  spaceAround: "space-around",
  spaceEvenly: "space-evenly",
}
const ALIGN_CSS: Record<string, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
}

/** CSS for what surfaceHtml emits: classes prefixed `s-`, colors only through the variables --fg, --muted, --line, --soft, --accent (the page sets them for light, dark and print). */
export const SURFACE_CSS: string = [
  `:root{${SERIES_COLORS.map((c, k) => `--s${k + 1}:${c};`).join("")}}`,
  ...SERIES_COLORS.map((_, k) => `.s-c${k + 1}{background:var(--s${k + 1})}`),
  ".s-cm{background:var(--muted)}",
  ...Object.entries(JUSTIFY_CSS).map(([k, v]) => `.s-j-${k}{justify-content:${v}}`),
  ".s-j-stretch>*{flex:1}",
  ...Object.entries(ALIGN_CSS).map(([k, v]) => `.s-a-${k}{align-items:${v}}`),
  ...Array.from({ length: 12 }, (_, k) => `.s-w${k + 1}{flex:${k + 1};min-width:0}`),
  ".s-surface{color:var(--fg);font-size:14px;line-height:1.45;overflow-wrap:break-word}",
  ".s-surface a[href]{color:var(--accent)}",
  ".s-col{display:flex;flex-direction:column;min-width:0}",
  ".s-row{display:flex;min-width:0}",
  ".s-row>*{min-width:0}",
  ".s-card{display:flex;flex-direction:column;border-bottom:1px solid var(--line)}",
  ".s-row>.s-card+.s-card{border-left:1px solid var(--line)}",
  ".s-line{display:flex;align-items:center;gap:10px;min-height:24px;padding:3px 8px}",
  ".s-item{display:flex;flex-direction:column}",
  ".s-hair{border-bottom:1px solid var(--soft)}",
  ".s-name{flex:1;min-width:0}",
  ".s-strong{flex:none;font-weight:500}",
  ".s-detail{flex:1;min-width:0;color:var(--muted);font-size:13px}",
  ".s-detail.s-alert{color:var(--fg)}",
  ".s-muted{color:var(--muted)}",
  ".s-data{flex:none;margin-left:auto;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}",
  ".s-data+.s-data{margin-left:0}",
  ".s-time{flex:none;width:68px;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}",
  ".s-mark,.s-box,.s-glyph{flex:none;display:block}",
  ".s-glyph{margin:5px 8px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}",
  ".s-cells{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr)}",
  ".s-progress{display:block;width:100%}",
  ".s-title{display:flex;align-items:center;gap:10px;margin:0;padding:8px;font-size:16px;font-weight:600}",
  ".s-h{margin:0;padding:4px 8px;font-size:14px;font-weight:600}",
  ".s-caption{margin:0;padding:3px 8px;color:var(--muted)}",
  ".s-md{padding:2px 8px;min-width:0}",
  ".s-md p{margin:4px 0}",
  ".s-md h1,.s-md h2,.s-md h3,.s-md h4,.s-md h5,.s-md h6{margin:8px 0 4px;font-size:14px;font-weight:600}",
  ".s-md ul,.s-md ol{margin:4px 0;padding-left:20px}",
  ".s-md li::marker{color:var(--muted)}",
  ".s-md blockquote{margin:4px 0;padding-left:12px;border-left:2px solid var(--line);color:var(--muted)}",
  ".s-md pre{margin:4px 0;padding:8px 12px;border:1px solid var(--line);overflow-x:auto;font-size:12px;white-space:pre-wrap}",
  ".s-md code{font-family:ui-monospace,Menlo,monospace;font-size:12px}",
  ".s-md table{border-collapse:collapse;margin:4px 0}",
  ".s-md th,.s-md td{border:1px solid var(--line);padding:2px 8px;text-align:left}",
  ".s-md hr{border:0;border-top:1px solid var(--line);margin:8px 0}",
  ".s-md img{max-width:100%}",
  ".s-divider{margin:0;border:0;border-top:1px solid var(--line)}",
  ".s-divider-v{flex:none;align-self:stretch;width:0;border-left:1px solid var(--line)}",
  ".s-img{display:block}",
  ".s-img-mediumFeature,.s-img-largeFeature{width:100%;height:auto}",
  ".s-img-header{width:100%;height:200px}",
  ".s-img-icon{width:24px;height:24px;margin:0 8px}",
  ".s-img-avatar{width:40px;height:40px;margin:0 8px;border-radius:50%}",
  ".s-img-smallFeature{width:100px;height:auto;margin:0 8px}",
  ".s-fit-contain{object-fit:contain}",
  ".s-fit-cover{object-fit:cover}",
  ".s-fit-fill{object-fit:fill}",
  ".s-fit-none{object-fit:none}",
  ".s-fit-scaleDown{object-fit:scale-down}",
  ".s-media{display:block;padding:3px 8px}",
  ".s-tab{padding:6px 8px;font-weight:600;border-bottom:1px solid var(--soft)}",
  ".s-button{display:inline-block;padding:1px 10px;border:1px solid var(--line);font-weight:500;color:var(--fg);text-decoration:none}",
  ".s-surface a.s-button{color:var(--fg)}",
  ".s-primary{border-color:var(--accent)}",
  ".s-gallery{display:flex;flex-wrap:wrap;gap:2px}",
  ".s-gallery img{display:block;height:160px;width:auto;max-width:100%;object-fit:cover}",
  ".s-figure{padding:8px}",
  ".s-chart{display:block;width:100%;height:auto;overflow:visible}",
  ".s-chart text,.s-ring text,.s-cal text{font-family:inherit}",
  ".s-tick{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}",
  ".s-label{fill:var(--fg);font-size:11px;font-variant-numeric:tabular-nums}",
  ".s-grid{stroke:var(--soft);stroke-width:1}",
  ".s-base{stroke:var(--line);stroke-width:1}",
  ".s-stroke{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}",
  ".s-spark{display:block;width:100%}",
  ".s-legend{display:flex;flex-wrap:wrap;gap:4px 12px;list-style:none;margin:0;padding:0 0 8px;font-size:12px;color:var(--muted)}",
  ".s-legend li{display:flex;align-items:center;gap:6px}",
  ".s-key{display:inline-block;flex:none;width:8px;height:8px}",
  ".s-round{border-radius:50%}",
  ".s-donut{display:flex;flex-wrap:wrap;align-items:center;gap:12px 24px;padding:8px}",
  ".s-ring{flex:none;display:block}",
  ".s-total{fill:var(--fg);font-size:20px;font-weight:600}",
  ".s-slices{flex:1;min-width:160px;max-width:300px;list-style:none;margin:0;padding:0;font-size:12px}",
  ".s-slices li{display:flex;align-items:center;gap:8px;padding:2px 0}",
  ".s-slices .s-name{color:var(--muted)}",
  ".s-slices .s-data{color:var(--fg)}",
  ".s-calendar{display:flex;flex-direction:column;align-items:flex-start}",
  ".s-cal{display:block;max-width:100%;height:auto}",
  ".s-scale{display:flex;align-items:center;gap:4px;padding-top:8px;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}",
  ".s-shade0{background:var(--line)}",
  ...[1, 2, 3, 4, 5].map((k) => `.s-shade${k}{background:var(--s1);opacity:${k / 5}}`),
  ".s-meter-label{flex:none;width:25%;min-width:64px}",
  ".s-track{display:block;flex:1;min-width:48px}",
  "@media print{.s-figure,.s-card,.s-donut,.s-line,.s-gallery img{break-inside:avoid}}",
].join("")
