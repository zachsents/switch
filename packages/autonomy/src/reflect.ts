// Reflection: the agent looking over what happened on its own, often and cheaply. Each look reads
// the stretch since the last (slow turns, self-started work, ignored output, what's open and what
// surprised it) and the day's measures, counted by code (measures.ts: repeated hand-work, slow and
// failing tools, the core's stalls and extensions' trouble, cost, corrections and repeats), and
// decides: leads worth keeping, each acted on once (a task) or asked about once (a "Find out"
// question, an action item in its space); standing rules that stop ignored output; lessons tied to
// the call they're about, from its mistakes (a call failed or sent back) and the user's go-aheads
// (asked once, after the same kind of approval passes unchanged again and again), so recall puts
// them in front of the next such call (hooks.ts); senses that disagree and blind spots, as
// surprises; and when to look again, from 15 minutes to 3 hours. A look with nothing new since the
// last costs no model call, and the user stepping away brings one sooner. Once a day, upkeep: gates
// scored, core fields rebuilt.
import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import type { SpaceId } from "@switch/brain"
import {
  allSpaces,
  Brain,
  defineEvent,
  EventId,
  HOME,
  ItemId,
  seqAt,
  extensionsEvent,
  ThreadId,
} from "@switch/brain"
import { Models } from "@switch/models"
import { Effect, Schema } from "effect"

import { openExpectations } from "./expect.ts"
import { gate, gateStats, scoreGates } from "./gate.ts"
import { items, OpenItem } from "./items.ts"
import { field, jsonOf, list, strings, text } from "./json.ts"
import { getLead, heldLeads, LEAD_KINDS, LeadNoted, leadsConfig, LeadTaken } from "./leads.ts"
import type { Lead } from "./leads.ts"
import { remember } from "./memory.ts"
import { buildCores } from "./recall.ts"
import { rulesAt } from "./rules.ts"
import { openSurprises, raise } from "./surprise.ts"

export const ReflectionDone = defineEvent(
  "reflection.done",
  1,
  Schema.Struct({
    /** The log it read: after `since`, through `through`. */
    since: Schema.Number,
    through: Schema.Number,
    report: Schema.String,
    started: Schema.Array(Schema.String),
    cost: Schema.Number,
    /** What stood out, a few short lines. */
    noticed: Schema.optionalKey(Schema.String),
    /** When it chose to look again, in ms. */
    next: Schema.optionalKey(Schema.Number),
  }),
)

/** The day's upkeep. */
export const ReflectionUpkept = defineEvent(
  "reflection.upkept",
  1,
  Schema.Struct({
    /** Unused memories expired, before memories stopped expiring. */
    expired: Schema.optionalKey(Schema.Number),
    /** Idle items archived, before items stopped being made. */
    archived: Schema.optionalKey(Schema.Number),
    /** Thresholds the gate tuned, before it stopped tuning them. */
    tuned: Schema.optionalKey(Schema.String),
    cost: Schema.Number,
  }),
)

export const reflectConfig = {
  events: [ReflectionDone, ReflectionUpkept, ...leadsConfig.events],
  projections: [...leadsConfig.projections],
  commands: [],
}

const DAY = 24 * 3600 * 1000

interface Row {
  readonly time: number
  readonly payload: string
}

const parse: (json: string) => unknown = JSON.parse
const usd = (n: number) => `$${n.toFixed(2)}`
const clip = (s: string, n: number) => {
  const flat = s.replaceAll(/\s+/gu, " ").trim()
  return flat.length > n ? `${flat.slice(0, n)}…` : flat
}

const events = (db: Database, type: string, since: number) =>
  db
    .query<Row, [string, number]>(
      "SELECT time, payload FROM events WHERE type = ? AND seq > ? ORDER BY seq",
    )
    .all(type, since)
    .map((r) => ({ time: r.time, p: parse(r.payload) }))

/**
 * The kind of hand-work a tool call is: the tool, for a shell the command's first words, and for
 * the gateway's `call_tool` the extension's tool it calls.
 */
const kindOf = (name: string, input: unknown) => {
  if (name === "Bash") {
    const cmd = text(field(input, "command")).replace(/^cd [^&;]+(?:&&|;)\s*/u, "")
    return `Bash: ${cmd.split(/\s+/u).slice(0, 2).join(" ")}`
  }
  return name === "mcp__apps__call_tool" ? text(field(input, "name")) : name
}

/** The same kind of approval passed unchanged this often in a month: worth asking about once. */
const APPROVED_SAME = 3

/** What the day looked like, for the model. */
const gather = (db: Database, since: number, sinceTime: number) => {
  const threads = new Map<string, string>(
    db
      .query<{ thread: string; title: string }, []>("SELECT thread, title FROM threads")
      .all()
      .map((r) => [r.thread, r.title]),
  )
  const calls = events(db, "turn.tool", since)
  const started = new Map(
    events(db, "turn.started", since).map(({ p }) => [
      text(field(p, "turn")),
      { thread: text(field(p, "thread")), text: text(field(p, "text")) },
    ]),
  )
  const ended = events(db, "turn.ended", since).map(({ p }) => ({
    turn: text(field(p, "turn")),
    thread: text(field(p, "thread")),
    status: text(field(p, "status")),
    result: text(field(p, "result")),
    cost: Number(field(p, "costUsd")) || 0,
    ms: Number(field(p, "ms")) || 0,
  }))
  // Self-started: woken turns (no words of the user's) and the tasks reflection started.
  const self = ended.filter(
    (e) => started.get(e.turn)?.text === "" || e.thread.startsWith("reflect-"),
  )
  const slow = ended
    .toSorted((a, b) => b.ms - a.ms)
    .slice(0, 5)
    .map(
      (e) => `- ${threads.get(e.thread) ?? e.thread}: ${Math.round(e.ms / 1000)} s, ${usd(e.cost)}`,
    )
  // Calls that failed or were sent back, by kind: where a mistake tied to a tool shows.
  const byId = new Map(calls.map(({ p }) => [text(field(p, "id")), p]))
  const failures = new Map<string, { n: number; examples: string[] }>()
  for (const { p } of events(db, "turn.result", since)) {
    const call = byId.get(text(field(p, "id")))
    if (field(p, "error") !== true || call === undefined) {
      continue
    }
    const k = kindOf(text(field(call, "name")), field(call, "input"))
    const entry = failures.get(k) ?? { n: 0, examples: [] }
    entry.n += 1
    if (entry.examples.length < 2) {
      entry.examples.push(
        `${clip(JSON.stringify(field(call, "input")), 120)} → ${clip(text(field(p, "output")), 160)}`,
      )
    }
    failures.set(k, entry)
  }
  const failed = [...failures]
    .toSorted((a, b) => b[1].n - a[1].n)
    .slice(0, 12)
    .map(([k, v]) => `- ${k} ×${v.n}: ${v.examples.join(" | ")}`)
  const every = items(db)
  const all = every.filter((i) => i.openedAt > sinceTime || i.status === "open")
  // The same kind of approval the user let through as drafted, again and again.
  const approvals = new Map<string, { n: number; space: SpaceId }>()
  for (const i of every) {
    if (
      i.kind === "approval" &&
      i.answer?.approved === true &&
      (i.answer.edited ?? []).length === 0 &&
      i.send !== undefined &&
      (i.closedAt ?? 0) > Date.now() - 30 * DAY
    ) {
      const k = `${i.send.app}_${i.send.tool}`
      approvals.set(k, { n: (approvals.get(k)?.n ?? 0) + 1, space: i.space })
    }
  }
  const approved = [...approvals]
    .filter(([, v]) => v.n >= APPROVED_SAME)
    .map(([k, v]) => `- ${k} ×${v.n} (last in ${v.space})`)
  // What the user said to reflection's own questions.
  const answers = every
    .filter(
      (i) =>
        i.id.startsWith("find-out-") && i.status === "answered" && (i.closedAt ?? 0) > sinceTime,
    )
    .map(
      (i) =>
        `- ${i.title} (${i.space}): ${clip([i.answer?.choice, i.answer?.text].filter(Boolean).join(": "), 300)}`,
    )
  const dismissed = all
    .filter((i) => i.status === "dismissed")
    .map((i) => `- ${i.title} (${i.space})`)
  const stale = all
    .filter((i) => i.status === "open" && i.openedAt < Date.now() - 3 * DAY)
    .map((i) => `- ${i.title} (${i.space})`)
  const wakes = db
    .query<{ space: SpaceId; wakes: number; notes: number }, [number]>(
      "SELECT space, sum(verdict = 'wake') AS wakes, sum(verdict = 'note') AS notes FROM triage_notes WHERE home = 1 AND time > ? GROUP BY space ORDER BY wakes DESC LIMIT 12",
    )
    .all(sinceTime)
    .map((r) => `- ${r.space}: ${r.wakes} wakes, ${r.notes} notes`)
  const user = db
    .query<{ space: SpaceId; n: number }, [number]>(
      "SELECT space, count(*) AS n FROM messages WHERE source NOT IN ('agent', 'peer') AND time > ? GROUP BY space",
    )
    .all(sinceTime)
    .map((r) => `- ${r.space}: ${r.n}`)
  const spaces = allSpaces(db).filter((s) => !s.archived)
  const lines = db.query<{ text: string }, [string, number]>(
    "SELECT substr(e.payload, 1, 300) AS text FROM tags t JOIN events e ON e.seq = t.seq WHERE t.home = ? AND t.seq > ? ORDER BY t.seq DESC LIMIT 8",
  )
  const active = spaces.flatMap((s) => {
    const recent = lines.all(s.id, since)
    return s.id === HOME || recent.length === 0
      ? []
      : [`- ${s.id} "${s.name}"\n  Latest: ${recent.map((r) => clip(r.text, 200)).join(" | ")}`]
  })
  const gates = gateStats(db, sinceTime).map(
    (g) =>
      `- ${g.exit}: ${g.decisions} decisions, ${g.bounced} bounced, scored ${g.used} used / ${g.noise} noise`,
  )
  return {
    failed,
    approved,
    answers,
    self,
    threads,
    slow,
    dismissed,
    stale,
    wakes,
    user,
    active,
    gates,
    spaces,
  }
}

const SYSTEM = `This is you, Switch, reflecting: every so often, and soon after the user steps away, you look over what happened since your last look and decide whether anything is worth a task now, or a question to the user, and when to look again. It's how you grow on your own instead of only answering. Switch is the user's personal agent; it should do the work and show them only what needs them, less over time. The user's rules and preferences, when given first, say how bold to be: what to start on your own, what to ask, what to leave.

Measures come first, counted by code for the last 24 hours beside the 24 before: hand-work repeated across turns, the slowest and failing tools, the core's stalls and extensions in trouble, cost by space and by day, your messages revised after they were said and the user's words said again. Read each against the day before and against what it costs: a number up sharply, high, or steady and wasteful is a lead; one that's normal for the work isn't. A wait that's slow by design, file editing that is how code gets written, a one-off spike from a single big task are no lead.

Leads are patterns or problems worth remembering even when they aren't worth a task yet, so one that keeps coming up gets acted on in time; not a log. Each is one of:
- grow: a sense or routine you lack. Look hardest at what keeps being done by hand: the same lookup, site or flow again and again across turns, a chore that recurs, a slow path (hundreds of browser steps where an API or a script would do). Its task builds a script or an extension: one coherent, general capability for that repeated work (a site's or a service's whole surface, a check you keep doing), never a category of things, nor a one-off for one case.
- fix: something unhealthy: a tool slow or failing often, the core's thread stalling, an extension stopped, crashing or quiet, turns failing, a sense reporting something wrong or stale, a routine wasting time, compute or money, claims you had to correct, the user having to ask again. Its task finds the cause and fixes it where it lives.
- learn: an open question about the user's world whose answer would make you more useful.
Give same_as with a held lead's id when this stretch shows it again, or when you act on it or ask about it now. A new one gets a name of 2 to 5 words for what would close it. "act": true starts its task now, with "task": a brief another agent can carry out (what to build or fix, where it's used, how to check it works). "ask": one short, specific question for the user instead, saying what you saw and asking the one thing you need, for when what it means is something only they know; never what you could find out yourself. It becomes an action item in "space", the id of the space it bears on, or home. A lead acts or asks, never both, and one already taken (marked) doesn't again. Start or ask only when clearly worth it now; starting nothing is often right. The user hears only what needs them: whatever you can build, fix or find out, you do with a task, and never ask them about.

Also:
- "drops": output that gets ignored (items dismissed, wakes in spaces never answered). Each {"space", "lesson"}: a standing rule that stops it, said generally. Usually none.
- "lessons": a mistake tied to a tool call that this stretch shows (a call that failed or was sent back, listed, that a lesson would have stopped; most failures are only the work going on, and need none), or a standing go-ahead the user gave in answering your question. Each {"space", "lesson", "tool", "words", "quote"}: the lesson said generally; "tool", the call it's about ("Bash", or an extension's tool as listed); "words", a few lowercase words in that call's input that pick it out; "quote", the user's exact words for a go-ahead. It's put in front of the next such call, before it runs. Usually none.
- The same kind of approval passed unchanged again and again (listed) is a learn lead whose "ask" is whether it should go ahead without asking from now on, said with what it would let you do; asked once, as every lead is.
- "surprises": two senses that disagree (kind "disagree"), or something a space needed that no sense gives (kind "blind"): {"name", "kind", "space", "text"}. Usually none.
- "noticed": what stood out, at most three short lines; where you were passive or slow.
- "next_minutes": when to look again, 15 to 180, about 60 usual. Sooner when a lot is going on or you just started or asked something; later when it's quiet or your spend is high.

Name patterns, not contents: apps, sites, people and projects, never what anyone wrote.

Answer with JSON only: {"leads": [{"name": "", "kind": "grow|fix|learn", "text": "", "same_as": "", "act": false, "task": "", "ask": "", "space": "home"}], "drops": [], "lessons": [], "surprises": [], "noticed": "", "next_minutes": 60}.`

export interface ReflectConfig {
  /** Starts a self-started task. */
  readonly start: (id: ThreadId, title: string, task: string) => Effect.Effect<void, unknown>
  /** The day's measures (measures.ts), read off the core's thread. */
  readonly measured: Effect.Effect<string, unknown>
  /** Dollars per look, core rebuilds included. */
  readonly budgetUsd?: number
}

const section = (title: string, rows: readonly string[]) =>
  rows.length === 0 ? "" : `${title}:\n${rows.join("\n")}`

type Day = ReturnType<typeof gather>

const at = (ms: number) =>
  new Date(ms).toLocaleString("en-US", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })

/** What else a look reads: what's held open, what went wrong, its own earlier looks. */
const around = (db: Database) => {
  const surprises = openSurprises(db)
    .slice(0, 12)
    .map((s) => `- ${s.kind} (${s.space}, ×${s.times}): ${clip(s.text, 160)}`)
  const expected = openExpectations(db)
    .slice(0, 12)
    .map(
      (x) =>
        `- ${x.space}: ${clip(x.what, 120)}${x.by === null ? ", watching" : `, by ${at(x.by)}`}${x.wokeAt === null ? "" : " (woke)"}`,
    )
  const held = heldLeads(db).map(
    (l) =>
      `- ${l.id} (${l.kind}, seen ${l.seen}×, last ${at(l.lastAt)}${l.taken === null ? "" : `, ${l.taken === "task" ? "task started" : "asked"}`}): ${l.name}: ${clip(l.text, 160)}`,
  )
  const earlier = db
    .query<{ time: number; payload: string }, []>(
      "SELECT time, payload FROM events WHERE type = 'reflection.done' ORDER BY seq DESC LIMIT 3",
    )
    .all()
    .flatMap((r) => {
      const noticed = text(field(parse(r.payload), "noticed"))
      return noticed === "" ? [] : [`- ${at(r.time)}: ${clip(noticed, 300)}`]
    })
  const today = db
    .query<{ n: number; usd: number | null }, [number]>(
      "SELECT count(*) AS n, sum(json_extract(payload, '$.cost')) AS usd FROM events WHERE type = 'reflection.done' AND seq >= ?",
    )
    .get(seqAt(db, new Date().setHours(0, 0, 0, 0)))
  return { surprises, expected, held, earlier, today }
}

const promptOf = (day: Day, more: ReturnType<typeof around>, measured: string) =>
  [
    `Looks so far today: ${more.today?.n ?? 0}, ${usd(more.today?.usd ?? 0)}.`,
    measured,
    section("Failed or sent-back tool calls (kind ×count: call → result)", day.failed),
    section("Approved unchanged, last 30 days (kind ×count)", day.approved),
    section("The user's answers to your questions", day.answers),
    section("Slowest turns", day.slow),
    section(
      "Self-started turns",
      day.self.map(
        (e) =>
          `- ${day.threads.get(e.thread) ?? e.thread}: ${e.status}, ${usd(e.cost)}: ${clip(e.result, 200)}`,
      ),
    ),
    section("Surprises open", more.surprises),
    section("Expectations open", more.expected),
    section("Items the user dismissed", day.dismissed),
    section("Items open over three days", day.stale),
    section("Triage by space", day.wakes),
    section("The user's messages by space", day.user),
    section("Gates", day.gates),
    section("Active spaces", day.active),
    section("Leads held", more.held),
    section("Your earlier looks", more.earlier),
  ]
    .filter((s) => s !== "")
    .join("\n\n")

const slug = (s: string) =>
  s
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 40)

const short = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 6)

const TITLE: Readonly<Record<Lead["kind"], string>> = { grow: "Grow", fix: "Fix", learn: "Learn" }

/** A question only the user can answer: an action item in the space it bears on, or Home. */
const findOut = (lead: Lead, question: string, space: SpaceId) =>
  Effect.gen(function* asking() {
    const brain = yield* Brain
    const asked = `${question}\n${lead.text}`
    const preferences = yield* brain.read((db) => rulesAt(db, [space], asked))
    const verdict = yield* gate("item", {
      key: `item:find-out-${lead.id}`,
      space,
      text: asked,
      context: "From reflection: a question only the user can answer.",
      preferences,
    })
    if (!verdict.pass) {
      return null
    }
    yield* brain.dispatch({
      id: `find-out-item:${lead.id}`,
      type: OpenItem.type,
      source: "autonomy",
      payload: {
        id: ItemId.make(`find-out-${lead.id}`),
        space,
        title: question,
        body: lead.text,
        decision: verdict.decision,
      } satisfies typeof OpenItem.payload.Type,
    })
    return space
  })

const MAX_STARTS = 2

/** Notes one lead of the answer, a new one or one held seen again; the lead as it now stands. */
const noteLead = (l: unknown, now: number) =>
  Effect.gen(function* noting() {
    const brain = yield* Brain
    const name = text(field(l, "name"))
    const known = yield* brain.read((db) => getLead(db, text(field(l, "same_as"))))
    if (known === null && name === "") {
      return null
    }
    const id = known?.id ?? `${slug(name)}-${short(`${name}\n${now}`)}`
    const payload = {
      id,
      name: known?.name ?? name,
      kind: LEAD_KINDS.find((k) => k === field(l, "kind")) ?? known?.kind ?? "learn",
      text: text(field(l, "text")) || (known?.text ?? name),
    }
    yield* Effect.orDie(
      brain.ingest([
        {
          id: EventId.make(`lead:${id}:${now}`),
          type: LeadNoted.type,
          source: "autonomy",
          payload,
        },
      ]),
    )
    return yield* brain.read((db) => getLead(db, id))
  })

const taken = (lead: Lead, how: "task" | "ask", ref: string) =>
  Effect.gen(function* marking() {
    const brain = yield* Brain
    yield* Effect.orDie(
      brain.ingest([
        {
          id: EventId.make(`lead-taken:${lead.id}`),
          type: LeadTaken.type,
          source: "autonomy",
          payload: { id: lead.id, how, ref },
        },
      ]),
    )
  })

/** Acts on a lead not yet taken: its task, or its question. What it started, or null. */
const actOn = (
  config: ReflectConfig,
  lead: Lead,
  l: unknown,
  mayStart: boolean,
  spaces: ReadonlyMap<string, SpaceId>,
) =>
  Effect.gen(function* acting() {
    const task = text(field(l, "task"))
    const ask = text(field(l, "ask"))
    if (field(l, "act") === true && task !== "" && mayStart) {
      const thread = ThreadId.make(`reflect-${lead.id}`)
      const title = `${TITLE[lead.kind]}: ${lead.name}`
      const ok = yield* Effect.exit(config.start(thread, title, task))
      if (ok._tag !== "Success") {
        return null
      }
      yield* taken(lead, "task", thread)
      return title
    }
    if (ask === "") {
      return null
    }
    const space = spaces.get(text(field(l, "space"))) ?? HOME
    const asked = yield* Effect.exit(findOut(lead, ask.slice(0, 200), space))
    if (asked._tag !== "Success" || asked.value === null) {
      return null
    }
    yield* taken(lead, "ask", asked.value)
    return `Find out: ${lead.name}`
  })

/** Leads noted, each acted on or asked about once. */
const takeLeads = (config: ReflectConfig, answer: unknown, day: Day, now: number) =>
  Effect.gen(function* taking() {
    const started: string[] = []
    const spaces = new Map<string, SpaceId>(day.spaces.map((s) => [s.id, s.id]))
    for (const l of list(field(answer, "leads")).slice(0, 8)) {
      const lead = yield* noteLead(l, now)
      if (lead !== null && lead.taken === null) {
        const did = yield* actOn(config, lead, l, started.length < MAX_STARTS, spaces)
        if (did !== null) {
          started.push(did)
        }
      }
    }
    return started
  })

/** A lesson's tie to its call, as a memory's trigger names it: an extension's tool by its words. */
const tiedTo = (tool: string, words: readonly string[]) =>
  /^[A-Z]/u.test(tool)
    ? { tools: [tool], words }
    : { tools: ["mcp__apps__*"], words: [tool.toLowerCase(), ...words] }

/** The rest of the answer: rules that stop ignored output, lessons tied to calls, and surprises. */
const keep = (answer: unknown, day: Day) =>
  Effect.gen(function* keeping() {
    const spaces = new Map<string, SpaceId>(day.spaces.map((s) => [s.id, s.id]))
    for (const d of list(field(answer, "drops")).slice(0, 3)) {
      const lesson = text(field(d, "lesson"))
      if (lesson !== "") {
        yield* Effect.ignore(
          remember({
            space: spaces.get(text(field(d, "space"))) ?? HOME,
            lesson,
            why: "Reflection: output that got ignored.",
          }),
        )
      }
    }
    for (const l of list(field(answer, "lessons")).slice(0, 3)) {
      const lesson = text(field(l, "lesson"))
      const tool = text(field(l, "tool"))
      const quote = text(field(l, "quote"))
      if (lesson !== "" && tool !== "") {
        const tie = tiedTo(
          tool,
          strings(field(l, "words")).map((w) => w.toLowerCase()),
        )
        yield* Effect.ignore(
          remember({
            space: spaces.get(text(field(l, "space"))) ?? HOME,
            lesson,
            why: quote === "" ? "Reflection: a mistake in a call." : "The user's go-ahead.",
            how: `Before a ${tool} call. Trigger: tools ${JSON.stringify(tie.tools)}, words ${JSON.stringify(tie.words)}.`,
            ...(quote !== "" && { quote }),
          }),
        )
      }
    }
    for (const s of list(field(answer, "surprises")).slice(0, 3)) {
      const kind = field(s, "kind") === "blind" ? "blind" : "disagree"
      const name = text(field(s, "name"))
      const said = text(field(s, "text"))
      if (name !== "" && said !== "") {
        yield* raise({
          id: `${kind}:${slug(name)}`,
          space: spaces.get(text(field(s, "space"))) ?? HOME,
          kind,
          text: said,
        })
      }
    }
  })

const lastLook = (db: Database) => {
  const row = db
    .query<{ time: number; payload: string }, []>(
      "SELECT time, payload FROM events WHERE type = 'reflection.done' ORDER BY seq DESC LIMIT 1",
    )
    .get()
  if (!row) {
    return null
  }
  const p = parse(row.payload)
  const next = Number(field(p, "next"))
  return {
    time: row.time,
    through: Number(field(p, "through")),
    next: Number.isFinite(next) && next > 0 ? next : row.time + WAIT_MS,
  }
}

const MINUTE = 60_000
const SOONEST = 15 * MINUTE
/** The latest a look may choose: "6 hours is long time between reflections." */
const LATEST = 180 * MINUTE
const WAIT_MS = 60 * MINUTE
/** Away this long is a break worth a look. */
const AWAY_MS = 10 * MINUTE
/** The least time between looks, however often the user steps away. */
const SPACING = 30 * MINUTE
/** How far back the first look reads. */
const FIRST_MS = 12 * 3_600_000

const NEWS = [
  "message.posted",
  "turn.ended",
  "task.ended",
  "item.opened",
  "item.closed",
  "expectation.woke",
  "expectation.lapsed",
  "expectation.broken",
  "surprise.raised",
]

/** Whether anything worth a look happened after `seq`: the user, work, items, surprises, news. */
const newsSince = (db: Database, seq: number) => {
  // Each its own index range, the first found enough.
  const one = db.query<{ n: number }, [string, number]>(
    "SELECT 1 AS n FROM events WHERE type = ? AND seq > ? LIMIT 1",
  )
  if (NEWS.some((type) => one.get(type, seq) !== null)) {
    return true
  }
  return (
    db
      .query<{ n: number }, [number]>(
        "SELECT 1 AS n FROM events WHERE type = 'triage.sorted' AND seq > ? AND json_array_length(json_extract(payload, '$.items')) > 0 LIMIT 1",
      )
      .get(seq) !== null
  )
}

/** An extension's `attention` event: whether the user is at a machine (`active`, `locked`). */
const ATTENTION = extensionsEvent("attention")

/** When the user was last at it: their messages, the clients' analytics, a Mac in use. */
const lastHere = (db: Database) => {
  const said = db
    .query<{ time: number }, []>(
      "SELECT time FROM messages WHERE source NOT IN ('agent', 'peer') ORDER BY seq DESC LIMIT 1",
    )
    .get()?.time
  const touched = db
    .query<{ time: number }, []>(
      "SELECT time FROM events WHERE type >= 'ui.' AND type < 'ui/' ORDER BY seq DESC LIMIT 1",
    )
    .get()?.time
  const active = db
    .query<{ time: number }, []>(
      `SELECT time FROM events WHERE type IN (${ATTENTION}) AND json_extract(payload, '$.active') = 1 ORDER BY seq DESC LIMIT 1`,
    )
    .get()?.time
  const times = [said, touched, active].filter((t): t is number => t !== undefined)
  return times.length > 0 ? Math.max(...times) : null
}

/** One look over everything since the last. */
export const reflect = (config: ReflectConfig) =>
  Effect.gen(function* reflecting() {
    const brain = yield* Brain
    const models = yield* Models
    const now = Date.now()
    const { previous, through } = yield* brain.read((db) => ({
      previous: lastLook(db),
      through:
        db.query<{ seq: number | null }, []>("SELECT max(seq) AS seq FROM events").get()?.seq ?? 0,
    }))
    const since = previous?.through ?? 0
    const sinceTime = previous?.time ?? now - FIRST_MS
    const day = yield* brain.read((db) => gather(db, since, sinceTime))
    const more = yield* brain.read(around)
    // A look goes on without its measures when they can't be read.
    const measured = yield* Effect.orElseSucceed(config.measured, () => "")
    const prompt = promptOf(day, more, measured)
    // The user's rules decide how bold a look is: what to start, ask about or leave.
    const preferences = yield* brain.read((db) => rulesAt(db, [HOME], prompt))
    const done = yield* models.complete(
      "gate",
      SYSTEM,
      [preferences, prompt].filter((s) => s !== "").join("\n\n"),
    )
    const answer = jsonOf(done.text)
    const started = yield* takeLeads(config, answer, day, now)
    yield* keep(answer, day)
    const noticed = text(field(answer, "noticed")).slice(0, 600)
    const minutes = Number(field(answer, "next_minutes"))
    const next =
      now +
      Math.min(LATEST, Math.max(SOONEST, Number.isFinite(minutes) ? minutes * MINUTE : WAIT_MS))
    const report = reportOf(day, started, noticed, done.cost)
    yield* Effect.orDie(
      brain.ingest([
        {
          id: EventId.make(`reflection:${through}`),
          type: ReflectionDone.type,
          source: "autonomy",
          payload: { since, through, report, started, cost: done.cost, noticed, next },
        },
      ]),
    )
    return { report, cost: done.cost, started, next }
  })

const reportOf = (day: Day, started: readonly string[], noticed: string, cost: number) => {
  const selfCost = day.self.reduce((s, e) => s + e.cost, 0)
  const self = day.self
    .slice(0, 8)
    .map(
      (e) =>
        `- ${day.threads.get(e.thread) ?? e.thread} (${usd(e.cost)}): ${e.status === "done" ? clip(e.result, 120) : e.status}`,
    )
  return [
    day.self.length === 0
      ? ""
      : `Self-started: ${day.self.length} turns, ${usd(selfCost)}.\n${self.join("\n")}`,
    started.length === 0 ? "" : `Started: ${started.join("; ")}.`,
    noticed,
    `look ${usd(cost)}`,
  ]
    .filter((s) => s !== "")
    .join("\n\n")
}

/** The day's upkeep: gates scored, cores rebuilt. */
export const upkeep = (budgetUsd: number) =>
  Effect.gen(function* keepingUp() {
    const brain = yield* Brain
    const now = Date.now()
    yield* scoreGates
    const rebuilt = yield* Effect.orElseSucceed(buildCores, () => [])
    const cost = rebuilt.reduce((s, c) => s + c.cost, 0)
    yield* Effect.orDie(
      brain.ingest([
        {
          id: EventId.make(`upkept:${new Date(now).toISOString().slice(0, 10)}`),
          type: ReflectionUpkept.type,
          source: "autonomy",
          payload: { cost: Math.min(cost, budgetUsd * 10) },
        },
      ]),
    )
  })

/** Self-started spend today: woken turns and reflection's tasks, from midnight. */
export const selfStartedToday = (db: Database, now: number) => {
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  return (
    db
      .query<{ usd: number | null }, [number, number]>(
        `SELECT sum(json_extract(e.payload, '$.costUsd')) AS usd FROM events e INDEXED BY events_ended_spend
         WHERE e.type = 'turn.ended' AND e.seq >= ?1 AND (
           json_extract(e.payload, '$.thread') LIKE 'reflect-%' OR json_extract(e.payload, '$.turn') IN (
             SELECT json_extract(s.payload, '$.turn') FROM events s INDEXED BY events_woken_turns
             WHERE s.type = 'turn.started' AND s.seq >= ?2 AND json_extract(s.payload, '$.text') = ''))`,
      )
      .get(seqAt(db, midnight), seqAt(db, midnight - DAY))?.usd ?? 0
  )
}

const UPKEEP_HOUR = 4
const SETTLE = 5 * MINUTE

const lastUpkeep = (db: Database) =>
  db
    .query<{ time: number | null }, []>(
      "SELECT max(time) AS time FROM events WHERE type = 'reflection.upkept'",
    )
    .get()?.time ?? null

/** Is a look due now: its chosen time came, or the user just stepped away. */
const lookDue = (db: Database, now: number) => {
  const last = lastLook(db)
  if (last === null) {
    return true
  }
  const here = lastHere(db)
  const away = here !== null && now - here >= AWAY_MS && here > last.time
  const due = now >= Math.min(last.next, last.time + LATEST) || (away && now - last.time >= SPACING)
  return due && newsSince(db, last.through)
}

/** Looks when one is due, checked each minute; upkeep each day at 4 am, or on start when overdue. */
export const reflecting = (config: ReflectConfig) =>
  Effect.gen(function* scheduling() {
    const brain = yield* Brain
    const budget = config.budgetUsd ?? 2
    // Nothing until the core has been serving a while: a start is no time for a look.
    yield* Effect.sleep(`${SETTLE} millis`)
    yield* Effect.forever(
      Effect.gen(function* minute() {
        yield* Effect.sleep(`${MINUTE} millis`)
        const now = Date.now()
        if (yield* brain.read((db) => lookDue(db, now))) {
          yield* Effect.ignore(reflect(config), { log: "Warn", message: "Reflection failed" })
        }
        const kept = yield* brain.read(lastUpkeep)
        const hour = new Date(now).getHours()
        if (
          kept === null ||
          (now - kept > DAY - MINUTE * 30 && hour === UPKEEP_HOUR) ||
          now - kept > DAY * 1.5
        ) {
          yield* Effect.ignore(upkeep(budget), { log: "Warn", message: "Upkeep failed" })
        }
      }),
    )
  })
