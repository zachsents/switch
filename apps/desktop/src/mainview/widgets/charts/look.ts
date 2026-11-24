// The charts' look (the dataviz method in the house's tokens): thin marks, bars at most 24 px thick
// with a 4 px rounded data end and square at the baseline, 2 px lines, 8 px markers in a 2 px ring of
// the background, a 2 px gap of the background between fills that touch, washes at 10%; gridlines
// line-2 hairlines, the baseline line-1, words in the inks, never a series' color. No motion.

/** A chart's own height, its axes in it, unless it's given one. */
export const HEIGHT = 200
/** A bar's most thickness. */
export const BAR = 24
/** A bar's rounded data end, square at the baseline: a column's top, a row's right. */
export const COLUMN_END: [number, number, number, number] = [4, 4, 0, 0]
export const ROW_END: [number, number, number, number] = [0, 4, 4, 0]
/** The background between fills that touch. */
export const GAP = 2
/** A line's width. */
export const LINE = 2
/** A marker's radius, and the background's ring round it. */
export const DOT = 4
export const RING = 2
/** An area's wash. */
export const WASH = 0.1
/** A label beside its mark, in px. */
export const BESIDE = 6

/** Axis and label words: small, in ink3. */
export const SMALL = 11
export const TICK = { fill: "var(--color-ink3)", fontSize: SMALL }
export const LABEL = { fill: "var(--color-ink2)", fontSize: SMALL }
export const GRID = { stroke: "var(--color-line-2)", strokeWidth: "var(--line-2)" }
export const BASELINE = { stroke: "var(--color-line-1)", strokeWidth: "var(--line-1)" }
/** The crosshair over a line's chart, and the wash over a bar's band. */
export const CROSSHAIR = { stroke: "var(--color-line-1)", strokeWidth: 1 }
export const BAND = { fill: "var(--color-hover)", stroke: "none" }
export const BACKGROUND = "var(--color-bg)"

const measure = document.createElement("canvas").getContext("2d")

/** How wide words are drawn small, in px, to keep room for them. */
export const widthOf = (text: string) => {
  if (!measure) {
    return text.length * SMALL * 0.62
  }
  measure.font = `${SMALL}px ${getComputedStyle(document.documentElement).fontFamily}`
  return Math.ceil(measure.measureText(text).width)
}
