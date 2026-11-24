// A thread's transcript as its page shows it: the pages paged in, oldest first, then its latest
// turn's entries the snapshot and live events brought that the pages don't have yet.
import { useInfiniteQuery } from "@tanstack/react-query"

import { threadQuery } from "./pages.ts"
import type { ThreadRow } from "./store.ts"

export const useTranscript = (t: ThreadRow) => {
  const paged = useInfiniteQuery({
    ...threadQuery(t.id),
    // A first page that failed is the page's to show; an older one is asked again on scroll.
    throwOnError: (_error, query) => query.state.data === undefined,
  })
  const pages = paged.data?.pages ?? []
  const items = pages.toReversed().flatMap((p) => p.items)
  const last = items.at(-1)?.seq ?? 0
  return {
    items: [...items, ...t.items.filter((i) => i.seq > last)],
    rejected: new Set([...t.rejected, ...pages.flatMap((p) => p.rejected)]),
    older: () => {
      if (paged.hasNextPage && !paged.isFetchingNextPage) {
        void paged.fetchNextPage()
      }
    },
  }
}
