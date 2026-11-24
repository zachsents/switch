// How A2UI's Row, Column and List place their children: `justify` along them and `align` across, as
// A2UI's own do (CSS's own values), and a child's `weight`, its share of the room (flex-grow).
import type { CSSProperties } from "react"

export const JUSTIFY = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  spaceBetween: "justify-between",
  spaceAround: "justify-around",
  spaceEvenly: "justify-evenly",
  // An equal share each, as old Switchboard's did (plain's a2ui-gpui).
  stretch: "[&>*>*]:min-w-0 [&>*>*]:flex-1",
} as const

export const ALIGN = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
} as const

/** A part's share of its Row's or Column's room, from its `weight`. */
export const share = (weight: number | undefined): CSSProperties | undefined =>
  weight === undefined ? undefined : { flex: weight }
