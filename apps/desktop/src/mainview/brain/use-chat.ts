// A space's chat as its column shows it: the lines paged in, oldest first, then the reply
// streaming in and what's sent but not yet in the log.
import type { SpaceId } from "@switch/brain"
import { useInfiniteQuery } from "@tanstack/react-query"
import { useEffect } from "react"

import * as derive from "./derive.ts"
import { chatQuery } from "./pages.ts"
import { useBrain } from "./use-brain.ts"

/** `reach`: a line to bring into view, by seq. Older pages come in until it's held. */
export const useChat = (space: SpaceId, reach: number | null) => {
  const paged = useInfiniteQuery({
    ...chatQuery(space),
    select: (chat) => chat.pages.toReversed().flatMap((p) => p.lines),
  })
  const held = paged.data ?? []
  const lines = useBrain((s) => derive.chat(s, space, held))
  const oldest = held[0]?.seq
  const short = reach !== null && oldest !== undefined && oldest > reach && paged.hasNextPage
  const { isFetchingNextPage, fetchNextPage } = paged
  useEffect(() => {
    if (short && !isFetchingNextPage) {
      void fetchNextPage()
    }
  }, [short, isFetchingNextPage, fetchNextPage])
  return {
    lines,
    /** Asks for the page before what's held, once at a time. */
    older: () => {
      if (paged.hasNextPage && !paged.isFetchingNextPage) {
        void paged.fetchNextPage()
      }
    },
  }
}
