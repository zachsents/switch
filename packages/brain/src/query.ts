// A small structured query over the brain: a source (the log, or a projection's read model), then
// conditions, the newest row per key, and conditions on those. No language to parse: agents,
// extensions and expectations all give the same JSON. Live queries run again when an event that can
// change their rows lands, and each minute when they look back from now.
import type { Database } from "bun:sqlite"
import { Schema } from "effect"

import { Rejected } from "./defs.ts"

/** Something to query: a SELECT and what its rows hold. */
export interface QuerySource {
  readonly name: string
  readonly description: string
  /** A SELECT whose columns are `columns`. */
  readonly select: string
  readonly columns: readonly string[]
  /** Columns holding JSON, which a dotted field reads into (`payload.status`). */
  readonly json?: readonly string[]
  /** Its time column (ms), for `since`. */
  readonly time?: string
  /** What newest-first sorts by. */
  readonly order: string
  /** Event types, or their prefixes, that can change its rows. */
  readonly depends: readonly string[]
}

export const OPS = [
  "==",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "contains",
  "startsWith",
  "in",
  "exists",
] as const

export const Condition = Schema.Struct({
  /** A column, or a path into a JSON one: `payload.data.facts.state`. */
  field: Schema.String,
  op: Schema.Literals(OPS),
  /** A list for `in`; true or false for `exists`. */
  value: Schema.optionalKey(Schema.Unknown),
})
export type Condition = typeof Condition.Type

export const Query = Schema.Struct({
  /** A source's name; the log ("events") when left out. */
  from: Schema.optionalKey(Schema.String),
  where: Schema.optionalKey(Schema.Array(Condition)),
  /** Only rows from the last this many minutes. */
  since: Schema.optionalKey(Schema.Finite),
  /** Keep the newest row per this field, then apply `having`. */
  latest: Schema.optionalKey(Schema.String),
  having: Schema.optionalKey(Schema.Array(Condition)),
  /** Fields to return; all when left out. */
  fields: Schema.optionalKey(Schema.Array(Schema.String)),
  oldest: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Finite),
})
export type Query = typeof Query.Type

export interface Found {
  readonly rows: readonly Record<string, unknown>[]
}

export const EVENTS: QuerySource = {
  name: "events",
  description:
    "The log: seq, id, time, type, source, payload. Narrow it by type, seq, id, time or since.",
  select: "SELECT seq, id, time, type, source, payload FROM events",
  columns: ["seq", "id", "time", "type", "source", "payload"],
  json: ["payload"],
  time: "time",
  order: "seq",
  depends: [],
}

const LIMIT = 50
const MAX = 500
/** Columns of the log its indexes answer, one of which a query over it must narrow. */
const NARROW = new Set(["seq", "id", "type", "time"])
/** What an index can't answer: one of these on a narrow column still reads the whole log. */
const WIDE = new Set<string>(["!=", "contains", "exists"])

type Arg = string | number | null

interface Sql {
  readonly sql: string
  readonly args: readonly Arg[]
}

const fail = (reason: string) => new Rejected({ reason })

const quote = (segment: string) =>
  /^[A-Za-z_][A-Za-z0-9_]*$/u.test(segment) ? segment : `"${segment.replaceAll('"', '\\"')}"`

const isJson = (source: QuerySource, column: string) => source.json?.includes(column) === true

/** The SQL a field reads, or what's wrong with it. */
const fieldSql = (source: QuerySource, field: string): string | Rejected => {
  const [head = "", ...rest] = field.split(".")
  if (!source.columns.includes(head)) {
    return fail(`${source.name} has no column ${head}; it has ${source.columns.join(", ")}`)
  }
  if (rest.length === 0) {
    return `r.${head}`
  }
  if (!isJson(source, head)) {
    return fail(`${source.name}.${head} isn't JSON, so ${field} can't read into it`)
  }
  return `json_extract(r.${head}, '$.${rest.map(quote).join(".")}')`
}

const bind = (v: unknown): Arg | Rejected => {
  if (v === null || typeof v === "string" || typeof v === "number") {
    return v
  }
  if (typeof v === "boolean") {
    return v ? 1 : 0
  }
  return fail(`Can't compare with ${JSON.stringify(v)}`)
}

const textOf = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v ?? ""))

const inSql = (f: string, c: Condition): Sql | Rejected => {
  if (!Array.isArray(c.value) || c.value.length === 0) {
    return fail(`${c.field} in: give a list`)
  }
  const args: Arg[] = []
  for (const v of c.value) {
    const a = bind(v)
    if (a instanceof Rejected) {
      return a
    }
    args.push(a)
  }
  return { sql: `${f} IN (${args.map(() => "?").join(", ")})`, args }
}

const startsSql = (f: string, c: Condition): Sql => {
  const p = textOf(c.value)
  // A range, so an index on a plain column answers it.
  return c.field.includes(".")
    ? { sql: `substr(${f}, 1, length(?)) = ?`, args: [p, p] }
    : { sql: `(${f} >= ? AND ${f} < ?)`, args: [p, `${p}\uFFFF`] }
}

const compareSql = (f: string, c: Condition): Sql | Rejected => {
  const a = bind(c.value ?? null)
  if (a instanceof Rejected) {
    return a
  }
  if (c.op === "==") {
    return { sql: `${f} IS ?`, args: [a] }
  }
  return c.op === "!=" ? { sql: `${f} IS NOT ?`, args: [a] } : { sql: `${f} ${c.op} ?`, args: [a] }
}

const conditionSql = (source: QuerySource, c: Condition): Sql | Rejected => {
  const f = fieldSql(source, c.field)
  if (f instanceof Rejected) {
    return f
  }
  switch (c.op) {
    case "exists": {
      return { sql: `${f} IS ${c.value === false ? "" : "NOT "}NULL`, args: [] }
    }
    case "in": {
      return inSql(f, c)
    }
    case "contains": {
      return { sql: `instr(lower(${f}), lower(?)) > 0`, args: [textOf(c.value)] }
    }
    case "startsWith": {
      return startsSql(f, c)
    }
    case "==":
    case "!=":
    case ">":
    case ">=":
    case "<":
    case "<=": {
      return compareSql(f, c)
    }
    default: {
      return c.op satisfies never
    }
  }
}

const all = (source: QuerySource, list: readonly Condition[]) => {
  const sql: string[] = []
  const args: Arg[] = []
  for (const c of list) {
    const one = conditionSql(source, c)
    if (one instanceof Rejected) {
      return one
    }
    sql.push(one.sql)
    args.push(...one.args)
  }
  return { sql, args }
}

const parse: (json: string) => unknown = JSON.parse

const decodeRow = (source: QuerySource, row: Record<string, unknown>) => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === "string" && isJson(source, k) ? parse(v) : v
  }
  return out
}

export const sourceOf = (sources: readonly QuerySource[], q: Query) => {
  const name = q.from ?? "events"
  return (
    sources.find((s) => s.name === name) ??
    fail(`No source ${name}; there are ${sources.map((s) => s.name).join(", ")}`)
  )
}

/** The earliest time a query of the log asks for, from `since` or a lower bound on `time`. */
const earliest = (q: Query, now: number) => {
  const times = (q.where ?? []).flatMap((c) =>
    c.field === "time" &&
    (c.op === ">=" || c.op === ">" || c.op === "==") &&
    typeof c.value === "number"
      ? [c.value]
      : [],
  )
  if (q.since !== undefined) {
    times.push(now - q.since * 60_000)
  }
  return times.length > 0 ? Math.max(...times) : null
}

/** Its filtered rows: the conditions, and `since`. */
const filteredSql = (source: QuerySource, q: Query, now: number): Sql | Rejected => {
  const where = all(source, q.where ?? [])
  if (where instanceof Rejected) {
    return where
  }
  if (q.since !== undefined) {
    if (source.time === undefined) {
      return fail(`${source.name} has no time to go back on`)
    }
    where.sql.push(`r.${source.time} >= ?`)
    where.args.push(now - q.since * 60_000)
  }
  const narrowed = (q.where ?? []).some((c) => NARROW.has(c.field) && !WIDE.has(c.op))
  if (source === EVENTS && q.since === undefined && !narrowed) {
    return fail("The log is big: narrow it with type, seq, id, time or since")
  }
  // A time on the log bounds its seqs too, through the time index: newest first, SQLite otherwise
  // walks the log back from its head and past the time, to its first event when too few match.
  const from = source === EVENTS ? earliest(q, now) : null
  if (from !== null) {
    where.sql.push(
      `r.seq >= (SELECT coalesce(min(seq), ${Number.MAX_SAFE_INTEGER}) FROM events INDEXED BY events_time WHERE time >= ?)`,
    )
    where.args.push(from)
  }
  const clause = where.sql.length > 0 ? ` WHERE ${where.sql.join(" AND ")}` : ""
  return { sql: `SELECT * FROM (${source.select}) AS r${clause}`, args: where.args }
}

/** The newest row per key, then `having` on those. */
const latestSql = (source: QuerySource, q: Query, filtered: Sql): Sql | Rejected => {
  if (q.latest === undefined) {
    return (q.having ?? []).length > 0 ? fail("having goes with latest") : filtered
  }
  const key = fieldSql(source, q.latest)
  if (key instanceof Rejected) {
    return key
  }
  const having = all(source, q.having ?? [])
  if (having instanceof Rejected) {
    return having
  }
  const newest = `r.${source.order} IN (SELECT max(r.${source.order}) FROM f AS r GROUP BY ${key})`
  return {
    sql: `WITH f AS (${filtered.sql}) SELECT * FROM f AS r WHERE ${[newest, ...having.sql].join(" AND ")}`,
    args: [...filtered.args, ...having.args],
  }
}

const columnsSql = (source: QuerySource, fields: readonly string[]) => {
  const picked: string[] = []
  for (const f of fields) {
    const s = fieldSql(source, f)
    if (s instanceof Rejected) {
      return s
    }
    picked.push(`${s} AS "${f.replaceAll('"', "")}"`)
  }
  return picked.length > 0 ? picked.join(", ") : "*"
}

/** The log's types from `low` up to `high`, a seek each in the type index. */
const typesBetween = (db: Database, low: string, high: string) =>
  db
    .query<{ type: string }, [string, string]>(
      `WITH RECURSIVE t(type) AS (
         SELECT min(type) FROM events WHERE type >= ?1 AND type < ?2
         UNION ALL SELECT (SELECT min(type) FROM events WHERE type > t.type AND type < ?2) FROM t
           WHERE t.type IS NOT NULL)
       SELECT type FROM t WHERE type IS NOT NULL`,
    )
    .all(low, high)
    .map((r) => r.type)

/** The types a condition on the log's type names, or null when it isn't one the index answers. */
const typesOf = (db: Database, c: Condition) => {
  if (c.field !== "type" || typeof c.value !== "string") {
    return null
  }
  if (c.op === "startsWith") {
    return typesBetween(db, c.value, `${c.value}\uFFFF`)
  }
  if (c.op === "contains") {
    const part = c.value.toLowerCase()
    return typesBetween(db, "", "\uFFFF").filter((t) => t.toLowerCase().includes(part))
  }
  return null
}

// A type prefix or part on the log is the types it names: the type index answers each with its seq
// bound (a watch's, `since`'s, a page's). As one range of types, SQLite read every event of all of
// them ever; as a part of the type, every event in the log. Contacts reads its sources' records
// (`type contains ".contact"`, a page from seq 0) as it starts and as it syncs: 341 events found by
// a scan of the whole 2.4 GB log, 13.6 s from a cold copy, and the core's thread held 10-13 s after
// each deploy on Nov 23 (and at a sync) while the pages came off the disk. None named: no rows.
const byTypes = (db: Database, source: QuerySource, q: Query): Query | null => {
  if (source !== EVENTS || q.where === undefined) {
    return q
  }
  const where: Condition[] = []
  for (const c of q.where) {
    const types = typesOf(db, c)
    if (types === null) {
      where.push(c)
    } else if (types.length === 0) {
      return null
    } else {
      where.push({ field: "type", op: "in", value: types })
    }
  }
  return { ...q, where }
}

/** Runs `q`; `now` is what `since` counts back from. */
export const runQuery = (
  db: Database,
  sources: readonly QuerySource[],
  asked: Query,
  now = Date.now(),
): Found | Rejected => {
  const source = sourceOf(sources, asked)
  if (source instanceof Rejected) {
    return source
  }
  const q = byTypes(db, source, asked)
  if (q === null) {
    return { rows: [] }
  }
  const filtered = filteredSql(source, q, now)
  if (filtered instanceof Rejected) {
    return filtered
  }
  const body = latestSql(source, q, filtered)
  if (body instanceof Rejected) {
    return body
  }
  const cols = columnsSql(source, q.fields ?? [])
  if (cols instanceof Rejected) {
    return cols
  }
  const limit = Math.min(Math.max(1, Math.round(q.limit ?? LIMIT)), MAX)
  const order = q.oldest === true ? "ASC" : "DESC"
  const final = `SELECT ${cols} FROM (${body.sql}) AS r ORDER BY r.${source.order} ${order} LIMIT ${limit}`
  try {
    const rows = db.query<Record<string, unknown>, Arg[]>(final).all(...body.args)
    return { rows: rows.map((r) => decodeRow(source, r)) }
  } catch (error) {
    return fail(`The query failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The event types that can change what `q` finds: null when any can. */
export const dependsOf = (sources: readonly QuerySource[], q: Query): readonly string[] | null => {
  const source = sourceOf(sources, q)
  if (source instanceof Rejected) {
    return []
  }
  if (source !== EVENTS) {
    return source.depends
  }
  const types: string[] = []
  for (const c of q.where ?? []) {
    if (c.field !== "type") {
      continue
    }
    if (c.op === "==" && typeof c.value === "string") {
      types.push(c.value)
    } else if (c.op === "startsWith" && typeof c.value === "string") {
      types.push(c.value)
    } else if (c.op === "in" && Array.isArray(c.value)) {
      types.push(...c.value.filter((v): v is string => typeof v === "string"))
    } else {
      return null
    }
  }
  return types.length === 0 ? null : types
}

/** Whether an event of `type` can change what a query depending on `depends` (types or prefixes) finds. */
export const touches = (depends: readonly string[] | null, type: string) =>
  depends === null || depends.some((d) => type.startsWith(d))

/** A few words on each source, for a tool's description. */
export const describeSources = (sources: readonly QuerySource[]) =>
  sources.map((s) => `${s.name}: ${s.description}`).join("\n")

/**
 * The first seq at or after `time` (ms), from the time index: with it, a query of one type since a
 * time reads that type's index range from there rather than every event of the type ever.
 */
// `min(seq) … WHERE time >= ?` would walk the table from its first row, reading the whole log
// when it's cold; the time index's first entry from `time` on is one seek.
export const seqAt = (db: Database, time: number) =>
  db
    .query<{ seq: number }, [number]>(
      "SELECT seq FROM events INDEXED BY events_time WHERE time >= ? ORDER BY time LIMIT 1",
    )
    .get(time)?.seq ??
  db.query<{ seq: number | null }, []>("SELECT max(seq) + 1 AS seq FROM events").get()?.seq ??
  0
