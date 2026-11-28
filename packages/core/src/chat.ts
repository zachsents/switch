// A message's path: the user posts in a space's chat, the pre-read runs, the turn runs in that space's
// live session, and what it says (its say, autonomy app.ts) is posted back as a message: only that
// reaches their chat, as only Switchboard's say did (sb/mcp.rs:466-482). Sync carries each step to
// clients.
// Workers are scoped layers, as T3 Code's reactors are.
import type { Database } from "bun:sqlite"
import { getThread, Sessions, Triage } from "@switch/agent"
import { dialOf, rulesAt } from "@switch/autonomy"
import type { NoHost, Wake } from "@switch/agent"
import {
  allSpaces,
  Blobs,
  Brain,
  defineRead,
  EFFORTS,
  EventId,
  HOME,
  ItemId,
  MessageEdited,
  MessagePosted,
  MessageReacted,
  MessageRead,
  PEER,
  react,
  spaceFor,
  whoOf,
} from "@switch/brain"
import type {
  Attachment,
  Effort,
  Rejected,
  ReplyRef,
  SpaceId,
  StoredEvent,
  ThreadId,
} from "@switch/brain"
import { Effect, Layer, Option, Schema, Stream } from "effect"

import { attached } from "./attached.ts"
import { CoreConfig } from "./config.ts"
import { threadOf } from "./context.ts"
import { dictatedNote } from "./dictated.ts"
import { effortOf, preRead, situation } from "./preread.ts"
import { isWake, WakeAsked } from "./side.ts"
import { ThreadSteered, ThreadStopped } from "./steer.ts"

const decodePosted = Schema.decodeUnknownOption(MessagePosted.payload)
const decodeSteered = Schema.decodeUnknownOption(ThreadSteered.payload)
const decodeStopped = Schema.decodeUnknownOption(ThreadStopped.payload)
const decodeEdited = Schema.decodeUnknownOption(MessageEdited.payload)
const decodeReacted = Schema.decodeUnknownOption(MessageReacted.payload)
const decodeWake = Schema.decodeUnknownOption(WakeAsked)

// Before the first message of the user's not yet read: its pre-read runs beside its turn, so the
// cursor can pass it before it's done.
const unreadFrom = (db: Database) => {
  const unread =
    db
      .query<{ seq: number | null }, []>(
        "SELECT min(seq) AS seq FROM messages WHERE source != 'agent' AND title IS NULL",
      )
      .get()?.seq ?? null
  return unread === null ? null : unread - 1
}

const headOf = (db: Database) =>
  db.query<{ seq: number | null }, []>("SELECT max(seq) AS seq FROM events").get()?.seq ?? 0

/** Where the chat reactor starts the first time: before the first unread message, else the head. */
const seedRead = defineRead("core/chat/seed", (db) => unreadFrom(db) ?? headOf(db))
/** Where it starts again after a restart, when a message is still unread. */
const rewindRead = defineRead("core/chat/rewind", unreadFrom)

/** Whether the thread's turn under way started before `seq`: a Stop read again after a restart ends no later turn. */
const runningBefore = (db: Database, thread: ThreadId, seq: number) => {
  const t = getThread(db, thread)
  if (t?.status !== "running" || t.turn === null) {
    return false
  }
  const started =
    db
      .query<{ seq: number | null }, [string, string]>(
        "SELECT min(seq) AS seq FROM thread_items WHERE thread = ? AND turn = ?",
      )
      .get(thread, t.turn)?.seq ?? null
  return started !== null && started < seq
}

/** Whether any of what a message replies to carries the user's own reply to it. */
const answersEach = (refs: readonly ReplyRef[]) => refs.some((r) => (r.reply ?? "").trim() !== "")

/**
 * What a message of the user's replies to, as the agent reads it: the words it quotes and whose
 * message they're from, a message whole by its number and excerpt (history_read gives the rest),
 * and each action item it's on, by title and id, each followed by the user's reply to it when it
 * has one. An older reply on an item (`item`) reads as one on that item.
 */
export const repliesLine = (db: Database, refs: readonly ReplyRef[], item: string | undefined) => {
  const all = [
    ...refs,
    ...(item !== undefined && !refs.some((r) => r.kind === "ask" && r.id === item)
      ? [{ kind: "ask" as const, id: ItemId.make(item) }]
      : []),
  ]
  const whose = db.query<{ source: string }, [number]>("SELECT source FROM messages WHERE seq = ?")
  const title = db.query<{ title: string | null }, [string]>(
    "SELECT json_extract(data, '$.title') AS title FROM action_items WHERE id = ?",
  )
  const from = (seq: number) =>
    whose.get(seq)?.source === "agent" ? "your message" : "their message"
  const on = (r: ReplyRef) => {
    if (r.kind === "quote") {
      return `(Replying to these words of ${from(r.seq)} ${String(r.seq)}: "${r.text}".)`
    }
    if (r.kind === "message") {
      return `(Replying to ${from(r.seq)} ${String(r.seq)}, whole: "${r.text}"; history_read with id ${String(r.seq)} reads it all.)`
    }
    const named = title.get(r.id)?.title ?? null
    return `(On action item ${named === null ? "" : `"${named}" `}${r.id}.)`
  }
  if (!answersEach(all)) {
    return all.map(on).join("\n")
  }
  return all
    .map((r) => {
      const reply = (r.reply ?? "").trim()
      return reply === "" ? on(r) : `${on(r)}\nTheir reply to it: ${reply}`
    })
    .join("\n\n")
}

// ——— The reads (reads.ts), run in a reader thread ———

/** Whether an event of this id is in the log. */
const eventHeldRead = defineRead(
  "core/chat/event-held",
  (db, id: string) => db.query("SELECT 1 FROM events WHERE id = ?").get(id) !== null,
)

/** Every space. */
const spacesRead = defineRead("core/chat/spaces", (db) => allSpaces(db))

/** What the pre-read knows of where a message was posted. */
const situationRead = defineRead("core/chat/situation", (db, space: SpaceId) =>
  situation(db, space),
)

/** A thread's record, else null. */
const threadRead = defineRead("core/chat/thread", (db, thread: ThreadId) => getThread(db, thread))

/** The space a wake names, else Home. */
const wakeSpaceRead = defineRead("core/chat/wake-space", (db, given: string | undefined) =>
  spaceFor(db, given, null),
)

/** The user's rules in a space for these words, and the effort a turn takes by default. */
const userEffortRead = defineRead("core/chat/user-effort", (db, space: SpaceId, words: string) => {
  const fallback = dialOf(db, "effort.default")
  return {
    rules: rulesAt(db, [space], words),
    fallback: EFFORTS.find((x) => x === fallback) ?? "medium",
  }
})

/** The space a message is in, else null. */
const messageSpaceRead = defineRead(
  "core/chat/message-space",
  (db, seq: number) =>
    db.query<{ space: SpaceId }, [number]>("SELECT space FROM messages WHERE seq = ?").get(seq)
      ?.space ?? null,
)

/** A message's source and words, else null. */
const messageRead = defineRead(
  "core/chat/message",
  (db, seq: number) =>
    db
      .query<{ source: string; text: string }, [number]>(
        "SELECT source, text FROM messages WHERE seq = ?",
      )
      .get(seq) ?? null,
)

/** Whether the thread's turn under way started before `seq`. */
const runningBeforeRead = defineRead(
  "core/chat/running-before",
  (db, thread: ThreadId, seq: number) => runningBefore(db, thread, seq),
)

/** What a message replies to, as the agent reads it. */
const repliesLineRead = defineRead(
  "core/chat/replies-line",
  (db, refs: readonly ReplyRef[], item: string | undefined) => repliesLine(db, refs, item),
)

/** The log's head. */
const headRead = defineRead("core/chat/head", (db) => headOf(db))

/** A turn no host could take: it waits in the record, and they're told (sessions.ts `wait`). */
const waits = <A>(effect: Effect.Effect<A, NoHost | Rejected>) =>
  Effect.asVoid(Effect.catchTag(effect, "NoHost", () => Effect.void))

/**
 * The user's reaction on their own message, as its space's turn reads it: a nudge on those words,
 * which it answers or acts on even when later turns came after them. "emphasize" is their "!!".
 */
export const nudgeLine = (seq: number, words: string, reaction: string, quoted: string | null) =>
  [
    `The user reacted ${reaction === "emphasize" ? "!! (emphasize: it matters)" : reaction} to their own message ${String(seq)}: "${words}".`,
    quoted === null ? "" : `On these words of it: "${quoted}".`,
    "It's a nudge: answer that message, or do what it asks, now, even if later turns came after it.",
  ]
    .filter((l) => l !== "")
    .join("\n")

/** A peer's words, as its space's turn reads them: whose they are, then what it said. */
export const peerLine = (from: string, text: string) =>
  `${from}, another agent (not the user), says:\n\n${text}`

const chat = Effect.gen(function* chatting() {
  const brain = yield* Brain
  const sessions = yield* Sessions
  const blobs = yield* Blobs

  // Beside the turn: fixed names, a title, a brain dump's parts. What changes the turn joins it as
  // a note between tool calls; a fix that comes after the reply gets a turn of its own.
  const read = Effect.fnUntraced(function* reading(
    e: StoredEvent,
    space: SpaceId,
    text: string,
    /** Their general words, when the message also replies to quotes or asks: the pair replies stay on their pairs. */
    typed: string | null,
    note: string,
    decided: { readonly effort: Effort; readonly cost: number },
  ) {
    const done = yield* brain.read(eventHeldRead, `read:${e.id}`)
    if (done) {
      return
    }
    const spaces = yield* brain.read(spacesRead)
    const nameOf = (id: string) => spaces.find((s) => s.id === id)?.name ?? id
    const r = yield* preRead(text, note, yield* brain.read(situationRead, space))
    const others = [...new Set(r.parts.map((p) => p.space))].filter((s) => s !== space)
    // The parts it sends elsewhere aren't mentions: triage gives those.
    yield* brain.ingest([
      {
        id: EventId.make(`read:${e.id}`),
        type: MessageRead.type,
        source: "core",
        payload: {
          seq: e.seq,
          ...r,
          text: typed ?? r.text,
          effort: decided.effort,
          cost: r.cost + decided.cost,
        },
      },
    ])
    const where = space === HOME ? "Home" : nameOf(space)
    // No host now: each waits, and starts once one can (sessions.ts `wait`).
    for (const p of r.parts.filter((x) => x.space !== space)) {
      yield* waits(
        sessions.send(threadOf(p.space), `${p.text}\n\n(Part of a message in ${where}.)`, {
          title: nameOf(p.space),
          effort: decided.effort,
          id: `chat:${String(e.seq)}:part:${p.space}`,
        }),
      )
    }
    const fixed = r.text !== text
    const notes = [
      fixed ? `The user's last message, with misheard names fixed: "${r.text}"` : "",
      others.length > 0
        ? `The parts of it about ${others.map(nameOf).join(", ")} went to those spaces. Answer only what's about ${where}.`
        : "",
    ].filter((n) => n !== "")
    const running = (yield* brain.read(threadRead, threadOf(space)))?.status === "running"
    if (notes.length > 0 && (running || fixed)) {
      yield* waits(
        sessions.wake(threadOf(space), notes.join("\n"), "owed", `chat:${String(e.seq)}:read`),
      )
    }
  })

  const handle = Effect.fnUntraced(function* handling(
    e: StoredEvent,
    space: SpaceId,
    text: string,
    note: string,
    attachments: readonly Attachment[],
    replying: string,
    /** The user's replies to each of what it replies to, when it has them. */
    replies: readonly string[],
  ) {
    const name = (yield* brain.read(spacesRead)).find((s) => s.id === space)?.name ?? space
    // The process starts while the effort is decided.
    yield* Effect.forkDetach(
      Effect.ignore(sessions.warm(threadOf(space), { title: name }), { log: "Warn" }),
    )
    // Their words: each reply to what it replies to, then what they said in general.
    const words = [...replies, text].filter((s) => s.trim() !== "").join("\n\n")
    const user = yield* brain.read(userEffortRead, space, words)
    const decided = yield* effortOf(words, user)
    const files = yield* attached(blobs, attachments)
    // Replies each under what they answer come first, the general words after them.
    const said = (replies.length > 0 ? [replying, text, files.note] : [text, replying, files.note])
      .filter((s) => s !== "")
      .join("\n\n")
    const sending = sessions.send(threadOf(space), said, {
      title: name,
      effort: decided.effort,
      note,
      images: files.images,
      id: `chat:${String(e.seq)}`,
    })
    // Every account that can take it is at its limit: it waits in the record, they're told, and
    // it's picked up when one can take it (claude/src/turn.rs:512-538 `waiting`, main.rs:346 `pick_up`).
    yield* waits(sending)
    yield* Effect.forkDetach(
      Effect.ignore(read(e, space, words, replies.length > 0 ? text : null, note, decided), {
        log: "Warn",
      }),
    )
  })

  // A peer's words (peer.ts) reach the space's session as its, never as the user's, with no pre-read:
  // their names aren't misheard, and they speak for one space.
  const peer = Effect.fnUntraced(function* peering(
    e: StoredEvent,
    space: SpaceId,
    from: string,
    text: string,
  ) {
    const name = (yield* brain.read(spacesRead)).find((s) => s.id === space)?.name ?? space
    const user = yield* brain.read(userEffortRead, space, text)
    const decided = yield* effortOf(text, user)
    yield* waits(
      sessions.send(threadOf(space), peerLine(from, text), {
        title: name,
        effort: decided.effort,
        id: `chat:${String(e.seq)}`,
      }),
    )
  })

  // An edit replaces the words the running turn (or the last) answered: stop it, and say what changed.
  const edited = Effect.fnUntraced(function* editing(
    e: StoredEvent,
    seq: number,
    text: string,
    was: string,
  ) {
    const space = yield* brain.read(messageSpaceRead, seq)
    if (space === null) {
      return
    }
    if (yield* brain.read(runningBeforeRead, threadOf(space), e.seq)) {
      yield* sessions.interrupt(threadOf(space))
    }
    yield* waits(
      sessions.send(
        threadOf(space),
        `The user changed their last message from "${was}" to:

${text}

Answer this instead; what you said to the old words is gone from their chat.`,
        { id: `chat:${String(e.seq)}` },
      ),
    )
  })

  // The user's reaction on their own message nudges its space's turn to answer it; one on the
  // agent's messages stays context (context.ts), with no turn.
  const reacted = Effect.fnUntraced(function* reacting(e: StoredEvent) {
    const r = Option.getOrNull(decodeReacted(e.payload))
    if (r === null || r.reaction === null || e.source === "agent") {
      return
    }
    const said = yield* brain.read(messageRead, r.seq)
    if (said === null || whoOf(said.source) !== "user") {
      return
    }
    const name = (yield* brain.read(spacesRead)).find((s) => s.id === r.space)?.name ?? r.space
    yield* waits(
      sessions.send(
        threadOf(r.space),
        nudgeLine(r.seq, said.text, r.reaction, r.quote?.text ?? null),
        { title: name, id: `chat:${String(e.seq)}` },
      ),
    )
  })

  // An extension's wake (side.ts `isWake`): a turn in its space, as the senses wake one.
  const woke = Effect.fnUntraced(function* waking(e: StoredEvent) {
    const w = Option.getOrNull(decodeWake(e.payload))
    if (w === null) {
      return
    }
    const space = yield* brain.read(wakeSpaceRead, w.space)
    yield* waits(
      sessions.wake(
        threadOf(space),
        `${e.source}, an extension, wakes you:\n\n${w.text}`,
        "sensed",
        `chat:${String(e.seq)}`,
      ),
    )
  })

  const on = (e: StoredEvent) => {
    if (isWake(e)) {
      return woke(e)
    }
    if (e.type === MessageReacted.type) {
      return reacted(e)
    }
    if (e.type === MessagePosted.type && e.source === PEER) {
      return Option.match(decodePosted(e.payload), {
        onNone: () => Effect.void,
        onSome: (p) => peer(e, p.space, p.from ?? "An agent", p.text),
      })
    }
    if (e.type === MessagePosted.type && e.source !== "agent") {
      return Option.match(decodePosted(e.payload), {
        onNone: () => Effect.void,
        onSome: (p) =>
          Effect.flatMap(brain.read(repliesLineRead, p.replyTo ?? [], p.item), (replying) =>
            handle(
              e,
              p.space,
              p.text,
              dictatedNote(p.text, p.dictated),
              p.attachments ?? [],
              replying,
              (p.replyTo ?? []).flatMap((r) =>
                (r.reply ?? "").trim() === "" ? [] : [(r.reply ?? "").trim()],
              ),
            ),
          ),
      })
    }
    if (e.type === ThreadSteered.type) {
      return Option.match(decodeSteered(e.payload), {
        onNone: () => Effect.void,
        onSome: (p) =>
          waits(
            sessions.send(p.thread, p.text, {
              note: dictatedNote(p.text, p.dictated),
              id: `chat:${String(e.seq)}`,
            }),
          ),
      })
    }
    if (e.type === ThreadStopped.type) {
      return Option.match(decodeStopped(e.payload), {
        onNone: () => Effect.void,
        // It waits for the turn to end: other spaces' messages shouldn't. Read again after a
        // restart, it stops only the turn it was meant for.
        onSome: (p) =>
          Effect.flatMap(brain.read(runningBeforeRead, p.thread, e.seq), (stops) =>
            stops ? Effect.asVoid(Effect.forkDetach(sessions.interrupt(p.thread))) : Effect.void,
          ),
      })
    }
    if (e.type === MessageEdited.type) {
      return Option.match(decodeEdited(e.payload), {
        onNone: () => Effect.void,
        onSome: (p) => edited(e, p.seq, p.text, p.was),
      })
    }
    return Effect.void
  }

  // Fetches the gateway key and opens its connection now, not on the user's first message.
  yield* Effect.forkDetach(effortOf("hi", { rules: "", fallback: "medium" }))
  // A canary's copy of the brain is caught up on nothing: only what comes after it starts.
  const { canary } = yield* CoreConfig
  // One at a time, from its cursor, so a space's messages reach its session in order and what
  // came as the core stopped (a message, a Stop, a steer, an edit, a reaction) is read once it's back.
  return yield* react(
    "chat",
    (e) =>
      isWake(e) ||
      e.type === MessageReacted.type ||
      (e.type === MessagePosted.type && e.source !== "agent") ||
      e.type === ThreadSteered.type ||
      e.type === ThreadStopped.type ||
      e.type === MessageEdited.type,
    on,
    { fresh: canary, seed: seedRead, rewind: rewindRead },
  )
})

/**
 * Triage reads every batch; what it wakes gets a turn, or joins the running one between tools.
 * Its fast path reads each commit as it lands, so an urgent event needn't wait for its batch. It
 * reads on from where it left off (a batch under way as the core stopped is read again), and what
 * it wakes waits in the record with what woke it, so `kick` here, or the sessions' `drain` after a
 * restart, starts it.
 */
const triage = Effect.gen(function* triaging() {
  const brain = yield* Brain
  const sessions = yield* Sessions
  const t = yield* Triage
  const { canary } = yield* CoreConfig
  const { from } = t
  const read = canary || from === undefined ? null : yield* from
  const seq = read ?? (yield* brain.read(headRead))
  const wakeAll = (wakes: readonly Wake[]) =>
    Effect.forEach(
      new Set(wakes.map((w) => w.thread)),
      (thread) => Effect.forkDetach(sessions.kick(thread)),
      { discard: true },
    )
  // The wake rules' bursts, looked at every five seconds as Switchboard's ponderer ticked (ponder.rs:132).
  const { due } = t
  if (due !== undefined) {
    yield* Effect.forkScoped(
      Effect.forever(Effect.sleep("5 seconds").pipe(Effect.andThen(due), Effect.flatMap(wakeAll))),
    )
  }
  const { urgent } = t
  if (urgent !== undefined) {
    yield* Effect.forkScoped(
      brain.changes(seq).pipe(
        Stream.chunks,
        Stream.mapEffect((events) => urgent(events), { concurrency: 8, unordered: true }),
        Stream.runForEach(wakeAll),
      ),
    )
  }
  return yield* brain.changes(seq).pipe(
    Stream.groupedWithin(64, "200 millis"),
    Stream.mapEffect((batch) => t.wakes(batch)),
    Stream.runForEach(wakeAll),
  )
})

export const chatLayer = Layer.effectDiscard(Effect.forkScoped(chat))
export const triageLayer = Layer.effectDiscard(Effect.forkScoped(triage))
