// The filters column: everything, favorites, each kind, folder, tag and space, and the trash, each
// with how many it keeps.
import type { ReactNode } from "react"

import type { ShownItem } from "../../shared/rpc.ts"
import { filtersOf, KIND_LABELS } from "../listing.ts"
import type { Filter } from "../route.ts"

const Line = ({
  label,
  count,
  on,
  onClick,
}: {
  label: ReactNode
  count: number
  on: boolean
  onClick: () => void
}) => (
  <li className="hairline-b last:after:hidden">
    <button
      type="button"
      onClick={onClick}
      className={`flex h-line w-full items-center gap-2 px-inset text-left text-ui text-ink outline-none hover:bg-wash focus-visible:bg-selection ${on ? "bg-selection" : "bg-transparent"}`}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="flex-none font-mono text-data text-ink3">{count}</span>
    </button>
  </li>
)

const Group = ({ label, children }: { label: string; children: ReactNode }) => (
  <section className="heavy-t">
    <h2 className="m-0 flex h-head items-center px-inset text-small font-semibold tracking-[0.06em] text-ink uppercase">
      {label}
    </h2>
    <ul className="m-0 list-none p-0">{children}</ul>
  </section>
)

export const Filters = ({
  items,
  filter,
  onFilter,
}: {
  items: readonly ShownItem[]
  filter: Filter
  onFilter: (f: Filter) => void
}) => {
  const f = filtersOf(items)
  const line = (key: Filter, label: ReactNode, count: number) => (
    <Line
      key={key}
      label={label}
      count={count}
      on={filter === key}
      onClick={() => {
        onFilter(key)
      }}
    />
  )
  return (
    <nav
      className="min-h-0 w-[200px] flex-none overflow-y-auto bg-paper rule-r"
      aria-label="Filters"
    >
      <ul className="m-0 list-none p-0">
        {line("all", "All", f.all)}
        {line("favorites", "Favorites", f.favorites)}
      </ul>
      {f.kinds.length > 0 && (
        <Group label="Kinds">
          {f.kinds.map((k) => line(`kind:${k.value}`, KIND_LABELS[k.value], k.count))}
        </Group>
      )}
      {f.folders.length > 0 && (
        <Group label="Folders">
          {f.folders.map((x) => line(`folder:${x.value}`, x.value, x.count))}
        </Group>
      )}
      {f.tags.length > 0 && (
        <Group label="Tags">{f.tags.map((x) => line(`tag:${x.value}`, x.value, x.count))}</Group>
      )}
      {f.spaces.length > 0 && (
        <Group label="Spaces">
          {f.spaces.map((x) => line(`space:${x.value}`, x.value, x.count))}
        </Group>
      )}
      <section className="heavy-t">
        <ul className="m-0 list-none p-0">{line("trash", "Trash", f.trash)}</ul>
      </section>
    </nav>
  )
}
