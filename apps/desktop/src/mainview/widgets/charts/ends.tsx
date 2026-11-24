// Each line's end: a dot in a ring of the background, its latest value beside it. When two would
// touch, none is labelled (nudged apart they'd leave their lines): the legend and tooltip say it.
import { useXAxisScale, useYAxisScale } from "recharts"

import { BACKGROUND, BESIDE, DOT, LABEL, RING, SMALL } from "./look.ts"

export interface End {
  /** The label it's at, by index. */
  readonly at: number
  readonly value: number
  readonly text: string
  readonly color: string
}

/** Labels this far apart, at least, read as their own. */
const APART = SMALL + 2

export const Ends = ({ ends }: { ends: readonly End[] }) => {
  const xScale = useXAxisScale()
  const yScale = useYAxisScale()
  const placed = ends.flatMap((e) => {
    const x = xScale?.(e.at, { position: "middle" })
    const y = yScale?.(e.value)
    return x === undefined || y === undefined ? [] : [{ ...e, x, y }]
  })
  let apart = true
  let above: number | null = null
  for (const p of placed.toSorted((a, b) => a.y - b.y)) {
    if (above !== null && p.y - above < APART) {
      apart = false
    }
    above = p.y
  }
  return (
    <g>
      {placed.map((p) => (
        <g key={`${p.color}-${p.at}`}>
          <circle cx={p.x} cy={p.y} r={DOT + RING} fill={BACKGROUND} />
          <circle cx={p.x} cy={p.y} r={DOT} fill={p.color} />
          {apart && p.text !== "" && (
            <text x={p.x + DOT + BESIDE} y={p.y} dominantBaseline="central" {...LABEL}>
              {p.text}
            </text>
          )}
        </g>
      ))}
    </g>
  )
}
