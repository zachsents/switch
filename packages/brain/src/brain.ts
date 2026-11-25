// The write path follows T3 Code's orchestration-v2 (EventSink), MIT, Copyright (c) 2026 T3 Tools
// Inc.: decide, then one transaction for events and projections, then publish. What reacts to an
// event after commit is a reactor with a cursor in the brain (reactors.ts). It's the one way in, so
// every event's secrets are redacted on it (redact.ts).
import { Database } from "bun:sqlite"
import { statSync } from "node:fs"
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Queue,
  Result,
  Semaphore,
  Stream,
} from "effect"

import { Rejected } from "./defs.ts"
import { EventId } from "./ids.ts"
import { dependsOf, EVENTS, runQuery, sourceOf, touches } from "./query.ts"
import { makeReaders, SLOW_READ_MS, timedRead } from "./readers.ts"
import type { Readers } from "./readers.ts"
import { defineRead } from "./reads.ts"
import type { Read } from "./reads.ts"
import { redactValue } from "./redact.ts"
import type { Found, Query, QuerySource } from "./query.ts"
import type { Check, CommandDef, EventDef, On, Projection, StoredEvent, Upcast } from "./defs.ts"

export interface BrainConfig {
  /** A file path, or ":memory:". */
  readonly path: string
  readonly events: readonly EventDef[]
  readonly projections: readonly Projection[]
  readonly commands: readonly CommandDef[]
  readonly upcasts?: readonly Upcast[]
  /**
   * Told after each commit, to checkpoint the WAL somewhere else (the core's checkpointer, a
   * process of its own). Given, the brain's commits never checkpoint: SQLite's own checkpoint runs
   * in the commit that fills the WAL, writing its pages into the main file and syncing it, seconds
   * of the core's thread on a busy disk (Nov 24). Without it, SQLite checkpoints as it does.
   */
  readonly checkpoint?: () => void
  /**
   * The reader threads its reads run in (readers.ts): `start` makes one, from a module that loads
   * every read and serves them. Without it (a brain in memory, a tool's), reads run here.
   */
  readonly readers?: { readonly start: () => Worker; readonly size: number }
}

/** `id` is the client's: a retry with the same id is a no-op. */
export interface Command {
  readonly id: string
  readonly type: string
  readonly source: string
  readonly payload: unknown
}

export interface Incoming {
  readonly id: EventId
  readonly type: string
  readonly source: string
  readonly payload: unknown
  readonly time?: number
}

export interface Snapshot {
  readonly seq: number
  readonly state: Readonly<Record<string, unknown>>
}

export interface Receipt {
  readonly seq: number
  readonly duplicate: boolean
}

export interface BrainShape {
  readonly dispatch: (command: Command) => Effect.Effect<Receipt, Rejected>
  /** Batched with other calls into one transaction; resolves once committed. */
  readonly ingest: (events: readonly Incoming[]) => Effect.Effect<void, Rejected>
  /** Every projection's state, each read whole: never for the head alone, which is one seek. */
  readonly snapshot: Effect.Effect<Snapshot>
  /** Every event after `seq`: the log first, then live, with no gap and no repeat. */
  readonly changes: (seq: number) => Stream.Stream<StoredEvent>
  /** A read by name (reads.ts), in a reader thread when the brain has them. */
  readonly read: <Args extends readonly unknown[], A>(
    read: Read<Args, A>,
    ...args: Args
  ) => Effect.Effect<A>
  /**
   * `f` changing the database in place, in one transaction between the other writes: a migration
   * made live, a page at a time (redaction's sweep). What it frees is zeroed (`secure_delete`).
   */
  readonly migrate: <A>(f: (db: Database) => A) => Effect.Effect<A>
  /**
   * Every commit copied into the file and the WAL emptied, between the other writes: what a
   * redaction rewrote leaves no old page behind in the log. Waits for readers to move past it.
   */
  readonly truncateLog: Effect.Effect<void>
  readonly rebuild: (projection: string) => Effect.Effect<void>
  /** Adds an event type while running, as an app connects. Rejected if it's known at another version. */
  readonly register: (def: EventDef) => Effect.Effect<void, Rejected>
  /** Every event type it knows: Switch's own and those apps declared as they connected. */
  readonly types: Effect.Effect<readonly string[]>
  /** The log and every projection's read models, to query. */
  readonly sources: readonly QuerySource[]
  readonly query: (q: Query) => Effect.Effect<Found, Rejected>
  /**
   * `q` now, then again each time an event that can change it lands (at most every `spacing` ms),
   * and each minute when it looks back from now; only when what it finds changed.
   */
  readonly live: (q: Query, spacing?: number) => Stream.Stream<Found, Rejected>
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, time INTEGER NOT NULL,
  type TEXT NOT NULL, v INTEGER NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_type ON events (type, seq);
CREATE INDEX IF NOT EXISTS events_time ON events (time);
CREATE INDEX IF NOT EXISTS events_time_type ON events (time, type);
CREATE INDEX IF NOT EXISTS events_permissions ON events (type, json_extract(payload, '$.machine'), seq)
  WHERE type GLOB '*.permissions';
CREATE INDEX IF NOT EXISTS events_attention ON events (type, json_extract(payload, '$.machine'), seq)
  WHERE type GLOB '*.attention';
CREATE INDEX IF NOT EXISTS events_ended_spend ON events
  (seq, json_extract(payload, '$.thread'), json_extract(payload, '$.turn'), json_extract(payload, '$.costUsd'))
  WHERE type = 'turn.ended';
CREATE INDEX IF NOT EXISTS events_woken_turns ON events (seq, json_extract(payload, '$.turn'))
  WHERE type = 'turn.started' AND json_extract(payload, '$.text') = '';
CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
DROP TABLE IF EXISTS outbox;
CREATE TABLE IF NOT EXISTS projections (name TEXT PRIMARY KEY, version INTEGER NOT NULL);
`

const PAGE = 1000

interface Row {
  readonly seq: number
  readonly id: EventId
  readonly time: number
  readonly type: string
  readonly v: number
  readonly source: string
  readonly payload: string
}

interface Prepared {
  readonly id: EventId
  readonly time: number
  readonly type: string
  readonly v: number
  readonly source: string
  readonly encoded: unknown
  readonly json: string
}

const parseJson: (json: string) => unknown = JSON.parse

const toStored = (row: Row): StoredEvent => ({ ...row, payload: parseJson(row.payload) })

const checked = (
  def: { readonly check: Check } | undefined,
  d: { readonly type: string; readonly payload: unknown },
) => {
  if (!def) {
    return new Rejected({ reason: `Unknown type ${d.type}` })
  }
  const result = def.check(d.payload)
  if (Result.isFailure(result)) {
    return new Rejected({ reason: `${d.type}: ${result.failure}` })
  }
  // Every secret in it is its name before it's stored, projected or published (redact.ts).
  const encoded = redactValue(result.success)
  return { encoded, json: JSON.stringify(encoded) }
}

const open = (path: string, elsewhere: boolean) => {
  const db = new Database(path, { create: true, strict: true })
  // First: another process's moment on the file (a WAL recovery, a checkpoint) is waited out, not
  // a "database is locked" that fails a deploy's prepare with the core stopped.
  db.run("PRAGMA busy_timeout = 5000")
  db.run("PRAGMA journal_mode = WAL")
  // WAL with NORMAL survives an app crash; a power cut can lose the last commits.
  db.run("PRAGMA synchronous = NORMAL")
  if (elsewhere) {
    db.run("PRAGMA wal_autocheckpoint = 0")
  }
  db.run(SCHEMA)
  return db
}

/** A write (a command, a batch, a migration) that held this thread past SLOW_READ_MS, logged. */
const slowWrite = (t0: number, what: string) => {
  const ms = performance.now() - t0
  if (ms >= SLOW_READ_MS) {
    console.warn(`slow brain write: ${Math.round(ms)} ms: ${what}`)
  }
}

/** The WAL's size now; 0 when it has none. */
const sizeOf = (path: string) => {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** A slow write's parts: its statements, then its commit (the WAL's write, and the sync of its
 * header when the WAL starts over), with what the process waited on meanwhile. */
const slowWriteParts = (
  at: {
    readonly t0: number
    readonly statementsDone: number
    readonly r0: NodeJS.ResourceUsage
    readonly wal: string
  },
  what: string,
) => {
  const ms = performance.now() - at.t0
  if (ms < SLOW_READ_MS) {
    return
  }
  const r = process.resourceUsage()
  const statements = Math.max(0, at.statementsDone - at.t0)
  console.warn(
    `slow brain write: ${Math.round(ms)} ms: ${what}: statements ${Math.round(statements)} ms, commit ${Math.round(ms - statements)} ms, ${r.majorPageFault - at.r0.majorPageFault} page faults, ${r.fsRead - at.r0.fsRead} reads, ${r.fsWrite - at.r0.fsWrite} writes, ${r.voluntaryContextSwitches - at.r0.voluntaryContextSwitches} waits, WAL ${sizeOf(at.wal)} bytes`,
  )
}

/** Projections by name, as every thread that reads them knows them (`knowProjections`). */
const projectionsKnown = new Map<string, Projection>()

/** The projections a brain's snapshot reads: the core and each reader thread say the same. */
export const knowProjections = (projections: readonly Projection[]) => {
  for (const p of projections) {
    projectionsKnown.set(p.name, p)
  }
}

/** The head and every named projection's state, in one read: the state is as of that head. */
const snapshotRead = defineRead("brain/snapshot", (db, names: readonly string[]) => {
  const seq =
    db.query<{ seq: number | null }, []>("SELECT max(seq) AS seq FROM events").get()?.seq ?? 0
  const state: Record<string, unknown> = {}
  for (const name of names) {
    const p = projectionsKnown.get(name)
    if (p === undefined) {
      throw new Error(`No projection ${name} known here`)
    }
    state[name] = p.snapshot(db)
  }
  return { seq, state }
})

/** A query of the log or a read model; the log's source is this thread's own (`EVENTS`). */
const queryRead = defineRead(
  "brain/query",
  (db, sources: readonly QuerySource[], q: Query, now: number) => {
    const found = runQuery(
      db,
      sources.map((source) => (source.name === EVENTS.name ? EVENTS : source)),
      q,
      now,
    )
    return found instanceof Rejected ? { rejected: found.reason } : { found }
  },
)

/** A page of the log after `cursor` through `through`, as stored. */
const pageRead = defineRead("brain/page", (db, cursor: number, through: number, size: number) =>
  db
    .query<Row, [number, number, number]>(
      "SELECT * FROM events WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?",
    )
    .all(cursor, through, size),
)

const makeBrain = Effect.fnUntraced(function* makeBrain(config: BrainConfig) {
  const db = yield* Effect.acquireRelease(
    Effect.sync(() => open(config.path, config.checkpoint !== undefined)),
    (d) =>
      Effect.sync(() => {
        d.close()
      }),
  )

  const eventDefs = new Map(config.events.map((e) => [e.type, e]))
  const commandDefs = new Map(config.commands.map((c) => [c.type, c]))
  const upcasts = new Map((config.upcasts ?? []).map((u) => [`${u.type}@${u.from}`, u.up]))
  /** Whether a type's events stored at `v` read as its current version. A type no build defines
   * (an app's, before it registers) is read as stored. */
  const readable = (type: string, v: number) => {
    const version = eventDefs.get(type)?.version
    if (version === undefined || v === version) {
      return true
    }
    if (v > version) {
      return false
    }
    for (let at = v; at < version; at += 1) {
      if (!upcasts.has(`${type}@${at}`)) {
        return false
      }
    }
    return true
  }
  /** A row as its type's current version reads it; as stored when nothing leads there (a newer
   * build's, after a rollback), which a rebuild refuses (`current`). */
  const lifted = (row: Row): StoredEvent => {
    const event = toStored(row)
    const version = eventDefs.get(row.type)?.version
    if (version === undefined || row.v === version || !readable(row.type, row.v)) {
      return event
    }
    let { payload } = event
    for (let at = row.v; at < version; at += 1) {
      const up = upcasts.get(`${row.type}@${at}`)
      if (up !== undefined) {
        payload = up(payload)
      }
    }
    return { ...event, v: version, payload }
  }
  const current = (row: Row) => {
    if (!readable(row.type, row.v)) {
      throw new Error(`No upcast for ${row.type} v${row.v} to v${eventDefs.get(row.type)?.version}`)
    }
    return lifted(row)
  }
  const handlers = new Map<string, On[]>()
  for (const o of config.projections.flatMap((p) => p.on)) {
    handlers.set(o.type, [...(handlers.get(o.type) ?? []), o])
  }

  const insertEvent = db.query<{ seq: number }, [string, number, string, number, string, string]>(
    "INSERT INTO events (id, time, type, v, source, payload) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING RETURNING seq",
  )
  const headQuery = db.query<{ seq: number | null }, []>("SELECT max(seq) AS seq FROM events")
  const head = () => headQuery.get()?.seq ?? 0
  const findCommand = db.query<{ seq: number }, [string]>("SELECT seq FROM commands WHERE id = ?")
  const insertCommand = db.query("INSERT INTO commands (id, seq) VALUES (?, ?)")
  knowProjections(config.projections)
  // Reads go to the reader threads once they've opened the brain and know every read; a brain in
  // memory has no file for them to open, so its reads run here.
  const wanted = config.path === ":memory:" ? undefined : config.readers
  const readers: Readers | null =
    wanted === undefined
      ? null
      : yield* Effect.acquireRelease(
          Effect.sync(() => makeReaders(config.path, wanted.start, wanted.size)),
          (r) =>
            Effect.sync(() => {
              r.close()
            }),
        )
  if (readers !== null) {
    yield* Effect.promise(async () => await readers.ready)
  }
  const runRead = <Args extends readonly unknown[], A>(read: Read<Args, A>, args: Args) =>
    readers === null
      ? Effect.sync(() => timedRead(read.name, () => db.transaction(() => read.run(db, ...args))()))
      : Effect.promise(async () => await readers.run(read, args))

  const prepare = (events: readonly Incoming[]): Prepared[] | Rejected => {
    const out: Prepared[] = []
    for (const e of events) {
      const def = eventDefs.get(e.type)
      const payload = checked(def, e)
      if (payload instanceof Rejected) {
        return payload
      }
      out.push({
        id: e.id,
        type: e.type,
        source: e.source,
        time: e.time ?? Date.now(),
        v: def?.version ?? 0,
        ...payload,
      })
    }
    return out
  }

  // The one write: events (skipping ids already in the log), projections, receipt.
  const committed = () => config.checkpoint?.()
  /** When the last write's statements were done, before its commit. */
  let statementsDone = 0
  const writing = db.transaction((events: readonly Prepared[], commandId: string | null) => {
    const stored: StoredEvent[] = []
    for (const e of events) {
      const row = insertEvent.get(e.id, e.time, e.type, e.v, e.source, e.json)
      if (row !== null) {
        const { id, time, type, v, source } = e
        const event: StoredEvent = { seq: row.seq, id, time, type, v, source, payload: e.encoded }
        for (const h of handlers.get(e.type) ?? []) {
          h.apply(db, event)
        }
        stored.push(event)
      }
    }
    const seq = stored.at(-1)?.seq ?? head()
    if (commandId !== null) {
      insertCommand.run(commandId, seq)
    }
    statementsDone = performance.now()
    return { stored, seq }
  })
  // Writes stay on this thread, the one writer: one that holds it this long is logged, as a slow
  // read is, so a stall no read explains is still named, with where its time went.
  const write = (events: readonly Prepared[], commandId: string | null) => {
    const r0 = process.resourceUsage()
    const t0 = performance.now()
    const out = writing(events, commandId)
    slowWriteParts(
      { t0, statementsDone, r0, wal: `${config.path}-wal` },
      `${events.length} events (${[...new Set(events.map((e) => e.type))].slice(0, 6).join(", ")})`,
    )
    committed()
    return out
  }

  const live = yield* PubSub.unbounded<StoredEvent>()
  // Commit and publish under one permit, so subscribers see events in seq order. Load, decide
  // and write run synchronously inside it, so no other write can land between them.
  const lane = yield* Semaphore.make(1)

  const publish = (stored: readonly StoredEvent[]) =>
    stored.length > 0 ? Effect.asVoid(PubSub.publishAll(live, stored)) : Effect.void

  const decideAndWrite = (command: Command) => {
    const t0 = performance.now()
    try {
      return decidingAndWriting(command)
    } finally {
      slowWrite(t0, `command ${command.type}`)
    }
  }
  const decidingAndWriting = (command: Command) => {
    const def = commandDefs.get(command.type)
    if (!def) {
      return new Rejected({ reason: `Unknown command ${command.type}` })
    }
    const done = findCommand.get(command.id)
    if (done) {
      return { seq: done.seq, duplicate: true, stored: [] }
    }
    const decision = def.handle(db, command.payload)
    if ("reject" in decision) {
      return new Rejected({ reason: decision.reject })
    }
    const events = prepare(
      decision.events.map((d, i) => ({
        type: d.type,
        payload: d.payload,
        id: EventId.make(`${command.id}:${i}`),
        source: command.source,
      })),
    )
    if (events instanceof Rejected) {
      return events
    }
    const { stored, seq } = write(events, command.id)
    return { seq, duplicate: false, stored }
  }

  const dispatch = (command: Command) =>
    lane.withPermit(
      Effect.suspend(() => {
        const r = decideAndWrite(command)
        return r instanceof Rejected
          ? Effect.fail(r)
          : Effect.as(publish(r.stored), { seq: r.seq, duplicate: r.duplicate })
      }),
    )

  // Batching writer: whatever arrives while a batch commits goes in the next one.
  const inbox = yield* Queue.unbounded<{
    readonly events: readonly Prepared[]
    readonly done: Deferred.Deferred<boolean>
  }>()
  const commitBatch = (events: readonly Prepared[]) =>
    lane.withPermit(Effect.suspend(() => publish(write(events, null).stored)))
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* batching() {
        const batch = yield* Queue.takeBetween(inbox, 1, 1024)
        const exit = yield* Effect.exit(commitBatch(batch.flatMap((b) => b.events)))
        for (const b of batch) {
          // One bad call must not fail the others in its batch.
          const own = Exit.isSuccess(exit) ? exit : yield* Effect.exit(commitBatch(b.events))
          yield* Exit.isSuccess(own)
            ? Deferred.succeed(b.done, true)
            : Deferred.failCause(b.done, own.cause)
        }
      }),
    ),
  )

  const ingest = (events: readonly Incoming[]) =>
    Effect.suspend(() => {
      const prepared = prepare(events)
      if (prepared instanceof Rejected) {
        return Effect.fail(prepared)
      }
      return Effect.flatMap(Deferred.make<boolean>(), (done) =>
        Effect.andThen(
          Queue.offer(inbox, { events: prepared, done }),
          Effect.asVoid(Deferred.await(done)),
        ),
      )
    })

  const since = (after: number, through: number) =>
    Stream.paginate(after, (cursor) =>
      Effect.map(runRead(pageRead, [cursor, through, PAGE]), (stored) => {
        const rows = stored.map(lifted)
        const last = rows.at(-1)
        return [rows, rows.length === PAGE && last ? Option.some(last.seq) : Option.none()] as const
      }),
    )

  // T3 Code's catch-up: subscribe first, then read the head, so nothing falls between.
  const changes = (after: number) =>
    Stream.unwrap(
      Effect.gen(function* subscribing() {
        const subscription = yield* PubSub.subscribe(live)
        const high = Math.max(head(), after)
        return Stream.concat(
          since(after, high),
          Stream.fromSubscription(subscription).pipe(Stream.filter((e) => e.seq > high)),
        )
      }),
    )

  const saveVersion = db.query(
    "INSERT INTO projections (name, version) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET version = excluded.version",
  )
  const rebuildNow = db.transaction((p: Projection) => {
    for (const table of p.tables) {
      db.run(`DROP TABLE IF EXISTS ${table}`)
    }
    db.run(p.create)
    if (p.indexes !== undefined) {
      db.run(p.indexes)
    }
    const types = [...new Set(p.on.map((o) => o.type))]
    const rows = db
      .query<Row, string[]>(
        `SELECT * FROM events WHERE type IN (${types.map(() => "?").join(", ")}) ORDER BY seq`,
      )
      .iterate(...types)
    for (const row of rows) {
      const event = current(row)
      for (const o of p.on) {
        if (o.type === row.type) {
          o.apply(db, event)
        }
      }
    }
    saveVersion.run(p.name, p.version)
  })

  const versions = db.query<{ version: number }, [string]>(
    "SELECT version FROM projections WHERE name = ?",
  )
  // An older build never touches a newer brain: rebuilding downward drops the newer tables'
  // columns from under the core that runs on them.
  const newer = config.projections.flatMap((p) => {
    const stored = versions.get(p.name)?.version
    return stored !== undefined && stored > p.version
      ? [`${p.name} v${stored} > v${p.version}`]
      : []
  })
  // Every version the log holds of a type reads as its current one, or the brain isn't opened: a
  // rebuild would otherwise stop partway, in a deploy's swap with the core down. The canary opens a
  // copy first, so a version moved on without its upcasts fails there. Only a type whose upcasts
  // don't all lead from v1 is looked up.
  const storedVersions = db.query<{ v: number }, [string, number]>(
    "SELECT DISTINCT v FROM events WHERE type = ? AND v != ?",
  )
  const unreadable = config.events.flatMap((def) =>
    readable(def.type, 1)
      ? []
      : storedVersions
          .all(def.type, def.version)
          .filter(({ v }) => !readable(def.type, v))
          .map(({ v }) => `${def.type} v${v} (now v${def.version})`),
  )
  if (unreadable.length > 0) {
    return yield* Effect.die(
      new Error(
        `${config.path} holds events no upcast reads (${unreadable.join(", ")}); not opened`,
      ),
    )
  }
  if (newer.length > 0) {
    return yield* Effect.die(
      new Error(`${config.path} is from a newer build (${newer.join(", ")}); not opened`),
    )
  }
  for (const p of config.projections) {
    if (versions.get(p.name)?.version !== p.version) {
      rebuildNow(p)
    }
    if (p.indexes !== undefined) {
      db.run(p.indexes)
    }
  }

  const register = (def: EventDef) =>
    Effect.suspend(() => {
      const known = eventDefs.get(def.type)
      if (known === undefined) {
        eventDefs.set(def.type, def)
      } else if (known.version !== def.version) {
        return Effect.fail(
          new Rejected({ reason: `${def.type} is v${known.version}, not v${def.version}` }),
        )
      }
      return Effect.void
    })

  const sources = [EVENTS, ...config.projections.flatMap((p) => p.sources ?? [])]
  const query = (q: Query) =>
    Effect.flatMap(runRead(queryRead, [sources, q, Date.now()]), (r) =>
      "rejected" in r ? Effect.fail(new Rejected({ reason: r.rejected })) : Effect.succeed(r.found),
    )
  const liveQuery = (q: Query, spacing = 1000): Stream.Stream<Found, Rejected> =>
    Stream.unwrap(
      Effect.gen(function* living() {
        const source = sourceOf(sources, q)
        if (source instanceof Rejected) {
          return yield* source
        }
        const depends = dependsOf(sources, q)
        const changed = changes(head()).pipe(
          Stream.filter((e) => touches(depends, e.type)),
          Stream.map(() => true),
        )
        const ticks = q.since === undefined ? Stream.empty : Stream.tick("1 minute")
        let last = ""
        return Stream.concat(Stream.make(true), Stream.merge(changed, ticks)).pipe(
          Stream.debounce(`${spacing} millis`),
          Stream.mapEffect(() => query(q)),
          Stream.filter((found) => {
            const key = JSON.stringify(found.rows)
            const fresh = key !== last
            last = key
            return fresh
          }),
        )
      }),
    )

  return {
    dispatch,
    ingest,
    register,
    types: Effect.sync(() => [...eventDefs.keys()]),
    sources,
    query,
    live: liveQuery,
    snapshot: runRead(snapshotRead, [config.projections.map((p) => p.name)]),
    changes,
    read: (read, ...args) => runRead(read, args),
    truncateLog: lane.withPermit(
      Effect.sync(() => {
        const t0 = performance.now()
        db.run("PRAGMA wal_checkpoint(TRUNCATE)")
        slowWrite(t0, "the log truncated")
      }),
    ),
    migrate: (f) =>
      lane.withPermit(
        Effect.sync(() => {
          db.run("PRAGMA secure_delete = ON")
          const t0 = performance.now()
          try {
            return db.transaction(f)(db)
          } finally {
            db.run("PRAGMA secure_delete = OFF")
            slowWrite(t0, `migrate: ${f.toString().replaceAll(/\s+/gu, " ").slice(0, 120)}`)
            committed()
          }
        }),
      ),
    rebuild: (name) =>
      lane.withPermit(
        Effect.suspend(() => {
          const p = config.projections.find((x) => x.name === name)
          return p
            ? Effect.sync(() => {
                rebuildNow(p)
                committed()
              })
            : Effect.die(new Error(`No projection ${name}`))
        }),
      ),
  } satisfies BrainShape
})

export class Brain extends Context.Service<Brain, BrainShape>()("switch/Brain") {
  static readonly layer = (config: BrainConfig) => Layer.effect(Brain, makeBrain(config))
}
