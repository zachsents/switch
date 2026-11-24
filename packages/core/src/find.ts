// Finding in what was said and kept: chat messages, action items and memories in one full-text
// index (SQLite FTS5, trigram, so any part of a word matches), read through the sync's `find` page.
// A row's rowid is the seq of the event that wrote it, so a later version replaces it in place.
// The exchanges' words are in it too, by their work (kind turn, ref the thread): what the history
// tools search, as the agent's history beyond its session (measured: .experiments/context).
import type { Database } from "bun:sqlite"
import {
  exchangeText,
  reasonOf,
  TurnInjected,
  turnItems,
  TurnStarted,
  TurnText,
} from "@switch/agent"
import { ItemOpened, MemoryWritten } from "@switch/autonomy"
import { Brain, HOME, MessagePosted, MessageRead, on, SpaceId, whoOf } from "@switch/brain"
import type { Projection } from "@switch/brain"
import { Caller, defineApp, Rejected, tool } from "switch-ext-kit"
import { Effect, Option, Schema } from "effect"

const KINDS = ["message", "item", "memory"] as const
type Kind = (typeof KINDS)[number]

const put = (db: Database, kind: Kind, ref: string, row: number, text: string) => {
  const old = db
    .query<{ row: number }, [string, string]>(
      "SELECT row FROM found_refs WHERE kind = ? AND ref = ?",
    )
    .get(kind, ref)
  if (old) {
    db.query("DELETE FROM found WHERE rowid = ?").run(old.row)
  }
  db.query("INSERT INTO found (rowid, kind, ref, text) VALUES (?, ?, ?, ?)").run(
    row,
    kind,
    ref,
    text,
  )
  db.query("INSERT OR REPLACE INTO found_refs (kind, ref, row) VALUES (?, ?, ?)").run(
    kind,
    ref,
    row,
  )
}

// An exchange's words are never revised: no ref to replace them by.
const said = (db: Database, row: number, thread: string, text: string) => {
  if (text.trim() !== "") {
    db.query("INSERT INTO found (rowid, kind, ref, text) VALUES (?, 'turn', ?, ?)").run(
      row,
      thread,
      text,
    )
  }
}

export const found: Projection = {
  name: "found",
  version: 2,
  tables: ["found", "found_refs"],
  create: `
    CREATE VIRTUAL TABLE found USING fts5(kind UNINDEXED, ref UNINDEXED, text, tokenize = 'trigram');
    CREATE TABLE found_refs (kind TEXT NOT NULL, ref TEXT NOT NULL, row INTEGER NOT NULL, PRIMARY KEY (kind, ref));`,
  on: [
    on(MessagePosted, (db, p, e) => {
      put(db, "message", String(e.seq), e.seq, p.text)
    }),
    // The pre-read's fixed words replace what was typed.
    on(MessageRead, (db, p, e) => {
      put(db, "message", String(p.seq), e.seq, p.text)
    }),
    on(ItemOpened, (db, p, e) => {
      put(db, "item", p.id, e.seq, `${p.title}\n${p.body}`)
    }),
    on(MemoryWritten, (db, p, e) => {
      put(db, "memory", p.id, e.seq, `${p.description}\n${p.body}`)
    }),
    // The user's words, or why a wake ran; the agent's words; a steer.
    on(TurnStarted, (db, p, e) => {
      said(db, e.seq, p.thread, p.text === "" ? reasonOf(p) : p.text)
    }),
    on(TurnText, (db, p, e) => {
      said(db, e.seq, p.thread, p.text)
    }),
    on(TurnInjected, (db, p, e) => {
      if (p.kind === "steer") {
        said(db, e.seq, p.thread, p.text)
      }
    }),
  ],
  snapshot: () => null,
}

/** The words of a query, as FTS5 phrases all of which must match; trigrams need three letters. */
const matchOf = (words: readonly string[]) =>
  words
    .filter((w) => w.length >= 3)
    .map((w) => `"${w.replaceAll('"', '""')}"`)
    .join(" AND ")

const wordsOf = (query: string) => query.toLowerCase().split(/\s+/u).filter(Boolean)

const AROUND = 60

/** The line of `text` where a word first matches, cut to a window around it. */
export const lineOf = (text: string, words: readonly string[]) => {
  const lines = text.split("\n").map((l) => l.replaceAll(/\s+/gu, " ").trim())
  const hit = (l: string) => words.some((w) => l.toLowerCase().includes(w))
  const line = lines.find(hit) ?? lines.find(Boolean) ?? ""
  const lower = line.toLowerCase()
  const at = Math.min(...words.map((w) => lower.indexOf(w)).filter((i) => i >= 0), line.length)
  const start = at > AROUND ? at - AROUND : 0
  const end = Math.min(line.length, at + AROUND * 2)
  return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`
}

interface Hit {
  readonly kind: Kind
  readonly ref: string
  readonly text: string
}

interface MessageRow {
  readonly seq: number
  readonly time: number
  readonly space: SpaceId
  readonly source: string
}

const RESULTS = 30

/** Across every space: messages, action items and live memories, best first. */
const everywhere = (db: Database, query: string) => {
  const words = wordsOf(query)
  const match = matchOf(words)
  if (match === "") {
    return []
  }
  const hits = db
    .query<Hit, [string, number]>(
      "SELECT kind, ref, text FROM found WHERE found MATCH ? AND kind != 'turn' ORDER BY bm25(found) LIMIT ?",
    )
    .all(match, RESULTS * 2)
  const message = db.query<MessageRow, [number]>(
    "SELECT seq, time, space, source FROM messages WHERE seq = ? AND widget IS NULL",
  )
  const item = db.query<{ space: SpaceId; title: string; opened_at: number }, [string]>(
    "SELECT space, json_extract(data, '$.title') AS title, opened_at FROM action_items WHERE id = ?",
  )
  const memory = db.query<{ scope: string; description: string; written_at: number }, [string]>(
    "SELECT scope, description, written_at FROM memories WHERE id = ? AND status = 'live'",
  )
  const out = []
  for (const h of hits) {
    const line = lineOf(h.text, words)
    if (h.kind === "message") {
      const m = message.get(Number(h.ref))
      if (m) {
        out.push({
          kind: h.kind,
          id: h.ref,
          space: m.space,
          seq: m.seq,
          time: m.time,
          who: whoOf(m.source),
          line,
        })
      }
    } else if (h.kind === "item") {
      const i = item.get(h.ref)
      if (i) {
        out.push({
          kind: h.kind,
          id: h.ref,
          space: i.space,
          title: i.title,
          time: i.opened_at,
          line,
        })
      }
    } else {
      const m = memory.get(h.ref)
      if (m) {
        const space = m.scope === "global" ? HOME : SpaceId.make(m.scope)
        out.push({ kind: h.kind, id: h.ref, space, title: m.description, time: m.written_at, line })
      }
    }
  }
  return out.slice(0, RESULTS)
}

const escapeLike = (s: string) => s.replaceAll(/[\\%_]/gu, (c) => `\\${c}`)

/** In one space's chat, its own lines and those mentioning it: every match's seq, oldest first. */
const inSpace = (db: Database, space: SpaceId, query: string) => {
  const q = query.trim()
  if (q === "") {
    return []
  }
  const like = `%${escapeLike(q)}%`
  return db
    .query<{ seq: number }, [string, string]>(
      `SELECT seq FROM messages WHERE space = ?1 AND widget IS NULL AND text LIKE ?2 ESCAPE '\\'
       UNION
       SELECT m.seq FROM mentions x JOIN messages m ON m.seq = x.seq
         WHERE x.space = ?1 AND m.widget IS NULL AND m.text LIKE ?2 ESCAPE '\\'
       ORDER BY seq`,
    )
    .all(space, like)
    .map((r) => r.seq)
}

const findArgs = Schema.decodeUnknownOption(
  Schema.Struct({ query: Schema.String, space: Schema.optionalKey(SpaceId) }),
)

/** The `find` page: `{query}` everywhere, or `{query, space}` for the seqs in that chat. */
export const findPage = (db: Database, args: unknown) =>
  Option.match(findArgs(args), {
    onNone: () => [],
    onSome: (a) =>
      a.space === undefined ? everywhere(db, a.query) : inSpace(db, a.space, a.query),
  })

export const findConfig = { events: [], projections: [found], commands: [] }

const SHOWN = 8
const SNIPPET = 600
const READ_MAX = 20_000

/** The words of a search, any of which may match, best first: as the experiment's tool ranked. */
const anyOf = (words: readonly string[]) =>
  words
    .filter((w) => w.length >= 3)
    .map((w) => `"${w.replaceAll('"', '""')}"`)
    .join(" OR ")

/** An exchange as the history tools show it: when, its id, then its words. */
const exchangeOf = (db: Database, turn: string, tools: boolean) => {
  const rows = turnItems(db, turn)
  if (rows.length === 0) {
    return null
  }
  const at = db
    .query<{ time: number }, [string]>(
      "SELECT e.time FROM turn_spans span JOIN events e ON e.seq = span.first WHERE span.turn = ?",
    )
    .get(turn)
  const when = new Date(at?.time ?? 0).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
  return `[${when} · ${turn}]\n${exchangeText(rows, tools)}`
}

/** A work's exchanges that match any of `words`, best first, each cut short. */
const searchHistory = (db: Database, thread: string, words: string) => {
  const match = anyOf(wordsOf(words))
  if (match === "") {
    return []
  }
  const turns = db
    .query<{ turn: string }, [string, string]>(
      `SELECT i.turn FROM (
         SELECT rowid, bm25(found) AS rank FROM found
         WHERE found MATCH ?1 AND kind = 'turn' AND ref = ?2 ORDER BY rank LIMIT 200) f
       JOIN thread_items i ON i.seq = f.rowid ORDER BY f.rank`,
    )
    .all(match, thread)
    .map((r) => r.turn)
  return [...new Set(turns)]
    .slice(0, SHOWN)
    .flatMap((t) => exchangeOf(db, t, false) ?? [])
    .map((x) => x.slice(0, SNIPPET))
}

// What history a rebuilt session leaves out stays here (agent/src/transcript.ts): these are how
// the agent reaches it, as the experiment's B had them.
export const historyApp = defineApp<Brain>({
  name: "history",
  version: "1",
  instructions: "This work's earlier exchanges with the user, beyond what your session holds.",
  tools: [
    tool(
      "search",
      {
        description:
          "Search this work's earlier exchanges (yours and the user's) by words. Returns matching exchanges, best first, each with its id.",
        readOnly: true,
        input: Schema.Struct({ words: Schema.String }),
      },
      (input) =>
        Effect.gen(function* searching() {
          const brain = yield* Brain
          const caller = yield* Caller
          const hits = yield* brain.read((db) =>
            searchHistory(db, caller.thread ?? "", input.words),
          )
          return hits.length === 0 ? "Nothing found" : hits.join("\n\n")
        }),
    ),
    tool(
      "read",
      {
        description:
          "Read one earlier exchange in full, with its tool calls, by the id history_search gave.",
        readOnly: true,
        input: Schema.Struct({ id: Schema.String }),
      },
      (input) =>
        Effect.gen(function* reading() {
          const brain = yield* Brain
          const text = yield* brain.read((db) => exchangeOf(db, input.id.trim(), true))
          return text === null
            ? yield* new Rejected({ reason: `No exchange ${input.id}` })
            : text.slice(0, READ_MAX)
        }),
    ),
  ],
})
