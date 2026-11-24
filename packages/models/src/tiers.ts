// Each subscription's models, tier for tier: heavy (Opus-class) runs turns, mid (Sonnet-class)
// and light (Haiku-class) take tasks and small work. Prices are list, $ per million tokens; the
// subscriptions don't bill per token, so these only weigh what a turn used.
//
// Looked up 2026-11-19:
// - Claude: platform.claude.com/docs/en/about-claude/pricing, code.claude.com/docs/en/model-config.
//   The CLI aliases resolve to claude-opus-5-5, claude-sonnet-5-5 and claude-haiku-5-5.
// - Codex: `model/list` from `codex app-server` 0.164.0 on a ChatGPT login (gpt-6.1-terra
//   default, gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-*); prices from
//   developers.openai.com/api/docs/pricing. The docs also name gpt-6.2-astra and gpt-6.2-sol,
//   which this login doesn't list yet. Luna matches Haiku's price exactly; Terra sits between.
// - Antigravity: antigravity.google/docs/models and aistudio.google.com/docs/pricing. Gemini 4
//   Neon is the default for new conversations; Carbon is Ultra-only. T3 Code's manifest lists
//   gemini-4-carbon, gemini-4-argon and gemini-3.8-flash. Not checked against `agy` here: no
//   Antigravity sign-in on this Mac. agy names effort in the id ("gemini-4-neon-xhigh").

export type Tier = "heavy" | "mid" | "light"
export const TIERS: readonly Tier[] = ["heavy", "mid", "light"]

/** A subscription a turn can run on, through its own agent CLI. */
export type Subscription =
  | "claude"
  | "codex"
  | "antigravity"
  | "fx"
  | "cursor"
  | "opencode"
  | "grok"
  | "kiro"
  | "pi"
  | "muse"
  | "acp"
export const SUBSCRIPTIONS: readonly Subscription[] = [
  "claude",
  "codex",
  "antigravity",
  "fx",
  "cursor",
  "opencode",
  "grok",
  "kiro",
  "pi",
  "muse",
  "acp",
]

export interface Price {
  readonly input: number
  readonly cachedInput: number
  readonly cacheWrite: number
  readonly output: number
}

export interface TierModel {
  /** As the provider's CLI takes it. */
  readonly id: string
  readonly price: Price
}

const price = (input: number, cachedInput: number, cacheWrite: number, output: number): Price => ({
  input,
  cachedInput,
  cacheWrite,
  output,
})

export const tiers: Readonly<Record<Subscription, Readonly<Record<Tier, TierModel>>>> = {
  cursor: {
    heavy: { id: "default", price: price(0, 0, 0, 0) },
    mid: { id: "default", price: price(0, 0, 0, 0) },
    light: { id: "default", price: price(0, 0, 0, 0) },
  },
  opencode: {
    heavy: { id: "default", price: price(0, 0, 0, 0) },
    mid: { id: "default", price: price(0, 0, 0, 0) },
    light: { id: "default", price: price(0, 0, 0, 0) },
  },
  grok: {
    heavy: { id: "default", price: price(0, 0, 0, 0) },
    mid: { id: "default", price: price(0, 0, 0, 0) },
    light: { id: "default", price: price(0, 0, 0, 0) },
  },
  kiro: {
    heavy: { id: "default", price: price(0, 0, 0, 0) },
    mid: { id: "default", price: price(0, 0, 0, 0) },
    light: { id: "default", price: price(0, 0, 0, 0) },
  },
  pi: {
    heavy: { id: "default", price: price(0, 0, 0, 0) },
    mid: { id: "default", price: price(0, 0, 0, 0) },
    light: { id: "default", price: price(0, 0, 0, 0) },
  },
  muse: {
    heavy: { id: "default", price: price(0, 0, 0, 0) },
    mid: { id: "default", price: price(0, 0, 0, 0) },
    light: { id: "default", price: price(0, 0, 0, 0) },
  },
  acp: {
    heavy: { id: "default", price: price(0, 0, 0, 0) },
    mid: { id: "default", price: price(0, 0, 0, 0) },
    light: { id: "default", price: price(0, 0, 0, 0) },
  },
  claude: {
    heavy: { id: "opus", price: price(4, 0.2, 8, 20) },
    mid: { id: "sonnet", price: price(2, 0.1, 4, 10) },
    light: { id: "haiku", price: price(0.1, 0.01, 0.2, 0.5) },
  },
  codex: {
    heavy: { id: "gpt-6-astra", price: price(10, 1, 0, 50) },
    mid: { id: "gpt-6.1-sol", price: price(2, 0.1, 0, 10) },
    light: { id: "gpt-6-luna", price: price(0.1, 0.01, 0, 0.5) },
  },
  fx: {
    heavy: { id: "default", price: price(0, 0, 0, 0) },
    mid: { id: "default", price: price(0, 0, 0, 0) },
    light: { id: "default", price: price(0, 0, 0, 0) },
  },
  antigravity: {
    heavy: { id: "gemini-4-neon", price: price(3, 0.15, 0, 15) },
    mid: { id: "gemini-4-argon", price: price(2, 0.1, 0, 10) },
    light: { id: "gemini-3.8-flash", price: price(0.75, 0.075, 0, 3.75) },
  },
}

/** Every model a subscription offers that's worth pricing, beyond its tiers. */
const others: Readonly<Record<string, Price>> = {
  "gpt-6.1-terra": price(1, 0.05, 0, 5),
  "gpt-6-sol": price(2, 0.1, 0, 10),
  "gemini-4-carbon": price(2, 0.1, 0, 10),
  "gemini-4-hydrogen": price(1.5, 0.075, 0, 7.5),
}

/** A model's list price, matched on its id or the id's start (agy adds effort to it). */
export const priceOf = (model: string): Price | null => {
  for (const models of Object.values(tiers)) {
    for (const m of Object.values(models)) {
      if (model === m.id || model.startsWith(`${m.id}-`)) {
        return m.price
      }
    }
  }
  for (const [id, p] of Object.entries(others)) {
    if (model === id || model.startsWith(`${id}-`)) {
      return p
    }
  }
  return null
}

export interface Tokens {
  /** Uncached input. */
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
}

export const listCost = (model: string, t: Tokens) => {
  const p = priceOf(model)
  if (!p) {
    return 0
  }
  return (
    (t.input * p.input +
      t.cacheRead * p.cachedInput +
      t.cacheWrite * p.cacheWrite +
      t.output * p.output) /
    1e6
  )
}

const NUMBER = /^\d+(?:\.\d+)*$/u
const DIGITS = /^\d+$/u
/** What some CLIs add to a model's id: a release date, an effort, a context window ("[1m]"). */
const SUFFIX = /(?:-(?:\d{8}|minimal|low|medium|high|xhigh|max))?(?:\[\w+\])?$/u

/**
 * A model's display name from its id: "claude-opus-5-5" is "Opus 5.5", "gpt-6-astra" "GPT-6 Astra",
 * "gemini-4-neon-xhigh" "Gemini 4 Neon".
 */
export const modelName = (id: string) => {
  const words: string[] = []
  for (const w of id
    .replace(/^claude-/u, "")
    .replace(SUFFIX, "")
    .split("-")) {
    const last = words.at(-1)
    if (last !== undefined && DIGITS.test(w) && NUMBER.test(last)) {
      words[words.length - 1] = `${last}.${w}`
    } else if (last === "GPT" && NUMBER.test(w)) {
      words[words.length - 1] = `GPT-${w}`
    } else if (w === "gpt") {
      words.push("GPT")
    } else if (w !== "") {
      words.push(`${w.charAt(0).toUpperCase()}${w.slice(1)}`)
    }
  }
  return words.join(" ")
}
