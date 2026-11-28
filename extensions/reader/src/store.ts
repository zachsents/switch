// What the reader keeps: each document's words in a file of its own (`docs/<id>.json`, written
// whole), and in its log the documents opened, their highlights, their threads (each a passage with
// the questions asked about it and Switch's answers), the notes those threads pinned to passages,
// and every lookup's answer, so none is fetched twice. The same events go to the brain.
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
    /** The space it was opened from: where its threads with Switch are. */
    space: Schema.optionalKey(Schema.String),
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
    /** A new thread's space: where its side thread with Switch is. */
    space: Schema.optionalKey(Schema.String),
    /** That side thread (switch-ext-kit's `sideThread`), whose record holds the conversation. */
    side: Schema.optionalKey(Schema.String),
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
    side: Schema.optionalKey(Schema.String),
  }),
)

/** What a note is: a term's meaning, an idea explained, or where to read more. */
export const NoteKind = Schema.Literals(["definition", "callout", "link"])
export type Kind = typeof NoteKind.Type

/** A note made or changed, whole: pinned to its passage, from the thread that settled it. */
export const Noted = defineEvent(
  "reader.noted",
  1,
  Schema.Struct({
    doc: Schema.String,
    note: Schema.String,
    kind: NoteKind,
    /** What it's about, as the document writes it: how it's found again in other documents. */
    term: Schema.String,
    text: Schema.String,
    url: Schema.optionalKey(Schema.String),
    quote: Quote,
    thread: Schema.optionalKey(Schema.String),
  }),
)

export const Unnoted = defineEvent(
  "reader.unnoted",
  1,
  Schema.Struct({ doc: Schema.String, note: Schema.String }),
)

export const Sense = Schema.Struct({
  pos: Schema.String,
  text: Schema.String,
  example: Schema.optionalKey(Schema.String),
})

export const DictionaryEntry = Schema.Struct({
  word: Schema.String,
  senses: Schema.Array(Sense),
  url: Schema.String,
})
export type Dictionary = typeof DictionaryEntry.Type

export const ArticleSummary = Schema.Struct({
  title: Schema.String,
  description: Schema.optionalKey(Schema.String),
  extract: Schema.String,
  url: Schema.String,
  thumbnail: Schema.optionalKey(Schema.String),
})
export type Article = typeof ArticleSummary.Type

/** A lookup's answer (either may be none), kept with the document it was looked up in. */
export const LookedUp = defineEvent(
  "reader.looked_up",
  1,
  Schema.Struct({
    /** What it was asked by: `t:<lang>:<term>` or `w:<lang>:<article>`. */
    key: Schema.String,
    term: Schema.String,
    doc: Schema.optionalKey(Schema.String),
    dictionary: Schema.NullOr(DictionaryEntry),
    wikipedia: Schema.NullOr(ArticleSummary),
  }),
)

export const logged = [
  Opened,
  Linked,
  Highlighted,
  Unhighlighted,
  Asked,
  Answered,
  Noted,
  Unnoted,
  LookedUp,
] as const

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
  readonly space: string | null
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
  readonly space: string | null
  readonly started: number
  readonly updated: number
}

export interface NoteRow {
  readonly id: string
  readonly doc: string
  readonly kind: Kind
  readonly term: string
  readonly text: string
  readonly url: string | null
  readonly quote: string
  readonly thread: string | null
  readonly made: number
  readonly edited: number
}

export interface LookupRow {
  readonly key: string
  readonly doc: string
  readonly term: string
  readonly dictionary: string | null
  readonly wikipedia: string | null
  readonly time: number
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
  version: 3,
  tables: ["docs", "highlights", "threads", "messages", "notes", "lookups"],
  create: `
    CREATE TABLE docs (doc TEXT PRIMARY KEY, title TEXT NOT NULL, format TEXT NOT NULL,
      source TEXT NOT NULL, words INTEGER NOT NULL, sections INTEGER NOT NULL, opened INTEGER NOT NULL,
      space TEXT);
    CREATE TABLE highlights (id TEXT PRIMARY KEY, doc TEXT NOT NULL, quote TEXT NOT NULL, time INTEGER NOT NULL);
    CREATE TABLE threads (id TEXT PRIMARY KEY, doc TEXT NOT NULL, quote TEXT, space TEXT,
      started INTEGER NOT NULL, updated INTEGER NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, thread TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
      failed TEXT, time INTEGER NOT NULL);
    CREATE INDEX messages_thread ON messages (thread, time);
    CREATE TABLE notes (id TEXT PRIMARY KEY, doc TEXT NOT NULL, kind TEXT NOT NULL, term TEXT NOT NULL,
      text TEXT NOT NULL, url TEXT, quote TEXT NOT NULL, thread TEXT, made INTEGER NOT NULL,
      edited INTEGER NOT NULL);
    CREATE INDEX notes_doc ON notes (doc, made);
    CREATE TABLE lookups (key TEXT NOT NULL, doc TEXT NOT NULL, term TEXT NOT NULL, dictionary TEXT,
      wikipedia TEXT, time INTEGER NOT NULL, PRIMARY KEY (key, doc));
  `,
  on: [
    on(Opened, (db, p, e) => {
      db.run(
        `INSERT INTO docs (doc, title, format, source, words, sections, opened, space) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (doc) DO UPDATE SET title = excluded.title, format = excluded.format,
           source = excluded.source, words = excluded.words, sections = excluded.sections,
           opened = excluded.opened, space = coalesce(excluded.space, docs.space)`,
        [p.doc, p.title, p.format, p.source, p.words, p.sections, e.time, p.space ?? null],
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
        `INSERT INTO threads (id, doc, quote, space, started, updated) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET updated = excluded.updated`,
        [
          p.thread,
          p.doc,
          p.quote === undefined ? null : JSON.stringify(p.quote),
          p.space ?? null,
          e.time,
          e.time,
        ],
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
    on(Noted, (db, p, e) => {
      db.run(
        `INSERT INTO notes (id, doc, kind, term, text, url, quote, thread, made, edited)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, term = excluded.term,
           text = excluded.text, url = excluded.url, quote = excluded.quote, edited = excluded.edited`,
        [
          p.note,
          p.doc,
          p.kind,
          p.term,
          p.text,
          p.url ?? null,
          JSON.stringify(p.quote),
          p.thread ?? null,
          e.time,
          e.time,
        ],
      )
    }),
    on(Unnoted, (db, p) => {
      db.run("DELETE FROM notes WHERE id = ?", [p.note])
    }),
    on(LookedUp, (db, p, e) => {
      db.run(
        "INSERT OR REPLACE INTO lookups (key, doc, term, dictionary, wikipedia, time) VALUES (?, ?, ?, ?, ?, ?)",
        [
          p.key,
          p.doc ?? "",
          p.term,
          p.dictionary === null ? null : JSON.stringify(p.dictionary),
          p.wikipedia === null ? null : JSON.stringify(p.wikipedia),
          e.time,
        ],
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
  outline: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        title: Schema.String,
        level: Schema.Literals([2, 3]),
        section: Schema.Finite,
      }),
    ),
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
