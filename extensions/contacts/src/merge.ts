// Taking a record in: find who it is by phone, email, handle or ref; certain matches fold in, unsure
// ones go to the decision model (Jev); anyone new is created.
import type { Database } from "bun:sqlite"
import { Log, Models } from "switch-ext-kit"
import type { Draft } from "switch-ext-kit"
import { Effect } from "effect"

import {
  best,
  holders,
  nameOf,
  normOf,
  PersonCreated,
  PersonMerged,
  PersonUpdated,
  ranked,
  readPerson,
} from "./model.ts"
import type { Field, Person } from "./model.ts"
import { books, commit, make, makeAll, missing } from "./store.ts"
import type { Stated } from "./store.ts"

/** One record from a source: an address book card, a CRM contact, a sender. */
export interface SourceRecord {
  readonly source: string
  /** Its id there, kept as a `ref` field so a second import finds it. */
  readonly ref?: { readonly service: string; readonly value: string }
  readonly fields: readonly Stated[]
  /** The user typed these (their own address book). */
  readonly user: boolean
  /** Make a person for it when nobody matches; else only add to someone who does. */
  readonly create: boolean
  /** When it's seen to have happened, for `last_contact`. */
  readonly lastContact?: number
  /** They wrote to the user: kept as the `messaged` label on `last_contact`. */
  readonly messaged?: boolean
}

export interface Outcome {
  readonly person: string | null
  readonly created: boolean
  readonly merged: number
  /** Folded into someone already there (not its own earlier import). */
  readonly matched: boolean
  readonly asked: number
  readonly cost: number
}

const MATCHING = new Set(["phone", "email", "handle"])

const tokens = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFD")
    .replaceAll(/[̀-ͯ]/gu, "")
    .replaceAll(/[^a-z0-9 ]/gu, " ")
    .split(/\s+/u)
    .filter((t) => t.length > 0)

const looksLikeName = (s: string) => /[a-z]/iu.test(s) && !s.includes("@")

const startsName = (x: string, y: string) => x.length >= 3 && y.startsWith(x)

/** Same name, or close enough to call it one: a token in common, or one the start of the other. */
export const namesAgree = (a: string | undefined, b: string | undefined) => {
  if (a === undefined || b === undefined || !looksLikeName(a) || !looksLikeName(b)) {
    return true
  }
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.length === 0 || tb.length === 0) {
    return true
  }
  const [fa = ""] = ta
  const [fb = ""] = tb
  if (fa === fb || startsName(fa, fb) || startsName(fb, fa)) {
    return true
  }
  return ta.some((t) => t.length >= 3 && tb.includes(t))
}

const summary = (fields: readonly Pick<Field, "kind" | "value" | "service" | "source">[]) =>
  fields
    .filter((f) => f.kind !== "ref" && f.kind !== "last_contact")
    .slice(0, 14)
    .map(
      (f) => `${f.kind}${f.service === undefined ? "" : `/${f.service}`}: ${f.value} (${f.source})`,
    )
    .join("; ")

const STABLE =
  "You merge contact records for one person's address book. Two records describe the same human (or the same business) only if the evidence says so. A shared phone can be a family landline, a business line or a recycled number; a shared name can be two people. Nicknames, initials, a business name next to its owner's name, or a name typed differently are still one person."

/** Jev: are these one person? The probability they are, and what it cost. */
const askSame = (a: string, b: string) =>
  Effect.gen(function* asking() {
    const models = yield* Models
    const d = yield* models.decide(
      { stable: STABLE, item: `Record A: ${a}\nRecord B: ${b}` },
      {
        same: {
          instructions: "Are A and B the same person or business?",
          choices: [
            { value: "same", description: "One person or business" },
            { value: "different", description: "Two different people or businesses" },
          ],
        },
      },
    )
    return { p: d.answers.same?.probabilities.same ?? 0, cost: d.cost }
  })

const SURE = 0.8

/**
 * How a record finds who it is. model: a shared key with agreeing names, and the decision model
 * for the rest. keys: a shared key with agreeing names only. exact: a shared key and the same
 * name (or no name on one side): an address book's cards, merged only where there's no doubt.
 */
export type Matching = "model" | "keys" | "exact"

/** Same name, as written once case and decoration are set aside; or no name on one side. */
const sameNamed = (fields: readonly Field[], p: Person) => {
  const ours = new Set(fields.filter((f) => f.kind === "name").map((f) => normOf("name", f.value)))
  const theirs = p.fields.filter((f) => f.kind === "name" && f.suggested !== true)
  if (ours.size === 0 || theirs.length === 0) {
    return true
  }
  return theirs.some((f) => ours.has(normOf("name", f.value)))
}

/** Folds `from` into `into`: one event, with what it brought, for undo. */
export const mergeEvent = (
  into: Person,
  from: Person,
  batch: string,
  reason: string,
  confidence: number,
): Draft =>
  PersonMerged.make({
    into: into.id,
    from: from.id,
    fields: from.fields,
    confidence,
    batch,
    reason,
  })

const candidates = (db: Database, fields: readonly Field[]) => {
  const found = new Set<string>()
  for (const f of fields) {
    if (MATCHING.has(f.kind)) {
      const norm = normOf(f.kind, f.value, f.service)
      if (norm !== "" && !norm.endsWith(":")) {
        for (const id of holders(db, f.kind, norm)) {
          found.add(id)
        }
      }
    }
  }
  return [...found]
}

const sameName = (db: Database, name: string | undefined) => {
  if (name === undefined || tokens(name).length < 2) {
    return []
  }
  return holders(db, "name", normOf("name", name))
}

/** Who a record might be: by its ref, else by its keys, and others by name alone. */
const lookup = (
  db: Database,
  ref: Field | undefined,
  fields: readonly Field[],
  name: string | undefined,
) => {
  const byRef = ref ? holders(db, "ref", normOf("ref", ref.value, ref.service)) : []
  const ids = byRef.length > 0 ? byRef.slice(0, 1) : candidates(db, fields)
  return {
    known: byRef.length > 0,
    matched: ids.flatMap((id) => {
      const p = readPerson(db, id)
      return p ? [p] : []
    }),
    named: (byRef.length > 0 ? [] : sameName(db, name))
      .filter((id) => !ids.includes(id))
      .flatMap((id) => {
        const p = readPerson(db, id)
        return p ? [p] : []
      }),
  }
}

/** The people the record surely is: by key and agreeing name, or as Jev judges. */
const decide = (
  all: readonly Field[],
  name: string | undefined,
  found: ReturnType<typeof lookup>,
  matching: Matching,
) =>
  Effect.gen(function* deciding() {
    let cost = 0
    let asked = 0
    const sure: { person: Person; p: number }[] = []
    const consider = [
      ...found.matched.map((p) => ({ p, byKey: true })),
      ...found.named.map((p) => ({ p, byKey: false })),
    ]
    for (const c of consider) {
      const theirs = best(c.p, "name")
      if (found.known) {
        sure.push({ person: c.p, p: 1 })
      } else if (matching === "exact") {
        if (c.byKey && sameNamed(all, c.p)) {
          sure.push({ person: c.p, p: 1 })
        }
      } else if (c.byKey && namesAgree(name, theirs)) {
        sure.push({ person: c.p, p: 1 })
      } else if (matching === "model") {
        asked += 1
        const answer = yield* askSame(summary(all), summary(c.p.fields)).pipe(
          Effect.orElseSucceed(() => ({ p: 0.5, cost: 0 })),
        )
        cost += answer.cost
        if (answer.p >= SURE) {
          sure.push({ person: c.p, p: answer.p })
        }
      }
    }
    return { sure, cost, asked }
  })

/** The oldest of the people it surely is holds the rest, and gets what the record adds. */
const fold = (
  sure: readonly { person: Person; p: number }[],
  all: readonly Field[],
  batch: string,
  reason: string,
) => {
  const events: Draft[] = []
  const ordered = sure.toSorted((a, b) => a.person.created - b.person.created)
  const [head] = ordered
  if (head === undefined) {
    return { person: null, events }
  }
  for (const o of ordered.slice(1)) {
    events.push(mergeEvent(head.person, o.person, batch, reason, o.p))
  }
  const folded: Person = {
    ...head.person,
    fields: ordered.flatMap((o) => o.person.fields),
  }
  const added = missing(folded, all)
  if (added.length > 0) {
    events.push(PersonUpdated.make({ id: head.person.id, added, removed: [], batch, reason }))
  }
  return { person: head.person, events }
}

/** A newer last contact, or the first sign they wrote to the user. */
const contacted = (
  person: Person,
  record: SourceRecord,
  batch: string,
  reason: string,
  now: number,
): Draft[] => {
  if (record.lastContact === undefined) {
    return []
  }
  const was = person.fields.find((f) => f.kind === "last_contact")
  const last = Number(was?.value ?? 0)
  const messaged = record.messaged === true || was?.label === "messaged"
  if (record.lastContact <= last && (!messaged || was?.label === "messaged")) {
    return []
  }
  const value = String(Math.max(record.lastContact, last))
  return [
    PersonUpdated.make({
      id: person.id,
      added: [
        make(
          { kind: "last_contact", value, ...(messaged ? { label: "messaged" } : {}) },
          record.source,
          false,
          now,
        ),
      ],
      removed: ranked(person, "last_contact"),
      batch,
      reason,
    }),
  ]
}

/**
 * Takes one record in. Sequential: each sees what the last wrote. `change` names its change, so taking
 * the same record again under it is a no-op.
 */
export const take = (
  record: SourceRecord,
  batch: string,
  reason: string,
  matching: Matching,
  change?: string,
) =>
  Effect.gen(function* taking() {
    const log = yield* Log
    const now = Date.now()
    const fields = makeAll(
      record.fields.filter((s) => s.value.trim() !== ""),
      record.source,
      record.user,
      now,
    ).filter((f) => f.value !== "")
    const { ref: source } = record
    const ref = source
      ? make(
          { kind: "ref", value: source.value, service: source.service },
          record.source,
          false,
          now,
        )
      : undefined
    const all = ref ? [...fields, ref] : fields
    const name = fields.find((f) => f.kind === "name")?.value

    const found = yield* log.read((db) => lookup(db, ref, fields, name))
    const { sure, cost, asked } = yield* decide(all, name, found, matching)

    const folded = sure.length > 0 ? fold(sure, all, batch, reason) : { person: null, events: [] }
    const events: Draft[] = [...folded.events]
    let person: Person | null = folded.person
    let created = false
    if (sure.length === 0 && record.create && all.some((f) => f.kind !== "ref")) {
      const id = crypto.randomUUID()
      events.push(PersonCreated.make({ id, fields: missing(null, all), batch, reason }))
      person = { id, created: now, updated: now, fields: [] }
      created = true
    }
    if (person !== null) {
      events.push(...contacted(person, record, batch, reason, now))
    }
    yield* commit(batch, events, false, change)
    return {
      person: person?.id ?? null,
      created,
      merged: Math.max(0, sure.length - 1),
      matched: !found.known && sure.length > 0,
      asked,
      cost,
    } satisfies Outcome
  })

/** Merges people by hand: `from` folds into `into`. */
export const mergeByHand = (into: string, from: readonly string[], batch: string, reason: string) =>
  books.withPermit(
    Effect.gen(function* merging() {
      const log = yield* Log
      const { head, rest } = yield* log.read((db) => ({
        head: readPerson(db, into),
        rest: from.flatMap((id) => {
          const p = readPerson(db, id)
          return p ? [p] : []
        }),
      }))
      if (head === null) {
        return yield* Effect.fail(new Error(`No person ${into}`))
      }
      const others = rest.filter((p) => p.id !== head.id)
      yield* commit(
        batch,
        others.map((p) => mergeEvent(head, p, batch, reason, 1)),
      )
      return { into: head.id, merged: others.map((p) => ({ id: p.id, name: nameOf(p) })) }
    }),
  )
