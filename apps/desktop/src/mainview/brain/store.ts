// The brain as the UI reads it: the snapshot (spaces, threads, the board's extras), live events
// folded on top. It lives in the query cache (client.ts), changed only through immer drafts, so a
// selector sees a new value exactly where something changed. Chats and transcripts are paged, so
// they're their own queries (history.ts).
import type { ThreadStatus } from "@switch/agent"
import type { MessagePosted, Space, SpaceId, StoredEvent, ThreadId } from "@switch/brain"
import { hashOf, HOME, Reaction } from "@switch/brain/commands"
import type { Attachment, Reactions } from "@switch/brain/commands"
import { Schema } from "effect"
import type { Draft } from "immer"

import * as adapter from "./adapter.ts"
import type { Link } from "./connection.ts"
import { rec, spaceId, str, threadId } from "./json.ts"

export interface SpaceRow extends Space {
  /** Its place in the order spaces were made, for stable order and station numbers. */
  readonly made: number
  /** Its cover's blob (at /blobs/<hash>), or none. */
  readonly cover?: string
}

/** One transcript entry of a thread, in log order. */
export interface Item {
  readonly seq: number
  readonly turn: string
  readonly kind: "user" | "text" | "tool" | "result" | "steer" | "wake"
  readonly text: string
  /** A tool call's id, and the id of the call a result answers. */
  readonly id?: string
  /** A tool's name. */
  readonly name?: string
  readonly input?: unknown
  readonly error?: boolean
}

export interface ThreadRow {
  readonly id: ThreadId
  readonly parent: ThreadId | null
  readonly title: string
  readonly status: ThreadStatus
  readonly turn: string | null
  /** The seq it was opened at: a tag of it says its space. */
  readonly opened: number
  /** Its own space, from its tag; null takes its parent's. */
  readonly home: SpaceId | null
  /** When the running turn started, or the last ended. */
  readonly since: number
  readonly result: string
  /** Text streaming into the running turn, until its block lands. */
  readonly streaming: string
  /** Its latest turn's entries, for its live step; the whole transcript is paged. */
  readonly items: readonly Item[]
  /** Drafts the reply gate sent back: never shown. */
  readonly rejected: ReadonlySet<string>
  /** Where a task's work stands, as it says ("building"); empty when it hasn't said. */
  readonly stage: string
  /** Its latest turn has none of the user's words in it (no steer of theirs joined it). */
  readonly woken: boolean
  /** And the senses woke it: nothing shows it running. */
  readonly sensed: boolean
}

/** An app's widget shown in a chat, its tool called with `input`. */
export interface Shown {
  readonly app: string
  readonly name: string
  readonly input?: Readonly<Record<string, unknown>>
}

/** A line's widget, if it's one. */
const shownOf = (raw: unknown): { widget?: Shown } => {
  const w = rec(raw)
  if (!str(w.app)) {
    return {}
  }
  const input = w.input === undefined ? {} : { input: rec(w.input) }
  return { widget: { app: str(w.app), name: str(w.name), ...input } }
}

/** A line's files, as far as they read. */
const attachmentsOf = (raw: unknown): { attachments?: readonly Attachment[] } => {
  const files = list(raw).flatMap((a) => {
    const blob = hashOf(str(a.blob))
    return blob === null
      ? []
      : [{ blob, name: str(a.name), type: str(a.type), size: Number(a.size) || 0 }]
  })
  return files.length > 0 ? { attachments: files } : {}
}

/**
 * What a message of the user's replies to: words of a message (by its seq), or an action item; each
 * with the user's own reply to it, when there is one.
 */
export type Reply =
  | { readonly kind: "quote"; readonly seq: number; readonly text: string; readonly reply?: string }
  | { readonly kind: "ask"; readonly id: string; readonly title?: string; readonly reply?: string }

/** Replies as kept on this Mac (a draft's, a message's in the outbox). */
export const Replies = Schema.Array(
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("quote"),
      seq: Schema.Number,
      text: Schema.String,
      reply: Schema.optionalKey(Schema.String),
    }),
    Schema.Struct({
      kind: Schema.Literal("ask"),
      id: Schema.String,
      title: Schema.optionalKey(Schema.String),
      reply: Schema.optionalKey(Schema.String),
    }),
  ]),
)

/** A side's reaction to words of a message. */
export interface Part {
  readonly side: "user" | "agent"
  readonly reaction: Reaction
  readonly text: string
}

/** What a line replies to, as far as it reads. */
const repliesOf = (raw: unknown): { replyTo?: readonly Reply[] } => {
  const refs = list(raw).flatMap((r): Reply[] => {
    const reply = str(r.reply).trim() === "" ? {} : { reply: str(r.reply) }
    if (r.kind === "quote" && str(r.text) !== "") {
      return [{ kind: "quote", seq: Number(r.seq), text: str(r.text), ...reply }]
    }
    if (r.kind === "ask" && str(r.id) !== "") {
      return [
        {
          kind: "ask",
          id: str(r.id),
          ...(str(r.title) !== "" && { title: str(r.title) }),
          ...reply,
        },
      ]
    }
    return []
  })
  return refs.length > 0 ? { replyTo: refs } : {}
}

/** The reactions to words of a line, as far as they read. */
const partsOf = (raw: unknown): { parts?: readonly Part[] } => {
  const parts = list(raw).flatMap((p): Part[] => {
    const reaction = reactionOf(p.reaction)
    return reaction !== undefined && str(p.text) !== ""
      ? [{ side: p.side === "agent" ? "agent" : "user", reaction, text: str(p.text) }]
      : []
  })
  return parts.length > 0 ? { parts } : {}
}

/** A line in a space's chat. */
export interface Line {
  readonly seq: number
  readonly time: number
  readonly who: "user" | "agent"
  readonly text: string
  /** The space it was said in. */
  readonly home: SpaceId
  /** The other spaces it bears on. */
  readonly mentions: readonly SpaceId[]
  /** The turn a reply came from. */
  readonly turn: string | null
  /** A widget instead of text. */
  readonly widget?: Shown
  /** A quiet line: an app's outcome (its words in `text`), or where the exchange at `of` went. */
  readonly quiet?: Quiet
  /** The action item a reply of the user's was on. */
  readonly item?: string
  readonly attachments?: readonly Attachment[]
  /** A reply's long version, opened on demand. */
  readonly detail?: string
  /** A reply revised in place since it posted. */
  readonly edited?: boolean
  /** Each side's tapback. */
  readonly reactions?: Reactions
  /** What a message of the user's replies to. */
  readonly replyTo?: readonly Reply[]
  /** Reactions to words of it. */
  readonly parts?: readonly Part[]
  /** The display name of the model that wrote it. */
  readonly model?: string
}

/** The display name of the model a line or item records, when it does. */
export const modelOf = (raw: unknown): { model?: string } => {
  const name = str(rec(raw).name)
  return name === "" ? {} : { model: name }
}

/** A reaction as the brain says it, or none. */
const isReaction = Schema.is(Reaction)
export const reactionOf = (v: unknown): Reaction | undefined => (isReaction(v) ? v : undefined)

/** Each side's reaction, as far as they read. */
const reactionsOf = (raw: unknown): { reactions?: Reactions } => {
  const r = rec(raw)
  const user = reactionOf(r.user)
  const agent = reactionOf(r.agent)
  if (user === undefined && agent === undefined) {
    return {}
  }
  return {
    reactions: { ...(user !== undefined && { user }), ...(agent !== undefined && { agent }) },
  }
}

const strings = (v: unknown) => (Array.isArray(v) ? v.map(str) : [])

/** A `memory.written` from a turn's work, or a dial it moved (`setting.set`), as its "Remembered" line in that space. */
export const learnedLine = (e: StoredEvent): Line | null => {
  const p = rec(e.payload)
  if (!str(p.space) || (!str(p.decision) && e.type !== "setting.set")) {
    return null
  }
  return {
    seq: e.seq,
    time: e.time,
    who: "agent",
    text: str(p.description),
    home: spaceId(p.space),
    mentions: [],
    turn: null,
    quiet: { kind: "learned", id: str(p.id), restore: strings(p.replaces) },
  }
}

export type Quiet =
  /** An app's outcome, or a condition's line revised through `until`. */
  | { readonly kind: "event"; readonly until: number }
  /** A memory a turn learned here, and what it replaced: Undo forgets it and puts those back. */
  | { readonly kind: "learned"; readonly id: string; readonly restore: string[] }

/** Sent, not yet in the log: a message kept in the outbox, or one the core took as of `landed`
 * whose line hasn't come yet. */
export interface Pending {
  readonly id: string
  readonly space: SpaceId
  readonly text: string
  /** The files' names. */
  readonly files: readonly string[]
  /** The core said no. */
  readonly failed: boolean
  /** What it replies to. */
  readonly replyTo?: readonly Reply[]
  readonly landed?: number
}

export interface State {
  readonly seq: number
  readonly link: Link
  /** Whether the first snapshot has landed. */
  readonly ready: boolean
  readonly spaces: ReadonlyMap<SpaceId, SpaceRow>
  readonly threads: ReadonlyMap<ThreadId, ThreadRow>
  /** The latest chat line in each space, carried up to the spaces above, for warmth. */
  readonly warm: ReadonlyMap<SpaceId, number>
  /** How far the user has read each space's chat, on any device. */
  readonly reads: ReadonlyMap<SpaceId, number>
  /** Each space's latest reply: unread while it's past the read mark. */
  readonly replies: ReadonlyMap<SpaceId, number>
  readonly pending: ReadonlyMap<string, Pending>
  readonly extra: adapter.Extra
}

type Posted = typeof MessagePosted.payload.Type

const home = (): SpaceRow => ({
  id: HOME,
  name: "Home",
  parent: null,
  about: "",
  ephemeral: false,
  archived: false,
  ink: null,
  made: 0,
})

/** Before the first snapshot: Home alone. */
export const empty = (): State => ({
  seq: 0,
  link: "connecting",
  ready: false,
  spaces: new Map([[HOME, home()]]),
  threads: new Map(),
  warm: new Map(),
  reads: new Map(),
  replies: new Map(),
  pending: new Map(),
  extra: adapter.empty(),
})

/** Read through `seq`: the read mark only moves forward. */
export const readTo = (st: Draft<State>, space: SpaceId, seq: number) => {
  if (seq > (st.reads.get(space) ?? 0)) {
    st.reads.set(space, seq)
  }
}

const warmUp = (st: Draft<State>, space: SpaceId, seq: number) => {
  const seen = new Set<string>()
  for (
    let s = st.spaces.get(space);
    s !== undefined && !seen.has(s.id);
    s = s.parent === null ? undefined : st.spaces.get(s.parent)
  ) {
    seen.add(s.id)
    st.warm.set(s.id, Math.max(st.warm.get(s.id) ?? 0, seq))
  }
}

/** Home has none; any other space without one sits in Home. */
const parentOf = (id: SpaceId, raw: unknown) => {
  if (id === HOME) {
    return null
  }
  return str(raw) ? spaceId(raw) : HOME
}

/** A space made by the user, shown before the brain says so. */
export const madeSpace = (st: Draft<State>, id: SpaceId, name: string, parent: SpaceId | null) => {
  st.spaces.set(id, {
    id,
    name,
    parent: parentOf(id, parent),
    about: "",
    ephemeral: false,
    archived: false,
    ink: null,
    made: st.spaces.size + 1,
  })
}

const space = (st: Draft<State>, e: StoredEvent, p: Record<string, unknown>) => {
  const id = spaceId(p.id)
  const s = st.spaces.get(id)
  if (e.type === "space.created") {
    madeSpace(st, id, str(p.name), str(p.parent) ? spaceId(p.parent) : null)
    const made = st.spaces.get(id)
    if (made) {
      made.about = str(p.about)
      made.ephemeral = p.ephemeral === true
    }
    return
  }
  if (e.type === "space.tagged") {
    tagThreads(st, Number(p.seq), spaceId(p.home))
    return
  }
  if (!s) {
    return
  }
  switch (e.type) {
    case "space.inked": {
      s.ink = { day: str(p.day), night: str(p.night) }
      return
    }
    case "space.renamed": {
      s.name = str(p.name)
      return
    }
    case "space.described": {
      s.about = str(p.about)
      return
    }
    case "space.cover_set": {
      if (typeof p.image === "string") {
        s.cover = p.image
      } else {
        delete s.cover
      }
      return
    }
    case "space.moved": {
      s.parent = spaceId(p.parent)
      return
    }
    case "space.archived": {
      s.archived = true
      return
    }
    case "space.unarchived": {
      s.archived = false
      return
    }
    case "space.promoted": {
      s.ephemeral = false
      break
    }
    default:
  }
}

const SPACE_THREAD = "space:"

/** A transcript entry of the running turn: kept here for its live step and draft. */
const addItem = (st: Draft<State>, item: Item, thread: ThreadId) => {
  const t = st.threads.get(thread)
  if (t && t.turn === item.turn) {
    t.items.push(item)
  }
}

const opened = (st: Draft<State>, e: StoredEvent, p: Record<string, unknown>) => {
  const id = threadId(p.thread)
  st.threads.set(id, {
    id,
    parent: typeof p.parent === "string" ? threadId(p.parent) : null,
    title: str(p.title),
    status: "idle",
    turn: null,
    opened: e.seq,
    home: id.startsWith(SPACE_THREAD) ? spaceId(id.slice(SPACE_THREAD.length)) : null,
    since: e.time,
    result: "",
    streaming: "",
    items: [],
    rejected: new Set(),
    stage: "",
    woken: false,
    sensed: false,
  })
}

const ended = (t: Draft<ThreadRow> | undefined, e: StoredEvent, p: Record<string, unknown>) => {
  if (t && t.turn === str(p.turn)) {
    // Done while its work goes on elsewhere (a watch, a script), it waits until `thread.settled`.
    if (p.status === "failed" || p.status === "limited" || p.status === "interrupted") {
      t.status = p.status
    } else {
      t.status = p.going === true ? "waiting" : "done"
    }
    t.result = t.status === "done" ? "" : str(p.result)
    t.since = e.time
    t.streaming = ""
  }
}

/** A turn event as a transcript entry, or null for one that isn't. */
export const itemOf = (e: StoredEvent, p: Record<string, unknown>): Item | null => {
  const at = { seq: e.seq, turn: str(p.turn) }
  switch (e.type) {
    case "turn.started": {
      return { ...at, kind: "user", text: str(p.text) }
    }
    case "turn.text": {
      return { ...at, kind: "text", text: str(p.text) }
    }
    case "turn.tool": {
      return { ...at, kind: "tool", text: "", id: str(p.id), name: str(p.name), input: p.input }
    }
    case "turn.result": {
      return { ...at, kind: "result", text: str(p.output), id: str(p.id), error: p.error === true }
    }
    case "turn.injected": {
      return { ...at, kind: p.kind === "wake" ? "wake" : "steer", text: str(p.text) }
    }
    default: {
      return null
    }
  }
}

/** A turn starting: none of the user's words in it is a wake; the senses' one says so. */
const started = (t: Draft<ThreadRow>, e: StoredEvent, p: Record<string, unknown>) => {
  t.status = "running"
  t.turn = str(p.turn)
  t.since = e.time
  t.streaming = ""
  t.result = ""
  t.items = []
  t.stage = ""
  t.woken = str(p.text).trim() === ""
  t.sensed = t.woken && p.sensed === true
}

/** A steer of theirs joining its turn makes it theirs; the senses' wake, sensed. */
const injected = (t: Draft<ThreadRow>, p: Record<string, unknown>) => {
  if (t.turn !== str(p.turn)) {
    return
  }
  if (p.kind === "steer") {
    t.woken = false
    t.sensed = false
  } else if (p.sensed === true) {
    t.sensed = t.woken
  }
}

/** What its turn left going has stopped: it's done. */
const settled = (t: Draft<ThreadRow>, p: Record<string, unknown>) => {
  if (t.status === "waiting" && t.turn === str(p.turn)) {
    t.status = "done"
    t.result = ""
  }
}

const turn = (st: Draft<State>, e: StoredEvent, p: Record<string, unknown>) => {
  const t = st.threads.get(threadId(p.thread))
  if (e.type === "thread.opened") {
    opened(st, e, p)
    return
  }
  if (t && e.type === "turn.started") {
    started(t, e, p)
  } else if (t && e.type === "turn.injected") {
    injected(t, p)
  } else if (t && e.type === "thread.settled") {
    settled(t, p)
  } else if (t && e.type === "thread.staged") {
    t.stage = str(p.stage).trim()
  } else if (t && e.type === "turn.delta") {
    t.streaming += str(p.text)
  } else if (t && e.type === "turn.text") {
    t.streaming = ""
  } else if (e.type === "turn.ended") {
    ended(t, e, p)
  }
  const item = itemOf(e, p)
  if (item) {
    addItem(st, item, threadId(p.thread))
  }
}

const bounced = (st: Draft<State>, turnId: string, text: string) => {
  for (const t of st.threads.values()) {
    if (t.turn === turnId || t.items.some((i) => i.turn === turnId)) {
      t.rejected.add(text.trim())
    }
  }
}

/** The line a `message.posted` event is. */
export const postedLine = (e: StoredEvent): Line => {
  const m: Partial<Posted> = rec(e.payload)
  const where = m.space ? spaceId(m.space) : HOME
  return {
    seq: e.seq,
    time: e.time,
    who: e.source === "agent" ? "agent" : "user",
    text: str(m.text),
    home: where,
    mentions: [],
    turn: str(m.turn) || null,
    ...shownOf(m.widget),
    ...(str(m.item) !== "" && { item: str(m.item) }),
    ...attachmentsOf(m.attachments),
    ...(str(m.detail).trim() !== "" && { detail: str(m.detail) }),
    ...repliesOf(m.replyTo),
    ...modelOf(m.model),
  }
}

const fold = (st: Draft<State>, e: StoredEvent) => {
  const p = rec(e.payload)
  if (e.type === "space.read") {
    readTo(st, spaceId(p.space), Number(p.seq))
  } else if (e.type.startsWith("space.")) {
    space(st, e, p)
  } else if (e.type.startsWith("thread.") || e.type.startsWith("turn.")) {
    turn(st, e, p)
  } else if (e.type === "gate.decided") {
    // A reply the gate bounced: its draft goes, and the revision takes its place.
    if (p.exit === "reply" && p.pass === false) {
      bounced(st, str(p.turn), str(p.text))
    }
  } else if (e.type === "message.posted") {
    const where = postedLine(e).home
    warmUp(st, where, e.seq)
    if (e.source === "agent") {
      st.replies.set(where, e.seq)
    } else {
      readTo(st, where, e.seq)
    }
    for (const id of st.pending.keys()) {
      if (e.id.startsWith(`${id}:`)) {
        st.pending.delete(id)
      }
    }
  } else if (e.type === "iphone.activity") {
    adapter.activity(st.extra, p)
  } else {
    adapter.fold(st.extra, e, p)
  }
}

/** Live events, folded in order. */
export const apply = (st: Draft<State>, events: readonly StoredEvent[]) => {
  for (const e of events) {
    fold(st, e)
    st.seq = e.seq
  }
  for (const p of st.pending.values()) {
    if (p.landed !== undefined && p.landed <= st.seq) {
      st.pending.delete(p.id)
    }
  }
}

/** The tag of a thread's opening says its space. */
const tagThreads = (st: Draft<State>, seq: number, where: SpaceId) => {
  for (const t of st.threads.values()) {
    if (t.opened === seq) {
      t.home = where
    }
  }
}

const inkOf = (raw: unknown): SpaceRow["ink"] => {
  const i = rec(raw)
  return typeof i.day === "string" && typeof i.night === "string"
    ? { day: i.day, night: i.night }
    : null
}

export const list = (v: unknown) => (Array.isArray(v) ? v.map(rec) : [])

const KINDS: readonly Item["kind"][] = ["user", "text", "tool", "result", "steer", "wake"]

export const toItem = (raw: Record<string, unknown>): Item => {
  const kind = KINDS.find((k) => k === raw.kind) ?? "text"
  return {
    seq: Number(raw.seq),
    turn: str(raw.turn),
    kind,
    text: kind === "result" ? str(raw.output) : str(raw.text),
    ...(kind === "tool" && { id: str(raw.id), name: str(raw.name), input: raw.input }),
    ...(kind === "result" && { id: str(raw.id), error: raw.error === true }),
  }
}

export const toLine = (raw: Record<string, unknown>): Line => ({
  seq: Number(raw.seq),
  time: Number(raw.time),
  who: raw.who === "agent" ? "agent" : "user",
  text: str(raw.text),
  home: spaceId(raw.home),
  mentions: Array.isArray(raw.mentions) ? raw.mentions.map(spaceId) : [],
  turn: typeof raw.turn === "string" ? raw.turn : null,
  ...shownOf(raw.widget),
  ...quietOf(raw),
  ...(str(raw.item) !== "" && { item: str(raw.item) }),
  ...attachmentsOf(raw.attachments),
  ...(str(raw.detail) !== "" && { detail: str(raw.detail) }),
  ...(raw.edited === true && { edited: true }),
  ...reactionsOf(raw.reactions),
  ...repliesOf(raw.replyTo),
  ...partsOf(raw.parts),
  ...modelOf(raw.model),
})

const quietOf = (raw: Record<string, unknown>): { quiet?: Quiet } => {
  if (raw.kind === "event") {
    return { quiet: { kind: "event", until: Number(raw.until) } }
  }
  if (raw.kind === "learned") {
    return { quiet: { kind: "learned", id: str(raw.memory), restore: strings(raw.restore) } }
  }
  return {}
}

const STATUSES: readonly ThreadStatus[] = [
  "idle",
  "running",
  "waiting",
  "done",
  "interrupted",
  "failed",
  "limited",
]

/** The snapshot: everything the board shows, replacing what was held but what's still unsent. */
export const fromSnapshot = (
  prev: State,
  seq: number,
  given: Readonly<Record<string, unknown>>,
): State => ({
  seq,
  link: prev.link,
  ready: true,
  spaces: new Map([
    [HOME, home()],
    ...list(given.spaces).map((s): [SpaceId, SpaceRow] => [
      spaceId(s.id),
      {
        id: spaceId(s.id),
        name: str(s.name),
        parent: parentOf(spaceId(s.id), s.parent),
        about: str(s.about),
        ephemeral: s.ephemeral === true,
        archived: s.archived === true,
        ink: inkOf(s.ink),
        made: Number(s.made),
        ...(typeof s.cover === "string" && { cover: s.cover }),
      },
    ]),
  ]),
  threads: new Map(
    list(given.threads).map((t) => [
      threadId(t.id),
      {
        id: threadId(t.id),
        parent: typeof t.parent === "string" ? threadId(t.parent) : null,
        title: str(t.title),
        status: STATUSES.find((x) => x === t.status) ?? "idle",
        turn: typeof t.turn === "string" ? t.turn : null,
        opened: Number(t.opened),
        home: typeof t.home === "string" ? spaceId(t.home) : null,
        since: Number(t.since),
        result: str(t.result),
        streaming: "",
        items: list(t.items).map(toItem),
        rejected: new Set<string>(),
        stage: str(t.stage),
        woken: t.woken === true,
        sensed: t.sensed === true,
      },
    ]),
  ),
  warm: new Map(),
  reads: new Map(list(given.reads).map((r) => [spaceId(r.space), Number(r.seq)])),
  replies: new Map(list(given.replies).map((r) => [spaceId(r.space), Number(r.seq)])),
  // What landed is in it (or gone with a restore): only what's still kept stays.
  pending: new Map([...prev.pending].filter(([, p]) => p.landed === undefined)),
  extra: adapter.fromSnapshot(given),
})

/** Warmth from the snapshot, carried up to the spaces above. */
export const warmFrom = (st: Draft<State>, given: Readonly<Record<string, unknown>>) => {
  for (const w of list(given.warm)) {
    warmUp(st, spaceId(w.space), Number(w.seq))
  }
}
