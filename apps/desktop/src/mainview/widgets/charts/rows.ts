// Series as Recharts reads them, a row per label, and what a chart works out of them: a stack's
// extent, the extreme, the topmost of each stack.
import type { Series } from "./data.ts"
import { extentOf, scaleOf } from "./ticks.ts"

/** A row per label: its index (`i`, the category, so labels may repeat), then each series' value. */
export const rowsOf = (series: readonly Series[], count: number) =>
  Array.from({ length: count }, (_, i) => ({
    i,
    ...Object.fromEntries(series.map((s, k) => [`s${k}`, s.values[i] ?? null])),
  }))

/** Each label's stack: its values above zero summed, and those below. */
export const stacksOf = (series: readonly Series[], count: number) =>
  Array.from({ length: count }, (_, j) => {
    let up = 0
    let down = 0
    for (const s of series) {
      const v = s.values[j] ?? 0
      if (v > 0) {
        up += v
      } else {
        down += v
      }
    }
    return { up, down }
  })

/** How far a label's stack reaches: its values above zero summed, else those below; none if none. */
export const sumAt = (series: readonly Series[], j: number) => {
  let up = 0
  let down = 0
  let any = false
  for (const s of series) {
    const v = s.values[j] ?? null
    if (v !== null) {
      any = true
      if (v > 0) {
        up += v
      } else {
        down += v
      }
    }
  }
  if (!any) {
    return null
  }
  return up > 0 ? up : down
}

/** The extreme: the value furthest from zero, and where; none when every value is zero or none. */
export const peakOf = (values: readonly (number | null)[]) => {
  let peak: { readonly at: number; readonly value: number } | null = null
  for (const [at, value] of values.entries()) {
    if (value !== null && value !== 0 && (!peak || Math.abs(value) > Math.abs(peak.value))) {
      peak = { at, value }
    }
  }
  return peak
}

/** Each label's topmost series above zero, which takes the stack's rounded end; -1 for none. */
export const topsOf = (series: readonly Series[], count: number) =>
  Array.from({ length: count }, (_, j) => series.findLastIndex((s) => (s.values[j] ?? 0) > 0))

/** The scale for series' values, or their stacks' when stacked; from zero when `zero`. */
export const valueScale = (
  series: readonly Series[],
  count: number,
  { stacked, zero }: { readonly stacked: boolean; readonly zero: boolean },
) => {
  const extent = stacked
    ? extentOf(stacksOf(series, count).flatMap((s) => [s.up, s.down]))
    : extentOf(series.flatMap((s) => s.values))
  return scaleOf(extent?.min ?? 0, extent?.max ?? 0, { zero })
}
