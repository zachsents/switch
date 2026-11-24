// Editing by hand and by the agent: single fields set or cleared whole, labels on and off, a person
// linked to a card in a book, and every field made normal once (the migration).
import { Log } from "switch-ext-kit"
import type { Draft } from "switch-ext-kit"
import { Effect } from "effect"

import { splitName } from "./names.ts"
import { everyone, holders, normOf, PersonUpdated, ranked, readPerson } from "./model.ts"
import type { Field, Kind, Person, PersonType, Target } from "./model.ts"
import { normalField, partsChange, tagsOf } from "./normal.ts"
import { batchId, books, commit, make } from "./store.ts"

/** Single fields `set` takes; null clears one. */
export const SETTABLE = [
  "name",
  "given",
  "family",
  "initial",
  "nickname",
  "type",
  "relationship",
  "note",
  "company",
  "role",
  "location",
  "birthday",
] as const
export type Settable = (typeof SETTABLE)[number]

export type Settings = Partial<Record<Exclude<Settable, "type">, string | null>> & {
  readonly type?: PersonType | null
}

/** Family and initial are one or the other. */
const ALSO_CLEARS: Partial<Record<Settable, readonly Kind[]>> = {
  family: ["initial"],
  initial: ["family"],
}

const PARTS = ["given", "family", "initial"] as const

/** A name set alone brings its given and family with it, unless they're set too. */
const withParts = (s: Settings): Settings => {
  const { name } = s
  if (name === undefined || name === null || PARTS.some((k) => s[k] !== undefined)) {
    return s
  }
  const split = s.type === "company" || s.type === "system" ? null : splitName(name)
  return {
    ...s,
    given: split?.given ?? null,
    family: split?.family ?? null,
    initial: split?.initial ?? null,
  }
}

/**
 * Family (or initial) cleared and nothing set in its place: the name becomes what's left, so the
 * old surname isn't worked out of it again ("Mark Landlord" with family cleared is Mark).
 */
const withoutLast = (s: Settings, p: Person): Settings => {
  const cleared =
    (s.family === null || s.initial === null) &&
    !(typeof s.family === "string" && s.family.trim() !== "") &&
    !(typeof s.initial === "string" && s.initial.trim() !== "")
  const given = s.given ?? ranked(p, "given").find((f) => f.suggested !== true)?.value
  if (!cleared || s.name !== undefined || given === undefined || given === null || given === "") {
    return s
  }
  return { ...s, name: given, family: null, initial: null }
}

/** Sets or clears single fields and labels, as the user's own. */
export const setFields = (
  person: string,
  settings: Settings,
  labels: { readonly add?: readonly string[]; readonly remove?: readonly string[] },
) =>
  Effect.gen(function* setting() {
    const log = yield* Log
    const p = yield* log.read((db) => readPerson(db, person))
    if (p === null) {
      return yield* Effect.fail(new Error(`No person ${person}`))
    }
    const all = withoutLast(withParts(settings), p)
    const kinds = new Set<Kind>()
    const added: Field[] = []
    for (const key of SETTABLE) {
      const v = all[key]
      if (v !== undefined) {
        kinds.add(key)
        for (const k of ALSO_CLEARS[key] ?? []) {
          kinds.add(k)
        }
        if (v !== null && v.trim() !== "") {
          added.push(make({ kind: key, value: v }, "user", true))
        }
      }
    }
    const drop = new Set((labels.remove ?? []).map((l) => l.trim().toLowerCase()))
    const removed = p.fields.filter(
      (f) => kinds.has(f.kind) || (f.kind === "group" && drop.has(f.value.toLowerCase())),
    )
    const have = new Set(
      p.fields.filter((f) => f.kind === "group").map((f) => f.value.toLowerCase()),
    )
    for (const l of labels.add ?? []) {
      if (l.trim() !== "" && !have.has(l.trim().toLowerCase())) {
        have.add(l.trim().toLowerCase())
        added.push(make({ kind: "group", value: l }, "user", true))
      }
    }
    const batch = batchId("set")
    yield* commit(
      batch,
      [PersonUpdated.make({ id: p.id, added, removed, batch, reason: "set" })],
      true,
    )
    return { id: p.id, batch }
  })

/** Links a person to a card in a book, or takes the link off. */
export const linkCard = (person: string, target: Target, record: string, unlink: boolean) =>
  books.withPermit(
    Effect.gen(function* linking() {
      const log = yield* Log
      const { p, others } = yield* log.read((db) => ({
        p: readPerson(db, person),
        others: holders(db, "ref", normOf("ref", record, target)),
      }))
      if (p === null) {
        return yield* Effect.fail(new Error(`No person ${person}`))
      }
      const batch = batchId(unlink ? "unlink" : "link")
      if (unlink) {
        const removed = p.fields.filter(
          (f) => f.kind === "ref" && f.service === target && f.value === record,
        )
        yield* commit(
          batch,
          [PersonUpdated.make({ id: p.id, added: [], removed, batch, reason: "unlink" })],
          true,
        )
        return { id: p.id, batch }
      }
      const elsewhere = others.filter((id) => id !== p.id)
      if (elsewhere.length > 0) {
        return yield* Effect.fail(
          new Error(`${record} is already linked to ${elsewhere.join(", ")}: merge them instead`),
        )
      }
      const ref = make({ kind: "ref", value: record, service: target }, "user", false)
      yield* commit(batch, [
        PersonUpdated.make({ id: p.id, added: [ref], removed: [], batch, reason: "link" }),
      ])
      return { id: p.id, batch }
    }),
  )

/** Every field made normal and every name split, once: one batch, so one undo takes it back. */
export const normalizeAll = Effect.gen(function* normalizing() {
  const log = yield* Log
  const all = yield* log.read(everyone)
  const batch = batchId("normalize")
  const events: Draft[] = []
  let fields = 0
  for (const p of all) {
    const removed: Field[] = []
    const added: Field[] = []
    for (const f of p.fields) {
      const n = normalField(f)
      if (n !== f) {
        removed.push(f)
        added.push({ ...n, id: crypto.randomUUID() })
      }
    }
    added.push(...tagsOf(p.fields, p.fields))
    const gone = new Set(removed.map((f) => f.id))
    const after = [...p.fields.filter((f) => !gone.has(f.id)), ...added]
    const parts = partsChange(after, p.id)
    fields += removed.length
    if (added.length + parts.added.length + parts.removed.length > 0) {
      events.push(
        PersonUpdated.make({
          id: p.id,
          added: [...added, ...parts.added],
          removed: [...removed, ...parts.removed],
          batch,
          reason: "normalize",
        }),
      )
    }
  }
  yield* commit(batch, events, true)
  return { batch, people: events.length, fields }
})
