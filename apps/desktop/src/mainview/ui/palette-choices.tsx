// What ⌘K offers, as old Switchboard's search did: spaces (archived ones too, once looked for), what
// was said or kept that holds the words, and a new space by that name.
import { HOME, SpaceId } from "@switch/brain/commands"
import type { ReactNode } from "react"

import * as derive from "../brain/derive.ts"
import type { Found } from "../brain/find.ts"
import type { Act } from "../brain/mutations.ts"
import type { State } from "../brain/store.ts"
import { station } from "./look.ts"
import { Hand, Ring } from "./marks.tsx"
import { openMemory, openSpace } from "./nav.ts"

export interface Choice {
  readonly key: string
  readonly label: string
  /** Matched too, but not shown: where it is. */
  readonly also: string
  readonly icon: ReactNode
  /** Goes somewhere: at once. */
  readonly go?: () => void
  /** Asks the brain: shown at once; the palette stays open with its reason if it says no. */
  readonly act?: Act
  /** Found by the brain in what was said or kept: shown whatever the words. */
  readonly found?: boolean
}

export interface Group {
  readonly value: string
  readonly items: Choice[]
}

const slug = (name: string) =>
  `${name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")}-${crypto.randomUUID().slice(0, 4)}`

export const groups = (s: State, here: SpaceId, query: string, hits: readonly Found[]): Group[] => {
  const ring = (id: SpaceId) => {
    const st = station(s, id)
    return <Ring code={st.code} ink={st.ink} home={id === HOME} />
  }
  const words = query.trim()
  const space = (x: { readonly id: SpaceId; readonly name: string }): Choice => ({
    key: `s:${x.id}`,
    label: x.name,
    also: derive
      .above(s, x.id)
      .filter((y) => y.id !== HOME)
      .map((y) => y.name)
      .join(" "),
    icon: ring(x.id),
    go: () => {
      openSpace(x.id)
    },
  })
  const spaces = [
    ...derive.warmest(s).map(space),
    ...(words === "" ? [] : [...s.spaces.values()].filter((x) => x.archived).map(space)),
  ]
  // A line goes to its place in the chat, an item to its space, a memory to Memory.
  const found = hits
    .filter((h) => s.spaces.has(h.space))
    .map((h): Choice => ({
      key: `f:${h.kind}:${h.id}`,
      label: h.line,
      also: s.spaces.get(h.space)?.name ?? "",
      icon: h.kind === "item" ? <Hand /> : ring(h.space),
      found: true,
      go: () => {
        if (h.kind === "memory") {
          openMemory()
        } else {
          openSpace(h.space, h.kind === "message" ? h.seq : undefined)
        }
      },
    }))
  const made = SpaceId.make(slug(words))
  const make: Choice[] =
    words === ""
      ? []
      : [
          {
            key: "c:new",
            label: `New space “${words}”`,
            also: words,
            icon: (
              <span className="block size-[18px] rounded-full border-[2.3px] border-dashed border-ink3" />
            ),
            act: {
              type: "space.create",
              payload: { id: made, name: words, parent: here === HOME ? null : here },
            },
            go: () => {
              openSpace(made)
            },
          },
        ]
  return [
    { value: "Spaces", items: spaces },
    { value: "Found", items: found },
    { value: "New", items: make },
  ].filter((g) => g.items.length > 0)
}
