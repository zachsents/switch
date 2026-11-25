// An ask's live view (Switchboard's portals, its SPEC §11.4): an open item that names one
// (`portal: {app, session}`) shows the screen of the Mac that app runs on, streamed by the app's
// own engine (its `portal` tool opens and closes each view), and the user drives it from the card.
// The core relays it, on the user's own connection only (`/portal/<item>`, a client's credential),
// and keeps nothing: frames and input (which may be a password) pass through memory, never a
// record, a blob or a log line. A view ends when the item closes (checked every second), when either
// side lets go, or after ten minutes with no input in it (Switchboard's `IDLE_MS`). `/portal` is the
// viewer itself: a page with no data in it, which the apps load with the item and their credential
// in its fragment.
import { getItem } from "@switch/autonomy"
import { Brain, defineRead } from "@switch/brain"
import { Gateway } from "@switch/gateway"
import { Effect, Option, Schema } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { Socket } from "effect/socket"

import { viewerHtml } from "./portal-page.ts" with { type: "macro" }

/** How long a view stays open with nothing done in it. */
const IDLE_MS = 10 * 60_000
const CHECK_MS = 1000
/** An input record's message type, at byte 5 of the engine's header (screen-relay's PROTOCOL.md). */
const INPUT = 3

const Opened = Schema.Struct({ url: Schema.String, token: Schema.String, grant: Schema.String })

/** Why a view ended, as its close code and reason, for the viewer to say. */
const ended = (code: number, reason: string) => new Socket.CloseEvent(code, reason)

const html = viewerHtml()

/** GET /portal: the viewer, the same page in both apps. */
export const portalPageRoute = HttpRouter.add("GET", "/portal", () =>
  Effect.succeed(
    HttpServerResponse.text(html, {
      contentType: "text/html; charset=utf-8",
      headers: { "Cache-Control": "no-store" },
    }),
  ),
)

/** An open item's view, or null. */
const portalRead = defineRead("core/portal/open", (db, id: string) => {
  const i = getItem(db, id)
  return i?.status === "open" ? (i.portal ?? null) : null
})

/** GET /portal/:item (a WebSocket): the item's view relayed; `?watch=1` only shows it. */
export const portalRoute = HttpRouter.add("GET", "/portal/:item", (request) =>
  Effect.gen(function* relaying() {
    const brain = yield* Brain
    const gateway = yield* Gateway
    const url = new URL(request.url, "http://core")
    const id = decodeURIComponent(url.pathname.split("/")[2] ?? "")
    const scope = url.searchParams.get("watch") === "1" ? "watch" : "control"
    const isOpen = brain.read(portalRead, id)
    const portal = yield* isOpen
    if (portal === null) {
      return HttpServerResponse.text("No such view", { status: 404 })
    }
    const socket: Socket.Socket = yield* request.upgrade
    const call = (args: Record<string, unknown>) =>
      Effect.tryPromise(async () => await gateway.call(`${portal.app}_portal`, args))
    yield* Effect.scoped(
      Effect.gen(function* streaming() {
        const viewer = yield* socket.writer
        const result = yield* call({ op: "open", session: portal.session, scope }).pipe(
          Effect.option,
        )
        const opened = result.pipe(
          Option.flatMap((r) =>
            r.isError === true
              ? Option.none()
              : Schema.decodeUnknownOption(Opened)(r.structuredContent),
          ),
        )
        if (Option.isNone(opened)) {
          const said = result.pipe(
            Option.match({
              onNone: () => `Can't reach ${portal.app}`,
              onSome: (r) =>
                r.content
                  .filter((c) => c.type === "text")
                  .map((c) => c.text)
                  .join(" ")
                  .slice(0, 120),
            }),
          )
          yield* viewer.write(ended(4502, said))
          return
        }
        const { url: at, token, grant } = opened.value
        yield* Effect.addFinalizer(() => Effect.ignore(call({ op: "close", grant })))
        const engine = yield* Socket.makeWebSocket(at, { protocols: ["nsl1", `bearer.${token}`] })
        const toEngine = yield* engine.writer
        const reached = yield* Effect.option(engine.reader)
        if (Option.isNone(reached)) {
          yield* viewer.write(ended(4502, "Can't reach the screen"))
          return
        }
        const fromEngine = reached.value
        const fromViewer = yield* socket.reader
        let input = Date.now()
        const down = Effect.forever(fromEngine.pull.pipe(Effect.flatMap(viewer.writeAll)))
        const up = Effect.forever(
          fromViewer.pull.pipe(
            Effect.flatMap((frames) => {
              for (const f of frames) {
                if (typeof f !== "string" && f[5] === INPUT) {
                  input = Date.now()
                }
              }
              return toEngine.writeAll(frames)
            }),
          ),
        )
        const watch = Effect.gen(function* watching() {
          for (;;) {
            yield* Effect.sleep(CHECK_MS)
            if ((yield* isOpen) === null) {
              return ended(4000, "Closed")
            }
            if (Date.now() - input > IDLE_MS) {
              return ended(4001, "Idle")
            }
          }
        })
        const why = yield* Effect.raceAll([
          watch,
          down.pipe(
            Effect.as(ended(4502, "Screen gone")),
            Effect.orElseSucceed(() => ended(4502, "Screen gone")),
          ),
          up.pipe(
            Effect.as(ended(1000, "")),
            Effect.orElseSucceed(() => ended(1000, "")),
          ),
        ])
        yield* Effect.ignore(viewer.write(why))
      }),
    ).pipe(Effect.ignore)
    return HttpServerResponse.empty()
  }).pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal)),
)
