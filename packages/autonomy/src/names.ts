// The names a wait or a wake rule gives, looked up before it's set. A watch on a name that never
// occurs sits silently until its deadline: an agent watched for a text reply under two types while
// texts are recorded under a third. The user, Nov 22: "id maybe just warn in case its intentional,
// allowing it to submit again with some kind of "i'm sure, skip warnings" flag", which is `bypass`
// now, as every check's (brain's bypass.ts). Unknown is an event
// type nothing records or declares, a source or field there isn't, a payload path its type's records
// don't carry, a stream or kind never recorded.
import type { Database } from "bun:sqlite"
import { Brain, BYPASS } from "@switch/brain"
import type { Query, QuerySource } from "@switch/brain"
import { Effect } from "effect"

import { globbed } from "./triage.ts"

/** Relayed from old Switchboard (senses.ts): none arrive any more, so they don't make a name live. */
const RELAYED = "sb:*"
/** A type's newest records are what its records look like. */
const NEWEST = 1000
/** Per type, the newest records read for the streams and kinds it records. */
const SAMPLE = 300
const CLOSEST = 5
const TYPE_OPS = new Set(["==", "in", "startsWith"])

/** What a script fires (`switch event <event>`), as scripts.ts records it. */
const FIRES = /switch\s+event\s+["']?(?<name>[\w.:/-]+)/gu

/** The names the scripts set (scripts_set) declare: their names, events and streams. */
const scriptNames = (db: Database) => {
  const types = new Set<string>()
  const streams = new Set<string>()
  for (const s of db
    .query<{ name: string; run: string }, []>(
      "SELECT name, run FROM scripts WHERE status != 'retired'",
    )
    .all()) {
    types.add(s.name)
    streams.add(`scripts/${s.name}`)
    for (const m of s.run.matchAll(FIRES)) {
      types.add(m.groups?.name ?? "")
    }
  }
  return { types, streams }
}

// Each type's first entry in the type index, from the one before: a seek per type. `GROUP BY type`
// read the whole index, 1.5M entries: 1 s on the core's thread warm, 18 s cold (Nov 23).
const recordedTypes = (db: Database) =>
  db
    .query<{ type: string }, []>(
      `WITH RECURSIVE t(type) AS (
         SELECT min(type) FROM events
         UNION ALL SELECT (SELECT min(type) FROM events WHERE type > t.type) FROM t WHERE t.type IS NOT NULL)
       SELECT type FROM t WHERE type IS NOT NULL`,
    )
    .all()
    .map((r) => r.type)

/** Whether Switch itself has recorded `type` lately: not only relayed. */
const live = (db: Database, type: string) =>
  db
    .query(
      `SELECT 1 FROM (SELECT source FROM events WHERE type = ? ORDER BY seq DESC LIMIT ${NEWEST})
       WHERE source NOT GLOB '${RELAYED}' LIMIT 1`,
    )
    .get(type) !== null

const quote = (segment: string) =>
  /^[A-Za-z_][A-Za-z0-9_]*$/u.test(segment) ? segment : `"${segment.replaceAll('"', '\\"')}"`

/** Whether a path into the payload (`data.facts.from`) is on any of `types`' newest records. */
const carried = (db: Database, types: readonly string[], path: readonly string[]) =>
  types.some(
    (type) =>
      db
        .query(
          `SELECT 1 FROM (SELECT payload FROM events WHERE type = ? AND source NOT GLOB '${RELAYED}'
             ORDER BY seq DESC LIMIT ${NEWEST}) WHERE json_extract(payload, ?) IS NOT NULL LIMIT 1`,
        )
        .get(type, `$.${path.map(quote).join(".")}`) !== null,
  )

interface Recorded {
  readonly type: string
  readonly stream: string | null
  readonly kind: string | null
}

/** The streams and kinds each live type records, from its newest records. */
const recordsOf = (db: Database, types: readonly string[]) => {
  const read = db.query<Recorded, [string]>(
    `SELECT DISTINCT type, json_extract(payload, '$.stream') AS stream,
       json_extract(payload, '$.kind') AS kind
     FROM (SELECT type, payload FROM events WHERE type = ? AND source NOT GLOB '${RELAYED}'
       ORDER BY seq DESC LIMIT ${SAMPLE})`,
  )
  return types.flatMap((t) => read.all(t))
}

const tokens = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length > 0)

const distance = (a: string, b: string) => {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i]
    for (let j = 1; j <= b.length; j += 1) {
      next.push(
        Math.min(
          (row[j] ?? 0) + 1,
          (next[j - 1] ?? 0) + 1,
          (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
        ),
      )
    }
    row = next
  }
  return row[b.length] ?? 0
}

/**
 * The real names nearest `name`: most words shared (`text` and `texts` alike), then fewest edits; a
 * name sharing none only when it's a few edits off.
 */
const closest = (name: string, real: Iterable<string>, first: readonly string[] = []) => {
  const want = tokens(name)
  const shared = (other: string) =>
    tokens(other).filter((t) =>
      want.some((w) => Math.min(w.length, t.length) >= 4 && (w.startsWith(t) || t.startsWith(w))),
    ).length
  const ranked = [...new Set(real)]
    .filter((r) => r !== name && !first.includes(r))
    .map((r) => ({ r, shared: shared(r), edits: distance(name, r) }))
    .filter((x) => x.shared > 0 || x.edits <= Math.max(2, name.length / 3))
    .toSorted((a, b) => b.shared - a.shared || a.edits - b.edits)
    .map((x) => x.r)
  return [...first, ...ranked].slice(0, CLOSEST)
}

const unknown = (what: string, near: readonly string[]) =>
  near.length === 0 ? what : `${what} (closest: ${near.join(", ")})`

/** A query's fields: its conditions', its `latest`, its `fields`. */
const fieldsOf = (q: Query) => [
  ...(q.where ?? []).map((c) => c.field),
  ...(q.having ?? []).map((c) => c.field),
  ...(q.latest === undefined ? [] : [q.latest]),
  ...(q.fields ?? []),
]

const strings = (v: unknown): string[] => {
  if (typeof v === "string") {
    return [v]
  }
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []
}

/** The values a query's conditions on `field` name with `==` or `in`. */
const named = (q: Query, field: string) =>
  (q.where ?? [])
    .filter((c) => c.field === field && (c.op === "==" || c.op === "in"))
    .flatMap((c) => strings(c.value))

/** A source the query names that isn't, or fields its source hasn't. */
const sourceUnknowns = (sources: readonly QuerySource[], q: Query) => {
  const name = q.from ?? "events"
  const source = sources.find((s) => s.name === name)
  if (source === undefined) {
    const near = closest(
      name,
      sources.map((s) => s.name),
    )
    return { source, out: [unknown(`No source ${name}`, near)] }
  }
  const out = fieldsOf(q)
    .map((f) => f.split(".")[0] ?? "")
    .filter((head) => !source.columns.includes(head))
    .map((head) => unknown(`${name} has no field ${head}`, closest(head, source.columns)))
  return { source, out }
}

/** The types a condition on `type` finds among `real`. */
const typesFound = (op: string, given: string, real: ReadonlySet<string>) => {
  if (op === "startsWith") {
    return [...real].filter((r) => r.startsWith(given))
  }
  return real.has(given) ? [given] : []
}

/** Paths into the payload no record of `types` carries; one `exists: false` wants absent is fine. */
const pathUnknowns = (db: Database, q: Query, types: readonly string[]) =>
  types.length === 0
    ? []
    : [...(q.where ?? []), ...(q.having ?? [])]
        .filter((c) => {
          const [head, ...path] = c.field.split(".")
          return (
            head === "payload" &&
            path.length > 0 &&
            !(c.op === "exists" && c.value === false) &&
            !carried(db, types, path)
          )
        })
        .map((c) => `No ${types.join(" or ")} record has ${c.field}`)

/** What's unknown in `q`, each with the closest real names. */
const queryUnknowns = (
  db: Database,
  sources: readonly QuerySource[],
  declared: ReadonlySet<string>,
  q: Query,
) => {
  const { source, out } = sourceUnknowns(sources, q)
  if (source?.name !== "events") {
    return out
  }
  const scripts = scriptNames(db)
  const liveTypes = recordedTypes(db).filter(
    (t) => declared.has(t) || scripts.types.has(t) || live(db, t),
  )
  const real = new Set([...declared, ...scripts.types, ...liveTypes])
  // Types that carry the streams the query names come first: where those records are.
  const streams = named(q, "payload.stream")
  const carrying = new Set(
    streams.length === 0
      ? []
      : recordsOf(db, liveTypes)
          .filter((r) => r.stream !== null && streams.includes(r.stream))
          .map((r) => r.type),
  )
  const types: string[] = []
  for (const c of q.where ?? []) {
    const given = c.field === "type" && TYPE_OPS.has(c.op) ? strings(c.value) : []
    for (const t of given) {
      const found = typesFound(c.op, t, real)
      if (found.length === 0) {
        const near = closest(
          t,
          real,
          [...carrying].filter((x) => x !== t),
        )
        out.push(unknown(`Nothing records or declares the event type ${t}`, near))
      }
      types.push(...found)
    }
  }
  // A path into the payload, on the types it names that have been recorded.
  return [
    ...out,
    ...pathUnknowns(
      db,
      q,
      types.filter((t) => liveTypes.includes(t)),
    ),
  ]
}

const advice = (found: readonly string[]) => `Not set. ${found.join(". ")}. ${BYPASS}`

/** A warning for the names in `queries` nothing knows, or null when every one is known. */
export const queryWarning = (queries: readonly (Query | undefined)[]) =>
  Effect.gen(function* warning() {
    const brain = yield* Brain
    const declared = new Set(yield* brain.types)
    const found = yield* brain.read((db) =>
      queries.flatMap((q) =>
        q === undefined ? [] : queryUnknowns(db, brain.sources, declared, q),
      ),
    )
    return found.length === 0 ? null : advice([...new Set(found)])
  })

/** A warning for the streams and kinds of a wake rule's that are never recorded, or null. */
export const wakesWarning = (streams: readonly string[], kinds: readonly string[]) =>
  Effect.gen(function* warning() {
    const brain = yield* Brain
    const declared = new Set(yield* brain.types)
    const found = yield* brain.read((db) => {
      const scripts = scriptNames(db)
      const liveTypes = recordedTypes(db).filter((t) => declared.has(t) || live(db, t))
      const records = recordsOf(db, liveTypes)
      const realStreams = new Set([
        ...scripts.streams,
        ...records.flatMap((r) => (r.stream === null ? [] : [r.stream])),
      ])
      const realKinds = new Set(records.flatMap((r) => (r.kind === null ? [] : [r.kind])))
      return [
        ...streams
          .filter((p) => ![...realStreams].some((s) => globbed(p, s)))
          .map((p) => unknown(`No stream ${p} is recorded`, closest(p, realStreams))),
        ...kinds
          .filter((k) => !realKinds.has(k))
          .map((k) => unknown(`No kind ${k} is recorded`, closest(k, realKinds))),
      ]
    })
    return found.length === 0 ? null : advice(found)
  })
