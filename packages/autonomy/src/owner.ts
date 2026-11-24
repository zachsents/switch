// The work an extension's record belongs to: a job the agent started (a simulation, a build, a
// render, a print) reports on itself in records of its own, and those are its work's to hear,
// never the user's chat. The work that started it is the one whose call to that extension's tools
// was under way when the job's first record came.
import type { Database } from "bun:sqlite"
import { SpaceId, ThreadId } from "@switch/brain"
import type { StoredEvent } from "@switch/brain"
import { isJson, messageOf } from "switch-ext-kit"

/** How long a call can be under way and still be the one a job's first record came from. */
const UNDER_WAY_MS = 10 * 60_000
/** How far back a job's first record can be. */
const JOB_MS = 24 * 3600 * 1000
const SPACE = "space:"
const parse: (json: string) => unknown = JSON.parse

/** A record's ids: its entity and what it's about. */
const idsOf = (e: StoredEvent) => {
  if (!isJson(e.payload) || !isJson(e.payload.data)) {
    return []
  }
  const about: readonly unknown[] = Array.isArray(e.payload.about) ? e.payload.about : []
  return [...new Set([e.payload.data.entity, ...about].filter((x) => typeof x === "string"))]
}

const seqAt = (db: Database, time: number) =>
  db
    .query<{ seq: number }, [number]>(
      "SELECT seq FROM events WHERE time >= ? ORDER BY time LIMIT 1",
    )
    .get(time)?.seq ?? null

/** The first record of the same extension whose entity is `id`, within a day: a job is recent. */
const firstOf = (db: Database, source: string, id: string, now: number) => {
  const row = db
    .query<{ seq: number; time: number }, [string, string, number, string]>(
      `SELECT seq, time FROM events WHERE type >= ? AND type < ? AND seq >= ?
         AND json_extract(payload, '$.data.entity') = ? ORDER BY seq LIMIT 1`,
    )
    .get(`${source}.`, `${source}/`, seqAt(db, now - JOB_MS) ?? 0, id)
  return row ?? null
}

/** The work whose call to the extension's tools hadn't returned at `seq`. */
const underWay = (db: Database, source: string, seq: number, time: number) =>
  db
    .query<{ thread: string }, [number, number, string, number]>(
      `SELECT c.thread FROM thread_items c
       WHERE c.seq >= ? AND c.seq < ? AND c.thread NOT LIKE 'run-%'
         AND json_extract(c.body, '$.kind') = 'tool'
         AND json_extract(c.body, '$.input.name') LIKE ? ESCAPE '\\'
         AND NOT EXISTS (SELECT 1 FROM thread_items r WHERE r.thread = c.thread AND r.seq > c.seq
           AND r.seq < ? AND json_extract(r.body, '$.kind') = 'result'
           AND json_extract(r.body, '$.id') = json_extract(c.body, '$.id'))
       ORDER BY c.seq DESC LIMIT 1`,
    )
    .get(seqAt(db, time - UNDER_WAY_MS) ?? seq, seq, `${source.replaceAll("_", "\\_")}\\_%`, seq)
    ?.thread ?? null

// Each id's owner once read: a job's first record doesn't change. Cleared when it grows large.
const known = new Map<string, ThreadId | null>()
const KNOWN_MAX = 20_000

/** The work that started the job an extension's record is about, or null: a message is never a job's. */
export const ownerOf = (db: Database, e: StoredEvent): ThreadId | null => {
  const ids = idsOf(e)
  if (ids.length === 0 || messageOf(e.type, e.payload, e.time) !== null) {
    return null
  }
  if (known.size > KNOWN_MAX) {
    known.clear()
  }
  for (const id of ids) {
    let owner = known.get(id)
    if (owner === undefined) {
      const first = firstOf(db, e.source, id, e.time)
      const thread = first === null ? null : underWay(db, e.source, first.seq, first.time)
      owner = thread === null ? null : ThreadId.make(thread)
      known.set(id, owner)
    }
    if (owner !== null) {
      return owner
    }
  }
  return null
}

/**
 * The space a work is in: a space's own thread, the space its task is filed in (the tag on its
 * opening), or the space its task was started from.
 */
export const spaceOfWork = (db: Database, thread: ThreadId): SpaceId | null => {
  const parent = db.query<{ parent: string | null }, [string]>(
    "SELECT parent FROM threads WHERE thread = ?",
  )
  const filed = db.query<{ home: string | null }, [string]>(
    "SELECT home FROM thread_spaces WHERE thread = ?",
  )
  let at: string | null = thread
  for (let hops = 0; at !== null && hops < 8; hops += 1) {
    if (at.startsWith(SPACE)) {
      return SpaceId.make(at.slice(SPACE.length))
    }
    const home = filed.get(at)?.home ?? null
    if (home !== null) {
      return SpaceId.make(home)
    }
    at = parent.get(at)?.parent ?? null
  }
  return null
}

/** Its state when it gives one ("running", "failed"), else its summary. */
const said = (payload: unknown): unknown => {
  if (!isJson(payload) || !isJson(payload.data)) {
    return null
  }
  const { facts, summary } = payload.data
  return isJson(facts) && typeof facts.state === "string" ? facts.state : summary
}

/** Whether a record is in the state the last of its entity was: an ongoing one, said again. */
export const repeats = (db: Database, e: StoredEvent) => {
  const entity = isJson(e.payload) && isJson(e.payload.data) ? e.payload.data.entity : undefined
  if (typeof entity !== "string") {
    return false
  }
  const last = db
    .query<{ payload: string }, [string, number, string]>(
      `SELECT payload FROM events WHERE type = ? AND seq < ?
         AND json_extract(payload, '$.data.entity') = ? ORDER BY seq DESC LIMIT 1`,
    )
    .get(e.type, e.seq, entity)
  return last !== null && said(parse(last.payload)) === said(e.payload)
}
