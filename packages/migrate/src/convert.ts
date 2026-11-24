// One Switchboard record into the Switch events it becomes. A chat work's turns run in its space's
// master thread; a task, wake or goal is a thread of its own under the thread that started it.
// Ids are Switchboard's (`sb:<id>`), so a record brought in twice lands once.
import type { Database } from "bun:sqlite"
import { homedir } from "node:os"
import {
  TaskEnded,
  ThreadOpened,
  TurnEnded,
  TurnInjected,
  TurnResult,
  TurnStarted,
  TurnText,
  TurnTool,
} from "@switch/agent"
import type { Permissions, TurnStatus } from "@switch/agent"
import { EFFORTS, EventId, HOME, MessagePosted, ThreadId, TurnId } from "@switch/brain"
import type { Effort, Incoming, SpaceId } from "@switch/brain"

import { AppObserved, DeviceObserved, UiObserved } from "./events.ts"
import { groupOf, ruleOf } from "./rules.ts"
import type { Body, SbRecord } from "./source.ts"
import { num, obj, refOf, str } from "./source.ts"

export interface Work {
  readonly role: string
  readonly space: SpaceId
  /** The work that started it, by stream. */
  readonly parent: string | null
  readonly title: string
}

/** An event, the space it's filed in, and for the user's words, how the pre-read would have read them. */
export interface Out {
  readonly event: Incoming
  readonly space: SpaceId
  readonly read?: { readonly title: string; readonly effort: Effort }
}

/** What a turn's start reads off the record that caused it. */
export interface Cause {
  readonly kind: string
  readonly text: string
}

export const causeOf = (r: SbRecord): Cause => {
  const b = r.body
  if (r.kind === "woken") {
    return { kind: r.kind, text: [str(b.title), str(b.goal)].filter((s) => s !== "").join("\n\n") }
  }
  if (r.kind === "work") {
    return { kind: r.kind, text: str(b.goal) || str(b.title) }
  }
  return { kind: r.kind, text: str(b.text) }
}

export interface Context {
  readonly db: Database
  readonly works: ReadonlyMap<string, Work>
  readonly spaceOfWs: (ws: string) => SpaceId
  readonly names: ReadonlyMap<string, string>
  readonly folders: ReadonlyMap<string, string>
  /** The user's messages a part filed: those come in as the part. */
  readonly filed: ReadonlySet<string>
  /** Records turns and injections point at, by id. */
  readonly causes: Map<string, Cause>
}

const PERMISSIONS: Permissions = {
  tools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"],
  mode: "bypassPermissions",
  delegate: true,
}

const SECRET =
  /^(?:access_|refresh_|id_|api_|auth_|bearer_)?token$|secret|password|passwd|api_?key|cookie|authorization|private_key|credential/iu

/** A body with anything secret-looking blanked, however deep. */
export const redact = (v: unknown, depth = 0): unknown => {
  if (depth > 12) {
    return v
  }
  if (Array.isArray(v)) {
    return v.map((x) => redact(x, depth + 1))
  }
  if (typeof v === "object" && v !== null) {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        k,
        SECRET.test(k) && typeof x !== "object" ? "[redacted]" : redact(x, depth + 1),
      ]),
    )
  }
  return v
}

const effortOf = (v: unknown): Effort => {
  if (v === "max") {
    return "xhigh"
  }
  return EFFORTS.find((e) => e === v) ?? "medium"
}

const statusOf = (v: unknown): TurnStatus => {
  if (v === "done" || v === "failed") {
    return v
  }
  return "interrupted"
}

const parsed = (text: string): unknown => {
  try {
    const v: unknown = JSON.parse(text)
    return v
  } catch {
    return text
  }
}

const SPACE = "space:"

/** Converts records in log order; keeps what later records need: threads opened, turns, replies. */
export const makeConverter = (c: Context) => {
  const opened = new Set<ThreadId>()
  const ends = new Map<string, string>()
  /** Each work's turn under way, for wakes that join it. */
  const current = new Map<string, TurnId>()
  const lastSaid = new Map<string, string>()

  const hasThread = c.db.query<{ n: number }, [string]>(
    "SELECT count(*) AS n FROM threads WHERE thread = ?",
  )
  const saidIn = c.db.query<{ text: string }, [string]>(
    "SELECT text FROM messages WHERE turn = ? ORDER BY seq DESC LIMIT 1",
  )

  const workOf = (stream: string): Work =>
    c.works.get(stream) ?? { role: "chat", space: HOME, parent: null, title: "" }

  const threadOf = (stream: string) => {
    const w = workOf(stream)
    return ThreadId.make(
      w.role === "chat" ? `${SPACE}${w.space}` : `sb:${stream.slice("work/".length)}`,
    )
  }

  const known = (thread: ThreadId) => opened.has(thread) || (hasThread.get(thread)?.n ?? 0) > 0

  const openSpace = (space: SpaceId, at: number, out: Out[]) => {
    const thread = ThreadId.make(`${SPACE}${space}`)
    if (!known(thread)) {
      opened.add(thread)
      const p: typeof ThreadOpened.payload.Type = {
        thread,
        parent: null,
        title: c.names.get(space) ?? space,
        cwd: c.folders.get(space) ?? homedir(),
        model: "heavy",
        permissions: PERMISSIONS,
      }
      // The id Sessions opens it with, so whichever comes first is the one.
      out.push({
        event: {
          id: EventId.make(`open:${thread}:0`),
          type: ThreadOpened.type,
          source: "agent",
          time: at,
          payload: p,
        },
        space,
      })
    }
    return thread
  }

  /** Opens a work's thread, and the ones above it, the first time it's seen. */
  const open = (stream: string, at: number, out: Out[]): ThreadId => {
    const w = workOf(stream)
    const thread = threadOf(stream)
    if (thread.startsWith(SPACE)) {
      return openSpace(w.space, at, out)
    }
    if (known(thread)) {
      return thread
    }
    opened.add(thread)
    const parent =
      w.parent !== null && c.works.has(w.parent)
        ? open(w.parent, at, out)
        : openSpace(w.space, at, out)
    const p: typeof ThreadOpened.payload.Type = {
      thread,
      parent,
      title: w.title === "" ? w.role : w.title,
      cwd: c.folders.get(w.space) ?? homedir(),
      model: "heavy",
      permissions: PERMISSIONS,
    }
    out.push({
      event: {
        id: EventId.make(`sb:open:${stream}`),
        type: ThreadOpened.type,
        source: "agent",
        time: at,
        payload: p,
      },
      space: w.space,
    })
    return thread
  }

  /** The space a record that's no work's belongs in: a workspace it's about, else Home. */
  const spaceOf = (r: SbRecord): SpaceId => {
    const ws =
      r.about.find((a) => a.startsWith("ws:")) ??
      [r.body.workspace, obj(r.body.facts).workspace].map(str).find((x) => x.startsWith("ws:"))
    if (ws !== undefined) {
      return c.spaceOfWs(ws)
    }
    const work = str(r.body.work)
    if (work.startsWith("work/") && c.works.has(work)) {
      return workOf(work).space
    }
    const named = /^ws[:/](?<name>[^/]+)/u.exec(r.stream)?.groups?.name
    return named === undefined ? HOME : c.spaceOfWs(`ws:${named}`)
  }

  const said = (turn: string) => lastSaid.get(turn) ?? saidIn.get(turn)?.text ?? ""

  const turnStart = (r: SbRecord, w: Work, thread: ThreadId, out: Out[]) => {
    const turn = TurnId.make(`sb:${r.id}`)
    const cause = c.causes.get(refOf(r, "caused_by") ?? "")
    const wake = cause?.kind === "woken" || cause?.kind === "noticed"
    const p: typeof TurnStarted.payload.Type = {
      thread,
      turn,
      host: `sb:${str(r.body.host)}`,
      session: str(r.body.session),
      text: wake ? "" : (cause?.text ?? ""),
      delta: wake ? cause.text : "",
    }
    out.push({ event: agentEvent(r, TurnStarted.type, p), space: w.space })
    current.set(r.stream, turn)
  }

  const turnEnd = (r: SbRecord, w: Work, thread: ThreadId, out: Out[]) => {
    const replaces = refOf(r, "supersedes")
    const turn = TurnId.make(`sb:${replaces === null ? r.id : (ends.get(replaces) ?? replaces)}`)
    // An end with no start before it: its start is its own.
    if (replaces === null) {
      const start: typeof TurnStarted.payload.Type = {
        thread,
        turn,
        host: `sb:${str(r.body.host)}`,
        session: str(r.body.session),
        text: "",
        delta: "",
      }
      out.push({
        event: agentEvent(r, TurnStarted.type, start, `sb:${r.id}:start`),
        space: w.space,
      })
    }
    const tokens = obj(r.body.tokens)
    const p: typeof TurnEnded.payload.Type = {
      thread,
      turn,
      status: statusOf(r.body.status),
      result: said(turn),
      resetAt: null,
      costUsd: num(r.body.cost_usd),
      usage: {
        input: num(tokens.input),
        output: num(tokens.output),
        cacheRead: num(tokens.cache_read),
        cacheWrite: num(tokens.cache_write),
      },
      // Imported turns leave nothing to compact.
      context: 0,
      ms: num(r.body.duration_ms),
    }
    out.push({ event: agentEvent(r, TurnEnded.type, p), space: w.space })
    if (current.get(r.stream) === turn) {
      current.delete(r.stream)
    }
  }

  type Handler = (r: SbRecord, w: Work, out: Out[]) => void

  const handlers: Readonly<Record<string, Handler>> = {
    work: (r, _w, out) => {
      open(r.stream, r.at, out)
    },
    part: (r, w, out) => {
      const p: typeof MessagePosted.payload.Type = { space: w.space, text: str(r.body.text) }
      out.push({
        event: {
          id: EventId.make(`sb:${r.id}`),
          type: MessagePosted.type,
          source: "user",
          time: r.at,
          payload: p,
        },
        space: w.space,
        read: { title: w.title, effort: effortOf(r.body.effort) },
      })
    },
    message: (r, w, out) => {
      const text = str(r.body.text)
      const of = refOf(r, "part_of")
      if (text === "") {
        return
      }
      const p: typeof MessagePosted.payload.Type = { space: w.space, text }
      if (of !== null) {
        lastSaid.set(`sb:${of}`, text)
      }
      out.push({
        event: {
          id: EventId.make(`sb:${r.id}`),
          type: MessagePosted.type,
          source: "agent",
          time: r.at,
          payload: of === null ? p : { ...p, turn: TurnId.make(`sb:${of}`) },
        },
        space: w.space,
      })
    },
    turn: (r, w, out) => {
      const thread = open(r.stream, r.at, out)
      const replaces = refOf(r, "supersedes")
      if (str(r.body.status) !== "running") {
        turnEnd(r, w, thread, out)
      } else if (replaces === null) {
        turnStart(r, w, thread, out)
      } else {
        ends.set(r.id, ends.get(replaces) ?? replaces)
      }
    },
    tool: (r, w, out) => {
      const of = refOf(r, "part_of")
      if (of === null) {
        return
      }
      const thread = open(r.stream, r.at, out)
      const turn = TurnId.make(`sb:${of}`)
      const b = r.body
      // The API takes tool ids of letters, digits, _ and - only; Switchboard's are hex.
      const toolId = `sb_${r.id}`
      const call: typeof TurnTool.payload.Type = {
        thread,
        turn,
        id: toolId,
        name: str(b.name),
        input: typeof b.input === "string" ? parsed(b.input) : b.input,
      }
      const result: typeof TurnResult.payload.Type = {
        thread,
        turn,
        id: toolId,
        output: typeof b.output === "string" ? b.output : JSON.stringify(b.output ?? null),
        error: b.ok === false,
      }
      out.push(
        { event: agentEvent(r, TurnTool.type, call), space: w.space },
        { event: agentEvent(r, TurnResult.type, result, `sb:${r.id}:result`), space: w.space },
      )
    },
    aside: (r, w, out) => {
      const of = str(r.body.turn) || (refOf(r, "part_of") ?? "")
      if (of === "" || str(r.body.text) === "") {
        return
      }
      const p: typeof TurnText.payload.Type = {
        thread: open(r.stream, r.at, out),
        turn: TurnId.make(`sb:${of}`),
        text: str(r.body.text),
      }
      out.push({ event: agentEvent(r, TurnText.type, p), space: w.space })
    },
    injected: (r, w, out) => {
      const text = c.causes.get(refOf(r, "caused_by") ?? "")?.text ?? ""
      if (str(r.body.turn) !== "" && text !== "") {
        inject(r, w, TurnId.make(`sb:${str(r.body.turn)}`), "steer", text, out)
      }
    },
    noticed: (r, w, out) => {
      const turn = current.get(r.stream)
      if (turn !== undefined && str(r.body.text) !== "") {
        inject(r, w, turn, "wake", str(r.body.text), out)
      }
    },
    report: (r, w, out) => {
      if (w.role === "chat") {
        out.push(observed(r, AppObserved.type, w.space))
        return
      }
      const task = open(r.stream, r.at, out)
      const p: typeof TaskEnded.payload.Type = {
        task,
        parent:
          w.parent !== null && c.works.has(w.parent)
            ? threadOf(w.parent)
            : ThreadId.make(`${SPACE}${w.space}`),
        title: w.title,
        status: "done",
        result: str(r.body.text) || str(r.body.takeaway),
        costUsd: 0,
      }
      out.push({ event: agentEvent(r, TaskEnded.type, p), space: w.space })
    },
  }

  const inject = (
    r: SbRecord,
    w: Work,
    turn: TurnId,
    kind: "steer" | "wake",
    text: string,
    out: Out[],
  ) => {
    const p: typeof TurnInjected.payload.Type = {
      thread: open(r.stream, r.at, out),
      turn,
      kind,
      text,
    }
    out.push({ event: agentEvent(r, TurnInjected.type, p), space: w.space })
  }

  const owner = (r: SbRecord, out: Out[]) => {
    if (c.filed.has(r.id) || str(r.body.text) === "") {
      return
    }
    const p: typeof MessagePosted.payload.Type = { space: HOME, text: str(r.body.text) }
    out.push({
      event: {
        id: EventId.make(`sb:${r.id}`),
        type: MessagePosted.type,
        source: "user",
        time: r.at,
        payload: p,
      },
      space: HOME,
      read: { title: "", effort: "medium" },
    })
  }

  /** The events for one record, or none: dropped, folded, or nothing in it. */
  const convert = (r: SbRecord): Out[] => {
    const { route } = ruleOf(r.stream, r.kind)
    const out: Out[] = []
    if (typeof route !== "string") {
      return out
    }
    const w = workOf(r.stream)
    if (route === "work") {
      const handle = handlers[r.kind]
      if (handle === undefined) {
        out.push(observed(r, AppObserved.type, w.space))
      } else {
        handle(r, w, out)
      }
    } else if (route === "owner") {
      owner(r, out)
    } else {
      const type = OBSERVED[route]
      out.push(observed(r, type, r.stream.startsWith("work/") ? w.space : spaceOf(r)))
    }
    return out
  }

  return { convert }
}

const OBSERVED = {
  device: DeviceObserved.type,
  ui: UiObserved.type,
  app: AppObserved.type,
} as const

const observed = (r: SbRecord, type: string, space: SpaceId): Out => ({
  event: {
    id: EventId.make(`sb:${r.id}`),
    type,
    source: `sb:${r.source}`,
    time: r.at,
    payload: { space, stream: r.stream, kind: r.kind, about: [...r.about], body: redact(r.body) },
  },
  space,
})

const agentEvent = (r: SbRecord, type: string, payload: Body, id = `sb:${r.id}`): Incoming => ({
  id: EventId.make(id),
  type,
  source: "agent",
  time: r.at,
  payload,
})

/** The key a record counts under in the inventory and the run's report. */
export const keyOf = (r: Pick<SbRecord, "stream" | "kind">) => `${groupOf(r.stream)} ${r.kind}`
