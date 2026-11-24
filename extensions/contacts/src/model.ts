// One model of people and companies: a person is a set of fields, each with where it came from
// and how sure that is. Kept as events in the extension's own log, with this projection over them.
import type { Database } from "bun:sqlite"
import { defineCommand, defineEvent, on } from "switch-ext-kit"
import type { Draft, Projection } from "switch-ext-kit"
import { Schema } from "effect"

import { cleanName, composeName } from "./names.ts"
import { phoneKey } from "./text.ts"

export const KINDS = [
  /** A full name, as a source states it. */
  "name",
  /** Given (first) name. */
  "given",
  /** Family (last) name. */
  "family",
  /** The family name's initial, when that's all that's known: one letter. */
  "initial",
  /** What the user calls them, apart from their name. */
  "nickname",
  /** person, company or system (an automated sender); unset when it doesn't fit. */
  "type",
  /** A label they're under, such as a circle or a business they're from: an address book group. */
  "group",
  /** Who they are to the user, in the user's words ("grandmother"). */
  "relationship",
  "phone",
  "email",
  /** A messaging or social account: `service` says which (imessage, instagram, telegram, linkedin…). */
  "handle",
  "company",
  "role",
  "location",
  "note",
  /** Someone they're related to: `label` says how ("sister"). */
  "relation",
  /** A Switch space they show up in. */
  "space",
  "url",
  "birthday",
  /** Their record in an address book or CRM: `service` is apple, google or the source extension; `value` its id. */
  "ref",
  /** The last time they and the user traded a message, as epoch ms. */
  "last_contact",
] as const
export type Kind = (typeof KINDS)[number]

/** Kinds a person has one of: the best ranked shows. */
export const SINGLE: ReadonlySet<Kind> = new Set([
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
  "last_contact",
])

export const TYPES = ["person", "company", "system"] as const
export type PersonType = (typeof TYPES)[number]

/** Kinds that are a name, matched without case or decoration. */
export const NAMEISH: ReadonlySet<Kind> = new Set([
  "name",
  "given",
  "family",
  "nickname",
  "initial",
])

export const field = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(KINDS),
  value: Schema.String,
  label: Schema.optionalKey(Schema.String),
  service: Schema.optionalKey(Schema.String),
  /** apple, google, a source extension, imessage, gmail, instagram, texts, email, fastpeoplesearch, web, user, agent; derived: worked out from their name. */
  source: Schema.String,
  /** Where it was found, when that's a page. */
  url: Schema.optionalKey(Schema.String),
  /** 0 to 1. */
  confidence: Schema.Finite,
  /** The user set it (in their own address book, or through Switch): only they remove or replace it. */
  user: Schema.Boolean,
  /** Too unsure to act on: shown, never written out. */
  suggested: Schema.optionalKey(Schema.Boolean),
  at: Schema.Finite,
})
export type Field = typeof field.Type

const why = { batch: Schema.String, reason: Schema.String }

export const PersonCreated = defineEvent(
  "contacts.person_created",
  1,
  Schema.Struct({ id: Schema.String, fields: Schema.Array(field), ...why }),
)
export const PersonUpdated = defineEvent(
  "contacts.person_updated",
  1,
  Schema.Struct({
    id: Schema.String,
    added: Schema.Array(field),
    removed: Schema.Array(field),
    ...why,
  }),
)
/** `from` folded into `into`; `fields` are what it had then, so an undo can split them again. */
export const PersonMerged = defineEvent(
  "contacts.person_merged",
  1,
  Schema.Struct({
    into: Schema.String,
    from: Schema.String,
    fields: Schema.Array(field),
    confidence: Schema.Finite,
    ...why,
  }),
)
export const PersonSplit = defineEvent(
  "contacts.person_split",
  1,
  Schema.Struct({ into: Schema.String, from: Schema.String, fields: Schema.Array(field), ...why }),
)
/** Only an undo retires a person: the undo of its creation. */
export const PersonRetired = defineEvent(
  "contacts.person_retired",
  1,
  Schema.Struct({ id: Schema.String, retired: Schema.Boolean, ...why }),
)

// Lookups once ran here; their events stay so the log written then still reads.

const finding = Schema.Struct({
  kind: Schema.Literals(KINDS),
  value: Schema.String,
  service: Schema.optionalKey(Schema.String),
  source: Schema.String,
  url: Schema.optionalKey(Schema.String),
  confidence: Schema.Finite,
  /** Written to the person; else a suggestion. */
  written: Schema.Boolean,
})
export const Enriched = defineEvent(
  "contacts.enriched",
  1,
  Schema.Struct({
    id: Schema.String,
    findings: Schema.Array(finding),
    /** What it looked at: phone, name, web. */
    looked: Schema.Array(Schema.String),
    cost: Schema.Finite,
    ms: Schema.Finite,
    ...why,
  }),
)

export const SenderIdentified = defineEvent(
  "contacts.sender_identified",
  1,
  Schema.Struct({
    id: Schema.String,
    handle: Schema.String,
    name: Schema.String,
    source: Schema.String,
    url: Schema.String,
    confidence: Schema.Finite,
    ...why,
  }),
)

/** A sender with no name in any address book, first seen. */
export const SenderUnknown = defineEvent(
  "contacts.sender_unknown",
  1,
  Schema.Struct({ id: Schema.String, handle: Schema.String, channel: Schema.String, ...why }),
)

const TARGETS = ["apple", "google"] as const
export type Target = (typeof TARGETS)[number]

/** One value written: `was` what it replaced; `value` "" when it was taken out. */
const write = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
  was: Schema.optionalKey(Schema.String),
})

/** What went out to an address book: values added to a record, or a record made. */
export const Pushed = defineEvent(
  "contacts.pushed",
  1,
  Schema.Struct({
    id: Schema.String,
    target: Schema.Literals(TARGETS),
    remote: Schema.String,
    created: Schema.Boolean,
    written: Schema.Array(write),
    /** Taken back out, by an undo. */
    reverted: Schema.Boolean,
    /** The record was deleted, folded into another of the same person: `copy` is what it held. */
    deleted: Schema.optionalKey(Schema.Boolean),
    copy: Schema.optionalKey(Schema.String),
    ...why,
  }),
)

/** The address book has something else where Switch wrote, or would write: left as it is. */
export const Conflicted = defineEvent(
  "contacts.conflicted",
  1,
  Schema.Struct({
    id: Schema.String,
    target: Schema.Literals(TARGETS),
    remote: Schema.String,
    key: Schema.String,
    ours: Schema.String,
    theirs: Schema.String,
  }),
)

export const Imported = defineEvent(
  "contacts.imported",
  1,
  Schema.Struct({
    source: Schema.String,
    records: Schema.Finite,
    created: Schema.Finite,
    merged: Schema.Finite,
    batch: Schema.String,
  }),
)

export const Undone = defineEvent(
  "contacts.undone",
  1,
  Schema.Struct({ batch: Schema.String, by: Schema.String, events: Schema.Finite }),
)

export const contactEvents = [
  PersonCreated,
  PersonUpdated,
  PersonMerged,
  PersonSplit,
  PersonRetired,
  SenderUnknown,
  Pushed,
  Conflicted,
  Imported,
  Undone,
]

/** Everything the log holds, including what's no longer written. */
export const logEvents = [...contactEvents, Enriched, SenderIdentified]

// Normal forms, for matching.

export const normOf = (kind: Kind, value: string, service?: string) => {
  const v = value.trim()
  if (kind === "phone") {
    return phoneKey(v)
  }
  if (kind === "email") {
    return v.toLowerCase()
  }
  if (NAMEISH.has(kind)) {
    return cleanName(v).toLowerCase()
  }
  if (kind === "handle" || kind === "ref") {
    const bare = kind === "handle" ? v.replace(/^@/u, "") : v
    return `${service ?? ""}:${service === "imessage" ? phoneKey(bare) || bare.toLowerCase() : bare.toLowerCase()}`
  }
  return v.toLowerCase().replaceAll(/\s+/gu, " ")
}

export const keyOf = (f: Pick<Field, "kind" | "value" | "service">) =>
  `${f.kind}:${normOf(f.kind, f.value, f.service)}`

// The projection.

interface FieldRow {
  readonly id: string
  readonly person: string
  readonly kind: string
  readonly value: string
  readonly norm: string
  readonly label: string | null
  readonly service: string | null
  readonly source: string
  readonly url: string | null
  readonly confidence: number
  readonly user: number
  readonly suggested: number
  readonly at: number
}

const isKind = (k: string): k is Kind => (KINDS as readonly string[]).includes(k)

export const fieldOf = (r: FieldRow): Field => ({
  id: r.id,
  kind: isKind(r.kind) ? r.kind : "note",
  value: r.value,
  ...(r.label === null ? {} : { label: r.label }),
  ...(r.service === null ? {} : { service: r.service }),
  source: r.source,
  ...(r.url === null ? {} : { url: r.url }),
  confidence: r.confidence,
  user: r.user === 1,
  ...(r.suggested === 1 ? { suggested: true } : {}),
  at: r.at,
})

const putField = (db: Database, person: string, f: Field) => {
  db.query(
    `INSERT INTO fields (id, person, kind, value, norm, label, service, source, url, confidence, user, suggested, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET person = excluded.person`,
  ).run(
    f.id,
    person,
    f.kind,
    f.value,
    normOf(f.kind, f.value, f.service),
    f.label ?? null,
    f.service ?? null,
    f.source,
    f.url ?? null,
    f.confidence,
    f.user ? 1 : 0,
    f.suggested === true ? 1 : 0,
    f.at,
  )
}

const touch = (db: Database, id: string, at: number) => {
  db.query("UPDATE people SET updated = ? WHERE id = ?").run(at, id)
}

const noteBatch = (db: Database, batch: string, reason: string, at: number) => {
  db.query(
    `INSERT INTO batches (batch, reason, at, events) VALUES (?, ?, ?, 1)
     ON CONFLICT (batch) DO UPDATE SET events = events + 1`,
  ).run(batch, reason, at)
}

export const people: Projection = {
  name: "contacts",
  // 2: what went out is kept per record (`remote`), so merging two people pushed to the same
  // book no longer collides. 3: names match without case or decoration. 4: what's written for
  // someone merged away lands on who they were merged into.
  version: 4,
  tables: ["people", "fields", "pushed", "conflicts", "batches"],
  create: `
    CREATE TABLE people (id TEXT PRIMARY KEY, created INTEGER NOT NULL, updated INTEGER NOT NULL,
      merged_into TEXT, retired INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE fields (id TEXT PRIMARY KEY, person TEXT NOT NULL, kind TEXT NOT NULL,
      value TEXT NOT NULL, norm TEXT NOT NULL, label TEXT, service TEXT, source TEXT NOT NULL,
      url TEXT, confidence REAL NOT NULL, user INTEGER NOT NULL, suggested INTEGER NOT NULL,
      at INTEGER NOT NULL);
    CREATE INDEX fields_person ON fields (person);
    CREATE INDEX fields_norm ON fields (kind, norm);
    CREATE TABLE pushed (person TEXT NOT NULL, target TEXT NOT NULL, remote TEXT NOT NULL,
      key TEXT NOT NULL, value TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (person, target, remote, key));
    CREATE TABLE conflicts (person TEXT NOT NULL, target TEXT NOT NULL, key TEXT NOT NULL,
      ours TEXT NOT NULL, theirs TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (person, target, key));
    CREATE TABLE batches (batch TEXT PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL,
      events INTEGER NOT NULL, undone INTEGER NOT NULL DEFAULT 0);`,
  on: [
    on(PersonCreated, (db, p, e) => {
      db.query(
        "INSERT INTO people (id, created, updated) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING",
      ).run(p.id, e.time, e.time)
      for (const f of p.fields) {
        putField(db, p.id, f)
      }
      noteBatch(db, p.batch, p.reason, e.time)
    }),
    on(PersonUpdated, (db, p, e) => {
      // Written for someone since merged away: it lands on who they were merged into.
      const id = resolve(db, p.id) ?? p.id
      for (const f of p.removed) {
        db.query("DELETE FROM fields WHERE id = ?").run(f.id)
      }
      for (const f of p.added) {
        putField(db, id, f)
      }
      touch(db, id, e.time)
      noteBatch(db, p.batch, p.reason, e.time)
    }),
    on(PersonMerged, (db, p, e) => {
      db.query("UPDATE fields SET person = ? WHERE person = ?").run(p.into, p.from)
      db.query("UPDATE people SET merged_into = ? WHERE id = ?").run(p.into, p.from)
      db.query("UPDATE pushed SET person = ? WHERE person = ?").run(p.into, p.from)
      touch(db, p.into, e.time)
      noteBatch(db, p.batch, p.reason, e.time)
    }),
    on(PersonSplit, (db, p, e) => {
      for (const f of p.fields) {
        db.query("UPDATE fields SET person = ? WHERE id = ?").run(p.from, f.id)
      }
      db.query("UPDATE people SET merged_into = NULL WHERE id = ?").run(p.from)
      // What went out to its own records goes back with it.
      db.query(
        "UPDATE pushed SET person = ? WHERE person = ? AND remote IN (SELECT value FROM fields WHERE person = ? AND kind = 'ref')",
      ).run(p.from, p.into, p.from)
      touch(db, p.into, e.time)
      noteBatch(db, p.batch, p.reason, e.time)
    }),
    on(PersonRetired, (db, p, e) => {
      db.query("UPDATE people SET retired = ? WHERE id = ?").run(p.retired ? 1 : 0, p.id)
      noteBatch(db, p.batch, p.reason, e.time)
    }),
    on(Pushed, (db, raw, e) => {
      const p = { ...raw, id: resolve(db, raw.id) ?? raw.id }
      for (const w of p.written) {
        if (p.reverted) {
          db.query(
            "DELETE FROM pushed WHERE person = ? AND target = ? AND remote = ? AND key = ?",
          ).run(p.id, p.target, p.remote, w.key)
        } else {
          db.query(
            `INSERT INTO pushed (person, target, remote, key, value, at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (person, target, remote, key) DO UPDATE SET value = excluded.value, at = excluded.at`,
          ).run(p.id, p.target, p.remote, w.key, w.value, e.time)
        }
      }
      noteBatch(db, p.batch, p.reason, e.time)
    }),
    on(Conflicted, (db, raw, e) => {
      const p = { ...raw, id: resolve(db, raw.id) ?? raw.id }
      db.query(
        `INSERT INTO conflicts (person, target, key, ours, theirs, at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (person, target, key) DO UPDATE SET ours = excluded.ours, theirs = excluded.theirs, at = excluded.at`,
      ).run(p.id, p.target, p.key, p.ours, p.theirs, e.time)
    }),
    on(Enriched, (db, p, e) => {
      noteBatch(db, p.batch, p.reason, e.time)
    }),
    on(SenderIdentified, (db, p, e) => {
      noteBatch(db, p.batch, p.reason, e.time)
    }),
    on(Undone, (db, p) => {
      db.query("UPDATE batches SET undone = 1 WHERE batch = ?").run(p.batch)
    }),
  ],
  snapshot: (db) =>
    db
      .query<{ n: number }, []>(
        "SELECT count(*) AS n FROM people WHERE merged_into IS NULL AND retired = 0",
      )
      .get()?.n ?? 0,
}

// Reading it.

export interface Person {
  readonly id: string
  readonly created: number
  readonly updated: number
  readonly fields: readonly Field[]
}

const rank = (f: Field) =>
  (f.suggested === true ? -10 : 0) + (f.user ? 2 : 0) + f.confidence + f.at / 1e15

/** The fields of one kind, best first; suggestions last. */
export const ranked = (p: Person, kind: Kind) =>
  p.fields.filter((f) => f.kind === kind).toSorted((a, b) => rank(b) - rank(a))

export const best = (p: Person, kind: Kind) => {
  const top = ranked(p, kind).find((f) => f.suggested !== true)
  return top?.value
}

/** Their name as stated, unlabeled first (an alias or old nickname only when there's nothing else). */
const statedName = (p: Person) =>
  ranked(p, "name").find((f) => f.suggested !== true && f.label === undefined)?.value ??
  best(p, "name")

/** Their name from its parts, once someone set any part (not only worked out from a name). */
const sure = (f: Field) => f.suggested !== true

const setParts = (p: Person) => {
  const set = p.fields.some(
    (f) =>
      (f.kind === "given" || f.kind === "family" || f.kind === "initial") &&
      f.source !== "derived" &&
      sure(f),
  )
  if (!set) {
    return null
  }
  const top = (kind: Kind) => ranked(p, kind).find(sure)?.value
  const parts = { given: top("given"), family: top("family"), initial: top("initial") }
  return parts.given === undefined && parts.family === undefined && parts.initial === undefined
    ? null
    : parts
}

export const nameOf = (p: Person) => {
  const parts = setParts(p)
  return (
    (parts === null ? undefined : composeName(parts)) ??
    statedName(p) ??
    best(p, "nickname") ??
    best(p, "company") ??
    best(p, "phone") ??
    best(p, "email") ??
    ""
  )
}

/** The live person `id` points to, following merges. */
export const resolve = (db: Database, id: string): string | null => {
  let at: string | null = id
  for (let hops = 0; hops < 20 && at !== null; hops += 1) {
    const row: { merged_into: string | null; retired: number } | null = db
      .query<{ merged_into: string | null; retired: number }, [string]>(
        "SELECT merged_into, retired FROM people WHERE id = ?",
      )
      .get(at)
    if (row === null || row.retired === 1) {
      return null
    }
    if (row.merged_into === null) {
      return at
    }
    at = row.merged_into
  }
  return null
}

export const readPerson = (db: Database, id: string): Person | null => {
  const live = resolve(db, id)
  if (live === null) {
    return null
  }
  const row = db
    .query<{ id: string; created: number; updated: number }, [string]>(
      "SELECT id, created, updated FROM people WHERE id = ?",
    )
    .get(live)
  if (row === null) {
    return null
  }
  const fields = db
    .query<FieldRow, [string]>("SELECT * FROM fields WHERE person = ? ORDER BY at")
    .all(live)
    .map(fieldOf)
  return { ...row, fields }
}

/** Every live person, with fields. */
export const everyone = (db: Database): Person[] => {
  const rows = db
    .query<{ id: string; created: number; updated: number }, []>(
      "SELECT id, created, updated FROM people WHERE merged_into IS NULL AND retired = 0",
    )
    .all()
  const byPerson = new Map<string, Field[]>()
  for (const r of db
    .query<FieldRow, []>(
      "SELECT f.* FROM fields f JOIN people p ON p.id = f.person WHERE p.merged_into IS NULL AND p.retired = 0 ORDER BY f.at",
    )
    .all()) {
    const list = byPerson.get(r.person) ?? []
    list.push(fieldOf(r))
    byPerson.set(r.person, list)
  }
  return rows.map((r) => ({ ...r, fields: byPerson.get(r.id) ?? [] }))
}

/** Live people holding a field with this key. */
export const holders = (db: Database, kind: Kind, norm: string): string[] =>
  db
    .query<{ person: string }, [string, string]>(
      "SELECT DISTINCT f.person FROM fields f JOIN people p ON p.id = f.person WHERE f.kind = ? AND f.norm = ? AND p.merged_into IS NULL AND p.retired = 0",
    )
    .all(kind, norm)
    .map((r) => r.person)

// The one command: a change worked out elsewhere (imports, merges, edits, undo), checked here
// against what the log holds before it's written.

const change = Schema.Struct({
  batch: Schema.String,
  /** The user, through a tool they drive: only then may their own fields go. */
  byUser: Schema.Boolean,
  events: Schema.Array(Schema.Struct({ type: Schema.String, payload: Schema.Unknown })),
})

const decodeUpdated = Schema.decodeUnknownSync(PersonUpdated.payload)

export const Change = defineCommand({
  type: "contacts.change",
  payload: change,
  load: (db, p) => {
    const userFields = new Set<string>()
    for (const e of p.events) {
      if (e.type === PersonUpdated.type) {
        for (const f of decodeUpdated(e.payload).removed) {
          const row = db
            .query<{ user: number }, [string]>("SELECT user FROM fields WHERE id = ?")
            .get(f.id)
          if (row?.user === 1) {
            userFields.add(f.id)
          }
        }
      }
    }
    return { userFields }
  },
  decide: (state, p) => {
    if (!p.byUser && state.userFields.size > 0) {
      return { reject: "That removes a field the user set" }
    }
    const events: Draft[] = p.events.map((e) => ({ type: e.type, payload: e.payload }))
    return { events }
  },
})
