// What a chart is given, read defensively: any of it may be bound to the surface's data model, where
// anything can arrive. A value that can't be read is none; a series, slice, point or day that can't
// be read is left out. With nothing left, a chart draws nothing.
import { Option, Schema } from "effect"

/** The series' colors in this order, never cycled (index.css): marks only, never words. */
export const SERIES = [
  "var(--color-series-1)",
  "var(--color-series-2)",
  "var(--color-series-3)",
  "var(--color-series-4)",
  "var(--color-series-5)",
  "var(--color-series-6)",
  "var(--color-series-7)",
  "var(--color-series-8)",
] as const

/** A magnitude in one hue, least to most (index.css). */
export const SCALE = [
  "var(--color-scale-1)",
  "var(--color-scale-2)",
  "var(--color-scale-3)",
  "var(--color-scale-4)",
  "var(--color-scale-5)",
] as const

/** What's folded past a cap: Other, in the gray that steps back. */
export const OTHER = "var(--color-ink3)"

/** How many series a chart draws; past it the rest fold into Other, or aren't drawn. */
export const CAP = 8

const OTHER_NAME = "Other"

export const colorOf = (i: number) => SERIES[i] ?? OTHER

const decodeList = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown))
const decodeNamed = Schema.decodeUnknownOption(
  Schema.Struct({ name: Schema.String, values: Schema.Array(Schema.Unknown) }),
)
const decodeSlice = Schema.decodeUnknownOption(
  Schema.Struct({ label: Schema.String, value: Schema.Finite }),
)
const decodePoints = Schema.decodeUnknownOption(
  Schema.Struct({ name: Schema.String, points: Schema.Array(Schema.Unknown) }),
)
const decodePair = Schema.decodeUnknownOption(Schema.Tuple([Schema.Finite, Schema.Finite]))
const decodeDay = Schema.decodeUnknownOption(
  Schema.Struct({
    date: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)),
    value: Schema.Finite,
  }),
)

const listOf = (x: unknown): readonly unknown[] => Option.getOrElse(decodeList(x), () => [])

/** A number, or none. */
export const numberOf = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null)

/** Raw values: the numbers among them. */
export const numbersOf = (x: unknown) =>
  listOf(x).flatMap((v) => Option.toArray(Option.fromNullishOr(numberOf(v))))

/** Labels as words: a number reads as itself. */
export const labelsOf = (x: unknown) =>
  listOf(x).map((l) => {
    if (typeof l === "string") {
      return l
    }
    const n = numberOf(l)
    return n === null ? "" : String(n)
  })

/** A sum of what's there; none when nothing is. */
const sumOf = (values: readonly (number | null)[]) => {
  let sum: number | null = null
  for (const v of values) {
    if (v !== null) {
      sum = (sum ?? 0) + v
    }
  }
  return sum
}

export interface Series {
  readonly name: string
  readonly color: string
  readonly values: readonly (number | null)[]
}

/**
 * Named series with a value for each of `count` labels, or none; each takes its color by its place.
 * Past the cap, the rest are summed into Other when `sum` (parts of a whole), else not drawn.
 */
export const seriesOf = (x: unknown, count: number, sum: boolean): readonly Series[] => {
  const read = listOf(x)
    .flatMap((s) => Option.toArray(decodeNamed(s)))
    .map((s, i) => ({
      name: s.name,
      color: colorOf(i),
      values: Array.from({ length: count }, (_, j) => numberOf(s.values[j])),
    }))
  if (read.length <= CAP) {
    return read
  }
  if (!sum) {
    return read.slice(0, CAP)
  }
  const rest = read.slice(CAP - 1)
  const other = {
    name: OTHER_NAME,
    color: OTHER,
    values: Array.from({ length: count }, (_, j) => sumOf(rest.map((s) => s.values[j] ?? null))),
  }
  return [...read.slice(0, CAP - 1), other]
}

/** Whether any series has a value to draw. */
export const anyValue = (series: readonly Series[]) =>
  series.some((s) => s.values.some((v) => v !== null))

export interface Slice {
  readonly label: string
  readonly value: number
  readonly color: string
}

/** How many slices read at a glance; past it the rest fold into Other. */
const SLICES = 6

/** Parts of a whole: the slices with something in them, each its color by its place; past six, Other. */
export const slicesOf = (x: unknown): readonly Slice[] => {
  const read = listOf(x)
    .flatMap((s) => Option.toArray(decodeSlice(s)))
    .filter((s) => s.value > 0)
    .map((s, i) => ({ label: s.label, value: s.value, color: colorOf(i) }))
  if (read.length <= SLICES) {
    return read
  }
  const rest = read.slice(SLICES - 1)
  const other = { label: OTHER_NAME, value: sumOf(rest.map((s) => s.value)) ?? 0, color: OTHER }
  return [...read.slice(0, SLICES - 1), other]
}

export interface Points {
  readonly name: string
  readonly color: string
  readonly points: readonly { readonly x: number; readonly y: number }[]
}

/** How many series of points stay apart, any two side by side; past it, the rest aren't drawn. */
const POINT_SERIES = 3

/** Series of points, each its color by its place: the first three. */
export const pointsOf = (x: unknown): readonly Points[] =>
  listOf(x)
    .flatMap((s) => Option.toArray(decodePoints(s)))
    .map((s, i) => ({
      name: s.name,
      color: colorOf(i),
      points: s.points
        .flatMap((p) => Option.toArray(decodePair(p)))
        .map(([px, py]) => ({ x: px, y: py })),
    }))
    .filter((s) => s.points.length > 0)
    .slice(0, POINT_SERIES)

/** A real day, or none: "2026-02-30" is none. */
const dayOf = (date: string) => {
  try {
    return Temporal.PlainDate.from(date, { overflow: "reject" })
  } catch {
    return null
  }
}

/** A value per day, by the day ("2026-11-02"); a day given twice keeps its last. */
export const daysOf = (x: unknown) => {
  const days = new Map<string, { readonly day: Temporal.PlainDate; readonly value: number }>()
  for (const raw of listOf(x)) {
    for (const d of Option.toArray(decodeDay(raw))) {
      const day = dayOf(d.date)
      if (day) {
        days.set(day.toString(), { day, value: d.value })
      }
    }
  }
  return days
}
