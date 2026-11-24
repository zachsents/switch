// A stacked bar's segment: a gap of the background where it sits on the one under it, and the stack's
// data end rounded on the topmost.
import { Rectangle } from "recharts"
import type { BarShapeProps } from "recharts"

import { COLUMN_END, GAP, ROW_END } from "./look.ts"

interface Box {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

/** The side a segment starts on: a column's foot, a row's left (the other way below zero). */
const startOf = (horizontal: boolean, up: boolean): keyof Box => {
  if (horizontal) {
    return up ? "left" : "right"
  }
  return up ? "bottom" : "top"
}

/** Which way a side moves in. */
const INWARD = { left: GAP, right: -GAP, top: GAP, bottom: -GAP } as const

export const Segment = ({
  x = 0,
  y = 0,
  width = 0,
  height = 0,
  value,
  index = 0,
  stackedBarStart,
  series,
  color,
  tops,
  horizontal,
}: Partial<BarShapeProps> & {
  /** Which series it is, and its color. */
  series: number
  color: string
  /** The topmost series of each label's stack. */
  tops: readonly number[]
  horizontal: boolean
}) => {
  const up = !Array.isArray(value) || value[1] >= value[0]
  const box: Box = {
    left: Math.min(x, x + width),
    right: Math.max(x, x + width),
    top: Math.min(y, y + height),
    bottom: Math.max(y, y + height),
  }
  const side = startOf(horizontal, up)
  // It sits on another unless it starts where the stack does: a gap of the background between them.
  const sits = stackedBarStart === undefined || Math.abs(box[side] - stackedBarStart) > 0.5
  const b = sits ? { ...box, [side]: box[side] + INWARD[side] } : box
  if (b.right - b.left <= 0 || b.bottom - b.top <= 0) {
    return <g />
  }
  const end = horizontal ? ROW_END : COLUMN_END
  return (
    <Rectangle
      x={b.left}
      y={b.top}
      width={b.right - b.left}
      height={b.bottom - b.top}
      fill={color}
      radius={up && tops[index] === series ? end : 0}
    />
  )
}
