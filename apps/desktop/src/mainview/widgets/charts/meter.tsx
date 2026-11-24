// How full something is: a line with its label, a track filled to `value` of `max` (100), and the
// figure (with a prefix or suffix, else the share). The fill is the first series' color, square where
// it starts and rounded at its end; the track the lightest step of its hue.
import { createComponentImplementation } from "@a2ui/react"
import { DynamicStringSchema, DynamicValueSchema } from "@a2ui/web_core/v1_0"
import { z } from "zod"

import { numberOf, SCALE, SERIES } from "./data.ts"
import { figure, figuresOf, percent } from "./figures.ts"

/** The track's height, and its end's radius. */
const TRACK = 6
const END = 3

export const Meter = createComponentImplementation(
  {
    name: "Meter",
    schema: z.object({
      label: DynamicStringSchema.optional(),
      value: DynamicValueSchema,
      /** What full is, 100 unless given. */
      max: z.number().positive().optional(),
      prefix: z.string().optional(),
      suffix: z.string().optional(),
    }),
  },
  ({ props }) => {
    const value = numberOf(props.value)
    if (value === null) {
      return null
    }
    const max = props.max ?? 100
    const share = Math.min(1, Math.max(0, value / max))
    const fig = figuresOf(props)
    const label = typeof props.label === "string" ? props.label : ""
    return (
      <div className="flex h-line items-center gap-2.5 px-inset text-ui text-ink">
        {label !== "" && <span className="trim w-1/4 min-w-16 flex-none truncate">{label}</span>}
        <svg aria-hidden height={TRACK} className="block min-w-12 flex-1">
          <rect width="100%" height={TRACK} rx={END} fill={SCALE[0]} />
          <rect width={END} height={TRACK} fill={SCALE[0]} />
          {share > 0 && (
            <>
              <rect width={`${share * 100}%`} height={TRACK} rx={END} fill={SERIES[0]} />
              <rect width={END} height={TRACK} fill={SERIES[0]} />
            </>
          )}
        </svg>
        <span className="trim flex-none text-caption text-ink2 tabular-nums">
          {fig.prefix === "" && fig.suffix === "" ? percent(value / max) : figure(value, fig)}
        </span>
      </div>
    )
  },
)
