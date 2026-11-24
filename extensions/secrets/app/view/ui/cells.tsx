// A section's line as cells: what it is, then its value, and keys at its end.
import type { ReactNode } from "react"

export const Cells = ({
  label,
  children,
  end,
}: {
  label: ReactNode
  children: ReactNode
  end?: ReactNode
}) => (
  <li className="group flex min-h-line items-center hairline-b last:after:hidden">
    <span className="w-label flex-none truncate px-inset text-small text-ink2">{label}</span>
    <span className="selectable min-w-0 flex-1 py-2 pr-3 text-ui break-words text-ink">
      {children}
    </span>
    {end !== undefined && <span className="flex flex-none items-center gap-1 pr-inset">{end}</span>}
  </li>
)
