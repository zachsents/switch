// A line per series over labels evenly spaced along the bottom, or each filled under its line (a
// wash), or stacked. Up to four lines end in a dot and their latest value; the crosshair's tooltip
// has every series at a label. A line's scale fits its values; an area's starts at zero.
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import type { Series } from "./data.ts"
import { numberOf, OTHER } from "./data.ts"
import { Ends } from "./ends.tsx"
import type { End } from "./ends.tsx"
import type { Figures } from "./figures.ts"
import { figure, tick } from "./figures.ts"
import { Legend } from "./legend.tsx"
import { Lone } from "./lone.tsx"
import {
  BACKGROUND,
  BASELINE,
  BESIDE,
  CROSSHAIR,
  DOT,
  GRID,
  HEIGHT,
  LINE,
  RING,
  TICK,
  WASH,
  widthOf,
} from "./look.ts"
import { rowsOf, valueScale } from "./rows.ts"
import { Tip } from "./tip.tsx"
import type { ReadTip } from "./tip.tsx"

/** Lines ending in their value, at most. */
const LABELLED = 4

/** Each series' latest value, where it is. */
const endsOf = (series: readonly Series[], fig: Figures): readonly End[] =>
  series.flatMap((s) => {
    const at = s.values.findLastIndex((v) => v !== null)
    const value = s.values[at] ?? null
    return value === null ? [] : [{ at, value, text: figure(value, fig), color: s.color }]
  })

export const Trend = ({
  labels,
  series,
  area,
  stacked,
  fig,
  height,
}: {
  labels: readonly string[]
  series: readonly Series[]
  area: boolean
  stacked: boolean
  fig: Figures
  height: number | undefined
}) => {
  const labelAt = (i: unknown) => (typeof i === "number" ? (labels[i] ?? "") : "")
  const ends = stacked || series.length > LABELLED ? [] : endsOf(series, fig)
  const room = Math.max(0, ...ends.map((e) => widthOf(e.text)))
  const read: ReadTip = (payload, label) => ({
    title: labelAt(label),
    rows: payload.flatMap((e) => {
      const v = numberOf(e.value)
      return v === null
        ? []
        : [{ value: figure(v, fig), name: String(e.name ?? ""), color: e.color ?? OTHER }]
    }),
  })
  const active = { r: DOT + RING / 2, stroke: BACKGROUND, strokeWidth: RING }
  const scale = valueScale(series, labels.length, { stacked, zero: area })
  return (
    <div className="px-inset py-2">
      <Legend items={series} kind={area ? "square" : "line"} />
      <ComposedChart
        data={rowsOf(series, labels.length)}
        responsive
        style={{ width: "100%", height: height ?? HEIGHT }}
        margin={{
          top: 8,
          right: ends.length > 0 ? room + DOT + BESIDE + 4 : 8,
          bottom: 0,
          left: 0,
        }}
      >
        <CartesianGrid vertical={false} {...GRID} />
        <XAxis
          type="category"
          dataKey="i"
          scale="point"
          axisLine={BASELINE}
          tickLine={false}
          tick={TICK}
          tickFormatter={labelAt}
          interval="preserveStartEnd"
          minTickGap={8}
          height={20}
        />
        <YAxis
          type="number"
          domain={scale.domain}
          ticks={scale.ticks}
          axisLine={false}
          tickLine={false}
          tick={TICK}
          tickFormatter={(v: number) => tick(v, fig)}
          width="auto"
        />
        <ReferenceLine y={0} {...BASELINE} />
        {series.map((s, k) =>
          area ? (
            <Area
              key={`${s.name}-${s.color}`}
              type="linear"
              dataKey={`s${k}`}
              name={s.name}
              stroke={s.color}
              strokeWidth={LINE}
              fill={s.color}
              fillOpacity={WASH}
              activeDot={{ ...active, fill: s.color }}
              isAnimationActive={false}
              {...(stacked ? { stackId: "stack" } : {})}
            />
          ) : (
            <Line
              key={`${s.name}-${s.color}`}
              type="linear"
              dataKey={`s${k}`}
              name={s.name}
              stroke={s.color}
              strokeWidth={LINE}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={<Lone values={s.values} color={s.color} />}
              activeDot={{ ...active, fill: s.color }}
              isAnimationActive={false}
            />
          ),
        )}
        {ends.length > 0 && <Ends ends={ends} />}
        <Tooltip content={<Tip read={read} />} cursor={CROSSHAIR} isAnimationActive={false} />
      </ComposedChart>
    </div>
  )
}
