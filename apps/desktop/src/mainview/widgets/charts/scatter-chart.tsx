// Points by two measures: a dot each in a ring of the background, its hit wider than it. Three series
// at most stay apart side by side; past them the rest aren't drawn. Each axis fits its values; their
// names sit over the y axis and under the x axis's end.
import { createComponentImplementation } from "@a2ui/react"
import { DynamicValueSchema } from "@a2ui/web_core/v1_0"
import { CartesianGrid, Scatter, ScatterChart as Chart, Tooltip, XAxis, YAxis } from "recharts"
import { z } from "zod"

import { numberOf, pointsOf } from "./data.ts"
import { BARE, figure, tick } from "./figures.ts"
import { Legend } from "./legend.tsx"
import { BASELINE, GRID, HEIGHT, TICK } from "./look.ts"
import { Point } from "./point.tsx"
import { extentOf, scaleOf } from "./ticks.ts"
import { Tip } from "./tip.tsx"
import type { ReadTip } from "./tip.tsx"

const label = (x: unknown) => (typeof x === "string" ? x : "")

export const ScatterChart = createComponentImplementation(
  {
    name: "ScatterChart",
    schema: z.object({
      /** `[{ name, points: [[x, y], …] }]`, three at most. */
      series: DynamicValueSchema,
      xLabel: z.string().optional(),
      yLabel: z.string().optional(),
      /** Px, else its own. */
      height: z.number().positive().optional(),
    }),
  },
  ({ props }) => {
    const series = pointsOf(props.series)
    if (series.length === 0) {
      return null
    }
    const xLabel = label(props.xLabel)
    const yLabel = label(props.yLabel)
    const read: ReadTip = (payload) => {
      const [x, y] = payload
      const s = series.find((p) => p.color === x?.color)
      const xv = numberOf(x?.value)
      const yv = numberOf(y?.value)
      return !s || xv === null || yv === null
        ? null
        : {
            title: series.length > 1 ? s.name : "",
            rows: [
              { value: figure(xv, BARE), name: xLabel === "" ? "x" : xLabel, color: s.color },
              { value: figure(yv, BARE), name: yLabel === "" ? "y" : yLabel, color: s.color },
            ],
          }
    }
    const xs = extentOf(series.flatMap((s) => s.points.map((p) => p.x)))
    const ys = extentOf(series.flatMap((s) => s.points.map((p) => p.y)))
    const x = scaleOf(xs?.min ?? 0, xs?.max ?? 0, { zero: false })
    const y = scaleOf(ys?.min ?? 0, ys?.max ?? 0, { zero: false })
    const axis = {
      type: "number",
      tickLine: false,
      tick: TICK,
      tickFormatter: (v: number) => tick(v, BARE),
    } as const
    return (
      <div className="flex flex-col px-inset py-2">
        <Legend items={series} kind="dot" />
        {yLabel !== "" && <span className="trim pb-1.5 text-caption text-ink3">{yLabel}</span>}
        <Chart
          responsive
          style={{ width: "100%", height: props.height ?? HEIGHT }}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
        >
          <CartesianGrid vertical={false} {...GRID} />
          <XAxis
            {...axis}
            dataKey="x"
            name={xLabel}
            domain={x.domain}
            ticks={x.ticks}
            axisLine={BASELINE}
            height={20}
          />
          <YAxis
            {...axis}
            dataKey="y"
            name={yLabel}
            domain={y.domain}
            ticks={y.ticks}
            axisLine={false}
            width="auto"
          />
          {series.map((s) => (
            <Scatter
              key={`${s.name}-${s.color}`}
              name={s.name}
              data={s.points}
              fill={s.color}
              shape={<Point color={s.color} />}
              isAnimationActive={false}
            />
          ))}
          <Tooltip content={<Tip read={read} />} cursor={false} isAnimationActive={false} />
        </Chart>
        {xLabel !== "" && (
          <span className="trim self-end pt-1 text-caption text-ink3">{xLabel}</span>
        )}
      </div>
    )
  },
)
