// A value with none either side of it, which a line can't draw: a dot, so it isn't lost.
import { DOT } from "./look.ts"

export const Lone = ({
  cx,
  cy,
  index,
  values,
  color,
}: {
  cx?: number
  cy?: number
  index?: number
  values: readonly (number | null)[]
  color: string
}) => {
  const lone =
    index !== undefined &&
    values[index] !== null &&
    (values[index - 1] ?? null) === null &&
    (values[index + 1] ?? null) === null
  return lone && cx !== undefined && cy !== undefined ? (
    <circle cx={cx} cy={cy} r={DOT / 2 + 1} fill={color} />
  ) : (
    <g />
  )
}
