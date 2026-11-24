// The gallery's charts (`#gallery`, dev builds): each chart in its states, as A2UI messages a widget
// would send, its data in the components or bound to the surface's data model.
import { surface, SWITCH_CATALOG } from "switch-ext-kit"
import type { SwitchComponent } from "switch-ext-kit"

export interface Fixture {
  readonly id: string
  readonly name: string
  readonly width: number
  readonly messages: readonly unknown[]
}

type Chart = SwitchComponent extends infer C ? (C extends unknown ? Omit<C, "id"> : never) : never

const fixture = (
  id: string,
  name: string,
  chart: Chart,
  data?: Readonly<Record<string, unknown>>,
  width = 420,
): Fixture => {
  const root: Record<string, unknown> = { id: "root", ...chart }
  return {
    id,
    name,
    width,
    messages: [
      ...surface(id, SWITCH_CATALOG, [root]),
      ...(data
        ? [{ version: "1.0", updateDataModel: { surfaceId: id, path: "/", value: data } }]
        : []),
    ],
  }
}

/** Numbers that look measured, the same every time. */
const wave = (n: number, base: number, swing: number, seed: number) =>
  Array.from({ length: n }, (_, i) =>
    Math.round(
      base + swing * Math.sin(i * 0.7 + seed) + (swing / 3) * Math.sin(i * 2.3 + seed * 3),
    ),
  )

const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const NAMES = [
  "North",
  "South",
  "East",
  "West",
  "Central",
  "Coast",
  "Hills",
  "Lakes",
  "Plains",
  "Ridge",
]

const many = (n: number, count: number) =>
  NAMES.slice(0, n).map((name, k) => ({ name, values: wave(count, 20 + k * 3, 6, k) }))

/** A bell of `n` values round `mid`. */
const spread = (n: number, mid: number, width: number) =>
  Array.from({ length: n }, (_, i) => {
    const a = Math.sin(i * 12.9898) * 43_758.5453
    const b = Math.sin(i * 78.233) * 12_345.6789
    const c = Math.sin(i * 39.425) * 24_634.6345
    const u = (a - Math.floor(a) + (b - Math.floor(b)) + (c - Math.floor(c))) / 3
    return Math.round((mid + (u - 0.5) * 2 * width) * 10) / 10
  })

/** A value for each day of `days` up to `to`, some days with none. */
const daily = (to: string, days: number, gaps: boolean) => {
  const last = Temporal.PlainDate.from(to)
  return Array.from({ length: days }, (_, i) => {
    const day = last.subtract({ days: days - 1 - i })
    const v = Math.max(0, Math.round(4 + 4 * Math.sin(i * 0.31) + 3 * Math.sin(i * 1.7)))
    return { date: day.toString(), value: gaps && i % 9 === 4 ? null : v }
  }).flatMap((d) => (d.value === null ? [] : [{ date: d.date, value: d.value }]))
}

const points = (n: number, seed: number, slope: number) =>
  Array.from({ length: n }, (_, i) => {
    const x = Math.round((10 + ((i * 37 + seed * 11) % 60)) * 10) / 10
    const y = Math.round((slope * x + 8 * Math.sin(i * 1.3 + seed) + seed * 6) * 10) / 10
    return [x, y] as const
  })

export const FIXTURES: readonly (readonly [string, readonly Fixture[]])[] = [
  [
    "Bar chart",
    [
      fixture("bar-columns", "Columns", {
        component: "BarChart",
        labels: WEEK,
        series: [{ name: "Orders", values: [12, 18, 9, 22, 30, 14, 7] }],
      }),
      fixture("bar-grouped", "Grouped", {
        component: "BarChart",
        labels: ["Q1", "Q2", "Q3", "Q4"],
        series: many(3, 4),
      }),
      fixture("bar-stacked", "Stacked", {
        component: "BarChart",
        labels: MONTHS.slice(0, 6),
        series: many(4, 6).map((s) => ({ ...s, values: s.values.map((v) => v * 120) })),
        stacked: true,
        prefix: "$",
      }),
      fixture("bar-rows", "Horizontal", {
        component: "BarChart",
        labels: ["Search", "Direct", "Email", "Social", "Referral"],
        series: [{ name: "Visits", values: [4820, 3110, 1460, 980, 410] }],
        horizontal: true,
      }),
      fixture("bar-rows-stacked", "Horizontal stacked", {
        component: "BarChart",
        labels: ["Kitchen", "Office", "Garage", "Porch"],
        series: [
          { name: "Done", values: [6, 3, 8, 2] },
          { name: "Open", values: [2, 5, 1, 4] },
        ],
        horizontal: true,
        stacked: true,
      }),
      fixture("bar-folded", "Ten stacked", {
        component: "BarChart",
        labels: MONTHS.slice(0, 6),
        series: many(10, 6),
        stacked: true,
      }),
      fixture("bar-negative", "Below zero", {
        component: "BarChart",
        labels: MONTHS.slice(0, 8),
        series: [{ name: "Margin", values: [4.2, 2.8, -1.5, -3.1, 0.6, 3.9, 5.4, -0.8] }],
        suffix: "%",
      }),
      fixture(
        "bar-bound",
        "Bound",
        {
          component: "BarChart",
          labels: { "@path": "/labels" },
          series: { "@path": "/series" },
          height: 140,
        },
        {
          labels: ["A", "B", "C", "D", "E"],
          series: [{ name: "Count", values: [3, null, 5, 2, 4] }],
        },
      ),
      fixture("bar-empty", "Unreadable", {
        component: "BarChart",
        labels: { "@path": "/missing" },
        series: [{ name: "None", values: [] }],
      }),
    ],
  ],
  [
    "Line chart",
    [
      fixture("line-one", "One", {
        component: "LineChart",
        labels: MONTHS,
        series: [{ name: "Visits", values: wave(12, 1800, 600, 1) }],
      }),
      fixture("line-three", "Three", {
        component: "LineChart",
        labels: MONTHS,
        series: [
          { name: "North", values: wave(12, 62, 9, 0) },
          { name: "South", values: wave(12, 41, 7, 2) },
          { name: "West", values: wave(12, 20, 5, 4) },
        ],
        suffix: "°",
      }),
      fixture("line-gaps", "Gaps", {
        component: "LineChart",
        labels: WEEK,
        series: [
          { name: "Morning", values: [71.2, 71, null, 70.6, 70.9, null, 70.4] },
          { name: "Evening", values: [72, 71.8, 71.5, null, 71.6, 71.2, 71.1] },
        ],
        suffix: " kg",
      }),
      fixture("line-folded", "Ten", {
        component: "LineChart",
        labels: MONTHS,
        series: many(10, 12),
      }),
    ],
  ],
  [
    "Area chart",
    [
      fixture("area-overlaid", "Overlaid", {
        component: "AreaChart",
        labels: MONTHS,
        series: [
          { name: "Sent", values: wave(12, 40, 12, 1) },
          { name: "Opened", values: wave(12, 22, 8, 1.4) },
        ],
      }),
      fixture("area-stacked", "Stacked", {
        component: "AreaChart",
        labels: MONTHS,
        series: many(3, 12),
        stacked: true,
      }),
      fixture("area-folded", "Ten stacked", {
        component: "AreaChart",
        labels: MONTHS,
        series: many(10, 12),
        stacked: true,
      }),
    ],
  ],
  [
    "Sparkline",
    [
      fixture("spark-line", "A line's height", {
        component: "Sparkline",
        values: wave(24, 50, 15, 2),
      }),
      fixture("spark-tall", "48 px", {
        component: "Sparkline",
        values: wave(30, 120, 40, 5),
        height: 48,
      }),
      fixture("spark-one", "One value", { component: "Sparkline", values: [3] }),
      fixture(
        "spark-bound",
        "Bound",
        { component: "Sparkline", values: { "@path": "/trend" } },
        { trend: wave(16, 10, 4, 3) },
      ),
    ],
  ],
  [
    "Donut chart",
    [
      fixture("donut-four", "Four", {
        component: "DonutChart",
        slices: [
          { label: "Photos", value: 182 },
          { label: "Apps", value: 96 },
          { label: "Mail", value: 41 },
          { label: "System", value: 28 },
        ],
        suffix: " GB",
      }),
      fixture("donut-folded", "Nine", {
        component: "DonutChart",
        slices: NAMES.slice(0, 9).map((label, i) => ({ label, value: 90 - i * 9 })),
      }),
      fixture("donut-one", "One", {
        component: "DonutChart",
        slices: [{ label: "Paid", value: 14_250 }],
        prefix: "$",
      }),
    ],
  ],
  [
    "Scatter chart",
    [
      fixture("scatter-one", "One", {
        component: "ScatterChart",
        series: [{ name: "Builds", points: points(40, 1, 0.8) }],
        xLabel: "Files",
        yLabel: "Seconds",
      }),
      fixture("scatter-three", "Three", {
        component: "ScatterChart",
        series: [
          { name: "Small", points: points(20, 1, 0.6) },
          { name: "Medium", points: points(20, 2, 0.9) },
          { name: "Large", points: points(20, 3, 1.2) },
        ],
      }),
      fixture("scatter-five", "Five", {
        component: "ScatterChart",
        series: [1, 2, 3, 4, 5].map((k) => ({ name: NAMES[k] ?? "", points: points(12, k, 0.5) })),
      }),
    ],
  ],
  [
    "Histogram",
    [
      fixture("hist-own", "Its own bins", {
        component: "Histogram",
        values: spread(240, 38, 30),
        suffix: " ms",
      }),
      fixture("hist-six", "Six bins", {
        component: "Histogram",
        values: spread(80, 120, 60),
        bins: 6,
        prefix: "$",
      }),
    ],
  ],
  [
    "Calendar heatmap",
    [
      fixture(
        "cal-year",
        "A year",
        { component: "CalendarHeatmap", days: daily("2026-11-21", 365, false) },
        undefined,
        860,
      ),
      fixture("cal-weeks", "Six weeks, some days none", {
        component: "CalendarHeatmap",
        days: daily("2026-11-21", 42, true),
      }),
      fixture(
        "cal-bound",
        "Bound, narrow",
        { component: "CalendarHeatmap", days: { "@path": "/days" } },
        { days: daily("2026-11-21", 120, false) },
        240,
      ),
    ],
  ],
  [
    "Meter",
    [
      fixture("meter-share", "Share", { component: "Meter", label: "Disk", value: 62 }),
      fixture("meter-suffix", "Suffix", {
        component: "Meter",
        label: "Memory",
        value: 11.2,
        max: 16,
        suffix: " GB",
      }),
      fixture("meter-over", "Over", { component: "Meter", label: "Battery", value: 120 }),
      fixture("meter-bare", "No label", { component: "Meter", value: 35 }),
      fixture(
        "meter-bound",
        "Bound",
        { component: "Meter", label: { "@path": "/name" }, value: { "@path": "/used" } },
        { name: "Storage", used: 8 },
      ),
    ],
  ],
]
