// Leads: patterns or problems a reflection noticed, kept so one that keeps coming up gets acted on in
// time and one noticed again confirms the lead rather than starting its work again. A lead acts
// once (a task: Fix, Grow or Learn) or asks once (a "Find out" question to the user), never both.
import type { Database } from "bun:sqlite"
import { defineEvent, on } from "@switch/brain"
import type { Projection } from "@switch/brain"
import { Schema } from "effect"

export const LEAD_KINDS = ["grow", "fix", "learn"] as const
export type LeadKind = (typeof LEAD_KINDS)[number]

export const LeadNoted = defineEvent(
  "lead.noted",
  1,
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    kind: Schema.Literals(LEAD_KINDS),
    /** What shows it, in a sentence. */
    text: Schema.String,
  }),
)

/** What came of it: a task started, or a question put to the user. */
export const LeadTaken = defineEvent(
  "lead.taken",
  1,
  Schema.Struct({
    id: Schema.String,
    how: Schema.Literals(["task", "ask"]),
    /** The task's thread, or the question's space. */
    ref: Schema.String,
  }),
)

export interface Lead {
  readonly id: string
  readonly name: string
  readonly kind: LeadKind
  readonly text: string
  readonly seen: number
  readonly lastAt: number
  readonly taken: "task" | "ask" | null
  readonly ref: string | null
}

interface Row {
  readonly id: string
  readonly name: string
  readonly kind: LeadKind
  readonly text: string
  readonly seen: number
  readonly last_at: number
  readonly taken: "task" | "ask" | null
  readonly ref: string | null
}

const toLead = (r: Row): Lead => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  text: r.text,
  seen: r.seen,
  lastAt: r.last_at,
  taken: r.taken,
  ref: r.ref,
})

export const leads: Projection = {
  name: "leads",
  version: 1,
  tables: ["leads"],
  create: `
    CREATE TABLE leads (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
      text TEXT NOT NULL, seen INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
      taken TEXT, ref TEXT);`,
  on: [
    on(LeadNoted, (db, p, e) => {
      db.query(
        `INSERT INTO leads (id, name, kind, text, seen, first_at, last_at) VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET text = excluded.text, seen = seen + 1, last_at = excluded.last_at`,
      ).run(p.id, p.name, p.kind, p.text, e.time, e.time)
    }),
    on(LeadTaken, (db, p) => {
      db.query("UPDATE leads SET taken = ?, ref = ? WHERE id = ? AND taken IS NULL").run(
        p.how,
        p.ref,
        p.id,
      )
    }),
  ],
  snapshot: () => null,
  sources: [
    {
      name: "leads",
      description:
        "What reflection noticed: id, name, kind (grow, fix, learn), text, seen (times noticed), last_at, taken (task or ask, once acted on), ref (its task or question's space).",
      select: "SELECT id, name, kind, text, seen, last_at, taken, ref, rowid AS n FROM leads",
      columns: ["id", "name", "kind", "text", "seen", "last_at", "taken", "ref", "n"],
      time: "last_at",
      order: "n",
      depends: ["lead."],
    },
  ],
}

export const leadsConfig = { events: [LeadNoted, LeadTaken], projections: [leads], commands: [] }

/** The leads held, most recently seen first. */
export const heldLeads = (db: Database, limit = 30) =>
  db
    .query<Row, [number]>("SELECT * FROM leads ORDER BY last_at DESC LIMIT ?")
    .all(limit)
    .map(toLead)

export const getLead = (db: Database, id: string) => {
  const row = db.query<Row, [string]>("SELECT * FROM leads WHERE id = ?").get(id)
  return row ? toLead(row) : null
}
