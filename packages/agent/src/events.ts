import type { Database } from "bun:sqlite"
import path from "node:path"
import {
  defineCommand,
  defineEvent,
  EventId,
  ModelTag,
  on,
  Query,
  ThreadId,
  TurnId,
} from "@switch/brain"
import type { Incoming, Projection } from "@switch/brain"
import { Option, Schema } from "effect"

import { AccountAdded, AccountRemoved, AccountState, accounts, logins } from "./accounts.ts"

/** Narrowest first: a child may only take a mode at or before its parent's. */
export const MODES = ["plan", "dontAsk", "acceptEdits", "bypassPermissions"] as const
export type Mode = (typeof MODES)[number]

const permissions = Schema.Struct({
  /** Claude Code's built-in tools, by name. */
  tools: Schema.Array(Schema.String),
  mode: Schema.Literals(MODES),
  /** Whether it gets the delegation tools. */
  delegate: Schema.Boolean,
  /**
   * "look": of the apps' tools, only those that look (read-only), even with no built-in tools; a
   * check's fix turn gets these. Unset: every app tool, when it has built-in tools.
   */
  apps: Schema.optionalKey(Schema.Literal("look")),
})
export type Permissions = typeof permissions.Type

const usage = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
})
export type Usage = typeof usage.Type

const threadOpened = Schema.Struct({
  thread: ThreadId,
  /** The thread that delegated it, for a task. */
  parent: Schema.NullOr(ThreadId),
  title: Schema.String,
  cwd: Schema.String,
  model: Schema.String,
  permissions,
})
export type Opened = typeof threadOpened.Type

export const ThreadOpened = defineEvent("thread.opened", 1, threadOpened)

/** `session` is Claude Code's, on `host`. A new one means a fresh start or a compaction. */
export const ThreadSession = defineEvent(
  "thread.session",
  1,
  Schema.Struct({ thread: ThreadId, host: Schema.String, session: Schema.String }),
)

/** `text` is the user's words (empty for a wake); `delta` is what came before them in the message. */
export const TurnStarted = defineEvent(
  "turn.started",
  1,
  Schema.Struct({
    thread: ThreadId,
    turn: TurnId,
    host: Schema.String,
    session: Schema.String,
    text: Schema.String,
    delta: Schema.String,
    /** Why a wake ran (its notes, inside `delta`): all an old one keeps in a rebuilt session. */
    wake: Schema.optionalKey(Schema.String),
    /** The model id and effort it ran with. */
    model: Schema.optionalKey(Schema.String),
    effort: Schema.optionalKey(Schema.String),
    /**
     * The senses started it: Switchboard's wake role, a kernel's woken work run in its own work
     * (monologue/src/kernels/ponder.rs:347-374 `wake_turn`).
     */
    sensed: Schema.optionalKey(Schema.Boolean),
    /** The user's words a reply it carries on is owed to (a turn cut off partway), across cuts. */
    owes: Schema.optionalKey(Schema.String),
  }),
)

/**
 * The model a turn runs on as its provider resolved it (a tier's or alias's exact id), once known
 * and again whenever it changes. What the agent writes in the turn is tagged with it.
 */
export const TurnModel = defineEvent(
  "turn.model",
  1,
  Schema.Struct({ thread: ThreadId, turn: TurnId, model: ModelTag }),
)

const decodeTag = Schema.decodeUnknownOption(Schema.fromJsonString(ModelTag))

/** Each turn's model, the latest it ran on. */
export const turnModels: Projection = {
  name: "turn_models",
  version: 1,
  tables: ["turn_models"],
  create: "CREATE TABLE turn_models (turn TEXT PRIMARY KEY, model TEXT NOT NULL);",
  on: [
    on(TurnModel, (db, p) => {
      db.query("INSERT OR REPLACE INTO turn_models (turn, model) VALUES (?, ?)").run(
        p.turn,
        JSON.stringify(p.model),
      )
    }),
  ],
  snapshot: () => null,
}

/** The model turn `turn` ran on, when known. */
export const modelOfTurn = (db: Database, turn: string | null) => {
  if (turn === null) {
    return null
  }
  const row = db
    .query<{ model: string }, [string]>("SELECT model FROM turn_models WHERE turn = ?")
    .get(turn)
  return row ? Option.getOrNull(decodeTag(row.model)) : null
}

/** The model a thread's current (or last) turn runs on, when known. */
export const modelOfThread = (db: Database, thread: string) =>
  modelOfTurn(
    db,
    db
      .query<{ turn: string | null }, [string]>("SELECT turn FROM threads WHERE thread = ?")
      .get(thread)?.turn ?? null,
  )

/** Streamed text, coalesced over 50 ms. The finished block follows as `turn.text`. */
export const TurnDelta = defineEvent(
  "turn.delta",
  1,
  Schema.Struct({ thread: ThreadId, turn: TurnId, text: Schema.String }),
)

export const TurnText = defineEvent(
  "turn.text",
  1,
  Schema.Struct({ thread: ThreadId, turn: TurnId, text: Schema.String }),
)

export const TurnTool = defineEvent(
  "turn.tool",
  1,
  Schema.Struct({
    thread: ThreadId,
    turn: TurnId,
    id: Schema.String,
    name: Schema.String,
    input: Schema.Unknown,
  }),
)

export const TurnResult = defineEvent(
  "turn.result",
  1,
  Schema.Struct({
    thread: ThreadId,
    turn: TurnId,
    id: Schema.String,
    output: Schema.String,
    error: Schema.Boolean,
  }),
)

/** A message that joined a running turn: the user's steer, or a wake digest between tool calls. */
export const TurnInjected = defineEvent(
  "turn.injected",
  1,
  Schema.Struct({
    thread: ThreadId,
    turn: TurnId,
    kind: Schema.Literals(["steer", "wake"]),
    text: Schema.String,
    /** A wake the senses sent: Switchboard's wake role (its kernels' and triggers' work). */
    sensed: Schema.optionalKey(Schema.Boolean),
    /** As a turn's start has it. */
    owes: Schema.optionalKey(Schema.String),
    /** What waited for the thread that it carries in (`thread.waiting` seqs). */
    took: Schema.optionalKey(Schema.Array(Schema.Number)),
  }),
)

export const STATUSES = ["done", "interrupted", "failed", "limited"] as const
export type TurnStatus = (typeof STATUSES)[number]

const turnEnded = Schema.Struct({
  thread: ThreadId,
  turn: TurnId,
  status: Schema.Literals(STATUSES),
  /** The final reply, or what went wrong. */
  result: Schema.String,
  /**
   * The final text of each step that answered the user's words, in order: what their chat gets.
   * A wake's step isn't one. Absent on turns recorded before steps were told apart.
   */
  replies: Schema.optional(Schema.Array(Schema.String)),
  /** When a usage limit lifts, in ms. */
  resetAt: Schema.NullOr(Schema.Number),
  costUsd: Schema.Number,
  usage,
  /** Tokens in the conversation at its last request. */
  context: Schema.Number,
  ms: Schema.Number,
  /**
   * Ended done while its work goes on elsewhere (a watch of its own open, a script it set running):
   * it's waiting until `thread.settled`, not done.
   */
  going: Schema.optionalKey(Schema.Boolean),
})
export type TurnEnd = typeof turnEnded.Type

export const TurnEnded = defineEvent("turn.ended", 1, turnEnded)

/** A delegated task's turn ended. Triage decides whether it wakes the parent. */
export const TaskEnded = defineEvent(
  "task.ended",
  1,
  Schema.Struct({
    task: ThreadId,
    parent: ThreadId,
    title: Schema.String,
    status: Schema.Literals(STATUSES),
    result: Schema.String,
    costUsd: Schema.Number,
    /** The model that wrote the report. */
    model: Schema.optionalKey(ModelTag),
  }),
)

/** A task its parent dropped: what the dropped work made can be retired with it. */
export const TaskDropped = defineEvent(
  "task.dropped",
  1,
  Schema.Struct({ task: ThreadId, parent: ThreadId, why: Schema.String }),
)

/**
 * Work for a thread not yet taken in: recorded as it comes, so a restart can't lose it, and kept
 * while no host can take it (every account it can run on at its limit, or its machine gone). The
 * first turn that starts, or the running turn it joins, takes it all in (Switchboard's pending
 * triggers and `pick_up`: claude/src/main.rs:337-349).
 */
export const ThreadWaiting = defineEvent(
  "thread.waiting",
  1,
  Schema.Struct({
    thread: ThreadId,
    /** The user's words; empty for a wake. */
    text: Schema.String,
    /** For the agent beside them: a wake's text, or a note. */
    note: Schema.String,
    from: Schema.Literals(["owed", "sensed", "steer"]),
    effort: Schema.optionalKey(Schema.String),
    images: Schema.optionalKey(
      Schema.Array(Schema.Struct({ path: Schema.String, type: Schema.String })),
    ),
    /** As a turn's start has it. */
    owes: Schema.optionalKey(Schema.String),
  }),
)
export type Waiting = typeof ThreadWaiting.payload.Type

/**
 * Work for a thread, recorded before it's started (Sessions' `kick`): a wake, a message, a cut turn's
 * carry-on. Its id is derived from what it answers, so recording it again does nothing.
 */
export const waitingEvent = (id: string, w: Waiting): Incoming => ({
  id: EventId.make(id),
  type: ThreadWaiting.type,
  source: "agent",
  payload: w,
})

/** What waits for each thread, in order, until a turn takes it in. */
export const threadWaiting: Projection = {
  name: "thread_waiting",
  version: 1,
  tables: ["thread_waiting"],
  create:
    "CREATE TABLE thread_waiting (seq INTEGER PRIMARY KEY, thread TEXT NOT NULL, body TEXT NOT NULL); CREATE INDEX thread_waiting_thread ON thread_waiting (thread, seq);",
  on: [
    on(ThreadWaiting, (db, p, e) => {
      db.query("INSERT INTO thread_waiting (seq, thread, body) VALUES (?, ?, ?)").run(
        e.seq,
        p.thread,
        JSON.stringify(p),
      )
    }),
    on(TurnStarted, (db, p) => {
      db.query("DELETE FROM thread_waiting WHERE thread = ?").run(p.thread)
    }),
    on(TurnInjected, (db, p) => {
      const drop = db.query("DELETE FROM thread_waiting WHERE seq = ?")
      for (const seq of p.took ?? []) {
        drop.run(seq)
      }
    }),
    on(TaskDropped, (db, p) => {
      db.query("DELETE FROM thread_waiting WHERE thread = ?").run(p.task)
    }),
  ],
  snapshot: () => null,
}

const parseWaiting: (json: string) => Waiting = JSON.parse

/** What waits for a thread, oldest first, by its record's seq. */
export const waitingRows = (db: Database, thread: ThreadId) =>
  db
    .query<{ seq: number; body: string }, [ThreadId]>(
      "SELECT seq, body FROM thread_waiting WHERE thread = ? ORDER BY seq",
    )
    .all(thread)
    .map((r) => ({ seq: r.seq, w: parseWaiting(r.body) }))

/** What waits for a thread, oldest first. */
export const waitingFor = (db: Database, thread: ThreadId) =>
  waitingRows(db, thread).map((r) => r.w)

/** The threads with work waiting. */
export const threadsWaiting = (db: Database) =>
  db
    .query<{ thread: ThreadId }, []>("SELECT DISTINCT thread FROM thread_waiting")
    .all()
    .map((r) => r.thread)

/** Where a task's work stands, in a word or two ("building", "in checks"), on its row; empty clears it. */
export const ThreadStaged = defineEvent(
  "thread.staged",
  1,
  Schema.Struct({ thread: ThreadId, stage: Schema.String }),
)

/** What a thread's last turn left going on (its `going` end) has stopped: it's done now. */
export const ThreadSettled = defineEvent(
  "thread.settled",
  1,
  Schema.Struct({ thread: ThreadId, turn: TurnId }),
)

/** Each thread's stage, apart from the threads table so adding it changed no table. A new turn clears it. */
export const threadStages: Projection = {
  name: "thread_stages",
  version: 1,
  tables: ["thread_stages"],
  create: "CREATE TABLE thread_stages (thread TEXT PRIMARY KEY, stage TEXT NOT NULL);",
  on: [
    on(ThreadStaged, (db, p) => {
      const stage = p.stage.trim()
      if (stage === "") {
        db.query("DELETE FROM thread_stages WHERE thread = ?").run(p.thread)
      } else {
        db.query("INSERT OR REPLACE INTO thread_stages (thread, stage) VALUES (?, ?)").run(
          p.thread,
          stage,
        )
      }
    }),
    on(TurnStarted, (db, p) => {
      db.query("DELETE FROM thread_stages WHERE thread = ?").run(p.thread)
    }),
  ],
  snapshot: () => null,
}

/** Waiting: its turn ended done while its work goes on elsewhere, as clients and the view read it. */
export type ThreadStatus = "idle" | "running" | "waiting" | TurnStatus

export interface Thread extends Opened {
  readonly host: string | null
  readonly session: string | null
  readonly status: ThreadStatus
  /** The turn running, or the last one. */
  readonly turn: TurnId | null
  readonly result: string
  readonly resetAt: number | null
  readonly context: number
  readonly costUsd: number
  /** Brain seq at the end of its last turn: where "since you last looked" starts. */
  readonly seen: number
  readonly endedAt: number
}

const body = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("user"),
    text: Schema.String,
    delta: Schema.String,
    wake: Schema.optionalKey(Schema.String),
    owes: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("tool"),
    id: Schema.String,
    name: Schema.String,
    input: Schema.Unknown,
  }),
  Schema.Struct({
    kind: Schema.Literal("result"),
    id: Schema.String,
    output: Schema.String,
    error: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literals(["steer", "wake"]),
    text: Schema.String,
    owes: Schema.optionalKey(Schema.String),
  }),
])
type Body = typeof body.Type
const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(body))

/** One transcript entry, in log order. */
export type Item = Body & { readonly turn: TurnId }

interface ThreadRow {
  readonly thread: ThreadId
  readonly parent: ThreadId | null
  readonly title: string
  readonly cwd: string
  readonly model: string
  readonly permissions: string
  readonly host: string | null
  readonly session: string | null
  readonly status: ThreadStatus
  readonly turn: TurnId | null
  readonly result: string
  readonly reset_at: number | null
  readonly context: number
  readonly cost_usd: number
  readonly seen: number
  readonly ended_at: number
}

const parsePermissions: (json: string) => Permissions = JSON.parse

const toThread = (r: ThreadRow): Thread => ({
  thread: r.thread,
  parent: r.parent,
  title: r.title,
  cwd: r.cwd,
  model: r.model,
  permissions: parsePermissions(r.permissions),
  host: r.host,
  session: r.session,
  status: r.status,
  turn: r.turn,
  result: r.result,
  resetAt: r.reset_at,
  context: r.context,
  costUsd: r.cost_usd,
  seen: r.seen,
  endedAt: r.ended_at,
})

export const getThread = (db: Database, thread: ThreadId) => {
  const row = db.query<ThreadRow, [ThreadId]>("SELECT * FROM threads WHERE thread = ?").get(thread)
  return row ? toThread(row) : null
}

/**
 * A thread whose turn ended done while its work goes on elsewhere, a watch of its own still open or
 * a script it set still running, is waiting, not done (Nov 23: a task whose turn ended while its
 * rented server ran read "done" to the watch on it, which closed). It reads autonomy's
 * expectations and the core's scripts, which the core, the only brain with threads, always has.
 */
const WAITING = `threads.status = 'done' AND (
  EXISTS (SELECT 1 FROM expectations x WHERE x.thread = threads.thread AND x.status = 'open')
  OR EXISTS (SELECT 1 FROM scripts s WHERE s.thread = threads.thread AND s.status = 'running'))`

/** Whether a thread whose turn ended done still has work going on: it's waiting. */
export const stillGoing = (db: Database, thread: ThreadId) =>
  db.query(`SELECT 1 FROM threads WHERE thread = ? AND ${WAITING}`).get(thread) !== null

/** Whether a thread has a watch open or a script running, whatever its status (`WAITING`'s test). */
const goesOn = (db: Database, thread: ThreadId) =>
  db
    .query(
      `SELECT 1 WHERE EXISTS (SELECT 1 FROM expectations WHERE thread = ?1 AND status = 'open')
         OR EXISTS (SELECT 1 FROM scripts WHERE thread = ?1 AND status = 'running')`,
    )
    .get(thread) !== null

const decodeWatch = Schema.decodeUnknownOption(Schema.fromJsonString(Query))

/** A condition's values: a list's for `in`, else its one. */
const valuesOf = (c: { readonly op: string; readonly value?: unknown } | undefined): unknown[] => {
  if (c === undefined) {
    return []
  }
  const { value } = c
  return c.op === "in" && Array.isArray(value) ? value : [value]
}

/**
 * Whether a task's work carries on by itself, sure to wake it again: a watch of its own at a time,
 * or on the end of a script of its own still running; or a task of its own still at it. Its next
 * end reports, so this one is progress (Nov 24: a task relaying its deploys' and tasks' progress
 * woke its space a dozen times to say nothing). A watch on the world (a sense's events, an item)
 * may never fire: what the task did until then is its report.
 */
const carriesOn = (db: Database, thread: ThreadId): boolean => {
  const running = new Set(
    db
      .query<{ name: string }, [string]>(
        "SELECT name FROM scripts WHERE thread = ? AND status = 'running'",
      )
      .all(thread)
      .map((r) => r.name),
  )
  const wakes = db
    .query<{ when_q: string | null; by: number | null }, [string]>(
      "SELECT when_q, by FROM expectations WHERE thread = ? AND status = 'open'",
    )
    .all(thread)
    .some((x) => {
      if (x.when_q === null) {
        return x.by !== null
      }
      const q = decodeWatch(x.when_q)
      if (Option.isNone(q) || (q.value.from ?? "events") !== "events") {
        return false
      }
      const where = q.value.where ?? []
      return (
        valuesOf(where.find((c) => c.field === "type")).includes("script.ended") &&
        valuesOf(where.find((c) => c.field === "payload.script")).some(
          (n) => typeof n === "string" && running.has(n),
        )
      )
    })
  if (wakes) {
    return true
  }
  const queued = db.query<{ n: number }, [string]>(
    "SELECT count(*) AS n FROM thread_waiting WHERE thread = ?",
  )
  return db
    .query<{ thread: ThreadId; status: string }, [string]>(
      "SELECT thread, status FROM threads WHERE parent = ?",
    )
    .all(thread)
    .some(
      (c) =>
        c.status === "running" ||
        c.status === "limited" ||
        (queued.get(c.thread)?.n ?? 0) > 0 ||
        (c.status === "done" && carriesOn(db, c.thread)),
    )
}

/**
 * What a task's turn `turn` ending `status` tells its parent: null while its work carries on by
 * itself (`carriesOn`) and no wait on the user was hung this turn, its own or its tasks'; else how
 * it ended, "waiting" when a watch or script of its own goes on.
 */
export const taskEnd = (db: Database, thread: ThreadId, status: string, turn: string) => {
  if (status !== "done") {
    return status
  }
  const asked =
    db
      .query(
        `WITH RECURSIVE tree(thread) AS (SELECT ?1
             UNION SELECT t.thread FROM threads t JOIN tree ON t.parent = tree.thread)
         SELECT 1 FROM expectations x JOIN tree ON x.thread = tree.thread
         WHERE x.status = 'open' AND json_extract(x.when_q, '$.from') = 'items'
           AND x.set_seq > (SELECT seq FROM events WHERE id = ?2 || ':start')`,
      )
      .get(thread, turn) !== null
  if (!asked && carriesOn(db, thread)) {
    return null
  }
  return goesOn(db, thread) ? "waiting" : "done"
}

/** Every waiting thread, in one read from the open watches and running scripts: what `stillGoing`
 * says of each, for a list of all threads. */
export const waiting = (db: Database) =>
  new Set(
    db
      .query<{ thread: ThreadId }, []>(
        `SELECT DISTINCT w.thread FROM (
           SELECT thread FROM expectations WHERE status = 'open' AND thread IS NOT NULL
           UNION ALL
           SELECT thread FROM scripts WHERE status = 'running' AND thread IS NOT NULL) w
         JOIN threads t ON t.thread = w.thread AND t.status = 'done'`,
      )
      .all()
      .map((r) => r.thread),
  )

export const allThreads = (db: Database) =>
  db.query<ThreadRow, []>("SELECT * FROM threads ORDER BY thread").all().map(toThread)

export const items = (db: Database, thread: ThreadId): Item[] =>
  db
    .query<{ turn: TurnId; body: string }, [ThreadId]>(
      "SELECT turn, body FROM thread_items WHERE thread = ? ORDER BY seq",
    )
    .all(thread)
    .map((r) => ({ ...decodeBody(r.body), turn: r.turn }))

/** A thread's entries after `after`, in log order, each with when it was recorded. */
export const itemsAfter = (db: Database, thread: string, after: number) =>
  db
    .query<{ turn: TurnId; body: string; time: number }, [string, number]>(
      `SELECT i.turn, i.body, e.time FROM thread_items i JOIN events e ON e.seq = i.seq
       WHERE i.thread = ? AND i.seq > ? ORDER BY i.seq`,
    )
    .all(thread, after)
    .map((r) => ({ ...decodeBody(r.body), turn: r.turn, time: r.time }))

/** One turn's entries, in log order, by its span (core/src/view.ts `turn_spans`). */
export const turnItems = (db: Database, turn: string): Item[] =>
  db
    .query<{ turn: TurnId; body: string }, [string]>(
      `SELECT i.turn, i.body FROM turn_spans span JOIN thread_items i ON i.thread = span.thread
         AND i.seq BETWEEN span.first AND span.last
       WHERE span.turn = ? AND i.turn = span.turn ORDER BY i.seq`,
    )
    .all(turn)
    .map((r) => ({ ...decodeBody(r.body), turn: r.turn }))

const set = (db: Database, thread: ThreadId, fields: Record<string, string | number | null>) => {
  const keys = Object.keys(fields)
  db.query(`UPDATE threads SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE thread = ?`).run(
    ...Object.values(fields),
    thread,
  )
}

const item = (
  db: Database,
  seq: number,
  p: { readonly thread: ThreadId; readonly turn: TurnId },
  b: Body,
) => {
  db.query("INSERT INTO thread_items (seq, thread, turn, body) VALUES (?, ?, ?, ?)").run(
    seq,
    p.thread,
    p.turn,
    JSON.stringify(b),
  )
}

/**
 * What a turn the deploy paused for an update ends on (scripts/ship.sh). Its thread stays running in
 * the record, as the next core carries it on at once: a watch on it, or its parent reading it, sees
 * no end in the pause.
 */
export const PAUSED = "Paused for an update"
/** What a turn moved to another profile partway ends on; it carries on there at once. */
export const MOVED = "Moved to another profile"
/** What a turn cut off from outside (a restart, a stray reap) ends on; it carries on in its session. */
export const CUT_OFF = "Cut off by a restart"
/** A turn a usage limit cut off, as its end records it: not the user's Stop. */
export const LIMIT_OFF = "Cut off by a usage limit"

/** Whether a turn's end only pauses its work: a later turn of its thread carries it on. */
export const carriedOn = (end: Pick<TurnEnd, "status" | "result">) =>
  end.status === "limited" || [PAUSED, MOVED, CUT_OFF, LIMIT_OFF].includes(end.result)

export const threads: Projection = {
  name: "threads",
  version: 1,
  tables: ["threads", "thread_items"],
  create: `
    CREATE TABLE threads (
      thread TEXT PRIMARY KEY, parent TEXT, title TEXT NOT NULL, cwd TEXT NOT NULL,
      model TEXT NOT NULL, permissions TEXT NOT NULL, host TEXT, session TEXT,
      status TEXT NOT NULL DEFAULT 'idle', turn TEXT, result TEXT NOT NULL DEFAULT '',
      reset_at INTEGER, context INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
      seen INTEGER NOT NULL DEFAULT 0, ended_at INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX threads_parent ON threads (parent);
    CREATE TABLE thread_items (
      seq INTEGER PRIMARY KEY, thread TEXT NOT NULL, turn TEXT NOT NULL, body TEXT NOT NULL);
    CREATE INDEX thread_items_thread ON thread_items (thread, seq);`,
  on: [
    on(ThreadOpened, (db, p) => {
      db.query(
        "INSERT INTO threads (thread, parent, title, cwd, model, permissions) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(p.thread, p.parent, p.title, p.cwd, p.model, JSON.stringify(p.permissions))
    }),
    on(ThreadSession, (db, p) => {
      // A rebuilt session is smaller; the next turn says by how much.
      set(db, p.thread, { host: p.host, session: p.session, context: 0 })
    }),
    on(TurnStarted, (db, p, e) => {
      // A turn carrying on a paused or cut one leaves that end behind: the thread reads as working.
      db.query(
        "UPDATE threads SET result = '' WHERE thread = ? AND (status = 'interrupted' OR result = ?)",
      ).run(p.thread, PAUSED)
      set(db, p.thread, { status: "running", turn: p.turn, host: p.host, session: p.session })
      item(db, e.seq, p, {
        kind: "user",
        text: p.text,
        delta: p.delta,
        ...(p.wake !== undefined && { wake: p.wake }),
        ...(p.sensed === true && { sensed: true }),
        ...(p.owes !== undefined && { owes: p.owes }),
      })
    }),
    on(TurnText, (db, p, e) => {
      item(db, e.seq, p, { kind: "text", text: p.text })
    }),
    on(TurnTool, (db, p, e) => {
      item(db, e.seq, p, { kind: "tool", id: p.id, name: p.name, input: p.input })
    }),
    on(TurnResult, (db, p, e) => {
      item(db, e.seq, p, { kind: "result", id: p.id, output: p.output, error: p.error })
    }),
    on(TurnInjected, (db, p, e) => {
      item(db, e.seq, p, {
        kind: p.kind,
        text: p.text,
        ...(p.sensed === true && { sensed: true }),
        ...(p.owes !== undefined && { owes: p.owes }),
      })
    }),
    on(TurnEnded, (db, p, e) => {
      db.query("UPDATE threads SET cost_usd = cost_usd + ? WHERE thread = ?").run(
        p.costUsd,
        p.thread,
      )
      // The next turn may have started before this one's end was written.
      db.query(
        `UPDATE threads SET status = ?, result = ?, reset_at = ?, context = ?, seen = ?, ended_at = ?
          WHERE thread = ? AND turn = ?`,
      ).run(
        p.result === PAUSED ? "running" : p.status,
        p.result,
        p.resetAt,
        p.context,
        e.seq,
        e.time,
        p.thread,
        p.turn,
      )
    }),
  ],
  snapshot: allThreads,
  sources: [
    {
      name: "work",
      description:
        "Threads: thread (\"space:<id>\" for a space's chat, \"side:<extension>:<space>:<key>\" for an extension's side thread, else a task), parent, title, status (idle, running, done, waiting, interrupted, failed, limited; waiting: its turn ended but its work goes on, a watch of its own open or a script it set running; done: nothing of it goes on), result (its last reply), cost_usd, ended_at, link (its page in the apps: a space's chat is its space's).",
      select: `SELECT thread, parent, title, CASE WHEN ${WAITING} THEN 'waiting' ELSE status END AS status, turn, result, cost_usd, ended_at, CASE WHEN thread LIKE 'space:%' THEN 'switchboard://space/' || substr(thread, 7) ELSE 'switchboard://thread/' || thread END AS link, rowid AS n FROM threads`,
      columns: [
        "thread",
        "parent",
        "title",
        "status",
        "turn",
        "result",
        "cost_usd",
        "ended_at",
        "link",
        "n",
      ],
      time: "ended_at",
      order: "n",
      depends: ["thread.", "turn.started", "turn.ended", "task.", "expectation.", "script."],
    },
  ],
}

/** Opens a top-level thread; a no-op when it exists. */
export const OpenThread = defineCommand({
  type: "thread.open",
  payload: threadOpened,
  load: (db, p) => getThread(db, p.thread),
  decide: (existing, p) => ({
    events: existing ? [] : [ThreadOpened.make({ ...p, parent: null })],
  }),
})

const rank = (mode: Mode) => MODES.indexOf(mode)

const within = (dir: string, root: string) => {
  const d = path.resolve(dir)
  const r = path.resolve(root)
  return d === r || d.startsWith(`${r}/`)
}

/** A child thread of `parent`. Its permissions and folder can only narrow the parent's. */
export const Delegate = defineCommand({
  type: "thread.delegate",
  payload: Schema.Struct({
    thread: ThreadId,
    parent: ThreadId,
    title: Schema.String,
    cwd: Schema.NullOr(Schema.String),
    model: Schema.NullOr(Schema.String),
    tools: Schema.NullOr(Schema.Array(Schema.String)),
    mode: Schema.NullOr(Schema.Literals(MODES)),
    delegate: Schema.NullOr(Schema.Boolean),
  }),
  load: (db, p) => ({ parent: getThread(db, p.parent), existing: getThread(db, p.thread) }),
  decide: ({ parent, existing }, p) => {
    if (!parent) {
      return { reject: "No parent thread" }
    }
    if (existing) {
      return { reject: "Thread exists" }
    }
    const granted = parent.permissions
    const tools = p.tools ?? granted.tools
    const extra = tools.filter((t) => !granted.tools.includes(t))
    if (extra.length > 0) {
      return { reject: `Not permitted: ${extra.join(", ")}` }
    }
    const mode = p.mode ?? granted.mode
    if (rank(mode) > rank(granted.mode)) {
      return { reject: `Mode ${mode} is broader than ${granted.mode}` }
    }
    const delegate = p.delegate ?? granted.delegate
    if (delegate && !granted.delegate) {
      return { reject: "Not permitted to delegate" }
    }
    const cwd = p.cwd ?? parent.cwd
    if (!within(cwd, parent.cwd)) {
      return { reject: `${cwd} is outside ${parent.cwd}` }
    }
    return {
      events: [
        ThreadOpened.make({
          thread: p.thread,
          parent: p.parent,
          title: p.title,
          cwd,
          model: p.model ?? parent.model,
          permissions: { tools, mode, delegate },
        }),
      ],
    }
  },
})

export const agentConfig = {
  events: [
    ThreadOpened,
    ThreadSession,
    TurnStarted,
    TurnModel,
    TurnDelta,
    TurnText,
    TurnTool,
    TurnResult,
    TurnInjected,
    TurnEnded,
    TaskEnded,
    TaskDropped,
    ThreadStaged,
    ThreadSettled,
    ThreadWaiting,
    AccountState,
    AccountAdded,
    AccountRemoved,
  ],
  projections: [threads, accounts, logins, threadStages, threadWaiting, turnModels],
  commands: [OpenThread, Delegate],
}
