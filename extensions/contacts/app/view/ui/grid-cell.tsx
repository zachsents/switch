// A cell of the details grid: its label, then what it holds edge to edge. Two to a line, hairlines
// between; a wide one takes the whole line.
import type { ReactNode } from "react"

export const GridCell = ({
  label,
  children,
  wide = false,
  top = false,
}: {
  label: string
  children: ReactNode
  wide?: boolean
  /** Label at the top, for what grows downward. */
  top?: boolean
}) => (
  <li
    className={`group flex min-h-line min-w-0 hairline-b focus-within:bg-wash hover:bg-wash ${wide ? "col-span-2" : "odd:hairline-r"} ${top ? "items-start" : "items-center"}`}
  >
    <span
      className={`w-label flex-none truncate px-inset text-small text-ink2 ${top ? "py-[10px]" : ""}`}
    >
      {label}
    </span>
    {children}
  </li>
)
