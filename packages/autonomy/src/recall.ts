// Recall is pushed, never left to the agent, in three tiers (measured: .experiments/recall):
// - the user's rules and my lessons: each memory that keeps their words, and each lesson carried
//   from Switchboard, whole, in every turn where it holds (global, then down the tree), in the system
//   prompt's cached part (Switchboard's core/context.rs:254-258, 821-828, 371-377). The compressed
//   core fields below are the gates' reading of them (rules.ts).
// - situational: before each message, full text and vectors, then a loose decision-model filter.
// - triggered: memories tied to an action, filtered the same way right before a matching tool call.
import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { Memory as MemorySlot } from "@switch/agent"
import { allSpaces, Brain, EventId, whoOf } from "@switch/brain"
import { Models } from "@switch/models"
import type { Question } from "@switch/models"
import type { SpaceId } from "@switch/brain"
import { Effect, Layer } from "effect"

import { strings } from "./json.ts"
import {
  embedMissing,
  fts,
  getMemory,
  GLOBAL,
  LESSON,
  liveMemories,
  MemoryCore,
  memoryText,
  MemoryUsed,
  nearest,
  saidLine,
  scopesOf,
} from "./memory.ts"
import type { Memory, Scope } from "./memory.ts"

/** Tokens, as the recall eval counted them. */
export const tokens = (text: string) => Math.max(1, Math.round(text.length / 4))

const GLOBAL_CAP = 2000
const SPACE_CAP = 1000
const ROUNDS = 8

interface Core {
  readonly scope: string
  readonly text: string
  readonly sources: readonly string[]
  readonly from: string
}

const parseSources = (json: string) => strings(JSON.parse(json))

export const cores = (db: Database): Map<string, Core> =>
  new Map(
    db
      .query<{ scope: string; text: string; sources: string; built_from: string }, []>(
        "SELECT scope, text, sources, built_from FROM memory_cores",
      )
      .all()
      .map((r) => [
        r.scope,
        { scope: r.scope, text: r.text, sources: parseSources(r.sources), from: r.built_from },
      ]),
  )

const isRule = (m: Memory) => m.type === "feedback" || m.type === "user"

/** A `Label: …` line of a lesson's body. */
const lineOf = (body: string, label: string) =>
  body
    .split("\n")
    .find((l) => l.startsWith(`${label}: `))
    ?.slice(label.length + 2)
    .trim() ?? ""

/**
 * What every turn in `space` reads whole, broadest scope first: the user's rules, each memory that
 * keeps their own words, which it does only when it's their rule (memory.ts `saidOf`), whatever its
 * type (a wake rule is triage's), then my lessons (`LESSON`); oldest first so a new one adds to the
 * end. Switchboard showed every rule and lesson that holds, whole, never the strongest few or the
 * first part of one (core/context.rs:254-258: "never claim I verified something I didn't" reached no
 * turn when only 40 of 201 showed, each cut).
 */
const heldWhole = (db: Database, space: Scope) => {
  const scopes = scopesOf(db, space)
  const live = liveMemories(db).filter((m) => !m.name.startsWith("wake-rule-"))
  const rules = live.filter((m) => m.said !== null)
  const lessons = live.filter(
    (m) => m.said === null && m.name.startsWith(LESSON) && lineOf(m.body, "Learned") !== "",
  )
  return scopes.flatMap((scope) => [
    ...rules
      .filter((m) => m.scope === scope)
      .toSorted((a, b) => (a.said?.time ?? 0) - (b.said?.time ?? 0) || a.id.localeCompare(b.id)),
    ...lessons
      .filter((m) => m.scope === scope)
      .toSorted((a, b) => a.writtenAt - b.writtenAt || a.id.localeCompare(b.id)),
  ])
}

const oneLine = (text: string) => text.replaceAll(/\s+/gu, " ").trim()

/** What I keep from a rule: its lesson, the body's first paragraph, on one line. */
const lessonOf = (m: Memory) =>
  oneLine(m.body.split(/\n\s*\n|\*\*Why:\*\*/u)[0] ?? "") || m.description

/**
 * A lesson as Switchboard showed it: `My lesson (when, after what prompted it): …`, the prompt cut
 * at 120 characters (core/context.rs:271-274, protocol/src/whose.rs `PROMPTED_CHARS`). Its words are
 * the body before its `Learned:` line.
 */
const lessonLine = (m: Memory) => {
  const at = m.body.indexOf("\n\nLearned: ")
  const words = oneLine(at === -1 ? m.body : m.body.slice(0, at))
  const after = oneLine(lineOf(m.body, "After"))
  const learned = lineOf(m.body, "Learned")
  return `My lesson (${learned}${after === "" ? "" : `, after ${after.length > 120 ? `${after.slice(0, 120)}…` : after}`}): ${words}`
}

/**
 * The user's rules and my lessons, as every turn in `space` reads them, each saying whose words it
 * is (core/context.rs:260-277 `rule_line`, 280-288 `whose_words`).
 */
export const coreText = (db: Database, space: Scope) => {
  const held = heldWhole(db, space)
  return held.length === 0
    ? ""
    : [
        'The user\'s rules and preferences, and my lessons. Each says whose words it is. A line that starts User (a date) quotes what the user said then, word for word, and after the → is what I keep from it; My lesson is my own conclusion from what happened, never the user\'s instruction. When you cite a rule to the user, quote only their own words, from a line marked User, and never present a lesson of mine as something they said, asked for or set ("you said…", "your rule…"): say it\'s my own lesson.',
        ...held.map((m) =>
          m.said === null ? `- ${lessonLine(m)}` : `- ${saidLine(m)} → ${lessonOf(m)}`,
        ),
      ].join("\n")
}

/** Memories every turn in a space reads whole already: situational recall skips them. */
const conveyed = (db: Database, space: SpaceId) => new Set(heldWhole(db, space).map((m) => m.id))

const source = (m: Memory) =>
  `[${m.id}] ${m.description}\n${[saidLine(m), m.body].filter((x) => x !== "").join("\n")}`

const COMPRESS = `You are compressing an AI assistant's always-loaded memory: the rules and preferences below, which hold {where}. Write the core: the text loaded into every turn there, at most {cap} tokens (about {words} words). It should carry what applies nearly everywhere it loads, so the assistant acts right even when nothing else is recalled.

- Keep what applies across most turns and what is costly to break. Drop or shorten what is narrow, rare or already implied by another line.
- Merge overlapping memories into one line. Keep concrete specifics where they change behavior.
- After each line, list in brackets the ids of every source memory that line conveys well enough to act on, e.g. "- Never ... [id-one,id-two]".
- Stay under the cap: count roughly 0.75 words per token; the bracketed ids don't count.

Answer with the core lines only.`

const stripIds = (text: string) =>
  text
    .split("\n")
    .map((l) => l.replace(/\s*\[[a-z0-9,\s-]+\]\s*$/u, ""))
    .join("\n")
    .trim()

const idsIn = (draft: string) =>
  [...draft.matchAll(/\[(?<ids>[a-z0-9,\s-]+)\]\s*$/gmu)].flatMap((m) =>
    (m.groups?.ids ?? "").split(",").map((s) => s.trim()),
  )

/**
 * Builds one core field: verbatim when its rules fit the cap, else compressed in rounds by the
 * heavy model, each round told how far over it is, the target tightening after two. At most eight
 * rounds; one still over is kept as it is.
 */
const buildCore = (scope: string, where: string, cap: number, rules: readonly Memory[]) =>
  Effect.gen(function* building() {
    const models = yield* Models
    const from = createHash("sha256")
      .update(rules.map((m) => `${m.id}\n${m.body}`).join("\n"))
      .digest("hex")
      .slice(0, 16)
    const verbatim = rules.map((m) => `- ${m.body.split("\n")[0] ?? m.description}`).join("\n")
    if (tokens(verbatim) <= cap) {
      return {
        scope,
        text: verbatim,
        sources: rules.map((m) => m.id),
        tokens: tokens(verbatim),
        from,
        cost: 0,
        rounds: 0,
      }
    }
    const system = COMPRESS.replace("{where}", where)
    const sources = rules.map(source).join("\n\n")
    let draft = ""
    let cost = 0
    let rounds = 0
    for (; rounds < ROUNDS; rounds += 1) {
      const target = rounds >= 2 ? Math.round(cap * 0.75) : cap
      const sys = system
        .replace("{cap}", String(target))
        .replace("{words}", String(Math.round(target * 0.75)))
      const prompt =
        draft === ""
          ? sources
          : `${sources}\n\nYour last draft is ${tokens(stripIds(draft))} tokens, ${Math.round((tokens(stripIds(draft)) / cap - 1) * 100)}% over the ${cap}-token cap. Cut it to at most ${target} tokens: merge lines and drop the narrowest. The draft:\n\n${draft}`
      const done = yield* models.complete("turn", sys, prompt)
      cost += done.cost
      draft = done.text.trim()
      if (tokens(stripIds(draft)) <= cap) {
        break
      }
    }
    const text = stripIds(draft)
    const known = new Set(rules.map((m) => m.id))
    return {
      scope,
      text,
      sources: [...new Set(idsIn(draft))].filter((id) => known.has(id)),
      tokens: tokens(text),
      from,
      cost,
      rounds: rounds + 1,
    }
  })

/** Rebuilds every core field whose rules changed. Returns what each cost. */
export const buildCores = Effect.gen(function* rebuilding() {
  const brain = yield* Brain
  const { live, spaces, built } = yield* brain.read((db) => ({
    live: liveMemories(db).filter(isRule),
    spaces: allSpaces(db).filter((s) => !s.archived),
    built: cores(db),
  }))
  const scopes = [
    { scope: GLOBAL, where: "everywhere", cap: GLOBAL_CAP },
    ...spaces.map((s) => ({
      scope: s.id,
      where: `in ${s.name} and the spaces inside it`,
      cap: SPACE_CAP,
    })),
  ]
  const out: { scope: string; tokens: number; rounds: number; cost: number }[] = []
  for (const s of scopes) {
    const rules = live.filter((m) => m.scope === s.scope)
    const old = built.get(s.scope)
    if (rules.length === 0 && old === undefined) {
      continue
    }
    const c = yield* buildCore(s.scope, s.where, s.cap, rules)
    if (old?.from === c.from) {
      continue
    }
    yield* Effect.orDie(
      brain.ingest([
        {
          id: EventId.make(`core:${s.scope}:${c.from}`),
          type: MemoryCore.type,
          source: "autonomy",
          payload: {
            scope: c.scope,
            text: c.text,
            sources: c.sources,
            tokens: c.tokens,
            from: c.from,
          },
        },
      ]),
    )
    out.push({ scope: s.scope, tokens: c.tokens, rounds: c.rounds, cost: c.cost })
  }
  return out
})

// The loose filter: one yes/no per candidate, in parallel chunks of 20; p ≥ 0.5 kept.

const SITUATIONAL =
  "I am the user's assistant, about to answer the message in the item. Keep a memory only when having it in view would change or inform " +
  "what I do or say in this turn: a rule or preference that governs this kind of work, or a fact or procedure I'd need. Drop memories that are merely on the same topic."
const TRIGGERED =
  "I am the user's assistant, about to make the tool call in the item. Keep a memory only when it should be in view right before this exact call: " +
  "it tells me how to do this action, what to check first, or not to do it."
const CHUNK = 20
const KEEP = 0.5
const K = 20

const filter = (
  context: string,
  item: string,
  instructions: string,
  candidates: readonly Memory[],
) =>
  Effect.gen(function* filtering() {
    const models = yield* Models
    const chunks: Memory[][] = []
    for (let i = 0; i < candidates.length; i += CHUNK) {
      chunks.push(candidates.slice(i, i + CHUNK))
    }
    const decided = yield* Effect.forEach(
      chunks,
      (chunk) => {
        const questions: Record<string, Question> = Object.fromEntries(
          chunk.map((m, i) => [
            `m${i}`,
            {
              instructions: `${instructions}\n\nMemory: ${memoryText(m).slice(0, 700)}`,
              choices: [
                {
                  value: "yes",
                  description:
                    "It applies here: having it in view would change or inform what I do next.",
                },
                { value: "no", description: "It does not bear on this moment." },
              ],
            },
          ]),
        )
        return Effect.map(models.decide({ stable: context, item }, questions), (d) =>
          chunk.filter((_, i) => (d.answers[`m${i}`]?.probabilities.yes ?? 0) >= KEEP),
        )
      },
      { concurrency: "unbounded" },
    )
    return decided.flat()
  })

const used = (space: SpaceId, kept: readonly Memory[]) =>
  Effect.gen(function* using() {
    if (kept.length === 0) {
      return
    }
    const brain = yield* Brain
    yield* Effect.orDie(
      brain.ingest([
        {
          id: EventId.make(`used:${crypto.randomUUID()}`),
          type: MemoryUsed.type,
          source: "autonomy",
          payload: { ids: kept.map((m) => m.id), space },
        },
      ]),
    )
  })

const render = (kept: readonly Memory[]) =>
  kept
    .map((m) => {
      const body = m.body.replaceAll(/\s+/gu, " ").slice(0, 600)
      const said = saidLine(m)
      return said === "" ? `- ${m.description}: ${body}` : `- ${said} → ${m.description}: ${body}`
    })
    .join("\n")

/** Candidates for `query`: vector top 20 and full-text top 20, minus what `skip` holds. */
export const candidates = (query: string, skip: ReadonlySet<string>, k = K) =>
  Effect.gen(function* finding() {
    const brain = yield* Brain
    const models = yield* Models
    const q = yield* Effect.option(models.embed([query]))
    return yield* brain.read((db) => {
      const live = new Set(liveMemories(db).map((m) => m.id))
      const keep = (id: string) => live.has(id) && !skip.has(id)
      const byVector =
        q._tag === "Some" && q.value.vectors[0] ? nearest(db, q.value.vectors[0], k, keep) : []
      const byText = fts(db, query, Math.min(600, k + skip.size))
        .filter(keep)
        .slice(0, k)
      return [...new Set([...byVector, ...byText])].flatMap((id) => getMemory(db, id) ?? [])
    })
  })

// The exchange before the message: the agent's last reply carries what a short follow-up is about.
const exchangeBefore = (db: Database, space: SpaceId) => {
  const table = db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM sqlite_master WHERE name = 'messages'")
    .get()
  if ((table?.n ?? 0) === 0) {
    return ""
  }
  const rows = db
    .query<{ source: string; text: string }, [string]>(
      "SELECT source, text FROM messages WHERE space = ? ORDER BY seq DESC LIMIT 3",
    )
    .all(space)
  const user = rows.slice(1).find((r) => whoOf(r.source) === "user")?.text ?? ""
  const me = rows.find((r) => r.source === "agent")?.text ?? ""
  return user === "" && me === "" ? "" : `User: ${user.slice(0, 400)}\nMe: ${me.slice(0, 500)}`
}

export interface RecallOptions {
  /** The exchange before the message; read from the space's chat when left out. */
  readonly before?: string
  /** What the message is about, as the pre-read titled it. */
  readonly title?: string
  /** Memories not to consider, beside what the core fields convey. */
  readonly skip?: ReadonlySet<string>
  /** Record what's kept as used (default true). */
  readonly record?: boolean
}

/** What applies to this message: searched, then filtered loosely. */
export const situational = (space: SpaceId, message: string, options: RecallOptions = {}) =>
  Effect.gen(function* recalling() {
    const brain = yield* Brain
    const { name, skip, before } = yield* brain.read((db) => ({
      name: allSpaces(db).find((s) => s.id === space)?.name ?? space,
      skip: new Set([...conveyed(db, space), ...(options.skip ?? [])]),
      before: options.before ?? exchangeBefore(db, space),
    }))
    const where = options.title === undefined ? name : `${name} / ${options.title}`
    const query = `${message}\nSpace: ${where}${before === "" ? "" : `\nBefore: ${before}`}`
    const found = yield* candidates(query, skip)
    const context = `The user's message: ${message.slice(0, 1500)}\nSpace: ${where}${before === "" ? "" : `\nThe exchange before it: ${before}`}`
    const kept = yield* filter(
      context,
      "Which of my memories apply to answering this message?",
      SITUATIONAL,
      found,
    )
    if (options.record !== false) {
      yield* used(space, kept)
    }
    return kept
  })

const glob = (pattern: string, name: string) => {
  if (pattern.startsWith("*") && pattern.endsWith("*")) {
    return name.includes(pattern.slice(1, -1))
  }
  if (pattern.endsWith("*")) {
    return name.startsWith(pattern.slice(0, -1))
  }
  if (pattern.startsWith("*")) {
    return name.endsWith(pattern.slice(1))
  }
  return name === pattern
}

const TRIGGER_MAX = 30

/** Memories tied to this kind of call, filtered against it. `before` is the turn so far. */
export const triggered = (
  space: SpaceId,
  tool: string,
  input: string,
  before: string,
  options: RecallOptions = {},
) =>
  Effect.gen(function* triggering() {
    const brain = yield* Brain
    const models = yield* Models
    const lower = input.toLowerCase()
    let hits = yield* brain.read((db) =>
      liveMemories(db).filter(
        (m) =>
          m.trigger !== null &&
          options.skip?.has(m.id) !== true &&
          m.trigger.tools.some((t) => glob(t, tool)) &&
          (m.trigger.words.length === 0 || m.trigger.words.some((w) => lower.includes(w))),
      ),
    )
    if (hits.length === 0) {
      return []
    }
    if (hits.length > TRIGGER_MAX) {
      const q = yield* Effect.option(models.embed([`${tool} ${input.slice(0, 1500)}`]))
      const [query] = q._tag === "Some" ? q.value.vectors : []
      if (query) {
        const ids = new Set(hits.map((m) => m.id))
        const order = yield* brain.read((db) =>
          nearest(db, query, TRIGGER_MAX, (id) => ids.has(id)),
        )
        hits = order.flatMap((id) => hits.find((m) => m.id === id) ?? [])
      } else {
        hits = hits.slice(0, TRIGGER_MAX)
      }
    }
    const context = `Space: ${space}\nWhat I did so far this turn: ${before.slice(-1500)}`
    const kept = yield* filter(
      context,
      `Next tool call: ${tool} ${input.slice(0, 1200)}`,
      TRIGGERED,
      hits,
    )
    if (options.record !== false) {
      yield* used(space, kept)
    }
    return kept
  })

/** The Memory slot the core leaves open: the user's rules at launch, recall before each message. */
export const memoryLayer = Layer.effect(
  MemorySlot,
  Effect.gen(function* making() {
    const brain = yield* Brain
    const models = yield* Models
    // Vectors for whatever was written while this was down.
    yield* Effect.forkDetach(
      Effect.ignore(
        Effect.provideService(Effect.provideService(embedMissing, Brain, brain), Models, models),
        {
          log: "Warn",
          message: "Embedding memories failed",
        },
      ),
    )
    const provide = <A, E>(e: Effect.Effect<A, E, Brain | Models>) =>
      e.pipe(Effect.provideService(Brain, brain), Effect.provideService(Models, models))
    return {
      core: (space: SpaceId) => brain.read((db) => coreText(db, space)),
      recall: (space: SpaceId, text: string) =>
        provide(situational(space, text)).pipe(
          Effect.map(render),
          Effect.orElseSucceed(() => ""),
        ),
    }
  }),
)

/** `memory(space, message)`: the user's rules and what's recalled for this message, as one block. */
export const memory = (space: SpaceId, message: string) =>
  Effect.gen(function* both() {
    const brain = yield* Brain
    const core = yield* brain.read((db) => coreText(db, space))
    const kept = yield* Effect.orElseSucceed(situational(space, message), () => [])
    return [core, render(kept)].filter((s) => s.trim() !== "").join("\n\n")
  })

export { render as renderMemories }
