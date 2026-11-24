// Bars for each label: a series each, side by side or stacked; columns, or rows when horizontal. Past
// eight series, stacked ones fold the rest into Other and side-by-side ones draw the first eight. A
// single series, or a stack, labels its extreme; the tooltip has every series at a label.
import { createComponentImplementation } from "@a2ui/react"
import { DynamicValueSchema } from "@a2ui/web_core/v1_0"
import {
  Bar,
  BarChart as Chart,
  CartesianGrid,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import { z } from "zod"

import { anyValue, labelsOf, numberOf, OTHER, seriesOf } from "./data.ts"
import { figure, figuresOf, tick } from "./figures.ts"
import { Legend } from "./legend.tsx"
import {
  BAND,
  BAR,
  BASELINE,
  BESIDE,
  COLUMN_END,
  GAP,
  GRID,
  HEIGHT,
  ROW_END,
  TICK,
  widthOf,
} from "./look.ts"
import { Peak } from "./peak.tsx"
import { peakOf, rowsOf, sumAt, topsOf, valueScale } from "./rows.ts"
import { Segment } from "./segment.tsx"
import { Tip } from "./tip.tsx"
import type { ReadTip } from "./tip.tsx"

export const BarChart = createComponentImplementation(
  {
    name: "BarChart",
    schema: z.object({
      labels: DynamicValueSchema,
      /** One to eight: `[{ name, values }]`, a value per label or null. */
      series: DynamicValueSchema,
      stacked: z.boolean().optional(),
      horizontal: z.boolean().optional(),
      prefix: z.string().optional(),
      suffix: z.string().optional(),
      /** Px, else its own. */
      height: z.number().positive().optional(),
    }),
  },
  ({ props }) => {
    const labels = labelsOf(props.labels)
    const stacked = props.stacked === true
    const horizontal = props.horizontal === true
    const series = seriesOf(props.series, labels.length, stacked)
    if (labels.length === 0 || !anyValue(series)) {
      return null
    }
    const fig = figuresOf(props)
    const labelAt = (i: unknown) => (typeof i === "number" ? (labels[i] ?? "") : "")
    const peak =
      stacked || series.length === 1 ? peakOf(labels.map((_, j) => sumAt(series, j))) : null
    const peakText = peak ? figure(peak.value, fig) : ""
    const read: ReadTip = (payload, label) => ({
      title: labelAt(label),
      rows: payload.flatMap((e) => {
        const v = numberOf(e.value)
        return v === null
          ? []
          : [{ value: figure(v, fig), name: String(e.name ?? ""), color: e.color ?? OTHER }]
      }),
    })
    const tops = topsOf(series, labels.length)
    const scale = valueScale(series, labels.length, { stacked, zero: true })
    const value = {
      type: "number",
      axisLine: false,
      tickLine: false,
      tick: TICK,
      domain: scale.domain,
      ticks: scale.ticks,
    } as const
    const category = {
      type: "category",
      dataKey: "i",
      axisLine: false,
      tickLine: false,
      tick: TICK,
      tickFormatter: labelAt,
    } as const
    return (
      <div className="px-inset py-2">
        <Legend items={series} kind="square" />
        <Chart
          data={rowsOf(series, labels.length)}
          layout={horizontal ? "vertical" : "horizontal"}
          responsive
          style={{ width: "100%", height: props.height ?? HEIGHT }}
          margin={{
            top: peak && !horizontal ? 16 : 6,
            right: peak && horizontal ? widthOf(peakText) + BESIDE + 4 : 6,
            bottom: 0,
            left: 0,
          }}
          barGap={GAP}
        >
          <CartesianGrid horizontal={!horizontal} vertical={horizontal} {...GRID} />
          {horizontal ? (
            <XAxis {...value} tickFormatter={(v: number) => tick(v, fig)} height={20} />
          ) : (
            <XAxis {...category} interval="preserveStartEnd" minTickGap={8} height={20} />
          )}
          {horizontal ? (
            <YAxis {...category} width="auto" interval={0} />
          ) : (
            <YAxis {...value} tickFormatter={(v: number) => tick(v, fig)} width="auto" />
          )}
          {series.map((s, k) =>
            stacked ? (
              <Bar
                key={`${s.name}-${s.color}`}
                dataKey={`s${k}`}
                name={s.name}
                fill={s.color}
                stackId="stack"
                maxBarSize={BAR}
                isAnimationActive={false}
                shape={<Segment series={k} color={s.color} tops={tops} horizontal={horizontal} />}
              />
            ) : (
              <Bar
                key={`${s.name}-${s.color}`}
                dataKey={`s${k}`}
                name={s.name}
                fill={s.color}
                maxBarSize={BAR}
                isAnimationActive={false}
                radius={horizontal ? ROW_END : COLUMN_END}
              />
            ),
          )}
          {horizontal ? (
            <ReferenceLine x={0} {...BASELINE} />
          ) : (
            <ReferenceLine y={0} {...BASELINE} />
          )}
          {peak && <Peak at={peak.at} value={peak.value} text={peakText} horizontal={horizontal} />}
          <Tooltip content={<Tip read={read} />} cursor={BAND} isAnimationActive={false} />
        </Chart>
      </div>
    )
  },
)
