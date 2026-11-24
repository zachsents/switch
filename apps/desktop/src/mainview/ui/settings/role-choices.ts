// What a profile's roles can run on. Chat runs on any model a signed-in subscription offers; triage,
// gate, decision and browse on those of subscriptions that complete (decisions there as completions,
// each choice with the probability the model gives it), and on Gateway's models for each. An account
// pins a role to one subscription; none (Auto) spreads it across every account that can serve it.
// Pictures run on Gateway's image models only.
import { browseModels, completionModels, decisionModels, imageModels } from "@switch/core/profiles"
import type { Capability, ModelChoice } from "@switch/core/profiles"
import { PROVIDER_LAUNCHES } from "@switch/models"

export const ROLE_LABELS = {
  turn: "Chat",
  triage: "Triage",
  gate: "Gate",
  decision: "Decision",
  browse: "Browse",
  image: "Image",
} as const
export type Role = keyof typeof ROLE_LABELS
export const EDITABLE = [
  "turn",
  "triage",
  "gate",
  "decision",
  "browse",
  "image",
] as const satisfies readonly Role[]

type Choice = typeof ModelChoice.Type
type Account = typeof Capability.Type

const LABELS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(PROVIDER_LAUNCHES).map(([id, p]) => [id, p.label])),
  "claude-code": "Claude",
  gateway: "Gateway",
}

/** A provider's name: a subscription's, Claude Code's as Claude's, the Gateway's. */
export const providerLabel = (provider: string) => LABELS[provider] ?? provider

const serves = (role: Role, a: Account) =>
  role !== "image" && a.available && (role === "turn" || a.completion === true)

const gatewayModels = {
  turn: [],
  triage: completionModels,
  gate: completionModels,
  decision: decisionModels,
  browse: browseModels,
  image: imageModels,
}

/** A choice's key in a list. */
export const keyOf = (c: Pick<Choice, "provider" | "id">) => `${c.provider}:${c.id}`

/** Every model a role can run on, by provider; the current one too, offered or not. */
export const modelChoices = (role: Role, accounts: readonly Account[], current: Choice) => {
  const offered = accounts
    .filter((a) => serves(role, a))
    .flatMap((a) =>
      a.models.map((id) => ({
        provider: a.provider === "claude" ? ("claude-code" as const) : a.provider,
        id,
      })),
    )
  const gateway = gatewayModels[role].map((id) => ({ provider: "gateway" as const, id }))
  const all = [...offered, ...gateway, { provider: current.provider, id: current.id }]
  return [...new Map(all.map((m) => [keyOf(m), m])).values()]
}

/** The accounts that can serve a role's model; the one it's pinned to too. */
export const accountChoices = (role: Role, choice: Choice, accounts: readonly Account[]) => {
  const provider = choice.provider === "claude-code" ? "claude" : choice.provider
  const able = accounts
    .filter((a) => a.provider === provider && serves(role, a) && a.models.includes(choice.id))
    .map((a) => a.host)
  return [...new Set(choice.account === undefined ? able : [...able, choice.account])]
}

/** A new profile's name from another's: "claude copy", then "claude copy 2" and on. */
export const copyName = (name: string, profiles: readonly { readonly name: string }[]) => {
  const taken = new Set(profiles.map((p) => p.name))
  const base = `${name} copy`
  let candidate = base
  for (let n = 2; taken.has(candidate); n += 1) {
    candidate = `${base} ${n}`
  }
  return candidate
}
