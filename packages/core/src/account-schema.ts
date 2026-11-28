import { LOGIN_PROVIDERS, PROVIDER_LAUNCHES } from "@switch/models"
import { Schema } from "effect"

export const AccountId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,31}$/u)).pipe(
  Schema.brand("ProviderAccountId"),
)
/** An account added: its provider's sign-in, in a home of its own; who signs in is the account. */
export const NewAccount = Schema.Struct({ provider: Schema.Literals(LOGIN_PROVIDERS) })
/** A sign-in under way, no account until it's done. */
export const SignInView = Schema.Struct({
  provider: Schema.String,
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
  /** Who it is, for one added here: its identity. */
  email: Schema.String,
  status: Schema.Literals(["signed-out", "connected", "limited"]),
  problem: Schema.String,
  used: Schema.Number,
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
  signIns: Schema.Array(SignInView),
})

interface Labeled {
  readonly host: string
  readonly provider: string
  /** The email its login reports. */
  readonly email?: string | undefined
}
const providerName = (a: Labeled) =>
  a.provider === "acp"
    ? a.host
    : (Object.entries(PROVIDER_LAUNCHES).find(([id]) => id === a.provider)?.[1].label ?? a.provider)

/** Each account's label by its id: who it is (the email its login reports), else its provider. */
export const accountLabels = (accounts: readonly Labeled[]) =>
  new Map(
    accounts.map((a) => [
      a.host,
      a.email === undefined || a.email === "" ? providerName(a) : a.email,
    ]),
  )
