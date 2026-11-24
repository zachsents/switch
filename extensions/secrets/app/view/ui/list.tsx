// The list beside the item: the search as its top cell, then every item the filter and the search
// keep, best first. Drawn only where it's in view (TanStack Virtual).
import { useVirtualizer } from "@tanstack/react-virtual"
import { useState } from "react"
import type { ReactNode } from "react"

import type { ShownItem } from "../../shared/rpc.ts"
import { detailOf } from "../listing.ts"
import { Stop } from "./marks.tsx"

export const List = ({
  search,
  items,
  open,
  error,
  onOpen,
}: {
  search: ReactNode
  items: readonly ShownItem[]
  open: string | null
  error: string | null
  onOpen: (id: string) => void
}) => {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  const rows = useVirtualizer({
    count: items.length,
    getScrollElement: () => viewport,
    estimateSize: () => 36,
    getItemKey: (i) => items[i]?.id ?? i,
    overscan: 12,
  })
  return (
    <nav className="flex min-h-0 w-board flex-none flex-col bg-paper rule-r">
      {search}
      {error !== null && (
        <div className="flex h-line items-center gap-2.5 px-inset text-small text-ink hairline-b">
          <Stop size={12} />
          <span className="min-w-0 flex-1 truncate">{error}</span>
        </div>
      )}
      {items.length === 0 && error === null && (
        <p className="m-0 flex h-line items-center px-inset text-ui text-ink3">Nothing</p>
      )}
      <div ref={setViewport} className="min-h-0 flex-1 overflow-y-auto" aria-label="Items">
        <div className="relative w-full" style={{ height: rows.getTotalSize() }}>
          {rows.getVirtualItems().map((row) => {
            const item = items[row.index]
            if (!item) {
              return null
            }
            return (
              <button
                key={row.key}
                type="button"
                style={{ transform: `translateY(${row.start}px)`, height: row.size }}
                onClick={() => {
                  onOpen(item.id)
                }}
                className={`absolute top-0 left-0 flex w-full items-center gap-2.5 px-inset text-left text-ui text-ink outline-none hairline-b hover:bg-wash focus-visible:bg-selection ${item.id === open ? "bg-selection" : "bg-transparent"}`}
              >
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <span className="max-w-[45%] flex-none truncate pl-3 font-mono text-data text-ink3">
                  {detailOf(item)}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </nav>
  )
}
