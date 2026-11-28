// The rest of Switch, reached the way an agent reaches it: the core's apps over MCP (`/apps`), and
// its loopback routes. What Contacts asks of it: events in the brain, the user's connected Google
// account and a fresh token for it, or an action item asking the user to connect one.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { Effect } from "effect"
import type { HostShape } from "switch-ext-kit"

import { isJson, parse, rec, recs, str } from "./json.ts"
import type { Json } from "./json.ts"

export const core = (): string => process.env.SWITCH_URL ?? "http://127.0.0.1:4871"

/** The extension's credential, which a core on another machine wants (loopback alone needs none). */
const headers = (): Record<string, string> =>
  process.env.SWITCH_TOKEN === undefined
    ? {}
    : { authorization: `Bearer ${process.env.SWITCH_TOKEN}` }

/** The host that runs it, once it's serving: connections' tokens come through it, wherever the core is. */
let host: HostShape | null = null

/** Takes connections' tokens through `h` from now on. */
export const tokensThrough = (h: HostShape) => {
  host = h
}

let connected: Promise<Client> | null = null

const open = async () => {
  const client = new Client({ name: "contacts", version: "1" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${core()}/apps`), {
      requestInit: { headers: headers() },
    }),
  )
  return client
}

/** Calls another app's tool (`<app>_<tool>`): its structured result, or null if it isn't there. */
export const callCore = (name: string, args: Record<string, unknown>) =>
  Effect.promise(async () => {
    try {
      connected ??= open()
      const client = await connected
      const r = await client.callTool({ name, arguments: args })
      if (r.isError === true) {
        return null
      }
      if (isJson(r.structuredContent)) {
        return r.structuredContent
      }
      const first = Array.isArray(r.content) ? r.content[0] : undefined
      const parsed = parse(first?.type === "text" ? first.text : "null")
      return isJson(parsed) ? parsed : null
    } catch {
      connected = null
      return null
    }
  })

/** One event in the brain's log; `payload` parsed. */
export interface BrainEvent {
  readonly seq: number
  readonly id: string
  readonly time: number
  readonly type: string
  readonly source: string
  readonly payload: unknown
}

/** A condition of `brain_query`. */
export interface Where {
  readonly field: string
  readonly op: string
  readonly value?: unknown
}

const PAGE = 500

const brainEvent = (r: Json): BrainEvent => ({
  seq: Number(r.seq),
  id: String(r.id),
  time: Number(r.time),
  type: String(r.type),
  source: String(r.source),
  payload: r.payload,
})

/**
 * The log's events matching `where` after seq `after`, oldest first, a page at a time. `whole` is
 * false when the core stopped answering partway: what's there is still every match up to its last.
 */
export const brainEvents = (where: readonly Where[], after: number) =>
  Effect.gen(function* paging() {
    const events: BrainEvent[] = []
    let last = after
    for (;;) {
      const r = yield* callCore("brain_query", {
        where: [...where, { field: "seq", op: ">", value: last }],
        oldest: true,
        limit: PAGE,
      })
      if (r === null || !Array.isArray(r.events)) {
        return { events, whole: false }
      }
      const page = recs(r.events).map(brainEvent)
      for (const e of page) {
        if (Number.isNaN(e.seq) || e.seq <= last) {
          return { events, whole: false }
        }
        events.push(e)
        last = e.seq
      }
      if (r.events.length < PAGE) {
        return { events, whole: true }
      }
    }
  })

/** The first connected Google account that granted `scope`; null when there's none or no core. */
export const googleAccount = (scope: string) =>
  Effect.map(callCore("connections_list", {}), (r) => {
    const list = Array.isArray(r?.connections) ? r.connections : []
    for (const c of list) {
      const one = rec(c)
      const scopes = Array.isArray(one.scopes) ? one.scopes : []
      if (one.provider === "google" && str(one.account) !== "" && scopes.includes(scope)) {
        return str(one.account)
      }
    }
    return null
  })

/** Asks the user to connect a Google account: an action item with a Connect button. */
export const askForGoogle: Effect.Effect<unknown> = callCore("connections_request", {
  provider: "google",
})

/**
 * A fresh access token from the core, which holds the account's connection: through the host when
 * serving, else (a command run by hand on the core's machine) its loopback route.
 */
export const accessToken = async (account: string): Promise<string> => {
  if (host !== null) {
    return await Effect.runPromise(host.token("google", account))
  }
  const id = encodeURIComponent(`google:${account}`)
  const res = await fetch(`${core()}/connections/token?id=${id}`)
  const t = rec(await res.json().catch(() => ({})))
  if (!res.ok || typeof t.token !== "string") {
    throw new Error(`${account} isn't connected`)
  }
  return t.token
}
