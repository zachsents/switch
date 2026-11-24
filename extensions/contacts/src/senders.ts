// Everyone who messages the user, from the brain: texts and iMessage, Gmail, Instagram and Slack.
// Each message is a brain event the extension follows, its record in `payload.data` (`stream`,
// `data.facts`).
import type { Followed } from "switch-ext-kit"

import { rec, recs, str } from "./json.ts"
import type { SourceRecord } from "./merge.ts"
import { phoneKey } from "./text.ts"
import type { Stated } from "./store.ts"

/** The brain's event types that carry someone's messages. */
export const FOLLOWS = [
  "texts.message",
  "google.gmail.message",
  "instagram-dms.thread",
  "slack.message",
] as const

/** One message's record. */
export interface Seen {
  readonly id: string
  readonly at: number
  readonly stream: string
  readonly kind: string
  readonly space: string | null
  readonly body: Record<string, unknown>
  /** Who sent it, as the brain's message records say (`handle`, `via`, `name`, `me`, `agent`). */
  readonly sender: Record<string, unknown>
}

/** A followed event's record. */
export const seenOf = (e: Followed): Seen => {
  const p = rec(e.payload)
  return {
    id: e.id,
    at: e.time,
    stream: str(p.stream),
    kind: str(p.kind),
    space: typeof p.space === "string" ? p.space : null,
    body: rec(p.data),
    sender: rec(p.sender),
  }
}

const MARKETING =
  /reply stop|text stop|txt stop|stop to (?:end|opt|cancel|unsubscribe)|opt[- ]?out|unsubscribe|verification code|your code is/iu

/** A sender, gathered across their messages. */
export interface Sender {
  readonly channel: string
  /** A phone in E.164, an email, or a username. */
  readonly handle: string
  readonly kind: "phone" | "email" | "instagram"
  names: Set<string>
  spaces: Set<string>
  last: number
  fromThem: number
  fromUser: number
  marketing: number
  /** The user wrote to them, or it's a two-way thread: someone real. */
  create: boolean
}

const isPhoneName = (v: string) => /^[+\d\s().-]+$/u.test(v)

type Get = (channel: string, kind: Sender["kind"], handle: string) => Sender

/** The other side of a one to one chat ("any;-;+15551234567"); "" for a group. */
const ONE = /;-;(?<handle>[^;]+)$/u

const fromIMessage = (r: Seen, get: Get) => {
  const f = rec(r.body.facts)
  // One to one only: group chats say nothing about who a handle is.
  const handle = ONE.exec(str(f.chat))?.groups?.handle ?? ""
  const isPhone = handle.startsWith("+") && phoneKey(handle) !== ""
  if (!isPhone && !handle.includes("@")) {
    return
  }
  const s = get("imessage", isPhone ? "phone" : "email", handle)
  s.last = Math.max(s.last, r.at)
  if (f.from_me === true) {
    s.fromUser += 1
    s.create = true
  } else {
    s.fromThem += 1
    if (MARKETING.test(str(f.text))) {
      s.marketing += 1
    }
    const name = str(f.name)
    if (name !== "" && name !== handle && !isPhoneName(name)) {
      s.names.add(name)
    }
  }
  if (s.fromThem > 0 && s.marketing < s.fromThem) {
    s.create = true
  }
}

/** A business's text and email conversations: customers, one record each. */
const fromConversation = (r: Seen, get: Get, channel: "texts" | "email") => {
  const f = rec(r.body.facts)
  const handle = channel === "texts" ? str(f.phone) : str(f.email)
  const s = get(channel, channel === "texts" ? "phone" : "email", handle)
  s.last = Math.max(s.last, Number(f.last_at ?? r.at))
  const name = str(f.customer)
  const named = channel === "texts" ? !isPhoneName(name) : !name.includes("@")
  if (name !== "" && named) {
    s.names.add(name)
  }
  if (r.space !== null) {
    s.spaces.add(r.space)
  }
  s.fromThem += 1
  s.create = true
}

const ADDRESS = /<?(?<address>[^<>\s]+@[^<>\s]+)>?\s*$/u

const fromGmail = (r: Seen, get: Get) => {
  const f = rec(r.body.facts)
  const at = Number(f.date ?? r.at)
  if (f.sent === true) {
    for (const to of str(f.to).split(",")) {
      const address = ADDRESS.exec(to.trim())?.groups?.address
      if (address !== undefined) {
        const s = get("gmail", "email", address)
        s.last = Math.max(s.last, at)
        s.fromUser += 1
        s.create = true
        const name = to
          .replace(/<[^>]*>/u, "")
          .replaceAll('"', "")
          .trim()
        if (name !== "" && !name.includes("@")) {
          s.names.add(name)
        }
      }
    }
  } else if (str(f.from_email) !== "") {
    const s = get("gmail", "email", str(f.from_email))
    s.last = Math.max(s.last, at)
    s.fromThem += 1
    if (str(f.from) !== "" && !str(f.from).includes("@")) {
      s.names.add(str(f.from))
    }
  }
}

const fromInstagram = (r: Seen, get: Get) => {
  const f = rec(r.body.facts)
  for (const p of recs(f.people)) {
    const user = str(p.username)
    if (user === "") {
      continue
    }
    const s = get("instagram", "instagram", user)
    s.last = Math.max(s.last, Number(f.last_at ?? r.at))
    if (str(p.name) !== "") {
      s.names.add(str(p.name))
    }
    const msgs = recs(f.messages)
    s.fromThem += msgs.filter((m) => m.by !== "me").length
    s.fromUser += msgs.filter((m) => m.by === "me").length
    if (s.fromUser > 0) {
      s.create = true
    }
  }
}

/** A Slack message's sender, when Slack knows their email: a one to one chat says someone real. */
const fromSlack = (r: Seen, get: Get) => {
  const f = rec(r.body.facts)
  const handle = str(r.sender.handle)
  if (
    r.sender.me === true ||
    r.sender.agent === true ||
    str(r.sender.via) !== "email" ||
    !handle.includes("@")
  ) {
    return
  }
  const s = get("slack", "email", handle)
  s.last = Math.max(s.last, r.at)
  s.fromThem += 1
  const name = str(r.sender.name)
  if (name !== "" && !name.includes("@")) {
    s.names.add(name)
  }
  if (f.conversation_kind === "dm") {
    s.create = true
  }
}

export const gather = (seen: readonly Seen[]) => {
  const by = new Map<string, Sender>()
  const get: Get = (channel, kind, handle) => {
    const key = `${kind}:${kind === "phone" ? phoneKey(handle) : handle.toLowerCase()}`
    let s = by.get(key)
    if (s === undefined) {
      s = {
        channel,
        handle,
        kind,
        names: new Set(),
        spaces: new Set(),
        last: 0,
        fromThem: 0,
        fromUser: 0,
        marketing: 0,
        create: false,
      }
      by.set(key, s)
    }
    return s
  }
  for (const r of seen) {
    const f = rec(r.body.facts)
    if (r.stream === "comms/imessage") {
      fromIMessage(r, get)
    } else if (r.stream === "comms/texts" && str(f.phone) !== "") {
      fromConversation(r, get, "texts")
    } else if (r.stream === "comms/email" && str(f.email) !== "") {
      fromConversation(r, get, "email")
    } else if (r.stream === "comms/gmail" && str(f.message_id) !== "") {
      fromGmail(r, get)
    } else if (r.stream === "comms/instagram" && f.group !== true) {
      fromInstagram(r, get)
    } else if (r.stream === "comms/slack") {
      fromSlack(r, get)
    }
  }
  return [...by.values()]
}

/** A role or relay address: a shop's inbox, a no-reply, a marketplace's masked reply-to. */
const ROLE =
  /^(?:no-?reply|do-?not-?reply|info|support|hello|help|team|contact|sales|billing|admin|notifications?|news|orders?|mailer-daemon)(?:[+._@-])|-reply\+|^[0-9a-f]{24,}@|^\d+-[a-z0-9.]+@/u
const RELAY =
  /@(?:[a-z0-9-]+\.)*(?:craigslist\.org|booking\.com|airbnb\.com|facebookmail\.com|marketplace\.amazon\.com)$/u

/** Mail no one person writes. */
const automated = (s: Sender) =>
  s.kind === "email" && (ROLE.test(s.handle.toLowerCase()) || RELAY.test(s.handle.toLowerCase()))

export const toRecord = (s: Sender): SourceRecord => {
  const fields: Stated[] = []
  for (const n of s.names) {
    fields.push({ kind: "name", value: n, confidence: 0.8 })
  }
  if (s.kind === "phone") {
    fields.push({ kind: "phone", value: s.handle })
    if (s.channel === "imessage") {
      fields.push({ kind: "handle", value: s.handle, service: "imessage" })
    }
  } else if (s.kind === "email") {
    fields.push({ kind: "email", value: s.handle })
  } else {
    fields.push({
      kind: "handle",
      value: s.handle,
      service: "instagram",
      url: `https://www.instagram.com/${s.handle}/`,
    })
  }
  for (const space of s.spaces) {
    fields.push({ kind: "space", value: space })
  }
  return {
    source: s.channel,
    fields,
    user: false,
    create: s.create,
    ...(s.last > 0 ? { lastContact: s.last } : {}),
    messaged: s.fromThem > s.marketing && !automated(s),
  }
}
