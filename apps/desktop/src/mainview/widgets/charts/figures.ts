// How a chart's figures read: a prefix and a suffix round each ("$", "%", " kg"), the sign before
// them; ticks compact from 1,000 up ("1K", "2.5M"), as a figure standing alone is from 10,000.

export interface Figures {
  readonly prefix: string
  readonly suffix: string
}

/** No prefix or suffix. */
export const BARE: Figures = { prefix: "", suffix: "" }

/** A chart's prefix and suffix, none when not given. */
export const figuresOf = (p: {
  readonly prefix?: string | undefined
  readonly suffix?: string | undefined
}) => ({
  prefix: p.prefix ?? "",
  suffix: p.suffix ?? "",
})

const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })
const short = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 })
const share = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 0 })

const read = (v: number, f: Figures, format: Intl.NumberFormat) =>
  `${v < 0 ? "-" : ""}${f.prefix}${format.format(Math.abs(v))}${f.suffix}`

/** A value in full: "-$1,284.5". */
export const figure = (v: number, f: Figures) => read(v, f, whole)

/** An axis's tick, compact from 1,000: "$1.2K". */
export const tick = (v: number, f: Figures) => read(v, f, Math.abs(v) >= 1000 ? short : whole)

/** A figure standing alone (a ring's total), compact from 10,000: "1,284", "12.9K". */
export const headline = (v: number, f: Figures) => read(v, f, Math.abs(v) >= 10_000 ? short : whole)

/** A part of a whole: "32%". */
export const percent = (part: number) => share.format(part)
