// What clients show, as T3 Code syncs its web app (apps/server ws.ts, MIT, Copyright (c) 2026 T3
// Tools Inc.): a snapshot of the projections a page draws (the space tree, work, action items,
// widget placements, connections, each space's latest chat), then live events, then older history a page at a
// time as the user scrolls up. The log itself never goes to a client, nor the high-rate streams in it
// (devices, apps, UI analytics) unless a widget on screen watches their type.
import type { Database } from "bun:sqlite"
import {
  allAccounts,
  waiting,
  ThreadOpened,
  TurnInjected,
  TurnResult,
  TurnStarted,
  TurnText,
  TurnTool,
} from "@switch/agent"
import {
  conditionKey,
  GateDecided,
  ItemOpened,
  items as allItems,
  LINE_FRESH,
  shownEdits,
  TriageSorted,
} from "@switch/autonomy"
import type { OpenLine } from "@switch/autonomy"
import {
  allConnections,
  allCovers,
  installedExtensions,
  layouts,
  prefs,
  on,
  partReactionsTo,
  placements,
  reactionsTo,
  reads,
  removedFrom,
  repliesOf,
  ReplyRef,
  recordOf,
  SpaceId,
  SpaceTagged,
  ThreadId,
  whoOf,
  defineRead,
} from "@switch/brain"
import type { EventId, Projection, StoredEvent, View, TurnId } from "@switch/brain"
import { Option, Schema } from "effect"

import { accountLabels } from "./account-schema.ts"
import { homeOf, line, recordLine } from "./context.ts"
import { listed } from "./credentials.ts"
import { profilesState } from "./profiles.ts"
import { learnedLines, memoriesPage, runningActivities, systemPage } from "./system.ts"
import { findPage } from "./find.ts"

/** A space's chat lines in the snapshot, and in each page of it. */
const CHAT_PAGE = 50
/** A thread's transcript entries per page. */
const THREAD_PAGE = 200
/** A running thread's latest entries in the snapshot, for its live step. */
const RUNNING_ITEMS = 20

// Which space a thread works in: the tag on its opening, else its parent's. Kept as its own table
// because the opening's tag lands later, as a `space.tagged` naming its seq.
export const threadSpaces: Projection = {
  name: "thread_spaces",
  version: 1,
  tables: ["thread_spaces"],
  create: `
    CREATE TABLE thread_spaces (thread TEXT PRIMARY KEY, parent TEXT, opened INTEGER NOT NULL, home TEXT);
    CREATE INDEX thread_spaces_opened ON thread_spaces (opened);`,
  on: [
    on(ThreadOpened, (db, p, e) => {
      db.query(
        "INSERT OR IGNORE INTO thread_spaces (thread, parent, opened, home) VALUES (?, ?, ?, ?)",
      ).run(p.thread, p.parent, e.seq, homeOf(p.thread))
    }),
    on(SpaceTagged, (db, p) => {
      db.query("UPDATE thread_spaces SET home = ? WHERE opened = ?").run(p.home, p.seq)
    }),
  ],
  snapshot: () => null,
}

// Each turn's span in its thread's transcript, so what a turn held is read without the whole
// transcript.
const stretch = (db: Database, seq: number, p: { readonly turn: string }) => {
  db.query("UPDATE turn_spans SET last = ? WHERE turn = ?").run(seq, p.turn)
}

export const turnSpans: Projection = {
  name: "turn_spans",
  version: 1,
  tables: ["turn_spans"],
  create:
    "CREATE TABLE turn_spans (turn TEXT PRIMARY KEY, thread TEXT NOT NULL, first INTEGER NOT NULL, last INTEGER NOT NULL);",
  on: [
    on(TurnStarted, (db, p, e) => {
      db.query(
        "INSERT OR IGNORE INTO turn_spans (turn, thread, first, last) VALUES (?, ?, ?, ?)",
      ).run(p.turn, p.thread, e.seq, e.seq)
    }),
    on(TurnTool, (db, p, e) => {
      stretch(db, e.seq, p)
    }),
    on(TurnResult, (db, p, e) => {
      stretch(db, e.seq, p)
    }),
    on(TurnText, (db, p, e) => {
      stretch(db, e.seq, p)
    }),
    on(TurnInjected, (db, p, e) => {
      stretch(db, e.seq, p)
    }),
  ],
  snapshot: () => null,
}

// Each turn's own words, as its transcript has them (a `user` start, then `steer` and `wake`), without
// the transcript: whether a turn is woken or sensed is read from these, not from every entry it holds.
const word = (
  db: Database,
  seq: number,
  p: { readonly thread: string; readonly turn: string; readonly text: string },
  kind: string,
  sensed: boolean | undefined,
) => {
  db.query(
    "INSERT INTO turn_words (seq, thread, turn, kind, sensed, blank) VALUES (?1, ?2, ?3, ?4, ?5, trim(?6) = '')",
  ).run(seq, p.thread, p.turn, kind, sensed === true ? 1 : 0, p.text)
}

export const turnWords: Projection = {
  name: "turn_words",
  version: 1,
  tables: ["turn_words"],
  create: `
    CREATE TABLE turn_words (seq INTEGER PRIMARY KEY, thread TEXT NOT NULL, turn TEXT NOT NULL,
      kind TEXT NOT NULL, sensed INTEGER NOT NULL, blank INTEGER NOT NULL);
    CREATE INDEX turn_words_turn ON turn_words (turn);`,
  on: [
    on(TurnStarted, (db, p, e) => {
      word(db, e.seq, p, "user", p.sensed)
    }),
    on(TurnInjected, (db, p, e) => {
      word(db, e.seq, p, p.kind, p.sensed)
    }),
  ],
  snapshot: () => null,
}

// Reply drafts the gate sent back, by turn: a thread's transcript leaves them out.
export const bouncedDrafts: Projection = {
  name: "bounced_drafts",
  version: 1,
  tables: ["bounced_drafts"],
  create: `
    CREATE TABLE bounced_drafts (turn TEXT NOT NULL, text TEXT NOT NULL);
    CREATE INDEX bounced_drafts_turn ON bounced_drafts (turn);`,
  on: [
    on(GateDecided, (db, p) => {
      if (p.exit === "reply" && !p.pass && p.turn !== undefined) {
        db.query("INSERT INTO bounced_drafts (turn, text) VALUES (?, ?)").run(p.turn, p.text)
      }
    }),
  ],
  snapshot: () => null,
}

const parseJson: (json: string) => unknown = JSON.parse

interface EventRow {
  readonly seq: number
  readonly id: EventId
  readonly time: number
  readonly type: string
  readonly v: number
  readonly source: string
  readonly payload: string
}

const eventAt = (db: Database, seq: number) => {
  const row = db.query<EventRow, [number]>("SELECT * FROM events WHERE seq = ?").get(seq)
  return row ? { ...row, payload: parseJson(row.payload) } : null
}

// What an event with a line said: an extension's health has no line now, but its record says
// itself.
const saidBy = (e: StoredEvent) => line(e) ?? recordLine(e)

/** A condition's line in a space's chat: the latest line of its key, and what its latest event said. */
export const openLine = (db: Database, space: SpaceId, key: string): OpenLine | null => {
  const row = db
    .query<{ seq: number; note: string; updated: number; last: number }, [string, string]>(
      "SELECT seq, note, updated, last FROM chat_events WHERE space = ? AND key = ? ORDER BY seq DESC LIMIT 1",
    )
    .get(space, key)
  if (!row) {
    return null
  }
  const e = eventAt(db, row.last)
  return {
    seq: row.seq,
    note: row.note,
    updated: row.updated,
    said: e ? (saidBy(e)?.text ?? "") : "",
  }
}

/** How long a line stays one a later event can continue: an order takes days to arrive. */
const OPEN_MS = 7 * 24 * 3600 * 1000

/** A space's chat lines revised in the last week, the eight latest, newest first. */
export const openLines = (db: Database, space: SpaceId): OpenLine[] =>
  db
    .query<{ seq: number; note: string; updated: number; last: number }, [string, number]>(
      "SELECT seq, note, updated, last FROM chat_events WHERE space = ? AND updated > ? ORDER BY updated DESC LIMIT 8",
    )
    .all(space, Date.now() - OPEN_MS)
    .map((row) => {
      const e = eventAt(db, row.last)
      return {
        seq: row.seq,
        note: row.note,
        updated: row.updated,
        said: e ? (saidBy(e)?.text ?? "") : "",
      }
    })

type Sorted = (typeof TriageSorted.payload.Type)["items"][number]

// A line sorted before lines had keys: its key, and the line it continues.
const earlier = (db: Database, i: Sorted) => {
  const e = eventAt(db, i.seq)
  const l = e ? saidBy(e) : null
  if (!e || !l) {
    return { key: "", same: null }
  }
  const key = conditionKey(e, l)
  const open = openLine(db, i.space, key)
  // Before the model judged it, one condition continuing is the same key again within minutes,
  // unless it says the condition ended.
  const soon = open !== null && i.time - open.updated < CONTINUES_MS && !ENDED.test(i.note)
  const same = open !== null && i.time - open.updated < LINE_FRESH && (open.said === l.text || soon)
  return { key, same: same && open !== null ? open.seq : null }
}

/** How soon the same key again is the same condition, for lines sorted before keys. */
const CONTINUES_MS = 10 * 60_000
const ENDED = /\b(?:recovered|back up|resumed|fixed|restored)\b/iu

// An app's outcomes triage marked as lines in their space's chat (an order paid, a job failed): one
// per condition, revised as it continues.
/** A client's own reports (a crash, a hang) are diagnostics, never a chat line. */
const diagnostic = (db: Database, seq: number) =>
  db
    .query<{ type: string }, [number]>("SELECT type FROM events WHERE seq = ?")
    .get(seq)
    ?.type.startsWith("client.") === true

export const chatEvents: Projection = {
  name: "chat_events",
  version: 4,
  tables: ["chat_events"],
  create: `
    CREATE TABLE chat_events (seq INTEGER PRIMARY KEY, space TEXT NOT NULL, note TEXT NOT NULL,
      time INTEGER NOT NULL, key TEXT NOT NULL, last INTEGER NOT NULL, updated INTEGER NOT NULL);
    CREATE INDEX chat_events_space ON chat_events (space, seq);
    CREATE INDEX chat_events_key ON chat_events (space, key, seq);`,
  on: [
    on(TriageSorted, (db, p) => {
      for (const i of p.items) {
        if (i.line !== true || diagnostic(db, i.seq)) {
          continue
        }
        const { key, same } = i.key === undefined ? earlier(db, i) : { key: i.key, same: i.same }
        const revised =
          typeof same === "number" &&
          db
            .query(
              "UPDATE chat_events SET note = ?, last = ?, updated = ? WHERE seq = ? AND space = ?",
            )
            .run(i.note, i.seq, i.time, same, i.space).changes > 0
        if (!revised) {
          db.query(
            "INSERT OR REPLACE INTO chat_events (seq, space, note, time, key, last, updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).run(i.seq, i.space, i.note, i.time, key, i.seq, i.time)
        }
      }
    }),
    // An event moved to another space (a retag) takes its line along.
    on(SpaceTagged, (db, p, e) => {
      if (e.source === "retag") {
        db.query("UPDATE chat_events SET space = ? WHERE seq = ?").run(p.home, p.seq)
      }
    }),
  ],
  snapshot: () => null,
}

interface SpaceRow {
  readonly id: SpaceId
  readonly name: string
  readonly parent: SpaceId | null
  readonly about: string
  readonly ephemeral: number
  readonly archived: number
  readonly day: string | null
  readonly night: string | null
  readonly made: number
}

/** Each space, with its cover: the image's blob (at /blobs/<hash>), or null. */
const spaces = (db: Database) => {
  const covered = new Map(allCovers(db).map((c) => [c.space, c.image]))
  return db
    .query<SpaceRow, []>(
      "SELECT rowid AS made, id, name, parent, about, ephemeral, archived, day, night FROM spaces ORDER BY rowid",
    )
    .all()
    .map(({ day, night, ...s }) => ({
      ...s,
      ephemeral: s.ephemeral === 1,
      archived: s.archived === 1,
      ink: day === null || night === null ? null : { day, night },
      cover: covered.get(s.id) ?? null,
    }))
}

/** Each space's latest chat line, for warmth. */
const warm = (db: Database) =>
  db
    .query<{ space: SpaceId; seq: number }, []>(
      "SELECT space, max(seq) AS seq FROM messages GROUP BY space",
    )
    .all()

/**
 * Each space's latest reply, against which its read mark is unread: each space by a seek in the
 * space index, then its newest lines back to a reply. `WHERE source = 'agent' GROUP BY space` read
 * every line ever said, half a second of the core's thread from a cold cache on each snapshot.
 */
const replies = (db: Database) =>
  db
    .query<{ space: SpaceId; seq: number | null }, []>(
      `WITH RECURSIVE s(space) AS (
         SELECT min(space) FROM messages
         UNION ALL SELECT (SELECT min(space) FROM messages WHERE space > s.space) FROM s WHERE s.space IS NOT NULL)
       SELECT space, (SELECT m.seq FROM messages m WHERE m.space = s.space AND m.source = 'agent'
         ORDER BY m.seq DESC LIMIT 1) AS seq
       FROM s WHERE space IS NOT NULL`,
    )
    .all()
    .flatMap((r) => (r.seq === null ? [] : [{ space: r.space, seq: r.seq }]))

interface LineRow {
  readonly seq: number
  readonly time: number
  readonly space: SpaceId
  readonly source: string
  readonly text: string
  readonly turn: TurnId | null
  readonly widget: string | null
  readonly attachments: string | null
  readonly item: string | null
  readonly detail: string | null
  /** Revised in place since it posted (message.revised). */
  readonly revised: number | null
  /** The model that wrote it, as JSON. */
  readonly model: string | null
  /** A peer's name. */
  readonly sender: string | null
}

/**
 * What each of messages `seqs` replies to, read as a client shows it: its refs, an ask's title
 * beside its id, and an older message's "(On action item <id>.)" read as an ask when the id is an
 * item's (taken off its words then, left as it is otherwise).
 */
const repliedTo = (db: Database, seqs: readonly number[]) => {
  const refs = new Map<number, readonly ReplyRef[]>()
  if (seqs.length > 0) {
    for (const r of db
      .query<{ seq: number; refs: string }, number[]>(
        `SELECT seq, refs FROM message_replies WHERE seq IN (${seqs.map(() => "?").join(", ")})`,
      )
      .all(...seqs)) {
      const parsed = Schema.decodeUnknownOption(Schema.Array(ReplyRef))(parseJson(r.refs))
      if (parsed._tag === "Some") {
        refs.set(r.seq, parsed.value)
      }
    }
  }
  const title = db.query<{ title: string | null }, [string]>(
    "SELECT json_extract(data, '$.title') AS title FROM action_items WHERE id = ?",
  )
  return (r: { readonly seq: number; readonly source: string; readonly text: string }) => {
    if (r.source === "agent") {
      return { text: r.text, replyTo: [] }
    }
    const own = refs.get(r.seq) ?? null
    const read = repliesOf(r.text, own)
    const known = read.replyTo.every((x) => x.kind !== "ask" || title.get(x.id) !== null)
    const kept = known ? read : { text: r.text, replyTo: own ?? [] }
    return {
      text: kept.text,
      replyTo: kept.replyTo.map((x) => {
        const named = x.kind === "ask" ? (title.get(x.id)?.title ?? null) : null
        return named === null ? x : { ...x, title: named }
      }),
    }
  }
}

/** A space's chat lines before `before`, newest `limit`, oldest first: its own and those mentioning it. */
const chat = (db: Database, space: SpaceId, before: number, limit: number) => {
  const rows = db
    .query<LineRow, [string, number, number]>(
      `SELECT l.*, d.detail, r.seq AS revised, mm.model, ms.name AS sender FROM (
         SELECT seq, time, space, source, text, turn, widget, attachments, item FROM messages
           WHERE space = ?1 AND seq < ?2
         UNION ALL
         SELECT m.seq, m.time, m.space, m.source, m.text, m.turn, m.widget, m.attachments, m.item
           FROM mentions x JOIN messages m ON m.seq = x.seq
           WHERE x.space = ?1 AND x.seq < ?2 AND m.space != ?1
       ) l LEFT JOIN message_details d ON d.seq = l.seq
         LEFT JOIN message_revisions r ON r.seq = l.seq
         LEFT JOIN message_models mm ON mm.seq = l.seq
         LEFT JOIN message_senders ms ON ms.seq = l.seq
       WHERE NOT ${removedFrom("l.seq", "?1")}
       ORDER BY l.seq DESC LIMIT ?3`,
    )
    .all(space, before, limit + 1)
  const page = rows.slice(0, limit).toReversed()
  // The quiet lines between: an app's outcomes.
  const from = rows.length > limit ? (page[0]?.seq ?? 0) : 0
  const events = db
    .query<{ seq: number; time: number; note: string; updated: number }, [string, number, number]>(
      "SELECT seq, time, note, updated FROM chat_events WHERE space = ? AND seq > ? AND seq < ? ORDER BY seq",
    )
    .all(space, from, before)
  // The spaces each shows in besides: those it's mentioned in, and where it was taken out.
  const mentions = new Map<number, string[]>()
  const removed = new Map<number, string[]>()
  if (page.length > 0) {
    const seqs = page.map((r) => r.seq)
    const marks = seqs.map(() => "?").join(", ")
    const found = db
      .query<{ seq: number; space: SpaceId }, number[]>(
        `SELECT seq, space FROM mentions x WHERE seq IN (${marks}) AND NOT ${removedFrom("x.seq", "x.space")}`,
      )
      .all(...seqs)
    for (const m of found) {
      mentions.set(m.seq, [...(mentions.get(m.seq) ?? []), m.space])
    }
    for (const r of db
      .query<{ seq: number; space: SpaceId }, number[]>(
        `SELECT seq, space FROM removals WHERE seq IN (${marks})`,
      )
      .all(...seqs)) {
      removed.set(r.seq, [...(removed.get(r.seq) ?? []), r.space])
    }
  }
  const reacted = reactionsTo(
    db,
    page.map((r) => r.seq),
  )
  const parts = partReactionsTo(
    db,
    page.map((r) => r.seq),
  )
  const replied = repliedTo(
    db,
    page.map((r) => r.seq),
  )
  return {
    space,
    more: rows.length > limit,
    lines: [
      ...page.map((r) => {
        const said = replied(r)
        return {
          seq: r.seq,
          time: r.time,
          who: whoOf(r.source),
          ...(r.sender !== null && { from: r.sender }),
          text: said.text,
          ...(said.replyTo.length > 0 && { replyTo: said.replyTo }),
          ...(parts.has(r.seq) && { parts: parts.get(r.seq) }),
          home: r.space,
          mentions: mentions.get(r.seq) ?? [],
          ...(removed.has(r.seq) && { removed: removed.get(r.seq) }),
          turn: r.turn,
          ...(r.widget !== null && { widget: parseJson(r.widget) }),
          ...(r.attachments !== null && { attachments: parseJson(r.attachments) }),
          ...(r.item !== null && { item: r.item }),
          ...(r.detail !== null && { detail: r.detail }),
          ...(r.revised !== null && { edited: true }),
          ...(r.model !== null && { model: parseJson(r.model) }),
          ...(reacted.has(r.seq) && { reactions: reacted.get(r.seq) }),
        }
      }),
      ...events.map((e) => ({
        ...quiet(e.seq, e.time, space),
        text: e.note,
        kind: "event",
        until: e.updated,
      })),
      ...learnedLines(db, space, from, before).map((l) => ({
        ...quiet(l.seq, l.time, space),
        kind: "learned",
        text: l.text,
        memory: l.memory,
        restore: l.restore,
      })),
    ].toSorted((a, b) => a.seq - b.seq),
  }
}

/** A line of its own between what's said: no one's words. */
const quiet = (seq: number, time: number, space: SpaceId) => ({
  seq,
  time,
  who: "agent",
  text: "",
  home: space,
  mentions: [],
  turn: null,
})

interface ThreadRow {
  readonly thread: ThreadId
  readonly parent: ThreadId | null
  readonly title: string
  readonly status: string
  readonly turn: TurnId | null
  readonly result: string
  readonly ended_at: number
  readonly opened: number | null
  readonly home: SpaceId | null
  readonly stage: string | null
}

interface ItemRow {
  readonly seq: number
  readonly turn: TurnId
  readonly body: string
}

const rec = (v: unknown): Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? { ...v } : {}

const toItem = (r: ItemRow) => ({ ...rec(parseJson(r.body)), seq: r.seq, turn: r.turn })

/** A thread's transcript entries before `before`, newest `limit`, oldest first. */
const items = (db: Database, thread: ThreadId, before: number, limit: number) => {
  const rows = db
    .query<ItemRow, [string, number, number]>(
      "SELECT seq, turn, body FROM thread_items WHERE thread = ? AND seq < ? ORDER BY seq DESC LIMIT ?",
    )
    .all(thread, before, limit + 1)
  const turns = [...new Set(rows.map((r) => r.turn))]
  const rejected =
    turns.length === 0
      ? []
      : db
          .query<{ text: string }, string[]>(
            `SELECT text FROM bounced_drafts WHERE turn IN (${turns.map(() => "?").join(", ")})`,
          )
          .all(...turns)
          .map((r) => r.text)
  return {
    thread,
    more: rows.length > limit,
    items: rows.slice(0, limit).map(toItem).toReversed(),
    rejected,
  }
}

/** When the running turn started: its first entry's time. */
const startedAt = (db: Database, thread: ThreadId, turn: TurnId) =>
  db
    .query<{ time: number }, [string, string]>(
      `SELECT e.time FROM events e WHERE e.seq =
         (SELECT min(seq) FROM thread_items WHERE thread = ? AND turn = ?)`,
    )
    .get(thread, turn)?.time ?? 0

/**
 * Whether a turn has none of the user's words in it: it started without them (the senses, a task's
 * end or an expectation woke it) and no steer of theirs joined it. It isn't their conversation, as
 * Switchboard's woken work wasn't (docs.md "Being woken").
 */
const wokenTurn = (db: Database, turn: TurnId) =>
  db
    .query<{ woken: number }, [string]>(
      `SELECT start.blank = 1 AND NOT EXISTS (
         SELECT 1 FROM turn_words steer WHERE steer.turn = span.turn AND steer.thread = span.thread
           AND steer.seq BETWEEN span.first AND span.last AND steer.kind = 'steer') AS woken
       FROM turn_spans span JOIN turn_words start ON start.seq = span.first
       WHERE span.turn = ?`,
    )
    .get(turn)?.woken === 1

/**
 * Whether a woken turn is one the senses woke: Switchboard's wake role, its kernels' and triggers'
 * work, which neither its Running list nor a workspace's runner counted (core/src/places.rs:93,
 * 370-372: only chat and task work).
 */
const sensedTurn = (db: Database, turn: TurnId) =>
  db
    .query<{ sensed: number }, [string]>(
      `SELECT EXISTS (SELECT 1 FROM turn_spans span JOIN turn_words i ON i.turn = span.turn
         AND i.thread = span.thread AND i.seq BETWEEN span.first AND span.last
         WHERE span.turn = ? AND i.kind IN ('wake', 'user') AND i.sensed = 1) AS sensed`,
    )
    .get(turn)?.sensed === 1

/** A task's report, for its card in chat, kept to this, for this long. */
const REPORT_MAX = 4000
const REPORT_FOR = 3 * 24 * 3_600_000

// A finished space thread's reply is in its chat, so only a stopped one shows its reason; a
// recent task's report shows on its card.
const resultOf = (r: ThreadRow, stopped: boolean) => {
  if (stopped) {
    return r.result
  }
  return r.parent !== null && r.ended_at > Date.now() - REPORT_FOR
    ? r.result.slice(0, REPORT_MAX)
    : ""
}

const threads = (db: Database) => {
  const rows = db
    .query<ThreadRow, []>(
      `SELECT t.thread, t.parent, t.title, t.status, t.turn, t.result, t.ended_at, s.opened, s.home,
         g.stage FROM threads t LEFT JOIN thread_spaces s ON s.thread = t.thread
         LEFT JOIN thread_stages g ON g.thread = t.thread`,
    )
    .all()
  const waits = waiting(db)
  return rows.map((r) => {
    const running = r.status === "running" && r.turn !== null
    const stopped = r.status === "failed" || r.status === "limited"
    // Any thread's, as clients read a turn's start: a check's fix turn runs on a thread of its own.
    const woken = r.turn !== null && wokenTurn(db, r.turn)
    // Its turn over while its work goes on (a watch of its own, a script it set): waiting.
    return {
      id: r.thread,
      parent: r.parent,
      title: r.title,
      status: waits.has(r.thread) ? "waiting" : r.status,
      turn: r.turn,
      opened: r.opened ?? 0,
      /** Its own tag; a client walks up the parents when it has none. */
      home: r.home,
      since: running ? startedAt(db, r.thread, r.turn) : r.ended_at,
      result: resultOf(r, stopped),
      /** Where a task's work stands, as it says. */
      stage: r.stage ?? "",
      /** Its latest turn has none of the user's words in it. */
      woken,
      /** And the senses woke it: nothing shows it running. */
      sensed: woken && r.turn !== null && sensedTurn(db, r.turn),
      items: running ? items(db, r.thread, Number.MAX_SAFE_INTEGER, RUNNING_ITEMS).items : [],
    }
  })
}

/** An item's own fields, or null (said in the log) when they don't read: the rest still go. */
const readItem = recordOf("action item", ItemOpened.payload)

/** Open items, oldest first, with when each opened as `seq`. */
const actions = (db: Database) =>
  allItems(db, { status: "open" })
    .toReversed()
    .flatMap((i) => {
      const fields = readItem(i)
      return fields ? [{ ...fields, seq: i.openedAt, edits: shownEdits(i) }] : []
    })

const CLOSED = 30

/** The latest closed items, newest first, to reopen: how each closed and when, the user's answer,
 * and whether what Approve ran went through. */
const closedActions = (db: Database) =>
  allItems(db)
    .filter((i) => i.status !== "open" && i.kind !== "sealed")
    .toSorted((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
    .slice(0, CLOSED)
    .flatMap((i) => {
      const fields = readItem(i)
      return fields
        ? [
            {
              ...fields,
              seq: i.openedAt,
              status: i.status,
              closedAt: i.closedAt,
              edits: shownEdits(i),
              ...(i.answer && { answer: i.answer }),
              ...(i.ran && { ran: { ok: i.ran.ok } }),
            },
          ]
        : []
    })

/** Each placement, each space's in order: by its id, with its input and size, so a client draws a
 * widget placed twice as two, each called with its own input. */
const widgets = (db: Database) => placements(db).map(({ index: _, ...w }) => w)

/** Each account as last logged, with its label: the email its login reports, as the catalog has it. */
const labeledAccounts = (db: Database) => {
  const accounts = allAccounts(db)
  const catalog = profilesState(db).accounts
  const labels = accountLabels(
    accounts.map((a) => ({ ...a, email: catalog.find((c) => c.host === a.host)?.email })),
  )
  return accounts.map((a) => ({ ...a, label: labels.get(a.host) ?? a.host }))
}

const snapshot = (db: Database) => {
  const tree = spaces(db)
  return {
    spaces: tree,
    warm: warm(db),
    reads: reads.snapshot(db),
    replies: replies(db),
    threads: threads(db),
    actions: actions(db),
    closedActions: closedActions(db),
    widgets: widgets(db),
    layouts: layouts(db),
    prefs: prefs(db),
    connections: allConnections(db),
    extensions: installedExtensions(db),
    accounts: labeledAccounts(db),
    credentials: listed(db, Date.now()),
    activities: runningActivities(db),
    chats: tree
      .filter((s) => !s.archived)
      .map((s) => chat(db, s.id, Number.MAX_SAFE_INTEGER, CHAT_PAGE)),
  }
}

const SHOWN = [
  "pref.",
  "space.",
  "thread.",
  "turn.",
  "item.",
  "widget.",
  "layout.",
  "connection.",
  "extension.installed",
  "extension.updated",
  "extension.removed",
  // The same, as the log has them from before extensions were renamed.
  "spur.installed",
  "spur.updated",
  "spur.removed",
  "account.",
  "profile.",
  "credential.",
  "memory.written",
  "memory.forgotten",
  "setting.set",
  "iphone.activity",
]

/** A tag goes out only when it's of something clients hold: a chat line or a thread's opening. */
const live = (db: Database, e: StoredEvent) => {
  if (e.type === SpaceTagged.type) {
    const seq = Option.getOrNull(decodeTagged(e.payload))?.seq
    const tagged =
      seq === undefined
        ? null
        : db.query<{ type: string }, [number]>("SELECT type FROM events WHERE seq = ?").get(seq)
    return (
      tagged?.type === "message.posted" ||
      tagged?.type === "thread.opened" ||
      (e.source === "retag" &&
        db.query("SELECT 1 FROM chat_events WHERE seq = ?").get(seq ?? 0) !== null)
    )
  }
  if (e.type === GateDecided.type) {
    return Option.getOrNull(decodeGate(e.payload))?.exit === "reply"
  }
  if (e.type === TriageSorted.type) {
    return Option.getOrNull(decodeSorted(e.payload))?.items.some((i) => i.line === true) === true
  }
  return LIVE.has(e.type) || SHOWN.some((p) => e.type.startsWith(p))
}

/** What changes a chat line: each goes out as it is. */
const LIVE = new Set([
  "message.posted",
  "message.moved",
  "message.removed",
  "message.restored",
  "message.edited",
  "message.revised",
  "message.reacted",
  // Files shared from the iPhone into a desktop's draft (draft.ts).
  "draft.shared",
])

const decodeTagged = Schema.decodeUnknownOption(SpaceTagged.payload)
const decodeGate = Schema.decodeUnknownOption(GateDecided.payload)
const decodeSorted = Schema.decodeUnknownOption(TriageSorted.payload)

const before = Schema.optionalKey(Schema.Number)
const chatArgs = Schema.decodeUnknownOption(Schema.Struct({ space: SpaceId, before }))
const threadArgs = Schema.decodeUnknownOption(Schema.Struct({ thread: ThreadId, before }))

/** What a client's snapshot holds, its events and its pages, each read in a reader thread. */
export const clientView: View = {
  snapshot: defineRead("core/view/snapshot", snapshot),
  live: defineRead("core/view/live", live),
  // Pairing and revoking go through the core's /auth routes, which check the caller's scopes.
  accepts: (command) => !command.startsWith("credential."),
  acceptsEvent: (event) => !event.startsWith("item.") && !event.startsWith("connection."),
  pages: {
    memories: defineRead("core/view/memories", (db, _args: unknown) => memoriesPage(db)),
    system: defineRead("core/view/system", (db, _args: unknown) => systemPage(db)),
    find: defineRead("core/view/find", findPage),
    chat: defineRead("core/view/chat", (db, args: unknown) =>
      Option.match(chatArgs(args), {
        onNone: () => [],
        onSome: (a) => chat(db, a.space, a.before ?? Number.MAX_SAFE_INTEGER, CHAT_PAGE),
      }),
    ),
    thread: defineRead("core/view/thread", (db, args: unknown) =>
      Option.match(threadArgs(args), {
        onNone: () => [],
        onSome: (a) => items(db, a.thread, a.before ?? Number.MAX_SAFE_INTEGER, THREAD_PAGE),
      }),
    ),
  },
}

export const viewConfig = {
  events: [],
  projections: [threadSpaces, bouncedDrafts, chatEvents, turnSpans, turnWords],
  commands: [],
}
