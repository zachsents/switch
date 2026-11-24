// A list's parts: its heading (a mark, a name, a count), its rows on line-2s, its one line when it
// has nothing, and a row's figures. Tooltips, at once. The rail's sections head theirs in small
// capitals (rail-section.tsx).
import { Tooltip } from "@base-ui/react/tooltip"
import type { MouseEvent, ReactElement, ReactNode } from "react"

import { Button } from "./kit/button.tsx"

/** A list's heading: its mark, its name, and a count at its end. */
export const Head = ({
  mark,
  label,
  count,
}: {
  mark?: ReactNode
  label: string
  count?: number | undefined
}) => (
  <h2 className="m-0 flex h-line flex-none items-center gap-2 px-inset text-ui font-semibold text-ink">
    {mark}
    <span className="trim min-w-0 truncate">{label}</span>
    {count !== undefined && count > 0 && (
      <span className="trim ml-auto text-caption tabular-nums font-normal text-ink3">{count}</span>
    )}
  </h2>
)

/** A list: a heading, then its rows, one a line. */
export const Section = ({
  mark,
  label,
  count,
  children,
}: {
  mark?: ReactNode
  label: string
  count?: number
  children: ReactNode
}) => (
  <section className="flex flex-col">
    <Head mark={mark} label={label} count={count} />
    <ul className="m-0 flex list-none flex-col p-0">{children}</ul>
  </section>
)

/** A list's one line when it has nothing, as old Switchboard's board said it (ui/home.rs `quiet`). */
export const Quiet = () => (
  <li className="flex h-work items-center px-[14px] text-ui text-ink3 line-2-t">
    <span className="trim">Nothing</span>
  </li>
)

/** A list's row: its whole width and height are the click. */
export const Row = ({
  onClick,
  onContextMenu,
  children,
  title,
  className = "",
}: {
  onClick?: () => void
  onContextMenu?: (e: MouseEvent) => void
  children: ReactNode
  title?: string
  className?: string
}) => (
  <li className="min-w-0 line-2-t">
    <Button
      look="row"
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={title}
      className={className}
    >
      {children}
    </Button>
  </li>
)

/** Figures at a row's end: when, how many; `w`, a column's width, so figures line up. */
export const Data = ({ children, w = "" }: { children: ReactNode; w?: string }) => (
  <span
    data-data
    className={`trim ml-auto flex-none pl-3 text-right text-caption tabular-nums text-ink2 ${w}`}
  >
    {children}
  </span>
)

/** A tooltip 100 ms after the pointer is over it, centred under it. */
export const Tip = ({
  label,
  children,
  offset = 6,
}: {
  label: string
  children: ReactElement
  /** Px below the trigger: more when it sits inside a plate taller than itself. */
  offset?: number
}) => (
  <Tooltip.Root>
    <Tooltip.Trigger delay={100} closeDelay={0} render={children} />
    <Tooltip.Portal>
      <Tooltip.Positioner side="bottom" sideOffset={offset}>
        <Tooltip.Popup className="max-w-[280px] rounded-key border border-line-1 bg-bg px-2 py-1 text-small text-ink">
          {label}
        </Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  </Tooltip.Root>
)
