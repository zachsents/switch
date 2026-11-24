// Switchboard's ponderer for the user's wake rules (monologue/src/kernels/ponder.rs): each rule
// gathers the records its filter lets in for its `batch_s`, then one decision reads the burst against
// its question, a probability each, as Switchboard built it to the character (its guide, the kernel's
// name and question, each record's line), and what's at its threshold wakes a turn, one per burst. A rule at 0,
// or a trigger (core/triggers.rs), wakes on all it gathered with no model. A burst that couldn't be
// read waits five minutes and is tried again, for up to six hours. Each decision is kept, and a
// restart gathers again from where each rule's last decision left off.
import type { StoredEvent } from "@switch/brain"
import { defineEvent } from "@switch/brain"
import type { Question } from "@switch/models"
import { Schema } from "effect"

import { field, text } from "./json.ts"

/** A burst gathers this long when a rule doesn't say (ponder.rs:44 `BATCH`). */
export const BATCH_MS = 120_000
/** A trigger's, when it doesn't say (core/triggers.rs:35 `BATCH_S`). */
export const TRIGGER_BATCH_MS = 60_000
/** A decision reads at most this many records at once (ponder.rs:46 `AT_ONCE`). */
export const AT_ONCE = 40
/** A burst that couldn't be read is tried again this much later (ponder.rs:49 `RETRY`)… */
export const RETRY_MS = 5 * 60_000
/** …and let go once it's older than this (ponder.rs:50 `GIVE_UP_MS`). */
export const GIVE_UP_MS = 6 * 3_600_000

/** A wake rule's decision on a burst (Switchboard's `decided` about its kernel, ponder.rs:327-341). */
export const TriageDecided = defineEvent(
  "triage.decided",
  1,
  Schema.Struct({
    rule: Schema.String,
    /** Its threshold; 0 for one that wakes on all it lets in. */
    at: Schema.Number,
    records: Schema.Array(Schema.Struct({ seq: Schema.Number, p: Schema.Number })),
    /** wake: some went through; rest: none did; lost: unread for six hours, let go. */
    verdict: Schema.Literals(["wake", "rest", "lost"]),
    /** The bearing kernel's: each record against each piece of running work (bearing.ts). */
    answers: Schema.optionalKey(
      Schema.Array(Schema.Struct({ seq: Schema.Number, thread: Schema.String, p: Schema.Number })),
    ),
    ms: Schema.Number,
    cost: Schema.Number,
  }),
)

/** Text on one line, at most `max` characters (words.rs:17 `one_line`). */
export const oneLine = (s: string, max: number) => {
  const flat = s.split(/\s+/u).filter(Boolean).join(" ")
  // Counted in characters, as Rust's `chars()`.
  const chars = flat.match(/./gsu) ?? []
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : flat
}

/** A record's body: an extension's `data`, or `body` as Switchboard's own records came over. */
export const bodyOf = (payload: unknown) => field(payload, "data") ?? field(payload, "body")

/** ponder.rs:56-59 `GUIDE`, as it was. */
export const GUIDE =
  "You decide whether one of the kernels of Switch, an AI assistant that works for one person, wakes for what just " +
  "came in. A kernel owns one question, and what wakes it costs real work (a model call that writes, or a full agent turn), so a record wakes " +
  "it only when it plainly bears on that question; when the kernel's words don't settle a record, let it go unless missing it would cost the " +
  "person something, since nothing is lost by letting one go (it stays in the brain). Answer each question about the numbered records below."

/** words.rs:7 `ago`. */
const ago = (at: number, now: number) => {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 60) {
    return `${String(minutes)} min ago`
  }
  return minutes < 2880
    ? `${String(Math.floor(minutes / 60))} h ago`
    : `${String(Math.floor(minutes / 1440))} days ago`
}

const byName = ([a]: readonly [string, unknown], [b]: readonly [string, unknown]) => {
  if (a === b) {
    return 0
  }
  return a < b ? -1 : 1
}

/** A value as Switchboard's serde_json wrote it: an object's keys in order (its Map is a BTreeMap). */
const ordered = (v: unknown): unknown => {
  if (Array.isArray(v)) {
    return v.map(ordered)
  }
  if (typeof v === "object" && v !== null) {
    return Object.fromEntries(
      Object.entries(v)
        .toSorted(byName)
        .map(([k, x]: [string, unknown]) => [k, ordered(x)]),
    )
  }
  return v
}

/**
 * What a record without facts carries besides its words, in a short line (ponder.rs:228-251
 * `carries`): each field by name, a list by its length, an object by its text or its keys.
 */
const carries = (body: unknown) => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return ""
  }
  const parts = Object.entries(body)
    .filter(([name]) => name !== "summary" && name !== "text")
    .toSorted(byName)
    .map(([name, v]: [string, unknown]) => {
      if (Array.isArray(v)) {
        return `${name}: ${String(v.length)}`
      }
      if (typeof v === "object" && v !== null) {
        const t = field(v, "text")
        return typeof t === "string"
          ? `${name}: ${oneLine(t, 200)}`
          : `${name}: {${Object.keys(v).join(", ")}}`
      }
      return typeof v === "string" ? `${name}: ${oneLine(v, 80)}` : `${name}: ${JSON.stringify(v)}`
    })
  return oneLine(parts.join(" · "), 1200)
}

/**
 * A record as a decision reads it (ponder.rs:255-259 `line`): its stream, kind and source (the
 * appendage and the machine it runs on, as Switchboard named a source), how long ago, its words, then
 * its facts or what it carries.
 */
export const recordLine = (e: StoredEvent, machine: string | null, now: number) => {
  const body = bodyOf(e.payload)
  const summary =
    text(field(body, "summary")) || text(field(body, "text")) || text(field(body, "statement"))
  const facts = field(body, "facts")
  const shown = facts === undefined ? carries(body) : oneLine(JSON.stringify(ordered(facts)), 1200)
  const own = e.source.replace(/^sb:/u, "")
  const source = machine === null || own.includes("@") ? own : `${own}@${machine}`
  return `${text(field(e.payload, "stream"))} · ${text(field(e.payload, "kind"))} · ${source} · ${ago(e.time, now)}: ${oneLine(summary, 300)}\n  ${shown}`
}

/** ponder.rs:271-276, 362 `predicate`: a kernel with no criteria of its own, a predicate per record. */
export const recordQuestion = (i: number): Question => ({
  instructions: `About record ${String(i + 1)}: By the kernel's question above, is it worth waking for?`,
  choices: [{ value: "yes" }, { value: "no" }],
  predicate: true,
})
