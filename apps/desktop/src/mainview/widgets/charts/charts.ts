// Switch's charts (switch-ext-kit's `SwitchParts`): plain data in, drawn in the house look.
import type { ReactCatalogComponent } from "@a2ui/react"

import { AreaChart } from "./area-chart.tsx"
import { BarChart } from "./bar-chart.tsx"
import { CalendarHeatmap } from "./calendar-heatmap.tsx"
import { DonutChart } from "./donut-chart.tsx"
import { Histogram } from "./histogram.tsx"
import { LineChart } from "./line-chart.tsx"
import { Meter } from "./meter.tsx"
import { ScatterChart } from "./scatter-chart.tsx"
import { Sparkline } from "./sparkline.tsx"

export const charts: ReactCatalogComponent[] = [
  BarChart,
  LineChart,
  AreaChart,
  Sparkline,
  DonutChart,
  ScatterChart,
  Histogram,
  CalendarHeatmap,
  Meter,
]
