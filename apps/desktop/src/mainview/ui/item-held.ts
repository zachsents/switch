// What an ask's window is handed by the main window: the item and its space's ring and name as the
// main window holds them, so the window shows them at once, before its own brain has them.
import type { SpaceId } from "@switch/brain"
import { HOME } from "@switch/brain/commands"
import { Schema } from "effect"

import { brainQuery } from "../brain/client.ts"
import { itemOf } from "../brain/items.ts"
import type { State } from "../brain/store.ts"
import { queryClient } from "../query.ts"
import { station } from "./look.ts"

/** Where an item is from: its space's ring and name. */
export const placeOf = (s: State, space: SpaceId) => ({
  ...station(s, space),
  name: s.spaces.get(space)?.name ?? "Home",
  home: space === HOME,
})

const Held = Schema.Struct({
  at: Schema.Finite,
  item: Schema.Unknown,
  place: Schema.Struct({
    code: Schema.String,
    ink: Schema.String,
    name: Schema.String,
    home: Schema.Boolean,
  }),
})

/** The item and its place, from this window's brain; undefined when it doesn't hold it. */
export const heldOf = (id: string) => {
  const s = queryClient.getQueryData(brainQuery.queryKey)
  const item =
    s?.extra.actions.get(id) ??
    s?.extra.closed.find((c) => c.id === id) ??
    s?.extra.closed.find((c) => c.id === id)
  return s && item ? { at: item.at, item, place: placeOf(s, item.space) } : undefined
}

/** What the window was handed, read back. */
export const readHeld = (raw: unknown) => {
  const got = Schema.decodeUnknownOption(Held)(raw)
  const item = got._tag === "Some" ? itemOf(got.value.item, got.value.at) : null
  return got._tag === "Some" && item ? { item, place: got.value.place } : undefined
}
