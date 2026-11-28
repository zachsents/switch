// One live agent session per thread, on whichever provider the thread's model runs on (provider.ts).
// Edge cases follow T3 Code's ClaudeAdapterV2 and
// orchestrator (MIT, Copyright (c) 2026 T3 Tools Inc.): steer, interrupt, orphan cleanup,
// usage-limit auto-resume, 50 ms delta coalescing, idle compaction before the cache expires.
import { createHash } from "node:crypto"
import { Brain, bypassEvent, defineRead, spaceNamed, SpaceTagged, ThreadId } from "@switch/brain"
import type { Database } from "bun:sqlite"
import type { Incoming, ModelTag, Rejected, TurnId } from "@switch/brain"
import {
  Context,
  Deferred,
  Effect,
  Fiber,
  FiberSet,
  Layer,
  Option,
  Semaphore,
  Stream,
} from "effect"

import { modelName } from "@switch/models"
import type { Profile, Subscription } from "@switch/models"

import { accountOf, allAccounts, reportAccount } from "./accounts.ts"
import type { CliMessage } from "./claude.ts"
import { delegation as makeDelegation } from "./delegate.ts"
import type { DelegateArgs, Delegation, TaskInfo, TaskStatus } from "./delegate.ts"
import {
  allThreads,
  CUT_OFF,
  LIMIT_OFF,
  MOVED,
  PAUSED,
  Delegate,
  getThread,
  items,
  OpenThread,
  TaskDropped,
  TaskEnded,
  ThreadSession,
  ThreadStaged,
  ThreadWaiting,
  threadsWaiting,
  TurnEnded,
  TurnInjected,
  TurnModel,
  TurnStarted,
  stillGoing,
  taskEnd,
  waitingEvent,
  waitingFor,
  waitingRows,
} from "./events.ts"
import type { Permissions, Thread, ThreadStatus, TurnEnd as Ended, Waiting } from "./events.ts"
import { Hosts, providerOf, workOn } from "./hosts.ts"
import { sameWork } from "./overlap.ts"
import type { Host, Machine, NoHost, Window } from "./hosts.ts"
import { adapters, route } from "./route.ts"
import type { Image, Runner } from "./provider.ts"
import { build } from "./transcript.ts"
import { absorb, endOf, event, newTurn, owe, STOPPED } from "./turn.ts"
import type { Running } from "./turn.ts"
import type { ReportsShape } from "./slots.ts"

export interface SessionsConfig {
  /** Identity. A process keeps the system prompt it started with. */
  /** Who the agent is: read at each launch, so a change reaches the next process. */
  readonly system: Effect.Effect<string>
  /** Where the core serves `delegation`, as a session on `machine` reaches it. */
  readonly delegateUrl: (machine: Machine) => string
  /** The apps' tools, for every session. */
  readonly appsUrl?: (machine: Machine) => Effect.Effect<string>
  /** Apps a one-off run (`once`) doesn't see: about a work's own history, which it hasn't. */
  readonly worksOnly?: readonly string[]
  /** After identity at launch: the stable part of a thread's context, such as its memory. */
  readonly stable?: (thread: Thread) => Effect.Effect<string>
  /** Claude Code settings JSON for every session on `machine`: autonomy's hooks, its guard. */
  readonly settings?: (machine: Machine) => Effect.Effect<string>
  /** Folder for new top-level threads. */
  readonly cwd: string
  /** The thread's project folder on each machine that has it, by machine: its turns go there. */
  readonly folders?: (thread: Thread) => Effect.Effect<ReadonlyMap<string, string>>
  /** The subscription a tier ("heavy", "mid", "light") runs on now: the profile's. Claude when unset. */
  readonly provider?: () => Subscription
  readonly profile?: Effect.Effect<Profile>
  readonly model?: string
  /** The effort a turn takes when nothing says otherwise: the user's dial. */
  readonly effort?: Effect.Effect<string>
  readonly permissions?: Permissions
  /** What goes before each message: what changed since the thread last looked, and now. */
  readonly delta?: (thread: Thread, text: string) => Effect.Effect<string>
  /** How long a process stays open after a turn. */
  readonly liveMs?: number
  readonly cacheTtlMs?: number
  /** Rebuilt just before the cache expires when at least this big. */
  readonly compactIdleTokens?: number
  /** Rebuilt right after a turn when at least this big. */
  readonly compactTokens?: number
  /** Tokens of exchanges a rebuild keeps, newest first. */
  readonly keepTokens?: number
  /** Exchanges that keep their tool I/O in a rebuild. */
  readonly fullExchanges?: number
  /** Off: what a previous run left (cut turns, limits, broken sessions, idle timers) is left alone. */
  readonly recover?: boolean
  /**
   * Work for the user waits, as no account can take it: their words (`partway` false), or a turn
   * answering them that was cut off partway. They're told it waits until `resetAt` (claude/src/
   * turn.rs:512-538 `waiting`, said for each turn that couldn't start).
   */
  readonly waiting?: (
    thread: ThreadId,
    resetAt: number | null,
    partway: boolean,
    /** The waiting work's own: they're told once for it, across restarts. */
    key: string,
  ) => Effect.Effect<void>
  /** A task's report, read as its turn ends: why it goes back to the task first, or null. */
  readonly report?: ReportsShape["read"]
}

export interface SendOptions {
  /** These four only when it opens the thread. */
  readonly title?: string
  readonly cwd?: string
  readonly model?: string
  readonly permissions?: Permissions
  /** From this message on. */
  readonly effort?: string
  /** Close the process when the turn ends, rather than keep it live. */
  readonly once?: boolean
  /** A pinned account for a one-shot completion. */
  readonly account?: string
  readonly eligibleAccounts?: ReadonlySet<string>
  /** Images the message carries, for the model to see. */
  readonly images?: readonly Image[]
  /** For the agent beside the user's words, not one of them: in the message's delta block. */
  readonly note?: string
  /**
   * The senses start it: with no words of the user's (only a `note`), it's recorded as theirs, so
   * nothing shows it running, as a check's fix turn.
   */
  readonly sensed?: boolean
  /**
   * Derived from what it answers (an event's seq): it's recorded before it starts, so a restart
   * can't lose it, and sending it again does nothing.
   */
  readonly id?: string
}

export interface SessionsShape {
  /** Starts a turn, or steers the running one. Resolves with the turn's id once it's sent. */
  readonly send: (
    thread: ThreadId,
    text: string,
    options?: SendOptions,
  ) => Effect.Effect<TurnId, NoHost | Rejected>
  /** Opens the thread and starts its process ahead of a message, so the message doesn't wait for it. */
  readonly warm: (thread: ThreadId, options?: SendOptions) => Effect.Effect<void, NoHost | Rejected>
  /**
   * A "wake" item: after the step under way of a running turn, or a turn of its own. Its text
   * stays in the turn unless it's `owed`: it bears on the user's words, so the chat gets it. One
   * the senses woke (`sensed`) is Switchboard's wake role; any other (an answer, a task's end, an
   * expectation) comes back to the work as a steer did there.
   */
  readonly wake: (
    thread: ThreadId,
    text: string,
    from?: "owed" | "sensed" | "steer",
    /** As SendOptions has it; a fresh one when unset. */
    id?: string,
  ) => Effect.Effect<void, NoHost | Rejected>
  /** Starts what waits for the thread in the record (`waitingEvent`), or joins it to its running turn. */
  readonly kick: (thread: ThreadId) => Effect.Effect<void>
  readonly interrupt: (thread: ThreadId) => Effect.Effect<void>
  /** Whether the thread's step under way is one the senses woke, with no words of the user's. */
  readonly woken: (thread: ThreadId) => boolean
  /** Whether the thread's step under way answers the user's words: only such a step's text is posted. */
  readonly answering: (thread: ThreadId) => boolean
  /** Rebuilds the session from the brain's record. */
  readonly compact: (thread: ThreadId) => Effect.Effect<void>
  readonly ended: (turn: TurnId) => Effect.Effect<Ended>
  /** The delegation MCP route, served at `delegateUrl`. */
  readonly delegation: (request: Request) => Promise<Response>
  /**
   * Marks a host at its usage limit until `until`, as a turn hitting one does: threads running on
   * it stop and carry on on another host, and the host comes back once the limit lifts.
   */
  readonly limit: (host: string, until: number) => Effect.Effect<void>
  /**
   * Pauses every running turn for an update, just before the deploy restarts the core: each ends
   * as paused, not the user's Stop, and the next core carries it on. Resolves with how many.
   */
  readonly pause: Effect.Effect<number>
  /**
   * Another model profile was selected: each turn under way on a provider it no longer runs on is
   * paused as for an update and carries on at once on the new one (from the record where its
   * session can't go), and what waits for a host starts. The user, Nov 23: "if i switch back to
   * claude, it should move all existing work over too. similar to a redeploy".
   */
  readonly move: Effect.Effect<void>
}

const deltaBlock = (inside: string) => `<brain-delta>\n${inside}\n</brain-delta>`

const SYSTEM = `
A message may open with a <brain-delta> block: what changed elsewhere since you last looked, or what came up while you worked, including delegated tasks ending, and which of the user's words were dictated. Use what bears on the work; ignore the rest silently.`

const kindOf = (b: unknown) => (typeof b === "object" && b !== null && "kind" in b ? b.kind : null)
const wordsOf = (b: unknown) =>
  typeof b === "object" && b !== null && "text" in b && typeof b.text === "string"
    ? b.text.trim()
    : ""
const sensedWake = (b: unknown) =>
  kindOf(b) === "wake" && typeof b === "object" && b !== null && "sensed" in b && b.sensed === true
const sensedStart = (b: unknown) =>
  kindOf(b) === "user" && typeof b === "object" && b !== null && "sensed" in b && b.sensed === true
/** The user's words a carried-on reply is owed to, as its start or wake recorded them. */
const owesOf = (b: unknown) =>
  typeof b === "object" && b !== null && "owes" in b && typeof b.owes === "string"
    ? b.owes.trim()
    : ""

interface Cut {
  readonly from: "owed" | "sensed" | "steer"
  /** The user's words it was answering: a turn cut before its process read them carries them on. */
  readonly words: string
}

/** A cut turn whose items are gone: it still owes the user its reply. */
const OWED: Cut = { from: "owed", words: "" }

/**
 * What a cut turn was, by its items: answering the user (their words began it or a steer of theirs
 * joined), woken by the senses (a sensed wake, none of their words), or another wake.
 */
const cutAs = (db: Database, turn: TurnId): Cut => {
  const said = db
    .query<{ body: string }, [string]>(
      `SELECT i.body FROM turn_spans span JOIN thread_items i ON i.thread = span.thread
         AND i.seq BETWEEN span.first AND span.last
       WHERE span.turn = ? AND i.turn = span.turn ORDER BY i.seq`,
    )
    .all(turn)
    .map((r): unknown => JSON.parse(r.body))
  const theirs = said.filter(
    (b) => (kindOf(b) === "user" && wordsOf(b) !== "") || kindOf(b) === "steer",
  )
  // A reply carried on before owes the words it was owed to still, cut again or not.
  const owed = said.map(owesOf).filter((w) => w !== "")
  if (theirs.length > 0 || owed.length > 0) {
    const words = [...new Set([...owed, ...theirs.map(wordsOf)])].filter((w) => w !== "")
    return { from: "owed", words: words.join("\n\n") }
  }
  return {
    from: said.some(sensedWake) || said.some(sensedStart) ? "sensed" : "steer",
    words: "",
  }
}

// A turn a usage limit cut off carries on in a turn that shows nothing of its own (its words go in
// its brain delta, as Switchboard's `carrying_on` went after the context: claude/src/turn.rs:541-551).
const LIMIT_CUT =
  "Your last turn was cut off partway by a usage limit and carries on here. Pick up where you left off, without redoing what's done."
// A turn cut off from outside (a restart, a stray reap) carries on in its session: Switchboard's
// runner did, and a cut turn otherwise ends failed and is never picked up again.
const CUT = "Your last turn was cut off when its host restarted. Pick up where it left off."
// A turn the deploy paused (ship.sh) carries on the same way once the updated core is live; what
// it started outside the turn went with the old core's processes.
const PAUSE =
  "Your last turn was paused for an update to Switch, which is live now. Anything you left running (background commands, servers, watchers) may have stopped: check before carrying on. Pick up where it left off."
// A turn whose login turned out signed out carries on the same way on another account.
const SIGNED_OUT_CUT =
  "Your last turn's account turned out to be signed out, and it carries on here on another. Pick up where it left off."
// A turn moved to another profile carries on the same way, at once (`move`).
const MOVE =
  "Your last turn was moved to another model profile partway, and carries on here. Pick up where it left off, without redoing what's done."
/** What a carried-on turn's wake opens with. */
const CARRIED = [LIMIT_CUT, CUT, PAUSE, MOVE, SIGNED_OUT_CUT]
/** A process ended by SIGTERM or SIGKILL, or with its host's link (remote.ts ends those with -1). */
const SIGNALLED = new Set([143, 137, -1])
/** How often work waiting for a host looks again: an account's limit may lift, its machine link back, or the profile change. A cut turn's carry-on waits for it too, so the core serves its tools first. */
const WAIT_RETRY = "5 seconds"
/** Cut-offs in a row a thread carries on from; then it fails, so a turn that kills its host can't loop. */
const MAX_CUTS = 3
const MINUTE = 60_000

/**
 * What a turn the run before this one ended carries on with now: one paused for the update that
 * started this core, or one moved to another profile (a build before this one carried that on in
 * memory only).
 */
const leftOff = (t: Thread) => {
  // Running in the record (events.ts), or interrupted as a build before that one recorded it.
  if (t.result === PAUSED && (t.status === "running" || t.status === "interrupted")) {
    return PAUSE
  }
  return t.status === "interrupted" && t.result === MOVED ? MOVE : null
}

/** The turns cut off in a row that a thread's last turns ended on, by the record. */
const cutsInARow = (db: Database, thread: ThreadId) => {
  const ends = db
    .query<{ status: string; result: string }, [string]>(
      `SELECT json_extract(payload, '$.status') AS status, json_extract(payload, '$.result') AS result
       FROM events WHERE type = 'turn.ended' AND json_extract(payload, '$.thread') = ?
       ORDER BY seq DESC LIMIT 20`,
    )
    .all(thread)
  let n = 0
  for (const e of ends) {
    if (e.status !== "interrupted") {
      break
    }
    if (e.result === CUT_OFF) {
      n += 1
    }
  }
  return n
}

// A login that isn't signed in, as a turn on it ends.
const SIGNED_OUT =
  /isn't signed in|not logged in|please run \/login|invalid api key|authentication required|failed to authenticate|oauth session expired/iu

/** Whether the thread's last turn before this one also failed on a login that was signed out. */
const signedOutBefore = (db: Database, thread: ThreadId) => {
  const last = db
    .query<{ status: string; result: string }, [string]>(
      `SELECT json_extract(payload, '$.status') AS status, json_extract(payload, '$.result') AS result
       FROM events WHERE type = 'turn.ended' AND json_extract(payload, '$.thread') = ?
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(thread)
  return last !== null && last.status === "failed" && SIGNED_OUT.test(last.result)
}

/** What a turn that ended this way carries on with, if it does. */
const carryWhy = (db: Database, thread: ThreadId, end: Ended) => {
  if (end.status === "limited") {
    return LIMIT_CUT
  }
  // Its login was signed out: another account takes it, once, so a turn every login fails on
  // ends rather than going round.
  if (end.status === "failed" && SIGNED_OUT.test(end.result)) {
    return signedOutBefore(db, thread) ? null : SIGNED_OUT_CUT
  }
  if (end.status !== "interrupted") {
    return null
  }
  if (end.result === MOVED) {
    return MOVE
  }
  if (end.result === LIMIT_OFF) {
    return LIMIT_CUT
  }
  return end.result === CUT_OFF && cutsInARow(db, thread) < MAX_CUTS ? CUT : null
}

/**
 * A cut turn's carry-on, as it waits in the record: it carries on as what it was. One answering the
 * user still owes them its reply; one the senses woke stays woken, as a cut turn was picked up in its
 * own work and role there (claude/src/main.rs: 316-326 `resume`, a steer in that work; 484-490
 * `work_role`); any other comes back as it came. Their words go with it, in its note and as what it
 * owes: a turn cut as it started may never have reached its session, and one cut again owes them
 * still. It starts once a host can take it (`kick`, `drain`).
 */
const carryEvent = (thread: ThreadId, key: string, cut: Cut, why: string) =>
  waitingEvent(`carry:${key}`, {
    thread,
    text: "",
    note: cut.words === "" ? why : `${why}\nThe user's words it was answering:\n${cut.words}`,
    from: cut.from,
    ...(cut.from === "owed" && cut.words !== "" && { owes: cut.words }),
  })

const hasWork = (w: Waiting) =>
  w.text.trim() !== "" || w.note.trim() !== "" || (w.images ?? []).length > 0

/** What waited and what comes now, as one turn's: their words, the notes, images, effort and kind. */
const merged = (queued: readonly Waiting[], own: Waiting) => {
  const all = hasWork(own) ? [...queued, own] : queued
  let from: Cut["from"] = "steer"
  if (all.some((w) => w.from === "owed" || w.text.trim() !== "")) {
    from = "owed"
  } else if (all.length > 0 && all.every((w) => w.from === "sensed")) {
    from = "sensed"
  }
  return {
    text: all
      .map((w) => w.text.trim())
      .filter((x) => x !== "")
      .join("\n\n"),
    wakeText: all
      .map((w) => w.note.trim())
      .filter((x) => x !== "")
      .join("\n"),
    images: all.flatMap((w) => w.images ?? []),
    effort: own.effort ?? queued.findLast((w) => w.effort !== undefined)?.effort,
    from,
    owes: [...new Set(all.map((w) => (w.owes ?? "").trim()).filter((x) => x !== ""))].join("\n\n"),
  }
}

/** Their words waiting, or a reply cut off partway that waits: they're told it waits. */
const partwayOf = (w: Waiting) =>
  w.text.trim() === "" && w.from === "owed" && CARRIED.some((c) => w.note.startsWith(c))

/** Cut by a usage limit, its carry-on not yet waiting in the record (a build before kept it in memory). */
const limitCut = (t: Thread) =>
  t.status === "limited" || (t.status === "interrupted" && t.result === LIMIT_OFF)

const DEFAULT_PERMISSIONS: Permissions = {
  tools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"],
  mode: "bypassPermissions",
  delegate: true,
}

interface Live {
  readonly thread: ThreadId
  readonly once: boolean
  readonly host: Host
  readonly session: string
  readonly runner: Runner
  turn: Running | null
  stderr: string
  effort: string
  /** The model id it runs, as its provider names it. */
  readonly model: string
  /** That model's exact id, as its stream last said it. */
  resolved: string | null
}

/** What the agent writes on `live` is tagged with: the model, provider and account. */
const tagOf = (live: Live, id: string): ModelTag => ({
  id,
  name: modelName(id),
  provider: providerOf(live.host),
  account: live.host.id,
})

/** A tier or alias names no exact model until the stream says one; "default" names none. */
const knownModel = (live: Live) => live.resolved ?? (live.model === "default" ? null : live.model)

/** The turn's `turn.model` when its model is newly known or changed, else none. */
const retag = (live: Live, t: Running): Incoming[] => {
  const id = t.model ?? (t.tagged === null ? knownModel(live) : null)
  if (t.model !== null) {
    live.resolved = t.model
  }
  if (id === null || id === t.tagged) {
    return []
  }
  t.tagged = id
  t.n += 1
  return [
    event(`${t.id}:model:${String(t.n)}`, TurnModel.type, {
      thread: live.thread,
      turn: t.id,
      model: tagOf(live, id),
    }),
  ]
}

const claudeOnly = (): Subscription => "claude"

/** A session on a lapsing token takes no new turn with less than this left of it. */
const FRESH_MS = 2 * 60 * MINUTE

// The API refused the session itself (a bad id in it, say): every turn on it fails the same way.
const BROKEN_SESSION = /API Error: 400 messages\./u

const TASK_STATUS: Readonly<Record<ThreadStatus, TaskStatus>> = {
  idle: "queued",
  running: "running",
  done: "completed",
  waiting: "waiting",
  limited: "waiting",
  interrupted: "cancelled",
  failed: "failed",
}

const info = (t: Thread): TaskInfo => ({
  taskId: t.thread,
  title: t.title,
  status: TASK_STATUS[t.status],
  summary: t.result,
  costUsd: t.costUsd,
  link: `switchboard://thread/${t.thread}`,
})

// The session's reads of the brain, by name (reads.ts), so they run in a reader thread.
const threadRead = defineRead("agent/sessions/thread", (db, thread: ThreadId) =>
  getThread(db, thread),
)
const allThreadsRead = defineRead("agent/sessions/all-threads", (db) => allThreads(db))
const childrenRead = defineRead("agent/sessions/children", (db, task: ThreadId) =>
  allThreads(db).filter((c) => c.parent === task),
)
const historyRead = defineRead(
  "agent/sessions/history",
  (db, thread: ThreadId, full: number, budget: number) =>
    build(items(db, thread), { full, budget }),
)
const taskEndRead = defineRead(
  "agent/sessions/task-end",
  (db, task: ThreadId, status: string, turn: string) => taskEnd(db, task, status, turn),
)
const stillGoingRead = defineRead("agent/sessions/still-going", (db, thread: ThreadId) =>
  stillGoing(db, thread),
)
const cutsInARowRead = defineRead("agent/sessions/cuts-in-a-row", (db, thread: ThreadId) =>
  cutsInARow(db, thread),
)
const cutAsRead = defineRead("agent/sessions/cut-as", (db, turn: TurnId) => cutAs(db, turn))
const waitingRowsRead = defineRead("agent/sessions/waiting-rows", (db, thread: ThreadId) =>
  waitingRows(db, thread),
)
const waitingForRead = defineRead("agent/sessions/waiting-for", (db, thread: ThreadId) =>
  waitingFor(db, thread),
)
const threadsWaitingRead = defineRead("agent/sessions/threads-waiting", (db) => threadsWaiting(db))
const accountsRead = defineRead("agent/sessions/accounts", (db) => allAccounts(db))
const spaceNamedRead = defineRead("agent/sessions/space-named", (db, given: string) =>
  spaceNamed(db, given),
)

/**
 * What a turn's end reads for its one write: a task's end, as its parent hears of it (`task`, null
 * when it wakes no parent), and the cut a turn that carries on carries on as (`thread`, null for a
 * one-off session that never carries on).
 */
const endRead = defineRead(
  "agent/sessions/end",
  (db, task: ThreadId | null, thread: ThreadId | null, turn: TurnId, end: Ended) => {
    const why = thread === null ? null : carryWhy(db, thread, end)
    return {
      ended: task === null ? null : taskEnd(db, task, end.status, turn),
      carry: why === null ? null : { why, cut: cutAs(db, turn) },
    }
  },
)

/** A turn's end, by the record. */
const turnEndedRead = defineRead("agent/sessions/turn-ended", (db, turn: TurnId) => {
  const row = db
    .query<{ payload: string }, [string]>(
      "SELECT payload FROM events WHERE type = 'turn.ended' AND json_extract(payload, '$.turn') = ?",
    )
    .get(turn)
  return row ? TurnEnded.decode(JSON.parse(row.payload)) : null
})

/**
 * A new task that's the same work as one already running (`sameWork`), unless it's a retry of
 * itself (`id` is there), its parent is gone, or it says how it differs (`separate`).
 */
const sameRead = defineRead(
  "agent/sessions/same-work",
  (
    db,
    parent: ThreadId,
    id: ThreadId,
    separate: boolean,
    cwd: string | null,
    title: string,
    task: string,
  ) => {
    const from = getThread(db, parent)
    if (getThread(db, id) !== null || from === null || separate) {
      return null
    }
    return sameWork(db, cwd ?? from.cwd, title, task, id, parent)
  },
)

/** A turn the run before cut off, carried on unless the thread's been cut too often in a row. */
const carriedRead = defineRead("agent/sessions/carried", (db, thread: ThreadId, turn: TurnId) =>
  cutsInARow(db, thread) < MAX_CUTS ? [carryEvent(thread, turn, cutAs(db, turn), CUT)] : [],
)

const makeSessions = Effect.fnUntraced(function* makeSessions(config: SessionsConfig) {
  const brain = yield* Brain
  const hosts = yield* Hosts
  const fibers = yield* FiberSet.make()
  const fork = <A, E>(effect: Effect.Effect<A, E>) =>
    FiberSet.run(fibers, Effect.catchCause(effect, Effect.logError))

  const liveMs = config.liveMs ?? 10 * MINUTE
  const ttl = config.cacheTtlMs ?? 60 * MINUTE
  const compactIdleTokens = config.compactIdleTokens ?? 60_000
  // From replaying three days of the busiest spaces' turns (Nov 23): reads of the live session cost
  // most, so each 20k less kept saves 5 to 9%, and the threshold barely moves the bill between 200k
  // and 300k. 80k is the least that kept more exchanges than 100k with old wakes' whole deltas did,
  // in every big space; at 60k, one long exchange shut out all older ones.
  const compactTokens = config.compactTokens ?? 250_000
  const keepTokens = config.keepTokens ?? 80_000
  const full = config.fullExchanges ?? 3
  const defaultEffort = config.effort ?? Effect.succeed("medium")
  const providerNow = config.provider ?? claudeOnly
  const selection = (model: string) => {
    if (config.profile) {
      return config.profile.pipe(Effect.map((profile) => route(model, profile)))
    }
    return Effect.sync(() => route(model, providerNow()))
  }

  const lives = new Map<string, Live>()
  const locks = new Map<string, Semaphore.Semaphore>()
  const timers = new Map<string, Fiber.Fiber<unknown>>()
  const waiters = new Map<string, Deferred.Deferred<Ended>>()
  const once = new Set<string>()
  const completionAccounts = new Map<string, string>()
  const completionEligible = new Map<string, ReadonlySet<string>>()
  /** Waiting work they've been told of this run (each is told once, by its key, across runs too). */
  const told = new Set<number>()
  /** The core stopping: what it cuts off stays running in the record, for the next run. */
  let stopping = false

  const lock = (thread: ThreadId) => {
    let s = locks.get(thread)
    if (!s) {
      s = Semaphore.makeUnsafe(1)
      locks.set(thread, s)
    }
    return s
  }
  const read = (thread: ThreadId) => brain.read(threadRead, thread)
  const ingest = (events: readonly Incoming[]) => Effect.orDie(brain.ingest(events))
  const cancelTimer = (thread: ThreadId) =>
    Effect.suspend(() => {
      const t = timers.get(thread)
      timers.delete(thread)
      return t ? Fiber.interrupt(t) : Effect.void
    })

  const close = (live: Live) =>
    Effect.sync(() => {
      if (lives.get(live.thread) === live) {
        lives.delete(live.thread)
      }
      live.runner.proc.end()
      const killer = setTimeout(() => {
        live.runner.proc.kill()
      }, 5000)
      void live.runner.proc.exited.finally(() => {
        clearTimeout(killer)
      })
    })

  // Accounts: health and usage into the brain when it changes in a way that matters.
  const report = (id: string) =>
    Effect.gen(function* reporting() {
      const state = (yield* hosts.states).find((h) => h.account === hosts.account(id))
      if (state) {
        yield* reportAccount(accountOf(state)).pipe(Effect.provideService(Brain, brain))
      }
    })

  const learn = (id: string, batch: readonly CliMessage[]) =>
    Effect.gen(function* learning() {
      const limits = batch.findLast((m) => m.type === "rate_limit_event")?.rate_limit_info
      if (!limits?.unifiedWindows) {
        return
      }
      const windows: Window[] = Object.entries(limits.unifiedWindows).map(([name, w]) => ({
        name,
        used: w.utilization ?? 0,
        resetsAt: (w.resetsAt ?? 0) * 1000,
      }))
      if (yield* hosts.learn(id, windows)) {
        yield* report(id)
      }
    })

  const launch: (
    t: Thread,
    host: Host,
    effort: string,
    selected: ReturnType<typeof route>,
  ) => Effect.Effect<Live> = Effect.fnUntraced(function* launching(
    t: Thread,
    host: Host,
    effort: string,
    selected: ReturnType<typeof route>,
  ) {
    // A folder of its own (a task's), else the project's on this machine, else the default; and
    // the machine's home when it hasn't that.
    const folders = config.folders ? yield* config.folders(t) : new Map<string, string>()
    const m = host.machine
    const wanted = t.cwd === config.cwd ? (folders.get(m.id) ?? t.cwd) : t.cwd
    const cwd = (yield* m.realpath(wanted)) ?? (yield* m.realpath(m.home)) ?? m.home
    const { provider, id: model } = selected
    const before = t.host === null ? undefined : hosts.get(t.host)
    // A session moves within a provider; the adapter starts a new one where this login can't
    // see it, from the record.
    const same = before !== undefined && providerOf(before) === provider
    const stable = config.stable ? (yield* config.stable(t)).trim() : ""
    const mcp: Record<string, { url: string; token?: string }> = {}
    if (t.permissions.delegate) {
      mcp.switch = { url: config.delegateUrl(host.machine), token: delegation.token(t.thread) }
    }
    const look = t.permissions.apps === "look"
    if (config.appsUrl !== undefined && (t.permissions.tools.length > 0 || look)) {
      // The thread rides along, so a call that speaks for the user is held in its space.
      const apps = new URL(yield* config.appsUrl(host.machine))
      apps.searchParams.set("thread", t.thread)
      if (look) {
        apps.searchParams.set("look", "1")
      }
      if (once.has(t.thread)) {
        for (const app of config.worksOnly ?? []) {
          apps.searchParams.append("without", app)
        }
      }
      mcp.apps = { url: apps.toString() }
    }
    return yield* Effect.acquireUseRelease(
      adapters[provider]
        .start({
          host: workOn(host, t.thread),
          cwd,
          session: same ? t.session : null,
          history: () => brain.read(historyRead, t.thread, full, keepTokens),
          model,
          effort,
          system: [(yield* config.system).trim(), SYSTEM, stable]
            .filter((s) => s !== "")
            .join("\n\n"),
          permissions: t.permissions,
          mcp,
          ...(config.settings === undefined || t.permissions.tools.length === 0
            ? {}
            : { settings: yield* config.settings(host.machine) }),
        })
        .pipe(Effect.interruptible),
      (runner) =>
        Effect.gen(function* registering() {
          const { session } = runner
          if (session !== t.session) {
            yield* ingest([
              event(`session:${session}`, ThreadSession.type, {
                thread: t.thread,
                host: host.id,
                session,
              }),
            ])
          }
          const live: Live = {
            thread: t.thread,
            once: once.has(t.thread),
            host,
            session,
            runner,
            turn: null,
            stderr: "",
            effort,
            model,
            resolved: null,
          }
          lives.set(t.thread, live)
          void new Response(runner.proc.stderr).text().then((s) => {
            live.stderr = s.slice(-2000)
            return s
          })
          yield* fork(reader(live))
          return live
        }),
      (runner, exit) =>
        exit._tag === "Failure"
          ? Effect.sync(() => {
              runner.proc.kill("SIGKILL")
            })
          : Effect.void,
    )
  })

  // After a turn's end is in the brain.
  const finish: (live: Live, t: Running, end: Ended) => Effect.Effect<void> = Effect.fnUntraced(
    function* finishing(live: Live, t: Running, end: Ended) {
      yield* hosts.end(live.host.id)
      yield* report(live.host.id)
      const waiter = waiters.get(t.id)
      waiters.delete(t.id)
      if (waiter) {
        yield* Deferred.succeed(waiter, end)
      }
      if (end.status === "limited") {
        // It carries on on another account, or waits for one (its end recorded that); owed the
        // user a reply it never gave, they hear that it waits when none can take it.
        yield* close(live)
        yield* limit(live.host.id, end.resetAt ?? Date.now() + 15 * MINUTE)
      } else if (end.status === "failed" && SIGNED_OUT.test(end.result)) {
        // The login can't run turns until the user signs it in; others take its threads meanwhile,
        // this one's included (its end recorded its carry-on).
        yield* close(live)
        yield* hosts.limit(live.host.id, Date.now() + 10 * MINUTE, "Signed out")
        yield* report(live.host.id)
      } else if (end.status === "failed" && BROKEN_SESSION.test(end.result) && !live.once) {
        // The next turn starts one from the record.
        yield* fork(compact(t.thread.thread))
      } else if (live.once) {
        yield* close(live)
      } else if (end.context >= compactTokens) {
        yield* fork(compact(t.thread.thread))
      } else {
        yield* arm(t.thread.thread, Date.now(), end.context)
      }
      once.delete(t.thread.thread)
      completionAccounts.delete(t.thread.thread)
      completionEligible.delete(t.thread.thread)
      const { parent } = t.thread
      if (parent !== null && end.status !== "interrupted") {
        yield* fork(Effect.ignore(kick(parent)))
      }
    },
  )

  /**
   * What a turn's end is written with, in its one write: a task's end and the wake it owes its
   * parent, and the carry-on of a turn cut off partway. A restart between them can't lose either.
   */
  const endWrites = (live: Live, t: Running, end: Ended) => {
    const { parent } = t.thread
    // A cancelled task's parent already knows.
    const toParent = parent !== null && end.status !== "interrupted"
    const task = toParent ? t.thread.thread : null
    const reading = brain.read(endRead, task, live.once ? null : live.thread, t.id, end)
    return reading.pipe(
      Effect.map(({ ended, carry }): Incoming[] => {
        const out: Incoming[] = []
        if (parent !== null && task !== null) {
          out.push(
            event(`${t.id}:task`, TaskEnded.type, {
              task,
              parent,
              title: t.thread.title,
              status: end.status,
              result: end.result,
              costUsd: end.costUsd,
              ...(t.tagged !== null && { model: tagOf(live, t.tagged) }),
            }),
          )
          // Its progress, while its work carries on by itself, stays on its row: the parent wakes
          // for its end.
          if (ended !== null) {
            out.push(
              waitingEvent(`${t.id}:task:wake`, {
                thread: parent,
                text: "",
                note: `Task ${task} "${t.thread.title}" ${ended}: ${end.result}`,
                from: "steer",
              }),
            )
          }
        }
        if (carry !== null) {
          const { cut, why } = carry
          // One that hit its limit after it replied owes the user nothing more.
          const as =
            end.status === "limited" && t.replies.length > 0
              ? { ...cut, from: "steer" as const }
              : cut
          out.push(carryEvent(live.thread, t.id, as, why))
        }
        return out
      }),
    )
  }

  // Claude Code's output, coalesced over 50 ms into one ingest per batch.
  const begin = Effect.fnUntraced(function* beginning(
    live: Live,
    turn: Running,
    text: string,
    delta: string,
    wake: string,
    sensed?: boolean,
    owes?: string,
  ) {
    live.turn = turn
    turn.promises = !live.once
    waiters.set(turn.id, yield* Deferred.make<Ended>())
    yield* ingest([
      event(`${turn.id}:start`, TurnStarted.type, {
        thread: live.thread,
        turn: turn.id,
        host: live.host.id,
        session: live.session,
        text,
        delta,
        ...(wake !== "" && { wake }),
        model: live.model,
        effort: live.effort,
        ...(sensed === true && { sensed: true }),
        ...(owes !== undefined && owes !== "" && { owes }),
      }),
      ...retag(live, turn),
    ])
    yield* hosts.begin(live.host.id)
    yield* report(live.host.id)
    return turn
  })

  // Claude Code starts a turn of its own when background work it ran finishes.
  const adopt = Effect.fnUntraced(function* adopting(live: Live) {
    const row = yield* read(live.thread)
    if (live.turn || !row) {
      return live.turn
    }
    return yield* begin(live, newTurn(row), "", "", "")
  })

  // One line back into a turn about to end, as a step of its own: not the user's words, so what
  // it answers stays in the turn.
  const remind = Effect.fnUntraced(function* reminding(live: Live, t: Running, text: string) {
    const uuid = crypto.randomUUID()
    t.pending.set(uuid, "queued")
    // A line back into a step the senses woke is that step's too.
    if (t.woken) {
      t.sensed.add(uuid)
    }
    yield* ingest([
      event(`${t.id}:${uuid}`, TurnInjected.type, {
        thread: live.thread,
        turn: t.id,
        kind: "wake",
        text,
        ...(t.woken && { sensed: true }),
      }),
    ])
    yield* live.runner.send(text, uuid, "next")
  })

  // A task's report is read before it reaches the user (autonomy's report check): what needs
  // their hands is an ask, not a report (Switchboard's sb/mcp.rs:2567). It goes back until it
  // passes or its last line bypasses the check (turn.ts `reportBypass`).
  const readReport = (live: Live, t: Running, end: Ended) => {
    if (
      config.report === undefined ||
      live.once ||
      t.thread.parent === null ||
      end.status !== "done" ||
      end.result.trim() === ""
    ) {
      return Effect.succeed(null)
    }
    const readOf = config.report
    // Progress no one is woken for isn't read.
    return Effect.flatMap(brain.read(taskEndRead, t.thread.thread, end.status, t.id), (ended) =>
      ended === null
        ? Effect.succeed(null)
        : readOf({
            thread: t.thread.thread,
            turn: t.id,
            title: t.thread.title,
            text: end.result,
            ...(t.bypass !== null && { bypass: t.bypass }),
          }),
    )
  }

  const handle = Effect.fnUntraced(function* handling(live: Live, batch: readonly CliMessage[]) {
    yield* learn(live.host.id, batch)
    const own = batch.some((m) => m.type === "assistant" || m.type === "stream_event")
    const t = live.turn ?? (own ? yield* adopt(live) : null)
    if (!t) {
      return
    }
    const absorbed = absorb(t, batch)
    const { end, nudge } = absorbed
    // Its model first, so what the batch's calls write is tagged with it.
    const drafts = [...retag(live, t), ...absorbed.drafts]
    const back = end === null ? null : yield* readReport(live, t, end)
    if (back !== null) {
      // Not its end yet: the task hears why, and its next end is read again.
      t.closing = null
      yield* ingest(drafts.filter((d) => d.type !== TurnEnded.type))
      yield* remind(live, t, back)
      return
    }
    if (end) {
      // Free the process for the next message before the write lands.
      live.turn = null
    }
    // Done while its work goes on (a watch of its own, a script it set), its end says so: it waits.
    const going = end?.status === "done" && (yield* brain.read(stillGoingRead, live.thread))
    const written = going
      ? drafts.map((d) => (d.type === TurnEnded.type ? { ...d, payload: { ...end, going } } : d))
      : drafts
    yield* ingest(end ? [...written, ...(yield* endWrites(live, t, end))] : written)
    if (nudge !== null) {
      yield* remind(live, t, nudge)
    }
    if (end) {
      yield* finish(live, t, end)
    }
  })

  const reader = (live: Live): Effect.Effect<void> =>
    Effect.gen(function* reading() {
      yield* live.runner.messages.pipe(
        Stream.groupedWithin(256, "50 millis"),
        Stream.runForEach((batch) => handle(live, batch)),
      )
      const code = yield* Effect.promise(async () => await live.runner.proc.exited)
      if (lives.get(live.thread) === live) {
        lives.delete(live.thread)
      }
      const t = live.turn
      if (t) {
        live.turn = null
        if (stopping && !t.interrupted) {
          return
        }
        const signalled = !live.once && !t.interrupted && SIGNALLED.has(code)
        const cut = signalled && (yield* brain.read(cutsInARowRead, live.thread)) < MAX_CUTS
        let end = endOf(
          t,
          "failed",
          live.stderr.trim() === ""
            ? `${providerOf(live.host)} exited with ${code}`
            : live.stderr.trim(),
        )
        if (t.interrupted) {
          end = endOf(t, "interrupted", t.cutBy ?? STOPPED)
        } else if (cut) {
          end = endOf(t, "interrupted", CUT_OFF)
        }
        // Cut, it carries on (`endWrites`) once the core serves again.
        yield* ingest([
          event(`${t.id}:end`, TurnEnded.type, end),
          ...(yield* endWrites(live, t, end)),
        ])
        yield* finish(live, t, end)
      }
    })

  // Closes the process once the thread goes quiet, and rebuilds a big session just before
  // its prompt cache expires: the next message would write all of it again anyway.
  const arm = (thread: ThreadId, endedAt: number, context: number) =>
    Effect.gen(function* arming() {
      yield* cancelTimer(thread)
      const timer = yield* fork(
        Effect.gen(function* waiting() {
          yield* Effect.sleep(Math.max(0, endedAt + liveMs - Date.now()))
          yield* lock(thread).withPermit(
            Effect.suspend(() => {
              const live = lives.get(thread)
              return live && !live.turn ? close(live) : Effect.void
            }),
          )
          if (context >= compactIdleTokens) {
            yield* Effect.sleep(Math.max(0, endedAt + ttl - 2 * MINUTE - Date.now()))
            yield* compact(thread)
          }
        }),
      )
      timers.set(thread, timer)
    })

  const compact = (thread: ThreadId): Effect.Effect<void> =>
    lock(thread).withPermit(
      Effect.gen(function* compacting() {
        const t = yield* read(thread)
        const live = lives.get(thread)
        if (!t || live?.turn) {
          return
        }
        if (live) {
          yield* close(live)
        }
        // No session: the next launch starts one from the record.
        if (t.host !== null) {
          yield* ingest([
            event(`session:compact:${crypto.randomUUID()}`, ThreadSession.type, {
              thread,
              host: t.host,
              session: "",
            }),
          ])
        }
      }),
    )

  const inject = Effect.fnUntraced(function* injecting(
    live: Live,
    t: Running,
    kind: "steer" | "wake",
    text: string,
    note: string,
    owed: boolean,
    sensed: boolean,
    images: readonly Image[] = [],
    /** The waiting work it carries in, and the words it owes from it. */
    took: readonly number[] = [],
    owes?: string,
  ) {
    const uuid = crypto.randomUUID()
    t.pending.set(uuid, "queued")
    if (owed) {
      owe(t, uuid)
    }
    if (sensed) {
      t.sensed.add(uuid)
    }
    const said = kind === "wake" ? deltaBlock(text) : text
    // A steer's note goes to the agent; the record keeps the user's words.
    const body = note === "" ? said : `${deltaBlock(note)}\n\n${said}`
    yield* ingest([
      event(`${t.id}:${uuid}`, TurnInjected.type, {
        thread: live.thread,
        turn: t.id,
        kind,
        text: said,
        ...(sensed && { sensed: true }),
        ...(owes !== undefined && owes !== "" && { owes }),
        ...(took.length > 0 && { took }),
      }),
    ])
    yield* live.runner.send(body, uuid, kind === "steer" ? "now" : "next", images)
    return t.id
  })

  // What waits joins the running turn: their words as a steer, else a wake.
  const injectWaiting = (
    live: Live,
    t: Running,
    queued: readonly { readonly seq: number; readonly w: Waiting }[],
  ) => {
    const m = merged(
      queued.map((r) => r.w),
      { thread: live.thread, text: "", note: "", from: "steer" },
    )
    const took = queued.map((r) => r.seq)
    return m.text === ""
      ? inject(
          live,
          t,
          "wake",
          m.wakeText,
          "",
          m.from === "owed",
          m.from === "sensed",
          [],
          took,
          m.owes,
        )
      : inject(live, t, "steer", m.text, m.wakeText, true, false, m.images, took, m.owes)
  }

  // Under the thread's lock.
  const ready = Effect.fnUntraced(function* readying(t: Thread, effort: string | undefined) {
    const live = lives.get(t.thread)
    // A thread stays on its host while its session is live or its prompt cache warm.
    const warmCache = live !== undefined || Date.now() - t.endedAt < ttl
    const folders = config.folders ? yield* config.folders(t) : new Map<string, string>()
    const selected = yield* selection(t.model)
    const host = yield* hosts.pick(
      warmCache ? t.host : null,
      selected.provider,
      new Set(folders.keys()),
      completionAccounts.get(t.thread) ?? selected.account,
      completionEligible.get(t.thread),
    )
    // A session started on a token that lapses soon starts again on a fresh one, in the same session.
    if (
      live &&
      live.host.id === host.id &&
      live.model === selected.id &&
      (live.runner.until ?? Number.POSITIVE_INFINITY) - Date.now() > FRESH_MS
    ) {
      return live
    }
    if (live) {
      yield* close(live)
    }
    return yield* launch(t, host, effort ?? (yield* defaultEffort), selected)
  })

  // Work no host can take waits in the record, and the first turn that starts takes it all in. The
  // user hears it waits when it's their words, or a reply to them cut off partway: once for each.
  const wait = (thread: ThreadId, w: Waiting, resetAt: number | null) =>
    Effect.gen(function* waiting() {
      if (once.has(thread)) {
        return
      }
      if (hasWork(w)) {
        yield* ingest([event(`waiting:${thread}:${crypto.randomUUID()}`, ThreadWaiting.type, w)])
      }
      const tell = config.waiting
      if (tell === undefined) {
        return
      }
      for (const { seq, w: x } of yield* brain.read(waitingRowsRead, thread)) {
        if (!told.has(seq) && (x.text.trim() !== "" || partwayOf(x))) {
          told.add(seq)
          yield* tell(thread, resetAt, partwayOf(x), `waiting:${String(seq)}`)
        }
      }
    })

  const start: (
    thread: ThreadId,
    text: string,
    wakeText: string,
    effort?: string,
    images?: readonly Image[],
    from?: "owed" | "sensed" | "steer",
  ) => Effect.Effect<TurnId, NoHost> = Effect.fnUntraced(function* starting(
    thread: ThreadId,
    given: string,
    givenWake: string,
    givenEffort?: string,
    givenImages: readonly Image[] = [],
    givenFrom: "owed" | "sensed" | "steer" = "steer",
  ) {
    const t = yield* read(thread)
    if (!t) {
      return yield* Effect.die(new Error(`No thread ${thread}`))
    }
    const own: Waiting = {
      thread,
      text: given,
      note: givenWake,
      from: givenFrom,
      ...(givenEffort === undefined ? {} : { effort: givenEffort }),
      ...(givenImages.length === 0 ? {} : { images: givenImages }),
    }
    // What waited for a host goes first, in the order it came.
    const queued = once.has(thread) ? [] : yield* brain.read(waitingForRead, thread)
    const { text, wakeText, images, effort, from, owes } = merged(queued, own)
    yield* cancelTimer(thread)
    const live = yield* Effect.catchTag(ready(t, effort), "NoHost", (e) =>
      Effect.andThen(wait(thread, own, e.resetAt), Effect.fail(e)),
    )
    if (effort !== undefined && effort !== live.effort) {
      live.effort = effort
      yield* live.runner.effort(effort)
    }
    const note = config.delta ? yield* config.delta(t, text) : ""
    const delta = [note.trim(), wakeText.trim()].filter((s) => s !== "").join("\n")
    const since = t.endedAt > 0 ? ` since="${new Date(t.endedAt).toISOString()}"` : ""
    const block = delta === "" ? "" : `<brain-delta${since}>\n${delta}\n</brain-delta>`
    // A turn the senses start is recorded as theirs, as Switchboard's ran in the kernel's own work.
    const turn = yield* begin(
      live,
      newTurn(t),
      text,
      block,
      wakeText.trim(),
      text.trim() === "" && from === "sensed",
      owes,
    )
    const uuid = crypto.randomUUID()
    turn.pending.set(uuid, "queued")
    // A turn a wake starts owes the user nothing, unless it picks up a reply owed to them.
    if (text.trim() !== "" || from === "owed") {
      owe(turn, uuid)
    }
    if (text.trim() === "" && from === "sensed") {
      turn.sensed.add(uuid)
    }
    yield* live.runner.send(
      [block, text].filter((s) => s !== "").join("\n\n"),
      uuid,
      undefined,
      images,
    )
    return turn.id
  })

  const open = (thread: ThreadId, options: SendOptions) =>
    Effect.gen(function* opening() {
      if (yield* read(thread)) {
        return
      }
      yield* brain.dispatch({
        id: `open:${thread}`,
        type: OpenThread.type,
        source: "agent",
        payload: {
          thread,
          parent: null,
          title: options.title ?? thread,
          cwd: options.cwd ?? config.cwd,
          model: options.model ?? config.model ?? "heavy",
          permissions: options.permissions ?? config.permissions ?? DEFAULT_PERMISSIONS,
        },
      })
    })

  // Starts what waits for the thread, or joins it to the running turn. Null when nothing waits (or
  // the thread isn't open yet: what waits starts with its first turn).
  const kick = (thread: ThreadId): Effect.Effect<TurnId | null, NoHost> =>
    lock(thread).withPermit(
      Effect.gen(function* kicking() {
        const t = yield* read(thread)
        const queued = yield* brain.read(waitingRowsRead, thread)
        if (once.has(thread) || t === null || queued.length === 0) {
          return null
        }
        const live = lives.get(thread)
        return live?.turn
          ? yield* injectWaiting(live, live.turn, queued)
          : yield* start(thread, "", "")
      }),
    )

  // A send with an id: recorded, then started or joined to the running turn.
  const sendRecorded = (thread: ThreadId, id: string, text: string, options: SendOptions) =>
    Effect.gen(function* recorded() {
      yield* ingest([
        waitingEvent(id, {
          thread,
          text,
          note: options.note ?? "",
          from: options.sensed === true ? "sensed" : "steer",
          ...(options.effort !== undefined && { effort: options.effort }),
          ...(options.images !== undefined &&
            options.images.length > 0 && { images: options.images }),
        }),
      ])
      const turn = (yield* kick(thread)) ?? (yield* read(thread))?.turn ?? null
      return turn ?? (yield* Effect.die(new Error(`No turn for ${id}`)))
    })

  const send = (
    thread: ThreadId,
    text: string,
    options: SendOptions = {},
  ): Effect.Effect<TurnId, NoHost | Rejected> =>
    options.id !== undefined && options.once !== true
      ? Effect.andThen(open(thread, options), sendRecorded(thread, options.id, text, options))
      : Effect.andThen(
          open(thread, options),
          lock(thread).withPermit(
            Effect.suspend(() => {
              if (options.once === true) {
                once.add(thread)
                if (options.eligibleAccounts !== undefined) {
                  completionEligible.set(thread, options.eligibleAccounts)
                }
                if (options.account !== undefined) {
                  completionAccounts.set(thread, options.account)
                }
              }
              const live = lives.get(thread)
              // A steer waits for running tools to finish.
              return live?.turn
                ? inject(
                    live,
                    live.turn,
                    "steer",
                    text,
                    options.note ?? "",
                    true,
                    false,
                    options.images,
                  )
                : start(
                    thread,
                    text,
                    options.note ?? "",
                    options.effort,
                    options.images,
                    options.sensed === true ? "sensed" : undefined,
                  )
            }),
          ),
        ).pipe(
          Effect.onExit((exit) =>
            exit._tag === "Failure"
              ? Effect.sync(() => {
                  once.delete(thread)
                  completionAccounts.delete(thread)
                  completionEligible.delete(thread)
                })
              : Effect.void,
          ),
        )

  const warm = (thread: ThreadId, options: SendOptions = {}) =>
    Effect.andThen(
      open(thread, options),
      lock(thread).withPermit(
        Effect.gen(function* warming() {
          const t = yield* read(thread)
          if (t && !lives.has(thread)) {
            yield* cancelTimer(thread)
            const live = yield* ready(t, options.effort)
            // Idle until a message comes; closed like any other once the thread goes quiet.
            yield* arm(thread, Date.now(), t.context)
            return live
          }
          return null
        }),
      ),
    )

  // `owed`: it bears on the user's words (a fix to them, or a cut reply picked up), so what its
  // step ends on is theirs. Any other wake's text stays in the turn.
  // Recorded first, so a restart can't lose it.
  const wake = (
    thread: ThreadId,
    text: string,
    from: "owed" | "sensed" | "steer" = "steer",
    id = `wake:${thread}:${crypto.randomUUID()}`,
  ): Effect.Effect<void, NoHost | Rejected> =>
    Effect.andThen(
      ingest([waitingEvent(id, { thread, text: "", note: text, from })]),
      Effect.asVoid(kick(thread)),
    )

  // `cutBy`: it's cut off from outside, and its end records that, not the user's Stop.
  const interrupt = (thread: ThreadId, cutBy: string | null = null) =>
    Effect.gen(function* interrupting() {
      const live = lives.get(thread)
      const t = live?.turn
      if (!live) {
        return
      }
      if (t) {
        t.cutBy = cutBy
      }
      if (live.once) {
        if (t) {
          t.interrupted = true
        }
        yield* close(live)
        live.runner.proc.kill("SIGKILL")
        return
      }
      if (!t) {
        return
      }
      t.interrupted = true
      yield* live.runner.interrupt
      const waiter = waiters.get(t.id)
      const ended = waiter
        ? yield* Effect.timeoutOption(Deferred.await(waiter), "10 seconds")
        : Option.none()
      if (Option.isNone(ended)) {
        // It didn't answer: the reader ends the turn once the process is gone.
        live.runner.proc.kill("SIGKILL")
      }
    })

  // Usage limits outlast a restart; a host whose limit lifted meanwhile is back. Being signed out
  // doesn't: it's found again at each start (an account added here, by its login; any other, by
  // its next turn), so a login that was signed out at the last start isn't held out for good.
  const restoreAccounts = Effect.fnUntraced(function* restoring() {
    for (const a of yield* brain.read(accountsRead)) {
      if (hosts.get(a.host)) {
        yield* hosts.learn(a.host, a.windows)
        if (a.limitedUntil > Date.now() && a.problem !== "Signed out") {
          yield* hosts.limit(a.host, a.limitedUntil, a.problem)
          yield* fork(comeBack(a.host, a.limitedUntil))
        }
      }
    }
    for (const h of hosts.all) {
      yield* report(h.id)
    }
  })

  const comeBack = (id: string, until: number) =>
    Effect.andThen(Effect.sleep(Math.max(0, until - Date.now()) + 1000), report(id))

  // A host at its limit: threads running there stop and carry on elsewhere.
  const limit = (id: string, until: number): Effect.Effect<void> =>
    Effect.gen(function* limiting() {
      yield* hosts.limit(id, until)
      yield* report(id)
      yield* fork(comeBack(id, until))
      const account = hosts.account(id)
      for (const live of [...lives.values()].filter((l) => hosts.account(l.host.id) === account)) {
        if (live.turn) {
          const { thread } = live
          // Its end records its carry-on (`endWrites`).
          yield* fork(live.once ? interrupt(thread) : interrupt(thread, LIMIT_OFF))
        } else {
          yield* lock(live.thread).withPermit(close(live))
        }
      }
    })

  // A machine gone: what ran there carries on where it fits now, from the record.
  hosts.onGone((machine) =>
    Effect.gen(function* handingOff() {
      for (const live of [...lives.values()].filter((l) => l.host.machine.id === machine)) {
        const { thread } = live
        if (live.once) {
          yield* fork(interrupt(live.thread))
          continue
        }
        const t = live.turn
        // Already being ended (paused for an update, or the user's Stop): that end stands, and a
        // paused one carries on in the next core, not here.
        if (t?.interrupted === true) {
          continue
        }
        // Cut, not stopped: it carries on as what it was once a host can take it (`endWrites`).
        yield* t ? fork(interrupt(thread, CUT_OFF)) : lock(thread).withPermit(close(live))
      }
    }),
  )

  // What waits for a host starts as soon as one can take it: a limit lifting, a machine linking
  // back, or another profile selected.
  const drain = Effect.gen(function* draining() {
    for (const thread of yield* brain.read(threadsWaitingRead)) {
      yield* Effect.ignore(kick(thread))
    }
  })

  // Another profile: turns under way on a provider it doesn't run them on pause, as for an update,
  // and carry on at once on the one it does.
  const move = Effect.gen(function* moving() {
    const running = [...lives.values()].filter((l) => !l.once && l.turn !== null)
    yield* Effect.forEach(
      running,
      (l) =>
        Effect.gen(function* movingOne() {
          const t = l.turn
          const row = yield* read(l.thread)
          const selected = yield* selection(row?.model ?? "heavy")
          if (t === null || selected.provider === providerOf(l.host)) {
            return
          }
          // Its end records its carry-on (`endWrites`), which `drain` starts.
          yield* interrupt(l.thread, MOVED)
        }),
      { concurrency: "unbounded", discard: true },
    )
    yield* drain
  })

  // Every turn under way, interrupted at once as paused; each waits for its end (interrupt's 10 s,
  // then killed). One-off turns (completions) aren't carried on, so they're left to the stop.
  const pause = Effect.suspend(() => {
    const running = [...lives.values()].filter((l) => !l.once && l.turn !== null)
    return Effect.as(
      Effect.forEach(running, (l) => interrupt(l.thread, PAUSED), { concurrency: "unbounded" }),
      running.length,
    )
  })

  const ended = (turn: TurnId) =>
    Effect.suspend(() => {
      const waiter = waiters.get(turn)
      if (waiter) {
        return Deferred.await(waiter)
      }
      return brain
        .read(turnEndedRead, turn)
        .pipe(
          Effect.flatMap((e) => (e ? Effect.succeed(e) : Effect.die(new Error(`No turn ${turn}`)))),
        )
    })

  // Delegation: a task is a child thread.
  const owned = (parent: ThreadId, task: ThreadId) =>
    Effect.flatMap(read(task), (t) =>
      t?.parent === parent ? Effect.succeed(t) : Effect.fail(`No task ${task}`),
    )

  const delegateTask = (parent: ThreadId, a: DelegateArgs): Effect.Effect<TaskInfo, string> =>
    Effect.gen(function* delegating() {
      const key = a.clientRequestId ?? crypto.randomUUID()
      const id = ThreadId.make(
        `task-${createHash("sha256").update(`${parent}\n${key}`).digest("hex").slice(0, 12)}`,
      )
      const title = a.title ?? a.task.slice(0, 60)
      // In the space it names, else its parent's (`spaceFor`): one it doesn't file, placeOf walks up.
      const space = a.space === null ? null : yield* brain.read(spaceNamedRead, a.space)
      // A retry is the same task; a new one that's the same work as a running one is refused.
      const same = yield* brain.read(
        sameRead,
        parent,
        id,
        a.separate !== null,
        a.cwd,
        title,
        a.task,
      )
      if (same !== null) {
        return yield* Effect.fail(
          `Task ${same.thread} "${same.title}" is on this already. Steer it with task_steer, or give separate (how this one differs) to start it anyway.`,
        )
      }
      if (a.bypassed !== null) {
        yield* ingest([
          bypassEvent({
            check: "delegate_task",
            objections: ["dash"],
            reason: a.bypassed,
            work: parent,
          }),
        ])
      }
      // Its receipt's seq is its opening, the one event a delegation writes, a retry's as well.
      const opened = yield* brain.dispatch({
        // The brain keeps command ids: a retry with the same clientRequestId is a no-op.
        id: `delegate:${id}`,
        type: Delegate.type,
        source: parent,
        payload: {
          thread: id,
          parent,
          title,
          cwd: a.cwd,
          // A task writes code as often as not: it runs on the heavy tier, never a smaller model.
          model: "heavy",
          tools: a.tools,
          mode: a.mode,
          delegate: a.delegate,
        },
      })
      // Filed in the space its work is about: a tag on its opening, as a space's chat has.
      if (space !== null) {
        yield* ingest([
          event(`filed:${id}`, SpaceTagged.type, {
            seq: opened.seq,
            home: space,
            mentions: [],
            conversation: null,
            links: [],
          }),
        ])
      }
      // Start it unless a first try already did.
      yield* lock(id).withPermit(
        Effect.gen(function* startingTask() {
          const t = yield* read(id)
          const waits = yield* brain.read(waitingForRead, id)
          // No host now: it waits, queued, and starts once one can.
          if (t?.status === "idle" && !lives.get(id)?.turn && waits.length === 0) {
            yield* Effect.catchTag(start(id, a.task, ""), "NoHost", () => Effect.void)
          }
        }),
      )
      return info(yield* owned(parent, id))
    }).pipe(
      Effect.mapError((e) => {
        if (typeof e === "string") {
          return e
        }
        return e.reason
      }),
    )

  const cancelTask = (
    parent: ThreadId,
    task: ThreadId,
    why: string,
  ): Effect.Effect<TaskInfo, string> =>
    Effect.gen(function* cancelling() {
      yield* owned(parent, task)
      const children = yield* brain.read(childrenRead, task)
      for (const c of children) {
        yield* Effect.ignore(cancelTask(task, c.thread, why))
      }
      yield* interrupt(task)
      yield* ingest([
        event(`dropped:${task}:${crypto.randomUUID()}`, TaskDropped.type, { task, parent, why }),
      ])
      return info(yield* owned(parent, task))
    })

  const steerTask = (parent: ThreadId, task: ThreadId, text: string) =>
    Effect.gen(function* steering() {
      yield* owned(parent, task)
      yield* Effect.catchTag(send(task, text), "NoHost", () => Effect.void)
      return info(yield* owned(parent, task))
    }).pipe(
      Effect.mapError((e) => {
        if (typeof e === "string") {
          return e
        }
        return e.reason
      }),
    )

  const delegation: Delegation = yield* makeDelegation({
    delegate: delegateTask,
    // Its turn over while its work goes on (a watch of its own, a script it set), it's waiting.
    status: (parent, task) =>
      Effect.gen(function* standing() {
        const t = info(yield* owned(parent, task))
        return (yield* brain.read(stillGoingRead, task)) ? { ...t, status: "waiting" } : t
      }),
    cancel: cancelTask,
    steer: steerTask,
    stage: (thread, stage) =>
      Effect.gen(function* staging() {
        const t = yield* read(thread)
        if (!t?.parent) {
          return yield* Effect.fail("Only a task has a stage")
        }
        yield* ingest([
          event(`staged:${thread}:${crypto.randomUUID()}`, ThreadStaged.type, {
            thread,
            stage: stage.trim().slice(0, 40),
          }),
        ])
        return { stage: stage.trim().slice(0, 40) }
      }),
  })

  const endCompletion = (t: Thread) =>
    Effect.gen(function* endingCompletion() {
      if (t.status === "running" && t.turn !== null) {
        const cut = { ...endOf({ ...newTurn(t), id: t.turn }, "interrupted", CUT_OFF), ms: 0 }
        yield* ingest([event(`${t.turn}:end`, TurnEnded.type, cut)])
      }
    })
  // What one thread a previous run left carries on with, or how it's tended now.
  const recoverThread = Effect.fnUntraced(function* recoveringThread(t: Thread) {
    // Internal completions have no caller after restart; never replay a gate or pre-read.
    if (t.title === "Completion" && t.thread.startsWith("run-")) {
      yield* endCompletion(t)
      return
    }
    // What carries on waits in the record, by ids derived from the turn, and `drain` starts it
    // once the core serves; a restart before then records nothing twice.
    const why = leftOff(t)
    const { turn } = t
    if (t.status === "running" && turn !== null && why !== PAUSE) {
      // Cut as the run before stopped (or crashed): its end and its carry-on are one write.
      const end = { ...endOf({ ...newTurn(t), id: turn }, "interrupted", CUT_OFF), ms: 0 }
      const carried = yield* brain.read(carriedRead, t.thread, turn)
      yield* ingest([event(`${turn}:end`, TurnEnded.type, end), ...carried])
    } else if (why !== null) {
      const cut = turn === null ? OWED : yield* brain.read(cutAsRead, turn)
      yield* ingest([carryEvent(t.thread, turn ?? `${t.thread}:${String(t.endedAt)}`, cut, why)])
    } else if (limitCut(t) && (yield* brain.read(waitingForRead, t.thread)).length === 0) {
      // Cut by a limit before what it carries on with waited in the record (a build before this
      // one kept that in memory, and lost it to a restart).
      if (t.status === "limited" && t.host !== null && t.resetAt !== null) {
        yield* limit(t.host, t.resetAt)
      }
      const cut = turn === null ? OWED : yield* brain.read(cutAsRead, turn)
      yield* ingest([
        carryEvent(t.thread, turn ?? `${t.thread}:${String(t.endedAt)}`, cut, LIMIT_CUT),
      ])
    } else if (t.status === "failed" && BROKEN_SESSION.test(t.result)) {
      yield* fork(compact(t.thread))
    } else if (t.endedAt > 0) {
      yield* arm(t.thread, t.endedAt, t.context)
    }
  })
  // Recovery: what a previous run left.
  const recoverLeft = Effect.fnUntraced(function* recovering() {
    for (const m of new Set(hosts.all.map((h) => h.machine))) {
      const killed = yield* m.reap
      if (killed > 0) {
        yield* Effect.logInfo(`Killed ${killed} orphaned agent processes on ${m.id}`)
      }
    }
    for (const t of yield* brain.read(allThreadsRead)) {
      yield* recoverThread(t)
    }
  })
  yield* restoreAccounts()
  if (config.recover !== false) {
    yield* recoverLeft()
    yield* fork(Effect.forever(Effect.andThen(Effect.sleep(WAIT_RETRY), drain)))
  }

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      stopping = true
      for (const live of lives.values()) {
        live.runner.proc.kill()
      }
    }),
  )

  return {
    send,
    warm: (thread, options) => Effect.asVoid(warm(thread, options)),
    wake,
    kick: (thread) => Effect.asVoid(Effect.ignore(kick(thread))),
    interrupt,
    woken: (thread) => lives.get(thread)?.turn?.woken ?? false,
    answering: (thread) => lives.get(thread)?.turn?.answering ?? false,
    compact,
    ended,
    delegation: delegation.fetch,
    limit,
    pause,
    move,
  } satisfies SessionsShape
})

export class Sessions extends Context.Service<Sessions, SessionsShape>()("switch/Sessions") {
  static readonly layer = (config: SessionsConfig) => Layer.effect(Sessions, makeSessions(config))
}
