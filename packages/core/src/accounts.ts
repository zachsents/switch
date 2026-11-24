// Tools share the account service, but never transport OAuth URLs or completion codes.
import { defineApp, tool } from "switch-ext-kit"
import { Effect, Schema } from "effect"
import { AccountId, NewAccount } from "./account-schema.ts"
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
        accounts: state.accounts.map(({ flow, ...account }) => ({
          ...account,
          pending: flow !== null,
        })),
      }
    }),
)
const add = tool(
  "add",
  {
    description:
      "Add an account of a provider, in a home of its own; it's shown by the email its login reports once signed in. The user completes sign-in privately in Settings → Providers.",
    input: NewAccount,
  },
  ({ provider, id }) =>
    Effect.gen(function* adding() {
      const accounts = yield* Accounts
      const added = yield* accounts.add(provider, id)
      return { id: added.id, settings: "Providers" }
    }),
)
const signIn = tool(
  "sign_in",
  {
    description:
      "Find a named account for sign-in. The user starts and completes sign-in in Settings → Providers. Never request a code in chat.",
    input,
  },
  ({ id }) =>
    Effect.gen(function* signingIn() {
      const accounts = yield* Accounts
      const state = yield* accounts.list
      if (!state.accounts.some((a) => a.id === id)) {
        return yield* Effect.fail(new Error("No account"))
      }
      return { id, settings: "Providers" }
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
    "Provider subscriptions. Add named accounts here, any number per provider; the user installs the CLI and signs in privately in Settings → Providers. Never ask for a sign-in code or put one in a tool call.",
  tools: [list, add, signIn, remove],
})
