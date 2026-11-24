// Once the vault locks, nothing opened stays in the view's cache.
import { useEffect } from "react"

import { queryClient, SECRETS } from "./query.ts"

export const useForgetWhenLocked = (open: boolean) => {
  useEffect(() => {
    if (!open) {
      queryClient.removeQueries({
        queryKey: SECRETS,
        predicate: (q) => q.queryKey[1] !== "status",
      })
    }
  }, [open])
}
