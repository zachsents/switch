// The window: the vault's gate (approve this Mac, unlock it) until it's open, then the vault.
import { useQuery } from "@tanstack/react-query"

import { useForgetWhenLocked } from "./forget.ts"
import { statusQuery } from "./queries.ts"
import { Gate } from "./ui/gate.tsx"
import { Shell } from "./ui/shell.tsx"

export const App = () => {
  const { data: status } = useQuery(statusQuery)
  const open = status?.stage === "open"
  useForgetWhenLocked(open)
  return status && open ? <Shell status={status} /> : <Gate status={status} />
}
