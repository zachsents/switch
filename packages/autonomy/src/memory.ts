// Memory: one write path. A proposed lesson goes through the gate's memory exit, then a writer that
// merges it with what's already held and generalizes it, or drops it. Each memory is a Claude Code
// memory file: a name, a one-line description, a type, and a body with the lesson, **Why:** and
// **How to apply:**. Its scope is global or a space, inherited down the tree.
// A rule the user gave keeps their exact words and the message they came from.
import type { Database } from "bun:sqlite"
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import {
  allSpaces,
  Brain,
  BYPASS,
  bypassOf,
  defineCommand,
  defineEvent,
  defineRead,
  emDashRefusal,
  EventId,
  HOME,
  on,
  SpaceId,
  unlessBypassed,
} from "@switch/brain"
import type { Projection, Space, ThreadId } from "@switch/brain"
import { Models } from "@switch/models"
import { Effect, Schema } from "effect"

import { gate } from "./gate.ts"
import type { Verdict } from "./gate.ts"
import { changeOpen } from "./dial-values.ts"
import { EDIT, EditPayload, FORGET, ForgetPayload } from "./memory-commands.ts"
import { field, jsonOf, strings, text } from "./json.ts"

export const GLOBAL = "global"
/** What a memory holds for: everywhere, or a space and the spaces under it. */
export type Scope = typeof GLOBAL | SpaceId

/** Claude Code's memory types. Rules and preferences are `feedback` and `user`. */
export const TYPES = ["user", "feedback", "project", "reference"] as const
export type MemoryType = (typeof TYPES)[number]

const trigger = Schema.Struct({
  /** Tool names; a trailing * matches any suffix, a leading * any prefix. */
  tools: Schema.Array(Schema.String),
  /** Any of these in the call's input fires it; none means any call to those tools. */
  words: Schema.Array(Schema.String),
})
export type Trigger = typeof trigger.Type

export const said = Schema.Struct({
  /** Their words, verbatim. */
  text: Schema.String,
  /** The `message.posted` they're from. */
  seq: Schema.Number,
  time: Schema.Number,
  space: SpaceId,
})
export type Said = typeof said.Type

export const MemoryWritten = defineEvent(
  "memory.written",
  1,
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    description: Schema.String,
    type: Schema.Literals(TYPES),
    /** "global" or a space. */
    scope: Schema.String,
    body: Schema.String,
    /** Set for a memory tied to an action: injected right before a matching tool call. */
    trigger: Schema.NullOr(trigger),
    /** What it merges or supersedes. */
    replaces: Schema.Array(Schema.String),
    /** The gate decision it passed, or "" for an import or the user's edit. */
    decision: Schema.String,
    /** The space whose turn learned it as it worked, for its chat's "Remembered" line. */
    space: Schema.optionalKey(SpaceId),
    /** The user's own words it keeps, when it's their rule. */
    said: Schema.optionalKey(said),
  }),
)

export const MemoryUsed = defineEvent(
  "memory.used",
  1,
  Schema.Struct({ ids: Schema.Array(Schema.String), space: SpaceId }),
)

/** The user forgot it, and put back what it had replaced: a "Remembered" line's Undo. */
export const MemoryForgotten = defineEvent(
  "memory.forgotten",
  1,
  Schema.Struct({ id: Schema.String, restore: Schema.Array(Schema.String) }),
)

/** A core field: always loaded. `sources` are the memories it conveys. */
export const MemoryCore = defineEvent(
  "memory.core",
  1,
  Schema.Struct({
    scope: Schema.String,
    text: Schema.String,
    sources: Schema.Array(Schema.String),
    tokens: Schema.Number,
    /** Of the memories it was built from: unchanged means no rebuild. */
    from: Schema.String,
  }),
)

export interface Memory {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly type: MemoryType
  readonly scope: string
  readonly body: string
  readonly trigger: Trigger | null
  readonly writtenAt: number
  readonly usedAt: number | null
  readonly uses: number
  readonly said: Said | null
}

interface Row {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly type: MemoryType
  readonly scope: string
  readonly body: string
  readonly trigger: string | null
  readonly written_at: number
  readonly used_at: number | null
  readonly uses: number
  readonly said_text: string | null
  readonly said_seq: number | null
  readonly said_time: number | null
  readonly said_space: SpaceId | null
}

const parseTrigger: (json: string) => Trigger = JSON.parse

const toMemory = (r: Row): Memory => ({
  id: r.id,
  name: r.name,
  description: r.description,
  type: r.type,
  scope: r.scope,
  body: r.body,
  trigger: r.trigger === null ? null : parseTrigger(r.trigger),
  writtenAt: r.written_at,
  usedAt: r.used_at,
  uses: r.uses,
  said:
    r.said_text === null || r.said_space === null
      ? null
      : { text: r.said_text, seq: r.said_seq ?? 0, time: r.said_time ?? 0, space: r.said_space },
})

const when = (ms: number) =>
  new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })

/** `User (Nov 17 16:05): "…"`, for a memory that keeps the user's words. */
export const saidLine = (m: Pick<Memory, "said">) =>
  m.said === null ? "" : `User (${when(m.said.time)}): ${JSON.stringify(m.said.text)}`

/** What search and the filter read of a memory. */
export const memoryText = (m: Pick<Memory, "name" | "description" | "body">) =>
  `${m.description}\n${m.body}`

const retire = (db: Database, id: string, status: string) => {
  db.query("UPDATE memories SET status = ? WHERE id = ? AND status = 'live'").run(status, id)
  db.query("DELETE FROM memories_fts WHERE id = ?").run(id)
}

const revive = (db: Database, id: string) => {
  const row = db
    .query<Row, [string]>("SELECT * FROM memories WHERE id = ? AND status = 'replaced'")
    .get(id)
  if (row) {
    db.query("UPDATE memories SET status = 'live' WHERE id = ?").run(id)
    db.query("INSERT INTO memories_fts (id, text) VALUES (?, ?)").run(id, memoryText(row))
  }
}

export const memories: Projection = {
  name: "memories",
  version: 2,
  tables: ["memories", "memories_fts", "memory_cores"],
  create: `
    CREATE TABLE memories (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
      type TEXT NOT NULL, scope TEXT NOT NULL, body TEXT NOT NULL, trigger TEXT,
      decision TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'live', written_at INTEGER NOT NULL,
      used_at INTEGER, uses INTEGER NOT NULL DEFAULT 0, said_text TEXT, said_seq INTEGER,
      said_time INTEGER, said_space TEXT);
    CREATE INDEX memories_scope ON memories (status, scope);
    CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, text, tokenize = 'porter');
    CREATE TABLE memory_cores (scope TEXT PRIMARY KEY, text TEXT NOT NULL, sources TEXT NOT NULL,
      tokens INTEGER NOT NULL, built_from TEXT NOT NULL, time INTEGER NOT NULL);`,
  // The wake rules found by name (rules.ts), not by reading every memory's row.
  indexes: "CREATE INDEX IF NOT EXISTS memories_name ON memories (status, name);",
  on: [
    on(MemoryWritten, (db, p, e) => {
      for (const id of p.replaces) {
        if (id !== p.id) {
          retire(db, id, "replaced")
        }
      }
      db.query(
        `INSERT INTO memories (id, name, description, type, scope, body, trigger, decision, written_at,
           said_text, said_seq, said_time, said_space)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description,
           type = excluded.type, scope = excluded.scope, body = excluded.body,
           trigger = excluded.trigger, decision = excluded.decision, status = 'live',
           written_at = excluded.written_at,
           said_text = coalesce(excluded.said_text, said_text), said_seq = coalesce(excluded.said_seq, said_seq),
           said_time = coalesce(excluded.said_time, said_time), said_space = coalesce(excluded.said_space, said_space)`,
      ).run(
        p.id,
        p.name,
        p.description,
        p.type,
        p.scope,
        p.body,
        p.trigger === null ? null : JSON.stringify(p.trigger),
        p.decision,
        e.time,
        p.said?.text ?? null,
        p.said?.seq ?? null,
        p.said?.time ?? null,
        p.said?.space ?? null,
      )
      db.query("DELETE FROM memories_fts WHERE id = ?").run(p.id)
      db.query("INSERT INTO memories_fts (id, text) VALUES (?, ?)").run(p.id, memoryText(p))
    }),
    on(MemoryUsed, (db, p, e) => {
      const use = db.query("UPDATE memories SET uses = uses + 1, used_at = ? WHERE id = ?")
      for (const id of p.ids) {
        use.run(e.time, id)
      }
    }),
    on(MemoryForgotten, (db, p) => {
      retire(db, p.id, "forgotten")
      for (const id of p.restore) {
        revive(db, id)
      }
    }),
    on(MemoryCore, (db, p, e) => {
      db.query(
        "INSERT OR REPLACE INTO memory_cores (scope, text, sources, tokens, built_from, time) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(p.scope, p.text, JSON.stringify(p.sources), p.tokens, p.from, e.time)
    }),
  ],
  snapshot: (db) =>
    db
      .query<{ scope: string; n: number }, []>(
        "SELECT scope, count(*) AS n FROM memories WHERE status = 'live' GROUP BY scope",
      )
      .all(),
  sources: [
    {
      name: "memories",
      description:
        "What's remembered: id, description, type (user, feedback, project, reference), scope (global or a space), body, status (live, replaced), said (the user's words, when theirs), said_seq (their message), written_at, uses.",
      select:
        "SELECT id, description, type, scope, body, status, said_text AS said, said_seq, written_at, uses, rowid AS n FROM memories",
      columns: [
        "id",
        "description",
        "type",
        "scope",
        "body",
        "status",
        "said",
        "said_seq",
        "written_at",
        "uses",
        "n",
      ],
      time: "written_at",
      order: "n",
      depends: ["memory."],
    },
  ],
}

export const liveMemories = (db: Database): Memory[] =>
  db.query<Row, []>("SELECT * FROM memories WHERE status = 'live' ORDER BY id").all().map(toMemory)

export const getMemory = (db: Database, id: string) => {
  const row = db.query<Row, [string]>("SELECT * FROM memories WHERE id = ?").get(id)
  return row ? toMemory(row) : null
}

const statusOf = (db: Database, id: string) =>
  db.query<{ status: string }, [string]>("SELECT status FROM memories WHERE id = ?").get(id)
    ?.status ?? null

/**
 * Forgotten from the memory page, or a "Remembered" line undone, putting back what it replaced. A
 * dial's change (settings.ts) is a "Remembered" line too: undone, the dial goes back.
 */
export const ForgetMemory = defineCommand({
  type: FORGET,
  payload: ForgetPayload,
  load: (db, p) => ({
    live: statusOf(db, p.id) === "live" || changeOpen(db, p.id),
    restore: (p.restore ?? []).filter((id) => statusOf(db, id) === "replaced"),
  }),
  decide: (s, p) =>
    s.live
      ? { events: [MemoryForgotten.make({ id: p.id, restore: s.restore })] }
      : { reject: "No such memory" },
})

/** The user's own words for a memory: its line and its body. */
export const EditMemory = defineCommand({
  type: EDIT,
  payload: EditPayload,
  load: (db, p) => (statusOf(db, p.id) === "live" ? getMemory(db, p.id) : null),
  decide: (m, p) => {
    if (!m) {
      return { reject: "No such memory" }
    }
    if (p.body.trim() === "") {
      return { reject: "Empty" }
    }
    if (m.description === p.description && m.body === p.body) {
      return { events: [] }
    }
    return {
      events: [
        MemoryWritten.make({
          id: m.id,
          name: m.name,
          description: p.description.slice(0, 200),
          type: m.type,
          scope: m.scope,
          body: p.body,
          trigger: m.trigger,
          replaces: [],
          decision: "",
        }),
      ],
    }
  },
})

export const memoryConfig = {
  events: [MemoryWritten, MemoryUsed, MemoryForgotten, MemoryCore],
  projections: [memories],
  commands: [ForgetMemory, EditMemory],
}

/** A space and every space above it, root first: the scopes it inherits. */
export const scopesOf = (db: Database, space: Scope): Scope[] => {
  const byId = new Map<string, Space>(allSpaces(db).map((s) => [s.id, s]))
  const chain: SpaceId[] = []
  for (
    let s = byId.get(space);
    s !== undefined && !chain.includes(s.id);
    s = byId.get(s.parent ?? "")
  ) {
    chain.push(s.id)
  }
  return [GLOBAL, ...chain.filter((id) => id !== HOME).toReversed()]
}

// Search: full text (bm25 over the longest uncommon words) and vectors, as the recall eval ran them.

const STOP = new Set(
  "the a an and or of to in on for is it that this with be as at by from i you he she we they was were are am not no do did does have has had my your me him his her our their its if then so but just can will would should could what which who when where how all any some more most other into than too very there here up out about also get got let lets ok okay yes".split(
    " ",
  ),
)

export const ftsQuery = (query: string, max = 32) => {
  const words: string[] = []
  for (const w of query.toLowerCase().match(/[a-z0-9]+/gu) ?? []) {
    if (w.length > 2 && !STOP.has(w) && !words.includes(w)) {
      words.push(w)
    }
  }
  return words
    .toSorted((a, b) => b.length - a.length)
    .slice(0, max)
    .map((w) => `"${w}"`)
    .join(" OR ")
}

export const fts = (db: Database, query: string, k: number): string[] => {
  const q = ftsQuery(query)
  if (q === "") {
    return []
  }
  return db
    .query<{ id: string }, [string, number]>(
      "SELECT id FROM memories_fts WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT ?",
    )
    .all(q, k)
    .map((r) => r.id)
}

/** The user's rules and preferences that bear on `text` in `space`, most relevant first. */
export const rulesFor = (db: Database, space: SpaceId, about: string, k: number) => {
  const scopes = new Set<string>(scopesOf(db, space))
  const live = new Map(liveMemories(db).map((m) => [m.id, m]))
  return fts(db, about, 32)
    .flatMap((id) => {
      const m = live.get(id)
      return m && scopes.has(m.scope) && (m.type === "feedback" || m.type === "user") ? [m] : []
    })
    .slice(0, k)
    .map((m) => ({ id: m.id, text: m.description === "" ? m.body : m.description }))
}

// Vectors are a cache beside the log, not a projection: an embedding is a model call.
const VECTORS =
  "CREATE TABLE IF NOT EXISTS memory_vectors (id TEXT PRIMARY KEY, text TEXT NOT NULL, vec BLOB NOT NULL)"

const toBlob = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
const fromBlob = (b: Uint8Array) =>
  new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))

/** Whether the vectors' table is there yet: only embedding makes it, and a read can't. */
const hasVectors = (db: Database) =>
  db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_vectors'",
    )
    .get() !== null

/** Live memories whose vector is missing or stale. */
const unembeddedRead = defineRead("autonomy/memory/unembedded", (db) => {
  const have = new Map(
    db
      .query<{ id: string; text: string }, []>("SELECT id, text FROM memory_vectors")
      .all()
      .map((r) => [r.id, r.text]),
  )
  return liveMemories(db).filter((m) => have.get(m.id) !== memoryText(m))
})

/** Embeds live memories whose vector is missing or stale. */
export const embedMissing = Effect.gen(function* embedding() {
  const brain = yield* Brain
  const models = yield* Models
  // Without the gateway's key there are no vectors: recall reads by full text alone.
  if (!(yield* models.keyed)) {
    return { embedded: 0, cost: 0 }
  }
  // The table is made here, the one place that writes it, so the reads stay reads.
  yield* brain.migrate((db) => db.run(VECTORS))
  const todo = yield* brain.read(unembeddedRead)
  let cost = 0
  for (let i = 0; i < todo.length; i += 200) {
    const chunk = todo.slice(i, i + 200)
    const e = yield* models.embed(chunk.map(memoryText))
    cost += e.cost
    yield* brain.migrate((db) => {
      const put = db.query("INSERT OR REPLACE INTO memory_vectors (id, text, vec) VALUES (?, ?, ?)")
      for (const [j, m] of chunk.entries()) {
        const v = e.vectors[j]
        if (v && v.length > 0) {
          put.run(m.id, memoryText(m), toBlob(v))
        }
      }
    })
  }
  return { embedded: todo.length, cost }
})

let vectorCache: { readonly count: number; readonly rows: readonly [string, Float32Array][] } = {
  count: -1,
  rows: [],
}

const vectors = (db: Database) => {
  // Before anything's embedded there's no table, and no vectors.
  if (!hasVectors(db)) {
    return []
  }
  const count =
    db.query<{ n: number }, []>("SELECT count(*) AS n FROM memory_vectors").get()?.n ?? 0
  if (count !== vectorCache.count) {
    vectorCache = {
      count,
      rows: db
        .query<{ id: string; vec: Uint8Array }, []>("SELECT id, vec FROM memory_vectors")
        .all()
        .map((r): [string, Float32Array] => [r.id, fromBlob(r.vec)]),
    }
  }
  return vectorCache.rows
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0
  for (let i = 0; i < a.length; i += 1) {
    s += (a[i] ?? 0) * (b[i] ?? 0)
  }
  return s
}

/** Nearest live memories to `query`, best first. `live` filters ids. */
export const nearest = (
  db: Database,
  query: Float32Array,
  k: number,
  keep: (id: string) => boolean,
): string[] =>
  vectors(db)
    .filter(([id]) => keep(id))
    .map(([id, v]) => [id, dot(v, query)] as const)
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([id]) => id)

/** Live memories near a query's vector (none without one) and its words, merged, at most `k`. */
const similarRead = defineRead(
  "autonomy/memory/similar",
  (db, query: string, vector: Float32Array | null, k: number) => {
    const live = new Set(liveMemories(db).map((m) => m.id))
    const byVector = vector === null ? [] : nearest(db, vector, k, (id) => live.has(id))
    const byText = fts(db, query, k).filter((id) => live.has(id))
    const ids: string[] = []
    for (let i = 0; ids.length < k && i < k; i += 1) {
      for (const id of [byVector[i], byText[i]]) {
        if (id !== undefined && !ids.includes(id)) {
          ids.push(id)
        }
      }
    }
    return ids.slice(0, k).flatMap((id) => getMemory(db, id) ?? [])
  },
)

/** Live memories similar to `text`: vector and full text merged, at most `k`. */
export const similar = (query: string, k: number) =>
  Effect.gen(function* searching() {
    const brain = yield* Brain
    const models = yield* Models
    const q = yield* Effect.option(models.embed([query]))
    const vector = q._tag === "Some" && q.value.vectors[0] ? q.value.vectors[0] : null
    return yield* brain.read(similarRead, query, vector, k)
  })

// The write path.

const WRITER = `You keep the long-term memory of Switch, the user's personal agent. A lesson is proposed; you decide what, if anything, is kept, in Claude Code's memory-file format.

- Keep only what holds beyond the moment it came from: a rule or preference of the user's, a lasting fact about their world or about how Switch's own parts work, or a procedure that worked. Drop a one-off, or the state of a piece of work (what a task, order or build stands at).
- Generalize: when it's one case of a broader rule (one site, one tool, one person), write the broader rule with this case as its example.
- Merge: when a held memory (listed) says the same thing or this updates it, write the merged memory and list the ones it replaces. Reuse the held memory's id when it's one memory updated.
- Scope: "global" when it holds everywhere; a space's id when it holds only there (and in the spaces inside it).
- The gate's objections, if any, say what to fix.
- No em dashes (—): a comma, colon, period or parentheses instead.

The body: the lesson in a sentence or two, then a line "**Why:** ..." (why it holds, with who said it and when if known), then "**How to apply:** ..." (when and how to use it). Concise. The user's own words, when given, are kept with it as they are: never rewrite or paraphrase them, only write the lesson they teach.
"from_user": true when it's a rule, preference or fact the user stated, false when it's the agent's own lesson.
A trigger, only for a memory tied to an action (before deploying, before sending an email, before a purchase): the tool names it applies to (a trailing * matches any suffix; "Bash", "mcp__apps__*") and a few lowercase words, any of which in the call's input fires it. An extension's tool is "mcp__apps__*" with its name (app_tool) among the words. A lesson from a mistake in a call (the user corrected what it did, or it failed) and a go-ahead for a kind of call always get one, on that call: it's put in front of the next such call, before it runs. Words narrow it to that call; a trigger that fires on calls it doesn't bear on gets in the way.

Answer with JSON only: {"keep": true, "id": "kebab-case-name", "description": "one line, under 150 characters", "type": "user|feedback|project|reference", "scope": "global or a space id", "body": "...", "replaces": ["ids"], "trigger": {"tools": [], "words": []} or null, "from_user": false}, or {"keep": false, "why": "..."}.`

/**
 * A lesson of mine, which every turn where it holds reads whole, as Switchboard's turns read every
 * lesson it learned (core/context.rs:254-258, 271-274): its memory's name starts so, and its body
 * says when it was learned (a `Learned:` line), so a memory merely named lesson-… isn't one. The
 * writer keeps one for guidance of my own (type feedback) that isn't the user's rule.
 */
export const LESSON = "lesson-"

/** When a lesson was learned, as Switchboard wrote it ("%b %-d %H:%M", local). */
const learnedAt = (ms: number) => {
  const d = new Date(ms)
  const month = d.toLocaleString("en-US", { month: "short" })
  const hm = d.toLocaleString("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
  return `${month} ${d.getDate()} ${hm}`
}

/** A lesson's body as kept: the writer's, its old Learned and After lines out, then when it's learned. */
const lessonBody = (body: string, now: number) =>
  `${body
    .split("\n")
    .filter((l) => !l.startsWith("Learned: ") && !l.startsWith("After: "))
    .join("\n")
    .trim()}\n\nLearned: ${learnedAt(now)}`

/**
 * Guidance of my own, not the user's words, is a lesson: under its own name (a held memory it
 * updates is replaced by it), saying when it was learned.
 */
const shapeOf = (
  type: MemoryType,
  theirs: boolean,
  kept: Said | null,
  wanted: string,
  body: string,
) =>
  type === "feedback" && !theirs && kept === null
    ? {
        wanted: wanted.startsWith(LESSON) ? wanted : `${LESSON}${wanted}`,
        body: lessonBody(body, Date.now()),
      }
    : { wanted, body }

/** `wanted`, or with a number after it when another memory has it (one it replaces doesn't count). */
const freeId = (db: Database, wanted: string, replaces: readonly string[]) => {
  const taken = (x: string) => getMemory(db, x) !== null && !replaces.includes(x)
  const base = wanted === "" || wanted === LESSON ? `${wanted}memory` : wanted
  let out = base
  for (let n = 2; taken(out); n += 1) {
    out = `${base}-${n}`
  }
  return out
}

const kebab = (s: string) =>
  s
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 60)

const card = (m: Memory) =>
  `- ${m.id} (${m.type}, ${m.scope}): ${m.description}\n  ${[saidLine(m), m.body]
    .filter((x) => x !== "")
    .join("\n")
    .replaceAll("\n", "\n  ")}`

export interface Proposal {
  /** Where it came from: the space whose work taught it. */
  readonly space: SpaceId
  readonly lesson: string
  readonly why?: string
  readonly how?: string
  /** A turn there learned it as it worked: its chat shows a "Remembered" line. */
  readonly fromTurn?: boolean
  /** The user's exact words it rests on, as they said them. */
  readonly quote?: string
  /** The work that proposed it, whose latest message from the user it may come from. */
  readonly thread?: ThreadId | null
  /** Carried over from the user's earlier system: always kept, merged only with a duplicate. */
  readonly carried?: boolean
  /** Why a check that refused it is wrong this time (brain's bypass.ts); a secret is kept never. */
  readonly bypass?: string | undefined
}

export type Remembered =
  | {
      readonly kept: true
      readonly id: string
      readonly replaces: readonly string[]
      /** Set when a quote given isn't in any of their messages. */
      readonly unquoted?: string
    }
  | { readonly kept: false; readonly why: string }

const normal = (s: string) => s.replaceAll(/\s+/gu, " ").trim().toLowerCase()

interface Posted {
  readonly seq: number
  readonly time: number
  readonly space: SpaceId
  readonly text: string
}

/** The user's message holding `quote`, newest first, from `space` before others. */
export const quoted = (db: Database, quote: string, space: SpaceId) => {
  const want = normal(quote)
  if (want === "") {
    return null
  }
  const rows = db
    .query<Posted, []>(
      "SELECT seq, time, space, text FROM messages WHERE source NOT IN ('agent', 'peer') ORDER BY seq DESC LIMIT 5000",
    )
    .all()
    .filter((m) => normal(m.text).includes(want))
  return rows.find((m) => m.space === space) ?? rows[0] ?? null
}

/** The latest message from the user that a work's turns answered. */
const lastAsked = (db: Database, thread: ThreadId) => {
  const space = thread.startsWith("space:") ? thread.slice("space:".length) : null
  return space === null
    ? null
    : db
        .query<Posted, [string]>(
          "SELECT seq, time, space, text FROM messages WHERE space = ? AND source NOT IN ('agent', 'peer') ORDER BY seq DESC LIMIT 1",
        )
        .get(space)
}

const SAID_MAX = 600

/** The user's words as a memory keeps them, when they're found among their messages in `space`. */
export const saidFrom = (db: Database, words: string, space: SpaceId): Said | null => {
  const found = quoted(db, words, space)
  return found === null
    ? null
    : { text: words.slice(0, SAID_MAX), seq: found.seq, time: found.time, space: found.space }
}
const NOT_FOUND = "Not found in their messages: kept without it"

const given = (p: Proposal) => (p.quote ?? "").trim()

/** The message a proposal's words come from, and the words: the quote, else that message. */
const wordsOf = (db: Database, p: Proposal) => {
  if (given(p) !== "") {
    return { found: quoted(db, given(p), p.space), words: given(p) }
  }
  const found = p.thread === undefined || p.thread === null ? null : lastAsked(db, p.thread)
  return { found, words: (found?.text ?? "").trim() }
}

const withWords = (prompt: string, words: string, p: Proposal) =>
  words === ""
    ? prompt
    : `${prompt}\n\nThe user's words${given(p) === "" ? " (their latest message)" : ""}:\n${JSON.stringify(words.slice(0, SAID_MAX))}`

/** Their words are kept only when it's their rule, as they said them; a merge keeps what it replaces'. */
const saidOf = (
  db: Database,
  found: Posted | null,
  words: string,
  fromUser: boolean,
  replaces: readonly string[],
): Said | null => {
  if (found !== null && fromUser) {
    return { text: words.slice(0, SAID_MAX), seq: found.seq, time: found.time, space: found.space }
  }
  for (const r of replaces) {
    const was = getMemory(db, r)?.said
    if (was) {
      return was
    }
  }
  return null
}

const CARRIED = `This one is carried over from the user's earlier system, so it's kept, as it says: never {"keep": false}, and don't generalize it. Merge it only with a held memory that says the same thing.`

/** How far back the lesson gate looks for rules kept lately (monologue/src/memory.rs:232-234). */
const LATELY_MS = 3 * 86_400_000

/**
 * The rules and preferences kept in the last three days where this work is (everywhere's and its
 * space's), newest first, at most 20 (memory.rs:259-268 `kept_lately`). A lesson carried from
 * Switchboard (`LESSON`, its body naming Switchboard's memory) was kept when Switchboard learned it,
 * not now.
 */
const keptLately = (db: Database, space: SpaceId) =>
  db
    .query<Row, [number, string]>(
      `SELECT * FROM memories WHERE status = 'live' AND type IN ('feedback', 'user')
         AND written_at > ? AND (scope = 'global' OR scope = ?) AND name NOT LIKE 'wake-rule-%'
         AND NOT (name LIKE 'lesson-%' AND instr(body, char(10) || 'From Switchboard''s memory ') > 0)
       ORDER BY written_at DESC LIMIT 20`,
    )
    .all(Date.now() - LATELY_MS, space)
    .map(toMemory)

const keptLatelyRead = defineRead("autonomy/memory/kept-lately", keptLately)
const scopesRead = defineRead("autonomy/memory/scopes", (db, space: Scope) => scopesOf(db, space))
const wordsRead = defineRead("autonomy/memory/words", wordsOf)
const saidRead = defineRead("autonomy/memory/said", saidOf)
const freeIdRead = defineRead("autonomy/memory/free-id", freeId)

/**
 * The gate's read of a proposal; a carried one isn't read. It reads it against the memories held and,
 * apart from them, the rules and preferences kept lately, newest first, so a lesson that's one more
 * case of what they share shows as such (memory.rs:236-253 `held_context`, the lesson gate's `symptom`).
 */
const gated = (p: Proposal, proposed: string, held: readonly Memory[], lately: readonly Memory[]) =>
  p.carried === true
    ? Effect.succeed({
        pass: true,
        reasons: [],
        withheld: false,
        bypassed: false,
        decision: crypto.randomUUID(),
      } satisfies Verdict)
    : gate("memory", {
        key: `memory:${p.space}`,
        space: p.space,
        text: proposed,
        // Its em dashes are read in `remember`: the objections here go to the writer.
        own: [],
        bypass: p.bypass,
        work: p.thread ?? p.space,
        context: [
          `Memories already held:\n${
            held.length === 0
              ? "(none)"
              : held
                  .filter((m) => !lately.some((l) => l.id === m.id))
                  .map(card)
                  .join("\n")
          }`,
          `Rules and preferences kept in the last three days, newest first:\n${lately.length === 0 ? "(none)" : lately.map(card).join("\n")}`,
        ].join("\n\n"),
      })

/** What the writer kept, else for a carried one, the memory as it came; null when nothing is. */
const keptOf = (answered: unknown, p: Proposal, proposed: string) => {
  if (field(answered, "keep") === true && text(field(answered, "body")) !== "") {
    return answered
  }
  return p.carried === true
    ? { body: proposed, description: p.lesson.slice(0, 150), scope: p.space }
    : null
}

/** A proposal's em dashes, or the writer's (brain's dashes.ts); a carried one is as it came. */
const dashesIn = (p: Proposal, texts: readonly string[]) =>
  unlessBypassed(p.carried === true ? null : emDashRefusal(texts), bypassOf(p.bypass), {
    check: "memory",
    objections: ["dash"],
    work: p.thread ?? p.space,
    space: p.space,
  })

/** The gate's objections, for the writer, and why the agent says they're wrong this time. */
const objectionsFor = (verdict: Verdict, p: Proposal) => [
  verdict.reasons.length > 0
    ? `The gate's objections:\n${verdict.reasons.map((r) => `- ${r}`).join("\n")}`
    : "",
  verdict.bypassed ? `Why the agent says they're wrong this time: ${p.bypass ?? ""}` : "",
]

/** The one write path: gate, merge with what's held, generalize, keep. A carried one skips the gate. */
export const remember = (p: Proposal) =>
  Effect.gen(function* remembering() {
    const brain = yield* Brain
    const models = yield* Models
    const proposed = [
      p.lesson,
      p.why === undefined ? "" : `Why: ${p.why}`,
      p.how === undefined ? "" : `How to apply: ${p.how}`,
    ]
      .filter((s) => s !== "")
      .join("\n")
    const dashed = yield* dashesIn(p, [proposed])
    if (dashed !== null) {
      return { kept: false, why: `${dashed} ${BYPASS}` } satisfies Remembered
    }
    const held = yield* similar(proposed, 6)
    const lately = yield* brain.read(keptLatelyRead, p.space)
    const verdict = yield* gated(p, proposed, held, lately)
    if (verdict.withheld) {
      return { kept: false, why: "It holds a secret" } satisfies Remembered
    }
    const scopes = yield* brain.read(scopesRead, p.space)
    const prompt = [
      `Proposed, from space ${p.space}:\n${proposed}`,
      held.length > 0 ? `Held memories most like it:\n${held.map(card).join("\n")}` : "",
      ...objectionsFor(verdict, p),
      `Scopes it may take: ${scopes.join(", ")}`,
    ]
      .filter((s) => s !== "")
      .join("\n\n")
    const { found, words } = yield* brain.read(wordsRead, p)
    const writer = p.carried === true ? `${WRITER}\n${CARRIED}` : WRITER
    const done = yield* models.complete("gate", writer, withWords(prompt, words, p))
    const answered = jsonOf(done.text)
    const a = keptOf(answered, p, proposed)
    if (a === null) {
      return {
        kept: false,
        why: text(field(answered, "why")) || "Not general",
      } satisfies Remembered
    }
    const written = yield* dashesIn(p, [text(field(a, "description")), text(field(a, "body"))])
    if (written !== null) {
      return { kept: false, why: `As written: ${written} ${BYPASS}` } satisfies Remembered
    }
    const heldIds = new Set(held.map((m) => m.id))
    const wanted = kebab(text(field(a, "id")) || text(field(a, "description")))
    // A held memory's id, reused, is that memory updated.
    const replaces = [
      ...new Set([...strings(field(a, "replaces")), ...(heldIds.has(wanted) ? [wanted] : [])]),
    ].filter((x) => heldIds.has(x))
    const theirs = p.quote !== undefined || field(a, "from_user") === true
    const keptSaid = yield* brain.read(saidRead, found, words, theirs, replaces)
    const type = TYPES.find((t) => t === field(a, "type")) ?? "feedback"
    const shaped = shapeOf(type, theirs, keptSaid, wanted, text(field(a, "body")))
    const id = yield* brain.read(freeIdRead, shaped.wanted, replaces)
    const scope = scopes.find((s) => s === field(a, "scope")) ?? GLOBAL
    const t = field(a, "trigger")
    const tools = strings(field(t, "tools"))
    yield* Effect.orDie(
      brain.ingest([
        {
          id: EventId.make(`memory:${verdict.decision}`),
          type: MemoryWritten.type,
          source: "autonomy",
          payload: {
            id,
            name: id,
            description: text(field(a, "description")).slice(0, 200),
            type,
            scope,
            body: shaped.body,
            trigger:
              tools.length > 0
                ? { tools, words: strings(field(t, "words")).map((w) => w.toLowerCase()) }
                : null,
            replaces,
            decision: verdict.decision,
            ...(p.fromTurn === true && { space: p.space }),
            ...(keptSaid !== null && { said: keptSaid }),
          },
        },
      ]),
    )
    yield* Effect.ignore(embedMissing)
    return {
      kept: true,
      id,
      replaces,
      ...(p.quote !== undefined && found === null && { unquoted: NOT_FOUND }),
    } satisfies Remembered
  })

// Files: the live set as Claude Code memory files, one per memory, and a MEMORY.md index.

const quote = (s: string) => JSON.stringify(s)

export const toFile = (m: Memory) =>
  [
    "---",
    `name: ${m.id}`,
    `description: ${quote(m.description)}`,
    "metadata:",
    `  type: ${m.type}`,
    `  scope: ${m.scope}`,
    ...(m.said
      ? [
          `  said: ${quote(m.said.text)}`,
          `  said_at: ${new Date(m.said.time).toISOString()}`,
          `  said_seq: ${m.said.seq}`,
        ]
      : []),
    ...(m.trigger
      ? [
          `  tools: ${quote(m.trigger.tools.join(", "))}`,
          `  words: ${quote(m.trigger.words.join(", "))}`,
        ]
      : []),
    "---",
    "",
    m.body.trim(),
    "",
  ].join("\n")

/** Writes the live memories to `dir`, as Claude Code's memory folder. */
export const exportFiles = (db: Database, dir: string) => {
  mkdirSync(dir, { recursive: true })
  const live = liveMemories(db)
  for (const m of live) {
    writeFileSync(path.join(dir, `${m.id}.md`), toFile(m))
  }
  const index = live.map((m) => `- [${m.id}](${m.id}.md) — ${m.description}`)
  writeFileSync(path.join(dir, "MEMORY.md"), `${index.join("\n")}\n`)
  return live.length
}

const unquote = (s: string) => {
  const t = s.trim()
  if (t.startsWith('"')) {
    try {
      return String(JSON.parse(t))
    } catch {
      return t.slice(1, -1)
    }
  }
  return t
}

/** A Claude Code memory file read back; null when it isn't one. */
export const parseFile = (raw: string, fallbackScope: string) => {
  const m = /^---\n(?<head>[\s\S]*?)\n---\n?(?<body>[\s\S]*)$/u.exec(raw)
  if (!m) {
    return null
  }
  const head = new Map<string, string>()
  for (const line of (m.groups?.head ?? "").split("\n")) {
    const kv = /^\s*(?<key>[a-zA-Z_]+):\s*(?<value>.*)$/u.exec(line)
    const key = kv?.groups?.key
    const value = kv?.groups?.value
    if (key !== undefined && value !== undefined && value !== "") {
      head.set(key, unquote(value))
    }
  }
  const name = head.get("name")
  if (name === undefined) {
    return null
  }
  const list = (k: string) =>
    (head.get(k) ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "")
  const tools = list("tools")
  return {
    id: kebab(name),
    name: kebab(name),
    description: head.get("description") ?? "",
    type: TYPES.find((t) => t === head.get("type")) ?? "feedback",
    scope: head.get("scope") ?? fallbackScope,
    body: (m.groups?.body ?? "").trim(),
    trigger: tools.length > 0 ? { tools, words: list("words") } : null,
    replaces: [],
    decision: "",
  } satisfies typeof MemoryWritten.payload.Type
}

/** Reads a Claude Code memory folder into the brain as it is: they were kept once already. */
export const importFiles = (dir: string, scope: string = GLOBAL) =>
  Effect.gen(function* importing() {
    const brain = yield* Brain
    const parsed = readdirSync(dir)
      .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
      .flatMap((f) => parseFile(readFileSync(path.join(dir, f), "utf-8"), scope) ?? [])
    yield* Effect.orDie(
      brain.ingest(
        parsed.map((p) => ({
          id: EventId.make(`import:${p.scope}:${p.id}:${Bun.hash(p.body).toString(36)}`),
          type: MemoryWritten.type,
          source: "import",
          payload: p,
        })),
      ),
    )
    return parsed.length
  })
