// High-rate events reach the desktop only when a widget placed or shown in a chat refreshes on
// them: this keeps the brain told which, as widgets are placed or shown and extensions offer them.
import { useEffect, useSyncExternalStore } from "react"

import type { Chat } from "../brain/history.ts"
import { watch } from "../brain/client.ts"
import { useBrain } from "../brain/use-brain.ts"
import { queryClient } from "../query.ts"
import { keyOf, useOffered } from "./host.ts"

const cache = queryClient.getQueryCache()
const subscribe = (l: () => void) => cache.subscribe(l)

/** The widgets shown in the chats held, by key, as one string so it compares by value. */
const inChats = () =>
  [
    ...new Set(
      queryClient
        .getQueriesData<Chat>({ queryKey: ["chat"] })
        .flatMap(([, chat]) => chat?.pages.flatMap((p) => p.lines) ?? [])
        .flatMap((l) => (l.widget ? [keyOf(l.widget)] : [])),
    ),
  ]
    .toSorted()
    .join(" ")

export const useWatch = () => {
  const offered = useOffered()
  const chats = useSyncExternalStore(subscribe, inChats)
  const shown = chats === "" ? [] : chats.split(" ")
  const types = useBrain((s) =>
    [
      ...new Set(
        [...s.extra.widgets.map(keyOf), ...shown].flatMap((k) => offered.get(k)?.refresh ?? []),
      ),
    ]
      .toSorted()
      .join(" "),
  )
  useEffect(() => {
    watch(types === "" ? [] : types.split(" "))
  }, [types])
}
