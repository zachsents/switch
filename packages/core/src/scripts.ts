// Scripts: what the agent writes for Switch to run outside any turn, on the Mac it picks (the core's
// own by default), so a wait on something nothing records (a port, a file, a page, a command's
// result) has an event to watch rather than a timer. The user, Nov 22: "is it not able to just set
// up some watch that fires once a bash proc ends or something ?", "i also want an agent to be able
// to write arbitrary scripts that can fire events".
// - A script fires an event with `switch event <name> [json]`, through the credential its host gives
//   it: a record of its stream (`scripts/<name>`), in the space and work that set it.
// - Its end on its own is `script.ended`, with its exit code and last lines of output.
// - Its host runs it apart from itself (script-host.ts): a deploy or a host's restart leaves it
//   running; one a reboot or a kill stopped is started again from the top.
// - It's retired with its work (a task dropped, a space archived), on request, or replaced by one
//   set under the same name in its space.
import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { TaskDropped } from "@switch/agent"
import {
  Brain,
  defineCommand,
  defineRead,
  defineEvent,
  EventId,
  on,
  react,
  SpaceArchived,
  SpaceId,
  ThreadId,
} from "@switch/brain"
import type { Projection } from "@switch/brain"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpRouter } from "effect/http"

import { CoreConfig } from "./config.ts"
import { threadOf } from "./context.ts"
import { scriptOf, scriptToken } from "./credentials.ts"
import type { ScriptSpec, ToCore } from "./link.ts"
import { web } from "./web.ts"

export const ScriptSet = defineEvent(
  "script.set",
  1,
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    space: SpaceId,
    /** The work that set it. */
    thread: Schema.optionalKey(ThreadId),
    machine: Schema.String,
    /** The script: sh, unless it starts with `#!`. */
    run: Schema.String,
  }),
)

export const ScriptRetired = defineEvent(
  "script.retired",
  1,
  Schema.Struct({ id: Schema.String, why: Schema.String }),
)

/** Its host started it: `restarts` is how many times it was started again after a stop. */
export const ScriptStarted = defineEvent(
  "script.started",
  1,
  Schema.Struct({
    id: Schema.String,
    gen: Schema.Number,
    machine: Schema.String,
    pid: Schema.Number,
    restarts: Schema.Number,
  }),
)

/** What a script records, its own events and its end: a record of its stream, in its space. */
const ScriptRecord = Schema.Struct({
  stream: Schema.String,
  /** The event's name. */
  kind: Schema.String,
  script: Schema.String,
  space: SpaceId,
  thread: Schema.optionalKey(ThreadId),
  data: Schema.optionalKey(Schema.Unknown),
})

/** It ended on its own: `data` is its exit code and its last lines of output. */
export const ScriptEnded = defineEvent("script.ended", 1, ScriptRecord)

export type ScriptStatus = "running" | "ended" | "retired"

export interface Script {
  readonly id: string
  readonly name: string
  readonly space: SpaceId
  readonly thread: ThreadId | null
  readonly machine: string
  readonly run: string
  /** The seq of the set it runs for. */
  readonly gen: number
  readonly status: ScriptStatus
  readonly setAt: number
  readonly pid: number | null
  readonly restarts: number
  readonly code: number | null
  readonly endedAt: number | null
}

interface Row {
  readonly id: string
  readonly name: string
  readonly space: SpaceId
  readonly thread: ThreadId | null
  readonly machine: string
  readonly run: string
  readonly gen: number
  readonly status: ScriptStatus
  readonly set_at: number
  readonly pid: number | null
  readonly restarts: number
  readonly code: number | null
  readonly ended_at: number | null
}

const toScript = (r: Row): Script => ({
  id: r.id,
  name: r.name,
  space: r.space,
  thread: r.thread,
  machine: r.machine,
  run: r.run,
  gen: r.gen,
  status: r.status,
  setAt: r.set_at,
  pid: r.pid,
  restarts: r.restarts,
  code: r.code,
  endedAt: r.ended_at,
})

/** A script's id: its name in its space. */
export const scriptId = (space: string, name: string) =>
  `s-${createHash("sha256").update(`${space}\n${name}`).digest("hex").slice(0, 10)}`

export const scripts: Projection = {
  name: "scripts",
  version: 3,
  tables: ["scripts"],
  create: `
    CREATE TABLE scripts (id TEXT PRIMARY KEY, name TEXT NOT NULL, space TEXT NOT NULL, thread TEXT,
      machine TEXT NOT NULL, run TEXT NOT NULL, gen INTEGER NOT NULL, status TEXT NOT NULL,
      set_at INTEGER NOT NULL, pid INTEGER, restarts INTEGER NOT NULL DEFAULT 0, code INTEGER,
      ended_at INTEGER);
    CREATE INDEX scripts_machine ON scripts (machine, status);`,
  on: [
    on(ScriptSet, (db, p, e) => {
      // Set again under its name, it's replaced: run anew.
      db.query(
        `INSERT INTO scripts (id, name, space, thread, machine, run, gen, status, set_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)
         ON CONFLICT (id) DO UPDATE SET thread = excluded.thread, machine = excluded.machine,
           run = excluded.run, gen = excluded.gen, status = 'running', set_at = excluded.set_at,
           pid = NULL, restarts = 0, code = NULL, ended_at = NULL`,
      ).run(p.id, p.name, p.space, p.thread ?? null, p.machine, p.run, e.seq, e.time)
    }),
    on(ScriptStarted, (db, p) => {
      db.query(
        "UPDATE scripts SET pid = ?, restarts = ? WHERE id = ? AND gen = ? AND status = 'running'",
      ).run(p.pid, p.restarts, p.id, p.gen)
    }),
    on(ScriptEnded, (db, p, e) => {
      const code = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.Number }))(p.data)
      db.query(
        "UPDATE scripts SET status = 'ended', code = ?, ended_at = ? WHERE id = ? AND status = 'running'",
      ).run(Option.isSome(code) ? code.value.code : null, e.time, scriptId(p.space, p.script))
    }),
    on(ScriptRetired, (db, p, e) => {
      db.query(
        "UPDATE scripts SET status = 'retired', ended_at = coalesce(ended_at, ?) WHERE id = ?",
      ).run(e.time, p.id)
    }),
  ],
  snapshot: () => null,
  sources: [
    {
      name: "scripts",
      description:
        "Scripts set to run outside turns: id, name, space, thread (the work that set it), machine, status (running, ended, retired), restarts (times started again after a reboot or a kill), code (its exit code once ended), set_at, ended_at.",
      select:
        "SELECT id, name, space, thread, machine, status, restarts, code, set_at, ended_at, rowid AS n FROM scripts",
      columns: [
        "id",
        "name",
        "space",
        "thread",
        "machine",
        "status",
        "restarts",
        "code",
        "set_at",
        "ended_at",
        "n",
      ],
      time: "set_at",
      order: "n",
      depends: ["script."],
    },
  ],
}

export const getScript = (db: Database, id: string) => {
  const row = db.query<Row, [string]>("SELECT * FROM scripts WHERE id = ?").get(id)
  return row ? toScript(row) : null
}

/** Scripts not retired, newest first; in `space` when given. */
export const listScripts = (db: Database, space?: string) =>
  db
    .query<Row, []>("SELECT * FROM scripts WHERE status != 'retired' ORDER BY set_at DESC")
    .all()
    .map(toScript)
    .filter((s) => space === undefined || s.space === space)

export const SetScript = defineCommand({
  type: "script.set",
  payload: ScriptSet.payload,
  load: (db, p) => db.query("SELECT id FROM spaces WHERE id = ?").get(p.space) !== null,
  decide: (exists, p) => (exists ? { events: [ScriptSet.make(p)] } : { reject: "No such space" }),
})

export const RetireScript = defineCommand({
  type: "script.retire",
  payload: ScriptRetired.payload,
  load: (db, p) => getScript(db, p.id),
  decide: (s, p) => {
    if (!s) {
      return { reject: "No such script" }
    }
    return { events: s.status === "retired" ? [] : [ScriptRetired.make(p)] }
  },
})

export const scriptsConfig = {
  events: [ScriptSet, ScriptRetired, ScriptStarted, ScriptEnded],
  projections: [scripts],
  commands: [SetScript, RetireScript],
}

/**
 * What `machine`'s host runs, or keeps the log of: each with the credential it fires events with,
 * and its work as `SWITCH_WORK`, the mark a Mac's runaway stopper knows it and all it starts by
 * (runaway.ts).
 */
export const scriptsFor = (db: Database, machine: string, dir: string): ScriptSpec[] =>
  db
    .query<Row, [string]>("SELECT * FROM scripts WHERE machine = ? AND status != 'retired'")
    .all(machine)
    .map((r) => ({
      id: r.id,
      gen: r.gen,
      name: r.name,
      run: r.run,
      env: { SWITCH_TOKEN: scriptToken(dir, r.id), SWITCH_WORK: r.thread ?? threadOf(r.space) },
      ...(r.status === "ended" && { ended: true }),
      ...(r.pid !== null && { pid: r.pid }),
      restarts: r.restarts,
    }))

/** A record of a script's, as its events and its end are. */
const recordOf = (s: Script, kind: string, data: unknown) => ({
  stream: `scripts/${s.name}`,
  kind,
  script: s.name,
  space: s.space,
  ...(s.thread !== null && { thread: s.thread }),
  ...(data !== undefined && { data }),
})

/** What a host says of a script: its start, or its end on its own. Each is recorded once. */
/** A script. */
const scriptRead = defineRead("core/scripts/script", getScript)
/** Whether something other than a script records events of type `name`. */
const otherWriterRead = defineRead(
  "core/scripts/other-writer",
  (db, name: string) =>
    db.query("SELECT 1 FROM events WHERE type = ? AND source != 'script' LIMIT 1").get(name) !==
    null,
)
/** The scripts a dropped task or an archived space leaves: the task's, else the space's. */
const goneRead = defineRead("core/scripts/gone", (db, task: string | null, space: string | null) =>
  listScripts(db).filter((s) => (task === null ? s.space === space : s.thread === task)),
)

export const reported = (machine: string, m: Extract<ToCore, { t: "script" }>) =>
  Effect.gen(function* reporting() {
    const brain = yield* Brain
    const s = yield* brain.read(scriptRead, m.id)
    if (s === null || s.gen !== m.gen || s.machine !== machine || s.status !== "running") {
      return
    }
    yield* m.code === undefined
      ? brain.ingest([
          {
            id: EventId.make(`script.started:${m.id}:${m.gen}:${m.pid}`),
            type: ScriptStarted.type,
            source: "runtime",
            payload: { id: m.id, gen: m.gen, machine, pid: m.pid, restarts: m.restarts },
          },
        ])
      : brain.ingest([
          {
            id: EventId.make(`script.ended:${m.id}:${m.gen}`),
            type: ScriptEnded.type,
            source: "script",
            payload: recordOf(s, ScriptEnded.type, { code: m.code, tail: m.tail ?? "" }),
          },
        ])
  }).pipe(Effect.catchTag("Rejected", (r) => Effect.logWarning(r.reason)))

const Fired = Schema.Struct({ name: Schema.String, data: Schema.optionalKey(Schema.Unknown) })
const decodeFired = Schema.decodeUnknownOption(Schema.fromJsonString(Fired))

/** An event a script fires: a name nobody else writes, and not one of a script's own. */
const fire = (s: Script, name: string, data: unknown) =>
  Effect.gen(function* firing() {
    const brain = yield* Brain
    const other = yield* brain.read(otherWriterRead, name)
    if (name.startsWith("script.") || other) {
      return `${name} is another writer's event`
    }
    yield* brain.register(defineEvent(name, 1, ScriptRecord))
    yield* brain.ingest([
      {
        id: EventId.make(`script:${s.id}:${crypto.randomUUID()}`),
        type: name,
        source: "script",
        payload: recordOf(s, name, data),
      },
    ])
    return null
  }).pipe(Effect.catchTag("Rejected", (r) => Effect.succeed(r.reason)))

const EVENT = /^[\w.:/-]+$/u

/** POST /events: `switch event`, from a running script, with its credential. */
export const eventsRoute = Layer.unwrap(
  Effect.gen(function* routing() {
    const brain = yield* Brain
    const c = yield* CoreConfig
    return HttpRouter.add(
      "POST",
      "/events",
      web(async (request) => {
        const header = request.headers.get("authorization") ?? ""
        const token = header.startsWith("Bearer ")
          ? header.slice(7).trim()
          : (new URL(request.url).searchParams.get("token") ?? "")
        const id = scriptOf(c.dir, token)
        const s = id === null ? null : await Effect.runPromise(brain.read(scriptRead, id))
        if (s?.status !== "running") {
          return Response.json({ error: "No running script" }, { status: 401 })
        }
        const asked = decodeFired(await request.text())
        if (Option.isNone(asked) || !EVENT.test(asked.value.name)) {
          return Response.json({ error: "Bad event" }, { status: 400 })
        }
        const refused = await Effect.runPromise(
          fire(s, asked.value.name, asked.value.data).pipe(Effect.provideService(Brain, brain)),
        )
        return refused === null
          ? Response.json({ recorded: asked.value.name })
          : Response.json({ error: refused }, { status: 400 })
      }),
    )
  }),
)

const Wanted = Schema.Struct({
  name: Schema.String,
  run: Schema.String,
  machine: Schema.String,
  space: Schema.optionalKey(Schema.String),
})
const decodeWanted = Schema.decodeUnknownOption(Schema.fromJsonString(Wanted))

/**
 * POST /scripts: a script set from the core's own machine (auth.ts: as the deploy's routes), for
 * what a machine runs that no work owns, so nothing retires it: move-core.sh's backup jobs on a Mac,
 * which launchd's /bin/sh may not run off the backup disk (TCC) and its host may. The same name
 * again replaces it.
 */
export const scriptsRoute = Layer.unwrap(
  Effect.gen(function* routing() {
    const brain = yield* Brain
    return HttpRouter.add(
      "POST",
      "/scripts",
      web(async (request) => {
        const asked = decodeWanted(await request.text())
        const name = Option.isSome(asked) ? asked.value.name.trim() : ""
        if (Option.isNone(asked) || name === "" || asked.value.run.trim() === "") {
          return Response.json({ error: "Give a name, a machine and a script" }, { status: 400 })
        }
        const { run, machine } = asked.value
        const space = asked.value.space ?? "home"
        const id = scriptId(space, name)
        const refused = await Effect.runPromise(
          brain
            .dispatch({
              id: crypto.randomUUID(),
              type: SetScript.type,
              source: "core",
              payload: { id, name, space, machine, run },
            })
            .pipe(
              Effect.as(null),
              Effect.catchTag("Rejected", (r) => Effect.succeed(r.reason)),
            ),
        )
        return refused === null
          ? Response.json({ id, name, space, machine })
          : Response.json({ error: refused }, { status: 400 })
      }),
    )
  }),
)

/**
 * Work dropped: its scripts go with it, as its expectations do (expect.ts). From its cursor, so work
 * dropped as the core stopped still retires its scripts.
 */
export const scriptsRetire = Layer.effectDiscard(
  Effect.forkScoped(
    react(
      "scripts-retire",
      (e) => e.type === TaskDropped.type || e.type === SpaceArchived.type,
      (e) =>
        Effect.gen(function* dropping() {
          const brain = yield* Brain
          const task = e.type === TaskDropped.type ? TaskDropped.decode(e.payload).task : null
          const space = e.type === SpaceArchived.type ? SpaceArchived.decode(e.payload).id : null
          const gone = yield* brain.read(goneRead, task, space)
          for (const s of gone) {
            yield* brain
              .dispatch({
                id: `retire:${s.id}:${String(e.seq)}`,
                type: RetireScript.type,
                source: "autonomy",
                payload: { id: s.id, why: task === null ? "space archived" : "task dropped" },
              })
              .pipe(Effect.catchTag("Rejected", (r) => Effect.logWarning(r.reason)))
          }
        }),
    ),
  ),
)
