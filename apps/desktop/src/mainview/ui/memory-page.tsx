// Memory: what the agent remembers, by where it holds. Where (everywhere first, then each space in
// the tree) is a list down the left; what's remembered there, rules and preferences before the
// rest, beside it. Each opens to edit or forget.
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import type { ReactNode } from "react"

import { HOME, SpaceId } from "@switch/brain/commands"
import * as derive from "../brain/derive.ts"
import { memoriesQuery } from "../brain/system.ts"
import type { MemoryRow } from "../brain/system.ts"
import { useBrain } from "../brain/use-brain.ts"
import { station } from "./look.ts"
import { Ring } from "./marks.tsx"
import { MemoryItem } from "./memory-item.tsx"
import { PaneScroll } from "./pane-scroll.tsx"
import { Button } from "./kit/button.tsx"

const GLOBAL = "global"

/** Rules and preferences first, then what's known about work and where things are. */
const RANK: Record<string, number> = { feedback: 0, user: 1, project: 2, reference: 3 }

const ranked = (list: readonly MemoryRow[]) =>
  list.toSorted(
    (a, b) =>
      (RANK[a.type] ?? 4) - (RANK[b.type] ?? 4) || a.description.localeCompare(b.description),
  )

const Where = ({
  mark,
  name,
  count,
  open,
  onOpen,
}: {
  mark?: ReactNode
  name: string
  count: number
  open: boolean
  onOpen: () => void
}) => (
  <li>
    <Button
      look="bare"
      aria-current={open ? "true" : undefined}
      onClick={onOpen}
      className="flex h-line w-full items-center gap-2.5 px-inset text-left text-ui text-ink outline-none hover:lit focus-visible:focused aria-[current=true]:held"
    >
      {mark}
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="flex-none text-caption tabular-nums text-ink3">{count}</span>
    </Button>
  </li>
)

export const MemoryPage = () => {
  const memories = useQuery(memoriesQuery)
  const all = memories.data ?? []
  const [chosen, setChosen] = useState(GLOBAL)
  const scopes = [...new Set(all.map((m) => m.scope))]
  const places = useBrain((s) => {
    const order = [HOME, ...derive.warmest(s).map((x) => x.id)]
    return scopes
      .filter((x) => x !== GLOBAL)
      .map((x) => {
        const id = SpaceId.make(x)
        return {
          id,
          name: s.spaces.get(id)?.name ?? x,
          at: order.includes(id) ? order.indexOf(id) : order.length,
          ...station(s, id),
        }
      })
      .toSorted((a, b) => a.at - b.at)
  })
  const countOf = (scope: string) => all.filter((m) => m.scope === scope).length
  const scope = scopes.includes(chosen) ? chosen : (scopes[0] ?? GLOBAL)
  return (
    <div className="flex min-h-0 flex-1 bg-bg">
      <PaneScroll label="Where" className="w-side flex-none line-1-r">
        <ul className="m-0 list-none p-0 rows">
          {scopes.includes(GLOBAL) && (
            <Where
              name="Everywhere"
              count={countOf(GLOBAL)}
              open={scope === GLOBAL}
              onOpen={() => {
                setChosen(GLOBAL)
              }}
            />
          )}
          {places.map((p) => (
            <Where
              key={p.id}
              mark={<Ring code={p.code} ink={p.ink} home={p.id === HOME} />}
              name={p.name}
              count={countOf(p.id)}
              open={scope === p.id}
              onOpen={() => {
                setChosen(p.id)
              }}
            />
          ))}
        </ul>
      </PaneScroll>
      <PaneScroll label="Remembered">
        {memories.error && (
          <div className="flex h-line items-center px-inset text-small text-ink line-2-b">
            {memories.error.message}
          </div>
        )}
        {memories.isSuccess && all.length === 0 && (
          <div className="flex h-line items-center px-inset text-ui text-ink3">Nothing yet</div>
        )}
        <ul className="m-0 list-none p-0 rows">
          {ranked(all.filter((m) => m.scope === scope)).map((m) => (
            <MemoryItem key={m.id} m={m} />
          ))}
        </ul>
      </PaneScroll>
    </div>
  )
}
