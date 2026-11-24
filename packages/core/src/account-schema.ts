import { LOGIN_PROVIDERS, PROVIDER_LAUNCHES } from "@switch/models"
import { Schema } from "effect"

export const AccountId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,31}$/u)).pipe(
  Schema.brand("ProviderAccountId"),
)
/** An account added here: its provider's, a home of its own; its id is made when none is given. */
export const NewAccount = Schema.Struct({
  provider: Schema.Literals(LOGIN_PROVIDERS),
  id: Schema.optionalKey(AccountId),
})
export const AccountFlow = Schema.Struct({
  flowId: Schema.String,
  url: Schema.String,
  /** What a device sign-in has the user type on the page; empty when the page gives a code back. */
  code: Schema.String,
})
export const AccountView = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  machine: Schema.String,
  added: Schema.Boolean,
  status: Schema.Literals(["signed-out", "pending", "connected", "limited"]),
  problem: Schema.String,
  used: Schema.Number,
  flow: Schema.NullOr(AccountFlow),
})
export type AccountView = typeof AccountView.Type
export const CliView = Schema.Struct({
  provider: Schema.String,
  machine: Schema.String,
  command: Schema.String,
  version: Schema.String,
  installable: Schema.Boolean,
})
export const AccountsView = Schema.Struct({
  accounts: Schema.Array(AccountView),
  clis: Schema.Array(CliView),
})

interface Labeled {
  readonly host: string
  readonly provider: string
  /** The email its login reports. */
  readonly email?: string | undefined
}
const own = (a: Labeled) => a.host === a.provider || a.host.endsWith(`:${a.provider}`)
const providerName = (a: Labeled) =>
  a.provider === "acp"
    ? a.host
    : (Object.entries(PROVIDER_LAUNCHES).find(([id]) => id === a.provider)?.[1].label ?? a.provider)

/**
 * Each account's label by its id: the email its login reports, else its provider's name, numbered
 * past the provider's first ("Codex", "Codex 2"), its own login first.
 */
export const accountLabels = (accounts: readonly Labeled[]) => {
  const labels = new Map<string, string>()
  const sorted = accounts.toSorted(
    (a, b) => Number(own(b)) - Number(own(a)) || a.host.localeCompare(b.host),
  )
  const counts = new Map<string, number>()
  for (const a of sorted) {
    const name = providerName(a)
    const n = (counts.get(name) ?? 0) + 1
    counts.set(name, n)
    if (!labels.has(a.host)) {
      const numbered = n === 1 ? name : `${name} ${n}`
      labels.set(a.host, a.email === undefined || a.email === "" ? numbered : a.email)
    }
  }
  return labels
}
