// The grid's parts, as Switch's desktop has them: a section under a heavy rule, its heading, its
// lines on hairlines; keys.
import { Tooltip } from "@base-ui/react/tooltip"
import type { ButtonHTMLAttributes, ReactElement, ReactNode } from "react"

/** A section of the board: a heavy rule, its heading, then its lines. */
export const Section = ({
  mark,
  label,
  count,
  action,
  children,
}: {
  mark?: ReactNode
  label: string
  count?: number
  /** A key at the heading's end. */
  action?: ReactNode
  children: ReactNode
}) => (
  <section className="heavy-t first:border-t-0">
    <h2 className="flex h-head items-center gap-2 px-inset text-small font-semibold tracking-[0.06em] text-ink uppercase">
      {mark}
      <span>{label}</span>
      {count !== undefined && count > 0 && (
        <span className="ml-auto font-mono text-data font-normal tracking-normal text-ink3">
          {count}
        </span>
      )}
      {action !== undefined && (
        <span
          className={`flex items-center gap-2 font-normal tracking-normal normal-case ${count !== undefined && count > 0 ? "ml-3" : "ml-auto"}`}
        >
          {action}
        </span>
      )}
    </h2>
    <ul className="m-0 list-none p-0">{children}</ul>
  </section>
)

/** A line of the board: 36 high, the whole line is the click, lit under the pointer. */
export const Row = ({
  onClick,
  children,
  title,
}: {
  onClick?: () => void
  children: ReactNode
  title?: string
}) => (
  <li className="hairline-b last:after:hidden">
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex h-line w-full items-center gap-2.5 bg-transparent px-inset text-left text-ui text-ink outline-none hover:bg-wash focus-visible:bg-selection active:bg-selection"
    >
      {children}
    </button>
  </li>
)

/** Figures at a line's end: when, how many. */
export const Data = ({ children }: { children: ReactNode }) => (
  <span className="ml-auto flex-none pl-3 font-mono text-data text-ink3">{children}</span>
)

/** A raised key, lit from above, sinking a point when pressed; `go` is the green one that sends. */
export const Key = ({
  go = false,
  children,
  className = "",
  ...props
}: { go?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button
    type="button"
    {...props}
    className={`inline-flex h-[26px] flex-none items-center gap-2 rounded-row border px-[11px] text-small font-medium outline-none select-none active:translate-y-px active:shadow-none disabled:opacity-40 ${
      go
        ? "border-go-border bg-linear-to-b from-go-top to-go-foot text-white shadow-go"
        : "border-key-border bg-linear-to-b from-key-top to-key-foot text-ink shadow-key"
    } ${className}`}
  >
    {children}
  </button>
)

/** A tooltip the moment the pointer is over it, centered under it. */
export const Tip = ({ label, children }: { label: string; children: ReactElement }) => (
  <Tooltip.Root>
    <Tooltip.Trigger delay={0} closeDelay={0} render={children} />
    <Tooltip.Portal>
      <Tooltip.Positioner side="bottom" sideOffset={6}>
        <Tooltip.Popup className="rounded-chip bg-overlay px-2 py-1 text-small text-ink shadow-float transition-opacity duration-100 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0">
          {label}
        </Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  </Tooltip.Root>
)
