// Adding a provider on the core's machine: a provider's own account, a named account in a home of
// its own (any number per provider), or an agent from the ACP Registry, installed. A named account
// starts its sign-in once added, when its CLI is there.
import { recordsOf } from "@switch/brain/commands"
import type { LoginProvider, Subscription } from "@switch/models"
import { mutationOptions, queryOptions } from "@tanstack/react-query"
import { Schema } from "effect"

import { queryClient } from "../query.ts"
import { accountRequest, accountsQuery } from "./accounts.ts"
import { coreUrl } from "./auth.ts"
import { rec } from "./json.ts"
import { modelsQuery } from "./models.ts"

const Failure = Schema.fromJsonString(Schema.Struct({ error: Schema.String }))

/** A provider route; a body in plain text, so the browser sends it without asking first. */
const providerRequest = async (route: string, body?: unknown) => {
  const response = await fetch(coreUrl(route), {
    cache: "no-store",
    ...(body !== undefined && {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(body),
    }),
  }).catch(() => {
    throw new Error("Can't reach the core")
  })
  if (!response.ok) {
    const failure = Schema.decodeUnknownOption(Failure)(await response.text())
    throw new Error(failure._tag === "Some" ? failure.value.error : "Didn't go through")
  }
  return response
}

/** Each registry agent that reads; one that doesn't is left out, said in the log. */
const agentsOf = recordsOf(
  "registry agent",
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    version: Schema.String,
    distributions: Schema.Array(Schema.Literals(["binary", "npx", "uvx"])),
  }),
)

export const registryQuery = queryOptions({
  queryKey: ["provider-registry"],
  queryFn: async () => {
    // The core reads the registry from the web; whatever stops it, adding a provider still works.
    const response = await providerRequest("/providers/registry").catch(() => {
      throw new Error("ACP Registry unavailable")
    })
    return { agents: agentsOf(rec(await response.json()).agents) }
  },
  staleTime: 600_000,
})

export type Adding =
  | { readonly kind: "account"; readonly provider: LoginProvider; readonly id: string }
  | { readonly kind: "provider"; readonly provider: Subscription }
  | {
      readonly kind: "agent"
      readonly agentId: string
      readonly version: string
      readonly distribution: string
    }

/** Adds it; the account it made, by id. */
const add = async (adding: Adding) => {
  switch (adding.kind) {
    case "account": {
      await accountRequest("/auth/accounts", { provider: adding.provider, id: adding.id })
      return adding.id
    }
    case "provider": {
      await providerRequest("/providers/add", { provider: adding.provider })
      return adding.provider
    }
    case "agent": {
      const { agentId, version, distribution } = adding
      await providerRequest("/providers/registry/install", { agentId, version, distribution })
      return `acp-${agentId}`
    }
    default: {
      return adding satisfies never
    }
  }
}

/** Added, the accounts are read again before it settles, so what's added can be picked at once; the
 * catalog (which asks every provider) and the registry (whose versions move) after. */
export const addProvider = mutationOptions({
  mutationFn: add,
  onSettled: async () => {
    void queryClient.invalidateQueries({ queryKey: modelsQuery.queryKey })
    void queryClient.invalidateQueries({ queryKey: registryQuery.queryKey })
    await queryClient.invalidateQueries({ queryKey: accountsQuery.queryKey })
  },
})

/** An account added, by an id the core makes, and its sign-in started when its CLI is there to sign
 * in with. */
export const addAccount = mutationOptions({
  mutationFn: async (adding: { readonly provider: LoginProvider; readonly signIn: boolean }) => {
    const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
      await accountRequest("/auth/accounts", { provider: adding.provider }),
    )
    if (adding.signIn) {
      await accountRequest(`/auth/accounts/${encodeURIComponent(id)}/start`, {})
    }
  },
  onSettled: async () => {
    void queryClient.invalidateQueries({ queryKey: modelsQuery.queryKey })
    await queryClient.invalidateQueries({ queryKey: accountsQuery.queryKey })
  },
})
