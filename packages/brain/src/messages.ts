import type { Database } from "bun:sqlite"
import { Schema } from "effect"

import { Attachment } from "./attachment.ts"
import { MessageReacted, partReactions, ReactToMessage, reactions } from "./reactions.ts"
import { ItemId, SpaceId, TurnId } from "./ids.ts"
import { defineCommand, defineEvent, on } from "./defs.ts"
import type { Projection } from "./defs.ts"
import { SpaceCreated } from "./spaces.ts"
import { WidgetInput } from "./widgets.ts"

// A space's chat. The user's messages and the agent's replies are one type; the event's source says
// who: "agent" for a reply, "peer" for another agent's words (a Claude Code or T3 Code session, by
// the name it gave, `from`), else the user (the client's source). A message may be an app's widget,
// shown in the chat, its tool called with `input`; its text is then the widget's title. A user's
// message says which of its words they dictated, since speech recognition mishears names. Files ride
// along as attachments, each a blob. A reply may carry a long version, its `detail`, opened on demand.

const shown = Schema.Struct({
  app: Schema.String,
  name: Schema.String,
  input: Schema.optionalKey(WidgetInput),
})

/**
 * The stretches of a text the user dictated rather than typed: where each starts, in code points,
 * and its words as they stand in the text.
 */
export const Dictated = Schema.Array(Schema.Struct({ start: Schema.Number, text: Schema.String }))
export type Dictated = typeof Dictated.Type

/**
 * What a message of the user's replies to: words of a message (its seq, the words as they stand
 * there, and where, in UTF-16 code units, when the client knows), a message whole (its seq and a
 * short excerpt of it, its opening and its ending, never all of it), or an action item (its id).
 * Several may go on one message, each with the user's own reply to it (`reply`), apart from the
 * message's general words.
 */
export const Quote = Schema.Struct({
  kind: Schema.Literal("quote"),
  seq: Schema.Number,
  text: Schema.String,
  start: Schema.optionalKey(Schema.Number),
  end: Schema.optionalKey(Schema.Number),
  reply: Schema.optionalKey(Schema.String),
})
export const MessageRef = Schema.Struct({
  kind: Schema.Literal("message"),
  seq: Schema.Number,
  text: Schema.String,
  reply: Schema.optionalKey(Schema.String),
})
export const AskRef = Schema.Struct({
  kind: Schema.Literal("ask"),
  id: ItemId,
  reply: Schema.optionalKey(Schema.String),
})
export const ReplyRef = Schema.Union([Quote, MessageRef, AskRef])
export type ReplyRef = typeof ReplyRef.Type

/**
 * The model that wrote something of the agent's: its id as the provider resolved it at run time
 * (not a tier or alias), its display name, the provider and the account it ran on.
 */
export const ModelTag = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  provider: Schema.String,
  account: Schema.String,
})
export type ModelTag = typeof ModelTag.Type

export const MessagePosted = defineEvent(
  "message.posted",
  1,
  Schema.Struct({
    space: SpaceId,
    text: Schema.String,
    /** The turn a reply came from. */
    turn: Schema.optionalKey(TurnId),
    /** A widget shown in the chat. */
    widget: Schema.optionalKey(shown),
    /** The action item the user replied on. */
    item: Schema.optionalKey(ItemId),
    /** What it replies to: words of a message, a message whole, or an action item; several may go together. */
    replyTo: Schema.optionalKey(Schema.Array(ReplyRef)),
    attachments: Schema.optionalKey(Schema.Array(Attachment)),
    dictated: Schema.optionalKey(Dictated),
    /** A reply's long version, when the short one isn't enough; never repeats it. */
    detail: Schema.optionalKey(Schema.String),
    /** The model that wrote a reply. */
    model: Schema.optionalKey(ModelTag),
    /** A peer's name (`T3 Code · Fix login`): another agent's words, never the user's. */
    from: Schema.optionalKey(Schema.String),
  }),
)

/** The source of another agent's words: a peer's post (peer.ts). */
export const PEER = "peer"

/** Whose a message is, by its event's source: Switch's, a peer's, or the user's. */
export const whoOf = (source: string) => {
  if (source === "agent") {
    return "agent"
  }
  return source === PEER ? "peer" : "user"
}

/** Who said a line, as a model reads it: `me` for the agent, a peer by its name, else `user`. */
export const saidBy = (
  line: { readonly source: string; readonly from?: string | null | undefined },
  me: string,
  user: string,
) => {
  if (line.source === "agent") {
    return me
  }
  const { from } = line
  return from === undefined || from === null ? user : `${from} (another agent, not the user)`
}

const DETAIL = /<detail>(?<detail>[\s\S]*?)(?:<\/detail>|$)/u

/**
 * A reply's text and its long version: what a turn's final text holds in `<detail>…</detail>`.
 * An unclosed one, still streaming, runs to the end.
 */
export const splitDetail = (said: string): { text: string; detail?: string } => {
  const found = DETAIL.exec(said)
  if (!found) {
    return { text: said }
  }
  const text = said.replace(found[0], "").trim()
  const detail = (found.groups?.detail ?? "").trim()
  return detail === "" ? { text } : { text, detail }
}

/**
 * The user's last message in a space, changed before what it started reached outside: the new
 * words take its place, and the replies to the old ones go.
 */
export const MessageEdited = defineEvent(
  "message.edited",
  1,
  Schema.Struct({ seq: Schema.Number, text: Schema.String, was: Schema.String }),
)

/**
 * A message of the agent's, revised in place once it's in the chat (an after check's fix): the
 * same message with new words, shown as edited. Nothing after it changes, and no one is told again.
 */
export const MessageRevised = defineEvent(
  "message.revised",
  1,
  Schema.Struct({ seq: Schema.Number, text: Schema.String, was: Schema.String }),
)

export const EFFORTS = ["low", "medium", "high", "xhigh"] as const
export type Effort = (typeof EFFORTS)[number]

/** The pre-read of message `seq`: names fixed, a title, the parts of a brain dump by space, the effort. */
export const MessageRead = defineEvent(
  "message.read",
  1,
  Schema.Struct({
    seq: Schema.Number,
    text: Schema.String,
    title: Schema.String,
    /** Empty unless it covers several spaces. */
    parts: Schema.Array(Schema.Struct({ space: SpaceId, text: Schema.String })),
    effort: Schema.Literals(EFFORTS),
    ms: Schema.Number,
    cost: Schema.Number,
  }),
)

export const PostMessage = defineCommand({
  type: "message.post",
  payload: MessagePosted.payload,
  load: (db, p) => db.query("SELECT id FROM spaces WHERE id = ?").get(p.space) !== null,
  decide: (exists, p) =>
    exists ? { events: [MessagePosted.make(p)] } : { reject: "No such space" },
})

/** An exchange moved to another space's chat: `seqs` are its lines, `seq` the first. */
export const MessageMoved = defineEvent(
  "message.moved",
  1,
  Schema.Struct({
    seq: Schema.Number,
    seqs: Schema.Array(Schema.Number),
    from: SpaceId,
    to: SpaceId,
  }),
)

interface Placed {
  readonly seq: number
  readonly space: SpaceId
  readonly source: string
}

const parseSeqs = (json: string): number[] => {
  const v: unknown = JSON.parse(json)
  return Array.isArray(v) ? v.filter((x) => typeof x === "number") : []
}

/**
 * The exchange at `seq`: that line, and the agent's lines after it in its space up to the next of
 * the user's. Moving one back takes the lines its move took.
 */
const exchange = (db: Database, seq: number, to: SpaceId) => {
  const first = db
    .query<Placed, [number]>("SELECT seq, space, source FROM messages WHERE seq = ?")
    .get(seq)
  if (!first) {
    return null
  }
  const back = db
    .query<{ seqs: string }, [number, string, string]>(
      "SELECT seqs FROM message_moves WHERE seq = ? AND dest = ? AND origin = ? ORDER BY moved DESC LIMIT 1",
    )
    .get(seq, first.space, to)
  if (back) {
    return { from: first.space, seqs: parseSeqs(back.seqs) }
  }
  const after = db
    .query<Placed, [string, number]>(
      "SELECT seq, space, source FROM messages WHERE space = ? AND seq > ? ORDER BY seq LIMIT 200",
    )
    .all(first.space, seq)
  const next = after.findIndex((m) => m.source !== "agent")
  const replies = next === -1 ? after : after.slice(0, next)
  return { from: first.space, seqs: [seq, ...replies.map((m) => m.seq)] }
}

/** Moves the exchange at `seq` into `space`'s chat: it leaves nothing in the old one. */
export const MoveMessage = defineCommand({
  type: "message.move",
  payload: Schema.Struct({ seq: Schema.Number, space: SpaceId }),
  load: (db, p) => ({
    found: exchange(db, p.seq, p.space),
    exists: db.query("SELECT id FROM spaces WHERE id = ?").get(p.space) !== null,
  }),
  decide: ({ found, exists }, p) => {
    if (!found) {
      return { reject: "No such message" }
    }
    if (!exists) {
      return { reject: "No such space" }
    }
    if (found.from === p.space) {
      return { events: [] }
    }
    return {
      events: [MessageMoved.make({ seq: p.seq, seqs: found.seqs, from: found.from, to: p.space })],
    }
  },
})

const spaceExists = (db: Database, id: SpaceId) =>
  db.query("SELECT id FROM spaces WHERE id = ?").get(id) !== null

/** The space's latest exchange: the user's last message there and everything after it. */
const latestExchange = (db: Database, space: SpaceId) => {
  const last = db
    .query<{ seq: number; text: string; title: string | null }, [SpaceId]>(
      "SELECT seq, text, title FROM messages WHERE space = ? AND source NOT IN ('agent', 'peer') ORDER BY seq DESC LIMIT 1",
    )
    .get(space)
  if (!last) {
    return null
  }
  const seqs = db
    .query<{ seq: number }, [SpaceId, number]>(
      "SELECT seq FROM messages WHERE space = ? AND seq >= ? ORDER BY seq",
    )
    .all(space, last.seq)
    .map((r) => r.seq)
  return { seq: last.seq, seqs, title: last.title ?? "", text: last.text }
}

const firstWords = (text: string) => text.trim().split(/\s+/u).slice(0, 5).join(" ")

/** Split Off: the latest exchange in `from` becomes a new space inside it, moved there. */
export const SplitOff = defineCommand({
  type: "space.split",
  payload: Schema.Struct({
    id: SpaceId,
    from: SpaceId,
    /** Its pre-read title, else its first words, when not given. */
    name: Schema.optionalKey(Schema.String),
  }),
  load: (db, p) => ({
    taken: spaceExists(db, p.id),
    from: spaceExists(db, p.from),
    exchange: latestExchange(db, p.from),
  }),
  decide: (state, p) => {
    if (state.taken) {
      return { reject: "Space exists" }
    }
    if (!state.from) {
      return { reject: "No such space" }
    }
    if (!state.exchange) {
      return { reject: "Nothing to split off" }
    }
    // The first of its given name, its title and its first words that isn't empty.
    const name =
      [p.name?.trim() ?? "", state.exchange.title.trim(), firstWords(state.exchange.text)].find(
        (n) => n !== "",
      ) ?? "Split"
    const { seq, seqs } = state.exchange
    return {
      events: [
        SpaceCreated.make({ id: p.id, name, parent: p.from, ephemeral: false, about: "" }),
        MessageMoved.make({ seq, seqs, from: p.from, to: p.id }),
      ],
    }
  },
})

/** The user has read a space's chat through `seq`, on some device: unread marks clear everywhere. */
export const SpaceRead = defineEvent(
  "space.read",
  1,
  Schema.Struct({ space: SpaceId, seq: Schema.Number }),
)

/** How far the user has read a space's chat; their own message there (not a peer's) reads it. */
export const readThrough = (db: Database, space: SpaceId) =>
  db.query<{ seq: number }, [string]>("SELECT seq FROM reads WHERE space = ?").get(space)?.seq ?? 0

export const ReadSpace = defineCommand({
  type: "space.read",
  payload: SpaceRead.payload,
  load: (db, p) => ({
    exists: db.query("SELECT id FROM spaces WHERE id = ?").get(p.space) !== null,
    through: readThrough(db, p.space),
  }),
  decide: (state, p) => {
    if (!state.exists) {
      return { reject: "No such space" }
    }
    return { events: p.seq > state.through ? [SpaceRead.make(p)] : [] }
  },
})

const readTo = (db: Database, space: string, seq: number) => {
  db.query(
    "INSERT INTO reads (space, seq) VALUES (?, ?) ON CONFLICT (space) DO UPDATE SET seq = max(seq, excluded.seq)",
  ).run(space, seq)
}

export const reads: Projection = {
  name: "reads",
  version: 1,
  tables: ["reads"],
  create: "CREATE TABLE reads (space TEXT PRIMARY KEY, seq INTEGER NOT NULL);",
  on: [
    on(SpaceRead, (db, p) => {
      readTo(db, p.space, p.seq)
    }),
    on(MessagePosted, (db, p, e) => {
      if (whoOf(e.source) === "user") {
        readTo(db, p.space, e.seq)
      }
    }),
  ],
  snapshot: (db) =>
    db.query<{ space: SpaceId; seq: number }, []>("SELECT space, seq FROM reads").all(),
}

export interface Message {
  readonly seq: number
  readonly time: number
  readonly space: SpaceId
  readonly source: string
  /** As the pre-read fixed it, once it has. */
  readonly text: string
  /** Null until the pre-read; empty for a reply or a peer's. */
  readonly title: string | null
  readonly turn: TurnId | null
  /** A widget shown in the chat, as JSON. */
  readonly widget: string | null
  /** The action item a reply of the user's was on. */
  readonly item: string | null
  /** Its files, as JSON. */
  readonly attachments: string | null
  /** A peer's name; null for the user's and the agent's (spaceMessages only). */
  readonly from?: string | null
}

const COLUMNS = "seq, time, space, source, text, title, turn, widget, attachments, item"

/** A space's last `limit` messages, oldest first, each peer's with its name. */
export const spaceMessages = (db: Database, space: SpaceId, limit: number): Message[] =>
  db
    .query<Message, [string, number]>(
      `SELECT m.*, s.name AS "from" FROM (
         SELECT ${COLUMNS} FROM messages WHERE space = ? ORDER BY seq DESC LIMIT ?
       ) m LEFT JOIN message_senders s ON s.seq = m.seq ORDER BY m.seq DESC`,
    )
    .all(space, limit)
    .toReversed()

export const messages: Projection = {
  name: "messages",
  version: 5,
  tables: ["messages"],
  create: `
    CREATE TABLE messages (seq INTEGER PRIMARY KEY, time INTEGER NOT NULL, space TEXT NOT NULL,
      source TEXT NOT NULL, text TEXT NOT NULL, title TEXT, turn TEXT, widget TEXT, attachments TEXT,
      item TEXT);
    CREATE INDEX messages_space ON messages (space, seq);
    CREATE INDEX messages_turn ON messages (turn);`,
  on: [
    on(MessagePosted, (db, p, e) => {
      db.query(
        "INSERT INTO messages (seq, time, space, source, text, title, turn, widget, attachments, item) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        e.seq,
        e.time,
        p.space,
        e.source,
        p.text,
        p.turn === undefined && p.widget === undefined && e.source !== PEER ? null : "",
        p.turn ?? null,
        p.widget === undefined ? null : JSON.stringify(p.widget),
        p.attachments === undefined ? null : JSON.stringify(p.attachments),
        p.item ?? null,
      )
    }),
    on(MessageEdited, (db, p) => {
      const row = db
        .query<{ space: string }, [number]>("SELECT space FROM messages WHERE seq = ?")
        .get(p.seq)
      if (row) {
        db.query("UPDATE messages SET text = ? WHERE seq = ?").run(p.text, p.seq)
        db.query("DELETE FROM messages WHERE space = ? AND seq > ? AND source = 'agent'").run(
          row.space,
          p.seq,
        )
      }
    }),
    on(MessageRead, (db, p) => {
      db.query("UPDATE messages SET text = ?, title = ? WHERE seq = ?").run(p.text, p.title, p.seq)
    }),
    on(MessageRevised, (db, p) => {
      db.query("UPDATE messages SET text = ? WHERE seq = ? AND source = 'agent'").run(p.text, p.seq)
    }),
    on(MessageMoved, (db, p) => {
      db.query(
        `UPDATE messages SET space = ? WHERE seq IN (${p.seqs.map(() => "?").join(", ")})`,
      ).run(p.to, ...p.seqs)
    }),
  ],
  sources: [
    {
      name: "messages",
      description:
        'Chat messages: seq, time, space, source ("agent" for yours, "peer" for another agent\'s; else the user\'s client), text.',
      select: "SELECT seq, time, space, source, text FROM messages",
      columns: ["seq", "time", "space", "source", "text"],
      time: "time",
      order: "seq",
      depends: ["message."],
    },
  ],
  // The last 50 of each space.
  snapshot: (db) =>
    db
      .query<Message, []>(
        `SELECT ${COLUMNS} FROM (SELECT *, row_number() OVER (PARTITION BY space ORDER BY seq DESC) AS n FROM messages)
         WHERE n <= 50 ORDER BY seq`,
      )
      .all(),
}

// Replies' long versions, apart from the messages table so adding them changed no table.
export const messageDetails: Projection = {
  name: "message_details",
  version: 1,
  tables: ["message_details"],
  create: "CREATE TABLE message_details (seq INTEGER PRIMARY KEY, detail TEXT NOT NULL);",
  on: [
    on(MessagePosted, (db, p, e) => {
      if (p.detail !== undefined && p.detail.trim() !== "") {
        db.query("INSERT OR REPLACE INTO message_details (seq, detail) VALUES (?, ?)").run(
          e.seq,
          p.detail,
        )
      }
    }),
  ],
  snapshot: () => null,
}

// The model that wrote each reply, apart from the messages table as details are.
export const messageModels: Projection = {
  name: "message_models",
  version: 1,
  tables: ["message_models"],
  create: "CREATE TABLE message_models (seq INTEGER PRIMARY KEY, model TEXT NOT NULL);",
  on: [
    on(MessagePosted, (db, p, e) => {
      if (p.model !== undefined) {
        db.query("INSERT OR REPLACE INTO message_models (seq, model) VALUES (?, ?)").run(
          e.seq,
          JSON.stringify(p.model),
        )
      }
    }),
  ],
  snapshot: () => null,
}

// Peers' names, apart from the messages table as details are, so adding them changed no table.
export const messageSenders: Projection = {
  name: "message_senders",
  version: 1,
  tables: ["message_senders"],
  create: "CREATE TABLE message_senders (seq INTEGER PRIMARY KEY, name TEXT NOT NULL);",
  on: [
    on(MessagePosted, (db, p, e) => {
      if (p.from !== undefined && e.source === PEER) {
        db.query("INSERT OR REPLACE INTO message_senders (seq, name) VALUES (?, ?)").run(
          e.seq,
          p.from,
        )
      }
    }),
  ],
  snapshot: () => null,
}

// What messages reply to, apart from the messages table as details are, so adding it changed no table.
export const messageReplies: Projection = {
  name: "message_replies",
  version: 1,
  tables: ["message_replies"],
  create: "CREATE TABLE message_replies (seq INTEGER PRIMARY KEY, refs TEXT NOT NULL);",
  on: [
    on(MessagePosted, (db, p, e) => {
      if (p.replyTo !== undefined && p.replyTo.length > 0) {
        db.query("INSERT OR REPLACE INTO message_replies (seq, refs) VALUES (?, ?)").run(
          e.seq,
          JSON.stringify(p.replyTo),
        )
      }
    }),
  ],
  snapshot: () => null,
}

// Which of the agent's messages were revised, for their edited mark: apart from the messages
// table, as their details are, so adding it changed no table.
export const messageRevisions: Projection = {
  name: "message_revisions",
  version: 1,
  tables: ["message_revisions"],
  create: "CREATE TABLE message_revisions (seq INTEGER PRIMARY KEY);",
  on: [
    on(MessageRevised, (db, p) => {
      db.query("INSERT OR IGNORE INTO message_revisions (seq) VALUES (?)").run(p.seq)
    }),
  ],
  snapshot: () => null,
}

/** What an item's reply said before replies carried it: "(On action item <id>.)" at its end. */
const ON_ITEM = /\n\n\(On action item (?<id>\S+?)\.\)$/u

/**
 * A message's words and what it replies to: its own refs, else an older message's "(On action item
 * <id>.)" read as an ask it replies to, taken off its words.
 */
export const repliesOf = (
  text: string,
  refs: readonly ReplyRef[] | null,
): { text: string; replyTo: readonly ReplyRef[] } => {
  const found = ON_ITEM.exec(text)
  const id = found?.groups?.id
  if (found === null || id === undefined) {
    return { text, replyTo: refs ?? [] }
  }
  const asked = (refs ?? []).some((r) => r.kind === "ask" && r.id === id)
  return {
    text: text.slice(0, found.index),
    replyTo: asked ? (refs ?? []) : [...(refs ?? []), { kind: "ask", id: ItemId.make(id) }],
  }
}

/** Where exchanges went: moving one back takes the lines its move took, and forgets the move. */
export const messageMoves: Projection = {
  name: "message_moves",
  version: 1,
  tables: ["message_moves"],
  create: `
    CREATE TABLE message_moves (moved INTEGER PRIMARY KEY, seq INTEGER NOT NULL, seqs TEXT NOT NULL,
      origin TEXT NOT NULL, dest TEXT NOT NULL, time INTEGER NOT NULL);
    CREATE INDEX message_moves_origin ON message_moves (origin, moved);
    CREATE INDEX message_moves_seq ON message_moves (seq);`,
  on: [
    on(MessageMoved, (db, p, e) => {
      // A move back is an undo: the line the move there left goes, and none is left in its place.
      const undone = db
        .query(
          "DELETE FROM message_moves WHERE seq = ? AND origin = ? AND dest = ? RETURNING moved",
        )
        .all(p.seq, p.to, p.from)
      if (undone.length === 0) {
        db.query(
          "INSERT INTO message_moves (moved, seq, seqs, origin, dest, time) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(e.seq, p.seq, JSON.stringify(p.seqs), p.from, p.to, e.time)
      }
    }),
  ],
  snapshot: () => null,
}

export const messagesConfig = {
  events: [
    MessagePosted,
    MessageRead,
    MessageMoved,
    SpaceRead,
    MessageEdited,
    MessageRevised,
    MessageReacted,
  ],
  projections: [
    messages,
    messageMoves,
    reads,
    messageDetails,
    messageModels,
    messageSenders,
    messageReplies,
    messageRevisions,
    reactions,
    partReactions,
  ],
  commands: [PostMessage, MoveMessage, ReadSpace, SplitOff, ReactToMessage],
}
