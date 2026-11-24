// What can be done to a space from the window: rename it in place on the band, split off its latest
// exchange, move, archive or unarchive it, copy its link, and its right-click menu. Every change is
// a palette act (mutations.ts), shown at once.
import { HOME, SpaceId } from "@switch/brain/commands"
import { useMutation } from "@tanstack/react-query"
import { useSyncExternalStore } from "react"

import { spaceLink } from "../../shared/commands.ts"
import type { SpaceMenu } from "../../shared/commands.ts"
import * as derive from "../brain/derive.ts"
import { brainQuery } from "../brain/client.ts"
import { actMutation } from "../brain/mutations.ts"
import type { State } from "../brain/store.ts"
import { queryClient } from "../query.ts"
import { openSpace } from "./nav.ts"
import { copyText, showSpaceMenu } from "./use-menu.ts"

let renaming: SpaceId | null = null
const listeners = new Set<() => void>()

const setRenaming = (id: SpaceId | null) => {
  renaming = id
  for (const l of listeners) {
    l()
  }
}

/** Puts the band's title in edit, for the space open. */
export const startRename = (id: SpaceId) => {
  if (id !== HOME) {
    setRenaming(id)
  }
}

export const stopRename = () => {
  setRenaming(null)
}

/** The space whose name is being edited, if any. */
export const useRenaming = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => renaming,
  )

/** A space's menu: where it can move is every live space outside it. */
export const spaceMenuOf = (s: State, id: SpaceId): SpaceMenu => {
  const inside = derive.subtree(s, id)
  const space = s.spaces.get(id)
  return {
    id,
    home: id === HOME,
    archived: space?.archived === true,
    moveTo: derive
      .warmest(s)
      .filter((x) => !inside.has(x.id) && x.id !== HOME && x.id !== space?.parent)
      .map((x) => ({ id: x.id, name: x.name })),
  }
}

/** The right-click menu of a space, drawn by the app at the pointer. */
export const onSpaceMenu = (id: SpaceId) => (e: { preventDefault: () => void }) => {
  const s = queryClient.getQueryData(brainQuery.queryKey)
  if (s && showSpaceMenu(spaceMenuOf(s, id))) {
    e.preventDefault()
  }
}

export const copyLink = (id: SpaceId) => {
  copyText(spaceLink(id))
}

/** A new space's id: unique, and readable in a link. */
export const newSpaceId = (name: string) =>
  SpaceId.make(
    `${name
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, "-")
      .replaceAll(/^-|-$/gu, "")}-${crypto.randomUUID().slice(0, 4)}`,
  )

/** Rename, Split Off, Move, Archive and Unarchive, each shown at once. */
export const useSpaceActs = () => {
  const act = useMutation(actMutation)
  return {
    rename: (id: SpaceId, name: string) => {
      act.mutate({ type: "space.rename", payload: { id, name } })
    },
    split: (from: SpaceId) => {
      const id = newSpaceId("split")
      act.mutate(
        { type: "space.split", payload: { id, from } },
        {
          onSuccess: () => {
            openSpace(id)
          },
        },
      )
    },
    move: (id: SpaceId, to: SpaceId | null) => {
      act.mutate({ type: "space.move", payload: { id, parent: to } })
    },
    archive: (id: SpaceId) => {
      act.mutate({ type: "space.archive", payload: { id } })
    },
    unarchive: (id: SpaceId) => {
      act.mutate({ type: "space.unarchive", payload: { id } })
    },
  }
}
