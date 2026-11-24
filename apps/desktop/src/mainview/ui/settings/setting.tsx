// A setting's row: its label at a fixed width (`w`), its control beside it, on a line-2.
import type { ReactNode } from "react"

export const Setting = ({
  label,
  w = "w-40",
  children,
}: {
  label: string
  w?: string
  children: ReactNode
}) => (
  <div className="flex min-h-9 items-center gap-3 px-inset py-1.5 line-2-b">
    <span title={label} className={`trim ${w} flex-none truncate text-ui text-ink2`}>
      {label}
    </span>
    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</span>
  </div>
)

/** A group of settings under its heading, and what acts on the group at the heading's end. */
export const Group = ({
  label,
  action,
  children,
}: {
  label: string
  action?: ReactNode
  children: ReactNode
}) => (
  <section className="flex flex-col">
    <div className="flex h-line items-center gap-1 px-inset line-2-b">
      <h2 className="m-0 min-w-0 flex-1 truncate text-ui font-semibold text-ink">
        <span className="trim">{label}</span>
      </h2>
      {action}
    </div>
    {children}
  </section>
)
