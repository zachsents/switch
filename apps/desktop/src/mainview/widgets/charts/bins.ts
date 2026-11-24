// Raw values counted into bins of equal width at round edges (a step of 1, 2, 2.5 or 5 times a power
// of ten, from a multiple of it): `bins` of them when given, else Sturges' count.
import { roundStep } from "./ticks.ts"

export interface Bin {
  readonly lo: number
  readonly hi: number
  readonly count: number
}

/** The round step after `step`. */
const nextStep = (step: number) => roundStep(step * (1 + 1e-6))

export const binsOf = (values: readonly number[], given: number | undefined): readonly Bin[] => {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const v of values) {
    min = Math.min(min, v)
    max = Math.max(max, v)
  }
  if (values.length === 0) {
    return []
  }
  if (min === max) {
    return [{ lo: min - 0.5, hi: max + 0.5, count: values.length }]
  }
  const count = given ?? Math.ceil(Math.log2(values.length)) + 1
  let step = roundStep((max - min) / count)
  let lo = Math.floor(min / step) * step
  // Given a count, the step grows until that many bins reach the most.
  if (given !== undefined) {
    while (lo + given * step < max) {
      step = nextStep(step)
      lo = Math.floor(min / step) * step
    }
  }
  const n = given ?? Math.max(1, Math.ceil((max - lo) / step))
  const counts = Array.from({ length: n }, () => 0)
  for (const v of values) {
    const k = Math.min(n - 1, Math.floor((v - lo) / step))
    counts[k] = (counts[k] ?? 0) + 1
  }
  return counts.map((c, k) => ({ lo: lo + k * step, hi: lo + (k + 1) * step, count: c }))
}
