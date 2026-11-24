// Contacts as an extension: its tools, its events, and a person card for chat.
import type { Database } from "bun:sqlite"
import { BASIC_CATALOG, defineApp, Log, SWITCH_CATALOG, tool } from "switch-ext-kit"
import type { LogService, ModelsService } from "switch-ext-kit"
import { Effect, Schema } from "effect"

import { SCOPE } from "./google.ts"
import { Heartbeat } from "./heartbeat.ts"

import { linkCard, normalizeAll, setFields } from "./edit.ts"
import { mergeByHand } from "./merge.ts"
import {
  best,
  contactEvents,
  everyone,
  KINDS,
  nameOf,
  normOf,
  PersonCreated,
  PersonMerged,
  PersonSplit,
  PersonUpdated,
  Pushed,
  ranked,
  readPerson,
  SINGLE,
  TYPES,
} from "./model.ts"
import type { Field, Person } from "./model.ts"
import { batchId, commit, makeAll, missing } from "./store.ts"
import { backup, linksOf, push } from "./push.ts"
import { importAll } from "./run.ts"
import { FOLLOWS } from "./senders.ts"
import { labelOf, pretty, score } from "./text.ts"
import { undo } from "./undo.ts"

/** The live person and everyone merged into them, for what happened to any of them. */
const family = (db: Database, id: string) => {
  const ids = [id]
  for (let i = 0; i < ids.length && ids.length < 500; i += 1) {
    for (const r of db
      .query<{ id: string }, [string]>("SELECT id FROM people WHERE merged_into = ?")
      .all(ids[i] ?? "")) {
      ids.push(r.id)
    }
  }
  return ids
}

const inList = (ids: readonly string[]) => ids.map(() => "?").join(", ")

/** A person as tools answer it: the best of each kind, and every field with its source. */
const view = (db: Database, p: Person) => {
  const facts: { label: string; value: string }[] = []
  for (const kind of KINDS) {
    if (kind === "name" || kind === "ref" || kind === "group") {
      continue
    }
    const shown = new Set<string>()
    for (const f of ranked(p, kind)) {
      if (f.suggested === true || (kind === "handle" && f.service === "imessage")) {
        continue
      }
      const label = labelOf(f)
      const value = pretty(f)
      if (!shown.has(`${label}:${value}`)) {
        shown.add(`${label}:${value}`)
        facts.push({ label, value })
      }
      if (SINGLE.has(kind)) {
        break
      }
    }
  }
  const ids = family(db, p.id)
  const conflicts = db
    .query<{ target: string; key: string; ours: string; theirs: string }, string[]>(
      `SELECT target, key, ours, theirs FROM conflicts WHERE person IN (${inList(ids)})`,
    )
    .all(...ids)
  return {
    id: p.id,
    name: nameOf(p),
    type: best(p, "type") ?? null,
    labels: [
      ...new Set(
        p.fields.filter((f) => f.kind === "group" && f.suggested !== true).map((f) => f.value),
      ),
    ],
    links: linksOf(p),
    facts,
    fields: p.fields.map((f) => ({
      id: f.id,
      kind: f.kind,
      value: f.value,
      ...(f.label === undefined ? {} : { label: f.label }),
      ...(f.service === undefined ? {} : { service: f.service }),
      source: f.source,
      ...(f.url === undefined ? {} : { url: f.url }),
      confidence: f.confidence,
      user: f.user,
      ...(f.suggested === true ? { suggested: true } : {}),
      at: f.at,
    })),
    conflicts,
  }
}

/** Labels on a person, as written. */
const labelsOf = (p: Person) => [
  ...new Set(
    p.fields.filter((f) => f.kind === "group" && f.suggested !== true).map((f) => f.value),
  ),
]

const search = tool(
  "search",
  {
    description:
      "Find people by any field, fuzzily: name, nickname, phone (any digits), email, company, handle, city, note. `label` and `type` (person, company, system, or none for unset) narrow it; with an empty query they list everyone matching them.",
    readOnly: true,
    input: Schema.Struct({
      query: Schema.String,
      label: Schema.optionalKey(Schema.String),
      type: Schema.optionalKey(Schema.Literals([...TYPES, "none"])),
      limit: Schema.optionalKey(Schema.Finite),
    }),
  },
  (input) =>
    Effect.gen(function* searching() {
      const log = yield* Log
      const all = yield* log.read(everyone)
      const label = input.label?.toLowerCase()
      const fits = (p: Person) =>
        (label === undefined || labelsOf(p).some((l) => l.toLowerCase() === label)) &&
        (input.type === undefined || (best(p, "type") ?? "none") === input.type)
      const blank = input.query.trim() === ""
      const hits = all
        .filter(fits)
        .map((p) => ({ p, s: blank ? 1 : score(p.fields, input.query) }))
        .filter((h) => h.s > 0)
        .toSorted((a, b) => b.s - a.s || nameOf(a.p).localeCompare(nameOf(b.p)))
        .slice(0, Math.min(500, input.limit ?? (blank ? 100 : 10)))
      return {
        people: hits.map((h) => ({
          id: h.p.id,
          name: nameOf(h.p),
          nickname: best(h.p, "nickname") ?? null,
          type: best(h.p, "type") ?? null,
          labels: labelsOf(h.p),
          phone: best(h.p, "phone") ?? null,
          email: best(h.p, "email") ?? null,
          company: best(h.p, "company") ?? null,
        })),
      }
    }),
)

const get = tool(
  "get",
  {
    description:
      "One person, by id, phone, email or exact name: their facts, and every field with its source and confidence. Shows as a card in chat.",
    readOnly: true,
    input: Schema.Struct({ person: Schema.String }),
  },
  (input) =>
    Effect.gen(function* getting() {
      const log = yield* Log
      const p = yield* log.read((db) => {
        const direct = readPerson(db, input.person)
        if (direct) {
          return direct
        }
        for (const kind of ["phone", "email", "name"] as const) {
          const row = db
            .query<{ person: string }, [string, string]>(
              "SELECT f.person FROM fields f JOIN people p ON p.id = f.person WHERE f.kind = ? AND f.norm = ? AND p.merged_into IS NULL AND p.retired = 0 LIMIT 1",
            )
            .get(kind, normOf(kind, input.person))
          if (row) {
            return readPerson(db, row.person)
          }
        }
        return null
      })
      if (p === null) {
        return yield* Effect.fail(new Error(`No one matches ${input.person}`))
      }
      return yield* log.read((db) => view(db, p))
    }),
)

const stated = Schema.Struct({
  kind: Schema.Literals(KINDS),
  value: Schema.String,
  label: Schema.optionalKey(Schema.String),
  service: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
})

const update = tool(
  "update",
  {
    description:
      "Add fields to a person, or remove ones by id (ids from `get`): for what a person has several of, such as phones, emails, handles (`service`: instagram, linkedin, x, tiktok…), links and relations. `set` is for single fields and labels. `user`: the user asked for it, which makes the fields theirs (never overwritten) and lets their own fields go. Without it, a field the user set can't be removed. Pass `create` to make a new person.",
    input: Schema.Struct({
      person: Schema.optionalKey(Schema.String),
      add: Schema.optionalKey(Schema.Array(stated)),
      remove: Schema.optionalKey(Schema.Array(Schema.String)),
      user: Schema.optionalKey(Schema.Boolean),
      create: Schema.optionalKey(Schema.Boolean),
    }),
  },
  (input) =>
    Effect.gen(function* updating() {
      const log = yield* Log
      const byUser = input.user === true
      const batch = batchId("update")
      const source = byUser ? "user" : "agent"
      const added = makeAll(input.add ?? [], source, byUser)
      if (input.create === true) {
        const id = crypto.randomUUID()
        yield* commit(
          batch,
          [PersonCreated.make({ id, fields: missing(null, added), batch, reason: "update" })],
          byUser,
        )
        return { id, batch }
      }
      const p = yield* log.read((db) => readPerson(db, input.person ?? ""))
      if (p === null) {
        return yield* Effect.fail(new Error(`No person ${input.person ?? ""}`))
      }
      const ids = new Set(input.remove)
      const removed = p.fields.filter((f) => ids.has(f.id))
      yield* commit(
        batch,
        [
          PersonUpdated.make({
            id: p.id,
            added: missing(p, added),
            removed,
            batch,
            reason: "update",
          }),
        ],
        byUser,
      )
      return { id: p.id, batch }
    }),
)

const merge = tool(
  "merge",
  {
    description:
      "Fold people into one: `from` into `into`, every field kept. In Apple and Google, at the next push, the person's first-linked card in each book gets everything and their other cards there are deleted (each kept whole in the log). Undo splits them again and brings deleted cards back.",
    input: Schema.Struct({ into: Schema.String, from: Schema.Array(Schema.String) }),
  },
  (input) =>
    Effect.gen(function* merging() {
      const batch = batchId("merge")
      const out = yield* mergeByHand(input.into, input.from, batch, "merge")
      return { ...out, batch }
    }),
)

const undoTool = tool(
  "undo",
  {
    description:
      "Revert a batch: every change in it, including what it wrote to Apple or Google. `log` lists batches.",
    input: Schema.Struct({ batch: Schema.String }),
  },
  (input) => undo(input.batch),
)

const importTool = tool(
  "import",
  {
    description:
      "Take every source in: Apple and Google the first time (`again`: once more, for cards made there since), merged only into someone who surely is the same (a shared phone, email or handle and the same name); and other extensions' contacts. Returns counts per source.",
    input: Schema.Struct({ again: Schema.optionalKey(Schema.Boolean) }),
  },
  (input) => importAll(input.again === true),
)

const logTool = tool(
  "log",
  {
    description: "Recent batches of changes, newest first, for undo.",
    readOnly: true,
    input: Schema.Struct({ limit: Schema.optionalKey(Schema.Finite) }),
  },
  (input) =>
    Effect.gen(function* listing() {
      const log = yield* Log
      const batches = yield* log.read((db) =>
        db
          .query<
            { batch: string; reason: string; at: number; events: number; undone: number },
            [number]
          >("SELECT * FROM batches ORDER BY at DESC LIMIT ?")
          .all(Math.min(200, input.limit ?? 20)),
      )
      return { batches: batches.map((b) => ({ ...b, undone: b.undone === 1 })) }
    }),
)

const peopleTool = tool(
  "people",
  {
    description:
      "Everyone, with their fields' kinds and values (no suggestions or records): a client's own list, searched as it types.",
    readOnly: true,
    appOnly: true,
  },
  () =>
    Effect.gen(function* listing() {
      const log = yield* Log
      const all = yield* log.read(everyone)
      return {
        people: all.map((p) => ({
          id: p.id,
          name: nameOf(p),
          ...(best(p, "type") === undefined ? {} : { type: best(p, "type") }),
          labels: labelsOf(p),
          fields: p.fields
            .filter((f) => f.suggested !== true && f.kind !== "ref" && f.kind !== "last_contact")
            .map((f) => ({
              kind: f.kind,
              value: f.value,
              ...(f.service === undefined ? {} : { service: f.service }),
            })),
        })),
      }
    }),
)

const fact = (f: Field) => ({
  kind: f.kind,
  value: f.value,
  ...(f.service === undefined ? {} : { service: f.service }),
})

interface Change {
  batch: string
  reason: string
  at: number
  undone: boolean
  created: boolean
  added: ReturnType<typeof fact>[]
  removed: ReturnType<typeof fact>[]
  merged: string[]
  split: string[]
  sent: string[]
}

const history = tool(
  "history",
  {
    description:
      "What happened to one person, newest first, a batch at a time: fields added and removed, merges and splits, what went out to Apple or Google. Each batch can be undone.",
    readOnly: true,
    input: Schema.Struct({ person: Schema.String, limit: Schema.optionalKey(Schema.Finite) }),
  },
  (input) =>
    Effect.gen(function* reading() {
      const log = yield* Log
      return yield* log.read((db) => {
        const live = readPerson(db, input.person)
        if (live === null) {
          return { changes: [] }
        }
        const ids = family(db, live.id)
        const list = inList(ids)
        const rows = db
          .query<
            {
              type: string
              payload: string
              time: number
              batch: string
              reason: string
              undone: number
            },
            string[]
          >(
            `SELECT e.type, e.payload, e.time, b.batch, b.reason, b.undone FROM events e
             JOIN batches b ON b.batch = json_extract(e.payload, '$.batch')
             WHERE json_extract(e.payload, '$.id') IN (${list})
               OR json_extract(e.payload, '$.into') IN (${list})
               OR json_extract(e.payload, '$.from') IN (${list})
             ORDER BY e.seq DESC LIMIT 2000`,
          )
          .all(...ids, ...ids, ...ids)
        const byBatch = new Map<string, Change>()
        for (const r of rows) {
          const raw: unknown = JSON.parse(r.payload)
          const { batch } = r
          let c = byBatch.get(batch)
          if (c === undefined) {
            c = {
              batch,
              reason: r.reason,
              at: r.time,
              undone: r.undone === 1,
              created: false,
              added: [],
              removed: [],
              merged: [],
              split: [],
              sent: [],
            }
            byBatch.set(batch, c)
          }
          if (r.type === PersonCreated.type) {
            c.created = true
            c.added.push(...PersonCreated.decode(raw).fields.map(fact))
          } else if (r.type === PersonUpdated.type) {
            const e = PersonUpdated.decode(raw)
            c.added.push(...e.added.map(fact))
            c.removed.push(...e.removed.map(fact))
          } else if (r.type === PersonMerged.type) {
            const e = PersonMerged.decode(raw)
            c.merged.push(e.fields.find((f) => f.kind === "name")?.value ?? e.from)
          } else if (r.type === PersonSplit.type) {
            const e = PersonSplit.decode(raw)
            c.split.push(e.fields.find((f) => f.kind === "name")?.value ?? e.from)
          } else if (r.type === Pushed.type) {
            const e = Pushed.decode(raw)
            if (!c.sent.includes(e.target)) {
              c.sent.push(e.target)
            }
          }
        }
        return { changes: [...byBatch.values()].slice(0, Math.min(200, input.limit ?? 50)) }
      })
    }),
)

const nullable = Schema.optionalKey(Schema.NullOr(Schema.String))

const setTool = tool(
  "set",
  {
    description:
      "Set or clear a person's single fields, replacing whatever they hold, as the user's own (never overwritten by an import; sent to Apple and Google). name (a name set alone also sets given and family from it), given, family, initial (one letter: the family name's initial when that's all that's known; clears family), nickname (what the user calls them), type (person, company or system; leave unset when none fits), relationship (who they are to the user, such as grandmother: Apple's related names), note, company, role, location, birthday (YYYY-MM-DD, or --MM-DD without a year). null clears one. `labels` adds or removes labels (Apple groups, Google labels).",
    input: Schema.Struct({
      person: Schema.String,
      name: nullable,
      given: nullable,
      family: nullable,
      initial: nullable,
      nickname: nullable,
      type: Schema.optionalKey(Schema.NullOr(Schema.Literals(TYPES))),
      relationship: nullable,
      note: nullable,
      company: nullable,
      role: nullable,
      location: nullable,
      birthday: nullable,
      labels: Schema.optionalKey(
        Schema.Struct({
          add: Schema.optionalKey(Schema.Array(Schema.String)),
          remove: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      ),
    }),
  },
  (input) => {
    const { person, labels, ...settings } = input
    return setFields(person, settings, labels ?? {})
  },
)

const linkTool = tool(
  "link",
  {
    description:
      "Link a person to a card in Apple (its id, `…:ABPerson`) or Google (`people/c…`), so pushes go to that card; `unlink` takes a link off. A card linked to someone else can't be linked again: merge the two people instead. A person linked to several cards in one book keeps the first and the push deletes the rest after giving the first everything.",
    input: Schema.Struct({
      person: Schema.String,
      target: Schema.Literals(["apple", "google"]),
      record: Schema.String,
      unlink: Schema.optionalKey(Schema.Boolean),
    }),
  },
  (input) => linkCard(input.person, input.target, input.record, input.unlink === true),
)

const normalizeTool = tool(
  "normalize",
  {
    description:
      "Make every field normal once (phones in E.164, names without emoji and properly cased, full names split into given and family): one batch, undone whole. New writes are made normal on their own.",
  },
  () => normalizeAll,
)

const backupTool = tool(
  "backup",
  {
    description:
      "Back both address books up whole now: Apple as vCards and JSON (notes and groups included), Google as JSON, in a new folder under contacts-backup.",
  },
  () => backup,
)

const pushTool = tool(
  "push",
  {
    description:
      "Send what changed to Apple and Google now, instead of at the next two-minute pass. A book gets nothing until it's been imported; anything already there changes only after a backup from the last hour. `dry`: what it would send.",
    input: Schema.Struct({
      target: Schema.optionalKey(Schema.Literals(["apple", "google"])),
      dry: Schema.optionalKey(Schema.Boolean),
    }),
  },
  (input) =>
    Effect.all(
      (input.target === undefined ? (["apple", "google"] as const) : [input.target]).map((t) =>
        push(t, batchId(`push-${t}`), undefined, input.dry === true),
      ),
    ).pipe(Effect.map((reports) => ({ reports }))),
)

const component = (id: string, rest: Record<string, unknown>) => ({ id, ...rest })

export const contactsApp = defineApp<LogService | ModelsService>({
  name: "contacts",
  version: "1",
  connections: [{ provider: "google", scopes: [SCOPE], multiple: false }],
  reaches: { follows: [...FOLLOWS] },
  instructions:
    "The user's people and companies, merged from Apple, Google, other sources and everyone who messages them; Switch is the source of truth and pushes changes out to Apple and Google every two minutes. Every field keeps its source and confidence; every change is a batch `undo` reverts, including what it sent. `set` edits single fields and labels; `update` adds or removes list fields (phones, emails, handles, links); `merge` folds duplicates; `link` ties a person to a card.",
  tools: [
    search,
    get,
    setTool,
    update,
    merge,
    linkTool,
    normalizeTool,
    backupTool,
    pushTool,
    undoTool,
    importTool,
    logTool,
    peopleTool,
    history,
  ],
  events: [...contactEvents, Heartbeat],
  widgets: [
    {
      name: "person",
      title: "Person",
      surfaces: ["chat"],
      resource: "ui://contacts/person",
      tool: "get",
      refresh: [PersonUpdated.type],
      a2ui: () => [
        { version: "1.0", createSurface: { surfaceId: "person", catalogId: SWITCH_CATALOG } },
        {
          version: "1.0",
          updateComponents: {
            surfaceId: "person",
            components: [
              component("root", {
                component: "Column",
                catalogId: BASIC_CATALOG,
                children: ["name", "facts"],
              }),
              component("name", { component: "Title", label: { "@path": "/name" } }),
              component("facts", {
                component: "List",
                catalogId: BASIC_CATALOG,
                children: { componentId: "fact", path: "/facts" },
              }),
              component("fact", {
                component: "Field",
                label: { "@path": "label" },
                value: { "@path": "value" },
              }),
            ],
          },
        },
      ],
    },
  ],
})
