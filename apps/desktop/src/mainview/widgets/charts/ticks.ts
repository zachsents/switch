// A value axis's scale: from a multiple of a round step (1, 2, 2.5 or 5 times a power of ten) below
// the least to one above the most, about four steps apart, ticked at each. Bars, areas and counts
// keep zero in it; lines and points fit their values.

const FACTORS = [1, 2, 2.5, 5, 10] as const

/** The round step at least `raw` (give or take a float's error); a whole one when `whole`. */
export const roundStep = (raw: number, whole = false) => {
  const power = 10 ** Math.floor(Math.log10(raw))
  const step = (FACTORS.find((f) => f * power >= raw * (1 - 1e-9)) ?? 10) * power
  if (!whole) {
    return step
  }
  if (step < 1) {
    return 1
  }
  return Number.isInteger(step) ? step : step * 2
}

/** A tick without a float's error: 0.30000000000000004 is 0.3. */
const clean = (v: number) => Number(v.toPrecision(12))

export interface Scale {
  readonly domain: [number, number]
  readonly ticks: readonly number[]
}

/** The scale for values from `min` to `max`. */
export const scaleOf = (
  min: number,
  max: number,
  { zero, whole = false }: { readonly zero: boolean; readonly whole?: boolean },
): Scale => {
  let lo = zero ? Math.min(0, min) : min
  let hi = zero ? Math.max(0, max) : max
  if (hi - lo <= 0) {
    lo -= lo === 0 ? 0 : 1
    hi += 1
  }
  const step = roundStep((hi - lo) / 4, whole)
  const from = Math.floor(lo / step + 1e-9)
  const to = Math.ceil(hi / step - 1e-9)
  const ticks = Array.from({ length: to - from + 1 }, (_, k) => clean((from + k) * step))
  return { domain: [clean(from * step), clean(to * step)], ticks }
}

/** The least and most of values, none when there are none. */
export const extentOf = (values: Iterable<number | null>) => {
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
