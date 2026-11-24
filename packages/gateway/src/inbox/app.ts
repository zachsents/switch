// The inbox: every extension's messages in one place, read from the brain, each with its sender
// linked to Contacts. Any event carrying `sender` and `message` is a message; it knows no
// extension. Its widgets: the inbox, for Home, and a conversation's messages, which a `thread` call
// shows in chat.
import type { Database } from "bun:sqlite"
import { Brain } from "@switch/brain"
import { Effect, Schema } from "effect"

import { BASIC_CATALOG, defineApp, messageOf, SWITCH_CATALOG, tool } from "switch-ext-kit"
import type { Received as Message } from "switch-ext-kit"
import { nameOf, peopleFor, stranger } from "./contacts.ts"
import type { Person } from "./contacts.ts"
import { messagesIn, saidWith } from "./people.ts"

/** How far back it reads: the latest this many events. */
const WINDOW = 20_000

interface Row {
  readonly time: number
  readonly type: string
  readonly payload: string
}

const parse: (json: string) => unknown = JSON.parse

/** Each message once, its latest state (an extension records one again as it's read or relabeled). */
const recent = (db: Database): Message[] => {
  const rows = db
    .query<Row, []>(
      `SELECT time, type, payload FROM (SELECT * FROM events ORDER BY seq DESC LIMIT ${WINDOW})
       WHERE json_extract(payload, '$.message.conversation') IS NOT NULL ORDER BY seq DESC`,
    )
    .all()
  const seen = new Set<string>()
  const out: Message[] = []
  for (const r of rows) {
    const m = messageOf(r.type, parse(r.payload), r.time)
    if (m !== null && !seen.has(m.id)) {
      seen.add(m.id)
      out.push(m)
    }
  }
  return out.toSorted((a, b) => b.at - a.at)
}

const whoOf = (db: Database, m: Message) => {
  if (m.sender.me === true) {
    return "Me"
  }
  const linked = m.sender.person === undefined ? null : nameOf(db, m.sender.person)
  return linked ?? m.sender.name ?? m.sender.handle
}

const clip = (text: string, n: number) => {
  const flat = text.replaceAll(/\s+/gu, " ").trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

interface Conversation {
  readonly conversation: string
  readonly channel: string
  readonly name: string
  readonly person: string | null
  readonly text: string
  readonly unread: number
  readonly at: number
}

const conversations = (db: Database, limit: number): Conversation[] => {
  const by = new Map<string, Message[]>()
  for (const m of recent(db)) {
    const list = by.get(m.conversation) ?? []
    list.push(m)
    by.set(m.conversation, list)
  }
  return (
    [...by.entries()]
      // What only the user said isn't anything to read.
      .filter(([, ms]) => ms.some((m) => m.sender.me !== true))
      .map(([conversation, ms]): Conversation => {
        const [latest] = ms
        const them = ms.find((m) => m.sender.me !== true) ?? latest
        const subject = ms.find((m) => m.subject !== undefined && m.subject !== "")?.subject
        return {
          conversation,
          channel: latest?.channel ?? "",
          name: them === undefined ? "" : whoOf(db, them),
          person: them?.sender.person ?? null,
          text: clip(subject ?? latest?.text ?? "", 80),
          unread: ms.filter((m) => m.unread === true).length,
          at: latest?.at ?? 0,
        }
      })
      .toSorted((a, b) => b.unread - a.unread || b.at - a.at)
      .slice(0, limit)
  )
}

const inbox = tool(
  "inbox",
  {
    description:
      "Conversations across every channel, unread first: who (linked to Contacts), the latest line, how many unread.",
    readOnly: true,
    input: Schema.Struct({ limit: Schema.optionalKey(Schema.Number) }),
  },
  (input) =>
    Effect.gen(function* reading() {
      const brain = yield* Brain
      const list = yield* brain.read((db) => conversations(db, input.limit ?? 8))
      return {
        unread: list.reduce((n, c) => n + c.unread, 0),
        conversations: list.map((c) => ({
          ...c,
          time: hhmm(c.at),
          line: `${c.name}: ${c.text}`,
          needsYou: c.unread > 0,
        })),
      }
    }),
)

/** A message as a conversation's line shows it. */
const shown = (db: Database, m: Message, channels: boolean) => {
  const who = whoOf(db, m)
  return {
    who,
    mine: m.sender.me === true,
    channel: m.channel ?? "",
    text: clip(
      m.subject === undefined || m.subject === "" ? m.text : `${m.subject}: ${m.text}`,
      400,
    ),
    at: m.at,
    time: hhmm(m.at),
    line: `${who}${channels ? ` (${m.channel ?? ""})` : ""}: ${clip(m.text, 200)}`,
  }
}

const none = { title: "", channel: "", conversation: "", messages: [] }

/** Everything with one person on every channel, oldest first. */
const withPerson = (db: Database, p: Person, limit: number) => {
  const ms = saidWith(db, messagesIn(db), p, limit).toReversed()
  const channels = [...new Set(ms.map((m) => m.channel ?? ""))]
  return {
    title: p.name,
    ...(p.id === "" ? {} : { person: p.id }),
    handles: p.handles,
    channel: channels.join(", "),
    conversation: ms.at(-1)?.conversation ?? "",
    conversations: [...new Set(ms.map((m) => m.conversation))],
    messages: ms.map((m) => shown(db, m, channels.length > 1)),
  }
}

const thread = tool(
  "thread",
  {
    description:
      "Messages, oldest first: one conversation by its id from inbox, or everything with a person on every channel. A person is found by who they are (name, phone, email, @handle or Contacts id): every phone, email and handle Contacts has for them, on texts, email and the rest. A name that fits several people returns them as candidates. Shows as a card in chat.",
    readOnly: true,
    input: Schema.Struct({
      conversation: Schema.optionalKey(Schema.String),
      with: Schema.optionalKey(Schema.String),
      limit: Schema.optionalKey(Schema.Number),
    }),
  },
  (input) =>
    Effect.gen(function* reading() {
      const brain = yield* Brain
      return yield* brain.read((db) => {
        const who = input.conversation === undefined ? input.with : undefined
        if (who !== undefined) {
          const people = peopleFor(db, who)
          const [one] = people
          if (people.length > 1) {
            return {
              ...none,
              candidates: people.map((p) => ({ person: p.id, name: p.name, handles: p.handles })),
            }
          }
          const p = one ?? stranger(who)
          if (p !== null) {
            return withPerson(db, p, input.limit ?? 20)
          }
        }
        // Someone Contacts doesn't know, by the name they write under.
        const all = recent(db)
        const want = who?.toLowerCase()
        const first =
          input.conversation === undefined
            ? all.find(
                (m) =>
                  want === undefined ||
                  m.sender.handle.toLowerCase().includes(want) ||
                  whoOf(db, m).toLowerCase().includes(want),
              )
            : all.find((m) => m.conversation === input.conversation)
        if (first === undefined) {
          return none
        }
        const ms = all
          .filter((m) => m.conversation === first.conversation)
          .slice(0, input.limit ?? 12)
          .toReversed()
        const them = ms.find((m) => m.sender.me !== true) ?? first
        return {
          title: whoOf(db, them),
          channel: first.channel,
          conversation: first.conversation,
          messages: ms.map((m) => shown(db, m, false)),
        }
      })
    }),
)

/** Today's as a clock time, earlier days as a date. */
const hhmm = (at: number) => {
  const d = new Date(at)
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

const surface = (id: string, components: readonly Record<string, unknown>[]) => [
  { version: "1.0", createSurface: { surfaceId: id, catalogId: SWITCH_CATALOG } },
  { version: "1.0", updateComponents: { surfaceId: id, components } },
]

export const inboxApp = defineApp<Brain>({
  name: "inbox",
  version: "1",
  instructions:
    "The user's messages on every channel, in one place; thread finds everything with a person by who they are. Each channel's extension has its own tools to search, read and send.",
  tools: [inbox, thread],
  widgets: [
    {
      name: "inbox",
      title: "Inbox",
      surfaces: ["space"],
      resource: "ui://inbox/inbox",
      tool: "inbox",
      // A line per conversation, the house's Slot in A2UI's List: when, a hand while it's unread, who
      // and what.
      a2ui: () =>
        surface("inbox", [
          {
            id: "root",
            component: "List",
            catalogId: BASIC_CATALOG,
            children: { componentId: "row", path: "/conversations" },
          },
          {
            id: "row",
            component: "Slot",
            time: { "@path": "time" },
            title: { "@path": "line" },
            needsYou: { "@path": "needsYou" },
          },
        ]),
    },
    {
      name: "messages",
      title: "Messages",
      surfaces: ["chat"],
      resource: "ui://inbox/messages",
      tool: "thread",
      // The conversation, a line per message: when, who and what.
      a2ui: () =>
        surface("messages", [
          {
            id: "root",
            component: "List",
            catalogId: BASIC_CATALOG,
            children: { componentId: "message", path: "/messages" },
          },
          {
            id: "message",
            component: "Slot",
            time: { "@path": "time" },
            title: { "@path": "line" },
          },
        ]),
    },
  ],
})
