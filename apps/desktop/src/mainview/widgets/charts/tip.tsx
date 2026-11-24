// A Recharts chart's tooltip: Recharts gives it what's under the pointer; `read` says what that
// reads as, drawn as what floats over a chart.
import type { TooltipPayloadEntry } from "recharts"

import { TipBox } from "./tip-box.tsx"
import type { TipRead } from "./tip-box.tsx"

export type ReadTip = (
  payload: readonly TooltipPayloadEntry[],
  label: string | number | undefined,
) => TipRead | null

export const Tip = ({
  active,
  payload,
  label,
  read,
}: {
  active?: boolean
  payload?: readonly TooltipPayloadEntry[]
  label?: string | number
  read: ReadTip
}) => {
  const shown = active === true && payload && payload.length > 0 ? read(payload, label) : null
  return shown && shown.rows.length > 0 ? <TipBox title={shown.title} rows={shown.rows} /> : null
}
