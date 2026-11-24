// Switchboard's wake rules, as the brain data they are: each kernel the agent made to be woken (a
// turn body) and each trigger, as a rule triage reads, in its own words, with what it woke on, what
// its turn was for, and which Switchboard record it was. Retired ones stay behind.
import { createHash } from "node:crypto"
import { Brain, EventId } from "@switch/brain"
import { MemoryWritten, wakeRuleMemory } from "@switch/autonomy"
import { Effect } from "effect"

import { num, obj, str, Switchboard } from "./source.ts"
import type { Body } from "./source.ts"

const slug = (s: string) =>
  s
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 60)

const rule = (input: {
  readonly name: string
  readonly question: string
  readonly goal: string
  readonly wakes: Body
  readonly at: number | null
  readonly unless: Body
  readonly record: string
  readonly seq: number
}) => {
  const kept = wakeRuleMemory({
    name: input.name,
    question: input.question,
    goal: input.goal,
    wakes: input.wakes,
    at: input.at,
    unless: input.unless,
    from: `Switchboard's ${input.record} (seq ${String(input.seq)}).`,
  })
  // A run that brings the same rule across again writes nothing; a changed one, its new version.
  const version = createHash("sha256")
    .update(
      JSON.stringify([
        input.name,
        input.question,
        input.goal,
        input.wakes,
        input.at,
        ...(Object.keys(input.unless).length > 0 ? [input.unless] : []),
      ]),
    )
    .digest("hex")
    .slice(0, 12)
  return {
    id: EventId.make(`${kept.name}:${version}`),
    type: MemoryWritten.type,
    source: "migrate",
    payload: {
      id: kept.name,
      name: kept.name,
      description: kept.description,
      type: "feedback" as const,
      scope: "global",
      body: kept.body,
      trigger: null,
      // The name its first import gave it, before wake rules had a prefix of their own.
      replaces: [`wake-${slug(input.name)}`],
      decision: "",
    } satisfies typeof MemoryWritten.payload.Type,
  }
}

/** Writes each live wake rule once; returns how many it wrote. */
export const wakeRules = Effect.gen(function* porting() {
  const sb = yield* Switchboard
  const brain = yield* Brain
  const kernels = yield* sb.query(
    'entities | where id startswith "kernel:" and facts.body == "turn" | project id, seq, name, retired = facts.retired, question = facts.question, goal = facts.goal, wakes = facts.wakes',
  )
  const triggers = yield* sb.query(
    'stream("triggers") | where kind == "trigger" | project id, seq, body',
  )
  const superseded = new Set(triggers.map((t) => str(obj(t.body).supersedes)).filter(Boolean))
  const events = [
    ...kernels
      .filter((k) => k.retired !== true)
      .map((k) => {
        const wakes = obj(k.wakes)
        return rule({
          name: str(k.name) || str(k.id),
          question: str(k.question),
          goal: str(k.goal),
          wakes,
          at: num(wakes.at),
          unless: {},
          record: str(k.id),
          seq: num(k.seq),
        })
      }),
    ...triggers
      .filter((t) => obj(t.body).retired !== true && !superseded.has(str(t.id)))
      .map((t) => {
        const body = obj(t.body)
        return rule({
          name: str(body.name) || str(t.id),
          question: str(body.goal),
          goal: "",
          wakes: obj(body.wakes),
          at: null,
          unless: obj(body.unless),
          record: `trigger ${str(t.id)}`,
          seq: num(t.seq),
        })
      }),
  ]
  yield* Effect.orDie(brain.ingest(events))
  return events.map((e) => e.payload.name)
})
