// The user's rules and preferences, as each place that decides reads them: the core fields of the
// spaces it bears on (global first), and the rules among the memories that match what it decides
// about which those cores don't already carry. Criteria stay in code; these say which way they go.
import type { Database } from "bun:sqlite"
import { SpaceId } from "@switch/brain"
import { Layer } from "effect"

import { RulesAbout } from "./bypass.ts"

import { fts, getMemory, rulesFor, scopesOf } from "./memory.ts"
import type { Scope } from "./memory.ts"
import { cores } from "./recall.ts"

/** For `spaces`, about `about`: "" when the user has none. */
export const rulesAt = (db: Database, spaces: readonly Scope[], about: string, k = 6) => {
  const scopes = new Set<string>(spaces.flatMap((s) => scopesOf(db, s)))
  const all = cores(db)
  const held = [...scopes].flatMap((s) => {
    const c = all.get(s)
    return c && c.text.trim() !== "" ? [c] : []
  })
  const conveyed = new Set(held.flatMap((c) => c.sources))
  const matched = fts(db, about, 32)
    .flatMap((id) => {
      const m = conveyed.has(id) ? null : getMemory(db, id)
      return m !== null && scopes.has(m.scope) && (m.type === "feedback" || m.type === "user")
        ? [`- ${m.description === "" ? m.body : m.description}`]
        : []
    })
    .slice(0, k)
  const text = [...held.map((c) => c.text.trim()), matched.join("\n")]
    .filter((s) => s !== "")
    .join("\n\n")
  return text === "" ? "" : `The user's rules and preferences:\n${text}`
}

/** The rules among the memories that bear on a bypass's reason, a line each, for its judge. */
export const rulesAboutLayer = Layer.succeed(RulesAbout, {
  about: (db, space, text) =>
    rulesFor(db, SpaceId.make(space), text, 6)
      .map((r) => `- ${r.text}`)
      .join("\n"),
})

/**
 * Switchboard's `wakes` (protocol/src/kernels.rs `Wakes`): which records a rule reads (streams, kinds,
 * fields that must match, sources that don't count, only the first record about an entity), how long a
 * burst gathers, and how sure it must be (null: a trigger's, rules alone, core/triggers.rs). `unless`
 * is a trigger's: fields that rule a record out.
 */
export interface WakeFilter {
  readonly streams: readonly string[]
  readonly kinds: readonly string[]
  readonly match: Readonly<Record<string, unknown>>
  readonly notFrom: readonly string[]
  readonly first: boolean
  readonly batchS: number | null
  readonly at: number | null
  readonly unless: Readonly<Record<string, unknown>>
}

export interface WakeRule {
  /** Its name (`wake-rule-…`): what its burst gathers under. */
  readonly name: string
  /** Its name as it was given (the kernel's, "New mail"). */
  readonly title: string
  /** Its own words, and what it woke on there. */
  readonly words: string
  /** Its question alone: its body's first paragraph. */
  readonly question: string
  /** What its turn is for, when it says. */
  readonly goal: string
  readonly wakes: WakeFilter | null
}

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
const texts = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : [])

/** A `Name: {…}` line of a rule's body, as JSON. */
const jsonLine = (body: string, name: string): Readonly<Record<string, unknown>> | null => {
  const line = body.split("\n").find((l) => l.startsWith(`${name}: `))
  if (line === undefined) {
    return null
  }
  try {
    const v: unknown = JSON.parse(line.slice(name.length + 2))
    return isRecord(v) ? v : null
  } catch {
    return null
  }
}

/** The `Wakes: {…}` (and a trigger's `Unless: {…}`) lines of a rule's body, as Switchboard kept them. */
const filterOf = (body: string): WakeFilter | null => {
  const w = jsonLine(body, "Wakes")
  if (w === null) {
    return null
  }
  return {
    streams: texts(w.streams),
    kinds: texts(w.kinds),
    match: isRecord(w.match) ? w.match : {},
    notFrom: texts(w.not_from),
    first: w.first === true,
    batchS: typeof w.batch_s === "number" ? w.batch_s : null,
    at: typeof w.at === "number" ? w.at : null,
    unless: jsonLine(body, "Unless") ?? {},
  }
}

/** A `Label: …` line of a rule's body. */
const lineOf = (body: string, label: string) =>
  body
    .split("\n")
    .find((l) => l.startsWith(`${label}: `))
    ?.slice(label.length + 2)
    .trim() ?? ""

/** A name from a rule's memory name, for one written before names were kept. */
const titleOf = (name: string) => {
  const words = name.replace(/^wake-rule-/u, "").replaceAll("-", " ")
  return `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`
}

/** A wake rule, as its memory keeps it (`wakeRuleMemory`). */
export const ruleOf = (m: {
  readonly name: string
  readonly description: string
  readonly body: string
}): WakeRule => ({
  name: m.name,
  title: lineOf(m.body, "Name") || titleOf(m.name),
  words: m.description,
  question: m.body.split("\n\n")[0]?.trim() ?? "",
  goal: lineOf(m.body, "Its turn"),
  wakes: filterOf(m.body),
})

const liveRules = (db: Database) =>
  db
    .query<{ name: string; description: string; body: string; scope: string }, []>(
      "SELECT name, description, body, scope FROM memories WHERE status = 'live' AND name LIKE 'wake-rule-%' ORDER BY written_at",
    )
    .all()

/**
 * A resource alarm's `Alarm: {…}` line: what of a machine's vitals it reads (`on`, a field of the
 * reading, or one over another, `load5/cores`), the line it crosses (`above` or `below` a number, or
 * `is` one of some words), where it's over (`clear`: a number past which, or the words; else back
 * over its line), and what its heaviest processes are heaviest in (`by`: memory or cpu).
 */
export interface AlarmLine {
  readonly on: string
  readonly above: number | null
  readonly below: number | null
  readonly is: readonly string[]
  readonly clear: number | readonly string[] | null
  readonly by: "memory" | "cpu"
}

export interface Alarm {
  readonly name: string
  readonly title: string
  readonly question: string
  readonly goal: string
  readonly alarm: AlarmLine
}

const words = (v: unknown) => (typeof v === "string" ? [v] : texts(v))

/** The `Alarm: {…}` line of a rule's body, or null when it isn't an alarm. */
const alarmOf = (body: string): AlarmLine | null => {
  const a = jsonLine(body, "Alarm")
  if (a === null || typeof a.on !== "string" || a.on === "") {
    return null
  }
  const above = typeof a.above === "number" ? a.above : null
  const below = typeof a.below === "number" ? a.below : null
  const is = words(a.is)
  if (above === null && below === null && is.length === 0) {
    return null
  }
  const { clear } = a
  return {
    on: a.on,
    above,
    below,
    is,
    clear: typeof clear === "number" || clear === undefined ? (clear ?? null) : words(clear),
    by: a.by === "cpu" ? "cpu" : "memory",
  }
}

/**
 * The user's wake rules (`wake-rule-…`: Switchboard's kernels and triggers brought across, and the ones
 * the agent writes from the user's words), for the spaces given: triage reads every one against what
 * comes in, as Switchboard read every kernel. A resource alarm is the alarms' (`alarmsOf`), not triage's.
 */
export const wakeRulesOf = (db: Database, spaces: readonly Scope[]): WakeRule[] => {
  const scopes = new Set<string>(spaces.flatMap((s) => scopesOf(db, s)))
  return liveRules(db)
    .filter((m) => scopes.has(m.scope) && alarmOf(m.body) === null)
    .map(ruleOf)
}

/** The wake rules that are resource alarms, read against each machine's vitals (core alarms.ts). */
export const alarmsOf = (db: Database): Alarm[] =>
  liveRules(db).flatMap((m) => {
    const alarm = alarmOf(m.body)
    if (alarm === null) {
      return []
    }
    const rule = ruleOf(m)
    return [{ name: m.name, title: rule.title, question: rule.question, goal: rule.goal, alarm }]
  })

/** A wake rule's memory name: `wake-rule-` and its name in lowercase words. */
export const wakeRuleName = (name: string) =>
  `wake-rule-${name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 60)}`

const num = (v: unknown, fallback: number) => (typeof v === "number" ? v : fallback)

/** What it wakes on, in words, from Switchboard's `wakes` (null `at`: a trigger, rules alone). */
const wokeOn = (wakes: Readonly<Record<string, unknown>>, at: number | null) =>
  [
    `streams ${JSON.stringify(wakes.streams ?? [])}`,
    `kinds ${JSON.stringify(wakes.kinds ?? [])}`,
    wakes.match === undefined ? "" : `match ${JSON.stringify(wakes.match)}`,
    wakes.not_from === undefined ? "" : `not from ${JSON.stringify(wakes.not_from)}`,
    wakes.first === true ? "first record about a thing only" : "",
    `gathered ${String(num(wakes.batch_s, at === null ? 60 : 120))} s`,
    at === null ? "rules alone, no model" : `woke at p ≥ ${String(at)}`,
  ]
    .filter((x) => x !== "")
    .join("; ")

/** What an alarm rings on, in words. */
const rungOn = (a: Readonly<Record<string, unknown>>) => {
  let line = `is ${JSON.stringify(a.is)}`
  if (typeof a.above === "number") {
    line = `above ${String(a.above)}`
  } else if (typeof a.below === "number") {
    line = `below ${String(a.below)}`
  }
  return [
    `${String(a.on)} ${line}`,
    a.clear === undefined ? "" : `clear at ${JSON.stringify(a.clear)}`,
    `the heaviest by ${a.by === "cpu" ? "cpu" : "memory"}`,
    "once an episode, rules alone, no model",
  ]
    .filter((x) => x !== "")
    .join("; ")
}

/**
 * A wake rule as a memory keeps it: its question (the description, with what it wakes on), and a body
 * of the question, what it wakes on, what its turn is for, Switchboard's `wakes` as JSON (with `at`,
 * null for a trigger), a trigger's `unless`, and where it came from. Triage reads it back (`wakeRulesOf`).
 * A resource alarm keeps its `Alarm` line in the place of `Wakes` (`alarmsOf`).
 */
export const wakeRuleMemory = (input: {
  readonly name: string
  readonly question: string
  readonly goal: string
  readonly wakes: Readonly<Record<string, unknown>>
  readonly at: number | null
  readonly unless?: Readonly<Record<string, unknown>>
  readonly alarm?: Readonly<Record<string, unknown>>
  readonly from: string
}) => {
  const on = input.alarm === undefined ? wokeOn(input.wakes, input.at) : rungOn(input.alarm)
  const unless = input.unless ?? {}
  return {
    name: wakeRuleName(input.name),
    description: `${input.question} (Woke on: ${on}.)`,
    body: [
      input.question,
      `Name: ${input.name}`,
      `Woke on: ${on}.`,
      input.goal === "" ? "" : `Its turn: ${input.goal}`,
      input.alarm === undefined
        ? `Wakes: ${JSON.stringify({ ...input.wakes, at: input.at })}`
        : `Alarm: ${JSON.stringify(input.alarm)}`,
      Object.keys(unless).length === 0 ? "" : `Unless: ${JSON.stringify(unless)}`,
      input.from,
    ]
      .filter((x) => x !== "")
      .join("\n\n"),
  }
}
