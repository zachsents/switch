// The one value a bar chart labels: its extreme, at its bar's data end (a column's cap, a row's
// tip), in words' ink. The axis carries the rest, the tooltip each.
import { useXAxisScale, useYAxisScale } from "recharts"

import { BESIDE, LABEL } from "./look.ts"

export const Peak = ({
  at,
  value,
  text,
  horizontal,
}: {
  /** Which label's bar, by its index (or, on a number axis, its place). */
  at: number
  value: number
  text: string
  horizontal: boolean
}) => {
  const xScale = useXAxisScale()
  const yScale = useYAxisScale()
  const along = horizontal
    ? yScale?.(at, { position: "middle" })
    : xScale?.(at, { position: "middle" })
  const end = horizontal ? xScale?.(value) : yScale?.(value)
  if (along === undefined || end === undefined) {
    return null
  }
  const out = value < 0 ? -1 : 1
  if (horizontal) {
    return (
      <text
        x={end + out * BESIDE}
        y={along}
        dominantBaseline="central"
        textAnchor={out > 0 ? "start" : "end"}
        {...LABEL}
      >
        {text}
      </text>
    )
  }
  return (
    <text
      x={along}
      y={end - out * BESIDE}
      dominantBaseline={out > 0 ? "auto" : "hanging"}
      textAnchor="middle"
      {...LABEL}
    >
      {text}
    </text>
  )
}
