// After checks (gate.ts's CHECKS whose mode is "after"): each message of the agent's is read once
// it's in the user's chat, whatever posted it, so no reply waits on them. When a check's criterion
// passes, a fix turn runs on a thread of its own, on the check's tier, looking things up only; what
// it finds revises the message in place (message.revised): no new message, no notification, shown
// as edited. The fix scores the check's decision: used when it changed the message, noise when it
// found nothing. The user's rules reach both the check and its fix.
import type { Database } from "bun:sqlite"
import { Sessions } from "@switch/agent"
import { Brain, EventId, MessagePosted, MessageRevised, ThreadId } from "@switch/brain"
import type { SpaceId, StoredEvent, TurnId } from "@switch/brain"
import { Effect, Option, Schema, Stream } from "effect"

import { AFTER_MESSAGE, gate, GateScored } from "./gate.ts"
import { field, jsonOf, list, text } from "./json.ts"
import { rulesAt } from "./rules.ts"

const decodePosted = Schema.decodeUnknownOption(MessagePosted.payload)

/** A message posted this long before a restart, and not read yet, is read then. */
const CATCH_UP_MS = 10 * 60_000
/** The links a fix turn is given from what its message's turn read, at most. */
const SEEN_MAX = 80

const URL_IN_TEXT = /\b(?:https?|switchboard):\/\/[^\s"'<>\\)\]]+/gu
const LINKABLE = /^(?:https?|switchboard|mailto):/u

/** The turn that wrote a message: its own, else its space thread's latest before it. */
const writerOf = (db: Database, seq: number, space: SpaceId, turn: TurnId | undefined) =>
  turn ??
  db
    .query<{ turn: TurnId }, [string, number]>(
      "SELECT turn FROM turn_spans WHERE thread = ? AND first < ? ORDER BY first DESC LIMIT 1",
    )
    .get(`space:${space}`, seq)?.turn ??
  null

/** The links a turn saw, the latest last, each after the words just before it. */
const linksSeen = (db: Database, turn: TurnId) => {
  const seen = new Map<string, string>()
  const rows = db
    .query<{ body: string }, [string]>(
      `SELECT i.body FROM turn_spans s JOIN thread_items i ON i.thread = s.thread
         AND i.seq BETWEEN s.first AND s.last AND i.turn = s.turn
       WHERE s.turn = ? AND json_extract(i.body, '$.kind') IN ('tool', 'result') ORDER BY i.seq`,
    )
    .all(turn)
  for (const r of rows) {
    const b: unknown = JSON.parse(r.body)
    const said = text(field(b, "output")) || JSON.stringify(field(b, "input") ?? "")
    for (const m of said.matchAll(URL_IN_TEXT)) {
      const url = m[0].replace(/[.,;:!?]+$/u, "")
      const before = said
        .slice(Math.max(0, m.index - 100), m.index)
        .replaceAll(/\s+/gu, " ")
        .trim()
      seen.delete(url)
      seen.set(url, before)
    }
  }
  return [...seen]
    .slice(-SEEN_MAX)
    .map(([url, before]) => `- ${before} ${url}`)
    .join("\n")
}

/** Where a message has links, code or bare URLs already: no new link goes inside one. */
const taken = (said: string) =>
  [
    ...said.matchAll(
      /```[\s\S]*?(?:```|$)|`[^`\n]*`|!?\[[^\]\n]*\]\([^)\n]*\)|<(?:https?|switchboard):[^>\s]+>|\b(?:https?|switchboard):\/\/\S+/gu,
    ),
  ].map((m) => [m.index, m.index + m[0].length] as const)

/** The first place `words` stand in `said` outside a link, code or a URL; -1 when none. */
const freeAt = (said: string, words: string) => {
  const spans = taken(said)
  for (let at = said.indexOf(words); at !== -1; at = said.indexOf(words, at + 1)) {
    const end = at + words.length
    if (!spans.some(([from, to]) => at < to && end > from)) {
      return at
    }
  }
  return -1
}

/**
 * `said` with each found link on the first place its words stand free, as a Wikipedia article
 * links a thing where it first names it. Nothing else changes.
 */
export const linked = (said: string, links: readonly { words: string; url: string }[]) => {
  let out = said
  for (const l of links) {
    const words = l.words.trim()
    const url = l.url.trim().replaceAll(" ", "%20").replaceAll("(", "%28").replaceAll(")", "%29")
    const at =
      words === "" || /[[\]\n]/u.test(words) || !LINKABLE.test(url) ? -1 : freeAt(out, words)
    if (at !== -1) {
      out = `${out.slice(0, at)}[${words}](${url})${out.slice(at + words.length)}`
    }
  }
  return out
}

const linksOf = (said: string) =>
  list(field(jsonOf(said), "links")).map((l) => ({
    words: text(field(l, "words")),
    url: text(field(l, "url")),
  }))

/** One posted message through each after check, and a check that fires through its fix. */
const read = Effect.fnUntraced(function* checking(e: StoredEvent) {
  const brain = yield* Brain
  const sessions = yield* Sessions
  const posted = Option.getOrNull(decodePosted(e.payload))
  // A widget's message is only its title.
  if (posted === null || posted.widget !== undefined || posted.text.trim() === "") {
    return
  }
  const { space } = posted
  for (const check of AFTER_MESSAGE) {
    const preferences = yield* brain.read((db) => rulesAt(db, [space], posted.text))
    const verdict = yield* gate(check.name, {
      key: `${check.name}:${e.seq}`,
      space,
      text: posted.text,
      context: "",
      preferences,
      ...(posted.turn !== undefined && { turn: posted.turn }),
    })
    if (!verdict.pass) {
      const reading = yield* brain.read((db) => {
        const writer = writerOf(db, e.seq, space, posted.turn)
        return writer === null ? "" : linksSeen(db, writer)
      })
      const asked = [
        check.fix,
        preferences,
        reading === "" ? "" : `Links in what I read when I wrote it:\n${reading}`,
        `The message:\n${posted.text}`,
      ]
        .filter((s) => s !== "")
        .join("\n\n")
      const turn = yield* sessions.send(ThreadId.make(`${check.name}-${e.seq}`), "", {
        title: check.name,
        model: check.tier,
        permissions: { tools: [], mode: "dontAsk", delegate: false, apps: "look" },
        once: true,
        note: asked,
        sensed: true,
      })
      const end = yield* sessions.ended(turn)
      if (end.status === "done") {
        // Its words as they are now, should they have changed meanwhile.
        const now = yield* brain.read(
          (db) =>
            db
              .query<{ text: string }, [number]>(
                "SELECT text FROM messages WHERE seq = ? AND source = 'agent'",
              )
              .get(e.seq)?.text ?? null,
        )
        const fixed = now === null ? null : linked(now, linksOf(end.result))
        yield* brain.ingest([
          ...(now !== null && fixed !== null && fixed !== now
            ? [
                {
                  id: EventId.make(`revised:${check.name}:${e.seq}`),
                  type: MessageRevised.type,
                  source: "agent",
                  payload: { seq: e.seq, text: fixed, was: now },
                },
              ]
            : []),
          {
            id: EventId.make(`scored:${verdict.decision}`),
            type: GateScored.type,
            source: "autonomy",
            payload: {
              decision: verdict.decision,
              outcome: fixed !== null && fixed !== now ? "used" : "noise",
            },
          },
        ])
      }
    }
  }
})

/** Messages of the agent's posted lately, up to `head`, that their checks haven't read: a restart cut them off. */
const unread = (db: Database, head: number, now: number) =>
  db
    .query<{ seq: number }, [number, number]>(
      `SELECT m.seq FROM messages m WHERE m.source = 'agent' AND m.seq <= ? AND m.time > ?
         AND NOT EXISTS (SELECT 1 FROM gate_decisions d WHERE d.key IN (${AFTER_MESSAGE.map((c) => `'${c.name}:' || m.seq`).join(", ")}))`,
    )
    .all(head, now - CATCH_UP_MS)
    .map((r) => r.seq)

const headOf = (db: Database) =>
  db.query<{ seq: number | null }, []>("SELECT max(seq) AS seq FROM events").get()?.seq ?? 0

/** Reads each message of the agent's as it posts, each on its own, so a slow fix holds none back. */
export const afterChecks = Effect.gen(function* watching() {
  const brain = yield* Brain
  // The head alone: the brain's snapshot reads every projection whole for it (a count of all 500k
  // tags among them), 12 s of the core's thread on each start when the pages came off the disk.
  const head = yield* brain.read(headOf)
  const missed = new Set(yield* brain.read((db) => unread(db, head, Date.now())))
  yield* brain.changes(Math.min(head, ...[...missed].map((s) => s - 1))).pipe(
    Stream.filter(
      (e) =>
        e.type === MessagePosted.type &&
        e.source === "agent" &&
        // An imported message was said elsewhere, long ago.
        !e.id.startsWith("sb:") &&
        (e.seq > head || missed.has(e.seq)),
    ),
    Stream.runForEach((e) =>
      Effect.forkDetach(Effect.ignore(read(e), { log: "Warn", message: `After checks ${e.seq}` })),
    ),
  )
})
