// How raw values spread: a column per bin, a gap of the background between them, the edges along the
// bottom, the fullest bin's count on its cap. The pointer shows a bin's range and count.
import { createComponentImplementation } from "@a2ui/react"
import { DynamicValueSchema } from "@a2ui/web_core/v1_0"
import { Bar, BarChart, CartesianGrid, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts"
import { z } from "zod"

import { binsOf } from "./bins.ts"
import { numberOf, numbersOf, SERIES } from "./data.ts"
import { BARE, figure, figuresOf, tick } from "./figures.ts"
import { BAND, BASELINE, COLUMN_END, GRID, HEIGHT, TICK } from "./look.ts"
import { Peak } from "./peak.tsx"
import { peakOf } from "./rows.ts"
import { extentOf, scaleOf } from "./ticks.ts"
import { Tip } from "./tip.tsx"
import type { ReadTip } from "./tip.tsx"

export const Histogram = createComponentImplementation(
  {
    name: "Histogram",
    schema: z.object({
      values: DynamicValueSchema,
      /** How many bars, else its own. */
      bins: z.number().int().positive().optional(),
      prefix: z.string().optional(),
      suffix: z.string().optional(),
      /** Px, else its own. */
      height: z.number().positive().optional(),
    }),
  },
  ({ props }) => {
    const bins = binsOf(numbersOf(props.values), props.bins)
    const [first] = bins
    const last = bins.at(-1)
    if (!first || !last) {
      return null
    }
    const fig = figuresOf(props)
    const [color] = SERIES
    const rows = bins.map((b) => ({ mid: (b.lo + b.hi) / 2, count: b.count }))
    const peak = peakOf(bins.map((b) => b.count))
    const counts = scaleOf(0, extentOf(bins.map((b) => b.count))?.max ?? 0, {
      zero: true,
      whole: true,
    })
    const peakBin = peak ? rows[peak.at] : undefined
    const read: ReadTip = (payload, label) => {
      const bin = bins.find((b) => (b.lo + b.hi) / 2 === label)
      const count = numberOf(payload[0]?.value)
      return !bin || count === null
        ? null
        : {
            title: `${figure(bin.lo, fig)}–${figure(bin.hi, fig)}`,
            rows: [{ value: figure(count, BARE), name: "", color }],
          }
    }
    return (
      <div className="px-inset py-2">
        <BarChart
          data={rows}
          responsive
          style={{ width: "100%", height: props.height ?? HEIGHT }}
          margin={{ top: 16, right: 8, bottom: 0, left: 0 }}
          barCategoryGap={1}
        >
          <CartesianGrid vertical={false} {...GRID} />
          <XAxis
            type="number"
            dataKey="mid"
            domain={[first.lo, last.hi]}
            ticks={[first.lo, ...bins.map((b) => b.hi)]}
            interval="preserveStartEnd"
            minTickGap={8}
            axisLine={false}
            tickLine={false}
            tick={TICK}
            tickFormatter={(v: number) => tick(v, fig)}
            height={20}
          />
          <YAxis
            type="number"
            axisLine={false}
            tickLine={false}
            tick={TICK}
            domain={counts.domain}
            ticks={counts.ticks}
            width="auto"
          />
          <Bar dataKey="count" fill={color} radius={COLUMN_END} isAnimationActive={false} />
          <ReferenceLine y={0} {...BASELINE} />
          {peak && peakBin && (
            <Peak
              at={peakBin.mid}
              value={peak.value}
              text={figure(peak.value, BARE)}
              horizontal={false}
            />
          )}
          <Tooltip content={<Tip read={read} />} cursor={BAND} isAnimationActive={false} />
        </BarChart>
      </div>
    )
  },
)
