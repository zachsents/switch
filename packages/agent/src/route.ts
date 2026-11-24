// Which provider and model a thread's `model` means. A tier ("heavy", "mid", "light") follows the
// profile, so switching profiles moves every thread; a model id pins its own provider.
import { SUBSCRIPTIONS, TIERS, tiers } from "@switch/models"
import type { Profile, Subscription, Tier } from "@switch/models"

import { cursorAdapter } from "./cursor.ts"
import { museAdapter } from "./muse.ts"
import { piAdapter } from "./pi.ts"
import { grokAdapter, kiroAdapter, opencodeAdapter, localAcpAdapter } from "./acp-providers.ts"
import { Effect } from "effect"
import { antigravityAdapter } from "./antigravity.ts"
import { fxAdapter } from "./fx.ts"
import { codexAdapter } from "./codex.ts"
import { claudeAdapter } from "./provider.ts"
import type { Adapter } from "./provider.ts"

export const adapters: Readonly<Record<Subscription, Adapter>> = {
  cursor: cursorAdapter("cursor"),
  muse: museAdapter("muse"),
  pi: piAdapter("pi"),
  grok: grokAdapter("grok"),
  kiro: kiroAdapter("kiro"),
  opencode: opencodeAdapter("opencode"),
  acp: {
    provider: "acp",
    start: (s) =>
      s.host.acp === undefined
        ? Effect.die(new Error("ACP agent not installed"))
        : localAcpAdapter("acp", s.host.acp.command, s.host.acp.args, {
            env: () => s.host.acp?.env ?? {},
          }).start(s),
  },
  claude: claudeAdapter,
  fx: fxAdapter,
  codex: codexAdapter,
  antigravity: antigravityAdapter,
}

const isTier = (s: string): s is Tier => TIERS.some((t) => t === s)
const isSubscription = (s: string): s is Subscription => SUBSCRIPTIONS.some((p) => p === s)

export const route = (
  model: string,
  profile: Subscription | Profile,
): { readonly provider: Subscription; readonly id: string; readonly account?: string } => {
  const turnProvider = typeof profile === "string" ? profile : profile.roles.turn.provider
  const selected = turnProvider === "claude-code" ? "claude" : turnProvider
  const subscription = isSubscription(selected) ? selected : "claude"
  if (model === "heavy" && typeof profile !== "string") {
    return {
      provider: subscription,
      id: profile.roles.turn.id,
      ...(profile.roles.turn.account !== undefined && { account: profile.roles.turn.account }),
    }
  }
  if (isTier(model)) {
    return { provider: subscription, id: tiers[subscription][model].id }
  }
  // "codex:gpt-6-astra"
  const at = model.indexOf(":")
  const named = at === -1 ? "" : model.slice(0, at)
  if (isSubscription(named)) {
    return { provider: named, id: model.slice(at + 1) }
  }
  for (const p of SUBSCRIPTIONS) {
    if (Object.values(tiers[p]).some((m) => m.id === model)) {
      return { provider: p, id: model }
    }
  }
  if (model.startsWith("gpt-")) {
    return { provider: "codex", id: model }
  }
  if (model.startsWith("gemini-")) {
    return { provider: "antigravity", id: model }
  }
  return { provider: "claude", id: model }
}
