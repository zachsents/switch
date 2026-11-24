// A line chart filled under each line, or stacked. Past eight series, stacked ones fold the rest
// into Other; overlaid ones draw the first eight.
import { createComponentImplementation } from "@a2ui/react"
import { DynamicValueSchema } from "@a2ui/web_core/v1_0"
import { z } from "zod"

import { anyValue, labelsOf, seriesOf } from "./data.ts"
import { figuresOf } from "./figures.ts"
import { Trend } from "./trend.tsx"

export const AreaChart = createComponentImplementation(
  {
    name: "AreaChart",
    schema: z.object({
      labels: DynamicValueSchema,
      /** One to eight: `[{ name, values }]`, a value per label or null. */
      series: DynamicValueSchema,
      stacked: z.boolean().optional(),
      prefix: z.string().optional(),
      suffix: z.string().optional(),
      /** Px, else its own. */
      height: z.number().positive().optional(),
    }),
  },
  ({ props }) => {
    const labels = labelsOf(props.labels)
    const stacked = props.stacked === true
    const series = seriesOf(props.series, labels.length, stacked)
    return labels.length === 0 || !anyValue(series) ? null : (
      <Trend
        labels={labels}
        series={series}
        area
        stacked={stacked}
        fig={figuresOf(props)}
        height={props.height}
      />
    )
  },
)
