// The brain's shapes for the board's extras, folded from live events after the snapshot: action
// items (autonomy's items.ts) and widget placements (brain's widgets.ts).
import type { SpaceId, StoredEvent } from "@switch/brain"

import { itemOf } from "./items.ts"
import type { ActionItem } from "./items.ts"
import { rec, spaceId, str } from "./json.ts"
import { describe, stepText } from "./step.ts"

export type { Action, ActionItem } from "./items.ts"

/** How many closed items are kept, to reopen. */
const CLOSED = 30

/** An account the user connected for extensions: `connection.added`, `.scopes_changed`, `.removed`. */
export interface Connection {
  readonly id: string
  readonly provider: string
  readonly account: string
  scopes: readonly string[]
}

/**
 * A device, host or extension that may reach the core, or one asking to: `credential.requested`
 * (with the code it shows), `.issued`, `.approved`, `.denied`, `.revoked`.
 */
export interface Credential {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly scopes: readonly string[]
  status: "pending" | "active" | "revoked"
  code: string | null
  /** When it was made, in ms. */
  readonly at: number
  /** Good until then, in ms. */
  readonly until: number | null
}

/** An installed extension: `extension.installed`, `.updated`, `.removed`. */
export interface Extension {
  readonly name: string
  readonly from: string
  readonly version: string
}

/** A provider subscription the agent runs on, as `account.state` last said. */
export interface Subscription {
  readonly host: string
  /** What it's shown as: the email its login reports, else its provider's name. */
  readonly label: string
  readonly provider: string
  readonly up: boolean
  /** Why it's down besides a limit: "Signed out". */
  readonly problem: string
  /** ms; 0 when not limited. */
  readonly limitedUntil: number
  /** Its usage windows, each a share used, 0 to 1. */
  readonly windows: readonly UsageWindow[]
  readonly running: number
}

export interface UsageWindow {
  readonly name: string
  readonly used: number
  readonly resetsAt: number
}

/** An extension's long job, as its Live Activity says: a print, a deploy. */
export interface Activity {
  readonly id: string
  readonly space: SpaceId
  readonly title: string
  readonly line: string
  /** 0 to 1, when known. */
  readonly progress?: number
  readonly startedAt: number
  readonly endsAt?: number
  readonly state: "running" | "needs" | "failed" | "done"
}

/** A widget placed in a space; a space's widgets keep the order of this list. */
export interface Widget {
  readonly app: string
  readonly name: string
  readonly space: SpaceId
}

const widgetOf = (w: Record<string, unknown>): Widget => ({
  app: str(w.app),
  name: str(w.name),
  space: spaceId(w.space),
})

const same = (a: { app: string; name: string }, b: { app: string; name: string }) =>
  a.app === b.app && a.name === b.name

/** Takes it out of wherever it was, then puts it `index`th among its space's widgets. */
const place = (list: Widget[], w: Widget, index: number) => {
  const at = list.findIndex((x) => same(x, w))
  if (at !== -1) {
    list.splice(at, 1)
  }
  const there = list.flatMap((x, i) => (x.space === w.space ? [i] : []))
  const before = there[Math.max(0, Math.trunc(index))]
  const after = there.at(-1)
  let to = list.length
  if (before !== undefined) {
    to = before
  } else if (after !== undefined) {
    to = after + 1
  }
  list.splice(to, 0, w)
}

export interface Extra {
  /** What needs the user, open. */
  readonly actions: Map<string, ActionItem>
  /** Open, out of the queue while the agent reworks them: nothing to answer, links still find them. */
  readonly revising: Map<string, ActionItem>
  /** The latest closed, newest first. */
  readonly closed: ActionItem[]
  readonly widgets: Widget[]
  /** The user's preferences that follow them across clients, by key (the theme, notifications). */
  readonly prefs: Map<string, unknown>
  readonly connections: Map<string, Connection>
  readonly subscriptions: Map<string, Subscription>
  readonly extensions: Map<string, Extension>
  readonly credentials: Map<string, Credential>
  readonly activities: Map<string, Activity>
}

export const empty = (): Extra => ({
  actions: new Map(),
  revising: new Map(),
  closed: [],
  widgets: [],
  prefs: new Map(),
  connections: new Map(),
  subscriptions: new Map(),
  extensions: new Map(),
  credentials: new Map(),
  activities: new Map(),
})

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : [])

const list = (v: unknown) => (Array.isArray(v) ? v.map(rec) : [])

const itemsOf = (v: unknown) =>
  list(v).flatMap((a) => {
    const i = itemOf(a, Number(a.seq))
    return i ? [i] : []
  })

/** Takes an open item out, into the closed ones, with the user's answer when it was answered. */
const close = (
  x: Extra,
  id: string,
  status: string,
  time: number,
  answer?: ActionItem["answer"],
) => {
  const i = x.actions.get(id) ?? x.revising.get(id)
  if (!i) {
    return
  }
  x.actions.delete(id)
  x.revising.delete(id)
  x.closed.unshift(
    answer ? { ...i, status, closedAt: time, answer } : { ...i, status, closedAt: time },
  )
  x.closed.splice(CLOSED)
}

/** A record of strings, as far as it is one. */
const textsOf = (v: unknown) =>
  Object.fromEntries(
    Object.entries(rec(v)).filter((kv): kv is [string, string] => typeof kv[1] === "string"),
  )

/** An answer's fields, as far as they read. */
const answerOf = (p: Record<string, unknown>): NonNullable<ActionItem["answer"]> => ({
  ...(typeof p.approved === "boolean" && { approved: p.approved }),
  ...(typeof p.choice === "string" && { choice: p.choice }),
  ...(typeof p.text === "string" && { text: p.text }),
  ...(p.drafts !== undefined && { drafts: textsOf(p.drafts) }),
})

/** The edits of `was` on the drafts `now` left as they were. */
const keptEdits = (was: ActionItem, now: ActionItem) =>
  Object.fromEntries(
    Object.entries(was.edits ?? {}).filter(([name]) => {
      const before = was.drafts?.find((d) => d.name === name)?.text
      return before !== undefined && now.drafts?.find((d) => d.name === name)?.text === before
    }),
  )

/** An item opened, revised, reopened, edited, closed or run. */
const foldItem = (x: Extra, e: StoredEvent, p: Record<string, unknown>) => {
  const id = str(p.id)
  if (e.type === "item.closed") {
    close(x, id, str(p.status), e.time)
    return
  }
  if (e.type === "item.answered") {
    close(x, id, "answered", e.time, answerOf(p))
    return
  }
  if (e.type === "item.ran") {
    const at = x.closed.findIndex((c) => c.id === id)
    const c = x.closed[at]
    if (c) {
      x.closed[at] = { ...c, ran: { ok: p.ok === true } }
    }
    return
  }
  const was = x.actions.get(id) ?? x.revising.get(id)
  if (e.type === "item.edited") {
    if (was) {
      const edits = { ...was.edits, ...textsOf(p.drafts) }
      ;(was.revising ? x.revising : x.actions).set(id, { ...was, edits })
    }
    return
  }
  if (e.type !== "item.opened" && e.type !== "item.revised" && e.type !== "item.reopened") {
    return
  }
  const read = itemOf(p, was?.at ?? e.time)
  // The user's edits stay on the drafts a revision left as they were (autonomy's `rebased`).
  const i = read && was ? { ...read, edits: keptEdits(was, read) } : read
  if (i) {
    x.actions.delete(id)
    x.revising.delete(id)
    ;(i.revising ? x.revising : x.actions).set(id, i)
    const at = x.closed.findIndex((c) => c.id === id)
    if (at !== -1) {
      x.closed.splice(at, 1)
    }
  }
}

const connectionOf = (c: Record<string, unknown>): Connection => ({
  id: str(c.id),
  provider: str(c.provider),
  account: str(c.account),
  scopes: strings(c.scopes),
})

/** Its name: under `spur` in events from before extensions were renamed. */
const nameOf = (p: Record<string, unknown>) => str(p.extension ?? p.spur)

const extensionOf = (p: Record<string, unknown>): Extension => ({
  name: nameOf(p),
  from: str(p.from),
  version: str(p.version),
})

const statusOf = (v: unknown): Credential["status"] =>
  v === "pending" || v === "revoked" ? v : "active"

const credentialOf = (c: Record<string, unknown>, at: number): Credential => ({
  id: str(c.id),
  name: str(c.name),
  kind: str(c.kind),
  scopes: strings(c.scopes),
  status: statusOf(c.status),
  code: typeof c.code === "string" ? c.code : null,
  at: typeof c.at === "number" ? c.at : at,
  until: typeof c.until === "number" ? c.until : null,
})

const subscriptionOf = (a: Record<string, unknown>, label?: string): Subscription => ({
  host: str(a.host),
  label: (str(a.label) || label) ?? str(a.host),
  provider: str(a.provider),
  up: a.up === true,
  problem: str(a.problem),
  limitedUntil: Number(a.limitedUntil) || 0,
  windows: list(a.windows).map((w) => ({
    name: str(w.name),
    used: Number(w.used) || 0,
    resetsAt: Number(w.resetsAt) || 0,
  })),
  running: Number(a.running) || 0,
})

const STATES = ["running", "needs", "failed", "done"] as const

const activityOf = (a: Record<string, unknown>): Activity => {
  const progress = typeof a.progress === "number" ? { progress: a.progress } : {}
  const endsAt = typeof a.endsAt === "number" ? { endsAt: a.endsAt } : {}
  return {
    id: str(a.id),
    space: spaceId(a.space),
    title: str(a.title),
    line: str(a.line),
    startedAt: Number(a.startedAt) || 0,
    state: STATES.find((s) => s === a.state) ?? "running",
    ...progress,
    ...endsAt,
  }
}

/** The snapshot's extras: open items, placements in order. */

export const fromSnapshot = (given: Readonly<Record<string, unknown>>): Extra => ({
  actions: new Map(
    itemsOf(given.actions)
      .filter((i) => !i.revising)
      .map((i) => [i.id, i]),
  ),
  revising: new Map(
    itemsOf(given.actions)
      .filter((i) => i.revising)
      .map((i) => [i.id, i]),
  ),
  closed: itemsOf(given.closedActions),
  widgets: list(given.widgets).map(widgetOf),
  prefs: new Map(Object.entries(rec(given.prefs))),
  connections: new Map(list(given.connections).map((c) => [str(c.id), connectionOf(c)])),
  subscriptions: new Map(list(given.accounts).map((a) => [str(a.host), subscriptionOf(a)])),
  extensions: new Map(list(given.extensions).map((p) => [str(p.extension), extensionOf(p)])),
  activities: new Map(list(given.activities).map((a) => [str(a.id), activityOf(a)])),
  credentials: new Map(list(given.credentials).map((c) => [str(c.id), credentialOf(c, 0)])),
})

/** A credential's events: requested, issued, approved, denied, revoked. */
const foldCredential = (x: Extra, e: StoredEvent, p: Record<string, unknown>, id: string) => {
  switch (e.type) {
    case "credential.requested": {
      x.credentials.set(id, credentialOf({ ...p, status: "pending" }, e.time))
      break
    }
    case "credential.issued": {
      x.credentials.set(id, credentialOf({ ...p, status: "active" }, e.time))
      break
    }
    case "credential.approved": {
      const c = x.credentials.get(id)
      if (c) {
        c.status = "active"
        c.code = null
      }
      break
    }
    case "credential.denied": {
      x.credentials.delete(id)
      break
    }
    case "credential.revoked": {
      const c = x.credentials.get(id)
      if (c) {
        c.status = "revoked"
        c.code = null
      } else {
        // `spur:<name>` before extensions were renamed.
        const extension = id.replace(/^(?:extension|spur):/u, "")
        x.credentials.set(
          id,
          credentialOf({ id, name: extension, kind: "extension", status: "revoked" }, e.time),
        )
      }
      break
    }
    default:
  }
}

/** A Live Activity starts or moves, or ends and goes. */
export const activity = (x: Extra, p: Record<string, unknown>) => {
  const id = str(p.id)
  if (p.phase === "end") {
    x.activities.delete(id)
  } else {
    x.activities.set(id, activityOf(p))
  }
}

export const fold = (x: Extra, e: StoredEvent, p: Record<string, unknown>) => {
  if (e.type.startsWith("credential.")) {
    foldCredential(x, e, p, str(p.id))
  } else {
    foldBoard(x, e, p)
  }
}

const foldBoard = (x: Extra, e: StoredEvent, p: Record<string, unknown>) => {
  const id = str(p.id)
  if (e.type.startsWith("item.")) {
    foldItem(x, e, p)
    return
  }
  switch (e.type) {
    case "connection.added": {
      x.connections.set(id, connectionOf(p))
      return
    }
    case "connection.scopes_changed": {
      const c = x.connections.get(id)
      if (c) {
        c.scopes = strings(p.scopes)
      }
      return
    }
    case "connection.removed": {
      x.connections.delete(id)
      return
    }
    case "pref.set": {
      x.prefs.set(str(p.key), p.value)
      return
    }
    case "widget.placed":
    case "widget.moved": {
      place(x.widgets, widgetOf(p), Number(p.index))
      return
    }
    case "widget.removed": {
      const at = x.widgets.findIndex((w) => same(w, { app: str(p.app), name: str(p.name) }))
      if (at !== -1) {
        x.widgets.splice(at, 1)
      }
      return
    }
    default: {
      foldSetup(x, e.type, p)
    }
  }
}

// Extensions and the subscriptions the agent runs on.
const foldSetup = (x: Extra, type: string, p: Record<string, unknown>) => {
  switch (type) {
    // `spur.*` as the log has them from before extensions were renamed.
    case "extension.installed":
    case "extension.updated":
    case "spur.installed":
    case "spur.updated": {
      x.extensions.set(nameOf(p), extensionOf(p))
      return
    }
    case "extension.removed":
    case "spur.removed": {
      x.extensions.delete(nameOf(p))
      return
    }
    case "account.state": {
      // `account.state` doesn't carry the label: the one the snapshot gave stays.
      x.subscriptions.set(str(p.host), subscriptionOf(p, x.subscriptions.get(str(p.host))?.label))
      return
    }
    case "account.removed": {
      x.subscriptions.delete(str(p.host))
      break
    }
    // A login found to be another's account is that account's now.
    case "model.catalog": {
      for (const a of Array.isArray(p.accounts) ? p.accounts : []) {
        const merged: unknown = rec(a).same
        for (const from of Array.isArray(merged) ? merged : []) {
          x.subscriptions.delete(str(from))
        }
      }
      break
    }
    default:
  }
}

/** The live step of a running thread ("Deploying"), from its latest tool call. */
export const liveStep = (
  thread: {
    readonly turn: string | null
    readonly streaming: string
    readonly items: readonly {
      kind: string
      turn: string
      id?: string
      name?: string
      input?: unknown
    }[]
  },
  /** The installed apps' names (`appNames`). */
  apps: readonly string[],
): string => {
  const completed = new Set<string>()
  for (let i = thread.items.length - 1; i >= 0; i -= 1) {
    const item = thread.items[i]
    if (!item || item.turn !== thread.turn) {
      break
    }
    if (item.kind === "result") {
      completed.add(item.id ?? "")
    }
    if (item.kind === "tool" && !completed.has(item.id ?? "")) {
      const step = stepText(describe(item.name ?? "", item.input, apps))
      if (step !== "") {
        return step
      }
    }
  }
  return thread.streaming === "" ? "" : "Writing"
}

/** Steering a running thread. */
export const STEER = "thread.steer"
