// What the bun process answers, as queries, all under ["secrets"] so a change marks every one stale.
import { queryOptions } from "@tanstack/react-query"

import type { Generate, Status } from "../shared/rpc.ts"
import { ask } from "./bridge.ts"
import { SECRETS } from "./query.ts"

const STARTING: Status = { stage: "starting", code: "", error: "", online: true, device: "" }

export const statusQuery = queryOptions({
  queryKey: [...SECRETS, "status"],
  queryFn: async () => await ask.status({}),
  placeholderData: STARTING,
  staleTime: 0,
})

/** Asked only while the vault's open. */
export const itemsQuery = queryOptions({
  queryKey: [...SECRETS, "items"],
  queryFn: async () => await ask.items({}),
  staleTime: 0,
})

export const itemQuery = (id: string) =>
  queryOptions({
    queryKey: [...SECRETS, "item", id],
    queryFn: async () => await ask.item({ id }),
    staleTime: 0,
  })

/** An authenticator's code, asked again the moment it turns over. */
export const codeQuery = (id: string, field: string) =>
  queryOptions({
    queryKey: [...SECRETS, "code", id, field],
    queryFn: async () => await ask.code({ id, field }),
    refetchInterval: (q) => (q.state.data?.left ?? 1000) + 50,
    staleTime: 0,
    gcTime: 0,
  })

export const historyQuery = (id: string) =>
  queryOptions({
    queryKey: [...SECRETS, "history", id],
    queryFn: async () => await ask.history({ id }),
  })

export const auditQuery = (item?: string) =>
  queryOptions({
    queryKey: [...SECRETS, "audit", item ?? ""],
    queryFn: async () => await ask.audit(item === undefined ? {} : { item }),
  })

export const membersQuery = queryOptions({
  queryKey: [...SECRETS, "members"],
  queryFn: async () => await ask.members({}),
  staleTime: 0,
})

/** A new password for these options; another with Regenerate (a refetch). */
export const generateQuery = (g: Generate) =>
  queryOptions({
    queryKey: ["generate", g],
    queryFn: async () => await ask.generate(g),
    staleTime: Infinity,
    gcTime: 0,
  })
