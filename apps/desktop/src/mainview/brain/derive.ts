// What a space's page shows, read from the state.
import type { Attachment, SpaceId } from "@switch/brain"

import * as adapter from "./adapter.ts"
import { threadId } from "./json.ts"
import { HOME } from "@switch/brain/commands"
import type { Reactions } from "@switch/brain/commands"
import type {
  Line,
  Part,
  Pending,
  Quiet,
  Reply,
  Shown,
  SpaceRow,
  State,
  ThreadRow,
} from "./store.ts"

export const live = (s: State) => [...s.spaces.values()].filter((x) => !x.archived)

/** The space and every space under it. */
export const subtree = (s: State, id: SpaceId): Set<SpaceId> => {
  const out = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const x of s.spaces.values()) {
      if (x.parent !== null && out.has(x.parent) && !out.has(x.id)) {
        out.add(x.id)
        grew = true
      }
    }
  }
  return out
}

/** The spaces above, from Home down, without the space itself. */
export const above = (s: State, id: SpaceId): SpaceRow[] => {
  const out: SpaceRow[] = []
  const seen = new Set<string>()
  const parent = s.spaces.get(id)?.parent
  for (let x = parent ? s.spaces.get(parent) : undefined; x && !seen.has(x.id);) {
    seen.add(x.id)
    out.unshift(x)
    x = x.parent === null ? undefined : s.spaces.get(x.parent)
  }
  return out
}

/** Which space a thread works in: its own tag, else its parent's, else Home. */
export const spaceOf = (s: State, t: ThreadRow) => {
  const seen = new Set<string>()
  for (let x: ThreadRow | undefined = t; x !== undefined && !seen.has(x.id);) {
    seen.add(x.id)
    if (x.home !== null) {
      return x.home
    }
    x = x.parent === null ? undefined : s.threads.get(x.parent)
  }
  return HOME
}

export interface Work {
  readonly thread: ThreadRow
  readonly space: SpaceId
  readonly step: string
}

/** Switch's own apps, whose tools a turn calls through the gateway. */
const OWN_APPS = [
  "brain",
  "autonomy",
  "skills",
  "connections",
  "extensions",
  "accounts",
  "inbox",
  "iphone",
]

/** The apps a turn's tools may come from: Switch's own and the installed extensions. */
export const appNames = (s: State) => [...OWN_APPS, ...s.extra.extensions.keys()]

/** A task the agent set going, as `task-…`; not a space's chat, nor the core's own threads (a
 * one-shot model call's `run-…` "Completion", a check's fix turn, a reflection), which aren't work
 * of the user's (the user, Nov 23: "idk what 'completion' is"). */
export const isTask = (t: ThreadRow) => t.id.startsWith("task-")

/** Tasks under way in the space itself, not the spaces under it, oldest first. A space's own chat turn isn't one: the
 * chat shows it typing instead (DESIGN.md, Running), unlike Switchboard's Running, which counted
 * chat work too (core/src/places.rs:370-372). A turn the senses woke isn't work under way for them
 * (core/src/places.rs:93). */
export const work = (s: State, id: SpaceId) => {
  const running: Work[] = []
  for (const t of s.threads.values()) {
    const space = spaceOf(s, t)
    if (space !== id) {
      continue
    }
    // Only a turn under way now. Work waiting (a watch or a script still open) isn't running: listed
    // here, it read as running for hours (the user, Nov 23: "showing that they've been running for
    // hours and hours").
    if (!isTask(t)) {
      continue
    }
    if (t.status === "running" && !t.sensed) {
      running.push({ thread: t, space, step: adapter.liveStep(t, appNames(s)) })
    }
  }
  running.sort((a, b) => a.thread.since - b.thread.since)
  return running
}

/** Extensions' long jobs under way in the space itself (their Live Activities), oldest first. */
export const activities = (s: State, id: SpaceId) =>
  [...s.extra.activities.values()]
    .filter((a) => a.space === id && a.state !== "done")
    .toSorted((a, b) => a.startedAt - b.startedAt)

/** The space's own open asks, not the spaces' under it. */
export const actions = (s: State, id: SpaceId) =>
  [...s.extra.actions.values()].filter((a) => a.space === id).toSorted((a, b) => a.at - b.at)

export const widgets = (s: State, id: SpaceId) => s.extra.widgets.filter((w) => w.space === id)

/** The spaces right inside, warmest first. */
export const children = (s: State, id: SpaceId) =>
  live(s)
    .filter((x) => x.parent === id && x.id !== id)
    .toSorted((a, b) => (s.warm.get(b.id) ?? b.made) - (s.warm.get(a.id) ?? a.made))

/** Every space, warmest first, for the palette. */
export const warmest = (s: State) =>
  live(s).toSorted((a, b) => (s.warm.get(b.id) ?? b.made) - (s.warm.get(a.id) ?? a.made))

export interface ChatLine {
  /** Unique within a chat. */
  readonly key: string
  /** The message's seq, once it's in the log, and the space it was said in. */
  readonly seq?: number
  readonly home?: SpaceId
  readonly who: "user" | "agent"
  readonly text: string
  /** The other spaces it bears on, besides this one. */
  readonly also: readonly SpaceId[]
  readonly pending?: Pending
  /** A widget instead of text, and the line's seq. */
  readonly widget?: { readonly shown: Shown; readonly seq: number }
  /** When it was said; none until it's in the log. */
  readonly time?: number
  readonly quiet?: Quiet
  /** The title of the action item a reply was on. */
  readonly on?: string
  readonly attachments?: readonly Attachment[]
  /** A reply's long version, opened on demand. */
  readonly detail?: string
  /** A reply revised in place since it posted. */
  readonly edited?: boolean
  /** Each side's tapback: the user's and the agent's. */
  readonly reactions?: Reactions
  /** What a message of the user's replies to: words of a message, or an action item. */
  readonly replyTo?: readonly Reply[]
  /** Reactions to words of it. */
  readonly parts?: readonly Part[]
  /** The display name of the model that wrote it. */
  readonly model?: string
}

/** What a line replies to: its own refs, and the item an older reply was on (`item`). */
const repliesTo = (line: Line): readonly Reply[] => [
  ...(line.replyTo ?? []),
  ...(line.item !== undefined &&
  !(line.replyTo ?? []).some((r) => r.kind === "ask" && r.id === line.item)
    ? [{ kind: "ask" as const, id: line.item }]
    : []),
]

/**
 * A line's general words: none when they only repeat its replies under what it replies to (the
 * pre-read once stored those as its words too).
 */
const generalOf = (line: Line) => {
  const replies = (line.replyTo ?? []).flatMap((r) => {
    const reply = (r.reply ?? "").trim()
    return reply === "" ? [] : [reply]
  })
  return replies.length > 0 && line.text.trim() === replies.join("\n\n") ? "" : line.text
}

/** An item's title, open or lately closed. */
const titleOf = (s: State, id: string) =>
  (s.extra.actions.get(id) ?? s.extra.revising.get(id) ?? s.extra.closed.find((c) => c.id === id))
    ?.title ?? ""

/**
 * A space's chat: what's posted in it or mentions it, then what's sent but not yet in the log. A
 * turn's steps, and its words until they're posted, are its thread's, never the chat's.
 */
export const chat = (s: State, id: SpaceId, held: readonly Line[]): ChatLine[] => {
  const out: ChatLine[] = held.map((line) => ({
    key: String(line.seq),
    seq: line.seq,
    home: line.home,
    who: line.who,
    text: generalOf(line),
    also: [line.home, ...line.mentions].filter((x) => x !== id && s.spaces.has(x)),
    time: line.time,
    ...(line.quiet && { quiet: line.quiet }),
    ...(line.widget && { widget: { shown: line.widget, seq: line.seq } }),
    ...(line.attachments && { attachments: line.attachments }),
    ...(line.detail !== undefined && { detail: line.detail }),
    ...(line.edited === true && { edited: true }),
    ...(line.reactions && { reactions: line.reactions }),
    ...(line.item !== undefined && titleOf(s, line.item) !== "" && { on: titleOf(s, line.item) }),
    ...(repliesTo(line).length > 0 && { replyTo: repliesTo(line) }),
    ...(line.parts && { parts: line.parts }),
    ...(line.model !== undefined && { model: line.model }),
  }))
  for (const p of s.pending.values()) {
    if (p.space === id) {
      out.push({
        key: p.id,
        who: "user",
        text: p.text,
        also: [],
        pending: p,
        ...(p.replyTo && { replyTo: p.replyTo }),
      })
    }
  }
  return out
}

/** When the space's chat turn answering the user started, while it works and hasn't replied yet:
 * the chat shows it typing. A turn with none of their words in it isn't answering them. */
export const typingSince = (s: State, id: SpaceId) => {
  const t = s.threads.get(threadId(`space:${id}`))
  return t?.status === "running" && !t.woken ? t.since : null
}

/** What the core ends a turn the user stopped on (agent turn.ts STOPPED); a cut one records its cause. */
const STOPPED = "Stopped"
/** A turn the deploy paused (agent turn.ts PAUSED): the updated core carries it on. */
const PAUSED = "Paused for an update"

/** The space's chat turn answering the user, when it ended with no reply and the user didn't stop
 * it (it failed, hit a limit, or was cut off; not paused for an update): their last message there
 * shows Not Delivered, and Retry runs the turn again. */
export const undelivered = (s: State, id: SpaceId) => {
  const t = s.threads.get(threadId(`space:${id}`))
  const unanswered =
    t?.status === "failed" ||
    t?.status === "limited" ||
    (t?.status === "interrupted" && t.result !== STOPPED && t.result !== PAUSED)
  return t !== undefined && unanswered && !t.woken ? t.id : null
}

/** The latest reply in the space's own chat, if the user hasn't read that far. */
export const unreadAt = (s: State, id: SpaceId) => {
  const reply = s.replies.get(id) ?? 0
  return reply > (s.reads.get(id) ?? 0) ? reply : null
}

/** Whether the space, or one under it, has a reply the user hasn't read. */
export const unread = (s: State, id: SpaceId) =>
  [...subtree(s, id)].some((x) => s.spaces.get(x)?.archived !== true && unreadAt(s, x) !== null)

/** A space's live marks, as its row shows them, for it and the spaces under it: running, how many
 * need the user, unread. */
export const marks = (s: State, id: SpaceId) => {
  const inside = [...subtree(s, id)]
  return {
    running: inside.some((x) => work(s, x).length + activities(s, x).length > 0),
    needs: inside.reduce((n, x) => n + actions(s, x).length, 0),
    unread: unread(s, id),
  }
}
