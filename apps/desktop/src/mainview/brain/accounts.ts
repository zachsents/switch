// OAuth stays on private HTTP. Completion mutations have void variables and retain no code.
import { AccountView, CliView } from "@switch/core/account-schema"
import { recordsOf } from "@switch/brain/commands"
import { queryOptions } from "@tanstack/react-query"
import { Schema } from "effect"
import { coreUrl } from "./auth.ts"
import { rec } from "./json.ts"

export const accountRequest = async (route: string, body?: unknown) => {
  const response = await fetch(coreUrl(route), {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "text/plain" },
    cache: "no-store",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch(() => {
    throw new Error("Accounts connection failed")
  })
  if (!response.ok) {
    let message = "Account operation failed"
    try {
      const error = Schema.decodeUnknownSync(Schema.Struct({ error: Schema.String }))(
        await response.json(),
      )
      message = error.error
    } catch {
      // No server internals in the UI.
    }
    throw new Error(message)
  }
  const answer: unknown = await response.json()
  return answer
}
/** Each account and CLI that reads; one that doesn't is left out, said in the log. */
const accountsOf = recordsOf("account", AccountView)
const clisOf = recordsOf("provider CLI", CliView)
export const accountsQuery = queryOptions({
  queryKey: ["provider-accounts"],
  queryFn: async () => {
    const view = rec(await accountRequest("/auth/accounts"))
    return { accounts: accountsOf(view.accounts), clis: clisOf(view.clis) }
  },
  refetchInterval: 10_000,
  gcTime: 0,
})
