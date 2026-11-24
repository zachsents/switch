// What the system and memory pages read, and the lines they add to a space: the memories held,
// spend and recent turns, what each Mac lets its extensions do, the brain's own counts; a
// "Remembered" line in the chat of the space whose work taught it; and the Live Activities running
// in a space.
import type { Database } from "bun:sqlite"
import { liveMemories, MemoryForgotten, MemoryWritten, SettingSet } from "@switch/autonomy"
import { on } from "@switch/brain"
import type { Projection, SpaceId } from "@switch/brain"
import { Activity } from "@switch/gateway"

const DAY = 86_400_000
/** Days of spend shown. */
const DAYS = 14
const TURNS = 40
/** An activity nothing has said anything about for this long is gone. */
const STALE = DAY

// A memory the agent learned from a space's work, or a dial it moved there, as a line in that
// space's chat. Undone, it goes.
export const learned: Projection = {
  name: "learned",
  version: 2,
  tables: ["learned"],
  create: `
    CREATE TABLE learned (seq INTEGER PRIMARY KEY, time INTEGER NOT NULL, space TEXT NOT NULL,
      memory TEXT NOT NULL, text TEXT NOT NULL, replaces TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX learned_space ON learned (space, seq);
    CREATE INDEX learned_memory ON learned (memory);`,
  on: [
    on(MemoryWritten, (db, p, e) => {
      // Only what a turn learned as it worked has a space; distilling and reflection don't.
      if (p.space !== undefined && p.decision !== "") {
        db.query(
          "INSERT OR IGNORE INTO learned (seq, time, space, memory, text, replaces) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(e.seq, e.time, p.space, p.id, p.description, JSON.stringify(p.replaces))
      }
    }),
    on(SettingSet, (db, p, e) => {
      if (p.space !== undefined) {
        db.query(
          "INSERT OR IGNORE INTO learned (seq, time, space, memory, text, replaces) VALUES (?, ?, ?, ?, ?, '[]')",
        ).run(e.seq, e.time, p.space, p.id, p.description)
      }
    }),
    on(MemoryForgotten, (db, p) => {
      db.query("UPDATE learned SET undone = 1 WHERE memory = ?").run(p.id)
    }),
  ],
  snapshot: () => null,
}

/** A space's "Remembered" lines with seq in [from, before). */
export const learnedLines = (db: Database, space: SpaceId, from: number, before: number) =>
  db
    .query<
      { seq: number; time: number; memory: string; text: string; replaces: string },
      [string, number, number]
    >(
      "SELECT seq, time, memory, text, replaces FROM learned WHERE space = ? AND undone = 0 AND seq >= ? AND seq < ?",
    )
    .all(space, from, before)
    .map((r) => ({
      seq: r.seq,
      time: r.time,
      text: r.text,
      memory: r.memory,
      restore: parseStrings(r.replaces),
    }))

const parseStrings = (json: string): string[] => {
  const v: unknown = JSON.parse(json)
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []
}

// Live Activities as the board's Running shows them: the latest of each, until it ends.
export const activities: Projection = {
  name: "activities",
  version: 1,
  tables: ["activities"],
  create: `CREATE TABLE activities (id TEXT PRIMARY KEY, space TEXT NOT NULL, body TEXT NOT NULL,
    time INTEGER NOT NULL);`,
  on: [
    on(Activity, (db, p, e) => {
      if (p.phase === "end") {
        db.query("DELETE FROM activities WHERE id = ?").run(p.id)
        return
      }
      db.query("INSERT OR REPLACE INTO activities (id, space, body, time) VALUES (?, ?, ?, ?)").run(
        p.id,
        p.space,
        JSON.stringify(p),
        e.time,
      )
    }),
  ],
  snapshot: () => null,
}

export const runningActivities = (db: Database) =>
  db
    .query<{ body: string }, [number]>("SELECT body FROM activities WHERE time > ? ORDER BY time")
    .all(Date.now() - STALE)
    .map((r): unknown => JSON.parse(r.body))

/** Every live memory, for the memory page. */
export const memoriesPage = (db: Database) =>
  liveMemories(db).map((m) => ({
    id: m.id,
    description: m.description,
    type: m.type,
    scope: m.scope,
    body: m.body,
    triggered: m.trigger !== null,
    uses: m.uses,
  }))

interface TurnRow {
  readonly time: number
  readonly ended: string
  readonly started: string | null
  readonly title: string | null
  readonly tier: string | null
}

const parse = (json: string | null): Record<string, unknown> => {
  if (json === null) {
    return {}
  }
  const v: unknown = JSON.parse(json)
  return typeof v === "object" && v !== null && !Array.isArray(v) ? { ...v } : {}
}

const text = (v: unknown) => (typeof v === "string" ? v : "")
const num = (v: unknown) => (typeof v === "number" ? v : 0)

const recentTurns = (db: Database) =>
  db
    .query<TurnRow, [number]>(
      `SELECT e.time, e.payload AS ended, s.payload AS started, t.title, t.model AS tier
         FROM events e
         LEFT JOIN events s ON s.id = json_extract(e.payload, '$.turn') || ':start'
         LEFT JOIN threads t ON t.thread = json_extract(e.payload, '$.thread')
        WHERE e.type = 'turn.ended' ORDER BY e.seq DESC LIMIT ?`,
    )
    .all(TURNS)
    .map((r) => {
      const ended = parse(r.ended)
      const started = parse(r.started)
      return {
        time: r.time,
        thread: text(ended.thread),
        title: r.title ?? "",
        status: text(ended.status),
        model: text(started.model) || (r.tier ?? ""),
        effort: text(started.effort),
        cost: num(ended.costUsd),
        ms: num(ended.ms),
        host: text(started.host),
      }
    })

const spend = (db: Database) =>
  db
    .query<{ day: string; cost: number; turns: number }, [number]>(
      `SELECT date(time / 1000, 'unixepoch', 'localtime') AS day,
              sum(json_extract(payload, '$.costUsd')) AS cost, count(*) AS turns
         FROM events WHERE type = 'turn.ended' AND time > ? GROUP BY day ORDER BY day DESC`,
    )
    .all(Date.now() - DAYS * DAY)

// An extension says what a machine lets it do with a `<extension>.permissions` event: the machine
// and a boolean per permission. The latest per machine.
const permissions = (db: Database) =>
  db
    .query<{ time: number; payload: string }, []>(
      `SELECT time, payload FROM events WHERE seq IN (
         SELECT max(seq) FROM events WHERE type GLOB '*.permissions'
          GROUP BY type, json_extract(payload, '$.machine'))`,
    )
    .all()
    .map((r) => {
      const p = parse(r.payload)
      return {
        machine: text(p.machine),
        time: r.time,
        granted: Object.entries(p)
          .filter((x): x is [string, boolean] => typeof x[1] === "boolean")
          .map(([name, granted]) => ({ name, on: granted })),
      }
    })

const count = (db: Database, sql: string) => db.query<{ n: number }, []>(sql).get()?.n ?? 0

const debug = (db: Database) => ({
  seq: count(db, "SELECT max(seq) AS n FROM events"),
  bytes: count(
    db,
    "SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()",
  ),
  projections: db
    .query<{ name: string; version: number }, []>(
      "SELECT name, version FROM projections ORDER BY name",
    )
    .all(),
  types: db
    .query<{ type: string; n: number }, [number]>(
      "SELECT type, count(*) AS n FROM events INDEXED BY events_time_type WHERE time > ? GROUP BY type ORDER BY n DESC LIMIT 12",
    )
    .all(Date.now() - DAY),
})

/** The system page. */
export const systemPage = (db: Database) => ({
  spend: spend(db),
  turns: recentTurns(db),
  permissions: permissions(db),
  debug: debug(db),
})

export const systemConfig = {
  events: [],
  projections: [learned, activities],
  commands: [],
}
