// A line per series over labels evenly spaced along the bottom (days, months). Past eight series,
// the first eight are drawn: lines' values needn't add up.
import { createComponentImplementation } from "@a2ui/react"
import { DynamicValueSchema } from "@a2ui/web_core/v1_0"
import { z } from "zod"

import { anyValue, labelsOf, seriesOf } from "./data.ts"
import { figuresOf } from "./figures.ts"
import { Trend } from "./trend.tsx"

export const LineChart = createComponentImplementation(
  {
    name: "LineChart",
    schema: z.object({
      labels: DynamicValueSchema,
      /** One to eight: `[{ name, values }]`, a value per label or null. */
      series: DynamicValueSchema,
      prefix: z.string().optional(),
      suffix: z.string().optional(),
      /** Px, else its own. */
      height: z.number().positive().optional(),
    }),
  },
  ({ props }) => {
    const labels = labelsOf(props.labels)
    const series = seriesOf(props.series, labels.length, false)
    return labels.length === 0 || !anyValue(series) ? null : (
      <Trend
        labels={labels}
        series={series}
        area={false}
        stacked={false}
        fig={figuresOf(props)}
        height={props.height}
      />
    )
  },
)
