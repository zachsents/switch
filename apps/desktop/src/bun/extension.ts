// The desktop as an extension: tools the agent drives this window with. It dials the core's
// /extensions and speaks MCP over that socket, again whenever it drops.
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server"
import { tmpdir } from "node:os"
import path from "node:path"
import { answer, AppEvents, defineApp, serve, tool } from "switch-ext-kit"
import { Effect, Schema } from "effect"
import { Utils } from "electrobun/main"
import { dlopen, FFIType, JSCallback } from "bun:ffi"
import type { Pointer } from "bun:ffi"
import { nativeHelper } from "./native.ts"

const task = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (e) => (e instanceof Error ? e : new Error(String(e))) })

// The window's own picture (src/native/snapshot.m): drawn by the app, never read off the screen,
// so it asks for no Screen Recording.
let snapshotLib: ReturnType<typeof openSnapshot> | null = null
const openSnapshot = (file: string) =>
  dlopen(file, {
    switch_window_snapshot: {
      args: [FFIType.ptr, FFIType.cstring, FFIType.function],
      returns: FFIType.void,
    },
  })

/** A JPEG of this app's window, even behind others. */
const windowShot = async (window: Pointer | null) => {
  const lib = nativeHelper("libswitch-snapshot.dylib")
  if (window === null || lib === undefined) {
    throw new Error("No Switch window")
  }
  snapshotLib ??= openSnapshot(lib)
  const { switch_window_snapshot: snapshot } = snapshotLib.symbols
  const file = path.join(tmpdir(), `switch-window-${crypto.randomUUID()}.jpg`)
  const { promise, resolve } = Promise.withResolvers<number>()
  // Called once, on the main thread; closed only after, never from inside its own call.
  const done = new JSCallback(
    (s: number) => {
      resolve(s)
      setTimeout(() => {
        done.close()
      }, 0)
    },
    { args: [FFIType.i32], returns: FFIType.void, threadsafe: true },
  )
  snapshot(window, Buffer.from(`${file}\0`), done.ptr)
  const status = await promise
  if (status !== 1) {
    throw new Error(status === 0 ? "No Switch window" : "Can't draw the window")
  }
  const f = Bun.file(file)
  const data = Buffer.from(await f.arrayBuffer()).toString("base64")
  await f.delete()
  return data
}

/** What the extension needs of the window beyond the window itself. */
export interface Window {
  /** The window's NSWindow, else null. */
  readonly native: () => Pointer | null
  /** The space on screen in a focused window, else null. */
  readonly inFront: () => string | null
  /** Whether a notification is shown here now (where the user sends them, quiet while open). */
  readonly wanted: () => boolean
  /** A notification shown: a click on it (the app coming forward soon after) opens its space. */
  readonly notified: (space: string) => void
}

const desktopApp = (window: Window) =>
  defineApp({
    name: "desktop",
    version: "1",
    instructions: "Switch's window on this Mac: look at it, or notify the user.",
    tools: [
      tool(
        "screenshot",
        {
          description: "A picture of Switch's window as it is now, even behind other windows.",
          readOnly: true,
        },
        () =>
          task(async () => {
            const data = await windowShot(window.native())
            return answer({ window: "Switch" }, [{ type: "image", data, mimeType: "image/jpeg" }])
          }),
      ),
      tool(
        "notify",
        {
          description:
            "A macOS notification from Switch, about a space. Held back while that space is in front.",
          input: Schema.Struct({
            title: Schema.String,
            body: Schema.optionalKey(Schema.String),
            subtitle: Schema.optionalKey(Schema.String),
            space: Schema.optionalKey(Schema.String),
            item: Schema.optionalKey(Schema.String),
          }),
        },
        (input) =>
          Effect.sync(() => {
            if (
              !window.wanted() ||
              (input.space !== undefined && window.inFront() === input.space)
            ) {
              return { shown: false }
            }
            Utils.showNotification({
              title: input.title,
              ...(input.body !== undefined && { body: input.body }),
              ...(input.subtitle !== undefined && { subtitle: input.subtitle }),
            })
            if (input.space !== undefined) {
              window.notified(input.space)
            }
            return { shown: true }
          }),
      ),
    ],
  })

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
      resume(Effect.fail(new Error("Can't reach the core")))
    })
    return Effect.sync(() => {
      ws.close()
    })
  })

/**
 * Keeps the desktop extension dialed in to its core as `desktop-<machine>`, again a few seconds
 * after it drops, once `auth` gives a core and token.
 */
export const dialCore = (
  window: Window,
  machine: string,
  auth: () => { readonly core: string; readonly token: string } | null,
) => {
  const app = desktopApp(window)
  const once = Effect.scoped(
    Effect.gen(function* session() {
      const a = auth()
      if (a === null) {
        return
      }
      const url = new URL("/extensions", a.core)
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      url.searchParams.set("name", `desktop-${machine}`)
      url.searchParams.set("token", a.token)
      const transport = yield* socketTransport(url.href)
      const done = yield* serve(app, transport)
      yield* done
    }),
  ).pipe(Effect.provide(AppEvents.layer(app)), Effect.ignore)
  Effect.runFork(Effect.forever(Effect.andThen(once, Effect.sleep("3 seconds"))))
}
