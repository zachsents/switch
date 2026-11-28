// Provider accounts as Settings lists them: in providers' order, each provider's own account first,
// named by provider, then by the account's own name. And how each stands: needs you (signed out, or
// a sign-in under way), stopped (at a usage limit), or not as expected (its CLI missing, its
// provider unreachable); else connected, with how much of its limit it has used.
import type { AccountView, CliView } from "@switch/core/account-schema"
import type { Capability } from "@switch/core/profiles"
import { SUBSCRIPTIONS } from "@switch/models"

/** Its own name: another machine's accounts are `<machine>:<name>`. */
export const loginOf = (a: AccountView) =>
  a.id.startsWith(`${a.machine}:`) ? a.id.slice(a.machine.length + 1) : a.id

const RANKS = new Map<string, number>(SUBSCRIPTIONS.map((s, at) => [s, at]))
const rank = (a: AccountView) => RANKS.get(a.provider) ?? SUBSCRIPTIONS.length

/** In providers' order, each provider's own account first, then by name. */
export const ordered = (accounts: readonly AccountView[]) =>
  accounts.toSorted(
    (a, b) =>
      rank(a) - rank(b) ||
      Number(loginOf(a) !== a.provider) - Number(loginOf(b) !== b.provider) ||
      a.id.localeCompare(b.id),
  )

export interface Standing {
  readonly mark: "hand" | "stop" | "warn" | null
  readonly words: string
  /** Percent of its limit used, while it can run. */
  readonly used: number | null
}

export const standingOf = (
  account: AccountView,
  capability: typeof Capability.Type | undefined,
  cli: typeof CliView.Type | undefined,
): Standing => {
  const used = Math.round(account.used * 100)
  if (cli?.command === "") {
    return { mark: "warn", words: "CLI missing", used: null }
  }
  if (account.status === "signed-out") {
    return { mark: "hand", words: "Signed out", used: null }
  }
  if (account.status === "limited") {
    return { mark: "stop", words: account.problem || "Limited", used }
  }
  if (capability === undefined) {
    return { mark: null, words: "Connected", used }
  }
  if (!capability.available) {
    return { mark: "warn", words: capability.problem || "Unavailable", used: null }
  }
  return { mark: null, words: capability.problem || "Connected", used }
}
