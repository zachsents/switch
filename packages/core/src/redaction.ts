// Secrets out of the core's own output (brain's redact.ts is the matcher; its write path redacts
// every event): its log lines, the credentials it holds itself, and the sweep of what was kept
// before redaction (POST /redactions/sweep, once, admin only).
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { formatWithOptions } from "node:util"
import type { Database } from "bun:sqlite"
import { Brain, ownSecret, ownShape, redact, redacting, redactValue } from "@switch/brain"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

import { CoreConfig } from "./config.ts"
import { TOKEN_SHAPES } from "./credentials.ts"

const METHODS = [
  "log",
  "info",
  "warn",
  "error",
  "debug",
  "trace",
  "group",
  "groupCollapsed",
] as const

/** Every line this process logs, with its secrets redacted: console's and its own writes. */
export const redactLogs = () => {
  for (const m of METHODS) {
    const original = console[m].bind(console)
    console[m] = (...args: unknown[]) => {
      original(redact(formatWithOptions({ colors: false }, ...args)))
    }
  }
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream)
    stream.write = (chunk: unknown, ...rest: unknown[]) =>
      Reflect.apply(write, stream, [redactedChunk(chunk), ...rest]) === true
  }
}

const redactedChunk = (chunk: unknown) => {
  if (typeof chunk === "string") {
    return redact(chunk)
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(redact(Buffer.from(chunk).toString("utf-8")))
  }
  return chunk
}

const KEYS = [
  ["auth.key", "Switch key"],
  ["pages.key", "Switch pages key"],
] as const

/** A name its environment keeps a credential under: `…_API_KEY`, `…_TOKEN`, never `…_SECRETS_DIR`. */
const CREDENTIAL = /(?:key|token|secret|password)$/iu

/**
 * The core's own credentials: its tokens by shape, and by value its keys and each credential in its
 * environment. Connected accounts' tokens are known as they're read (connections.ts).
 */
export const ownCredentials = (dir: string) => {
  for (const re of TOKEN_SHAPES) {
    ownShape("Switch token", re)
  }
  for (const [file, label] of KEYS) {
    const at = path.join(dir, file)
    if (existsSync(at)) {
      ownSecret(readFileSync(at, "utf-8").trim(), label)
    }
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && value.length >= 16 && CREDENTIAL.test(name)) {
      ownSecret(value, name)
    }
  }
}

// ——— The sweep ———

const PAGE = 2000

interface Report {
  /** Each secret's name, how many times. */
  readonly found: Record<string, number>
  /** Events changed, by type. */
  readonly events: Record<string, number>
  /** Every changed event: what it was and what it held, by name. */
  readonly changed: { seq: number; type: string; source: string; time: number; found: string[] }[]
  /** Projection rows changed, by table. */
  readonly tables: Record<string, number>
  /** A secret in a key column, left: changing it would break what reads by it. */
  readonly keys: Record<string, number>
  /** Lines of each log changed. */
  readonly logs: Record<string, number>
}

const bump = (counts: Record<string, number>, key: string, by = 1) => {
  counts[key] = (counts[key] ?? 0) + by
}

/** Shadow tables a virtual table keeps (FTS5's), changed through it. */
const SHADOWS = ["_data", "_idx", "_content", "_docsize", "_config"]

interface Column {
  readonly name: string
  readonly pk: number
}

/** The tables projections keep, their text read and written by rowid; the log's own are left. */
const tablesOf = (db: Database) => {
  const all = db
    .query<{ name: string; sql: string | null }, []>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all()
  const virtual = all.filter((t) => /^CREATE VIRTUAL TABLE/iu.test(t.sql ?? ""))
  return all
    .filter(
      (t) =>
        !["events", "commands", "projections"].includes(t.name) &&
        !/WITHOUT ROWID/iu.test(t.sql ?? "") &&
        !virtual.some((v) => SHADOWS.some((s) => t.name === `${v.name}${s}`)),
    )
    .map((t) => ({
      name: t.name,
      columns: db.query<Column, []>(`SELECT name, pk FROM pragma_table_info('${t.name}')`).all(),
    }))
}

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`

const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** A cell redacted as the write path redacts an event: one holding JSON, string by string. */
const cellOf = (cell: string) => {
  const json = /^[[{]/u.test(cell) ? parsed(cell) : Option.none()
  if (Option.isNone(json)) {
    return redact(cell)
  }
  const out = redactValue(json.value)
  return out === json.value ? cell : JSON.stringify(out)
}

/**
 * Every event in place, a page at a time between the brain's writes, then every projection's text
 * (rebuilding them would hold the brain for many minutes), then the logs named: each secret
 * redacted as the write path redacts it now. The FTS indexes are merged after, so no old term stays
 * in them; what's freed is zeroed (Brain.migrate).
 */
const sweep = (logs: readonly string[]) =>
  Effect.gen(function* sweeping() {
    const brain = yield* Brain
    const report: Report = { found: {}, events: {}, changed: [], tables: {}, keys: {}, logs: {} }
    let after = 0
    let more = true
    while (more) {
      const from = after
      const page = yield* brain.migrate((db) => {
        const rows = db
          .query<
            { seq: number; type: string; source: string; time: number; payload: string },
            [number, number]
          >(
            "SELECT seq, type, source, time, payload FROM events WHERE seq > ? ORDER BY seq LIMIT ?",
          )
          .all(from, PAGE)
        const update = db.query("UPDATE events SET payload = ? WHERE seq = ?")
        for (const r of rows) {
          const payload: unknown = JSON.parse(r.payload)
          const found: string[] = []
          const out = redactValue(payload, found)
          if (out !== payload) {
            update.run(JSON.stringify(out), r.seq)
            bump(report.events, r.type)
            for (const f of found) {
              bump(report.found, f)
            }
            report.changed.push({ seq: r.seq, type: r.type, source: r.source, time: r.time, found })
          }
        }
        return { last: rows.at(-1)?.seq ?? from, n: rows.length }
      })
      after = page.last
      more = page.n === PAGE
    }
    const tables = yield* brain.read(tablesOf)
    for (const t of tables) {
      const text = t.columns.filter((c) => c.pk === 0).map((c) => c.name)
      const keys = t.columns.filter((c) => c.pk > 0).map((c) => c.name)
      let at = 0
      let rest = true
      while (rest && text.length > 0) {
        const from = at
        const page = yield* brain.migrate((db) => {
          const rows = db
            .query<Record<string, unknown>, [number, number]>(
              `SELECT rowid AS _row, ${[...text, ...keys].map(quoted).join(", ")} FROM ${quoted(t.name)} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
            )
            .all(from, PAGE)
          for (const row of rows) {
            const sets: [string, string][] = []
            for (const c of text) {
              const cell = row[c]
              if (typeof cell === "string") {
                const r = cellOf(cell)
                if (r !== cell) {
                  sets.push([c, r])
                }
              }
            }
            for (const c of keys) {
              const cell = row[c]
              if (typeof cell === "string" && redact(cell) !== cell) {
                bump(report.keys, `${t.name}.${c}`)
              }
            }
            if (sets.length > 0) {
              db.query(
                `UPDATE ${quoted(t.name)} SET ${sets.map(([c]) => `${quoted(c)} = ?`).join(", ")} WHERE rowid = ?`,
              ).run(...sets.map(([, v]) => v), Number(row._row))
              bump(report.tables, t.name)
            }
          }
          return { last: Number(rows.at(-1)?._row ?? from), n: rows.length }
        })
        at = page.last
        rest = page.n === PAGE
      }
    }
    yield* brain.migrate((db) => {
      const fts = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%fts5%'",
        )
        .all()
      for (const { name } of fts) {
        if ((report.tables[name] ?? 0) > 0) {
          db.run(`INSERT INTO ${quoted(name)} (${quoted(name)}) VALUES ('optimize')`)
        }
      }
    })
    for (const file of logs) {
      if (existsSync(file)) {
        const lines = readFileSync(file, "utf-8").split("\n")
        let n = 0
        const out = lines.map((line) => {
          const r = redacting(line)
          if (r.text !== line) {
            n += 1
            for (const f of r.found) {
              bump(report.found, f)
            }
          }
          return r.text
        })
        if (n > 0) {
          writeFileSync(file, out.join("\n"))
          report.logs[file] = n
        }
      }
    }
    yield* brain.read((db) => db.run("PRAGMA wal_checkpoint(TRUNCATE)"))
    return report
  })

const asked = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ logs: Schema.Array(Schema.String) })),
)

// Admin only (auth.ts): the sweep, with the logs it reads (`{ logs: [paths] }`). Answers at once;
// what it found, by name and never a value, is `redactions-swept.json` in the core's folder once
// it's done.
export const sweepRoute = Layer.unwrap(
  Effect.gen(function* routing() {
    const brain = yield* Brain
    const { dir } = yield* CoreConfig
    return HttpRouter.add(
      "POST",
      "/redactions/sweep",
      Effect.gen(function* sweepingRoute() {
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* request.text
        const logs = Option.match(asked(body), { onNone: () => [], onSome: (b) => b.logs })
        yield* Effect.forkDetach(
          sweep(logs).pipe(
            Effect.provideService(Brain, brain),
            Effect.flatMap((report) =>
              Effect.sync(() => {
                writeFileSync(path.join(dir, "redactions-swept.json"), JSON.stringify(report))
              }),
            ),
            Effect.ignore({ log: "Warn", message: "The redaction sweep stopped" }),
          ),
        )
        return HttpServerResponse.text("Started", { status: 202 })
      }).pipe(Effect.orDie),
    )
  }),
)
