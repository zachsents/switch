// A trend as one small line, its latest point marked: a line's height unless given one, its scale
// fitting its values. The pointer shows the value under it.
import { createComponentImplementation } from "@a2ui/react"
import { DynamicValueSchema } from "@a2ui/web_core/v1_0"
import { Line, LineChart, Tooltip, XAxis, YAxis } from "recharts"
import { z } from "zod"

import { numberOf, numbersOf, SERIES } from "./data.ts"
import { Ends } from "./ends.tsx"
import { BARE, figure } from "./figures.ts"
import { BACKGROUND, CROSSHAIR, DOT, LINE, RING } from "./look.ts"
import { Lone } from "./lone.tsx"
import { Tip } from "./tip.tsx"
import type { ReadTip } from "./tip.tsx"

/** A line's height (index.css `--spacing-line`). */
const ROW = 24
/** Room for the end's dot and its ring. */
const ROOM = DOT + RING

const read: ReadTip = (payload) => ({
  title: "",
  rows: payload.flatMap((e) => {
    const v = numberOf(e.value)
    return v === null ? [] : [{ value: figure(v, BARE), name: "", color: SERIES[0] }]
  }),
})

export const Sparkline = createComponentImplementation(
  {
    name: "Sparkline",
    schema: z.object({
      values: DynamicValueSchema,
      /** Px, else a line's. */
      height: z.number().positive().optional(),
    }),
  },
  ({ props }) => {
    const values = numbersOf(props.values)
    const last = values.at(-1)
    if (last === undefined) {
      return null
    }
    const [color] = SERIES
    const flat = values.every((v) => v === last)
    return (
      <div className="px-inset">
        <LineChart
          data={values.map((v, i) => ({ i, v }))}
          responsive
          style={{ width: "100%", height: props.height ?? ROW }}
          margin={{ top: ROOM, right: ROOM, bottom: ROOM, left: ROOM }}
        >
          <XAxis type="category" dataKey="i" scale="point" hide />
          <YAxis type="number" domain={flat ? [last - 1, last + 1] : ["dataMin", "dataMax"]} hide />
          <Line
            type="linear"
            dataKey="v"
            stroke={color}
            strokeWidth={LINE}
            strokeLinecap="round"
            strokeLinejoin="round"
            dot={values.length > 1 ? false : <Lone values={values} color={color} />}
            activeDot={{ r: DOT + RING / 2, fill: color, stroke: BACKGROUND, strokeWidth: RING }}
            isAnimationActive={false}
          />
          <Ends ends={[{ at: values.length - 1, value: last, text: "", color }]} />
          <Tooltip
            content={<Tip read={read} />}
            cursor={CROSSHAIR}
            position={{ y: 0 }}
            isAnimationActive={false}
          />
        </LineChart>
      </div>
    )
  },
)
