// What becomes of an action item once it leaves the queue, and the outbound gate.
//
// - Whoever waits on an item hears how it closed: its space's thread (and the spaces following it)
//   wakes when the user answers, does, dismisses or reopens it, it closes itself, or the agent's work
//   in another thread or space closes it (the work that closed it isn't told); the extension that
//   raised one is called at its `answerTo` tool. An approved item's `send` runs here, with the
//   drafts as the user left them, and its result is recorded (`item.ran`). Both wait for their
//   app to connect first (`reach`), so one approved as the core restarts runs once it's back.
// - The outbound gate (Switchboard's, with its thresholds): an agent's or an extension's call to a
// tool
//   marked `speaksForPerson` (a text, an email, an order in the user's name) is read against the
//   newest plan, privacy and each of the user's rules that bear on it. One that doesn't pass goes
//   back with the reasons. One that passes goes out without an extra approval hold. One sent again
//   with `bypass` (brain's bypass.ts) never goes out on it. Past what only the user can settle
//   (gate.ts `theirs`), the user, Nov 23, agreed it "becomes an approval card for him", whose drafts
//   are its words, titled from what it sends, and Approve sends it as edited; past anything else
//   it goes back to the agent to fix (gate.ts, the user Nov 24). A read-only core sends nothing.
// - A send goes once. Each that went out past the gate is recorded (`outbound.sent`), and it, or
//   an approved item's send that ran, closes every open item that would send the same (its `key`,
//   which a send never goes twice by, its draft, or the same words to the same place) as resolved;
//   the user, Nov 24, on a held reply still in his queue after the agent had sent it another way.
//   Approving one whose send went out already sends nothing.
// - Sealed answers: POST /items/<id>/sealed carries `{enc, ct}`, what the user's client sealed to
//   the item's one-time key (switch-ext-kit/sealed). It goes straight to the raising extension's `answerTo`
//   tool as `{item, use, enc, ct}` and is never stored or logged; the brain records only that the
//   item was answered (`item.answered` with `sealed: true`).
import type { Database } from "bun:sqlite"
import { Sessions } from "@switch/agent"
import {
  ago,
  AnswerItem,
  changesLine,
  CloseItem,
  DraftCopies,
  gate,
  getItem,
  ItemAnswered,
  ItemClosed,
  ItemEdited,
  ItemRan,
  ItemReopened,
  ItemSending,
  ItemTold,
  ItemRevised,
  items,
  OpenItem,
  placeOf,
  rulesFor,
} from "@switch/autonomy"
import type { ActionItem, Answer, Verdict } from "@switch/autonomy"
import {
  Brain,
  defineEvent,
  defineRead,
  EventId,
  HOME,
  ItemId,
  react,
  redactValue,
  saidBy,
  SpaceId,
  spaceMessages,
  stringsIn,
  ThreadId,
} from "@switch/brain"
import type { StoredEvent } from "@switch/brain"
import { Gateway } from "@switch/gateway"
import type { Guard, Outbound, Sent } from "@switch/gateway"
import { Models } from "@switch/models"
import { Effect, FiberSet, Layer, Option, Schedule, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { CallToolResult } from "@modelcontextprotocol/server"

import { CoreConfig } from "./config.ts"
import { troubled } from "./trouble.ts"
import { threadOf } from "./context.ts"

// ——— The outbound gate ———

/** Args as one string, keys in order, so the same call reads the same. */
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) {
    return `[${v.map(canonical).join(",")}]`
  }
  if (typeof v === "object" && v !== null) {
    const entries = Object.entries(v).toSorted(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`
  }
  return JSON.stringify(v)
}

/** Words the user would edit: prose, not ids or numbers. */
const isWords = (v: unknown): v is string => typeof v === "string" && /\s/u.test(v.trim())

const DRAFT = /\{\{draft:(?<name>[^}]+)\}\}/gu

/** `{{draft:name}}` in any string arg, as the user approved that draft. */
const withDrafts = (v: unknown, drafts: Readonly<Record<string, string>>): unknown => {
  if (typeof v === "string") {
    return v.replaceAll(DRAFT, (whole, name: string) => drafts[name] ?? whole)
  }
  if (Array.isArray(v)) {
    return v.map((x) => withDrafts(x, drafts))
  }
  if (typeof v === "object" && v !== null) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withDrafts(x, drafts)]))
  }
  return v
}

/** The args an approved item sends: its own with each draft as the user left it. */
export const finalArgs = (item: ActionItem, answer: Answer | null): Record<string, unknown> => {
  const drafts = Object.fromEntries((item.drafts ?? []).map((d) => [d.name, d.text]))
  const approved = { ...drafts, ...answer?.drafts }
  return Object.fromEntries(
    Object.entries(item.send?.args ?? {}).map(([k, v]) => [k, withDrafts(v, approved)]),
  )
}

const said = (text: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text }],
  ...(isError && { isError: true }),
})

const DAY = 24 * 3600 * 1000

interface Call {
  readonly app: string
  readonly tool: string
  readonly args: Readonly<Record<string, unknown>>
}

/** What a send goes once by: its `key` (an extension never sends twice by one), or its draft. */
const ONCE_BY = ["key", "draft"] as const

const withoutKey = (args: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(args).filter(([k]) => k !== "key"))

/** Whether two calls send the same: by what a send goes once by, or the same words to the same place. */
const sameSend = (a: Call, b: Call) =>
  a.app === b.app &&
  a.tool === b.tool &&
  (ONCE_BY.some((k) => typeof a.args[k] === "string" && a.args[k] === b.args[k]) ||
    canonical(withoutKey(a.args)) === canonical(withoutKey(b.args)))

/** What an item sends, as its drafts stand now. */
const sendOf = (i: ActionItem): Call | null =>
  i.send ? { app: i.send.app, tool: i.send.tool, args: finalArgs(i, i.answer) } : null

/** A call in the user's name that went out past the gate: an agent's, or an extension's. */
export const OutboundSent = defineEvent(
  "outbound.sent",
  1,
  Schema.Struct({
    app: Schema.String,
    tool: Schema.String,
    args: Schema.Record(Schema.String, Schema.Unknown),
    output: Schema.String,
    /** The agent's work that sent it, which knows. */
    thread: Schema.optionalKey(ThreadId),
  }),
)

export const asksConfig = { events: [OutboundSent], projections: [], commands: [] }

const decodeSent = Schema.decodeUnknownOption(OutboundSent.payload)

/** What came back when the same send went out in the day before, else null. */
const wentOut = (db: Database, call: Call, except: ItemId, now: number) => {
  const sent = db
    .query<{ payload: string }, [string, number]>(
      "SELECT payload FROM events WHERE type = ? AND time > ? ORDER BY seq DESC",
    )
    .all(OutboundSent.type, now - DAY)
    .flatMap((r) => Option.toArray(decodeSent(JSON.parse(r.payload))))
    .find((s) => sameSend(s, call))
  if (sent) {
    return sent.output
  }
  const approved = items(db).find((i) => {
    const other = sendOf(i)
    return (
      i.id !== except &&
      i.ran?.ok === true &&
      (i.closedAt ?? 0) > now - DAY &&
      other !== null &&
      sameSend(other, call)
    )
  })
  return approved?.ran?.output ?? null
}

/** The item that holds or held this very call, if one does. */
const holding = (db: Database, call: Outbound) => {
  const want = canonical(call.args)
  return items(db).find(
    (i) =>
      i.send?.app === call.app &&
      i.send.tool === call.tool &&
      (i.status === "open" || (i.closedAt ?? 0) > Date.now() - DAY) &&
      (canonical(i.send.args) === want || canonical(finalArgs(i, i.answer)) === want),
  )
}

/**
 * What the user approved on their cards in a space in the day before, word for word (Switchboard's
 * `approved`), each with when, and said to be for that one send. Without it, two approvals of the
 * old lead-form first reply ("What are you looking to get printed?") read as the newest plan and
 * refused the template the user approved in the chat hours after (Nov 24: plan at 0.72; 0.12
 * with this wording, while the same reply with another delivery time still read as 1).
 */
const approvedIn = (db: Database, space: SpaceId, now: number) => {
  const cards = items(db)
    .filter(
      (i) =>
        i.space === space &&
        i.kind === "approval" &&
        i.answer?.approved === true &&
        (i.closedAt ?? 0) > now - DAY,
    )
    .toSorted((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
    .slice(0, 3)
    .map((i) => {
      const approvedWords = Object.values({
        ...Object.fromEntries((i.drafts ?? []).map((d) => [d.name, d.text])),
        ...i.answer?.drafts,
      })
      const head = `- ${i.title} (approved ${ago(i.closedAt ?? now, now)})`
      return approvedWords.length === 0
        ? `${head}\n${i.body}`
        : `${head}\n  Approved, word for word: ${approvedWords.join(" / ")}`
    })
  return cards.length === 0
    ? ""
    : `What the user approved on their cards here in the last day, each for that one send (sending it is what they approved; it isn't a plan for what goes to anyone else):\n${cards.join("\n")}\n\n`
}

// ——— The reads (reads.ts), run in a reader thread ———

/** What the gate weighs a call by: its space, the item that holds it, the space's words and rules. */
const gateRead = defineRead("core/asks/gate", (db, call: Outbound, now: number) => {
  const s = call.thread === null ? HOME : SpaceId.make(placeOf(db, call.thread).space)
  const text = JSON.stringify(call.args)
  return {
    space: s,
    held: holding(db, call) ?? null,
    context: spaceMessages(db, s, 10)
      .map((m) => `${saidBy(m, "Switch", "User")}: ${m.text.slice(0, 600)}`)
      .join("\n"),
    rules: rulesFor(db, s, text, 6),
    approved: approvedIn(db, s, now),
  }
})

/** An item by id, else null. */
const itemRead = defineRead("core/asks/item", (db, id: string) => getItem(db, id))

/** Whether an item already ran, and whether a send of it was under way as the core stopped. */
const sendStateRead = defineRead("core/asks/send-state", (db, id: ItemId) => ({
  ran: getItem(db, id)?.ran ?? null,
  sending: db.query("SELECT 1 FROM events WHERE id = ?").get(`sending:${id}`) !== null,
}))

/** What came back when the same send went out in the day before, else null. */
const wentOutRead = defineRead(
  "core/asks/went-out",
  (db, call: Call, except: ItemId, now: number) => wentOut(db, call, except, now),
)

/** The open items, but `except`, that would send the same as `call`. */
const sameOpenRead = defineRead(
  "core/asks/same-open",
  (db, call: Call, except: ItemId | undefined) =>
    items(db, { status: "open" }).filter((i) => {
      const other = sendOf(i)
      return i.id !== except && other !== null && sameSend(other, call)
    }),
)

/** The open items with a draft's copy to keep in step. */
const copiedOpenRead = defineRead("core/asks/copied-open", (db) =>
  items(db, { status: "open" }).filter((i) => (i.drafts ?? []).some((d) => d.copy)),
)

// The card a held send is in the user's queue: its title and line written from what it sends, as
// Switchboard titled an ask (monologue notify.rs `TITLE`), never the tool, its fields or the check's
// note to the agent.
const CARD =
  'Write the card for something the user is asked to approve before it goes out in their name, as it shows in their queue. First line: its title, read at a glance, at most 40 characters, a few plain words saying what goes to whom, like "Email the quote to the new lead" or "Text the pickup time to the buyer". Second line: who it goes to and how (an email to …, a text to …), and when another agent asked for it, which one. Plain words only: no tool or field names, ids, keys or accounts, no markdown, no quotes. Reply with the two lines alone.'

/** The guard the gateway asks before an agent's call that speaks for the user. */
export const outboundGuard = Effect.gen(function* guarding() {
  const brain = yield* Brain
  const models = yield* Models
  const sessions = yield* Sessions
  const { readOnly } = yield* CoreConfig
  const run = yield* FiberSet.makeRuntimePromise()

  /**
   * A send that holds a secret goes nowhere, never with it blanked: the caller hears what it held,
   * by name, and an extension's call (no turn hears its answer) wakes the agent.
   */
  const secretHeld = (call: Outbound) =>
    Effect.gen(function* holdingSecret() {
      const found: string[] = []
      redactValue(call.args, found)
      if (found.length === 0) {
        return null
      }
      const names = [...new Set(found)].map((f) => `[${f}]`).join(", ")
      if (call.thread === null) {
        yield* troubled({
          id: `secret-send:${call.app}:${call.tool}`,
          space: HOME,
          text: `${call.app} ${call.tool} wasn't sent: it held ${names}.`,
        }).pipe(Effect.provideService(Sessions, sessions))
      }
      return said(
        `Not sent: it holds ${names}. A secret never goes out in a message, a post or an email. Take it out, or ask the user how it should reach its reader.`,
        true,
      )
    })

  /** Holds the call as an approval item, its words as drafts the user can edit; its id. */
  const hold = (call: Outbound, space: SpaceId, verdict: Verdict) =>
    Effect.gen(function* holdingIt() {
      const entries = Object.entries(call.args)
      const drafts = entries
        .filter(([, v]) => isWords(v))
        .map(([name, v]) => ({ name, label: name, text: String(v) }))
      const drafted = new Set(drafts.map((d) => d.name))
      const args = Object.fromEntries(
        entries.map(([k, v]) => [k, drafted.has(k) ? `{{draft:${k}}}` : v]),
      )
      const rest = entries
        .filter(([k]) => !drafted.has(k))
        .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
      const asked = [
        `${call.app} ${call.tool}`,
        ...rest,
        ...drafts.map((d) => `${d.name}: ${d.text.slice(0, 600)}`),
        ...(call.bypass === null ? [] : [`Why it's held: ${call.bypass}`]),
      ].join("\n")
      const [title = "", line = ""] = yield* models.complete("triage", CARD, asked).pipe(
        Effect.map((d) =>
          d.text
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l !== ""),
        ),
        Effect.orElseSucceed(() => []),
      )
      const id = ItemId.make(`o-${crypto.randomUUID().slice(0, 10)}`)
      yield* brain.dispatch({
        id: crypto.randomUUID(),
        type: OpenItem.type,
        source: "agent",
        payload: {
          id,
          space,
          title: tidyTitle(title) || tidyTitle(drafts[0]?.text ?? "") || "Approve",
          body: line.replaceAll(/^["'*“”`]+|["'*“”`]+$/gu, "").trim(),
          decision: verdict.decision,
          kind: "approval",
          send: { app: call.app, tool: call.tool, args },
          ...(drafts.length > 0 && { drafts }),
        } satisfies typeof OpenItem.payload.Type,
      })
      return id
    })

  const check = (call: Outbound) =>
    Effect.gen(function* checking() {
      const secret = yield* secretHeld(call)
      if (secret !== null) {
        return secret
      }
      if (readOnly) {
        return said("Not sent: Switch is read-only and sends nothing", true)
      }
      const { space, held, context, rules, approved } = yield* brain.read(
        gateRead,
        call,
        Date.now(),
      )
      if (held?.status === "open") {
        return said(
          `Not sent: it's waiting on the user's approval as item ${held.id}. This space wakes when they answer.`,
        )
      }
      if (held?.ran?.ok === true) {
        return said(`Already sent on the user's approval (item ${held.id}): ${held.ran.output}`)
      }
      const verdict = yield* gate("outbound", {
        key: `outbound:${call.app}:${call.tool}:${space}`,
        space,
        text: `${call.app} ${call.tool}\n${JSON.stringify(call.args, null, 1).slice(0, 4000)}`,
        context: [approved, context === "" ? "" : `The conversation so far:\n${context}`].join(""),
        own: stringsIn(call.args),
        rules,
        approved,
        ...(call.bypass !== null && { bypass: call.bypass }),
        work: call.thread ?? space,
      })
      if (!verdict.pass) {
        return said(
          `Not sent. Before this goes out in the user's name: ${verdict.reasons.join(" ")} Fix it, or what it rests on when that's what's out of date, and call again.`,
          true,
        )
      }
      if (!verdict.bypassed) {
        return null
      }
      const id = yield* hold(call, space, verdict)
      return said(
        `Not sent: it's held for the user's approval as item ${id}, its words as drafts they can edit. When they approve, it's sent as they leave it and this space wakes with the result. Don't send it yourself.`,
      )
    }).pipe(
      Effect.provideService(Brain, brain),
      Effect.provideService(Models, models),
      // A guard that fails holds nothing back but sends nothing either.
      Effect.match({
        onFailure: (failure: unknown) => said(`Not sent: ${String(failure)}`, true),
        onSuccess: (result) => result,
      }),
    )

  const guard: Guard = async (call) => await run(check(call))
  return guard
})

/** What the gateway tells once a call the guard let through went out: it's recorded. */
export const outboundSent = Effect.gen(function* recording() {
  const brain = yield* Brain
  const run = yield* FiberSet.makeRuntimePromise()
  const sent: Sent = async (call, result) => {
    await run(
      Effect.ignore(
        brain.ingest([
          {
            id: EventId.make(`sent:${crypto.randomUUID()}`),
            type: OutboundSent.type,
            source: "core",
            payload: {
              app: call.app,
              tool: call.tool,
              args: call.args,
              output: outputText(result),
              ...(call.thread !== null && { thread: ThreadId.make(call.thread) }),
            } satisfies typeof OutboundSent.payload.Type,
          },
        ]),
        { log: "Warn" },
      ),
    )
  }
  return sent
})

// ——— Hearing how it closed ———

const decodeAnswered = Schema.decodeUnknownOption(ItemAnswered.payload)
const decodeRan = Schema.decodeUnknownOption(ItemRan.payload)
const decodeClosed = Schema.decodeUnknownOption(ItemClosed.payload)
const decodeReopened = Schema.decodeUnknownOption(ItemReopened.payload)

const quote = (i: ActionItem) => `"${i.title}" (${i.id})`

/** What they changed in each draft they edited, as the sentences they cut and wrote (asks.rs `closed_with`). */
const draftChanges = (i: ActionItem, a: Answer) => {
  const changes = (a.edited ?? []).flatMap((name) => {
    const before = i.drafts?.find((d) => d.name === name)?.text
    const after = a.drafts?.[name]
    return before === undefined || after === undefined ? [] : [changesLine(name, before, after)]
  })
  return changes.length === 0
    ? ""
    : `\nWhat they changed in the drafts before approving:${changes.map((c) => `\n- ${c}`).join("")}`
}

const answerLine = (i: ActionItem, a: Answer) => {
  if (a.sealed === true) {
    return `The user answered ${quote(i)}; it went sealed to ${i.app ?? "its extension"}.`
  }
  if (a.approved === false) {
    return `The user declined ${quote(i)}.`
  }
  const edited = draftChanges(i, a)
  const drafts = Object.entries(a.drafts ?? {})
    .map(([name, text]) => `\n${name}: ${text}`)
    .join("")
  if (a.approved === true) {
    return `The user approved ${quote(i)}.\n${i.body}${edited}${drafts}`
  }
  const parts = [a.choice, a.text].filter((x) => x !== undefined && x !== "")
  return `The user answered ${quote(i)}: ${parts.join(". ")}${edited}${drafts}`
}

const closedLine = (i: ActionItem, status: string, why: string | undefined, source: string) => {
  if (status === "resolved") {
    return `${quote(i)} closed itself: ${why ?? i.resolveWhen ?? ""}`
  }
  const who = source === "agent" ? "You" : "The user"
  const because = source === "agent" && why !== undefined && why !== "" ? `: ${why}` : "."
  return `${who} ${status === "done" ? "marked" : "dismissed"} ${quote(i)}${status === "done" ? " done" : ""}${because}`
}

const ranLine = (ok: boolean, output: string) =>
  ok ? `\nSent: ${output}` : `\nSending it failed: ${output}`

const outputText = (r: CallToolResult) =>
  r.content
    .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
    .join("\n")
    .slice(0, 2000)

export const asksWorker = Layer.effectDiscard(
  Effect.gen(function* listening() {
    const brain = yield* Brain
    const sessions = yield* Sessions
    const gateway = yield* Gateway
    const copies = yield* DraftCopies
    const { readOnly } = yield* CoreConfig

    // Each wake's id is the event's, so one read again after a restart wakes no one twice.
    // All but the work that did it (Switchboard's core/watches.rs:362-381).
    const wake = (e: StoredEvent, i: ActionItem, text: string, by?: ThreadId) =>
      Effect.forEach(
        [...new Set([...(i.app === undefined ? [i.space] : []), ...i.followers])].filter(
          (space) => threadOf(space) !== by,
        ),
        (space) =>
          Effect.ignore(
            sessions.wake(threadOf(space), text, "steer", `asks:${String(e.seq)}:${space}`),
            { log: "Warn" },
          ),
        { discard: true },
      )

    // Recorded first, by an id derived from the event that closed it; the extension runs its tool
    // once per id (switch-ext-kit's ONCE), so a replay after a restart doesn't act twice.
    const callExtension = (e: StoredEvent, i: ActionItem, args: Record<string, unknown>) =>
      Effect.gen(function* telling() {
        if (i.app === undefined || i.answerTo === undefined) {
          return
        }
        const delivery = `${i.id}:${String(e.seq)}`
        yield* Effect.orDie(
          brain.ingest([
            {
              id: EventId.make(`told:${delivery}`),
              type: ItemTold.type,
              source: "core",
              payload: { id: i.id, delivery },
            },
          ]),
        )
        const { app } = i
        const tool = `${app}_${i.answerTo}`
        yield* Effect.promise(async () => {
          await gateway.reach(app)
        })
        yield* Effect.ignore(
          Effect.tryPromise(async () => await gateway.call(tool, args, delivery)),
          { log: "Warn" },
        )
      })

    const ran = (i: ActionItem, ok: boolean, output: string) =>
      Effect.ignore(
        brain.ingest([
          {
            id: EventId.make(`ran:${i.id}`),
            type: ItemRan.type,
            source: "core",
            payload: { id: i.id, ok, output },
          },
        ]),
      )

    /**
     * Runs an approved item's `send` once and records what came of it. Read again after a restart,
     * one that ran says how; one that was going out as the core stopped isn't sent again, as it may
     * have gone, and its space hears so.
     */
    const send = (i: ActionItem, a: Answer) =>
      Effect.gen(function* sending() {
        if (!i.send) {
          return ""
        }
        if (readOnly) {
          return "\nNot sent: Switch is read-only."
        }
        const was = yield* brain.read(sendStateRead, i.id)
        if (was.ran !== null) {
          return ranLine(was.ran.ok, was.ran.output)
        }
        if (was.sending) {
          const output =
            "Switch restarted while sending it, so whether it went is unknown. Check before sending it again."
          yield* ran(i, false, output)
          return ranLine(false, output)
        }
        const call = { app: i.send.app, tool: i.send.tool, args: finalArgs(i, a) }
        const went = yield* brain.read(wentOutRead, call, i.id, Date.now())
        if (went !== null) {
          const output = `Not sent again: it went out already. ${went}`
          yield* ran(i, true, output)
          return `\n${output}`
        }
        // Its app first, before it's marked going out: approved as the core restarted, it waits for
        // the extension to connect again; a restart meanwhile reads the answer again from the cursor.
        const { app } = i.send
        yield* Effect.promise(async () => {
          await gateway.reach(app)
        })
        yield* Effect.orDie(
          brain.ingest([
            {
              id: EventId.make(`sending:${i.id}`),
              type: ItemSending.type,
              source: "core",
              payload: { id: i.id },
            },
          ]),
        )
        // Its app was reached above: a call that breaks off now may have gone through all the same.
        const result = yield* Effect.tryPromise(
          async () => await gateway.callApproved(`${i.send?.app}_${i.send?.tool}`, finalArgs(i, a)),
        ).pipe(
          Effect.orElseSucceed(() =>
            said(
              "The call broke off before it answered, so whether it went is unknown. Check before sending it again.",
              true,
            ),
          ),
        )
        const ok = result.isError !== true
        const output = outputText(result)
        yield* ran(i, ok, output)
        return ranLine(ok, output)
      })

    /** Every other open item that would send what just went out closes itself. */
    const wentElsewise = (
      e: StoredEvent,
      call: Call,
      output: string,
      by?: ThreadId,
      except?: ItemId,
    ) =>
      Effect.gen(function* closing() {
        const same = yield* brain.read(sameOpenRead, call, except)
        yield* Effect.forEach(
          same,
          (i) =>
            brain
              .dispatch({
                id: `went:${i.id}:${String(e.seq)}`,
                type: CloseItem.type,
                source: "core",
                payload: {
                  id: i.id,
                  status: "resolved",
                  why: `It went out already: ${output}`,
                  ...(by !== undefined && { thread: by }),
                },
              })
              .pipe(Effect.catchTag("Rejected", (r) => Effect.logWarning(r.reason))),
          { discard: true },
        )
      })

    /** A send that went out, past the gate or on an approval: the items that would send it again close. */
    const went = (e: StoredEvent) =>
      Effect.gen(function* sentOnce() {
        if (e.type === OutboundSent.type) {
          const s = Option.getOrNull(decodeSent(e.payload))
          if (s !== null) {
            yield* wentElsewise(e, s, s.output, s.thread)
          }
          return
        }
        const r = Option.getOrNull(decodeRan(e.payload))
        const i = r?.ok === true ? yield* brain.read(itemRead, r.id) : null
        const call = i === null ? null : sendOf(i)
        if (r !== null && i !== null && call !== null) {
          yield* wentElsewise(e, call, r.output, undefined, i.id)
        }
      })

    const heard = (e: StoredEvent) =>
      Effect.gen(function* one() {
        if (e.type === ItemAnswered.type) {
          const given = Option.getOrNull(decodeAnswered(e.payload))
          const i = given === null ? null : yield* brain.read(itemRead, given.id)
          if (given === null || i === null) {
            return
          }
          // Their drafts as they left them, on the card or in a draft's copy.
          const a = yield* copies.approved(i, given)
          const sent = a.approved === true ? yield* send(i, a) : ""
          if (a.sealed !== true) {
            yield* callExtension(e, i, { item: i.id, status: "answered", answer: a })
          }
          yield* wake(e, i, `${answerLine(i, a)}${sent}`)
          return
        }
        if (e.type === ItemClosed.type) {
          const c = Option.getOrNull(decodeClosed(e.payload))
          const i = c === null ? null : yield* brain.read(itemRead, c.id)
          if (c === null || i === null) {
            return
          }
          yield* callExtension(e, i, { item: i.id, status: c.status })
          yield* wake(e, i, closedLine(i, c.status, c.why, e.source), c.thread)
          return
        }
        // His edit on a card, or the agent's revision: a draft's copy takes it.
        if ((e.type === ItemEdited.type && !isCopied(e.payload)) || e.type === ItemRevised.type) {
          const id = Option.getOrNull(decodeId(e.payload))?.id
          if (id !== undefined) {
            yield* copies.sync(id)
          }
          return
        }
        if (e.type === ItemReopened.type) {
          const r = Option.getOrNull(decodeReopened(e.payload))
          const i = r === null ? null : yield* brain.read(itemRead, r.id)
          if (i !== null) {
            yield* wake(e, i, `The user reopened ${quote(i)}.`)
          }
        }
      })

    // From its cursor: an answer that came as the core stopped is sent and heard once it's back.
    yield* Effect.forkScoped(
      react(
        "asks",
        (e) => e.type.startsWith("item.") || e.type === OutboundSent.type,
        (e) => (e.type === OutboundSent.type || e.type === ItemRan.type ? went(e) : heard(e)),
      ),
    )

    // His edits in a draft's copy come to its open card.
    yield* Effect.forkScoped(
      Effect.gen(function* syncing() {
        const open = yield* brain.read(copiedOpenRead)
        yield* Effect.forEach(open, (i) => copies.sync(i.id), { discard: true })
      }).pipe(Effect.repeat(Schedule.spaced("1 minute"))),
    )
  }),
)

const decodeId = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }))
const isCopied = (payload: unknown) =>
  Option.getOrNull(Schema.decodeUnknownOption(ItemEdited.payload)(payload))?.copy === true

// ——— An app's own asks ———

// A Switchboard appendage's ask, as its shim carries it (switch-ext-kit/shim). There it was a card
// in the user's queue like any other (docs.md, Asks); here it opens one as the app's, once.
const Asked = Schema.Struct({
  kind: Schema.Literal("ask"),
  stream: Schema.Literal("asks"),
  data: Schema.Struct({
    type: Schema.optionalKey(Schema.String),
    title: Schema.optionalKey(Schema.String),
    text: Schema.optionalKey(Schema.String),
    options: Schema.optionalKey(Schema.Array(Schema.String)),
    assists: Schema.optionalKey(
      Schema.Array(Schema.Struct({ label: Schema.String, url: Schema.optionalKey(Schema.String) })),
    ),
    resolve_when: Schema.optionalKey(Schema.String),
    notify: Schema.optionalKey(Schema.Boolean),
  }),
  about: Schema.optionalKey(Schema.Array(Schema.String)),
})
const decodeAsked = Schema.decodeUnknownOption(Asked)

/** An app's ask; what came over from Switchboard's own log was in its queue there already. */
const askOf = (e: StoredEvent) =>
  e.source.startsWith("sb:") ? null : Option.getOrNull(decodeAsked(e.payload))

/** The space an appendage's `ws:<slug>` names, if it's one of the user's; else Home. */
export const spaceAbout = (db: Database, about: readonly string[]) => {
  const named = about.flatMap((a) => (a.startsWith("ws:") ? [a.slice(3)] : []))
  const found = named.find((id) => db.query("SELECT 1 FROM spaces WHERE id = ?").get(id) !== null)
  return found === undefined ? HOME : SpaceId.make(found)
}

/** The space an appendage's `ws:<slug>` names, if it's one of the user's; else Home. */
export const spaceAboutRead = defineRead("core/asks/space-about", (db, about: readonly string[]) =>
  spaceAbout(db, about),
)

// Switchboard titled an ask that came without one (monologue notify.rs `TITLE`, `tidy_title`).
const TITLE =
  'Write the title of this item in the user\'s queue: what shows on its one line, read at a glance. At most 40 characters, a few plain words saying who and what they\'re asked to do or decide, like "Approve the bulk pricing", "Print the chair glides" or "Scan your ID". Names and codes over generic words; no markdown, no quotes, no full stop. Reply with the title alone.'

const tidyTitle = (reply: string) => {
  const line = reply
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "")
  const tidy = (line ?? "")
    .replace(/^Title:/u, "")
    .trim()
    .replaceAll(/^["'*“”`]+|["'*“”`]+$/gu, "")
    .trim()
    .replace(/\.$/u, "")
    .trim()
  return tidy.length > 48 ? `${tidy.slice(0, 47)}…` : tidy
}

const KINDS = ["task", "question", "approval"] as const

export const appAsks = Layer.effectDiscard(
  Effect.gen(function* asking() {
    const brain = yield* Brain
    const models = yield* Models

    const open = (e: StoredEvent) =>
      Effect.gen(function* opening() {
        const asked = askOf(e)
        const text = asked?.data.text?.trim() ?? ""
        if (asked === null || text === "") {
          return
        }
        // A resend is the same card.
        const id = ItemId.make(`${e.source}-${e.id}`)
        if ((yield* brain.read(itemRead, id)) !== null) {
          return
        }
        const { data } = asked
        const kind = KINDS.find((k) => k === data.type) ?? "task"
        const written = yield* models
          .complete("triage", TITLE, `A ${kind}:\n${text.slice(0, 1200)}`)
          .pipe(
            Effect.map((d) => tidyTitle(d.text)),
            Effect.orElseSucceed(() => ""),
          )
        const title = (data.title?.trim() ?? written) || tidyTitle(text)
        const links = (data.assists ?? []).flatMap((a) =>
          a.url !== undefined && /^https?:\/\//u.test(a.url)
            ? [{ label: a.label, url: a.url }]
            : [],
        )
        const space = yield* brain.read(spaceAboutRead, asked.about ?? [])
        yield* brain.dispatch({
          id: `ask:${e.id}`,
          type: OpenItem.type,
          source: e.source,
          payload: {
            id,
            space,
            title,
            body: text,
            decision: e.source,
            app: e.source,
            kind,
            ...(data.options !== undefined && { options: data.options }),
            ...(links.length > 0 && { links }),
            ...(data.resolve_when !== undefined && { resolveWhen: data.resolve_when }),
            ...(data.notify === false && { notify: false }),
          } satisfies typeof OpenItem.payload.Type,
        })
      })

    // From its cursor: an ask whose title was being written as the core stopped opens once it's back.
    yield* Effect.forkScoped(react("app-asks", (e) => askOf(e) !== null, open))
  }),
)

// ——— Sealed answers ———

const sealedBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      enc: Schema.String.check(Schema.isMaxLength(256)),
      ct: Schema.String.check(Schema.isMaxLength(16_384)),
    }),
  ),
)

const CORS = { "Access-Control-Allow-Origin": "*" }

/** POST /items/:id/sealed: a sealed answer, straight to its extension, then only its record. */
export const sealedRoute = HttpRouter.add(
  "POST",
  "/items/:id/sealed",
  Effect.gen(function* sealing() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const brain = yield* Brain
    const gateway = yield* Gateway
    const id = new URL(request.url, "http://core").pathname.split("/")[2] ?? ""
    const body = sealedBody(yield* Effect.orElseSucceed(request.text, () => ""))
    const i = yield* brain.read(itemRead, decodeURIComponent(id))
    const refuse = (text: string, status: number) =>
      HttpServerResponse.text(text, { status, headers: CORS })
    if (Option.isNone(body)) {
      return refuse("Not a sealed answer", 400)
    }
    if (
      i?.status !== "open" ||
      i.kind !== "sealed" ||
      i.sealed === undefined ||
      i.app === undefined ||
      i.answerTo === undefined
    ) {
      return refuse(i ? "It isn't waiting on a sealed answer" : "No such item", 404)
    }
    const result = yield* Effect.tryPromise(
      async () =>
        await gateway.call(`${i.app}_${i.answerTo}`, {
          item: i.id,
          use: i.sealed?.use,
          enc: body.value.enc,
          ct: body.value.ct,
        }),
    ).pipe(Effect.orElseSucceed(() => said(`Can't reach ${i.app ?? "its extension"}`, true)))
    if (result.isError === true) {
      return refuse(outputText(result), 422)
    }
    if (i.completion === "owner") {
      const verified = Schema.decodeUnknownOption(
        Schema.Struct({ connected: Schema.Literal(true) }),
      )(result.structuredContent)
      if (Option.isNone(verified)) {
        return refuse("Sign-in is not verified", 422)
      }
      return HttpServerResponse.text("Verified", { headers: CORS })
    }
    yield* Effect.ignore(
      brain.dispatch({
        id: `sealed:${i.id}`,
        type: AnswerItem.type,
        source: "core",
        payload: { id: i.id, sealed: true },
      }),
    )
    return HttpServerResponse.text("Sent", { headers: CORS })
  }),
)

/** POST /items/:id/drafts: its card opened, so each draft's copy and the card come to one version. */
export const draftsRoute = HttpRouter.add(
  "POST",
  "/items/:id/drafts",
  Effect.gen(function* opening() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const copies = yield* DraftCopies
    const id = new URL(request.url, "http://core").pathname.split("/")[2] ?? ""
    yield* copies.sync(decodeURIComponent(id))
    return HttpServerResponse.text("Synced", { headers: CORS })
  }),
)
