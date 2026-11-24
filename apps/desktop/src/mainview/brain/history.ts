// Paged history in the query cache: each space's chat and each opened thread's transcript is an
// infinite query, newest page first. The snapshot seeds every chat's first page; live lines and
// entries go into the first page as they land; older pages come in as the user scrolls up.
import type { StoredEvent, ThreadId } from "@switch/brain"
import type { Reaction } from "@switch/brain/commands"
import { SpaceId } from "@switch/brain/commands"
import type { InfiniteData, QueryClient } from "@tanstack/react-query"
import { castDraft, produce } from "immer"

import { rec, spaceId, str, threadId } from "./json.ts"
import { itemOf, learnedLine, list, postedLine, reactionOf, toItem, toLine } from "./store.ts"
import type { Item, Line } from "./store.ts"

export interface ChatPage {
  /** Oldest first. */
  readonly lines: readonly Line[]
  readonly more: boolean
}

export interface ThreadPage {
  /** Oldest first. */
  readonly items: readonly Item[]
  readonly more: boolean
  /** Drafts the reply gate sent back in these turns. */
  readonly rejected: readonly string[]
}

export type Chat = InfiniteData<ChatPage, number>
export type Transcript = InfiniteData<ThreadPage, number>

/** Before every seq: the latest page. */
export const LATEST = Number.MAX_SAFE_INTEGER

export const chatKey = (space: SpaceId) => ["chat", space] as const
export const threadKey = (thread: ThreadId) => ["thread", thread] as const

export const toChatPage = (raw: unknown): ChatPage => {
  const p = rec(raw)
  return { lines: list(p.lines).map(toLine), more: p.more === true }
}

export const toThreadPage = (raw: unknown): ThreadPage => {
  const p = rec(raw)
  return {
    items: list(p.items).map(toItem),
    more: p.more === true,
    rejected: Array.isArray(p.rejected) ? p.rejected.map((r) => str(r).trim()) : [],
  }
}

const one = <T>(first: T): InfiniteData<T, number> => ({ pages: [first], pageParams: [LATEST] })

/** Puts a line in a page, in seq order, once. */
const withLine = (page: ChatPage, line: Line): ChatPage => {
  const at = page.lines.findLastIndex((l) => l.seq <= line.seq) + 1
  if (page.lines[at - 1]?.seq === line.seq) {
    return page
  }
  return { ...page, lines: page.lines.toSpliced(at, 0, line) }
}

const insertLine = (client: QueryClient, space: SpaceId, line: Line) => {
  client.setQueryData<Chat>(chatKey(space), (chat) =>
    chat
      ? {
          ...chat,
          pages: chat.pages.with(0, withLine(chat.pages[0] ?? { lines: [], more: false }, line)),
        }
      : chat,
  )
}

/** A condition's line, revised in place as it continues. */
const reviseLine = (
  client: QueryClient,
  space: SpaceId,
  seq: number,
  text: string,
  until: number,
) => {
  client.setQueryData<Chat>(chatKey(space), (chat) =>
    chat
      ? produce(chat, (draft) => {
          for (const page of draft.pages) {
            page.lines = page.lines.map((l) =>
              l.seq === seq ? { ...l, text, quiet: { kind: "event", until } } : l,
            )
          }
        })
      : chat,
  )
}

/** The snapshot's chats, each a first page; mentioned lines show in the chats they mention too. */
export const fromSnapshot = (client: QueryClient, given: Readonly<Record<string, unknown>>) => {
  const chats = new Map(list(given.chats).map((c) => [spaceId(c.space), toChatPage(c)]))
  // A chat held but not in the snapshot has no lines now.
  for (const [[, space]] of client.getQueriesData<Chat>({ queryKey: ["chat"] })) {
    if (typeof space === "string" && !chats.has(SpaceId.make(space))) {
      chats.set(SpaceId.make(space), { lines: [], more: false })
    }
  }
  for (const [space, first] of chats) {
    client.setQueryData<Chat>(chatKey(space), one(first))
  }
  for (const [space, first] of chats) {
    for (const line of first.lines) {
      if (line.home === space) {
        for (const m of line.mentions) {
          insertLine(client, m, line)
        }
      }
    }
  }
  // Transcripts were paged against the log before the snapshot: page them again.
  void client.invalidateQueries({ queryKey: ["thread"] })
}

/** A side's tapback on line `seq`, in every chat that holds it; none takes it off. */
export const setReaction = (
  client: QueryClient,
  seq: number,
  side: "user" | "agent",
  reaction: Reaction | undefined,
) => {
  for (const [key, chat] of client.getQueriesData<Chat>({ queryKey: ["chat"] })) {
    if (chat?.pages.some((page) => page.lines.some((l) => l.seq === seq)) === true) {
      client.setQueryData<Chat>(
        key,
        produce(chat, (draft) => {
          for (const page of draft.pages) {
            for (const l of page.lines) {
              if (l.seq !== seq) {
                continue
              }
              const held = { user: l.reactions?.user, agent: l.reactions?.agent, [side]: reaction }
              if (held.user !== undefined || held.agent !== undefined) {
                l.reactions = {
                  ...(held.user !== undefined && { user: held.user }),
                  ...(held.agent !== undefined && { agent: held.agent }),
                }
              } else {
                delete l.reactions
              }
            }
          }
        }),
      )
    }
  }
}

/** A side's reaction to words of line `seq`, in every chat that holds it; none takes it off. */
export const setPart = (
  client: QueryClient,
  seq: number,
  side: "user" | "agent",
  text: string,
  reaction: Reaction | undefined,
) => {
  for (const [key, chat] of client.getQueriesData<Chat>({ queryKey: ["chat"] })) {
    if (chat?.pages.some((page) => page.lines.some((l) => l.seq === seq)) === true) {
      client.setQueryData<Chat>(
        key,
        produce(chat, (draft) => {
          for (const page of draft.pages) {
            for (const l of page.lines) {
              if (l.seq !== seq) {
                continue
              }
              const rest = (l.parts ?? []).filter((x) => x.side !== side || x.text !== text)
              const parts = reaction === undefined ? rest : [...rest, { side, reaction, text }]
              if (parts.length > 0) {
                l.parts = parts
              } else {
                delete l.parts
              }
            }
          }
        }),
      )
    }
  }
}

/** The user's reaction to these words of line `seq`, if they've made one. */
export const partOf = (client: QueryClient, seq: number, text: string) =>
  findLine(client, seq)?.parts?.find((x) => x.side === "user" && x.text === text)?.reaction

/** A line held in a chat, by seq, for a tag that names it later. */
const findLine = (client: QueryClient, seq: number) =>
  client
    .getQueriesData<Chat>({ queryKey: ["chat"] })
    .flatMap(([, chat]) => chat?.pages.flatMap((p) => p.lines) ?? [])
    .find((l) => l.seq === seq)

const tagged = (client: QueryClient, p: Record<string, unknown>) => {
  const line = findLine(client, Number(p.seq))
  if (!line) {
    return
  }
  const mentions = Array.isArray(p.mentions) ? p.mentions.map(spaceId) : []
  // A retag moves the line to its new home.
  const named = { ...line, home: spaceId(p.home), mentions }
  for (const [key, chat] of client.getQueriesData<Chat>({ queryKey: ["chat"] })) {
    const [, space] = key
    const keep = space === named.home || mentions.some((id) => id === space)
    if (chat) {
      client.setQueryData<Chat>(
        key,
        produce(chat, (draft) => {
          for (const page of draft.pages) {
            page.lines = page.lines.flatMap((held) => {
              if (held.seq !== line.seq) {
                return [held]
              }
              return keep ? [castDraft(named)] : []
            })
          }
        }),
      )
    }
  }
  for (const m of named.home === line.home ? mentions : [named.home, ...mentions]) {
    insertLine(client, m, named)
  }
}

/** A memory forgotten: its "Remembered" lines go. */
const forgotten = (client: QueryClient, id: string) => {
  for (const [key, chat] of client.getQueriesData<Chat>({ queryKey: ["chat"] })) {
    if (
      chat?.pages.some((p) =>
        p.lines.some((l) => l.quiet?.kind === "learned" && l.quiet.id === id),
      ) === true
    ) {
      client.setQueryData<Chat>(key, {
        ...chat,
        pages: chat.pages.map((p) => ({
          ...p,
          lines: p.lines.filter((l) => !(l.quiet?.kind === "learned" && l.quiet.id === id)),
        })),
      })
    }
  }
}

/** The user's last message, changed: its new words, and the replies to the old ones gone. */
const edited = (client: QueryClient, e: StoredEvent, p: Record<string, unknown>) => {
  const seq = Number(p.seq)
  const line = findLine(client, seq)
  if (!line) {
    return
  }
  for (const space of [line.home, ...line.mentions]) {
    client.setQueryData<Chat>(chatKey(space), (chat) =>
      chat
        ? produce(chat, (draft) => {
            for (const page of draft.pages) {
              page.lines = page.lines
                .filter(
                  (l) =>
                    !(
                      l.who === "agent" &&
                      !l.quiet &&
                      l.home === line.home &&
                      l.seq > seq &&
                      l.seq < e.seq
                    ),
                )
                .map((l) => (l.seq === seq ? { ...l, text: str(p.text) } : l))
            }
          })
        : chat,
    )
  }
}

/** A reply of the agent's, revised in place: its new words, marked edited; nothing else changes. */
const revised = (client: QueryClient, p: Record<string, unknown>) => {
  const seq = Number(p.seq)
  const line = findLine(client, seq)
  if (!line) {
    return
  }
  for (const space of [line.home, ...line.mentions]) {
    client.setQueryData<Chat>(chatKey(space), (chat) =>
      chat
        ? produce(chat, (draft) => {
            for (const page of draft.pages) {
              page.lines = page.lines.map((l) =>
                l.seq === seq ? { ...l, text: str(p.text), edited: true } : l,
              )
            }
          })
        : chat,
    )
  }
}

/** An entry lands in an opened thread's transcript. */
const addItem = (client: QueryClient, thread: ThreadId, item: Item) => {
  client.setQueryData<Transcript>(threadKey(thread), (t) => {
    const first = t?.pages[0]
    if (!t || !first || first.items.some((i) => i.seq === item.seq)) {
      return t
    }
    return { ...t, pages: t.pages.with(0, { ...first, items: [...first.items, item] }) }
  })
}

/** A reaction lands: one on words of the message is theirs alone; without, it's on the whole message. */
const reacted = (client: QueryClient, e: StoredEvent, p: ReturnType<typeof rec>) => {
  const words = str(rec(p.quote).text)
  const side = e.source === "agent" ? "agent" : "user"
  if (words === "") {
    setReaction(client, Number(p.seq), side, reactionOf(p.reaction))
  } else {
    setPart(client, Number(p.seq), side, words, reactionOf(p.reaction))
  }
}

/** A live event's part in the paged history. */
export const fold = (client: QueryClient, e: StoredEvent) => {
  const p = rec(e.payload)
  if (e.type === "message.posted") {
    const line = postedLine(e)
    insertLine(client, line.home, line)
  } else if (e.type === "memory.written" || e.type === "setting.set") {
    void client.invalidateQueries({ queryKey: ["memories"] })
    const line = learnedLine(e)
    if (line) {
      insertLine(client, line.home, line)
    }
  } else if (e.type === "memory.forgotten") {
    void client.invalidateQueries({ queryKey: ["memories"] })
    forgotten(client, str(p.id))
  } else if (e.type === "space.tagged") {
    tagged(client, p)
  } else if (e.type === "message.moved") {
    // Both chats as the brain now has them: the lines gone from one, in the other.
    void client.invalidateQueries({ queryKey: chatKey(spaceId(p.from)) })
    void client.invalidateQueries({ queryKey: chatKey(spaceId(p.to)) })
  } else if (e.type === "triage.sorted") {
    for (const i of list(p.items)) {
      if (i.line === true && typeof i.same === "number") {
        reviseLine(client, spaceId(i.space), i.same, str(i.note), Number(i.time))
      } else if (i.line === true) {
        const space = spaceId(i.space)
        insertLine(client, space, {
          seq: Number(i.seq),
          time: Number(i.time),
          who: "agent",
          text: str(i.note),
          home: space,
          mentions: [],
          turn: null,
          quiet: { kind: "event", until: Number(i.time) },
        })
      }
    }
  } else if (e.type === "space.unarchived") {
    // Its chat left the snapshot while archived.
    void client.invalidateQueries({ queryKey: chatKey(spaceId(p.id)) })
  } else if (e.type === "message.edited") {
    edited(client, e, p)
  } else if (e.type === "message.revised") {
    revised(client, p)
  } else if (e.type === "message.reacted") {
    reacted(client, e, p)
  } else if (e.type === "space.created") {
    client.setQueryData<Chat>(
      chatKey(spaceId(p.id)),
      (chat) => chat ?? one({ lines: [], more: false }),
    )
  } else {
    const item = itemOf(e, p)
    if (item) {
      addItem(client, threadId(p.thread), item)
    }
  }
}
