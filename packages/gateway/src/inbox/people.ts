// What was said with someone on every channel: the brain's messages from any of their handles, and
// the rest of those conversations. A message is any event carrying `sender` and `message`; this
// knows no extension.
import type { Database } from "bun:sqlite"

import { messageOf } from "switch-ext-kit"
import type { Received } from "switch-ext-kit"
import { keyString, livePerson } from "./contacts.ts"
import type { Person } from "./contacts.ts"

/** How many messages back it reads. */
const SCAN = 20_000

/** Who sent a message and where, without its words. */
export interface Sent {
  readonly seq: number
  readonly conversation: string
  readonly handle: string | null
  readonly via: string | null
  readonly person: string | null
  readonly me: number | null
}

// The types whose latest event is a message, each type found by a seek on the type index.
const MESSAGE_TYPES = `WITH RECURSIVE t(type) AS (
    SELECT min(type) FROM events
    UNION ALL SELECT (SELECT min(type) FROM events WHERE type > t.type) FROM t WHERE t.type IS NOT NULL)
  SELECT type FROM t WHERE type IS NOT NULL AND (SELECT json_extract(payload, '$.message.conversation') IS NOT NULL
    FROM events e WHERE e.type = t.type ORDER BY seq DESC LIMIT 1)`

/** Every message's sender and conversation, newest first. */
export const messagesIn = (db: Database): readonly Sent[] =>
  db
    .query<Sent, []>(
      `SELECT seq, json_extract(payload, '$.message.conversation') AS conversation,
         json_extract(payload, '$.sender.handle') AS handle, json_extract(payload, '$.sender.via') AS via,
         json_extract(payload, '$.sender.person') AS person, json_extract(payload, '$.sender.me') AS me
       FROM events WHERE type IN (${MESSAGE_TYPES}) AND conversation IS NOT NULL
       ORDER BY seq DESC LIMIT ${SCAN}`,
    )
    .all()

/** The user's own handles: what they send from. */
export const mine = (rows: readonly Sent[]) =>
  new Set(
    rows.flatMap((r) => {
      const k =
        r.me === 1 && r.handle !== null ? keyString({ handle: r.handle, via: r.via ?? "" }) : null
      return k === null ? [] : [k]
    }),
  )

/** A conversation named for one handle (a chat with one person) ends in it. */
const keyed = (conversation: string) => {
  const last = conversation.split(/[:;]/u).at(-1) ?? ""
  if (/^\+?\d{10,15}$/u.test(last)) {
    return keyString({ handle: last, via: "phone" })
  }
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(last) ? `email:${last.toLowerCase()}` : null
}

interface Payload {
  readonly time: number
  readonly type: string
  readonly payload: string
}

const parse: (json: string) => unknown = JSON.parse

/** The latest messages with `p` on every channel, theirs and the rest of those conversations, newest first. */
export const saidWith = (
  brain: Database,
  rows: readonly Sent[],
  p: Person,
  limit: number,
): readonly Received[] => {
  const keys = new Set(p.keys)
  const linked = new Map<string, boolean>()
  const isThem = (person: string) => {
    let is = linked.get(person)
    if (is === undefined) {
      is = p.id !== "" && livePerson(brain, person) === p.id
      linked.set(person, is)
    }
    return is
  }
  const theirs = (r: Sent) => {
    if (r.me === 1) {
      return false
    }
    if (r.person !== null && isThem(r.person)) {
      return true
    }
    const k = r.handle === null ? null : keyString({ handle: r.handle, via: r.via ?? "" })
    return k !== null && keys.has(k)
  }
  const conversations = new Set(
    rows
      .filter((r) => theirs(r) || keys.has(keyed(r.conversation) ?? ""))
      .map((r) => r.conversation),
  )
  // A message is recorded again as it's read or relabeled: enough rows for `limit` once each.
  const seqs = rows
    .filter((r) => conversations.has(r.conversation))
    .slice(0, limit * 4)
    .map((r) => r.seq)
  if (seqs.length === 0) {
    return []
  }
  const seen = new Set<string>()
  const out: Received[] = []
  for (const r of brain
    .query<Payload, number[]>(
      `SELECT time, type, payload FROM events WHERE seq IN (${seqs.map(() => "?").join(", ")}) ORDER BY seq DESC`,
    )
    .all(...seqs)) {
    const m = messageOf(r.type, parse(r.payload), r.time)
    if (m !== null && !seen.has(m.id)) {
      seen.add(m.id)
      out.push(m)
    }
  }
  return out.toSorted((a, b) => b.at - a.at).slice(0, limit)
}
