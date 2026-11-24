// Switchboard's bearing kernel (monologue/src/kernels/builtin.rs:305-329, kernels/bodies/bearing.rs):
// what comes in (mail, a text, a DM, an answer to an ask, an order) is read against the work running
// now, one decision with a probability for each record and piece of work, and what bears on one is
// handed into its running turn at its next step, as a wake joins one (sessions.ts `kick`). Work
// between turns doesn't get it as a turn of its own (claude/src/main.rs:773-775). Triage gathers its
// records 30 seconds as it gathers a wake rule's (triage.ts), and hands them here.
import type { Database } from "bun:sqlite"
import { getThread, waitingEvent } from "@switch/agent"
import type { Wake } from "@switch/agent"
import { Brain, EventId } from "@switch/brain"
import type { Incoming, StoredEvent, ThreadId } from "@switch/brain"
import { Models } from "@switch/models"
import type { Question } from "@switch/models"
import { Effect } from "effect"

import { sensedIn } from "./bypass.ts"
import { ItemAnswered } from "./items.ts"
import { field, text } from "./json.ts"
import { TriageDecided, bodyOf, oneLine, recordLine } from "./ponder.ts"
import type { WakeRule } from "./rules.ts"

/** builtin.rs:305-329: its streams and kinds, the first record about a thing, 30 s bursts. */
export const BEARING: WakeRule = {
  name: "bearing",
  title: "What bears on running work",
  words: "",
  question: "Does what just came in bear on work I have running, so it should hear it now?",
  goal: "",
  wakes: {
    streams: ["comms/**", "asks", "calendar/**", "trips/**", "commerce/**"],
    kinds: ["message", "observation", "answer", "trip"],
    match: {},
    notFrom: ["monologue@*"],
    first: true,
    batchS: 30,
    at: 0,
    unless: {},
  },
}

/** bearing.rs:21-23: how many pieces of running work, and records, one decision weighs. */
const WORK_AT_ONCE = 8
const RECORDS_AT_ONCE = 12
/** builtin.rs:322 `bears`. */
const AT = 0.7

// bearing.rs:25-28, as it was.
const GUIDE =
  "You decide, for Switch (an AI assistant working for one person), whether something that just came in bears on " +
  "work it has running now, so that work should hear it at its next step. A record bears on a piece of work when it answers what that work is " +
  "waiting for, changes what it's doing or should do, or is the very thing it's about (the same person, order, booking or job). Being on the " +
  "same general subject isn't enough. Be calibrated."

/** An answer to an ask, as bearing reads it. */
export const ANSWER = "asks.answer"

/**
 * The user's answer to one of their items, as Switchboard's `asks` answer record, which bearing read
 * with the rest; any other event as it is.
 */
export const asRecord = (db: Database, e: StoredEvent): StoredEvent => {
  if (e.type !== ItemAnswered.type) {
    return e
  }
  const id = text(field(e.payload, "id"))
  const title =
    db
      .query<{ title: string | null }, [string]>(
        "SELECT json_extract(data, '$.title') AS title FROM action_items WHERE id = ?",
      )
      .get(id)?.title ?? id
  const approved = field(e.payload, "approved")
  const said = [
    approved === true ? "approved" : "",
    approved === false ? "declined" : "",
    text(field(e.payload, "choice")),
    text(field(e.payload, "text")),
  ].filter((x) => x !== "")
  return {
    ...e,
    type: ANSWER,
    source: "owner",
    payload: {
      stream: "asks",
      kind: "answer",
      data: { summary: `The user answered "${title}": ${said.join(", ") || "answered"}`, item: id },
    },
  }
}

interface Work {
  readonly thread: ThreadId
  readonly title: string
  readonly task: boolean
  readonly turn: string
}

/**
 * The work a record could bear on (bearing.rs:30-33): a space's conversation or a task with a turn
 * running now, most recently active first; never work the senses woke (Switchboard's wake role).
 */
const running = (db: Database): Work[] =>
  db
    .query<{ thread: ThreadId; parent: string | null; title: string; turn: string }, []>(
      `SELECT t.thread, t.parent, t.title, t.turn FROM threads t
       WHERE t.status = 'running' AND t.turn IS NOT NULL AND (t.thread LIKE 'space:%' OR t.parent IS NOT NULL)
       ORDER BY (SELECT max(i.seq) FROM thread_items i WHERE i.thread = t.thread) DESC`,
    )
    .all()
    .filter((w) => !sensedIn(db, w.turn))
    .slice(0, WORK_AT_ONCE)
    .map((w) => ({ thread: w.thread, title: w.title, task: w.parent !== null, turn: w.turn }))

/** bearing.rs:35-46: its title, what it set out to do, and the last two things said there. */
export const describe = (db: Database, w: Work) => {
  const goal = w.task
    ? (db
        .query<{ text: string | null }, [string]>(
          `SELECT json_extract(body, '$.text') AS text FROM thread_items WHERE thread = ?
             AND json_extract(body, '$.kind') = 'user' AND trim(json_extract(body, '$.text')) != ''
           ORDER BY seq LIMIT 1`,
        )
        .get(w.thread)?.text ?? "")
    : ""
  const said = db
    .query<{ text: string }, [string]>(
      `SELECT json_extract(body, '$.text') AS text FROM thread_items WHERE thread = ?
         AND json_extract(body, '$.kind') IN ('text', 'user') AND trim(json_extract(body, '$.text')) != ''
       ORDER BY seq DESC LIMIT 2`,
    )
    .all(w.thread)
    .toReversed()
    .map((r) => oneLine(r.text, 300))
  return [
    `"${w.title.trim()}" (${w.task ? "task" : "chat"})`,
    goal === "" ? "" : `\n  What it set out to do: ${oneLine(goal, 500)}`,
    said.length === 0 ? "" : `\n  Lately: ${said.join(" / ")}`,
  ].join("")
}

/** What the work hears at its next step (claude/src/turn.rs:351-357). */
const noticed = (e: StoredEvent) => {
  const body = bodyOf(e.payload)
  const said = oneLine(text(field(body, "summary")) || text(field(body, "text")), 400)
  return `This just came in, and I noticed it bears on what you're doing: ${said} (${text(field(e.payload, "stream"))}, event ${String(e.seq)}; brain_query opens it). Take it into account, or carry on if it changes nothing.`
}

/**
 * One decision on records (their lines) against work (its titles, and each described): a probability
 * for each record and piece of work (bearing.rs:56-71).
 */
export const decide = (
  titles: readonly string[],
  described: readonly string[],
  lines: readonly string[],
) =>
  Effect.gen(function* deciding() {
    const models = yield* Models
    const questions: Record<string, Question> = {}
    for (const [i] of lines.entries()) {
      for (const [j, title] of titles.entries()) {
        questions[`r${String(i)}w${String(j)}`] = {
          instructions: `Does record ${String(i + 1)} bear on work ${String(j + 1)} ("${title.trim()}"), so it should hear it now?`,
          choices: [{ value: "yes" }, { value: "no" }],
          predicate: true,
        }
      }
    }
    const d = yield* models.decide(
      {
        stable: `${GUIDE}\n\nThe work running now:\n${described.map((w, j) => `Work ${String(j + 1)}: ${w}`).join("\n")}`,
        item: lines.map((l, i) => `Record ${String(i + 1)}:\n${l}`).join("\n\n"),
      },
      questions,
    )
    return {
      p: (i: number, j: number) => d.answers[`r${String(i)}w${String(j)}`]?.probabilities.yes ?? 0,
      ms: d.ms,
      cost: d.cost,
    }
  })

/**
 * Reads a burst against the work running now (bearing.rs:48-91): what bears on a piece of work at .7
 * waits for it in the record and joins its running turn; the decision is kept. Fails when a decision
 * can't be had, and the burst is tried again.
 */
export const bore = (records: readonly StoredEvent[]) =>
  Effect.gen(function* bearing() {
    const brain = yield* Brain
    const read = records.slice(0, RECORDS_AT_ONCE)
    const works = yield* brain.read(running)
    const last = String(read.at(-1)?.seq ?? 0)
    const kept = (
      answers: readonly { seq: number; thread: string; p: number }[],
      ms: number,
      cost: number,
    ): Incoming => ({
      id: EventId.make(`decided:${BEARING.name}:${last}`),
      type: TriageDecided.type,
      source: "triage",
      payload: {
        rule: BEARING.name,
        at: AT,
        records: read.map((e) => ({
          seq: e.seq,
          p: Math.max(0, ...answers.filter((a) => a.seq === e.seq).map((a) => a.p)),
        })),
        verdict: answers.some((a) => a.p >= AT) ? "wake" : "rest",
        answers,
        ms,
        cost,
      },
    })
    if (works.length === 0 || read.length === 0) {
      yield* Effect.orDie(brain.ingest([kept([], 0, 0)]))
      return []
    }
    const now = Date.now()
    const { described, machines } = yield* brain.read((db) => {
      const get = db.query<{ machine: string }, [string]>(
        "SELECT machine FROM extension_placements WHERE extension = ?",
      )
      return {
        described: works.map((w) => describe(db, w)),
        machines: new Map(read.map((e) => [e.source, get.get(e.source)?.machine ?? null])),
      }
    })
    const d = yield* decide(
      works.map((w) => w.title),
      described,
      read.map((e) => recordLine(e, machines.get(e.source) ?? null, now)),
    )
    const answers = read.flatMap((e, i) =>
      works.map((w, j) => ({
        seq: e.seq,
        thread: w.thread,
        p: Math.round(d.p(i, j) * 100) / 100,
      })),
    )
    // Only into work still running: what's for work between turns isn't a turn of its own.
    const still = yield* brain.read(
      (db) =>
        new Set(
          works.filter((w) => getThread(db, w.thread)?.status === "running").map((w) => w.thread),
        ),
    )
    const through = answers.filter((a) => a.p >= AT && still.has(a.thread))
    yield* Effect.orDie(
      brain.ingest([
        kept(answers, d.ms, d.cost),
        ...read.flatMap((e) =>
          through
            .filter((a) => a.seq === e.seq)
            .map((a) =>
              waitingEvent(`bearing:${String(a.seq)}:${a.thread}`, {
                thread: a.thread,
                text: "",
                note: noticed(e),
                from: "steer",
              }),
            ),
        ),
      ]),
    )
    return [...new Set(through.map((a) => a.thread))].map((thread): Wake => ({ thread }))
  })
