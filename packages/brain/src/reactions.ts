import type { Database } from "bun:sqlite"
import { Schema } from "effect"

import { SpaceId, ThreadId, TurnId } from "./ids.ts"
import { defineCommand, defineEvent, on } from "./defs.ts"
import type { Projection } from "./defs.ts"

// Tapbacks on chat messages, as iMessage has them: one per side per message, one of the six or any
// emoji. The event's source says whose: "agent", else the user's.

/** The six tapbacks. */
export const REACTIONS = ["love", "like", "dislike", "laugh", "emphasize", "question"] as const
export const Tapback = Schema.Literals(REACTIONS)
export type Tapback = typeof Tapback.Type

/** An emoji as a reaction: one emoji (with its modifiers and joiners), as iMessage allows any. */
export const Emoji = Schema.String.check(
  Schema.isPattern(
    /^(?=.*\p{Extended_Pictographic})[\p{Extended_Pictographic}\p{Emoji_Component}]{1,16}$/u,
  ),
)

export type Emoji = typeof Emoji.Type

/** A reaction: a tapback, or an emoji. */
export const Reaction = Schema.Union([Tapback, Emoji])
export type Reaction = typeof Reaction.Type

/** Whether a reaction is one of the six tapbacks, not an emoji. */
export const isTapback = (r: string): r is Tapback => (REACTIONS as readonly string[]).includes(r)

/**
 * Words of a message a reaction is on (their text as they stand there, and where, in UTF-16 code
 * units, when the client knows): without one it's on the whole message.
 */
export const ReactedWords = Schema.Struct({
  text: Schema.String,
  start: Schema.optionalKey(Schema.Number),
  end: Schema.optionalKey(Schema.Number),
})
export type ReactedWords = typeof ReactedWords.Type

/** The agent's "on it": a clock on the user's message, swapped for `like` once its work is done. */
export const CLOCK = "🕐"

/**
 * The work a clock waits on: the turn that placed it and the tasks delegated in it still running
 * then (with theirs). Tasks delegated afterwards join as they open (agent's clocks.ts).
 */
export const ClockWork = Schema.Struct({
  thread: ThreadId,
  turn: TurnId,
  tasks: Schema.Array(ThreadId),
})
export type ClockWork = typeof ClockWork.Type

/** A side's reaction to message `seq`, in `space`, or to `quote`'s words of it; null takes it back. */
export const MessageReacted = defineEvent(
  "message.reacted",
  1,
  Schema.Struct({
    seq: Schema.Number,
    space: SpaceId,
    reaction: Schema.NullOr(Reaction),
    quote: Schema.optionalKey(ReactedWords),
    /** A clock's work, when the agent placed it from a turn. */
    work: Schema.optionalKey(ClockWork),
  }),
)

/** Whose side a reaction is on, by its source. */
export const sideOf = (source: string) => (source === "agent" ? "agent" : "user")

const spaceOfMessage = (db: Database, seq: number) =>
  db.query<{ space: SpaceId }, [number]>("SELECT space FROM messages WHERE seq = ?").get(seq)
    ?.space ?? null

const OPEN = "('idle', 'running', 'limited')"

/**
 * The work a clock placed by `thread` now waits on: its running turn, and the tasks it delegated
 * in that turn that are still open, with their own open tasks; null when no turn of it runs.
 */
export const clockWork = (db: Database, thread: string): ClockWork | null => {
  const t = db
    .query<{ turn: string | null; status: string }, [string]>(
      "SELECT turn, status FROM threads WHERE thread = ?",
    )
    .get(thread)
  if (!t || t.status !== "running" || t.turn === null) {
    return null
  }
  const started =
    db
      .query<{ seq: number | null }, [string, string]>(
        "SELECT min(seq) AS seq FROM thread_items WHERE thread = ? AND turn = ?",
      )
      .get(thread, t.turn)?.seq ?? 0
  const tasks = db
    .query<{ thread: string }, [number, string]>(
      `WITH RECURSIVE under(thread) AS (
         SELECT json_extract(payload, '$.thread') FROM events
           WHERE type = 'thread.opened' AND seq > ? AND json_extract(payload, '$.parent') = ?
         UNION SELECT c.thread FROM threads c JOIN under u ON c.parent = u.thread)
       SELECT u.thread FROM under u JOIN threads t ON t.thread = u.thread WHERE t.status IN ${OPEN}`,
    )
    .all(started, thread)
    .map((r) => ThreadId.make(r.thread))
  return { thread: ThreadId.make(thread), turn: TurnId.make(t.turn), tasks }
}

/**
 * Sets the caller's reaction to a message, replacing theirs; null takes it back. `by`: the thread
 * whose turn placed it, so a clock is tied to that work. `was`: only when the caller's reaction is
 * that now.
 */
export const ReactToMessage = defineCommand({
  type: "message.react",
  payload: Schema.Struct({
    seq: Schema.Number,
    reaction: Schema.NullOr(Reaction),
    quote: Schema.optionalKey(ReactedWords),
    by: Schema.optionalKey(ThreadId),
    was: Schema.optionalKey(Reaction),
  }),
  load: (db, p) => ({
    space: spaceOfMessage(db, p.seq),
    work:
      p.reaction === CLOCK && p.quote === undefined && p.by !== undefined
        ? clockWork(db, p.by)
        : null,
    // Only the agent passes `was`; it's the agent's side.
    held:
      p.was === undefined
        ? null
        : (db
            .query<{ reaction: string }, [number]>(
              "SELECT reaction FROM reactions WHERE seq = ? AND side = 'agent'",
            )
            .get(p.seq)?.reaction ?? null),
  }),
  decide: ({ space, work, held }, p) => {
    if (space === null) {
      return { reject: "No such message" }
    }
    if (p.was !== undefined && held !== p.was) {
      return { events: [] }
    }
    return {
      events: [
        MessageReacted.make({
          seq: p.seq,
          space,
          reaction: p.reaction,
          ...(p.quote !== undefined && { quote: p.quote }),
          ...(work !== null && { work }),
        }),
      ],
    }
  },
})

export interface Reactions {
  readonly user?: Reaction
  readonly agent?: Reaction
}

/** The reactions to messages `seqs`, by seq. */
export const reactionsTo = (db: Database, seqs: readonly number[]) => {
  const out = new Map<number, { user?: Reaction; agent?: Reaction }>()
  if (seqs.length === 0) {
    return out
  }
  const rows = db
    .query<{ seq: number; side: string; reaction: Reaction }, number[]>(
      `SELECT seq, side, reaction FROM reactions WHERE seq IN (${seqs.map(() => "?").join(", ")})`,
    )
    .all(...seqs)
  for (const r of rows) {
    const held = out.get(r.seq) ?? {}
    if (r.side === "agent") {
      held.agent = r.reaction
    } else {
      held.user = r.reaction
    }
    out.set(r.seq, held)
  }
  return out
}

export const reactions: Projection = {
  name: "reactions",
  version: 1,
  tables: ["reactions"],
  create:
    "CREATE TABLE reactions (seq INTEGER NOT NULL, side TEXT NOT NULL, reaction TEXT NOT NULL, PRIMARY KEY (seq, side));",
  on: [
    on(MessageReacted, (db, p, e) => {
      // One on words is a part reaction (partReactions), not the whole message's.
      if (p.quote !== undefined) {
        return
      }
      const side = sideOf(e.source)
      if (p.reaction === null) {
        db.query("DELETE FROM reactions WHERE seq = ? AND side = ?").run(p.seq, side)
      } else {
        db.query(
          "INSERT INTO reactions (seq, side, reaction) VALUES (?, ?, ?) ON CONFLICT (seq, side) DO UPDATE SET reaction = excluded.reaction",
        ).run(p.seq, side, p.reaction)
      }
    }),
  ],
  snapshot: () => null,
}

/** A side's reaction to words of a message. */
export interface PartReaction {
  readonly side: "user" | "agent"
  readonly reaction: Reaction
  readonly text: string
  readonly start?: number
  readonly end?: number
}

/** The reactions to words of messages `seqs`, by seq, in the order they came. */
export const partReactionsTo = (db: Database, seqs: readonly number[]) => {
  const out = new Map<number, PartReaction[]>()
  if (seqs.length === 0) {
    return out
  }
  const rows = db
    .query<
      {
        seq: number
        side: string
        reaction: Reaction
        text: string
        start: number | null
        end: number | null
      },
      number[]
    >(
      `SELECT seq, side, reaction, text, start, "end" FROM part_reactions WHERE seq IN (${seqs.map(() => "?").join(", ")}) ORDER BY at`,
    )
    .all(...seqs)
  for (const r of rows) {
    out.set(r.seq, [
      ...(out.get(r.seq) ?? []),
      {
        side: r.side === "agent" ? "agent" : "user",
        reaction: r.reaction,
        text: r.text,
        ...(r.start !== null && { start: r.start }),
        ...(r.end !== null && { end: r.end }),
      },
    ])
  }
  return out
}

// Reactions to words of a message: one per side per stretch of words, apart from whole-message ones.
export const partReactions: Projection = {
  name: "part_reactions",
  version: 1,
  tables: ["part_reactions"],
  create: `CREATE TABLE part_reactions (seq INTEGER NOT NULL, side TEXT NOT NULL, text TEXT NOT NULL,
      start INTEGER, "end" INTEGER, reaction TEXT NOT NULL, at INTEGER NOT NULL,
      PRIMARY KEY (seq, side, text, start));`,
  on: [
    on(MessageReacted, (db, p, e) => {
      if (p.quote === undefined) {
        return
      }
      const side = sideOf(e.source)
      const start = p.quote.start ?? null
      db.query(
        "DELETE FROM part_reactions WHERE seq = ? AND side = ? AND text = ? AND start IS ?",
      ).run(p.seq, side, p.quote.text, start)
      if (p.reaction !== null) {
        db.query(
          'INSERT INTO part_reactions (seq, side, text, start, "end", reaction, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(p.seq, side, p.quote.text, start, p.quote.end ?? null, p.reaction, e.seq)
      }
    }),
  ],
  snapshot: () => null,
}
