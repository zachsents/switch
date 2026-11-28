// Tools share the account service, but never transport OAuth URLs or completion codes.
import { defineApp, tool } from "switch-ext-kit"
import { Effect, Schema } from "effect"
import { AccountId } from "./account-schema.ts"
import { Accounts } from "./account-service.ts"

const input = Schema.Struct({ id: AccountId })
const list = tool(
  "list",
  {
    description: "Provider subscriptions and usage. Manage sign-in in Settings → Providers.",
    readOnly: true,
  },
  () =>
    Effect.gen(function* listing() {
      const accounts = yield* Accounts
      const state = yield* accounts.list
      return {
        accounts: state.accounts,
        signingIn: state.signIns.map((f) => f.provider),
      }
    }),
)
const remove = tool(
  "remove",
  {
    description:
      "Remove an account: turns no longer go to it. One added here is signed out and its home removed; a provider's own login is left signed in.",
    input,
  },
  ({ id }) =>
    Effect.gen(function* removing() {
      const accounts = yield* Accounts
      return yield* accounts.remove(id)
    }),
)
export const accountsApp = defineApp<Accounts>({
  name: "accounts",
  version: "1",
  instructions:
    "Provider subscriptions. An account is the email its login reports. The user adds one by signing in privately in Settings → Providers (Add account): a new email is a new account, a known one replaces that account's sign-in. Never ask for a sign-in code or put one in a tool call.",
  tools: [list, remove],
})
