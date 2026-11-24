// Surprises: what didn't go as expected. A promise broken or a check that failed after its wake,
// two senses that disagree, an extension that stopped or a source gone quiet, something the agent
// couldn't see. Each has a key: one is raised once, never again while it's open, nor for a day
// once dismissed. The next turn in its space (or in the work it's about) hears each once.
import type { Database } from "bun:sqlite"
import {
  Brain,
  defineCommand,
  defineEvent,
  EventId,
  HOME,
  on,
  SpaceId,
  ThreadId,
} from "@switch/brain"
import type { Incoming, Projection } from "@switch/brain"
import { waitingEvent } from "@switch/agent"
import { Effect, Schema } from "effect"

export const KINDS = ["broken", "missed", "disagree", "stopped", "quiet", "blind", "other"] as const
export type SurpriseKind = (typeof KINDS)[number]

export const SurpriseRaised = defineEvent(
  "surprise.raised",
  1,
  Schema.Struct({
    /** Its key: the same surprise again has the same one. */
    id: Schema.String,
    space: SpaceId,
    /** The work it's about, whose next turn hears it. */
    thread: Schema.NullOr(ThreadId),
    kind: Schema.Literals(KINDS),
    text: Schema.String,
  }),
)

export const SurpriseDismissed = defineEvent(
  "surprise.dismissed",
  1,
  Schema.Struct({ id: Schema.String, why: Schema.String }),
)

/** What it was about came right by itself (an extension back up, a source heard again). */
export const SurpriseResolved = defineEvent(
  "surprise.resolved",
  1,
  Schema.Struct({ id: Schema.String }),
)

export interface Surprise {
  readonly id: string
  readonly space: SpaceId
  readonly thread: ThreadId | null
  readonly kind: SurpriseKind
  readonly text: string
  readonly status: "open" | "dismissed" | "resolved"
  /** How many times it was raised while open. */
  readonly times: number
  readonly raisedAt: number
  /** The seq it was last raised at: a turn that looked since has heard it. */
  readonly seq: number
}

interface Row {
  readonly id: string
  readonly space: SpaceId
  readonly thread: ThreadId | null
  readonly kind: SurpriseKind
  readonly text: string
  readonly status: "open" | "dismissed" | "resolved"
  readonly times: number
  readonly raised_at: number
  readonly seq: number
  readonly dismissed_at: number | null
}

const toSurprise = (r: Row): Surprise => ({
  id: r.id,
  space: r.space,
  thread: r.thread,
  kind: r.kind,
  text: r.text,
  status: r.status,
  times: r.times,
  raisedAt: r.raised_at,
  seq: r.seq,
})

const DAY = 24 * 3600 * 1000

export const surprises: Projection = {
  name: "surprises",
  version: 1,
  tables: ["surprises"],
  create: `
    CREATE TABLE surprises (id TEXT PRIMARY KEY, space TEXT NOT NULL, thread TEXT, kind TEXT NOT NULL,
      text TEXT NOT NULL, status TEXT NOT NULL, times INTEGER NOT NULL, raised_at INTEGER NOT NULL,
      seq INTEGER NOT NULL, dismissed_at INTEGER);
    CREATE INDEX surprises_open ON surprises (status, space);`,
  on: [
    on(SurpriseRaised, (db, p, e) => {
      const was = db.query<Row, [string]>("SELECT * FROM surprises WHERE id = ?").get(p.id)
      if (was?.status === "open") {
        db.query("UPDATE surprises SET times = times + 1, text = ? WHERE id = ?").run(p.text, p.id)
        return
      }
      if (was && (was.dismissed_at ?? 0) > e.time - DAY) {
        return
      }
      db.query(
        `INSERT INTO surprises (id, space, thread, kind, text, status, times, raised_at, seq)
         VALUES (?, ?, ?, ?, ?, 'open', 1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET space = excluded.space, thread = excluded.thread,
           kind = excluded.kind, text = excluded.text, status = 'open', times = 1,
           raised_at = excluded.raised_at, seq = excluded.seq, dismissed_at = NULL`,
      ).run(p.id, p.space, p.thread, p.kind, p.text, e.time, e.seq)
    }),
    on(SurpriseResolved, (db, p) => {
      db.query("UPDATE surprises SET status = 'resolved' WHERE id = ? AND status = 'open'").run(
        p.id,
      )
    }),
    on(SurpriseDismissed, (db, p, e) => {
      db.query(
        "UPDATE surprises SET status = 'dismissed', dismissed_at = ? WHERE id = ? AND status = 'open'",
      ).run(e.time, p.id)
    }),
  ],
  snapshot: (db) => openSurprises(db),
  sources: [
    {
      name: "surprises",
      description:
        "What didn't go as expected: id, space, thread, kind (broken, missed, disagree, stopped, quiet, blind, other), text, status (open, dismissed, resolved), times, raised_at.",
      select: "SELECT id, space, thread, kind, text, status, times, raised_at, seq FROM surprises",
      columns: ["id", "space", "thread", "kind", "text", "status", "times", "raised_at", "seq"],
      time: "raised_at",
      order: "seq",
      depends: ["surprise."],
    },
  ],
}

/** Open ones, newest first; in `spaces` when given. */
export const openSurprises = (db: Database, spaces?: readonly string[]): Surprise[] => {
  const rows = db
    .query<Row, []>("SELECT * FROM surprises WHERE status = 'open' ORDER BY seq DESC")
    .all()
    .map(toSurprise)
  return spaces === undefined ? rows : rows.filter((s) => spaces.includes(s.space))
}

/** What a turn in `space` (or in `thread`) hasn't heard: raised after `seen`. */
export const unheard = (db: Database, space: SpaceId, thread: ThreadId, seen: number) =>
  openSurprises(db).filter(
    (s) => s.seq > seen && (s.thread === thread || (s.thread === null && s.space === space)),
  )

/** The senses watch's own (senses.ts): each resolves itself once a look no longer finds it. */
export const SENSED = ["stopped:", "crashing:", "failing:", "quiet:", "calls:", "link:"]
/** Trouble in Switch itself (the senses watch's, and a push that reached no phone, trouble.ts), and
 * on a machine it runs on (a resource alarm, core alarms.ts). */
export const TROUBLE = [...SENSED, "push:", "alarm:"]
export const isTrouble = (id: string) => TROUBLE.some((p) => id.startsWith(p))

/** Why trouble isn't dismissed: dismissed, it went unseen for a day though nothing was fixed. */
export const TROUBLE_STAYS =
  "Trouble in Switch isn't dismissed: it closes itself once it works again. Fix it; if it doesn't matter, fix its source so it stops reporting it; if only the user can fix it, put one ask in their queue (action_item) and leave this open."

/** One that doesn't matter, taken down with why; trouble in Switch never is (TROUBLE_STAYS). */
export const DismissSurprise = defineCommand({
  type: "surprise.dismiss",
  payload: SurpriseDismissed.payload,
  load: (db, p) => db.query<Row, [string]>("SELECT * FROM surprises WHERE id = ?").get(p.id),
  decide: (row, p) => {
    if (!row) {
      return { reject: "No such surprise" }
    }
    if (isTrouble(row.id)) {
      return { reject: TROUBLE_STAYS }
    }
    if (p.why.trim() === "") {
      return { reject: "Say why it doesn't matter" }
    }
    return { events: row.status === "open" ? [SurpriseDismissed.make(p)] : [] }
  },
})

export const surpriseConfig = {
  events: [SurpriseRaised, SurpriseDismissed, SurpriseResolved],
  projections: [surprises],
  commands: [DismissSurprise],
}

export interface Raise {
  readonly id: string
  readonly space?: SpaceId
  readonly thread?: ThreadId | null
  readonly kind: SurpriseKind
  readonly text: string
  /** Each time again while it's open counts (its `times`, its latest text). */
  readonly count?: boolean
}

/**
 * Raises one, once: the same key while it's open, or dismissed within the day, logs nothing (unless
 * `count`, which counts it), since every raise logged reaches triage and can wake a space again.
 * True when it's newly open.
 */
export const raise = (
  s: Raise,
  /** Written with it when it's newly open, in the same write: by the raise's own event id. */
  along: (raised: string) => readonly Incoming[] = () => [],
) =>
  Effect.gen(function* raising() {
    const brain = yield* Brain
    const was = yield* brain.read((db) =>
      db
        .query<Pick<Row, "status" | "dismissed_at">, [string]>(
          "SELECT status, dismissed_at FROM surprises WHERE id = ?",
        )
        .get(s.id),
    )
    const open = was?.status === "open"
    if ((open && s.count !== true) || (was?.dismissed_at ?? 0) > Date.now() - DAY) {
      return false
    }
    const raised = `surprise:${s.id}:${Date.now()}`
    yield* Effect.orDie(
      brain.ingest([
        ...(open ? [] : along(raised)),
        {
          id: EventId.make(raised),
          type: SurpriseRaised.type,
          source: "autonomy",
          payload: {
            id: s.id,
            space: s.space ?? HOME,
            thread: s.thread ?? null,
            kind: s.kind,
            text: s.text,
          },
        },
      ]),
    )
    return !open
  })

/** Takes one down that came right by itself; a no-op when it isn't open. */
export const resolve = (id: string) =>
  Effect.gen(function* resolving() {
    const brain = yield* Brain
    const open = yield* brain.read(
      (db) => db.query("SELECT 1 FROM surprises WHERE id = ? AND status = 'open'").get(id) !== null,
    )
    if (open) {
      yield* Effect.orDie(
        brain.ingest([
          {
            id: EventId.make(`resolved:${id}:${Date.now()}`),
            type: SurpriseResolved.type,
            source: "autonomy",
            payload: { id },
          },
        ]),
      )
    }
  })

/**
 * Trouble in Switch itself: raised once, and a newly open one wakes its space's work at once, never
 * the user's chat (core trouble.ts), or the work given in `wakes`. `to` reaches the work.
 */
export const troubled = (s: Raise, to: Waker, wakes?: ThreadId) =>
  Effect.gen(function* raising() {
    const thread = wakes ?? to.threadOf(s.space ?? HOME)
    // Its wake waits in the record from the write that raised it, by an id derived from that raise,
    // so it's recorded once and a restart can't lose it.
    const fresh = yield* raise(s, (raised) => [
      waitingEvent(`${raised}:wake`, {
        thread,
        text: "",
        note: `Surprise [${s.id}]: ${s.text}`,
        from: "sensed",
      }),
    ])
    if (fresh) {
      yield* to.kick(thread)
    }
  })

/** Where a newly raised one wakes: its space's work, started from what waits for it in the record. */
export interface Waker {
  readonly threadOf: (space: SpaceId) => ThreadId
  readonly kick: (thread: ThreadId) => Effect.Effect<void>
}
