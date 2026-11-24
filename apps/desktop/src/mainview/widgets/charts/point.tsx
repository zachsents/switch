// A point: an 8 px dot in a 2 px ring of the background, so points stay legible where they overlap;
// its hit 24 px across, wider than it.
import { BACKGROUND, DOT, RING } from "./look.ts"

/** Half a point's hit, wider than its dot. */
const HIT = 12

export const Point = ({ cx, cy, color }: { cx?: number; cy?: number; color: string }) =>
  cx === undefined || cy === undefined ? (
    <g />
  ) : (
    <g>
      <circle cx={cx} cy={cy} r={HIT} fill="transparent" />
      <circle cx={cx} cy={cy} r={DOT + RING} fill={BACKGROUND} />
      <circle cx={cx} cy={cy} r={DOT} fill={color} />
    </g>
  )
