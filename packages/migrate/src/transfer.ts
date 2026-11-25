// One brain's distilled memories into another that staged the same Switchboard memories, so the
// write path's work isn't done twice. `exportMemories` writes the write path's own events (memories
// written, gate decisions, core fields) in log order, and each staged memory's outcome keyed by its
// Switchboard id; `importMemories` ingests them under their own ids and marks the matching staged
// memories consumed. Both are idempotent: a rerun lands nothing new.
import { readFileSync, writeFileSync } from "node:fs"
import { Brain, defineRead, EventId } from "@switch/brain"
import type { Incoming } from "@switch/brain"
import { Effect, Schema } from "effect"

import { MemoryImported, MigrateDistilled } from "./events.ts"
import { chunks } from "./source.ts"

/** The write path's events: what it kept or merged, what it decided, and the cores. */
const WRITTEN = ["gate.decided", "memory.written", "memory.expired", "memory.core"]

const line = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("event"),
    id: Schema.String,
    type: Schema.String,
    source: Schema.String,
    time: Schema.Number,
    payload: Schema.Unknown,
  }),
  Schema.Struct({
    kind: Schema.Literal("distilled"),
    /** The staged event's id: `sb:<Switchboard memory id>`, the same in every brain. */
    staged: Schema.String,
    kept: Schema.NullOr(Schema.String),
    replaces: Schema.Array(Schema.String),
    why: Schema.NullOr(Schema.String),
  }),
])
type Line = typeof line.Type
type Distilled = Extract<Line, { kind: "distilled" }>
const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(line))

interface Row {
  readonly id: string
  readonly type: string
  readonly source: string
  readonly time: number
  readonly payload: string
}

const parseJson: (text: string) => unknown = JSON.parse

/** The write path's events, in log order, then each staged memory's outcome. */
const writtenRead = defineRead("migrate/transfer/written", (db) => {
  const events = db
    .query<Row, string[]>(
      `SELECT id, type, source, time, payload FROM events
       WHERE type IN (${WRITTEN.map(() => "?").join(", ")})
         AND (type != 'gate.decided' OR json_extract(payload, '$.exit') = 'memory')
       ORDER BY seq`,
    )
    .all(...WRITTEN)
    .map((r): Line => ({ kind: "event", ...r, payload: parseJson(r.payload) }))
  const outcomes = db
    .query<{ staged: string; payload: string }, [string, string]>(
      `SELECT s.id AS staged, d.payload FROM events d
       JOIN events s ON s.seq = json_extract(d.payload, '$.seq') AND s.type = ?2
       WHERE d.type = ?1 ORDER BY d.seq`,
    )
    .all(MigrateDistilled.type, MemoryImported.type)
    .map((r): Line => {
      const p = Schema.decodeUnknownSync(MigrateDistilled.payload)(parseJson(r.payload))
      return {
        kind: "distilled",
        staged: r.staged,
        kept: p.kept,
        replaces: p.replaces,
        why: p.why,
      }
    })
  return [...events, ...outcomes]
})

const countRead = defineRead(
  "migrate/transfer/count",
  (db) => db.query<{ n: number }, []>("SELECT count(*) AS n FROM events").get()?.n ?? 0,
)

/** Each outcome whose staged memory is here, with that memory's seq. */
const stagedRead = defineRead("migrate/transfer/staged", (db, outcomes: readonly Distilled[]) => {
  const seqOf = db.query<{ seq: number }, [string, string]>(
    "SELECT seq FROM events WHERE id = ? AND type = ?",
  )
  return outcomes.flatMap((o) => {
    const seq = seqOf.get(o.staged, MemoryImported.type)?.seq
    return seq === undefined ? [] : [{ ...o, seq }]
  })
})

export const exportMemories = (file: string) =>
  Effect.gen(function* exporting() {
    const brain = yield* Brain
    const lines = yield* brain.read(writtenRead)
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"))
    return lines.length
  })

export const importMemories = (file: string) =>
  Effect.gen(function* importing() {
    const brain = yield* Brain
    const lines = readFileSync(file, "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => decodeLine(l))
    const events: Incoming[] = lines.flatMap((l) =>
      l.kind === "event"
        ? [
            {
              id: EventId.make(l.id),
              type: l.type,
              source: l.source,
              time: l.time,
              payload: l.payload,
            },
          ]
        : [],
    )
    const before = yield* brain.read(countRead)
    for (const chunk of chunks(events, 1000)) {
      yield* brain.ingest(chunk)
    }
    // Each staged memory here that the other brain distilled: consumed, as distill marks one.
    const outcomes = lines.flatMap((l) => (l.kind === "distilled" ? [l] : []))
    const staged = yield* brain.read(stagedRead, outcomes)
    const marks: Incoming[] = staged.map((o) => {
      const p: typeof MigrateDistilled.payload.Type = {
        seq: o.seq,
        kept: o.kept,
        replaces: o.replaces,
        why: o.why,
      }
      return {
        id: EventId.make(`distilled:${o.seq}`),
        type: MigrateDistilled.type,
        source: "migrate",
        payload: p,
      }
    })
    for (const chunk of chunks(marks, 1000)) {
      yield* brain.ingest(chunk)
    }
    const after = yield* brain.read(countRead)
    return {
      lines: lines.length,
      matched: staged.length,
      outcomes: outcomes.length,
      written: after - before,
    }
  })
