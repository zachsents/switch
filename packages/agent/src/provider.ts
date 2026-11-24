// One session interface over every provider's agent CLI, as T3 Code's provider adapters. Each
// adapter speaks its CLI's protocol and reports in Claude Code's stream-json shape (`CliMessage`),
// so a turn reads the same whichever provider ran it.
import type { Subscription } from "@switch/models"
import { Effect, Stream } from "effect"

import { effortRequest, interruptRequest, spawn, userMessage } from "./claude.ts"
import type { CliMessage } from "./claude.ts"
import type { Permissions } from "./events.ts"
import { guarded, sessionFile } from "./hosts.ts"
import type { Host, Machine, Proc } from "./hosts.ts"
import { toJsonl } from "./transcript.ts"
import type { Message } from "./transcript.ts"

/** An image a message carries, as a file on the core's machine. */
export interface Image {
  readonly path: string
  readonly type: string
}

/** Images read, for a CLI that takes them inline. */
export const inline = (images: readonly Image[]) =>
  Effect.all(
    images.map((i) =>
      Effect.promise(async () => ({
        type: i.type,
        data: Buffer.from(await Bun.file(i.path).bytes()).toString("base64"),
      })),
    ),
  )

export type Mcp = Readonly<Record<string, { readonly url: string; readonly token?: string }>>

export interface Start {
  readonly host: Host
  /** Real: no symlinks. */
  readonly cwd: string
  /** The thread's last session; resumed when this login can see it. */
  readonly session: string | null
  /** The thread's record, verbatim: what a new session starts from. */
  readonly history: () => Effect.Effect<readonly Message[]>
  readonly model: string
  readonly effort: string
  readonly system: string
  readonly permissions: Permissions
  readonly mcp: Mcp
  /** Claude Code settings JSON, for hooks; other providers ignore it. */
  readonly settings?: string
}

/** A live session. Its messages end when its process does. */
export interface Runner {
  readonly proc: Proc
  readonly session: string
  readonly messages: Stream.Stream<CliMessage>
  /**
   * A user message: a turn of its own, or joining the running one. "now" is the user's steer, "next"
   * waits for the step under way. Reports `command_lifecycle` for `uuid`: started, completed.
   */
  readonly send: (
    text: string,
    uuid: string,
    priority?: "now" | "next",
    images?: readonly Image[],
  ) => Effect.Effect<void>
  readonly interrupt: Effect.Effect<void>
  /** From the next message on. */
  readonly effort: (effort: string) => Effect.Effect<void>
  /** When the token it started on lapses (ms), for a login held as one that does. */
  readonly until?: number
}

export interface Adapter {
  readonly provider: Subscription
  readonly start: (s: Start) => Effect.Effect<Runner>
}

/** Writes to a process's stdin, ignoring a process that's gone: its reader ends the turn. */
export const writer = (proc: Proc) => (message: object) =>
  Effect.sync(() => {
    try {
      proc.write(`${JSON.stringify(message)}\n`)
    } catch {
      // Exited.
    }
  })

/** A pushable message stream, for adapters that translate another protocol. */
export const channel = () => {
  let controller: ReadableStreamDefaultController<CliMessage> | null = null
  const readable = new ReadableStream<CliMessage>({
    start: (c) => {
      controller = c
    },
  })
  return {
    push: (m: CliMessage) => {
      try {
        controller?.enqueue(m)
      } catch {
        // Closed.
      }
    },
    end: () => {
      try {
        controller?.close()
      } catch {
        // Closed.
      }
    },
    messages: Stream.fromReadableStream({ evaluate: () => readable, onError: () => null }).pipe(
      Stream.ignore,
    ),
  }
}

/** A private diagnostic drain with a fresh, empty stream for the session owner's reader. */
export const discardStderr = (proc: Proc): Proc => {
  void proc.stderr
    .pipeTo(
      new WritableStream({
        write() {
          // Never retain provider diagnostics that may contain credentials.
        },
      }),
    )
    .catch(() => {
      // Exiting processes can close their diagnostic pipe during teardown.
    })
  return {
    ...proc,
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    }),
  }
}

/** JSON-RPC requests over a process's stdin, answered by `answer` as replies come in. */
export const rpc = (send: (m: object) => void) => {
  let next = 0
  const waiting = new Map<number, (reply: Record<string, unknown>) => void>()
  return {
    request: async (method: string, params: unknown) => {
      next += 1
      const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>()
      waiting.set(next, resolve)
      send({ id: next, method, params })
      return await promise
    },
    answer: (id: number, reply: Record<string, unknown>) => {
      const resolve = waiting.get(id)
      waiting.delete(id)
      resolve?.(reply)
    },
    /** Every request still waiting gets `reply`. */
    close: (reply: Record<string, unknown>) => {
      for (const resolve of waiting.values()) {
        resolve(reply)
      }
      waiting.clear()
    },
  }
}

export const lifecycle = (uuid: string, state: "started" | "completed"): CliMessage => ({
  type: "command_lifecycle",
  command_uuid: uuid,
  state,
})

/** Lines of JSON from a stream, in order, until it ends. */
export const lines = async (stream: ReadableStream<Uint8Array>, each: (value: unknown) => void) => {
  const decoder = new TextDecoder()
  let buf = ""
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true })
    let at = buf.indexOf("\n")
    while (at !== -1) {
      const line = buf.slice(0, at).trim()
      buf = buf.slice(at + 1)
      if (line !== "") {
        try {
          each(JSON.parse(line))
        } catch {
          // Not a protocol line.
        }
      }
      at = buf.indexOf("\n")
    }
  }
}

/** Environment for a child CLI: none of the parent's agent wiring, and nothing that bills an API. */
export const childEnv = (
  machine: Pick<Machine, "env" | "guard">,
  drop: RegExp,
  extra: Readonly<Record<string, string>>,
) => guarded(machine, drop, extra)

// Claude Code: a session lives in a file under the login's config folder, so a thread resumes on
// any login that shares the folder, and a rebuild is a file written before launch.
export const claudeAdapter: Adapter = {
  provider: "claude",
  start: (s) =>
    Effect.gen(function* starting() {
      let { session } = s
      let resume = false
      if (session !== null) {
        resume = yield* s.host.machine.exists(sessionFile(s.host, s.cwd, session))
      }
      if (!resume) {
        session = crypto.randomUUID()
        const messages = yield* s.history()
        if (messages.length > 0) {
          const text = toJsonl(messages, { session, cwd: s.cwd, model: s.model })
          yield* s.host.machine.writeFile(sessionFile(s.host, s.cwd, session), text)
          resume = true
        }
      }
      const id = session ?? crypto.randomUUID()
      const claude = yield* spawn({ ...s, session: id, resume })
      return {
        proc: claude.proc,
        session: id,
        messages: claude.messages,
        send: (text, uuid, priority, images = []) =>
          Effect.flatMap(inline(images), (read) =>
            claude.send(userMessage(text, uuid, priority, read)),
          ),
        interrupt: claude.send(interruptRequest(crypto.randomUUID())),
        effort: (effort) => claude.send(effortRequest(crypto.randomUUID(), effort)),
        ...(claude.until !== undefined && { until: claude.until }),
      } satisfies Runner
    }),
}
