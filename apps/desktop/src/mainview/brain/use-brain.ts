// The synced state as a view reads it: through a selector, so it re-renders only when what it
// picks changes.
import { useQuery } from "@tanstack/react-query"

import { brainQuery } from "./client.ts"
import type { State } from "./store.ts"

export const useBrain = <T>(select: (s: State) => T) => useQuery({ ...brainQuery, select }).data
