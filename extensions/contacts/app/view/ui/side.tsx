// The list beside the person: the search as its top cell, its filters under it, then everyone, or
// with a search only who matches, best first. Drawn only where it's in view (TanStack Virtual).
import { useVirtualizer } from "@tanstack/react-virtual"
import { useState } from "react"
import type { ReactNode } from "react"

import { Stop } from "./marks.tsx"
import { Data } from "./parts.tsx"
import type { Line } from "../listing.ts"

const HEAD = 42
const LINE = 36

export const Side = ({
  search,
  filters,
  lines,
  open,
  picked,
  error,
  onOpen,
  onPick,
}: {
  search: ReactNode
  filters: ReactNode
  lines: readonly Line[]
  open: string | null
  picked: readonly string[]
  error: string | null
  onOpen: (id: string) => void
  onPick: (id: string) => void
}) => {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null)
  const rows = useVirtualizer({
    count: lines.length,
    getScrollElement: () => viewport,
    estimateSize: (i) => (lines[i]?.kind === "head" ? HEAD : LINE),
    getItemKey: (i) => lines[i]?.key ?? i,
    overscan: 12,
  })
  return (
    <nav className="flex min-h-0 w-board flex-none flex-col bg-paper rule-r">
      {search}
      {filters}
      {error !== null && (
        <div className="flex h-line items-center gap-2.5 px-inset text-small text-ink hairline-b">
          <Stop size={12} />
          <span className="min-w-0 flex-1 truncate">{error}</span>
        </div>
      )}
      <div ref={setViewport} className="min-h-0 flex-1 overflow-y-auto" aria-label="People">
        <div className="relative w-full" style={{ height: rows.getTotalSize() }}>
          {rows.getVirtualItems().map((row) => {
            const line = lines[row.index]
            if (line === undefined) {
              return null
            }
            const place = { transform: `translateY(${row.start}px)`, height: row.size }
            if (line.kind === "head") {
              return (
                <h2
                  key={row.key}
                  style={place}
                  className={`absolute top-0 left-0 m-0 flex w-full items-center gap-2 px-inset text-small font-semibold tracking-[0.06em] text-ink uppercase ${row.index > 0 ? "heavy-t" : ""}`}
                >
                  <span>{line.label}</span>
                  {line.count > 0 && (
                    <span className="ml-auto font-mono text-data font-normal tracking-normal text-ink3">
                      {line.count}
                    </span>
                  )}
                </h2>
              )
            }
            if (line.kind === "empty") {
              return (
                <p
                  key={row.key}
                  style={place}
                  className="absolute top-0 left-0 m-0 flex w-full items-center px-inset text-ui text-ink3"
                >
                  {line.label}
                </p>
              )
            }
            const isOpen = line.id === open
            const isPicked = picked.includes(line.id)
            return (
              <button
                key={row.key}
                type="button"
                style={place}
                onClick={(e) => {
                  if (e.metaKey || e.shiftKey) {
                    onPick(line.id)
                  } else {
                    onOpen(line.id)
                  }
                }}
                className={`absolute top-0 left-0 flex w-full items-center gap-2.5 px-inset text-left text-ui text-ink outline-none hairline-b hover:bg-wash focus-visible:bg-selection ${isOpen ? "bg-selection" : "bg-transparent"}`}
              >
                {isPicked && <span className="absolute inset-y-0 left-0 w-[3px] bg-ink" />}
                <span className="min-w-0 flex-1 truncate">{line.name}</span>
                {line.detail !== undefined && <Data>{line.detail}</Data>}
              </button>
            )
          })}
        </div>
      </div>
    </nav>
  )
}
