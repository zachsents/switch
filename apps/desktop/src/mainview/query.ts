// The client's one query cache: the brain's sync feeds it (brain/client.ts), tools' answers are
// queries, and every command is a mutation.
import { QueryClient } from "@tanstack/react-query"

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } },
})
