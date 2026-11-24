// A donut's slice, lifting under the pointer; Recharts gives it its geometry.
import { Sector } from "recharts"
import type { PieSectorShapeProps } from "recharts"

import { OTHER } from "./data.ts"
import { BACKGROUND, GAP } from "./look.ts"

export const Slice = ({
  cx = 0,
  cy = 0,
  innerRadius = 0,
  outerRadius = 0,
  startAngle = 0,
  endAngle = 0,
  fill = OTHER,
  isActive,
  gap,
}: Partial<PieSectorShapeProps> & { gap: boolean }) => (
  <Sector
    cx={cx}
    cy={cy}
    innerRadius={innerRadius}
    outerRadius={outerRadius}
    startAngle={startAngle}
    endAngle={endAngle}
    fill={fill}
    stroke={BACKGROUND}
    strokeWidth={gap ? GAP : 0}
    fillOpacity={isActive === true ? 0.8 : 1}
  />
)
