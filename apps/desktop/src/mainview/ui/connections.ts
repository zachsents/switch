// Connections as the client reaches them: what extensions need (a query, again whenever a
// connection changes) and connecting or disconnecting (mutations). The connections themselves come
// by sync.
import { recordsOf } from "@switch/brain/commands"
import { mutationOptions, useQuery } from "@tanstack/react-query"
import { Schema } from "effect"
import { WidgetWindow, ConnectionStart } from "../../shared/commands.ts"

import type { Action } from "../brain/adapter.ts"
import { useBrain } from "../brain/use-brain.ts"
import { callChecked } from "../widgets/call.ts"
import { openItemWindow, openWidgetWindow, rpc } from "./use-menu.ts"

const need = Schema.Struct({
  provider: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(["oauth", "key", "session"]),
  apps: Schema.Array(Schema.String),
  scopes: Schema.Array(Schema.String),
  multiple: Schema.Boolean,
})
export type ProviderNeed = typeof need.Type

const listed = Schema.decodeUnknownSync(
  Schema.Struct({ structuredContent: Schema.Struct({ needs: Schema.Unknown }) }),
)
/** Each need that reads; one an extension says in a way this app can't read is left out. */
const needsOf = recordsOf("provider need", need)
/** What extensions need of each provider. */
export const useNeeds = () => {
  // Its connections and their scopes, as one key: a change asks again.
  const changed = useBrain((s) =>
    [...s.extra.connections.values()].map((c) => `${c.id} ${c.scopes.join(" ")}`),
  )
  const q = useQuery({
    queryKey: ["connections", "needs", changed],
    queryFn: async () =>
      needsOf(listed(await callChecked("connections", "list", {})).structuredContent.needs),
    // Extensions come and go with what they need.
    refetchInterval: 30_000,
  })
  return q.data ?? []
}

const asked = Schema.decodeUnknownOption(
  Schema.Struct({ structuredContent: Schema.Struct({ item: Schema.String }) }),
)

const returnedView = Schema.decodeUnknownOption(
  Schema.Struct({ structuredContent: Schema.Struct({ view: WidgetWindow }) }),
)
const openView = (answer: unknown) => {
  const result = returnedView(answer)
  if (result._tag === "Some") {
    openWidgetWindow(result.value.structuredContent.view)
  }
}

const clientConnection = async (input: ConnectionStart) => {
  if (!rpc) {
    const { tool, ...args } = input
    return await callChecked("connections", tool, args)
  }
  const answer = await rpc.request.connection(input, { maxRequestTime: 11 * 60_000 })
  if (!answer.ok) {
    throw new Error(answer.error)
  }
  return answer.value
}

const connectionInput = Schema.decodeUnknownOption(ConnectionStart)
export const cancelConnection = (provider: string) => {
  rpc?.send.connectionCancel({ provider })
}

const verified = Schema.decodeUnknownOption(
  Schema.Struct({ structuredContent: Schema.Struct({ connected: Schema.Boolean }) }),
)
export const verifyConnection = mutationOptions({
  mutationKey: ["connections", "verify"],
  mutationFn: async (input: { readonly provider: string; readonly account?: string }) => {
    const answer = verified(await callChecked("connections", "verify", input))
    if (answer._tag === "None") {
      throw new Error("Could not verify the connection. Try again.")
    }
    return answer.value.structuredContent.connected
  },
})

/** Opens a provider's consent in the system browser; a key's sealed ask, in a window of its own. */
export const connectMutation = mutationOptions({
  mutationKey: ["connections", "connect"],
  mutationFn: async (input: { readonly provider: string; readonly account?: string }) => {
    const result = await clientConnection({ tool: "connect", ...input })
    openView(result)
    const answer = asked(result)
    if (answer._tag === "Some") {
      openItemWindow(answer.value.structuredContent.item)
    }
  },
})

export const disconnectMutation = mutationOptions({
  mutationKey: ["connections", "disconnect"],
  mutationFn: async (id: string) => {
    await callChecked("connections", "disconnect", { id })
  },
})

/** An app's tool, as an action item's button calls it. */
export const actionMutation = mutationOptions({
  mutationKey: ["action"],
  mutationFn: async (a: Action) => {
    const input = connectionInput({ ...a.args, tool: a.tool })
    const result =
      a.app === "connections" && input._tag === "Some"
        ? await clientConnection(input.value)
        : await callChecked(a.app, a.tool, a.args)
    openView(result)
  },
})
