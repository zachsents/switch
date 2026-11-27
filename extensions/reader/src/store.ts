// What the reader keeps: each document's words in a file of its own (`docs/<id>.json`, written
// whole), and in its log the documents opened, their highlights and their threads, each a passage
// with the questions asked about it and their answers. The same events go to the brain.
import type { Database } from "bun:sqlite"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { Effect, Schema } from "effect"
import { defineCommand, defineEvent, Log, on, writeFileAtomic } from "switch-ext-kit"
import type { Projection } from "switch-ext-kit"

import { FORMATS } from "./formats.ts"

const DIR = process.cwd()

/** A passage, as W3C's Web Annotation quotes one: its words, with a little of what's around them. */
export const Quote = Schema.Struct({
  section: Schema.Finite,
  exact: Schema.String,
  prefix: Schema.optionalKey(Schema.String),
  suffix: Schema.optionalKey(Schema.String),
})
export type Passage = typeof Quote.Type

export const Opened = defineEvent(
  "reader.opened",
  1,
  Schema.Struct({
    doc: Schema.String,
    title: Schema.String,
    format: Schema.String,
    source: Schema.String,
    words: Schema.Finite,
    sections: Schema.Finite,
  }),
)

export const Linked = defineEvent(
  "reader.linked",
  1,
  Schema.Struct({ doc: Schema.String, version: Schema.Finite, links: Schema.Finite }),
)

export const Highlighted = defineEvent(
  "reader.highlighted",
  1,
  Schema.Struct({ doc: Schema.String, highlight: Schema.String, quote: Quote }),
)

export const Unhighlighted = defineEvent(
  "reader.unhighlighted",
  1,
  Schema.Struct({ doc: Schema.String, highlight: Schema.String }),
)

export const Asked = defineEvent(
  "reader.asked",
  1,
  Schema.Struct({
    doc: Schema.String,
    thread: Schema.String,
    message: Schema.String,
    question: Schema.String,
    quote: Schema.optionalKey(Quote),
  }),
)

export const Answered = defineEvent(
  "reader.answered",
  1,
  Schema.Struct({
    doc: Schema.String,
    thread: Schema.String,
    message: Schema.String,
    /** What the answer says; empty when it failed. */
    answer: Schema.String,
    failed: Schema.optionalKey(Schema.String),
  }),
)

export const logged = [Opened, Linked, Highlighted, Unhighlighted, Asked, Answered] as const

const Record = defineCommand({
  type: "reader.record",
  payload: Schema.Struct({ type: Schema.String, payload: Schema.Unknown }),
  load: () => null,
  decide: (_, p) => ({ events: [{ type: p.type, payload: p.payload }] }),
})

export interface DocRow {
  readonly doc: string
  readonly title: string
  readonly format: string
  readonly source: string
  readonly words: number
  readonly sections: number
  readonly opened: number
}

export interface HighlightRow {
  readonly id: string
  readonly doc: string
  readonly quote: string
  readonly time: number
}

export interface ThreadRow {
  readonly id: string
  readonly doc: string
  readonly quote: string | null
  readonly started: number
  readonly updated: number
}

export interface MessageRow {
  readonly id: string
  readonly thread: string
  readonly role: "user" | "reader"
  readonly text: string
  readonly failed: string | null
  readonly time: number
}

const projection: Projection = {
  name: "reader",
  version: 1,
  tables: ["docs", "highlights", "threads", "messages"],
  create: `
    CREATE TABLE docs (doc TEXT PRIMARY KEY, title TEXT NOT NULL, format TEXT NOT NULL,
      source TEXT NOT NULL, words INTEGER NOT NULL, sections INTEGER NOT NULL, opened INTEGER NOT NULL);
    CREATE TABLE highlights (id TEXT PRIMARY KEY, doc TEXT NOT NULL, quote TEXT NOT NULL, time INTEGER NOT NULL);
    CREATE TABLE threads (id TEXT PRIMARY KEY, doc TEXT NOT NULL, quote TEXT, started INTEGER NOT NULL,
      updated INTEGER NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, thread TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
      failed TEXT, time INTEGER NOT NULL);
    CREATE INDEX messages_thread ON messages (thread, time);
  `,
  on: [
    on(Opened, (db, p, e) => {
      db.run(
        `INSERT INTO docs (doc, title, format, source, words, sections, opened) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (doc) DO UPDATE SET title = excluded.title, format = excluded.format,
           source = excluded.source, words = excluded.words, sections = excluded.sections, opened = excluded.opened`,
        [p.doc, p.title, p.format, p.source, p.words, p.sections, e.time],
      )
    }),
    on(Highlighted, (db, p, e) => {
      db.run("INSERT OR REPLACE INTO highlights (id, doc, quote, time) VALUES (?, ?, ?, ?)", [
        p.highlight,
        p.doc,
        JSON.stringify(p.quote),
        e.time,
      ])
    }),
    on(Unhighlighted, (db, p) => {
      db.run("DELETE FROM highlights WHERE id = ?", [p.highlight])
    }),
    on(Asked, (db, p, e) => {
      db.run(
        `INSERT INTO threads (id, doc, quote, started, updated) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET updated = excluded.updated`,
        [p.thread, p.doc, p.quote === undefined ? null : JSON.stringify(p.quote), e.time, e.time],
      )
      db.run(
        "INSERT OR REPLACE INTO messages (id, thread, role, text, failed, time) VALUES (?, ?, 'user', ?, NULL, ?)",
        [p.message, p.thread, p.question, e.time],
      )
    }),
    on(Answered, (db, p, e) => {
      db.run("UPDATE threads SET updated = ? WHERE id = ?", [e.time, p.thread])
      db.run(
        "INSERT OR REPLACE INTO messages (id, thread, role, text, failed, time) VALUES (?, ?, 'reader', ?, ?, ?)",
        [p.message, p.thread, p.answer, p.failed ?? null, e.time],
      )
    }),
  ],
  snapshot: () => null,
}

export const logLayer = () =>
  Log.layer({
    path: path.join(DIR, "reader.db"),
    events: [...logged],
    projections: [projection],
    commands: [Record],
  })

/** Records one event in the log (once per `id`). */
export const record = (id: string, draft: { readonly type: string; readonly payload: unknown }) =>
  Effect.gen(function* recording() {
    const log = yield* Log
    yield* log.dispatch({ id, type: Record.type, source: "reader", payload: draft })
  })

export const read = <A>(f: (db: Database) => A) =>
  Effect.gen(function* reading() {
    const log = yield* Log
    return yield* log.read(f)
  })

// --- Documents' words ---

const StoredSchema = Schema.Struct({
  doc: Schema.String,
  source: Schema.String,
  title: Schema.String,
  format: Schema.Literals(FORMATS),
  lang: Schema.String,
  author: Schema.optionalKey(Schema.String),
  words: Schema.Finite,
  sections: Schema.Array(
    Schema.Struct({ label: Schema.optionalKey(Schema.String), markdown: Schema.String }),
  ),
  /** Moves each time its words change (a fresh read, links added), so a client fetches them again. */
  version: Schema.Finite,
  /** Whether its notable terms have been linked. */
  linked: Schema.Boolean,
})

export type Stored = typeof StoredSchema.Type

const decodeStored = Schema.decodeUnknownSync(Schema.fromJsonString(StoredSchema))

const fileOf = (doc: string) => path.join(DIR, "docs", `${doc.replaceAll(/[^\w-]/gu, "")}.json`)

export const load = (doc: string): Stored | null => {
  const file = fileOf(doc)
  if (!existsSync(file)) {
    return null
  }
  return decodeStored(readFileSync(file, "utf-8"))
}

export const save = (stored: Stored) => {
  writeFileAtomic(fileOf(stored.doc), JSON.stringify(stored))
}
