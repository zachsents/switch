// The agent's ways out besides a reply, as an app's tools: an expectation, an action item (through
// the gate, revising the open one it means), closing or following an item, a memory (through the
// write path).
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import type { Database } from "bun:sqlite"
import { Caller, defineApp, Rejected, tool } from "switch-ext-kit"
import {
  Blobs,
  Brain,
  BYPASS,
  Bypass,
  bypassOf,
  defineRead,
  EventId,
  hashOf,
  HOME,
  ItemId,
  localFiles,
  machines,
  PostMessage,
  unheardTask,
  Query,
  safeName,
  SpaceCoverSet,
  spaceFor,
  sideOfThread,
  SpaceId,
  spaceNamed,
  TurnId,
  typeOf,
  unlessBypassed,
  whoOf,
} from "@switch/brain"
import type { Found, ModelTag, ThreadId } from "@switch/brain"
import { modelOfThread, modelOfTurn } from "@switch/agent"
import type { Models } from "@switch/models"
import { Effect, Option, Schema, Stream } from "effect"

import { ItemLink, itemCall, PreparedAsk, preparedFields } from "./prepared-ask.ts"
import { sensedIn, theirsIn } from "./bypass.ts"
import { callerOf, gave } from "./caller.ts"
import {
  brief,
  DropExpectation,
  Expect,
  getExpectation,
  openExpectations,
  scoped,
  unconditioned,
} from "./expect.ts"
import { DraftCopies } from "./draft-copies.ts"
import { lost } from "./draft-words.ts"
import { FILLER, gate, lookedUp, NEWS } from "./gate.ts"
import { Images } from "./image.ts"
import {
  Attachment,
  CloseItem,
  Draft,
  ItemCheck,
  ItemCommand,
  Portal,
  fieldsOf,
  FollowItem,
  getItem,
  items,
  OpenItem,
  ReviseItem,
} from "./items.ts"
import type { ActionItem, ItemFields } from "./items.ts"
import { field } from "./json.ts"
import { MemoryForgotten, MemoryWritten, remember, saidFrom } from "./memory.ts"
import { queryWarning, wakesWarning } from "./names.ts"
import { prepare, run } from "./records-query.ts"
import { rulesAt, wakeRuleMemory, wakeRuleName } from "./rules.ts"
import { dropped, REPEAT_MS, repeats } from "./said.ts"
import { adjust, DIALS, dialsNow, railsOf } from "./settings.ts"
import { DismissSurprise, isTrouble, raise, TROUBLE_STAYS } from "./surprise.ts"

const headSeq = (db: Database) =>
  db.query<{ seq: number | null }, []>("SELECT max(seq) AS seq FROM events").get()?.seq ?? 0

const headRead = defineRead("autonomy/app/head", headSeq)

const spaceForRead = defineRead(
  "autonomy/app/space-for",
  (db, given: string | undefined, asker: string | null) => spaceFor(db, given, asker),
)

const itemRead = defineRead("autonomy/app/item", (db, id: string) => getItem(db, id))

const SPACE = "space:"
const spaceOfThread = (thread: ThreadId) =>
  thread.startsWith(SPACE) ? SpaceId.make(thread.slice(SPACE.length)) : null

const short = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10)
/** An item's page in the apps, as its row in the items source carries it (items.ts). */
const itemLink = (id: string) => `switchboard://item/${id}`

/** Where what a tool makes lives: the space given, else the asking work's, else Home (`spaceFor`). */
const spaceId = (given: string | undefined) =>
  Effect.gen(function* resolving() {
    const brain = yield* Brain
    const caller = yield* Caller
    return yield* brain.read(spaceForRead, given, caller.space)
  })

const DURATION = /^(?<n>\d+(?:\.\d+)?)\s*(?<unit>m|min|h|d|w)$/u
const UNIT: Readonly<Record<string, number>> = {
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}
const OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/u

/** Minutes from now, a duration ("90m", "2h", "3d", "1w"), or a time with its offset. */
const timeOf = (given: string | number, now: number) => {
  if (typeof given === "number") {
    return now + given * 60_000
  }
  const d = DURATION.exec(given.trim())
  if (d?.groups) {
    return now + Number(d.groups.n) * (UNIT[d.groups.unit ?? "m"] ?? 60_000)
  }
  if (!OFFSET.test(given.trim())) {
    return new Error(
      `${given} has no offset: it could be any hour. Give one (Z, -08:00) or a duration.`,
    )
  }
  const t = Date.parse(given)
  return Number.isNaN(t) ? new Error(`Can't read the time ${given}`) : t
}

/** Whose words a line in a space is, as I read them. */
const SAID_BY = { agent: "I", peer: "Another agent", user: "User" } as const

/** What the user and I said here last, for the expectation check: a time someone gave is there. */
const lastSaid = (db: Database, space: string) =>
  db
    .query<{ source: string; text: string }, [string]>(
      "SELECT source, text FROM messages WHERE space = ? ORDER BY seq DESC LIMIT 8",
    )
    .all(space)
    .toReversed()
    .map((m) => `- ${SAID_BY[whoOf(m.source)]}: ${m.text.replaceAll(/\s+/gu, " ").slice(0, 400)}`)
    .join("\n")

const when = (ms: number) =>
  Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO(Temporal.Now.timeZoneId())
    .toLocaleString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })

/** What the expectation check reads beside the wait: their open items, what was said, their rules. */
const waitContextRead = defineRead(
  "autonomy/app/wait-context",
  (db, space: SpaceId, what: string) => ({
    open:
      items(db, { status: "open" })
        .map((i) => `${i.id}: ${i.title} (${i.space})`)
        .join("; ") || "none",
    said: lastSaid(db, space),
    preferences: rulesAt(db, [space], what),
  }),
)

/** What an id a wait names is: an expectation, an item, or neither. */
const waitTargetRead = defineRead("autonomy/app/wait-target", (db, id: string | undefined) => {
  if (id === undefined) {
    return null
  }
  if (getExpectation(db, id)) {
    return "expectation"
  }
  return items(db).some((i) => i.id === id) ? "item" : null
})

const modelOfThreadRead = defineRead("autonomy/app/model-of-thread", (db, thread: ThreadId) =>
  modelOfThread(db, thread),
)

const modelOfTurnRead = defineRead("autonomy/app/model-of-turn", (db, turn: string | null) =>
  modelOfTurn(db, turn),
)

const machineNamesRead = defineRead("autonomy/app/machine-names", (db) =>
  machines(db).map((m) => m.machine),
)

/**
 * The first row an item's `resolve_when` finds now, as JSON, or why it can't run: a query error
 * stays a message here, as it crosses back from the reader.
 */
const resolveFindsRead = defineRead(
  "autonomy/app/resolve-finds",
  (
    db,
    check: string,
    zone: string,
  ): { readonly row: string | null } | { readonly error: string } => {
    try {
      const [row] = run(db, prepare(check, zone), Date.now(), zone).rows
      return { row: row === undefined ? null : JSON.stringify(row) }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
)

/** What an item's gate reads: the open items, this space's expectations, the item it revises, rules. */
const proposeRead = defineRead(
  "autonomy/app/propose",
  (db, space: SpaceId, id: string | undefined, asked: string) => ({
    open: items(db, { status: "open" }),
    expected: openExpectations(db, [space]),
    given: id === undefined ? null : getItem(db, id),
    preferences: rulesAt(db, [space], asked),
  }),
)

const saidFromRead = defineRead("autonomy/app/said-from", (db, quote: string, space: SpaceId) =>
  saidFrom(db, quote, space),
)

const placeOfRead = defineRead("autonomy/app/place-of", (db, thread: string) => placeOf(db, thread))

const unheardTaskRead = defineRead("autonomy/app/unheard-task", (db, thread: string) =>
  unheardTask(db, thread),
)

const saidLatelyRead = defineRead("autonomy/app/said-lately", (db, space: SpaceId, since: number) =>
  saidLately(db, space, since),
)

const theirsInRead = defineRead("autonomy/app/theirs-in", (db, turn: string) => theirsIn(db, turn))

const sensedInRead = defineRead("autonomy/app/sensed-in", (db, turn: string) => sensedIn(db, turn))

/** What a reply's gate reads beside it: how its turn started, the queue, what the turn looked up. */
const sayContextRead = defineRead(
  "autonomy/app/say-context",
  (
    db,
    at: {
      readonly own: boolean
      readonly sensed: boolean
      readonly thread: string
      readonly turn: string | null
      readonly space: SpaceId
      readonly text: string
    },
  ) => ({
    context: [
      at.own
        ? `This turn started itself${at.sensed ? ": the senses woke it, and" : ":"} none of the user's words are in it.`
        : lastAskIn(db, at.thread),
      `Their open items: ${
        items(db, { status: "open" })
          .map((i) => `${i.title} (${i.space})`)
          .join("; ") || "none"
      }`,
      `Open expectations: ${
        openExpectations(db, [at.space])
          .map((x) => x.what)
          .join("; ") || "none"
      }`,
      `What this turn looked up:\n${(at.turn === null ? [] : lookedUp(db, at.turn)).join("\n") || "nothing"}`,
    ]
      .filter((x) => x !== "")
      .join("\n\n"),
    preferences: rulesAt(db, [at.space], at.text),
  }),
)

const dialsRead = defineRead("autonomy/app/dials", (db) => dialsNow(db))

const spaceNamedRead = defineRead("autonomy/app/space-named", (db, name: string) =>
  spaceNamed(db, name),
)

const ExpectInput = Schema.Struct({
  space: SpaceId,
  /** One already set (as listed), to move or drop: Switchboard's `{id, …}` and `{id, retired}`. */
  id: Schema.optionalKey(Schema.String),
  what: Schema.String,
  /** Minutes from now, a duration ("90m", "2h", "3d"), or a time with its offset. */
  by: Schema.optionalKey(Schema.Union([Schema.String, Schema.Finite])),
  source: Schema.optionalKey(Schema.String),
  otherwise: Schema.optionalKey(Schema.String),
  when: Schema.optionalKey(Query),
  item: Schema.optionalKey(ItemId),
  check: Schema.optionalKey(Query),
  promise: Schema.optionalKey(Schema.Boolean),
  drop: Schema.optionalKey(Schema.Boolean),
  /** Why a check that refused it is wrong this time (brain's bypass.ts). */
  bypass: Bypass,
})
type ExpectInput = typeof ExpectInput.Type

/** Its time, or what's wrong with it. */
const timeFor = (input: ExpectInput, now: number) => {
  if (input.item !== undefined && input.when !== undefined) {
    return new Error("Give item or when, not both")
  }
  return input.by === undefined ? null : timeOf(input.by, now)
}

// A wait needs what brings it back, in plain code: a watch, the ask in the user's queue it hangs
// on, or a real time with its source (the user, Nov 22: "Why would it just silently wait till
// Tuesday to check?"). Why it's refused, or null.
const unanchored = (input: ExpectInput) => {
  if (input.by === undefined) {
    return input.when === undefined && input.item === undefined
      ? "Nothing would bring this back: give a when to watch for, the item in their queue it waits on, or a real time (by, with its source). When it waits on them and no item asks for it, put one up first (action_item)."
      : null
  }
  return (input.source ?? "").trim() === ""
    ? "A time needs its source: where it comes from (a date someone gave, an ETA, a schedule, a print's end). Without a real one, give no time: a when to watch for, or the item it waits on."
    : null
}

/** Hanging on an item is watching for it to close. */
const watchOf = (input: ExpectInput): Query | undefined =>
  input.item === undefined
    ? input.when
    : {
        from: "items",
        where: [
          { field: "id", op: "==", value: input.item },
          { field: "status", op: "!=", value: "open" },
        ],
      }

/**
 * The gate's expect check: what code can't tell. Does it wait on the user with no ask, is its time
 * made up, could it be settled now.
 */
const judgeWait = (
  input: ExpectInput,
  at: {
    readonly space: SpaceId
    readonly by: number | null
    readonly asked: ActionItem | null
    readonly key: string
    readonly work: string
  },
) =>
  Effect.gen(function* judging() {
    const brain = yield* Brain
    const kind = [
      at.asked === null ? "" : `It hangs on their open item ${at.asked.id}: ${at.asked.title}.`,
      input.when === undefined ? "" : `It watches for: ${JSON.stringify(input.when)}.`,
      at.by === null ? "No time." : `Time: ${when(at.by)}, from its source: ${input.source ?? ""}.`,
      input.promise === true ? "A promise: something I'll do myself." : "",
      input.otherwise === undefined ? "" : `Otherwise: ${input.otherwise}`,
    ]
      .filter((l) => l !== "")
      .join("\n")
    const lately = yield* brain.read(waitContextRead, at.space, input.what)
    const read = {
      context: [
        `It's now ${when(Date.now())}.`,
        `Their open items: ${lately.open}`,
        `Said here lately:\n${lately.said || "nothing"}`,
      ].join("\n\n"),
      preferences: lately.preferences,
    }
    return yield* gate("expect", {
      key: at.key,
      space: at.space,
      bypass: input.bypass,
      work: at.work,
      text: `${input.what}\n${kind}`,
      own: [input.what, input.otherwise ?? ""],
      context: read.context,
      preferences: read.preferences,
      // No time is invented without one; one hanging on their item waits on them rightly.
      without: [
        ...(at.by === null ? ["invented", "scriptable"] : []),
        ...(at.asked === null ? [] : ["user"]),
      ],
    })
  }).pipe(Effect.orElseSucceed(() => UNGATED))

/**
 * The open item a wait hangs on, or null for none; the watch it keeps, which must find nothing yet.
 */
const hangsOn = (input: ExpectInput, after: number) =>
  Effect.gen(function* hanging() {
    const brain = yield* Brain
    const asked = input.item === undefined ? null : yield* brain.read(itemRead, input.item)
    if (input.item !== undefined && asked?.status !== "open") {
      return yield* new Rejected({
        reason: `${input.item} isn't open in their queue: give an open item's id`,
      })
    }
    const watch = watchOf(input)
    for (const [name, q] of [
      ["when", watch],
      ["check", input.check],
    ] as const) {
      const wrong = q === undefined ? null : unconditioned(q)
      if (wrong !== null) {
        return yield* new Rejected({ reason: `${name}: ${wrong}` })
      }
    }
    const already = watch === undefined ? null : yield* brain.query(scoped(watch, after))
    if (already !== null && already.rows.length > 0) {
      return yield* new Rejected({
        reason: `when finds ${brief(already)} already: it's happened, so act on it now.`,
      })
    }
    return { asked, watch }
  })

const expect = tool(
  "expect",
  {
    closed: true,
    description: `X by T, else wake: one primitive for promises, watches and confirmations, judged against the brain. The work that sets it is what it wakes. Each needs what brings it back: a when, the item it hangs on, or a real time.
- when: a query (as brain_query takes) that finds nothing until it happens: a print done, a reply landing, a page changing. The moment it finds something, you're woken to do \`what\`, and again with anything more it finds after. Use it instead of waiting or polling in a turn: set it and end your turn. It has no time: it waits until it fires or its work is dropped. On the log it looks only at events after now, and stays open after it wakes you: each new event it matches wakes you again, until you drop it or its check holds. It wakes only for what's new: a record that only says something changed (read, delivered, edited) doesn't wake you unless the watch names one of its facts (payload.data.facts.…) or its entity. One that wakes you 3 times in a row with nothing done is closed. On any other source (a work's status, an item) it's met once the turn it woke is over.
- item: the open item in the user's queue it waits on. You're woken to do \`what\` when they answer it; no time.
- by, with source: a real time and where it comes from (a date someone gave, an ETA, a schedule, a print's end). Never a guess.
- check: a query that finds rows once it held. Run at by: holding, done; not, you wake with \`otherwise\`, and it's checked again after: still nothing is a surprise. With a when on the log, what shows it's all over: once it holds after a wake, the watch is met.
- promise: true for something you'll do yourself at a time ("I'll check back at 5"). At by it's judged on what your work did; not kept, you wake to keep it, and it's judged again ten minutes on.
Setting the same \`what\` again, or giving one's \`id\` (as listed), moves it; \`drop\` with its id or \`what\` cancels it.`,
    input: ExpectInput,
  },
  (input) =>
    Effect.gen(function* expecting() {
      const brain = yield* Brain
      const space = yield* spaceId(input.space)
      const id = input.id ?? `x-${short(`${space}\n${input.what}`)}`
      if (input.drop === true) {
        yield* brain.dispatch({
          id: crypto.randomUUID(),
          type: DropExpectation.type,
          source: "agent",
          payload: { id },
        })
        return { id, dropped: true }
      }
      const by = timeFor(input, Date.now())
      if (by instanceof Error) {
        return yield* new Rejected({ reason: by.message })
      }
      const thread = yield* callerOf("autonomy_expect", gave("what", input.what))
      const work = thread ?? space
      const bypass = bypassOf(input.bypass)
      const loose = yield* unlessBypassed(unanchored(input), bypass, {
        check: "expect",
        objections: ["unanchored"],
        work,
        space,
      })
      if (loose !== null) {
        return yield* new Rejected({ reason: `${loose} ${BYPASS}`, check: true })
      }
      const warning = yield* unlessBypassed(
        yield* queryWarning([input.when, input.check]),
        bypass,
        { check: "expect", objections: ["names"], work, space },
      )
      if (warning !== null) {
        return { warning }
      }
      const after = yield* brain.read(headRead)
      const { asked, watch } = yield* hangsOn(input, after)
      // A check is said back as it stands.
      const checked =
        input.check === undefined ? null : yield* brain.query(scoped(input.check, after))
      const verdict = yield* judgeWait(input, {
        space,
        by,
        asked,
        key: `expect:${work}`,
        work,
      })
      if (!verdict.pass) {
        return yield* new Rejected({
          reason: `Before this is set: ${verdict.reasons.join(" ")} ${BYPASS}`,
          check: true,
        })
      }
      yield* brain.dispatch({
        id: crypto.randomUUID(),
        type: Expect.type,
        source: "agent",
        payload: {
          id,
          space,
          what: input.what,
          ...(by !== null && { by, source: (input.source ?? "").trim() }),
          otherwise: input.otherwise ?? "",
          ...(thread !== null && { thread }),
          ...(watch !== undefined && { when: watch }),
          ...(input.check !== undefined && { check: input.check }),
          ...(input.promise === true && { promise: true }),
        },
      })
      return {
        id,
        ...(by !== null && { by: new Date(by).toISOString() }),
        ...(checked !== null && { checkNow: brief(checked) }),
      }
    }),
)

// Under the agent's own limits on a call: 5 min silent ends it (Claude Code's idle limit), so a
// wait answers before. What takes longer is an expect, not a wait (Nov 2026: waits of up to 20 min
// were cut by the client at 60 s, 64% of them).
const WAIT_MINUTES = 2
const WAIT_MAX = 4

const wait = tool(
  "wait",
  {
    description: `Only for what comes out within ${WAIT_MAX} minutes, while you hold this turn: an expectation (its id) wakes or closes, an action item (its id) closes, or a query (as brain_query takes; on the log, only events after now count) finds rows. Gives way when the user speaks. minutes: default ${WAIT_MINUTES}, at most ${WAIT_MAX}; past it, it answers timeout. For anything longer or unsure (a task, a build, a reply, a print), don't wait: set expect with when and end your turn; you're woken when it comes.`,
    readOnly: true,
    input: Schema.Struct({
      id: Schema.optionalKey(Schema.String),
      query: Schema.optionalKey(Query),
      minutes: Schema.optionalKey(Schema.Finite),
    }),
  },
  (input) =>
    Effect.gen(function* waiting() {
      const brain = yield* Brain
      const started = Date.now()
      const after = yield* brain.read(headRead)
      const target = yield* brain.read(waitTargetRead, input.id)
      let q: Query
      if (input.query !== undefined) {
        const wrong = unconditioned(input.query)
        if (wrong !== null) {
          return yield* new Rejected({ reason: `query: ${wrong}` })
        }
        q = scoped(input.query, after)
      } else if (target === "expectation") {
        q = {
          from: "expectations",
          where: [{ field: "id", op: "==", value: input.id }],
          fields: ["id", "status", "woke_at", "closed_at"],
        }
      } else if (target === "item") {
        q = { from: "items", where: [{ field: "id", op: "==", value: input.id }] }
      } else {
        return yield* new Rejected({
          reason:
            input.id === undefined ? "Give an id or a query" : `No expectation or item ${input.id}`,
        })
      }
      const out = (found: Found) => {
        const [row] = found.rows
        if (target === "expectation") {
          return row !== undefined && (row.status !== "open" || row.woke_at !== null)
        }
        if (target === "item") {
          return row !== undefined && row.status !== "open"
        }
        return found.rows.length > 0
      }
      const thread = yield* callerOf(
        "autonomy_wait",
        (given) =>
          JSON.stringify(field(given, "id") ?? field(given, "query")) ===
          JSON.stringify(input.id ?? input.query),
      )
      const space = thread === null ? null : spaceOfThread(thread)
      const came = brain.live(q, 500).pipe(
        Stream.filter(out),
        Stream.take(1),
        Stream.runHead,
        Effect.map((found) => ({ ended: "found", rows: Option.getOrNull(found)?.rows ?? [] })),
      )
      const spoke = brain.changes(after).pipe(
        Stream.filter(
          (e) =>
            space !== null &&
            e.type === "message.posted" &&
            e.source !== "agent" &&
            field(e.payload, "space") === space,
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.as({ ended: "user spoke", rows: [] }),
      )
      const minutes = Math.min(Math.max(0.1, input.minutes ?? WAIT_MINUTES), WAIT_MAX)
      const result = yield* Effect.raceFirst(came, spoke).pipe(
        Effect.timeoutOption(`${Math.round(minutes * 60_000)} millis`),
      )
      const waited = Math.round((Date.now() - started) / 1000)
      return Option.match(result, {
        onNone: () => ({
          ended: "timeout",
          rows: [],
          waitedS: waited,
          next: `Nothing in ${minutes} min. Don't wait again: set expect with when (this query, or the id's) and end your turn.`,
        }),
        onSome: (r) => ({ ...r, waitedS: waited }),
      })
    }),
)

const surpriseTool = tool(
  "surprise",
  {
    closed: true,
    description:
      "Note what didn't go as expected so it isn't lost: two senses that disagree (disagree), something a space needed that no sense gives you (blind), something that stopped (stopped). The same id again only counts it. dismiss: true with its id and why takes down one that doesn't matter. Trouble in Switch (an id starting stopped:, crashing:, failing:, quiet:, calls:, link: or push:) is never dismissed: it closes itself once it works again; fix it, fix its source if it doesn't matter, or put one ask in the user's queue if only they can.",
    input: Schema.Struct({
      id: Schema.String,
      space: Schema.optionalKey(SpaceId),
      kind: Schema.optionalKey(Schema.Literals(["disagree", "blind", "stopped", "other"])),
      text: Schema.optionalKey(Schema.String),
      dismiss: Schema.optionalKey(Schema.Boolean),
      /** With dismiss: why it doesn't matter. */
      why: Schema.optionalKey(Schema.String),
    }),
  },
  (input) =>
    Effect.gen(function* surprising() {
      const brain = yield* Brain
      if (input.dismiss === true) {
        if (isTrouble(input.id)) {
          return yield* new Rejected({ reason: TROUBLE_STAYS })
        }
        const why = (input.why ?? input.text ?? "").trim()
        if (why === "") {
          return yield* new Rejected({ reason: "Say why it doesn't matter (why)" })
        }
        yield* brain.dispatch({
          id: crypto.randomUUID(),
          type: DismissSurprise.type,
          source: "agent",
          payload: { id: input.id, why },
        })
        return { id: input.id, dismissed: true }
      }
      const space = yield* spaceId(input.space)
      yield* raise({
        id: input.id,
        space,
        kind: input.kind ?? "other",
        text: input.text ?? input.id,
      })
      return { id: input.id }
    }),
)

const ITEM_KIND = Schema.Literals(["task", "question", "approval"])

const itemInput = Schema.Struct({
  space: SpaceId,
  title: Schema.optionalKey(Schema.String),
  /** What's prepared, and the one thing left to them. */
  body: Schema.optionalKey(Schema.String),
  /** A provider approval receipt: pass result.ask intact, preserving its Gmail draft and actions. */
  ask: Schema.optionalKey(PreparedAsk),
  links: Schema.optionalKey(Schema.Array(ItemLink)),
  kind: Schema.optionalKey(ITEM_KIND),
  options: Schema.optionalKey(Schema.Array(Schema.String)),
  drafts: Schema.optionalKey(Schema.Array(Draft)),
  /** Files on the card: each a `path` on this machine (stored for every device), a `blob` already stored, or an https `url`. */
  attachments: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        ...Attachment.fields,
        type: Schema.optionalKey(Schema.String),
        path: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  /** What Approve runs: a tool as listed to you (app_tool) and its args; `{{draft:name}}` in a string arg is that draft as approved. */
  send: Schema.optionalKey(
    Schema.Struct({
      app: Schema.optionalKey(Schema.String),
      tool: Schema.String,
      args: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
  resolve_when: Schema.optionalKey(Schema.String),
  /** A command that succeeds once their step is done: run until it does, which closes the item. */
  check: Schema.optionalKey(ItemCheck),
  notify: Schema.optionalKey(Schema.Boolean),
  /** A live view on the card: the app whose screen it shows, and its session. */
  portal: Schema.optionalKey(Portal),
  /** A shell command it asks them to run, and its folder: the card opens it in a terminal. */
  command: Schema.optionalKey(ItemCommand),
  /** A deadline close by: the notification breaks through Focus. */
  urgent: Schema.optionalKey(Schema.Boolean),
  /** An open item's id: revise it in place. */
  id: Schema.optionalKey(Schema.String),
  /** With `id`: out of their queue while you rework it. */
  revising: Schema.optionalKey(Schema.Boolean),
  /** Why a check that refused it is wrong this time (brain's bypass.ts). */
  bypass: Bypass,
})
type GivenFile = NonNullable<typeof itemInput.Type.attachments>[number]

/**
 * Its files as every device fetches them: a path here is stored as a blob, a blob must be in the
 * store, and a `url` is a link. A path that's only on this machine never reaches a client.
 */
const storedFiles = (given: readonly GivenFile[]) =>
  Effect.gen(function* storing() {
    const blobs = yield* Blobs
    const out: Attachment[] = []
    for (const { path: at, ...a } of given) {
      const local = at ?? (a.url !== undefined && !/^https?:\/\//u.test(a.url) ? a.url : undefined)
      // The type given, else the path's extension, else the name's: a display name ("B: Waypoint")
      // often has none, and the file's own is what it is.
      const type = typeOf(a.name, typeOf(local ?? "", a.type ?? ""))
      if (local !== undefined) {
        const file = local.replace(/^file:\/\//u, "").replace(/^~(?=\/)/u, homedir())
        const stored = yield* blobs
          .putFile(file)
          .pipe(Effect.mapError((reason) => new Error(reason)))
        out.push({
          name: a.name || safeName(file),
          type,
          size: stored.size,
          blob: stored.hash,
          ...(a.option !== undefined && { option: a.option }),
        })
      } else if (a.blob === undefined) {
        out.push({ ...a, type })
      } else {
        const hash = hashOf(a.blob)
        if (hash === null || (yield* blobs.path(hash)) === null) {
          return yield* Effect.fail(
            new Error(
              `No blob ${a.blob} (${a.name}) in this core's store: give the file's path instead`,
            ),
          )
        }
        out.push({ ...a, type, blob: hash })
      }
    }
    return out
  })

const normalizeItem = (input: typeof itemInput.Type) => {
  const prepared = input.ask ? preparedFields(input.ask) : undefined
  const title = input.title ?? prepared?.title
  const body = input.body ?? prepared?.body
  if (title === undefined || body === undefined) {
    throw new Error("Give title and body, or the provider's ask receipt")
  }
  return { ...prepared, ...input, title, body }
}
type ItemInput = Omit<ReturnType<typeof normalizeItem>, "attachments"> & {
  readonly attachments?: readonly Attachment[]
}

/** Its input as given, with its files stored. */
const withFiles = (raw: typeof itemInput.Type) =>
  Effect.gen(function* storingFiles() {
    const { attachments, ...rest } = normalizeItem(raw)
    const input: ItemInput = attachments
      ? { ...rest, attachments: yield* storedFiles(attachments) }
      : rest
    return input
  })

const UNGATED = { pass: true, reasons: [], withheld: false, bypassed: false, decision: "" }

/** Its buttons as its card draws them, for the gate: what Approve runs, then each link. */
const buttonsOf = (input: ItemInput) => [
  ...(input.kind === "approval"
    ? [
        `Approve runs: ${input.send === undefined ? "nothing" : [input.send.app, input.send.tool].filter((x) => x !== undefined).join("_")}`,
      ]
    : []),
  ...(input.links ?? []).map((l) => `Button "${l.label}": opens ${l.url}`),
]

/** It closes itself: a query or a check, given or kept from what it revises (kernels/gates.rs:583-585). */
const selfClosing = (input: ItemInput, was: ItemFields | null) =>
  Boolean(input.resolve_when ?? input.check ?? was?.resolveWhen ?? was?.check)

/** What the card says in the agent's words: read for em dashes apart (gate.ts). */
const ownWords = (input: ItemInput) => [
  input.title,
  input.body,
  ...(input.options ?? []),
  ...(input.drafts ?? []).flatMap((d) => [d.label, d.text]),
  ...(input.links ?? []).map((l) => l.label),
]

/** What's on the card: the input's, else what `was` held. */
const contentOf = (input: ItemInput, was: ItemFields | null) => {
  const options = input.options ?? was?.options
  // A draft revised keeps where it also lives (its email draft), when the revision doesn't say.
  const drafts =
    input.drafts?.map((d) => {
      const copy = d.copy ?? was?.drafts?.find((w) => w.name === d.name)?.copy
      return copy ? { ...d, copy } : d
    }) ?? was?.drafts
  const attachments = (input.attachments ?? was?.attachments)?.map((a) => {
    if (a.blob === undefined) {
      return a
    }
    const blob = hashOf(a.blob)
    if (blob === null) {
      throw new Error(`Invalid attachment blob: ${a.name}`)
    }
    return { ...a, blob }
  })
  const links = input.links ?? was?.links
  return {
    ...(options && { options }),
    ...(drafts && { drafts }),
    ...(attachments && { attachments }),
    ...(links && { links }),
  }
}

/** How it closes itself, if it does: the input's, else what `was` held. */
const closingOf = (input: ItemInput, was: ItemFields | null) => {
  const resolveWhen = input.resolve_when ?? was?.resolveWhen
  const check = input.check ?? was?.check
  return {
    ...(resolveWhen !== undefined && { resolveWhen }),
    ...(check && { check }),
  }
}

/** What it does and how it closes: the input's, else what `was` held. */
const controlOf = (input: ItemInput, was: ItemFields | null) => {
  const send = input.send ? itemCall(input.send) : was?.send
  const notify = input.notify ?? was?.notify
  const portal = input.portal ?? was?.portal
  const command = input.command ?? was?.command
  return {
    ...(was?.action && { action: was.action }),
    ...(was?.completion && { completion: was.completion }),
    ...((input.urgent ?? was?.urgent) === true && { urgent: true }),
    ...(send && { send }),
    ...closingOf(input, was),
    ...(notify !== undefined && { notify }),
    ...(portal && { portal }),
    ...(command && { command }),
  }
}

const kindOf = (
  input: ItemInput,
  content: ReturnType<typeof contentOf>,
  control: ReturnType<typeof controlOf>,
  was: ItemFields | null,
) => {
  if (input.kind) {
    return input.kind
  }
  if (control.send || content.drafts) {
    return "approval"
  }
  if (content.options && content.options.length > 0) {
    return "question"
  }
  return was?.kind ?? "task"
}

/** The fields an item's tool input gives, with what it leaves out kept from `was`. */
const fieldsFrom = (
  input: ItemInput,
  space: SpaceId,
  was: ItemFields | null,
): Omit<ItemFields, "id" | "decision"> => {
  const content = contentOf(input, was)
  const control = controlOf(input, was)
  return {
    space,
    title: input.title,
    body: input.body,
    kind: kindOf(input, content, control, was),
    ...content,
    ...control,
  }
}

/** An open item out of their queue while the work that marks it reworks it; a revise puts it back. */
const markRevising = (id: string | undefined) =>
  Effect.gen(function* marking() {
    if (id === undefined) {
      return yield* new Rejected({ reason: "Give the open item's id" })
    }
    const brain = yield* Brain
    const was = yield* brain.read(itemRead, id)
    if (was?.status !== "open") {
      return yield* new Rejected({
        reason: was ? `${id} is ${was.status} already` : `No item ${id}`,
      })
    }
    const thread = yield* callerOf("autonomy_action_item", gave("id", id))
    yield* brain.dispatch({
      id: crypto.randomUUID(),
      type: ReviseItem.type,
      source: "agent",
      payload: { ...fieldsOf(was), revising: thread ? { thread } : {} },
    })
    return { revising: true, id: was.id, link: itemLink(was.id) }
  })

/**
 * What of the user's own words in its drafts a revision would lose, as a warning; null when none.
 * Each copied draft (an email draft he may have edited there) is read first.
 */
const dropsTheirs = (id: string, { drafts }: ItemInput) =>
  Effect.gen(function* checking() {
    if (drafts === undefined) {
      return null
    }
    const copies = yield* DraftCopies
    yield* copies.sync(id)
    const now = yield* (yield* Brain).read(itemRead, id)
    const gone = drafts.flatMap((d) => {
      const e = now?.edits[d.name]
      const lines = e ? lost(e, d.text) : []
      return lines.length === 0 ? [] : [`${d.name}: ${lines.map((l) => `“${l}”`).join(", ")}`]
    })
    return gone.length === 0
      ? null
      : `Not revised: it drops what the user wrote in its drafts (${gone.join("; ")}). Keep it. ${BYPASS}`
  })

/** It asks the user for a one-time code. */
const asksForCode = (asked: string) =>
  /\b(?:one[ -]?time|verification|authentication|sign[ -]?in|security)\s+(?:code|password)\b/iu.test(
    asked,
  ) && /\b(?:reply|paste|provide|send|enter)\b/iu.test(asked)

/** The model field for what the calling work writes: the model it runs on, else what was there. */
const modelField = (thread: ThreadId | null, was?: ModelTag) =>
  Effect.gen(function* reading() {
    const brain = yield* Brain
    const model = thread === null ? null : yield* brain.read(modelOfThreadRead, thread)
    const by = model ?? was
    return by === undefined ? {} : { model: by }
  })

/** Why an item that asks the user for a one-time code is refused, or null. */
const codeRefusal = (asked: string) =>
  asksForCode(asked)
    ? `A one-time code is yours to get: read it from the user's email or texts, and give it to the browser's sign_in as otp. Never ask them for one. ${BYPASS}`
    : null

/** A check runs on a Mac Switch knows, until it succeeds (core's item-checks.ts). */
const checkRuns = (check: ItemInput["check"]) =>
  Effect.gen(function* checking() {
    const known = check?.machine === undefined ? [] : yield* (yield* Brain).read(machineNamesRead)
    if (check?.run.trim() === "") {
      yield* Effect.fail(new Error("check.run has to be a command"))
    }
    if (check?.machine !== undefined && !known.includes(check.machine)) {
      yield* Effect.fail(new Error(`No machine ${check.machine}: ${known.join(", ")}`))
    }
  })

/** A new item, or a revision of an open one, through the gate. */
const propose = (raw: typeof itemInput.Type) =>
  Effect.gen(function* proposing() {
    const input = yield* withFiles(raw)
    const brain = yield* Brain
    const space = yield* spaceId(input.space)
    const asked = [input.title, input.body].join("\n")
    const bypass = bypassOf(input.bypass)
    // Its key is the asking work (kernels/gates.rs:648).
    const asker = yield* callerOf("autonomy_action_item", gave("title", input.title))
    const work = asker ?? "nowhere"
    const code = yield* unlessBypassed(codeRefusal(asked), bypass, {
      check: "item",
      objections: ["code"],
      work,
      space,
    })
    if (code !== null) {
      return yield* new Rejected({ reason: code, check: true })
    }
    // A check that can't run would never close it; one that already finds something closes it at once (sb/mcp.rs `ask`).
    const check = input.resolve_when
    if (check !== undefined) {
      const zone = Temporal.Now.timeZoneId()
      const found = yield* brain.read(resolveFindsRead, check, zone)
      if ("error" in found) {
        return yield* Effect.fail(
          new Error(`resolve_when has to be a query that runs: ${found.error}`),
        )
      }
      if (found.row !== null) {
        return yield* Effect.fail(
          new Error(
            `resolve_when already finds ${found.row}, so the item would close at once: it should find something only once they've done it`,
          ),
        )
      }
    }
    yield* checkRuns(input.check)
    const { open, expected, given, preferences } = yield* brain.read(
      proposeRead,
      space,
      input.id,
      asked,
    )
    if (input.id !== undefined && given?.status !== "open") {
      return yield* Effect.fail(
        new Error(given ? `${input.id} is ${given.status} already` : `No item ${input.id}`),
      )
    }
    const others = open.filter((i) => i.id !== input.id)
    const context = [
      // What this revises isn't asked twice (Switchboard's gate left the card it replaces out).
      `Their open items: ${others.length === 0 ? "none" : others.map((i) => `${i.title} (${i.space})`).join("; ")}`,
      expected.length === 0
        ? ""
        : `Open expectations here: ${expected.map((x) => x.what).join("; ")}`,
      given ? `This revises the open item "${given.title}".` : "",
    ]
      .filter((s) => s !== "")
      .join("\n")
    const drafted = (input.drafts ?? []).map((d) => `${d.label}: ${d.text}`).join("\n")
    // A gate that can't be asked lets it through: it never stalls work (Switchboard's sb mcp.rs).
    const verdict = yield* gate("item", {
      key: `item:${work}`,
      space,
      bypass: input.bypass,
      work,
      text: [
        input.title,
        input.body,
        ...(input.options ?? []),
        drafted,
        ...buttonsOf(input),
        selfClosing(input, given) ? "It closes itself once my senses see it done." : "",
      ]
        .filter((s) => s !== "")
        .join("\n"),
      context,
      preferences,
      own: ownWords(input),
    }).pipe(Effect.orElseSucceed(() => UNGATED))
    if (!verdict.pass) {
      return { opened: false, why: `${verdict.reasons.join(" ")} ${BYPASS}` }
    }
    // One that means the same as an open item went back from the gate's "waiting" (kernels/builtin.rs:158-162):
    // the agent follows that item, so both spaces hear its answer. Only an item given by id is revised.
    const was = given
    if (was) {
      const warning = yield* unlessBypassed(yield* dropsTheirs(was.id, input), bypass, {
        check: "item",
        objections: ["drafts"],
        work,
        space,
      })
      if (warning !== null) {
        return { warning }
      }
      const before = fieldsOf(was)
      const revised = {
        id: was.id,
        decision: verdict.decision,
        ...fieldsFrom(input, space, before),
        ...(yield* modelField(asker, before.model)),
      } satisfies typeof ReviseItem.payload.Type
      yield* brain.dispatch({
        id: crypto.randomUUID(),
        type: ReviseItem.type,
        source: "agent",
        payload: revised,
      })
      return { revised: true, id: was.id, link: itemLink(was.id), objections: verdict.reasons }
    }
    const id = ItemId.make(`i-${short(`${space}\n${input.title}\n${String(Date.now())}`)}`)
    const model = yield* modelField(asker)
    yield* brain.dispatch({
      id: crypto.randomUUID(),
      type: OpenItem.type,
      source: "agent",
      payload: {
        id,
        decision: verdict.decision,
        ...fieldsFrom(input, space, null),
        ...(input.urgent === true && { urgent: true }),
        ...model,
      } satisfies typeof OpenItem.payload.Type,
    })
    return { opened: true, id, link: itemLink(id), objections: verdict.reasons }
  })

const item = tool(
  "action_item",
  {
    closed: true,
    description:
      "Put something in the user's queue: only what needs them, after you've taken it as far as you can without them. " +
      "kind: task (Done), question (options as keys and/or a typed answer), approval (Approve runs `send`, the committal call, with `drafts` as they left them; put every message you'd send for them in drafts and `{{draft:name}}` in send's args). " +
      'For an approval receipt an extension tool returns (its result.ask), pass it entire in `ask`; do not rebuild it or create another draft. links: navigation buttons. attachments: files on the card, each its `path` on this machine (stored so every device opens it) and name. When it leaves them a step outside Switch (a setting, an approval elsewhere, a sign-in, a payment, something by hand) that a command or a record can see done, give it a way to close itself, so they never tap Done just to tell you: check, a sh command that succeeds once it\'s done (`ssh -o BatchMode=yes -o ConnectTimeout=10 user@host true`), run every 10 s on `machine` (the core\'s own by default) until it does; or resolve_when, a query that finds something once they\'ve done it (entities | where id == "device:studio" and facts.accessibility == true). The item then closes itself and you hear about it. Either must not hold yet when you ask. notify: false for no notification. portal: a live view of the Mac an app runs on, about one of its sessions ({"app": "<app>", "session": "<session>"}), which the user drives from the card; the app\'s own instructions say when. ' +
      "command: whenever it asks them to run something in a terminal, the shell line as {run, cwd?} (cwd its folder, ~ for home), not in the body: the card shows it and opens it in a terminal on the Mac they're at, typed and waiting for their ↵; give it a check too when its effect can be seen. " +
      "Give `id` to revise an open item in place. " +
      "A revision that drops words the user wrote in its drafts comes back listing them. " +
      "Take an item out of their queue while you rework it (`id` and `revising: true`), and put it back when it's ready: revise it. " +
      "`urgent` only when a deadline is close: it breaks through Focus. When they answer, do or dismiss it, this space wakes with how. The gate may send it back with what to do first.",
    input: itemInput,
  },
  (raw) =>
    Effect.gen(function* acting() {
      if (raw.revising === true) {
        return yield* markRevising(raw.id)
      }
      return yield* propose(raw)
    }),
)

const closeItem = tool(
  "close_item",
  {
    closed: true,
    description:
      "Take an item out of the user's queue yourself: done once it's done (you did it, or it no longer needs them), dismissed when it's moot. Say why.",
    input: Schema.Struct({
      id: ItemId,
      status: Schema.Literals(["done", "dismissed"]),
      why: Schema.String,
    }),
  },
  (input) =>
    Effect.gen(function* closing() {
      const brain = yield* Brain
      const thread = yield* callerOf("autonomy_close_item", gave("id", input.id))
      yield* brain.dispatch({
        id: crypto.randomUUID(),
        type: CloseItem.type,
        source: "agent",
        payload: { ...input, ...(thread !== null && { thread }) },
      })
      return { closed: input.id }
    }),
)

const followItem = tool(
  "follow_item",
  {
    closed: true,
    description:
      "Wait on an item already in their queue (one another space or an extension opened) rather than asking twice: when it closes, this space wakes with how. follow false stops waiting.",
    input: Schema.Struct({
      id: ItemId,
      space: SpaceId,
      follow: Schema.optionalKey(Schema.Boolean),
    }),
  },
  (input) =>
    Effect.gen(function* following() {
      const brain = yield* Brain
      const space = yield* spaceId(input.space)
      const follow = input.follow ?? true
      yield* brain.dispatch({
        id: crypto.randomUUID(),
        type: FollowItem.type,
        source: "agent",
        payload: { id: input.id, space, follow },
      })
      return { id: input.id, following: follow }
    }),
)

const rememberTool = tool(
  "remember",
  {
    closed: true,
    description:
      "Keep a lesson for good: a rule or preference of the user's, a lasting fact, a procedure that worked. It's merged with what's held and generalized, or dropped if it won't hold next time. When it's the user's own rule, give quote: their exact words, as they said them; they're kept with it, and the message they came from. After a mistake in a call (the user corrected what it did, or it failed) or a go-ahead for a kind of call, say in how which call (the tool, and words in its input): it's shown before the next such call runs.",
    input: Schema.Struct({
      space: SpaceId,
      lesson: Schema.String,
      why: Schema.optionalKey(Schema.String),
      how: Schema.optionalKey(Schema.String),
      quote: Schema.optionalKey(Schema.String),
      bypass: Bypass,
    }),
  },
  (input) =>
    Effect.gen(function* remembering() {
      const space = yield* spaceId(input.space)
      const thread = yield* callerOf("autonomy_remember", gave("lesson", input.lesson))
      return yield* remember({ ...input, space, thread, fromTurn: true })
    }),
)

/** A resource alarm as its wake rule keeps it, or null without a question or a line to cross. */
const alarmRule = (
  name: string,
  question: string,
  goal: string,
  alarm: Readonly<Record<string, unknown>>,
  from: string,
) =>
  question === "" ||
  (alarm.above === undefined && alarm.below === undefined && alarm.is === undefined)
    ? null
    : wakeRuleMemory({ name, question, goal, wakes: {}, at: null, alarm, from })

// docs.md "Being woken" (Switchboard's): the agent adds a kernel whose body is a turn, or a trigger,
// as data; here a wake rule the user's triage reads (rules.ts), global as kernels were.
const wakeRuleTool = tool(
  "wake_rule",
  {
    closed: true,
    description:
      "Be woken by what your senses record. Nothing they record starts a turn by itself: when something should (the user asks to be woken for it, new mail that needs them, a failed payment, an order), add a wake rule. `wakes` picks the records: `streams` and `kinds` as they're recorded (a record's `stream` and `kind`, like comms/gmail and observation); `match`: fields that must equal a value, by dotted path into the record (body.facts.inbox); `not_from`: sources it leaves out; `first`: only the first record about a thing counts, not the ones that say it changed; `batch_s`: how long a burst gathers, so it wakes one turn (default 120). A decision model reads each burst against `question` and lets through what's at least `at` likely (default 0.5) to be worth a turn; with `at` 0 every match wakes one, so keep that for what's rare. `trigger: true` makes it rules alone, no model, for what's rule-tight (a DM from someone else, an order paid): `unless` names fields that rule a record out, and a burst gathers 60 s by default. What it lets through starts a turn in the space the record belongs to, for `goal`. `alarm` in the place of `wakes` makes it a resource alarm on machines' vitals, rules alone: `on` a field of a reading (diskFreeGb, swapGb, swapGrowthGbPerHour, pressure, load5, or one over another, load5/cores), `above` or `below` a number or `is` some words, `clear` where it's over (a number, or words), `by` memory or cpu for whose processes are heaviest. It rings once an episode, on each machine, and wakes the work whose processes are heaviest there, else Home, with the numbers and those processes. The same name again changes it; `retired: true` ends it. Give quote: the user's exact words, when it rests on them.",
    input: Schema.Struct({
      space: SpaceId,
      name: Schema.String,
      question: Schema.optionalKey(Schema.String),
      wakes: Schema.optionalKey(
        Schema.Struct({
          streams: Schema.Array(Schema.String),
          kinds: Schema.optionalKey(Schema.Array(Schema.String)),
          match: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
          not_from: Schema.optionalKey(Schema.Array(Schema.String)),
          first: Schema.optionalKey(Schema.Boolean),
          batch_s: Schema.optionalKey(Schema.Number),
          at: Schema.optionalKey(Schema.Number),
        }),
      ),
      trigger: Schema.optionalKey(Schema.Boolean),
      unless: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      alarm: Schema.optionalKey(
        Schema.Struct({
          on: Schema.String,
          above: Schema.optionalKey(Schema.Number),
          below: Schema.optionalKey(Schema.Number),
          is: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
          clear: Schema.optionalKey(
            Schema.Union([Schema.Number, Schema.String, Schema.Array(Schema.String)]),
          ),
          by: Schema.optionalKey(Schema.Literals(["memory", "cpu"])),
        }),
      ),
      goal: Schema.optionalKey(Schema.String),
      retired: Schema.optionalKey(Schema.Boolean),
      quote: Schema.optionalKey(Schema.String),
      bypass: Bypass,
    }),
  },
  (input) =>
    Effect.gen(function* waking() {
      const brain = yield* Brain
      const space = yield* spaceId(input.space)
      const name = wakeRuleName(input.name)
      if (input.retired === true) {
        yield* Effect.orDie(
          brain.ingest([
            {
              id: EventId.make(`${name}:retired:${crypto.randomUUID()}`),
              type: MemoryForgotten.type,
              source: "agent",
              payload: { id: name, restore: [] },
            },
          ]),
        )
        return { retired: name }
      }
      const question = (input.question ?? input.goal ?? "").trim()
      const { alarm, wakes } = input
      const from = `Written by the agent in ${space}.`
      let kept: ReturnType<typeof wakeRuleMemory>
      let trigger = true
      if (alarm === undefined) {
        if (wakes === undefined || wakes.streams.length === 0 || question === "") {
          return yield* new Rejected({
            reason: "Give a question (or a trigger's goal) and wakes.streams",
          })
        }
        const thread = yield* callerOf("autonomy_wake_rule", gave("name", input.name))
        const warning = yield* unlessBypassed(
          yield* wakesWarning(wakes.streams, wakes.kinds ?? []),
          bypassOf(input.bypass),
          { check: "wake_rule", objections: ["names"], work: thread ?? space, space },
        )
        if (warning !== null) {
          return { warning }
        }
        trigger = input.trigger === true
        const { at, ...rest } = wakes
        kept = wakeRuleMemory({
          name: input.name,
          question,
          goal: input.goal ?? "",
          wakes: rest,
          at: trigger ? null : (at ?? 0.5),
          ...(input.unless !== undefined && { unless: input.unless }),
          from,
        })
      } else {
        const rung = alarmRule(input.name, question, input.goal ?? "", alarm, from)
        if (rung === null) {
          return yield* new Rejected({
            reason: "Give a question and the alarm's line: above, below or is",
          })
        }
        kept = rung
      }
      const said =
        input.quote === undefined ? null : yield* brain.read(saidFromRead, input.quote, space)
      yield* Effect.orDie(
        brain.ingest([
          {
            id: EventId.make(`${name}:${crypto.randomUUID()}`),
            type: MemoryWritten.type,
            source: "agent",
            payload: {
              id: name,
              name,
              description: kept.description,
              type: "feedback",
              scope: "global",
              body: kept.body,
              trigger: null,
              replaces: [],
              decision: "",
              space,
              ...(said !== null && { said }),
            },
          },
        ]),
      )
      return { rule: name, trigger, woke_on: kept.description }
    }),
)

/** Where a thread speaks: its space, its own or the one the work it was started from is in. */
export const placeOf = (db: Database, thread: string) => {
  const parent = db.query<{ parent: string | null; turn: string | null; status: string }, [string]>(
    "SELECT parent, turn, status FROM threads WHERE thread = ?",
  )
  const home = db.query<{ home: string | null }, [string]>(
    "SELECT home FROM thread_spaces WHERE thread = ?",
  )
  const first = parent.get(thread)
  let at: string | null = thread
  for (let i = 0; at !== null && i < 20; i += 1) {
    if (at.startsWith("space:")) {
      return {
        space: at.slice("space:".length),
        turn: first?.turn ?? null,
        task: first?.parent !== null,
      }
    }
    const tagged = home.get(at)?.home ?? null
    if (tagged !== null) {
      return { space: tagged, turn: first?.turn ?? null, task: first?.parent !== null }
    }
    at = parent.get(at)?.parent ?? null
  }
  return { space: HOME, turn: first?.turn ?? null, task: first?.parent !== null && first !== null }
}

/** The user's latest words to this thread, for the reply check: what a say answers. */
const lastAskIn = (db: Database, thread: string) => {
  const row = db
    .query<{ text: string }, [string]>(
      `SELECT json_extract(body, '$.text') AS text FROM thread_items WHERE thread = ?
         AND json_extract(body, '$.kind') IN ('user', 'steer') AND trim(json_extract(body, '$.text')) != ''
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(thread)
  return row ? `The user's message:\n${row.text.slice(0, 2000)}` : ""
}

/**
 * What the agent said in this space in the last few minutes (said.rs `recent_query`), off the
 * messages table's (space, seq) index: the log's message.posted rows, read one by one, took seconds.
 */
const saidLately = (db: Database, space: string, since: number) =>
  db
    .query<{ text: string; time: number }, [string, number]>(
      `SELECT text, time FROM (SELECT text, time FROM messages WHERE space = ? AND source = 'agent'
         ORDER BY seq DESC LIMIT 50) WHERE time > ?`,
    )
    .all(space, since)

// Switchboard's say (sb/mcp.rs:466-499): the one way words reach the user. It goes to the
// conversation the turn is in, as a message of the turn; a repeat of what that conversation said in
// the last few minutes is dropped, saying what it repeats (protocol/src/said.rs); in a task it only
// answers the user's words to it, never its parent's prompt or follow-ups (brain heard.ts). The
// reply check reads it first. Unlike there, a turn the agent started itself may say what the user
// should hear, and it notifies them as a reply does: his words, "I definitely want the agent to be able to message me if it needs to".
// In an extension's side thread it answers there, never in the chat.
// Work the senses woke stays apart, as Switchboard's wake role did (sb/mcp.rs:472-481 refused its
// say): only news the user needs now passes (gate.ts NEWS), and no bypass takes it past.
const sayTool = tool(
  "say",
  {
    closed: true,
    description:
      "Say something to the user: the only way your words reach them. Your other text is your own. It goes to this conversation, and notifies them when they're away. A result, an answer or a real question, never an acknowledgement or progress (react; a task's stage): the answer first, in as few sentences as hold it. `files`: paths on this machine to show with it. `detail`: optional and rare, the long version opened on demand; it never repeats the text.",
    input: Schema.Struct({
      text: Schema.String,
      files: Schema.optionalKey(Schema.Array(Schema.String)),
      detail: Schema.optionalKey(Schema.String),
      bypass: Bypass,
    }),
  },
  (input) =>
    Effect.gen(function* saying() {
      const brain = yield* Brain
      const blobs = yield* Blobs
      const text = input.text.trim()
      if (text === "") {
        return yield* new Rejected({ reason: "say needs text: what you say to the user" })
      }
      const thread = yield* callerOf("autonomy_say", gave("text", input.text))
      if (thread === null) {
        return yield* new Rejected({ reason: "say works from a turn" })
      }
      const at = yield* brain.read(placeOfRead, thread)
      const space = yield* spaceId(at.space)
      if (yield* brain.read(unheardTaskRead, thread)) {
        return yield* new Rejected({
          reason:
            "In a task, say answers the user's words to it, and none have reached it: what's for them goes in your report, or an item when it needs their hands.",
        })
      }
      // In an extension's side thread (brain's ids.ts), what's said goes back to the extension,
      // read from this call in the record: never a message in the space's chat.
      const side = sideOfThread(thread) !== null
      if (side && (input.files ?? []).length > 0) {
        return yield* new Rejected({ reason: "In a side thread, say takes words only" })
      }
      const now = Date.now()
      const lately = side ? [] : yield* brain.read(saidLatelyRead, space, now - REPEAT_MS)
      const again = lately.find((m) => repeats(text, m.text))
      if (again !== undefined) {
        return { said: false, why: dropped(now - again.time, again.text) }
      }
      // A turn the agent started itself (none of the user's words in it) is also asked whether what
      // it says is filler (gate.ts FILLER); one the senses woke, whether it's news they need now.
      const own = at.turn === null || (yield* brain.read(theirsInRead, at.turn)) === 0
      const sensed = at.turn !== null && (yield* brain.read(sensedInRead, at.turn))
      const verdict = yield* brain
        .read(sayContextRead, { own, sensed, thread, turn: at.turn, space, text })
        .pipe(
          Effect.flatMap((read) =>
            gate("reply", {
              key: `reply:${at.turn ?? thread}`,
              space,
              text,
              context: read.context,
              preferences: read.preferences,
              ...(at.turn !== null && { turn: TurnId.make(at.turn) }),
              ...(own && { also: [sensed ? NEWS : FILLER] }),
              own: [text, input.detail ?? ""],
              bypass: sensed ? undefined : input.bypass,
              work: thread,
            }),
          ),
          Effect.orElseSucceed(() => UNGATED),
        )
      if (!verdict.pass) {
        return yield* new Rejected({
          reason: `Before this goes to the user: ${verdict.reasons.join(" ")}${sensed ? "" : ` ${BYPASS}`}`,
          check: true,
        })
      }
      if (side) {
        return { said: true, thread }
      }
      const attachments = yield* Effect.all(
        (input.files ?? []).map((file) =>
          blobs.putFile(file).pipe(
            Effect.map((stored) => ({
              blob: stored.hash,
              name: safeName(file),
              type: typeOf(file),
              size: stored.size,
            })),
            Effect.mapError((reason) => new Rejected({ reason })),
          ),
        ),
      )
      const inline = yield* localFiles(blobs, text)
      const model = yield* brain.read(modelOfTurnRead, at.turn)
      const all = [...attachments, ...inline.attachments]
      const receipt = yield* brain.dispatch({
        id: crypto.randomUUID(),
        type: PostMessage.type,
        source: "agent",
        payload: {
          space,
          text: inline.text,
          ...(at.turn !== null && { turn: at.turn }),
          ...(model !== null && { model }),
          ...(all.length > 0 && { attachments: all }),
          ...(input.detail !== undefined && input.detail.trim() !== "" && { detail: input.detail }),
        },
      })
      return { said: true, seq: receipt.seq }
    }),
)

// An explicit end: a turn with nothing for the user ends on this rather than in silence. His words:
// "making doing nothing explicit … if it literally doesn't do anything, it has to use the explicit
// `do nothing` tool call".
const nothingTool = tool(
  "nothing",
  {
    closed: true,
    description:
      "End this turn with nothing for the user: nothing to say, react to or put in their queue. `note`: a private word on why, for your own record.",
    input: Schema.Struct({ note: Schema.optionalKey(Schema.String) }),
  },
  () => Effect.succeed({ nothing: true }),
)

const settingTool = tool(
  "setting",
  {
    closed: true,
    description: `Move one of your dials when you learn the user wants it otherwise: a correction ("just do it", "stop pinging me"), a pattern in what they dismiss or let stand. It's yours to move; the user sees it in this space's chat with Undo. Give quote: their exact words, when it rests on them. Without key, lists the dials as they stand. The dials: ${Object.entries(
      DIALS,
    )
      .map(([key, d]) => `${key} (${railsOf(d)}, default ${JSON.stringify(d.default)}): ${d.what}`)
      .join("; ")}`,
    input: Schema.Struct({
      space: SpaceId,
      key: Schema.optionalKey(Schema.String),
      value: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
      why: Schema.optionalKey(Schema.String),
      quote: Schema.optionalKey(Schema.String),
    }),
  },
  (input) =>
    Effect.gen(function* setting() {
      const brain = yield* Brain
      if (input.key === undefined || input.value === undefined) {
        return { dials: yield* brain.read(dialsRead) }
      }
      const space = yield* spaceId(input.space)
      return yield* adjust({
        space,
        key: input.key,
        value: input.value,
        why: input.why ?? "",
        ...(input.quote !== undefined && { quote: input.quote }),
      })
    }),
)

const coverTool = tool(
  "cover",
  {
    closed: true,
    description:
      "Set a space's cover, the picture shown behind its name, from an image you have: `image`, a path on this machine or a blob. Without `image`, clears it. Make a cover in the look the user wants for covers (their wishes in memory); autonomy_image draws one.",
    input: Schema.Struct({ space: Schema.String, image: Schema.optionalKey(Schema.String) }),
  },
  (input) =>
    Effect.gen(function* covering() {
      const brain = yield* Brain
      const space = yield* brain.read(spaceNamedRead, input.space)
      if (space === null || space === HOME) {
        return yield* new Rejected({ reason: `No space ${input.space}` })
      }
      const blobs = yield* Blobs
      const given = input.image?.trim() ?? ""
      const stored = blobs
        .putFile(given.replace(/^file:\/\//u, "").replace(/^~(?=\/)/u, homedir()))
        .pipe(
          Effect.map((f) => f.hash),
          Effect.mapError((reason) => new Rejected({ reason })),
        )
      const image = given === "" ? null : (hashOf(given) ?? (yield* stored))
      yield* brain
        .ingest([
          {
            id: EventId.make(`space.cover_set:${crypto.randomUUID()}`),
            type: SpaceCoverSet.type,
            source: "agent",
            payload: { id: space, image },
          },
        ])
        .pipe(Effect.mapError((e) => new Rejected({ reason: e.reason })))
      return { space, image: image === null ? null : `/blobs/${image}` }
    }),
)

const imageTool = tool(
  "image",
  {
    description:
      'Draw pictures with an image model. `prompt`; `images`, paths or blobs to work from or edit, and a `mask` whose transparent part is what changes in the first; `size` ("1536x1024", or Gemini\'s "1K"/"2K"/"4K") or `aspect` ("16:9"); `quality` (low, medium, high); `n` pictures; `background` transparent; `format` png, jpeg or webp; `model`, a Gateway image model (the profile\'s by default). Returns each file\'s `path`, on this machine, and `blob`, with the `cost` in dollars.',
    input: Schema.Struct({
      prompt: Schema.String,
      images: Schema.optionalKey(Schema.Array(Schema.String)),
      mask: Schema.optionalKey(Schema.String),
      size: Schema.optionalKey(Schema.String),
      aspect: Schema.optionalKey(Schema.String),
      quality: Schema.optionalKey(Schema.String),
      n: Schema.optionalKey(Schema.Int),
      background: Schema.optionalKey(Schema.Literals(["transparent", "opaque", "auto"])),
      format: Schema.optionalKey(Schema.Literals(["png", "jpeg", "webp"])),
      model: Schema.optionalKey(Schema.String),
    }),
  },
  (input) =>
    Effect.gen(function* drawing() {
      const images = yield* Images
      return yield* images
        .draw({ ...input, images: input.images ?? [], n: input.n ?? 1 })
        .pipe(Effect.mapError((reason) => new Rejected({ reason })))
    }),
)

export const autonomyApp = defineApp<Brain | Models | Blobs | Images | DraftCopies>({
  name: "autonomy",
  version: "1",
  instructions:
    "What you say to the user, or nothing; expectations, waiting, surprises, action items, memory, wake rules, your dials, spaces' covers and pictures.",
  tools: [
    sayTool,
    nothingTool,
    expect,
    wait,
    surpriseTool,
    item,
    closeItem,
    followItem,
    rememberTool,
    wakeRuleTool,
    settingTool,
    coverTool,
    imageTool,
  ],
})
