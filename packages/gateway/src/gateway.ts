// The brain's gateway for apps: connects to each over MCP, ingests what they emit in batches, and
// offers all their tools to agent sessions as one MCP server. Apps reach the core's models through
// it (`ax.switch/models`), so no extension holds a model key, and put action items in the user's
// queue (`ax.switch/asks`), reach the user's connections, other extensions' tools (`switch/call`)
// and the brain's events (`switch/follow`). A tool that speaks in the user's name
// (`speaksForPerson`) goes through the core's outbound guard before it runs for an agent or an
// extension (`callAs`); the core's own calls (an approval being sent, a sealed answer) and the
// user's clients call it directly.
import {
  Client,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
} from "@modelcontextprotocol/client"
import type { CallToolRequest } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { createMcpHandler, InMemoryTransport, McpServer } from "@modelcontextprotocol/server"
import type { CallToolResult, Tool, Transport } from "@modelcontextprotocol/server"
import {
  Blobs,
  Brain,
  bypassOf,
  defineRead,
  EventId,
  eventFromJsonSchema,
  Fingerprints,
  knowSecrets,
  placedInput,
  placements,
  redact,
  redactPicture,
  redactRecord,
  spaceFor,
  WidgetInput,
} from "@switch/brain"
import type { BrainShape, Incoming } from "@switch/brain"
import { Models } from "@switch/models"
import type { ModelError } from "@switch/models"
import {
  Context,
  Effect,
  FiberMap,
  Layer,
  Option,
  Queue,
  Result,
  Schedule,
  Schema,
  Stream,
} from "effect"
import type { Scope } from "effect"
import type { Database } from "bun:sqlite"

import {
  A2UI_MIME_TYPE,
  ACK,
  AppEvents,
  ASKS,
  CALLER,
  ONCE,
  CONNECTIONS,
  EVENTS,
  REACHES,
  need,
  Rejected,
  serve,
  VERSION,
  widget,
  WIDGET,
  isJson,
} from "switch-ext-kit"
import type { App, AppEventsService, Need, Widget } from "switch-ext-kit"

import { approvals } from "./approved.ts"
import { Pages, passkeyLink } from "./pages/pages.ts"
import {
  CALLS_FAILING,
  fails,
  ExtensionFailing,
  LINK_FAILING_MS,
  latestFailing,
} from "./failing.ts"
import type { Part } from "./failing.ts"
import { pictureOf } from "./picture.ts"
import { brainName, messagesOf, readView } from "./views.ts"
import type { View } from "./views.ts"

/** An app to connect to: how to reach it, fresh on each (re)connect. */
export interface Plug {
  readonly name: string
  readonly transport: Effect.Effect<Transport, never, Scope.Scope>
}

/** An app run as a child process speaking MCP on stdio, with this process's environment. */
export const stdio = (name: string, command: string, args: readonly string[] = []): Plug => ({
  name,
  transport: Effect.sync(() => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter((kv): kv is [string, string] => kv[1] !== undefined),
    )
    return new StdioClientTransport({ command, args: [...args], env, stderr: "inherit" })
  }),
})

/** An app served in this process, over an in-memory MCP transport. */
export const inProcess = <R>(app: App<R>) =>
  Effect.map(Effect.context<Exclude<R, AppEventsService>>(), (context): Plug => ({
    name: app.name,
    transport: Effect.gen(function* linking() {
      const [client, server] = InMemoryTransport.createLinkedPair()
      // The outbox lives as long as the link: built into its scope, not one `serve` closes on return.
      const events = yield* Layer.build(AppEvents.layer(app))
      yield* serve(app, server).pipe(
        Effect.provideService(AppEvents, Context.get(events, AppEvents)),
        Effect.provideContext(context),
      )
      return client
    }),
  }))

export interface Listed {
  readonly app: string
  readonly tool: Tool
  /** It sends something out in the user's name. */
  readonly speaks: boolean
}

/** A call that speaks for the user, as the outbound guard reads it. */
export interface Outbound {
  readonly thread: string | null
  readonly app: string
  readonly tool: string
  readonly args: Record<string, unknown>
  /**
   * Why the outbound check is wrong this time (brain's bypass.ts): past what only the user can
   * settle, it's held for their approval.
   */
  readonly bypass: string | null
}

/** Null lets the call run; a result is what the agent gets instead (held for approval, sent back). */
export type Guard = (call: Outbound) => Promise<CallToolResult | null>

/** Told once a call the guard let through went out, with what came back. */
export type Sent = (call: Outbound, result: CallToolResult) => Promise<void>

/** Up to this many tools are listed to agents as they are; past it, only search and call. */
const LISTED_MAX = 24
const SEP = "_"

const anything = Schema.toStandardSchemaV1(Schema.Record(Schema.String, Schema.Unknown))
const eventList = Schema.toStandardSchemaV1(
  Schema.Struct({
    events: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        payloadSchema: Schema.optionalKey(Schema.Unknown),
        _meta: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      }),
    ),
  }),
)
const occurrence = Schema.toStandardSchemaV1(
  Schema.Struct({
    eventId: Schema.String,
    name: Schema.String,
    timestamp: Schema.String,
    data: Schema.Unknown,
    /** Its place in the extension's outbox, acknowledged once the brain has it. */
    cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
)

/** An extension's event on its way into the brain, and whom to acknowledge it to once it's there. */
interface Arrival {
  readonly event: Incoming
  readonly from: Client
  readonly cursor: string | null
}

/** The client capability apps call the core's models by: `models/decide` and `models/complete`. */
const MODELS = "ax.switch/models"
const role = Schema.Literals(["turn", "triage", "gate", "decision", "browse"])
const decideRequest = {
  params: Schema.toStandardSchemaV1(
    Schema.Struct({
      input: Schema.Struct({ stable: Schema.String, item: Schema.String }),
      questions: Schema.Record(
        Schema.String,
        Schema.Struct({
          instructions: Schema.String,
          choices: Schema.Array(
            Schema.Struct({
              value: Schema.String,
              description: Schema.optionalKey(Schema.String),
            }),
          ),
        }),
      ),
      role: Schema.optionalKey(role),
    }),
  ),
  result: Schema.toStandardSchemaV1(
    Schema.Struct({
      answers: Schema.Record(
        Schema.String,
        Schema.Struct({
          choice: Schema.String,
          probabilities: Schema.Record(Schema.String, Schema.Number),
        }),
      ),
      ms: Schema.Number,
      cost: Schema.Number,
    }),
  ),
}
const completeRequest = {
  params: Schema.toStandardSchemaV1(
    Schema.Struct({ role, system: Schema.String, prompt: Schema.String }),
  ),
  result: Schema.toStandardSchemaV1(
    Schema.Struct({ text: Schema.String, ms: Schema.Number, cost: Schema.Number }),
  ),
}

const asksOpen = {
  params: Schema.toStandardSchemaV1(
    Schema.Struct({
      ask: Schema.Struct({
        title: Schema.String,
        body: Schema.String,
        kind: Schema.optionalKey(Schema.Literals(["task", "question", "approval", "sealed"])),
        completion: Schema.optionalKey(Schema.Literal("owner")),
        action: Schema.optionalKey(
          Schema.Struct({
            label: Schema.String,
            app: Schema.String,
            tool: Schema.String,
            args: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
          }),
        ),
        space: Schema.optionalKey(Schema.String),
        options: Schema.optionalKey(Schema.Array(Schema.String)),
        drafts: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({ name: Schema.String, label: Schema.String, text: Schema.String }),
          ),
        ),
        attachments: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              name: Schema.String,
              type: Schema.String,
              size: Schema.optionalKey(Schema.Finite),
              blob: Schema.optionalKey(Schema.String),
              url: Schema.optionalKey(Schema.String),
              option: Schema.optionalKey(Schema.Finite),
            }),
          ),
        ),
        resolveWhen: Schema.optionalKey(Schema.String),
        notify: Schema.optionalKey(Schema.Boolean),
        answerTo: Schema.optionalKey(Schema.String),
        sealed: Schema.optionalKey(Schema.Struct({ key: Schema.String, use: Schema.String })),
        passkey: Schema.optionalKey(Schema.String),
      }),
      id: Schema.optionalKey(Schema.String),
    }),
  ),
  result: Schema.toStandardSchemaV1(Schema.Struct({ id: Schema.String })),
}
const asksClose = {
  params: Schema.toStandardSchemaV1(
    Schema.Struct({ id: Schema.String, status: Schema.Literals(["done", "dismissed"]) }),
  ),
  result: Schema.toStandardSchemaV1(Schema.Struct({})),
}

/** Each tool's raw annotations, which the SDK's own tool list strips of Switch's marks. */
const rawTools = Schema.toStandardSchemaV1(
  Schema.Struct({
    tools: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        annotations: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      }),
    ),
  }),
)

/** The mark of a tool that sends something out in the user's name (switch-ext-kit's `speaks`). */
export const SPEAKS = "speaksForPerson"

/** An app's open item, as far as the gateway needs it: whose it is. */
const itemApp = (db: Database, id: string) =>
  db
    .query<{ data: string }, [string]>(
      "SELECT data FROM action_items WHERE id = ? AND status = 'open'",
    )
    .get(id)

const decodeItemApp = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      app: Schema.optionalKey(Schema.String),
      space: Schema.String,
      completion: Schema.optionalKey(Schema.Literal("owner")),
    }),
  ),
)

// The gateway's reads of the brain, by name (reads.ts), so they run in a reader thread.
/** An app's open item, decoded, or null: none open, or not one of an app's. */
const itemAppRead = defineRead("gateway/gateway/item-app", (db, id: string) =>
  Option.getOrNull(decodeItemApp(itemApp(db, id)?.data ?? "")),
)
const failingRead = defineRead("gateway/gateway/failing", (db) => latestFailing(db))
const headRead = defineRead(
  "gateway/gateway/head",
  (db) =>
    db.query<{ seq: number | null }, []>("SELECT max(seq) AS seq FROM events").get()?.seq ?? 0,
)
const spaceForRead = defineRead("gateway/gateway/space-for", (db, given: string | undefined) =>
  spaceFor(db, given, null),
)
const placementsRead = defineRead("gateway/gateway/placements", (db) => placements(db))
const placedInputRead = defineRead(
  "gateway/gateway/placed-input",
  (db, app: string, name: string, placement: string | undefined) =>
    placedInput(db, app, name, placement),
)

/** A model call's answer, or its ModelError as an MCP error. */
const answered = async <A>(call: Effect.Effect<A, ModelError>) => {
  const result = await Effect.runPromise(Effect.result(call))
  if (Result.isFailure(result)) {
    throw new ProtocolError(ProtocolErrorCode.InternalError, result.failure.reason)
  }
  return result.success
}

const asked = Schema.toStandardSchemaV1(
  Schema.Struct({
    provider: Schema.String,
    account: Schema.optionalKey(Schema.String),
    grant: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
)
interface Asked {
  readonly provider: string
  readonly account?: string
  readonly grant?: Readonly<Record<string, unknown>>
}

/** What an extension may ask of the user's connections, through its gateway. */
export interface ExtensionConnections {
  /** Its provider's connected accounts and their scopes. */
  readonly list: (
    provider: string,
  ) => Effect.Effect<
    readonly { readonly account: string; readonly scopes: readonly string[] }[],
    Error
  >
  /** A fresh access token, or a key's secret. */
  readonly token: (
    provider: string,
    account: string,
  ) => Effect.Effect<{ readonly token: string; readonly expires: number }, Error>
  /** Takes in a grant the extension kept itself before connections (a refresh token and its client, or a key), once. */
  readonly adopt: (
    app: string,
    need: Need,
    account: string,
    grant: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<string, Error>
}

const reaches = Schema.Struct({
  calls: Schema.optionalKey(Schema.Array(Schema.String)),
  follows: Schema.optionalKey(Schema.Array(Schema.String)),
})
const decodeReaches = Schema.decodeUnknownOption(reaches)
/** Who asked for a tool call (`CALLER` in its `_meta`): the work's thread and space. */
const askedBy = Schema.Struct({
  thread: Schema.NullOr(Schema.String),
  space: Schema.NullOr(Schema.String),
})
type Caller = typeof askedBy.Type
const callAsked = Schema.toStandardSchemaV1(
  Schema.Struct({
    name: Schema.String,
    arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
)
const callerIn = Schema.decodeUnknownOption(Schema.Struct({ [CALLER]: askedBy }))
const followAsked = Schema.toStandardSchemaV1(
  Schema.Struct({
    types: Schema.Array(Schema.String),
    /** The seq of the last event it handled: those after it come first. */
    after: Schema.optionalKey(Schema.Finite),
  }),
)

const fingerprints = Schema.toStandardSchemaV1(Fingerprints)
const ReaderOffer = Schema.Struct({
  read: Schema.String,
  fill: Schema.String,
  machine: Schema.String,
})
const readerOffer = Schema.toStandardSchemaV1(ReaderOffer)

/** A Mac's picture reader: its app, the tools that read a picture's text and fill boxes, its machine. */
export interface PictureReader extends Readonly<typeof ReaderOffer.Type> {
  readonly app: string
}

/** A name against an extension's declared names: exact, or a prefix ending in `*`. */
const allowed = (declared: readonly string[], name: string) =>
  declared.some((d) => (d.endsWith("*") ? name.startsWith(d.slice(0, -1)) : d === name))

const decodeWidget = Schema.decodeUnknownOption(widget)
const decodeNeeds = Schema.decodeUnknownOption(Schema.Struct({ needs: Schema.Array(need) }))

/** Only the user's clients may call it (MCP Apps' `visibility: ["app"]`), never the agent. */
const appOnly = (t: Tool) => {
  const ui: unknown = t._meta?.ui
  const seen: unknown = typeof ui === "object" && ui !== null ? Reflect.get(ui, "visibility") : null
  return Array.isArray(seen) && !seen.includes("model")
}

/** Text on one line, at most `max` characters. */
const oneLine = (text: string, max: number) => {
  const flat = text.replaceAll(/\s+/gu, " ").trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * Each app as a line of what the agent can do (Switchboard's `able`, which its gates read): what it
 * says it is, cut short, then every tool the agent may call, by name.
 */
const able = (
  connected: ReadonlyMap<string, { readonly about: string; readonly tools: readonly Tool[] }>,
) =>
  [...connected]
    .map(([app, c]) => {
      const tools = c.tools.filter((t) => !appOnly(t)).map((t) => t.name)
      const about = oneLine(c.about || (c.tools[0]?.description ?? ""), 200)
      return tools.length === 0 ? "" : `- ${app}: ${about} Tools: ${tools.join(", ")}.`
    })
    .filter((l) => l !== "")
    .join("\n")

const decodeMessages = (text: string): readonly unknown[] =>
  Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Unknown)))(text).pipe(
    Option.getOrElse(() => []),
  )
const created = Schema.decodeUnknownOption(
  Schema.Struct({ createSurface: Schema.Struct({ surfaceId: Schema.String }) }),
)
/** The surface a widget's messages create. */
const surfaceOf = (messages: readonly unknown[]) =>
  messages.flatMap((m) => Option.toArray(created(m)))[0]?.createSurface.surfaceId ?? ""
const decodeArgs = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))

const backoff = Schedule.min([Schedule.exponential("500 millis"), Schedule.spaced("30 seconds")])

/** How long a call waits for the app it calls to connect. */
const APP_WAIT_MS = 60_000
/**
 * How long an app whose session ended stays listed, its calls waiting for it: as long as
 * Switchboard took to call a silent link gone (crates/core/src/ws.rs `SILENT_FOR`). A host linking
 * again or an extension restarting is no gap in what the agent can do, as a request waited in
 * `requests/<target>` until its appendage was back (Switchboard's docs.md, Requests).
 */
const AWAY_MS = 75_000

const failed = (text: string): CallToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
})

/**
 * How long a tool call may go without a word: its progress (`notifications/progress`) starts the
 * wait again, so a long tool that says how it's going runs to its end. The client's own default (60
 * s) cut a live call partway (Nov 23: an approved send that rsynced 320 MB first was reported
 * unreachable at 60 s, while it went through 44 s later).
 */
const CALL_SILENCE_MS = 10 * 60_000

/**
 * Calls a tool, waiting while it runs and says how it's going. One silent past `silence` answers
 * that it timed out and may still have gone through, never that it was out of reach: the request
 * reached it, so whoever sends it again checks first.
 */
export const runTool = async (
  client: Client,
  params: CallToolRequest["params"],
  silence = CALL_SILENCE_MS,
): Promise<CallToolResult> => {
  try {
    return await client.callTool(params, {
      timeout: silence,
      resetTimeoutOnProgress: true,
      onprogress: () => {
        /* asking for progress is what lets it hold the call open */
      },
    })
  } catch (error) {
    if (SdkError.isInstance(error) && error.code === SdkErrorCode.RequestTimeout) {
      return failed(
        `Timed out: no answer in ${String(Math.round(silence / 1000))} s. It may still have gone through: check before sending it again.`,
      )
    }
    throw error
  }
}

const clip = (text: string) => (text.length > 300 ? `${text.slice(0, 300)}…` : text)

/** A failed call's words: its first text. */
const textOf = (result: CallToolResult) => {
  const first = result.content.find((c) => c.type === "text")
  return first?.type === "text" ? first.text : "no reason given"
}

/** What a connected app offers, from its handshake on. */
interface Offered {
  readonly client: Client
  /** What it says it is, from its handshake. */
  readonly about: string
  readonly tools: readonly Tool[]
  readonly speaking: ReadonlySet<string>
  readonly widgets: readonly Widget[]
  readonly needs: readonly Need[]
}

export class Gateway extends Context.Service<
  Gateway,
  {
    /** Connects to a plug until interrupted, again whenever it goes. Its transport waits for it. */
    readonly keep: (plug: Plug) => Effect.Effect<never>
    readonly tools: () => readonly Listed[]
    readonly widgets: () => readonly (Widget & { readonly app: string })[]
    /** The connections each connected app needs. */
    readonly needs: () => readonly (Need & { readonly app: string })[]
    /** What the agent can do: each app, what it says it is, and its tools by name, a line each. */
    readonly able: () => string
    /**
     * A tool called for the core or the user's client, as it is. `once`: a stable id it runs once by
     * (switch-ext-kit's ONCE), however often it's called with it.
     */
    readonly call: (
      name: string,
      args: Record<string, unknown>,
      once?: string,
    ) => Promise<CallToolResult>
    /**
     * An approved item's `send`, as the user left it: while it runs, the app's own calls to tools
     * that speak, saying only his approved words to no one else, aren't held again by the guard.
     */
    readonly callApproved: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>
    /**
     * Once an app is connected, or APP_WAIT_MS from now if it isn't, listed or not: what an approved
     * item runs waits for its app, as one just restarted lists none.
     */
    readonly reach: (app: string) => Promise<void>
    /** A tool called for an agent's thread (or an extension, null): one that speaks goes through the guard. */
    readonly callAs: (
      name: string,
      args: Record<string, unknown>,
      thread: string | null,
    ) => Promise<CallToolResult>
    /**
     * A widget's A2UI messages, with its tool's result as the data model; null if none. Its tool
     * is called with `input`: a placement's own (widgetRoute reads it by the placement's id) or a
     * chat line's.
     */
    readonly view: (
      app: string,
      name: string,
      input: typeof WidgetInput.Type,
    ) => Promise<readonly unknown[] | null>
    /** The Macs that read pictures for redaction (`redactions/pictures`), as they offered. */
    readonly pictureReaders: () => readonly PictureReader[]
  }
>()("switch/Gateway") {
  /**
   * Each app's event types are registered with the brain as it connects. `enrich` sees each event
   * before it's ingested; `guard` sees each agent's or extension's call to a tool that speaks for
   * the user (`speaksForPerson`), and what it answers, if anything, is answered instead; `sent`
   * hears each it let through that went out.
   */
  static readonly layer = (options: {
    readonly plugs: readonly Plug[]
    readonly enrich?: (event: Incoming) => Effect.Effect<Incoming>
    readonly guard?: Guard
    readonly sent?: Sent
    /** The user's connections, which an extension reaches only for the providers it declared. */
    readonly connections?: ExtensionConnections
    /** The space a thread's work is in: what an agent's call tells the tool it calls (`CALLER`). */
    readonly spaceOf?: (thread: string) => Promise<string>
  }) =>
    Layer.effect(
      Gateway,
      Effect.gen(function* making() {
        const brain = yield* Brain
        const models = yield* Models
        const pages = Option.getOrNull(yield* Effect.serviceOption(Pages))
        const connected = new Map<string, Offered>()
        const readers = new Map<string, PictureReader>()
        /** Apps whose session ended while they're still kept: what each offered, and since when. */
        const away = new Map<string, { readonly offered: Offered; readonly since: number }>()
        /** What each app offers: connected, or away for less than AWAY_MS. */
        const listed = () => {
          const now = Date.now()
          return new Map([
            ...[...away]
              .filter(([, a]) => now - a.since < AWAY_MS)
              .map(([app, a]) => [app, a.offered] as const),
            ...connected,
          ])
        }

        // High-rate input (UI analytics): coalesce into one ingest per 20 ms. Each event is
        // acknowledged to its extension once it's in the brain (or refused for good), so its outbox
        // lets it go; one the core never took in goes again on the next stream.
        const inbox = yield* Queue.unbounded<Arrival>()
        const ingestOne = (e: Incoming) =>
          brain.ingest([e]).pipe(Effect.catchTag("Rejected", (r) => Effect.logWarning(r.reason)))
        const enrich = options.enrich ?? Effect.succeed
        const acknowledge = (arrivals: readonly Arrival[]) =>
          Effect.promise(async () => {
            const by = new Map<Client, string[]>()
            for (const a of arrivals) {
              if (a.cursor !== null) {
                by.set(a.from, [...(by.get(a.from) ?? []), a.cursor])
              }
            }
            await Promise.all(
              [...by].map(async ([client, cursors]) => {
                await client.notification({ method: ACK, params: { cursors } }).catch(() => {
                  /* gone: it sends them again */
                })
              }),
            )
          })
        const ingest = (arrivals: readonly Arrival[]) =>
          Effect.flatMap(Effect.all(arrivals.map((a) => enrich(a.event))), (batch) =>
            brain.ingest(batch).pipe(
              // One bad event must not drop the rest of its batch.
              Effect.catchTag("Rejected", () =>
                Effect.forEach(batch, ingestOne, { discard: true }),
              ),
              Effect.andThen(acknowledge(arrivals)),
            ),
          )
        yield* Effect.forkScoped(
          Stream.fromQueue(inbox).pipe(
            Stream.groupedWithin(1024, "20 millis"),
            Stream.runForEach(ingest),
          ),
        )

        // Whoever waits for an app to connect: an extension's call to another that's still starting
        // (both start together on a restart), or any call to an app that's away, waits for it rather
        // than finding it missing.
        const startedAt = Date.now()
        const arriving = new Map<string, Set<() => void>>()
        const arrived = (app: string) => {
          for (const resume of arriving.get(app) ?? []) {
            resume()
          }
          arriving.delete(app)
        }
        const connectedSoon = async (app: string, ms = APP_WAIT_MS) => {
          if (connected.has(app)) {
            return
          }
          const waiting = arriving.get(app) ?? new Set<() => void>()
          arriving.set(app, waiting)
          const { promise, resolve } = Promise.withResolvers<undefined>()
          const done = () => {
            clearTimeout(timer)
            waiting.delete(done)
            resolve(undefined)
          }
          const timer = setTimeout(done, ms)
          waiting.add(done)
          await promise
        }

        /**
         * An app that's away is waited for, until it's back or APP_WAIT_MS. Just after the gateway
         * starts, no app is listed yet: their hosts link again and each extension reconnects over
         * the next seconds. A call then (an approval tapped while the core restarted) waits for its
         * app too, until it comes or that first APP_WAIT_MS is over.
         */
        const reached = async (app: string) => {
          if (!connected.has(app)) {
            const starting = startedAt + APP_WAIT_MS - Date.now()
            if (listed().has(app)) {
              await connectedSoon(app)
            } else if (starting > 0) {
              await connectedSoon(app, starting)
            }
          }
          return connected.get(app)
        }

        // What's failing, by part and app, as last recorded: recorded again only once it works.
        const failingNow = new Map<string, string>(
          (yield* brain.read(failingRead)).flatMap((f) =>
            f.failing === null ? [] : [[`${f.part}\n${f.extension}`, f.failing] as const],
          ),
        )
        const failing = (app: string, part: Part, what: string | null) => {
          const key = `${part}\n${app}`
          if (failingNow.has(key) === (what !== null)) {
            return
          }
          if (what === null) {
            failingNow.delete(key)
          } else {
            failingNow.set(key, what)
          }
          Effect.runFork(
            ingestOne({
              id: EventId.make(`failing:${part}:${app}:${crypto.randomUUID()}`),
              type: ExtensionFailing.type,
              source: "gateway",
              payload: { extension: app, part, failing: what },
            }),
          )
        }
        /** Each app's calls failed in a row. */
        const streaks = new Map<string, number>()
        const callFailed = (app: string, tool: string, why: string) => {
          const n = (streaks.get(app) ?? 0) + 1
          streaks.set(app, n)
          if (n >= CALLS_FAILING) {
            failing(app, "calls", `${n} calls in a row failed; the last, ${tool}: ${clip(why)}`)
          }
        }
        const callWorked = (app: string) => {
          streaks.delete(app)
          failing(app, "calls", null)
        }

        const call = async (
          name: string,
          args: Record<string, unknown>,
          caller?: Caller,
          once?: string,
        ): Promise<CallToolResult> => {
          const [app = "", ...rest] = name.split(SEP)
          const tool = rest.join(SEP)
          const known = listed().has(app)
          const c = await reached(app)
          if (!c) {
            if (known) {
              callFailed(app, tool, "it didn't come back")
            }
            return failed(`No app ${app}`)
          }
          try {
            const meta = {
              ...(caller && { [CALLER]: caller }),
              ...(once !== undefined && { [ONCE]: once }),
            }
            const result = await runTool(c.client, {
              name: tool,
              arguments: args,
              ...(Object.keys(meta).length > 0 && { _meta: meta }),
            })
            if (fails(result)) {
              callFailed(app, tool, textOf(result))
            } else {
              callWorked(app)
            }
            return result
          } catch (error) {
            callFailed(app, tool, String(error))
            throw error
          }
        }

        /** An agent's call tells the tool whose work asked; an extension's passes on its own asker. */
        const callerFor = async (thread: string | null, passed: Caller | undefined) => {
          if (thread === null) {
            return passed
          }
          const space = options.spaceOf ? await options.spaceOf(thread) : null
          return { thread, space }
        }

        const approved = approvals()

        /** `by`: the extension calling, for its call inside an approval it's sending. */
        const callAs = async (
          name: string,
          args: Record<string, unknown>,
          thread: string | null,
          passed?: Caller,
          by?: string,
        ): Promise<CallToolResult> => {
          const [app = "", ...rest] = name.split(SEP)
          const tool = rest.join(SEP)
          const speaks = listed().get(app)?.speaking.has(tool) === true
          // A speaking tool's `bypass` is the guard's, never the tool's (`exposed`).
          const { bypass, ...unbypassed } = args
          const sent = speaks ? unbypassed : args
          const guarded = speaks && !(by !== undefined && approved.covers(by, sent))
          const outbound: Outbound = {
            thread: thread ?? passed?.thread ?? null,
            app,
            tool,
            args: sent,
            bypass: bypassOf(bypass),
          }
          const held = guarded && options.guard ? await options.guard(outbound) : null
          if (held !== null) {
            return held
          }
          const result = await call(name, sent, await callerFor(thread, passed))
          if (guarded && options.guard && options.sent && result.isError !== true) {
            await options.sent(outbound, result)
          }
          return result
        }

        const callApproved = async (name: string, args: Record<string, unknown>) =>
          await approved.within(name.split(SEP)[0] ?? "", args, async () => await call(name, args))

        const attach = (plug: Plug, linked: () => void) =>
          Effect.scoped(
            Effect.gen(function* attaching() {
              const transport = yield* plug.transport
              const client = new Client(
                { name: "switch", version: "1" },
                {
                  capabilities: {
                    extensions: {
                      [EVENTS]: {},
                      [MODELS]: {},
                      [ASKS]: {},
                      ...(options.connections === undefined ? {} : { [CONNECTIONS]: {} }),
                    },
                  },
                },
              )
              // What its handshake said: an extension may ask as soon as it has answered it, before
              // the client has taken the answer in, so its asks wait for the handshake to end.
              const shaken = Promise.withResolvers<null>()
              const extension = async (name: string) => {
                await shaken.promise
                return client.getServerCapabilities()?.extensions?.[name]
              }
              // The extension's requests for its accounts: only for the providers it says it needs.
              const declared = async (provider: string) =>
                decodeNeeds(await extension(CONNECTIONS)).pipe(
                  Option.flatMap((x) =>
                    Option.fromNullishOr(x.needs.find((n) => n.provider === provider)),
                  ),
                  Option.getOrUndefined,
                )
              const answer = (
                method: string,
                run: (p: Asked, n: Need) => Effect.Effect<Record<string, unknown>, Error>,
              ) => {
                client.setRequestHandler(method, { params: asked }, async (p) => {
                  const n = await declared(p.provider)
                  if (n === undefined || options.connections === undefined) {
                    throw new Error(`${plug.name} didn't declare ${p.provider}`)
                  }
                  return { ...(await Effect.runPromise(run(p, n))) }
                })
              }
              if (options.connections !== undefined) {
                const c = options.connections
                answer("connections/list", (p) =>
                  Effect.map(c.list(p.provider), (accounts) => ({ accounts })),
                )
                answer("connections/token", (p) =>
                  Effect.map(c.token(p.provider, p.account ?? ""), (t) => ({ ...t })),
                )
                answer("connections/adopt", (p, n) =>
                  Effect.map(c.adopt(plug.name, n, p.account ?? "", p.grant ?? {}), (id) => ({
                    id,
                  })),
                )
              }
              const reach = async () =>
                decodeReaches(await extension(REACHES)).pipe(
                  Option.getOrElse((): typeof reaches.Type => ({})),
                )
              // Another extension's tool, as the agent would call it (the outbound gate included).
              client.setRequestHandler("switch/call", { params: callAsked }, async (p, ctx) => {
                const { calls = [] } = await reach()
                if (!allowed(calls, p.name)) {
                  throw new Error(`${plug.name} doesn't reach ${p.name}`)
                }
                await connectedSoon(p.name.split(SEP)[0] ?? "")
                const passed = Option.getOrUndefined(callerIn(ctx.mcpReq._meta))?.[CALLER]
                return { ...(await callAs(p.name, p.arguments ?? {}, null, passed, plug.name)) }
              })
              // The brain's events of the types it follows, as notifications with their seq: from
              // when it connected, or from `after` (the last it handled), so a restart on either side
              // misses none. Following more starts over from the earlier of the two, skipping only
              // what the relay it replaces had sent: `relayed`, where that relay got to, never past
              // what it sent, so following again while one is still catching up loses nothing.
              const following = new Set<string>()
              let relayed = yield* brain.read(headRead)
              const relaying = yield* FiberMap.makeRuntime<never, "follow">()
              const relay = (from: number, before: readonly string[], through: number) =>
                brain.changes(from).pipe(
                  Stream.filter(
                    (e) =>
                      allowed([...following], e.type) &&
                      !(e.seq <= through && allowed(before, e.type)),
                  ),
                  Stream.runForEach((e) =>
                    Effect.promise(async () => {
                      await client
                        .notification({
                          method: "switch/event",
                          params: {
                            seq: e.seq,
                            id: e.id,
                            type: e.type,
                            source: e.source,
                            time: e.time,
                            payload: isJson(e.payload) ? e.payload : { value: e.payload },
                          },
                        })
                        .catch(() => {
                          /* gone: it follows again after the last it handled */
                        })
                      relayed = Math.max(relayed, e.seq)
                    }),
                  ),
                )
              client.setRequestHandler("switch/follow", { params: followAsked }, async (p) => {
                const { follows = [] } = await reach()
                const refused = p.types.filter((t) => !allowed(follows, t))
                if (refused.length > 0) {
                  throw new Error(`${plug.name} doesn't follow ${refused.join(", ")}`)
                }
                const before = [...following]
                const through = relayed
                for (const t of p.types) {
                  following.add(t)
                }
                const from = Math.min(p.after ?? through, through)
                relayed = from
                relaying("follow", relay(from, before, through))
                return { types: [...following] }
              })
              // The fingerprints of the secrets it holds (the vault's), in place of the last it gave:
              // every event, log line, tool result and send is matched against them (brain's
              // redact.ts), the values never leaving it. Kept while it's away.
              client.setRequestHandler("redactions/set", { params: fingerprints }, (p) => {
                knowSecrets(plug.name, p)
                return {}
              })
              // A Mac's text reader for pictures (Vision): the tools that read one and fill boxes in
              // it, kept while it's away.
              client.setRequestHandler("redactions/pictures", { params: readerOffer }, (p) => {
                readers.set(plug.name, { app: plug.name, ...p })
                return {}
              })
              client.setRequestHandler(
                "models/decide",
                decideRequest,
                async (p) =>
                  await answered(models.decide(p.input, p.questions, p.role ?? "decision")),
              )
              client.setRequestHandler(
                "models/complete",
                completeRequest,
                async (p) => await answered(models.complete(p.role, p.system, p.prompt)),
              )
              // An extension's own items: its id prefixes theirs, and it closes only its own.
              client.setRequestHandler("asks/open", asksOpen, async (p) => {
                const { space, ...ask } = p.ask
                const id = p.id ?? `${plug.name}-${crypto.randomUUID().slice(0, 8)}`
                const open = await Effect.runPromise(brain.read(itemAppRead, id))
                if (p.id !== undefined && open?.app !== plug.name) {
                  throw new ProtocolError(ProtocolErrorCode.InvalidParams, `No open item ${id}`)
                }
                // The space it names, else Home: an extension's call carries no asking work.
                const there = await Effect.runPromise(brain.read(spaceForRead, space))
                // A passkey approval's one link: its ceremony's page, and only its own extension closes it.
                const payload = {
                  ...ask,
                  id,
                  space: there,
                  decision: plug.name,
                  app: plug.name,
                  ...(ask.passkey !== undefined &&
                    pages !== null && {
                      kind: "approval" as const,
                      completion: "owner" as const,
                      links: [{ label: "Approve", url: passkeyLink(pages, id) }],
                    }),
                }
                await Effect.runPromise(
                  brain
                    .dispatch({
                      id: crypto.randomUUID(),
                      type: open ? "item.revise" : "item.open",
                      source: plug.name,
                      payload,
                    })
                    .pipe(
                      Effect.mapError(
                        (r) => new ProtocolError(ProtocolErrorCode.InvalidParams, r.reason),
                      ),
                    ),
                )
                return { id }
              })
              client.setRequestHandler("asks/close", asksClose, async (p) => {
                const open = await Effect.runPromise(brain.read(itemAppRead, p.id))
                if (open?.app === plug.name) {
                  await Effect.runPromise(
                    open.completion === "owner" && p.status === "done"
                      ? brain.ingest([
                          {
                            id: EventId.make(crypto.randomUUID()),
                            type: "item.closed",
                            source: plug.name,
                            payload: { id: p.id, status: "resolved" },
                          },
                        ])
                      : brain.dispatch({
                          id: crypto.randomUUID(),
                          type: "item.close",
                          source: plug.name,
                          payload: { id: p.id, status: p.status },
                        }),
                  )
                }
                return {}
              })
              // What comes before its event types are registered is refused by the brain: never
              // acknowledged, so the extension sends it again.
              let typesKnown = false
              client.setNotificationHandler(
                "notifications/events/event",
                { params: occurrence },
                (o) => {
                  Queue.offerUnsafe(inbox, {
                    event: {
                      id: EventId.make(`${plug.name}:${o.eventId}`),
                      type: o.name,
                      source: plug.name,
                      payload: o.data,
                      time: Date.parse(o.timestamp),
                    },
                    from: client,
                    cursor: typesKnown ? (o.cursor ?? null) : null,
                  })
                },
              )
              const closed = Effect.callback<boolean>((resume) => {
                client.onclose = () => {
                  resume(Effect.succeed(true))
                }
              })
              yield* Effect.acquireRelease(
                Effect.tryPromise(async () => {
                  await client.connect(transport)
                  shaken.resolve(null)
                }),
                () =>
                  Effect.promise(async () => {
                    await client.close()
                  }),
              )
              const { tools } = yield* Effect.tryPromise(async () => await client.listTools())
              const raw = yield* Effect.tryPromise(
                async () => await client.request({ method: "tools/list", params: {} }, rawTools),
              ).pipe(Effect.orElseSucceed(() => ({ tools: [] })))
              const speaking = new Set(
                raw.tools.filter((t) => t.annotations?.[SPEAKS] === true).map((t) => t.name),
              )
              // A plain MCP server has no events.
              const { events } = yield* Effect.tryPromise(
                async () => await client.request({ method: "events/list", params: {} }, eventList),
              ).pipe(Effect.orElseSucceed(() => ({ events: [] })))
              for (const e of events) {
                const version = e._meta?.[VERSION]
                const registered = yield* Effect.try({
                  try: () =>
                    eventFromJsonSchema(
                      e.name,
                      typeof version === "number" ? version : 0,
                      e.payloadSchema,
                    ),
                  catch: (error) => new Rejected({ reason: `${e.name}: ${String(error)}` }),
                }).pipe(
                  Effect.flatMap(brain.register),
                  Effect.as(true),
                  Effect.catchTag("Rejected", (r) =>
                    Effect.as(Effect.logWarning(`${plug.name}: ${r.reason}`), false),
                  ),
                )
                if (!registered) {
                  continue
                }
                // Long-lived: cancelled (notifications/cancelled) when this scope closes.
                yield* Effect.forkScoped(
                  Effect.ignore(
                    Effect.tryPromise(
                      async (signal) =>
                        await client.request(
                          { method: "events/stream", params: { name: e.name, cursor: null } },
                          anything,
                          {
                            signal,
                            timeout: 2 ** 31 - 1,
                          },
                        ),
                    ),
                  ),
                )
              }
              const resources =
                client.getServerCapabilities()?.resources === undefined
                  ? []
                  : (yield* Effect.tryPromise(async () => await client.listResources())).resources
              const widgets = resources.flatMap((r) =>
                Option.toArray(decodeWidget(r._meta?.[WIDGET])),
              )
              typesKnown = true
              // Tools only once its events are subscribed, so what a call emits isn't held back.
              const needs = decodeNeeds(
                client.getServerCapabilities()?.extensions?.[CONNECTIONS],
              ).pipe(
                Option.map((x) => x.needs),
                Option.getOrElse((): readonly Need[] => []),
              )
              const about = client.getInstructions() ?? ""
              const offered: Offered = { client, about, tools, speaking, widgets, needs }
              connected.set(plug.name, offered)
              away.delete(plug.name)
              arrived(plug.name)
              linked()
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  if (connected.get(plug.name) === offered) {
                    connected.delete(plug.name)
                    away.set(plug.name, { offered, since: Date.now() })
                  }
                }),
              )
              yield* Effect.logInfo(
                `${plug.name}: ${tools.length} tools, ${events.length} event types`,
              )
              yield* closed
              return yield* Effect.fail(`${plug.name} disconnected`)
            }),
          )

        // Once it's let go, it's no longer listed, and whoever waits for it stops waiting.
        // A link that keeps failing to come up for LINK_FAILING_MS is failing; one that ends after
        // it came up (a restart) isn't.
        const keep = (plug: Plug, schedule: Schedule.Schedule<unknown> = backoff) => {
          let up = false
          let since: number | null = null
          const linked = () => {
            up = true
            since = null
            failing(plug.name, "link", null)
          }
          return Effect.suspend(() => {
            up = false
            return attach(plug, linked)
          }).pipe(
            Effect.tapError((why) =>
              Effect.sync(() => {
                if (up) {
                  return
                }
                since ??= Date.now()
                if (Date.now() - since >= LINK_FAILING_MS) {
                  failing(plug.name, "link", clip(String(why)))
                }
              }),
            ),
            Effect.tapError(Effect.logWarning),
            Effect.retry(schedule),
            Effect.orDie,
            Effect.ensuring(
              Effect.sync(() => {
                away.delete(plug.name)
                arrived(plug.name)
              }),
            ),
          )
        }
        for (const plug of options.plugs) {
          yield* Effect.forkScoped(keep(plug))
        }

        const tools = () =>
          [...listed()].flatMap(([app, c]) =>
            c.tools.map((tool): Listed => ({ app, tool, speaks: c.speaking.has(tool.name) })),
          )

        return {
          keep: (plug) => keep(plug, Schedule.spaced("1 second")),
          tools,
          widgets: () => [...listed()].flatMap(([app, c]) => c.widgets.map((w) => ({ ...w, app }))),
          needs: () => [...listed()].flatMap(([app, c]) => c.needs.map((n) => ({ ...n, app }))),
          able: () => able(listed()),
          view: async (app, name, input) => {
            const c = await reached(app)
            const w = c?.widgets.find((x) => x.name === name)
            if (!c || !w) {
              return null
            }
            const { contents } = await c.client.readResource({ uri: w.resource })
            const messages = contents.flatMap((x) =>
              x.mimeType === A2UI_MIME_TYPE && "text" in x ? decodeMessages(x.text) : [],
            )
            if (w.tool === undefined) {
              return [
                ...messages,
                {
                  version: "1.0",
                  updateDataModel: {
                    surfaceId: surfaceOf(messages),
                    path: "/input",
                    value: input,
                  },
                },
              ]
            }
            const result = await runTool(c.client, { name: w.tool, arguments: input })
            const surfaceId = surfaceOf(messages)
            return [
              ...messages,
              {
                version: "1.0",
                updateDataModel: { surfaceId, value: result.structuredContent ?? {} },
              },
            ]
          },
          call: async (name: string, args: Record<string, unknown>, once?: string) =>
            await call(name, args, undefined, once),
          callApproved,
          reach: connectedSoon,
          callAs,
          pictureReaders: () => [...readers.values()],
        }
      }),
    )
}

/** A tool as agents see it; one that speaks for the user takes the outbound check's `bypass`. */
const exposed = ({ app, tool, speaks }: Listed): Tool => ({
  ...tool,
  name: `${app}${SEP}${tool.name}`,
  ...(speaks && {
    inputSchema: {
      ...tool.inputSchema,
      properties: { ...tool.inputSchema.properties, bypass: { type: "string" } },
    },
  }),
})

const searchTool: Tool = {
  name: "search_tools",
  description:
    'Find tools to use with call_tool. "select:clock_new,autonomy_say" fetches those by name; other words are matched against names and descriptions.',
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  annotations: { readOnlyHint: true },
}
const callTool: Tool = {
  name: "call_tool",
  description: "Call a tool search_tools found.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" }, arguments: { type: "object" } },
    required: ["name"],
  },
}

// Claude Code's ToolSearch query forms: "select:a,b" or keywords, best matches first.
const search = (tools: readonly Tool[], query: string) => {
  if (query.startsWith("select:")) {
    const names = new Set(
      query
        .slice(7)
        .split(",")
        .map((n) => n.trim()),
    )
    return tools.filter((t) => names.has(t.name))
  }
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean)
  return tools
    .map((t) => {
      const text = `${t.name} ${t.description ?? ""}`.toLowerCase()
      return { t, score: words.filter((w) => text.includes(w)).length }
    })
    .filter((s) => s.score > 0)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((s) => s.t)
}

type Block = CallToolResult["content"][number]

const redactedBlock = async (c: Block): Promise<Block> => {
  if (c.type === "text") {
    return { ...c, text: redact(c.text) }
  }
  if (c.type === "resource" && "text" in c.resource) {
    return { ...c, resource: { ...c.resource, text: redact(c.resource.text) } }
  }
  if (c.type === "image") {
    const picture = Buffer.from(c.data, "base64")
    const filled = await redactPicture(picture)
    return filled === picture ? c : { ...c, data: Buffer.from(filled).toString("base64") }
  }
  return c
}

/** A result with its secrets redacted: its words, data and pictures, not its sound (yet). */
const redacted = async (result: CallToolResult): Promise<CallToolResult> => {
  const data: unknown = result.structuredContent
  return {
    ...result,
    content: await Promise.all(result.content.map(redactedBlock)),
    ...(typeof data === "object" && data !== null && { structuredContent: redactRecord(data) }),
  }
}

/**
 * `look`: only the tools that look (read-only), for a session that only looks things up; none of
 * the apps `without` names.
 */
const agentServer = (
  gateway: typeof Gateway.Service,
  thread: string | null,
  look: boolean,
  without: ReadonlySet<string>,
) => {
  const all = gateway
    .tools()
    .filter(
      (l) =>
        !appOnly(l.tool) &&
        !without.has(l.app) &&
        (!look || l.tool.annotations?.readOnlyHint === true),
    )
    .map(exposed)
  const callable = new Set(all.map((t) => t.name))
  // What would speak in the user's name is the guard's to let through, hold or send back. What a
  // tool answers reaches the model with its secrets redacted.
  const call = async (name: string, args: Record<string, unknown>) =>
    callable.has(name)
      ? await redacted(await gateway.callAs(name, args, thread))
      : failed(`No tool ${name}`)
  const searching = all.length > LISTED_MAX
  const mcp = new McpServer({ name: "switch", version: "1" }, { capabilities: { tools: {} } })
  mcp.server.setRequestHandler("tools/list", () => ({
    tools: searching ? [searchTool, callTool] : all,
  }))
  mcp.server.setRequestHandler("tools/call", async (request) => {
    const { name } = request.params
    const args = request.params.arguments ?? {}
    if (searching && name === searchTool.name) {
      const found = search(all, typeof args.query === "string" ? args.query : "")
      return { content: [{ type: "text", text: JSON.stringify(found) }] }
    }
    if (searching && name === callTool.name) {
      const target = typeof args.name === "string" ? args.name : ""
      return await call(target, decodeArgs(args.arguments).pipe(Option.getOrElse(() => ({}))))
    }
    return await call(name, args)
  })
  return mcp
}

const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(WidgetInput))

/** Widget calls remembered by id, the latest. */
const CALLS_KEPT = 1000

/**
 * A widget's call of its app's tool (`name`), its arguments the body: the tool's result, or with
 * `?as=picture` its picture alone (picture.ts). A call sent again with its `?id=` (a client's outbox
 * retrying) answers the first one's result rather than running the tool twice.
 */
export const widgetCall = (
  call: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>,
) => {
  const calls = new Map<string, Promise<CallToolResult>>()
  return async (request: Request, name: string): Promise<Response> => {
    const url = new URL(request.url)
    const headers = { "Access-Control-Allow-Origin": "*" }
    const args = decodeBody(await request.text()).pipe(Option.getOrElse(() => ({})))
    const id = url.searchParams.get("id")
    const had = id === null ? undefined : calls.get(id)
    const calling = async () => {
      try {
        return await call(name, args)
      } catch (error) {
        return failed(String(error))
      }
    }
    const result = had ?? calling()
    if (id !== null && had === undefined) {
      calls.set(id, result)
      for (const old of calls.keys()) {
        if (calls.size <= CALLS_KEPT) {
          break
        }
        calls.delete(old)
      }
    }
    if (url.searchParams.get("as") === "picture") {
      return pictureOf(await result, url.searchParams.get("have"), headers)
    }
    return Response.json(await result, { headers })
  }
}

/**
 * Widgets for clients: `/widgets` lists them, `/widgets/<app>/<name>` is one's A2UI messages (its
 * tool called with `?input=<json>`, else with the input of the placement `?placement=<id>`, each
 * placement its own, else with its first placement's), and a
 * POST to `/widgets/<app>/<tool>` calls one of that app's tools for its widget (a swap, a camera
 * frame), its arguments the body; with `?as=picture`, its picture alone (picture.ts). A view the agent made is the brain app's widget of its name: the
 * list holds those placed in a space, so a client draws and names them as it does an app's.
 */
export const widgetRoute = Effect.gen(function* routing() {
  const gateway = yield* Gateway
  const brain = yield* Brain
  const blobs = yield* Blobs
  return widgetRouter({
    gateway,
    brain,
    made: async (name) =>
      await Effect.runPromise(readView(name).pipe(Effect.provideService(Blobs, blobs))),
  })
})

/** widgetRoute's handler, given what it reads: the extensions' widgets, the brain, the agent's views. */
export const widgetRouter = ({
  gateway,
  brain,
  made,
}: {
  readonly gateway: Pick<Gateway["Service"], "call" | "widgets" | "view">
  readonly brain: Pick<BrainShape, "read">
  readonly made: (name: string) => Promise<Option.Option<View>>
}) => {
  const calling = widgetCall(gateway.call)
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const [, root, app, name] = url.pathname.split("/")
    const headers = { "Access-Control-Allow-Origin": "*" }
    if (root !== "widgets") {
      return new Response("Not found", { status: 404, headers })
    }
    if (request.method === "POST" && app !== undefined && name !== undefined) {
      return await calling(request, `${app}${SEP}${name}`)
    }
    if (app === undefined || app === "") {
      const offered = gateway.widgets().map((w) => ({
        app: w.app,
        name: w.name,
        title: w.title,
        refresh: w.refresh ?? [],
        ...(w.size && { size: w.size }),
        ...(w.settings && { settings: w.settings }),
      }))
      const placed = await Effect.runPromise(brain.read(placementsRead))
      const views = await Promise.all(
        placed
          .filter((p) => p.app === brainName)
          .map(async (p) =>
            Option.toArray(
              Option.map(await made(p.name), (v) => ({
                app: brainName,
                name: p.name,
                title: v.title,
                refresh: [],
              })),
            ),
          ),
      )
      return Response.json([...offered, ...views.flat()], { headers })
    }
    if (app === brainName && name !== undefined) {
      const view = await made(name)
      return Option.isSome(view)
        ? Response.json(messagesOf(view.value), { headers })
        : new Response("No such widget", { status: 404, headers })
    }
    const named = name ?? ""
    const given = decodeBody(url.searchParams.get("input") ?? "").pipe(Option.getOrUndefined)
    const placement = url.searchParams.get("placement") ?? undefined
    const input =
      given ?? (await Effect.runPromise(brain.read(placedInputRead, app, named, placement)))
    const messages = await gateway.view(app, named, input).catch((): null => null)
    return messages === null
      ? new Response("No such widget", { status: 404, headers })
      : Response.json(messages, { headers })
  }
}

/**
 * Agent sessions attach to this route: `{ "type": "http", "url": "<url>?thread=<thread>" }` in
 * Claude Code's MCP config, the thread its calls are held for; `&look=1` lists only the tools that
 * look, and each `&without=<app>` none of that app's.
 */
export const agentRoute = Gateway.pipe(
  Effect.map((gateway) => async (request: Request) => {
    const url = new URL(request.url)
    const thread = url.searchParams.get("thread")
    const look = url.searchParams.get("look") === "1"
    const without = new Set(url.searchParams.getAll("without"))
    const handler = createMcpHandler(() => agentServer(gateway, thread, look, without), {
      legacy: "stateless",
    })
    return await handler.fetch(request)
  }),
)
