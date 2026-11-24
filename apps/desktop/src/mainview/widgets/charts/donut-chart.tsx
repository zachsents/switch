// Parts of a whole round a ring, the total in it; beside it each part's key, name and figure, in
// order. Past six slices, the rest fold into Other. The pointer shows a slice's value and share, the
// slice lifting.
import { createComponentImplementation } from "@a2ui/react"
import { DynamicValueSchema } from "@a2ui/web_core/v1_0"
import { Pie, PieChart, Tooltip } from "recharts"
import { z } from "zod"

import { numberOf, OTHER, slicesOf } from "./data.ts"
import { figure, figuresOf, headline, percent } from "./figures.ts"
import { Key } from "./key.tsx"
import { Slice } from "./slice.tsx"
import { Tip } from "./tip.tsx"
import type { ReadTip } from "./tip.tsx"

/** The ring's box, and its edges: a thin ring. */
const SIZE = 140
const OUTER = 70
const INNER = 53

export const DonutChart = createComponentImplementation(
  {
    name: "DonutChart",
    schema: z.object({
      /** `[{ label, value }]`, six at most reading at a glance. */
      slices: DynamicValueSchema,
      prefix: z.string().optional(),
      suffix: z.string().optional(),
    }),
  },
  ({ props }) => {
    const slices = slicesOf(props.slices)
    if (slices.length === 0) {
      return null
    }
    const fig = figuresOf(props)
    let total = 0
    for (const s of slices) {
      total += s.value
    }
    const read: ReadTip = (payload) => ({
      title: "",
      rows: payload.flatMap((e) => {
        const v = numberOf(e.value)
        const slice = slices.find((s) => s.label === e.name && s.value === v)
        return v === null || !slice
          ? []
          : [
              {
                value: figure(v, fig),
                name: slice.label,
                color: slice.color,
                note: percent(v / total),
              },
            ]
      }),
    })
    return (
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-inset py-2">
        <div className="relative flex-none">
          <PieChart width={SIZE} height={SIZE} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
            <Pie
              data={slices.map((s) => ({ label: s.label, value: s.value, fill: s.color }))}
              dataKey="value"
              nameKey="label"
              cx="50%"
              cy="50%"
              innerRadius={INNER}
              outerRadius={OUTER}
              startAngle={90}
              endAngle={-270}
              shape={<Slice gap={slices.length > 1} />}
              isAnimationActive={false}
            />
            <Tooltip
              content={<Tip read={read} />}
              allowEscapeViewBox={{ x: true, y: true }}
              isAnimationActive={false}
            />
          </PieChart>
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-title font-semibold text-ink proportional-nums">
            {headline(total, fig)}
          </span>
        </div>
        <ul className="m-0 grid max-w-[260px] min-w-[160px] flex-1 list-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1.5 p-0">
          {slices.map((s) => (
            <li key={`${s.label}-${s.color}`} className="contents">
              <Key kind="square" color={s.color === OTHER ? OTHER : s.color} />
              <span className="trim truncate text-small text-ink2">{s.label}</span>
              <span className="trim text-right text-small text-ink tabular-nums">
                {figure(s.value, fig)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    )
  },
)
