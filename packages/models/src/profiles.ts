import { SUBSCRIPTIONS, tiers } from "./tiers.ts"
import type { Subscription } from "./tiers.ts"

export type Role = "turn" | "triage" | "gate" | "decision" | "browse" | "image"

/**
 * Where a model runs. `gateway` is the Vercel AI Gateway (small models); `claude-code`, `codex`
 * and `antigravity` are the user's subscriptions, through Sessions; `workers-ai` is Cloudflare's,
 * for Clef; not wired yet.
 */
export type Provider = Exclude<Subscription, "claude"> | "gateway" | "claude-code" | "workers-ai"

export interface Model {
  readonly provider: Provider
  readonly id: string
  readonly account?: string
}

export interface Profile {
  readonly name: string
  readonly roles: Readonly<Record<Role, Model>>
}

const jev: Model = { provider: "gateway", id: "typesafe-ai/jev" }
// Decisions run on OpenAI's GPT-6 Luna Decisions, "the install's `decide` model" in Switchboard
// (crates/decide/src/lib.rs:10-13, protocol/src/settings.rs:132); Jev was its browser's default.
const luna: Model = { provider: "gateway", id: "openai/gpt-6-luna-decisions" }
/** Pictures: OpenAI's newest image model, which takes every option (references, masks, transparency). */
export const image: Model = { provider: "gateway", id: "openai/gpt-image-2.6-sunburst" }

/**
 * The profile a brain loads with, a default like the others, changed like any: the user, Nov 23,
 * "opus, sonnet haiku thru claude code and then like sunburst for images, luna decisions for
 * decisions+browser thru the gateway"; the browser stays on Jev until it's measured ("whatever
 * performs best").
 */
export const claude: Profile = {
  name: "claude",
  roles: {
    turn: { provider: "claude-code", id: "opus" },
    triage: { provider: "claude-code", id: "haiku" },
    gate: { provider: "claude-code", id: "sonnet" },
    decision: luna,
    browse: jev,
    image,
  },
}

// The gateway's small models, for the other defaults' background roles.
const gatewayRoles = {
  triage: { provider: "gateway", id: "anthropic/claude-haiku-5.5" },
  gate: { provider: "gateway", id: "anthropic/claude-sonnet-5.5" },
  decision: luna,
  browse: jev,
  image,
} as const satisfies Omit<Profile["roles"], "turn">

// The same agent on each subscription, tier for tier (tiers.ts). Gates, triage and decisions stay
// on the gateway models above, so a profile mixes providers by role.
export const codex: Profile = {
  name: "codex",
  roles: { ...gatewayRoles, turn: { provider: "codex", id: tiers.codex.heavy.id } },
}

export const antigravity: Profile = {
  name: "antigravity",
  roles: { ...gatewayRoles, turn: { provider: "antigravity", id: tiers.antigravity.heavy.id } },
}

export const fx: Profile = {
  name: "fx",
  roles: { ...gatewayRoles, turn: { provider: "fx", id: "default" } },
}

/** What a brain with no profiles is given, to change as it likes. */
export const defaultProfiles: readonly Profile[] = [claude, codex, antigravity, fx]

/** The subscription a profile's turns, and its tiers, run on. */
export const subscriptionOf = (p: Profile): Subscription => {
  const { provider } = p.roles.turn
  return SUBSCRIPTIONS.find((candidate) => candidate === provider) ?? "claude"
}
