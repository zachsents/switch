// The app's one query cache: what the bun process answers are queries, what it changes mutations,
// and it says when they've changed (bridge.ts). Nothing retries: a refusal is an answer.
import { QueryClient } from "@tanstack/react-query"

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, retry: false, refetchOnWindowFocus: false },
  },
})

/** Every query's key starts here, so a change marks them all stale at once. */
export const SECRETS = ["secrets"] as const
