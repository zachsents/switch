// A value per day, as weeks of squares, darker for more.
import { createComponentImplementation } from "@a2ui/react"
import { DynamicValueSchema } from "@a2ui/web_core/v1_0"
import { z } from "zod"

import { Calendar } from "./calendar.tsx"
import { daysOf } from "./data.ts"
import { figuresOf } from "./figures.ts"

export const CalendarHeatmap = createComponentImplementation(
  {
    name: "CalendarHeatmap",
    schema: z.object({
      /** `[{ date: "YYYY-MM-DD", value }]`. */
      days: DynamicValueSchema,
      prefix: z.string().optional(),
      suffix: z.string().optional(),
    }),
  },
  ({ props }) => {
    const days = daysOf(props.days)
    return days.size === 0 ? null : <Calendar days={days} fig={figuresOf(props)} />
  },
)
