// A running turn, and what Claude Code's output means for it in brain events.
import { EventId, TurnId } from "@switch/brain"
import type { Incoming } from "@switch/brain"

import { blockText } from "./claude.ts"
import type { CliBlock, CliMessage, CliModelUsage } from "./claude.ts"
import { TurnDelta, TurnEnded, TurnResult, TurnText, TurnTool } from "./events.ts"
import type { Thread, TurnEnd, TurnStatus, Usage } from "./events.ts"
import { choosesEnd, commitments, nudge, posted, setsWatch, UNCHOSEN, UNSAID } from "./promised.ts"

const MAX_OUTPUT = 16_000
/** What a turn the user stopped ends on; one cut off from outside records its cutBy instead. */
export const STOPPED = "Stopped"

export interface Running {
  readonly id: TurnId
  readonly thread: Thread
  readonly started: number
  /** Messages sent into the turn: queued until Claude Code starts them. */
  readonly pending: Map<string, "queued" | "started">
  background: number
  /** Of those, the ones that carry the user's words (or pick up a reply owed to them). */
  readonly owed: Set<string>
  /** Whether the step under way answers one of them. */
  answering: boolean
  /** The messages the senses woke it with (Switchboard's wake role). */
  readonly sensed: Set<string>
  /** Whether the step under way is one of those, with no words of the user's in it. */
  woken: boolean
  /** Each answering step's final text, in order: what the user is owed. */
  readonly replies: string[]
  /** Whether its closing words are read for promises (promised.ts): a one-shot run's aren't. */
  promises: boolean
  /** It set something that brings its work back: an expectation, an item, a follow, a task. */
  watched: boolean
  /** What it posted to the user, read with its closing words. */
  readonly said: string[]
  /** What it ended on before its line back, which is what it ends on still. */
  closing: string | null
  /** It made an explicit choice: said something, reacted, put up an item, showed something, or chose nothing. */
  chose: boolean
  /** It was told once to end on a choice; the second time it ends anyway. */
  choiceAsked: boolean
  /** A task's report check is wrong this time, as its report's last line said (`reportBypass`). */
  bypass: string | null
  n: number
  costUsd: number
  usage: Usage
  context: number
  resetAt: number | null
  interrupted: boolean
  /** The model it runs on as its provider reports it, once it has. */
  model: string | null
  /** The model its words are tagged with (`turn.model`), when known. */
  tagged: string | null
  /** What its end records when it was cut off from outside (a restart, its host gone, a limit); null when the user stopped it. */
  cutBy: string | null
  /** Streamed text after its last whitespace, held for the next delta (`absorb`). */
  held: string
}

export const newTurn = (thread: Thread): Running => ({
  id: TurnId.make(crypto.randomUUID()),
  thread,
  started: Date.now(),
  pending: new Map(),
  background: 0,
  owed: new Set(),
  answering: false,
  sensed: new Set(),
  woken: false,
  replies: [],
  promises: true,
  watched: false,
  said: [],
  closing: null,
  chose: false,
  choiceAsked: false,
  bypass: null,
  n: 0,
  costUsd: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  context: thread.context,
  resetAt: null,
  interrupted: false,
  model: null,
  tagged: null,
  cutBy: null,
  held: "",
})

/** Marks a message sent into the turn as the user's words: its step's text is owed to them. */
export const owe = (t: Running, uuid: string) => {
  t.owed.add(uuid)
}

export const event = (id: string, type: string, payload: unknown): Incoming => ({
  id: EventId.make(id),
  type,
  source: "agent",
  payload,
})

export const endOf = (t: Running, status: TurnStatus, result: string): TurnEnd => ({
  thread: t.thread.thread,
  turn: t.id,
  status,
  result,
  replies: status === "done" ? [...t.replies] : [],
  resetAt: status === "limited" ? t.resetAt : null,
  costUsd: t.costUsd,
  usage: t.usage,
  context: t.context,
  ms: Date.now() - t.started,
})

const cap = (s: string) =>
  s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n[${s.length - MAX_OUTPUT} chars cut]` : s

const capInput = (input: unknown) => {
  const json = JSON.stringify(input) ?? "null"
  return json.length > MAX_OUTPUT ? { truncated: cap(json) } : input
}

const addUsage = (u: Usage, m: CliModelUsage): Usage => ({
  input: u.input + m.inputTokens,
  output: u.output + m.outputTokens,
  cacheRead: u.cacheRead + m.cacheReadInputTokens,
  cacheWrite: u.cacheWrite + m.cacheCreationInputTokens,
})

const blocks = (m: CliMessage): readonly CliBlock[] => {
  const content = m.message?.content
  return typeof content === "string" || content === undefined ? [] : content
}

const statusOf = (t: Running, result: CliMessage, said: string): TurnStatus => {
  if (t.interrupted) {
    return "interrupted"
  }
  if (result.is_error !== true) {
    return "done"
  }
  return t.resetAt !== null || /usage limit|limit reached/iu.test(said) ? "limited" : "failed"
}

type Add = (type: string, payload: object) => void

const assistant = (t: Running, m: CliMessage, add: Add) => {
  const u = m.message?.usage
  if (u) {
    t.context =
      (u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0)
  }
  for (const b of blocks(m)) {
    if (b.type === "text" && (b.text ?? "").trim() !== "") {
      add(TurnText.type, { text: b.text })
    } else if (b.type === "tool_use") {
      add(TurnTool.type, { id: b.id ?? "", name: b.name ?? "", input: capInput(b.input) })
      if (setsWatch(b.name ?? "", b.input)) {
        t.watched = true
      }
      const words = posted(b.name ?? "", b.input)
      if (words !== "") {
        t.said.push(words)
      }
      if (choosesEnd(b.name ?? "", b.input)) {
        t.chose = true
      }
    }
  }
}

const toolResults = (m: CliMessage, add: Add) => {
  for (const b of blocks(m)) {
    if (b.type === "tool_result") {
      add(TurnResult.type, {
        id: b.tool_use_id ?? "",
        output: cap(blockText(b.content)),
        error: b.is_error ?? false,
      })
    }
  }
}

const lifecycle = (t: Running, m: CliMessage) => {
  const id = m.command_uuid ?? ""
  // A message's step ends completed, or cancelled (a steer cut it) or discarded (never run).
  if (m.state === "completed" || m.state === "cancelled" || m.state === "discarded") {
    t.pending.delete(id)
  } else if (m.state === "started" && t.pending.has(id)) {
    t.pending.set(id, "started")
    // A steer joins the step under way; a queued message starts its own.
    if (t.owed.has(id)) {
      t.answering = true
    }
    t.woken = !t.answering && t.sensed.has(id)
  }
}

const rateLimit = (t: Running, m: CliMessage) => {
  const info = m.rate_limit_info
  if (info?.status === "rejected" && info.isUsingOverage !== true) {
    t.resetAt = info.resetsAt === undefined ? null : info.resetsAt * 1000
  }
}

/** Whether this result ends the turn. */
const result = (t: Running, m: CliMessage) => {
  for (const u of Object.values(m.model_usage_since_last_result ?? m.modelUsage ?? {})) {
    t.costUsd += u.costUSD
    t.usage = addUsage(t.usage, u)
  }
  // A steer still queued starts a step of its own: the turn goes on.
  const queued = [...t.pending.values()].includes("queued")
  if (t.interrupted) {
    return true
  }
  // A steer ("now") aborts the step under way. Claude Code reports a step cut before the model said
  // anything as an error (error_during_execution, "[ede_diagnostic] result_type=user"), then runs
  // the steer: that is the turn going on, not its failure.
  if (m.is_error === true) {
    return !(queued && cutBySteer(m))
  }
  return t.background === 0 && !queued
}

/** A step Claude Code aborted for a message sent into it, not one that failed. */
const cutBySteer = (m: CliMessage) =>
  m.terminal_reason === "aborted_streaming" || m.terminal_reason === "aborted_tools"

// A result before background work finishes is a pause, not the answer owed to the user.
const reply = (t: Running, m: CliMessage) => {
  if (t.answering && (t.background === 0 || m.is_error === true || t.interrupted)) {
    t.answering = false
    if ((m.result ?? "").trim() !== "" && m.is_error !== true && !t.interrupted) {
      t.replies.push(m.result ?? "")
    }
  }
}

interface Batch {
  ended: CliMessage | null
  step: CliMessage | null
}

/** Its model as the stream says it: the session's at its start, each message's, else the one that did most. */
const learnModel = (t: Running, m: CliMessage) => {
  const said = (m.type === "assistant" ? m.message?.model : m.model) ?? ""
  // Claude Code's own stand-in messages say "<synthetic>".
  if ((m.type === "assistant" || m.type === "system") && said !== "" && !said.startsWith("<")) {
    t.model = said
  } else if (m.type === "result" && t.model === null) {
    const used = Object.entries(m.model_usage_since_last_result ?? m.modelUsage ?? {})
    const [most] = used.toSorted(([, a], [, b]) => b.outputTokens - a.outputTokens)
    if (most) {
      const [id] = most
      if (id !== "default") {
        t.model = id
      }
    }
  }
}

const absorbMessage = (t: Running, m: CliMessage, add: Add, batch: Batch) => {
  learnModel(t, m)
  if (m.type === "assistant") {
    assistant(t, m, add)
  } else if (m.type === "user") {
    toolResults(m, add)
  } else if (m.type === "system" && m.subtype === "background_tasks_changed") {
    if (t.background > 0 || (m.tasks?.length ?? 0) > 0) {
      batch.step = null
    }
    t.background = m.tasks?.length ?? 0
  } else if (m.type === "command_lifecycle") {
    if (m.state === "started" && batch.step) {
      reply(t, batch.step)
      batch.step = null
    }
    lifecycle(t, m)
  } else if (m.type === "rate_limit_event") {
    rateLimit(t, m)
  } else if (m.type === "result") {
    if (batch.step) {
      reply(t, batch.step)
    }
    batch.step = m
    batch.ended = result(t, m) ? m : null
  }
}

/**
 * Ending on a promise of later work with nothing set to bring it back: one line back, once
 * (promised.ts). What it ended on is kept as what it ends on.
 */
const lineBack = (t: Running, ended: CliMessage) => {
  if (!t.promises || t.closing !== null || t.interrupted || ended.is_error === true || t.watched) {
    return null
  }
  const promised = commitments([ended.result ?? "", ...t.said].join("\n"))
  if (promised.length === 0) {
    return null
  }
  t.closing = ended.result ?? ""
  return nudge(promised)
}

/**
 * Ending without an explicit choice: one error back, once; the second time it ends, as Switchboard's
 * gates let a second bounce through so work can't loop (kernels/gates.rs:237-242). A task's report
 * is its choice (its last words go to the work that started it); a one-shot run has none to make.
 */
const choiceBack = (t: Running, ended: CliMessage) => {
  if (
    t.chose ||
    t.choiceAsked ||
    !t.promises ||
    t.thread.parent !== null ||
    t.interrupted ||
    ended.is_error === true
  ) {
    return null
  }
  t.choiceAsked = true
  t.closing ??= ended.result ?? ""
  return t.replies.length > 0 && (ended.result ?? "").trim() !== "" ? UNSAID : UNCHOSEN
}

/** What a turn ended on: its last words, or those before its line back, whose answer is an aside. */
const endedOn = (t: Running, ended: CliMessage) =>
  t.closing !== null && ended.is_error !== true
    ? t.closing
    : (ended.result ?? (ended.errors ?? []).join("\n"))

// A task's report is no tool call: it bypasses the report check (brain's bypass.ts) on a last line
// "bypass: why", taken off what it reports.
const BYPASS_LINE = /(?:^|\n)[ \t>*`"]*bypass:[ \t]*(?<why>[^\n]*?)[`"* \t]*$/iu

/** A report without its bypass line, and the bypass's reason, or null for none. */
export const reportBypass = (text: string) => {
  const found = BYPASS_LINE.exec(text.trimEnd())
  const why = found?.groups?.why?.trim() ?? ""
  return found === null || why === ""
    ? { text, bypass: null }
    : { text: text.trimEnd().slice(0, found.index).trimEnd(), bypass: why }
}

/** A batch of output as brain events, with the turn's end when it ended. */
export const absorb = (t: Running, batch: readonly CliMessage[]) => {
  const drafts: Incoming[] = []
  const add: Add = (type, payload) => {
    drafts.push(event(`${t.id}:${t.n}`, type, { thread: t.thread.thread, turn: t.id, ...payload }))
    t.n += 1
  }
  // Text deltas in a row become one event, ending on whitespace: a word (a key, a token) is never
  // split between two, so each is stored with its secrets redacted whole. The rest waits for the
  // next, or the block's end.
  let delta = t.held
  const flush = (whole: boolean) => {
    const cut = whole ? delta.length : delta.search(/\S*$/u)
    if (cut > 0) {
      add(TurnDelta.type, { text: delta.slice(0, cut) })
      delta = delta.slice(cut)
    }
  }
  const state: Batch = { ended: null, step: null }
  for (const m of batch) {
    const own = (m.parent_tool_use_id ?? null) === null
    if (m.type === "stream_event") {
      if (own && m.event?.delta?.type === "text_delta") {
        delta += m.event.delta.text ?? ""
      }
    } else if (own) {
      flush(true)
      absorbMessage(t, m, add, state)
    }
  }
  flush(false)
  t.held = delta
  const { ended, step } = state
  if (step) {
    reply(t, step)
  }
  if (ended === null || (t.background > 0 && !t.interrupted && ended.is_error !== true)) {
    return { drafts, end: null, nudge: null }
  }
  const back = lineBack(t, ended) ?? choiceBack(t, ended)
  if (back !== null) {
    return { drafts, end: null, nudge: back }
  }
  const reported =
    t.thread.parent === null
      ? { text: endedOn(t, ended), bypass: null }
      : reportBypass(endedOn(t, ended))
  t.bypass = reported.bypass
  const said = reported.text
  const status = statusOf(t, ended, said)
  // An interrupted turn's result is Claude Code's diagnostics: it records who ended it instead.
  const end = endOf(t, status, status === "interrupted" ? (t.cutBy ?? STOPPED) : said)
  add(TurnEnded.type, end)
  return { drafts, end, nudge: null }
}
