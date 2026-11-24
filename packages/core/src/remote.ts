// Another machine, as the core runs agent turns there: each process started by that machine's host
// over its link, its stdio relayed. When the link drops the host stops them, and here they end.
import type { Guard, Machine, Proc } from "@switch/agent"
import { Effect, Redacted } from "effect"

import type { Link, ToCore } from "./link.ts"

const encoder = new TextEncoder()

/**
 * A process's output, as its host sends it. A reader may let go before the process ends (a probe
 * that read what it needed cancels it): what comes after goes nowhere, since putting it in a
 * cancelled stream throws, in the loop that serves the whole link, and ends it.
 */
const relayed = () => {
  let to: ReadableStreamDefaultController<Uint8Array> | null = null
  let open = true
  const stream = new ReadableStream<Uint8Array>({
    start: (c) => {
      to = c
    },
    cancel: () => {
      open = false
    },
  })
  return {
    stream,
    put: (data: string) => {
      if (open) {
        to?.enqueue(encoder.encode(data))
      }
    },
    end: () => {
      if (open) {
        open = false
        to?.close()
      }
    },
  }
}

interface Child {
  readonly out: ReturnType<typeof relayed>
  readonly err: ReturnType<typeof relayed>
  readonly done: (code: number) => void
}

export interface Remote {
  readonly machine: Machine
  /** A message from its host about a process: whether it was one. */
  readonly route: (m: ToCore) => boolean
  /** The link is gone: every process here has ended. */
  readonly close: () => void
}

const FS_MS = 20_000

export const remoteMachine = (
  link: Link,
  about: {
    readonly id: string
    readonly home: string
    readonly dir?: string
    readonly provides: readonly string[]
    readonly env: Readonly<Record<string, string>>
    readonly guard?: Guard
  },
): Remote => {
  const children = new Map<string, Child>()
  const asks = new Map<string, (value: string | boolean | null) => void>()
  const started = new Map<string, (pid: number) => void>()

  const ask = (
    op: "write" | "exists" | "realpath",
    file: string,
    text?: string,
    secret?: boolean,
  ) =>
    Effect.callback<string | boolean | null>((resume) => {
      const id = crypto.randomUUID()
      const timer = setTimeout(() => {
        asks.delete(id)
        resume(Effect.succeed(null))
      }, FS_MS)
      asks.set(id, (value) => {
        clearTimeout(timer)
        asks.delete(id)
        resume(Effect.succeed(value))
      })
      link.send({
        t: "fs",
        id,
        op,
        file,
        ...(text === undefined ? {} : { text }),
        ...(secret === true && { secret }),
      })
      return Effect.sync(() => {
        clearTimeout(timer)
        asks.delete(id)
      })
    })

  const spawn: Machine["spawn"] = (argv, options) =>
    Effect.sync(() => {
      const id = crypto.randomUUID()
      const out = relayed()
      const err = relayed()
      const { promise: exited, resolve: done } = Promise.withResolvers<number>()
      let pid = 0
      children.set(id, {
        out,
        err,
        done: (code) => {
          if (children.delete(id)) {
            out.end()
            err.end()
            done(code)
          }
        },
      })
      link.send({
        t: "spawn",
        id,
        argv: [...argv],
        cwd: options.cwd,
        env: { ...options.env },
        ...(options.secret && { secret: Redacted.value(options.secret) }),
      })
      const p: Proc = {
        get pid() {
          return pid
        },
        write: (line) => {
          link.send({ t: "stdin", id, data: line })
        },
        end: () => {
          link.send({ t: "eof", id })
        },
        stdout: out.stream,
        stderr: err.stream,
        exited,
        kill: (signal) => {
          link.send({ t: "signal", id, signal: signal ?? "SIGTERM" })
        },
      }
      started.set(id, (n) => {
        pid = n
      })
      return p
    })

  const route = (m: ToCore) => {
    if (m.t === "started") {
      started.get(m.id)?.(m.pid)
      started.delete(m.id)
    } else if (m.t === "out") {
      const c = children.get(m.id)
      const to = m.fd === 1 ? c?.out : c?.err
      to?.put(m.data)
    } else if (m.t === "exit") {
      started.delete(m.id)
      children.get(m.id)?.done(m.code)
    } else if (m.t === "fsDone") {
      asks.get(m.id)?.(m.value)
    } else {
      return false
    }
    return true
  }

  const machine: Machine = {
    id: about.id,
    home: about.home,
    ...(about.dir !== undefined && { dir: about.dir }),
    provides: about.provides,
    env: about.env,
    ...(about.guard && { guard: about.guard }),
    spawn,
    writeFile: (file, text, secret) => Effect.asVoid(ask("write", file, text, secret)),
    exists: (file) => Effect.map(ask("exists", file), (v) => v === true),
    realpath: (dir) => Effect.map(ask("realpath", dir), (v) => (typeof v === "string" ? v : null)),
    // Its host stops what it ran for a core that's gone.
    reap: Effect.succeed(0),
  }

  return {
    machine,
    route,
    close: () => {
      for (const c of children.values()) {
        c.done(-1)
      }
      for (const resolve of asks.values()) {
        resolve(null)
      }
    },
  }
}
