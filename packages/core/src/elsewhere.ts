// Elsewhere: what's going on outside this space, written by code with no model. Home's last
// exchanges, each exchange in another space in the last two hours, and where each other space
// touched since the last look stands. Each exchange starts with a link a reply cites it by,
// `[⇄ Home · 9m](switch://space/home?seq=…)`, which the clients draw as a chip that opens it.
import type { Database } from "bun:sqlite"
import { HOME, whoOf } from "@switch/brain"
import type { SpaceId } from "@switch/brain"

const HOUR = 3_600_000
const HOME_EXCHANGES = 4
const HOME_WITHIN = 24 * HOUR
const OTHERS_WITHIN = 2 * HOUR
const OTHERS = 8
const TOUCHED = 5
/** The whole of it, about 2,500 characters at most. */
const CAP = 2500

const clip = (text: string, n: number) => {
  const flat = text.replaceAll(/\s+/gu, " ").trim()
  return flat.length > n ? `${flat.slice(0, n)}…` : flat
}

const firstSentence = (text: string) => {
  const flat = text.replaceAll(/\s+/gu, " ").trim()
  const end = /[.!?](?:\s|$)/u.exec(flat)
  return end ? flat.slice(0, end.index + 1) : flat
}

const age = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000))
  if (m < 60) {
    return `${m}m`
  }
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

interface Said {
  readonly seq: number
  readonly time: number
  readonly space: SpaceId
  readonly source: string
  readonly text: string
}

interface Exchange {
  readonly space: SpaceId
  readonly seq: number
  readonly time: number
  readonly asked: string
  readonly answered: string
}

// Lines said after a time (?1), their seqs bounded through the log's time index: a line's time is
// its event's. Lines have no time index, so `time > ?` alone read every line ever said, half a
// second of the core's thread from a cold cache before each turn in a space (Nov 23).
const AFTER = `time > ?1 AND seq >= (SELECT coalesce(min(seq), ${Number.MAX_SAFE_INTEGER}) FROM events
  INDEXED BY events_time WHERE time > ?1)`

/** The user's messages after a time, each with the agent's reply after it. */
const exchanges = (db: Database, where: string, args: (string | number)[]): Exchange[] => {
  const rows = db
    .query<Said, (string | number)[]>(
      `SELECT seq, time, space, source, text FROM messages WHERE ${AFTER} AND ${where} ORDER BY seq`,
    )
    .all(...args)
  const out: Exchange[] = []
  for (const [i, m] of rows.entries()) {
    if (whoOf(m.source) !== "user") {
      continue
    }
    const reply = rows.slice(i + 1).find((r) => r.space === m.space)
    out.push({
      space: m.space,
      seq: m.seq,
      time: m.time,
      asked: m.text,
      answered: reply?.source === "agent" ? reply.text : "",
    })
  }
  return out
}

const link = (e: Exchange, name: string, now: number) =>
  `[⇄ ${name} · ${age(now - e.time)}](switch://space/${encodeURIComponent(e.space)}?seq=${e.seq})`

export interface ElsewhereInput {
  readonly space: SpaceId
  /** Seq this thread last looked at. */
  readonly after: number
  readonly names: ReadonlyMap<string, string>
  /** What each other space's latest event says. */
  readonly lineOf: (seq: number) => string
  readonly now: number
}

/** Elsewhere's lines, or none. */
export const elsewhere = (db: Database, input: ElsewhereInput): string[] => {
  const { space, names, now } = input
  const nameOf = (id: string) => names.get(id) ?? id
  const out: string[] = []
  if (space !== HOME) {
    const home = exchanges(db, "space = ?2", [now - HOME_WITHIN, HOME]).slice(-HOME_EXCHANGES)
    for (const e of home) {
      const reply = e.answered === "" ? "" : ` → ${clip(e.answered, 220)}`
      out.push(`- ${link(e, "Home", now)} User: ${clip(e.asked, 220)}${reply}`)
    }
  }
  const others = exchanges(db, "space != ?2 AND space != ?3", [
    now - OTHERS_WITHIN,
    space,
    HOME,
  ]).slice(-OTHERS)
  for (const e of others) {
    const reply = e.answered === "" ? "" : ` → ${clip(firstSentence(e.answered), 140)}`
    out.push(`- ${link(e, nameOf(e.space), now)} User: ${clip(e.asked, 140)}${reply}`)
  }
  const talked = new Set<string>([space, ...others.map((e) => e.space)])
  if (space !== HOME) {
    talked.add(HOME)
  }
  // Where each other space touched since the last look stands: what runs, what waits, its latest.
  const touched = db
    .query<{ home: SpaceId; last: number; n: number; time: number }, [number]>(
      `SELECT t.home, max(t.seq) AS last, count(*) AS n, max(e.time) AS time FROM tags t
         JOIN events e ON e.seq = t.seq
       WHERE t.seq > ? AND e.type NOT LIKE 'thread.%' GROUP BY t.home ORDER BY last DESC LIMIT 20`,
    )
    .all(input.after)
    .filter((r) => !talked.has(r.home))
    .slice(0, TOUCHED)
  const running = db.query<{ n: number }, [string]>(
    "SELECT count(*) AS n FROM threads WHERE thread = ? AND status = 'running'",
  )
  const open = db.query<{ n: number }, [string]>(
    "SELECT count(*) AS n FROM action_items WHERE space = ? AND status = 'open'",
  )
  for (const r of touched) {
    const marks = [
      (running.get(`space:${r.home}`)?.n ?? 0) > 0 ? "running" : "",
      (open.get(r.home)?.n ?? 0) > 0 ? `${open.get(r.home)?.n} open items` : "",
    ].filter((m) => m !== "")
    out.push(
      `- ${nameOf(r.home)} (${r.n} new, ${age(now - r.time)} ago${marks.length > 0 ? `, ${marks.join(", ")}` : ""}): ${clip(input.lineOf(r.last), 160)}`,
    )
  }
  // When it runs long, the last lines go: Home's and the exchanges come first.
  const kept: string[] = []
  let size = 0
  for (const l of out) {
    if (size + l.length > CAP) {
      break
    }
    kept.push(l)
    size += l.length + 1
  }
  return kept
}
