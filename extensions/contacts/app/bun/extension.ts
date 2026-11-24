// The window as an extension, `contacts-app`: tools the agent drives it with, and what the user
// does in it as UI events. It dials the core's /extensions and speaks MCP over that socket, again
// whenever it drops. Everything the window changes goes through the contacts extension's own tools,
// so the agent can do all of it without the window too.
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server"
import { tmpdir } from "node:os"
import path from "node:path"
import { answer, AppEvents, defineApp, left, serve, tool, Viewed } from "switch-ext-kit"
import type { Draft } from "switch-ext-kit"
import { Effect, Queue, Schema } from "effect"
import type { BrowserWindow } from "electrobun/main"

import type { Command, Seen, Shown } from "../shared/commands.ts"

export interface Window {
  readonly win: BrowserWindow
  readonly send: (c: Command) => void
  readonly shown: () => Promise<Shown>
}

const task = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (e) => (e instanceof Error ? e : new Error(String(e))) })

const run = async (argv: readonly string[]) => {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" })
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code !== 0) {
    throw new Error(err.trim() === "" ? `${argv[0] ?? ""} exited ${code}` : err.trim())
  }
  return out
}

// This process's biggest window, by CoreGraphics' list, which needs no permission.
const WINDOW_JXA = `ObjC.import("CoreGraphics")
const all = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0)))
const mine = all.filter((w) => w.kCGWindowOwnerPID === ${process.pid} && w.kCGWindowLayer === 0)
mine.sort((a, b) => b.kCGWindowBounds.Width * b.kCGWindowBounds.Height - a.kCGWindowBounds.Width * a.kCGWindowBounds.Height)
mine.length > 0 ? String(mine[0].kCGWindowNumber) : ""`

/** A JPEG of the window, even behind others (Screen Recording). */
const windowShot = async () => {
  const said = await run(["osascript", "-l", "JavaScript", "-e", WINDOW_JXA])
  const id = said.trim()
  if (id === "") {
    throw new Error("No Contacts window")
  }
  const file = path.join(tmpdir(), `contacts-window-${crypto.randomUUID()}.jpg`)
  await run(["screencapture", "-x", "-o", "-t", "jpg", "-l", id, file])
  const f = Bun.file(file)
  const data = Buffer.from(await f.arrayBuffer()).toString("base64")
  await f.delete()
  return data
}

const front = Schema.optionalKey(Schema.Boolean)

const windowApp = ({ win, send, shown }: Window) => {
  const told = (c: Command, forward: boolean | undefined) =>
    Effect.gen(function* telling() {
      send(c)
      if (forward === true) {
        win.activate()
      }
      // A frame for the window to draw it, so what's shown is after.
      yield* Effect.sleep("150 millis")
      return yield* task(shown)
    })
  return defineApp({
    name: "contacts-app",
    version: "1",
    instructions:
      "The Contacts window on this Mac: open someone, search, pick people to merge, see what's on screen. Changes to people go through the contacts tools; the window shows them at once.",
    tools: [
      tool(
        "open",
        {
          description:
            "Open a person in the Contacts window, by id, phone, email or exact name. `front` brings the window forward.",
          input: Schema.Struct({ person: Schema.String, front }),
        },
        (input) => told({ kind: "open", person: input.person }, input.front),
      ),
      tool(
        "find",
        {
          description: "Search the Contacts window's list, as the user would type it.",
          input: Schema.Struct({ query: Schema.String, front }),
        },
        (input) => told({ kind: "search", query: input.query }, input.front),
      ),
      tool(
        "page",
        {
          description: "Show the people, or every change with its undo.",
          input: Schema.Struct({ page: Schema.Literals(["people", "changes"]), front }),
        },
        (input) => told({ kind: input.page }, input.front),
      ),
      tool(
        "pick",
        {
          description:
            "Pick people for a merge, by id: the window shows them side by side with Merge for the user. To merge without asking, call contacts_merge.",
          input: Schema.Struct({ people: Schema.Array(Schema.String), front }),
        },
        (input) => told({ kind: "pick", people: input.people }, input.front),
      ),
      tool(
        "shown",
        {
          description:
            "What the window shows now: its page, the person open, the search, who's picked.",
          readOnly: true,
        },
        () => task(shown),
      ),
      tool(
        "screenshot",
        { description: "A picture of the Contacts window, even behind others.", readOnly: true },
        () =>
          task(async () => {
            const data = await windowShot()
            return answer(await shown(), [{ type: "image", data, mimeType: "image/jpeg" }])
          }),
      ),
    ],
  })
}

const parse: (json: string) => JSONRPCMessage = JSON.parse

/** One MCP session over a WebSocket to `url`, until it closes. */
const socketTransport = (url: string) =>
  Effect.callback<Transport, Error>((resume) => {
    const ws = new WebSocket(url)
    const transport: Transport = {
      start: async () => {
        await Promise.resolve()
      },
      send: async (m) => {
        ws.send(JSON.stringify(m))
        await Promise.resolve()
      },
      close: async () => {
        ws.close()
        await Promise.resolve()
      },
    }
    ws.addEventListener("open", () => {
      resume(Effect.succeed(transport))
    })
    ws.addEventListener("message", (e) => {
      if (typeof e.data === "string") {
        transport.onmessage?.(parse(e.data))
      }
    })
    ws.addEventListener("close", () => {
      transport.onclose?.()
      resume(Effect.fail(new Error(`Can't reach ${url}`)))
    })
    return Effect.sync(() => {
      ws.close()
    })
  })

/** What the user saw, as UI events: in view, then backed out of or stayed on. */
const draftOf = (s: Seen): Draft => {
  if (s.ms === undefined) {
    return Viewed.make(
      s.item === undefined ? { surface: s.surface } : { surface: s.surface, item: s.item },
    )
  }
  return left(s.surface, s.item, Date.now() - s.ms)
}

const seen = Effect.runSync(Queue.unbounded<Draft>())

/** What the user saw, sent on as UI events while the window is dialed in. */
export const saw = (s: Seen) => {
  Queue.offerUnsafe(seen, draftOf(s))
}

/** Keeps the window dialed in to the core at `core` (http://…). */
export const dialCore = (window: Window, core: string) => {
  const url = new URL("/extensions?name=contacts-app", core)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  const app = windowApp(window)
  const once = Effect.scoped(
    Effect.gen(function* session() {
      const transport = yield* socketTransport(url.href)
      const done = yield* serve(app, transport)
      yield* done
    }),
  ).pipe(Effect.ignore)
  const program = Effect.gen(function* dialing() {
    const events = yield* AppEvents
    yield* Effect.forkScoped(
      Effect.forever(Effect.flatMap(Queue.take(seen), (d) => Effect.ignore(events.emit(d)))),
    )
    yield* Effect.forever(Effect.andThen(once, Effect.sleep("3 seconds")))
  }).pipe(Effect.scoped, Effect.provide(AppEvents.layer(app)))
  Effect.runFork(program)
}
