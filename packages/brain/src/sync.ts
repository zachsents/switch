// The client protocol as a route on the core's HttpRouter, T3 Code's way (apps/server ws.ts, MIT,
// Copyright (c) 2026 T3 Tools Inc.): one WebSocket that sends a snapshot of what clients show (or
// the events since a seq, when that's short) and then live events, takes the client's commands and
// its own events back, and answers its requests for older history.
import type { Database } from "bun:sqlite"
import { Effect, Option, Schema, Stream } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import type { Socket } from "effect/socket"

import { Brain } from "./brain.ts"
import { storedEvent } from "./defs.ts"
import { EventId } from "./ids.ts"
import { PEER } from "./messages.ts"
import { defineRead, runAsked } from "./reads.ts"
import type { Read } from "./reads.ts"
import type { StoredEvent } from "./defs.ts"

/**
 * What clients get: a snapshot without history, the live events they show, and pages on demand.
 * Each is a read (reads.ts), so it runs in a reader thread.
 */
export interface View {
  readonly snapshot: Read<[], Readonly<Record<string, unknown>>>
  /** Whether a live event goes to clients. High-rate streams don't, unless a widget watches the type. */
  readonly live: Read<[event: StoredEvent], boolean>
  /** Older history, by name: a space's chat, a thread's transcript. */
  readonly pages: Readonly<Record<string, Read<[args: unknown], unknown>>>
  /** Whether a client may send this command; some only the core's own routes dispatch. */
  readonly accepts?: (command: string) => boolean
  /** Whether a client may emit an observation; state transitions stay with their owning service. */
  readonly acceptsEvent?: (event: string) => boolean
}

/** A reconnect further behind than this gets a fresh snapshot instead of the events it missed. */
const RESUME_MAX = 5000

const syncMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    seq: Schema.Number,
    state: Schema.Record(Schema.String, Schema.Unknown),
  }),
  Schema.Struct({ type: Schema.Literal("events"), events: Schema.Array(storedEvent) }),
  /** The answer to a client's command or emit, by its `id`. */
  Schema.Struct({ type: Schema.Literal("receipt"), id: Schema.String, seq: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("rejected"), id: Schema.String, reason: Schema.String }),
  /** The answer to a client's `page`. */
  Schema.Struct({ type: Schema.Literal("page"), id: Schema.String, value: Schema.Unknown }),
])
/** What the server sends. A client keeps the last seq it saw and reconnects with `?since=`. */
export type SyncMessage = typeof syncMessage.Type

export const decodeSyncMessage = Schema.decodeUnknownSync(Schema.fromJsonString(syncMessage))

const clientMessage = Schema.Union([
  /** A command, such as `message.post`. `id` makes a retry a no-op. */
  Schema.Struct({
    type: Schema.Literal("command"),
    id: Schema.String,
    command: Schema.String,
    payload: Schema.Unknown,
  }),
  /** An event the client observed itself, such as `ui.viewed`. */
  Schema.Struct({
    type: Schema.Literal("emit"),
    id: EventId,
    event: Schema.String,
    payload: Schema.Unknown,
  }),
  /** Event types a widget on screen refreshes on, beyond what clients get anyway. Replaces the last. */
  Schema.Struct({ type: Schema.Literal("watch"), types: Schema.Array(Schema.String) }),
  /** Older history: `name` is one of the view's pages. */
  Schema.Struct({
    type: Schema.Literal("page"),
    id: Schema.String,
    name: Schema.String,
    args: Schema.Unknown,
  }),
])
/** What a client sends: commands and its own events, under the source it connected as. */
export type ClientMessage = typeof clientMessage.Type

const decodeClientMessage = Schema.decodeUnknownOption(Schema.fromJsonString(clientMessage))

/** Whether a watched type names `type`: itself, or `*.<name>` any extension's `<extension>.<name>`. */
const watches = (watched: readonly string[], type: string) =>
  watched.some((w) => w === type || (w.startsWith("*.") && type.endsWith(w.slice(1))))

const encode = (message: SyncMessage) => JSON.stringify(message)
const text = new TextDecoder()

const head = (db: Database) =>
  db.query<{ seq: number | null }, []>("SELECT max(seq) AS seq FROM events").get()?.seq ?? 0

const headRead = defineRead("brain/sync/head", head)

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * The head and the view's snapshot (its read, by name, as this thread's registry has it), in one
 * read so the seq matches what it holds.
 */
const snapshotRead = defineRead("brain/sync/snapshot", (db, snapshot: string) => {
  const ran = runAsked(db, { name: snapshot, args: [] })
  if (ran === undefined) {
    throw new Error(`No read ${snapshot} known here`)
  }
  return { seq: head(db), state: isRecord(ran.value) ? ran.value : {} }
})

/** GET /?since=&source=, the daemon's root: `source` is who its commands and events come from ("desktop"). */
export const syncLayer = (view: View) =>
  HttpRouter.add("GET", "/", (request) =>
    Effect.gen(function* syncing() {
      const brain = yield* Brain
      const params = new URL(request.url, "http://switch").searchParams
      const raw = params.get("since")
      const since = raw === null ? null : Number(raw)
      if (since !== null && !Number.isSafeInteger(since)) {
        return HttpServerResponse.text("Bad since", { status: 400 })
      }
      // A client speaks as itself, never as the agent, the core or another agent (peer.ts).
      const asked = params.get("source") ?? "client"
      const source = asked === "agent" || asked === "auth" || asked === PEER ? "client" : asked
      const socket: Socket.Socket = yield* request.upgrade
      yield* Effect.scoped(
        Effect.gen(function* streaming() {
          const writer = yield* socket.writer
          const reader = yield* socket.reader
          const send = (m: SyncMessage) => writer.write(encode(m))
          let watched: readonly string[] = []

          const answer = (frame: string | Uint8Array) => {
            const message = Option.getOrUndefined(
              decodeClientMessage(typeof frame === "string" ? frame : text.decode(frame)),
            )
            if (!message) {
              return Effect.void
            }
            if (message.type === "watch") {
              watched = message.types
              return Effect.void
            }
            if (message.type === "page") {
              const page = view.pages[message.name]
              return page === undefined
                ? send({ type: "rejected", id: message.id, reason: `No page ${message.name}` })
                : brain
                    .read(page, message.args)
                    .pipe(Effect.flatMap((value) => send({ type: "page", id: message.id, value })))
            }
            if (message.type === "command" && view.accepts?.(message.command) === false) {
              return send({ type: "rejected", id: message.id, reason: "Not from a client" })
            }
            if (message.type === "emit" && view.acceptsEvent?.(message.event) === false) {
              return send({ type: "rejected", id: message.id, reason: "Not from a client" })
            }
            const done =
              message.type === "command"
                ? brain
                    .dispatch({
                      id: message.id,
                      type: message.command,
                      source,
                      payload: message.payload,
                    })
                    .pipe(Effect.map((r) => r.seq))
                : brain
                    .ingest([
                      { id: message.id, type: message.event, source, payload: message.payload },
                    ])
                    .pipe(Effect.as(0))
            return done.pipe(
              Effect.flatMap((seq) => send({ type: "receipt", id: message.id, seq })),
              Effect.catchTag("Rejected", (r) =>
                send({ type: "rejected", id: message.id, reason: r.reason }),
              ),
            )
          }

          // A short gap replays; a long one (or none given) starts from a snapshot, read in one go so
          // its seq matches what it holds. So does a cursor past the head, as after a restore.
          const behind = since === null ? null : (yield* brain.read(headRead)) - since
          let after = since ?? 0
          if (behind === null || behind < 0 || behind > RESUME_MAX) {
            const snapshot = yield* brain.read(snapshotRead, view.snapshot.name)
            yield* send({ type: "snapshot", ...snapshot })
            after = snapshot.seq
          }
          const out = brain.changes(after).pipe(
            Stream.filterEffect((e) =>
              watches(watched, e.type) ? Effect.succeed(true) : brain.read(view.live, e),
            ),
            Stream.groupedWithin(512, "50 millis"),
            Stream.runForEach((events) => send({ type: "events", events })),
          )
          // In order, as they come; the read fails when the client goes, which ends both.
          const inbound = Effect.forever(
            reader.pull.pipe(
              Effect.flatMap((frames) => Effect.forEach(frames, answer, { discard: true })),
            ),
          )
          yield* Effect.raceFirst(out, inbound)
        }),
      ).pipe(Effect.ignore)
      return HttpServerResponse.empty()
    }),
  )
