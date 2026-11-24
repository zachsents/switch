// How a space lists the spaces inside it: banner rows (each its cover behind its name and marks) or
// plain rows. The user's, per space, in the brain (`pref space.inside:<id>`); until set, Home's are
// banners and every other space's plain rows.
import type { SpaceId } from "@switch/brain"
import { HOME } from "@switch/brain/commands"

import type { State } from "../brain/store.ts"

export type InsideView = "banners" | "rows"

/** Its preference's key in the brain. */
export const insideKey = (id: SpaceId) => `space.inside:${id}`

export const insideView = (s: State, id: SpaceId): InsideView => {
  const set = s.extra.prefs.get(insideKey(id))
  if (set === "banners" || set === "rows") {
    return set
  }
  return id === HOME ? "banners" : "rows"
}
