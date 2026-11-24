// The app's one query cache: the extension's answers are queries, its changes mutations, and the
// brain's contacts events mark them stale (brain.ts).
import { QueryClient } from "@tanstack/react-query"

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: 1, refetchOnWindowFocus: false } },
})
