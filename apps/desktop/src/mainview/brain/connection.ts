// The brain's sync socket, T3 Code's way: a snapshot of what the pages show, then live events, and
// older history a page at a time on request. Reconnects on its own and picks up where it left off
// with `?since=`; the brain sends a fresh snapshot instead when that's too far back. Commands are
// kept on this Mac until the brain answers (outbox.ts), so one survives the app going too; each is
// kept under its core, and goes to that core alone.
import type { ClientMessage, StoredEvent, SyncMessage } from "@switch/brain"
import { EventId } from "@switch/brain/commands"
import type { Attachment } from "@switch/brain/commands"

import { coreKey, onAuth, socketUrl, tokenNow } from "./auth.ts"
import { RefusedError, uploadKept } from "./files.ts"
import * as outbox from "./outbox.ts"

export type Link = "connecting" | "open" | "down"

export interface Handlers {
  readonly onSnapshot: (seq: number, state: Readonly<Record<string, unknown>>) => void
  readonly onEvents: (events: readonly StoredEvent[]) => void
  readonly onLink: (link: Link) => void
  /** The core took a command, as of `seq`. */
  readonly onReceipt: (id: string, seq: number) => void
}

interface Waiting {
  readonly message: ClientMessage
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: string) => void
}

const BACKOFF_MIN = 250
const BACKOFF_MAX = 5000
/** How long a drop may last before it shows. */
const DOWN_AFTER = 2000
/** What another window keeps is sent from here too once it's been unanswered this long: that
 * window may have closed. */
const OTHERS_AFTER = 10_000

const parse: (json: string) => SyncMessage = JSON.parse

/** Connects once there's a credential, and again on a new one (the bun process paired again). */
export const connect = (handlers: Handlers) => {
  let socket: WebSocket | null = null
  /** Null until the first snapshot: a cold start asks for one. */
  let cursor: number | null = null
  let watched: readonly string[] = []
  let backoff = BACKOFF_MIN
  let closed = false
  let downTimer: ReturnType<typeof setTimeout> | undefined
  const waiting = new Map<string, Waiting>()

  const sendNow = (message: ClientMessage) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message))
    }
  }

  const open = () => {
    const token = tokenNow()
    if (token === null) {
      return
    }
    const target = socketUrl()
    target.searchParams.set("source", "desktop")
    target.searchParams.set("token", token)
    if (cursor !== null) {
      target.searchParams.set("since", String(cursor))
    }
    const ws = new WebSocket(target)
    socket = ws
    handlers.onLink("connecting")
    ws.addEventListener("open", () => {
      backoff = BACKOFF_MIN
      clearTimeout(downTimer)
      handlers.onLink("open")
      if (watched.length > 0) {
        sendNow({ type: "watch", types: watched })
      }
      for (const w of waiting.values()) {
        sendNow(w.message)
      }
    })
    ws.addEventListener("message", (m) => {
      if (typeof m.data !== "string") {
        return
      }
      const message = parse(m.data)
      if (message.type === "snapshot") {
        cursor = message.seq
        handlers.onSnapshot(message.seq, message.state)
      } else if (message.type === "events") {
        const fresh = message.events.filter((e) => e.seq > (cursor ?? 0))
        const last = fresh.at(-1)
        if (last) {
          cursor = last.seq
          handlers.onEvents(fresh)
        }
      } else {
        const w = waiting.get(message.id)
        waiting.delete(message.id)
        if (message.type === "receipt") {
          handlers.onReceipt(message.id, message.seq)
          outbox.drop(message.id)
        } else if (message.type === "rejected") {
          // A message stays, with what was said, for its "Not sent"; nothing goes again.
          if (outbox.find(message.id)?.name === "message.post") {
            outbox.update(message.id, (e) => ({ ...e, rejected: message.reason }))
          } else {
            outbox.drop(message.id)
          }
        }
        if (message.type === "receipt") {
          w?.resolve(message.seq)
        } else if (message.type === "page") {
          w?.resolve(message.value)
        } else {
          w?.reject(message.reason)
        }
      }
    })
    ws.addEventListener("close", () => {
      if (closed) {
        return
      }
      clearTimeout(downTimer)
      downTimer = setTimeout(() => {
        handlers.onLink("down")
      }, DOWN_AFTER)
      setTimeout(open, backoff)
      backoff = Math.min(backoff * 2, BACKOFF_MAX)
    })
  }

  open()
  let had = tokenNow()
  let core = coreKey()
  onAuth(() => {
    const now = tokenNow()
    if (now === had) {
      return
    }
    had = now
    const was = core
    core = coreKey()
    if (was !== null && core !== was) {
      // Another core: its log is another, and what was waiting stays kept under the old one.
      cursor = null
      const asked = [...waiting.values()]
      waiting.clear()
      for (const w of asked) {
        w.reject("Core changed")
      }
    }
    // What was kept before a core was known goes to this one.
    if (core !== was) {
      pickUp(0)
    }
    if (socket === null) {
      open()
    } else {
      socket.close()
    }
  })

  /** Sends now, or once the socket is back; a retry with the same id is a no-op in the brain. */
  const request = async (id: string, message: ClientMessage, kept = false) => {
    if (message.type === "command" && !kept) {
      outbox.keep({
        id,
        kind: "command",
        name: message.command,
        payload: message.payload,
        time: Date.now(),
      })
    }
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    waiting.set(id, {
      message,
      resolve,
      reject: (reason) => {
        reject(new Error(reason))
      },
    })
    sendNow(message)
    return await promise
  }

  // What's kept and not yet answered goes from here too: what a run of the app before this one
  // left, and what another window keeps (an ask's window may close first). One held for Undo goes
  // when it's due, unless it was undone by then. A message's files go up first.

  /** One at a time, each kept as up, so a relaunch goes on from the next. */
  const upAll = async (
    id: string,
    left: readonly outbox.KeptFile[],
    done: readonly Attachment[] = [],
  ): Promise<readonly Attachment[]> => {
    const [f, ...rest] = left
    if (f === undefined) {
      return done
    }
    const a = await uploadKept(f)
    outbox.update(id, (e) => ({
      ...e,
      files: (e.files ?? []).map((g) => (g.id === f.id ? { ...g, blob: a.blob } : g)),
    }))
    return await upAll(id, rest, [...done, a])
  }
  const send = async (k: outbox.Entry) => {
    let { payload } = k
    const files = k.files ?? []
    if (files.length > 0 && typeof payload === "object" && payload !== null) {
      payload = { ...payload, attachments: await upAll(k.id, files) }
    }
    const id = EventId.make(k.id)
    const message: ClientMessage =
      k.kind === "emit"
        ? { type: "emit", id, event: k.name, payload }
        : { type: "command", id, command: k.name, payload }
    await request(k.id, message, true)
  }
  const scheduled = new Set<string>()
  const fire = (id: string) => {
    const k = outbox.find(id)
    if (k === undefined || k.rejected !== undefined || waiting.has(id)) {
      scheduled.delete(id)
      return
    }
    // Held longer since (typing on): when it's due now.
    const wait = (k.due ?? 0) - Date.now()
    if (wait > 0) {
      setTimeout(() => {
        fire(id)
      }, wait)
      return
    }
    // Nothing here waits on its answer.
    void go(k)
  }
  const go = async (k: outbox.Entry) => {
    try {
      await send(k)
    } catch (error) {
      if (error instanceof RefusedError) {
        outbox.update(k.id, (e) => ({ ...e, rejected: error.message }))
      } else if (outbox.isKept(k.id)) {
        // Couldn't upload yet: again in a while.
        setTimeout(() => {
          pickUp(0)
        }, BACKOFF_MAX)
      }
    } finally {
      scheduled.delete(k.id)
    }
  }
  const pickUp = (after: number) => {
    if (outbox.QUIET) {
      return
    }
    for (const k of outbox.kept()) {
      // A widget's call is the iPhone's to make.
      const ready = k.rejected === undefined && k.kind !== "call"
      if (ready && !scheduled.has(k.id) && !waiting.has(k.id)) {
        scheduled.add(k.id)
        setTimeout(
          () => {
            fire(k.id)
          },
          Math.max(k.due ?? 0, Date.now() + after) - Date.now(),
        )
      }
    }
  }
  pickUp(0)
  outbox.subscribe((other) => {
    // This window's own keeps go when due; another window's after a while, as it may send them.
    pickUp(other ? OTHERS_AFTER : 0)
  })

  return {
    command: async (id: EventId, command: string, payload: unknown) =>
      Number(await request(id, { type: "command", id, command, payload })),
    /** `given` makes a resend a no-op: the brain keeps an event id once. */
    emit: async (event: string, payload: unknown, given?: string) => {
      const id = EventId.make(given ?? crypto.randomUUID())
      await request(id, { type: "emit", id, event, payload })
    },
    /** Older history: a space's chat or a thread's transcript, before a seq. */
    page: async (name: string, args: unknown) => {
      const id = EventId.make(crypto.randomUUID())
      return await request(id, { type: "page", id, name, args })
    },
    /** The event types widgets on screen refresh on, kept across reconnects. */
    watch: (types: readonly string[]) => {
      watched = types
      sendNow({ type: "watch", types })
    },
    close: () => {
      closed = true
      clearTimeout(downTimer)
      socket?.close()
    },
  }
}

export type Connection = ReturnType<typeof connect>
