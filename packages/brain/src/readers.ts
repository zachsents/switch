// The core's reader threads: each a Worker with its own read-only connection to the brain's file,
// running the reads it's asked for by name (reads.ts), one at a time, while the core's event loop
// goes on. WAL lets them read beside the one writer: each read sees every commit made before it
// was asked. A read of cold pages holds its reader, never the core.
import { Database } from "bun:sqlite"

import { readNames, runAsked } from "./reads.ts"
import type { Read } from "./reads.ts"

/** A read that takes this long is logged, by name, wherever it ran. */
export const SLOW_READ_MS = Number(process.env.SWITCH_SLOW_READ_MS ?? 1000)

type Ask =
  | { readonly kind: "open"; readonly path: string }
  | {
      readonly kind: "read"
      readonly id: number
      readonly name: string
      readonly args: readonly unknown[]
    }

/** A read's answer, with the name of the read that made it. */
interface Done {
  readonly kind: "done"
  readonly id: number
  readonly name: string
  readonly value: unknown
}

interface DoneOf<A> extends Done {
  readonly value: A
}

type Answer =
  | { readonly kind: "ready"; readonly names: readonly string[] }
  | Done
  | {
      readonly kind: "failed"
      readonly id: number
      readonly message: string
      readonly stack: string | undefined
    }

/** Whether `done` is `read`'s answer: only `read.run` makes an answer under its name. */
const isDoneOf = <Args extends readonly unknown[], A>(
  read: Read<Args, A>,
  done: Done,
): done is DoneOf<A> => done.name === read.name

/** `name`'s answer from `run`, logged when slow. */
export const timedRead = <A>(name: string, run: () => A) => {
  const t0 = performance.now()
  const out = run()
  const ms = performance.now() - t0
  if (ms >= SLOW_READ_MS) {
    console.warn(`slow brain read: ${Math.round(ms)} ms: ${name}`)
  }
  return out
}

/** A read-only connection as a reader holds it. */
export const openReading = (path: string) => {
  const db = new Database(path, { readonly: true, strict: true })
  // A checkpoint's moment on the file is waited out, as the writer waits.
  db.run("PRAGMA busy_timeout = 5000")
  return db
}

/** A reader thread's answer, to the core that started it. */
const answer = (a: Answer) => {
  postMessage(a)
}

/** What a reader answers `ask` with, from `db`: the value, under its read's name, or why not. */
const answered = (db: Database | null, ask: Extract<Ask, { kind: "read" }>): Answer => {
  try {
    if (db === null) {
      throw new Error("The reader has no brain open")
    }
    // Inside one transaction, so a read of several statements sees one moment of the brain.
    const ran = timedRead(ask.name, () => db.transaction(() => runAsked(db, ask))())
    if (ran === undefined) {
      throw new Error(`No read ${ask.name} in this reader`)
    }
    return { kind: "done", id: ask.id, name: ask.name, value: ran.value }
  } catch (error) {
    return {
      kind: "failed",
      id: ask.id,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }
  }
}

/**
 * A reader thread's loop (its entry calls it once every module with reads is loaded): opens the
 * brain when told, says which reads it knows, then answers each read with its value or its error.
 */
export const serveReads = () => {
  let db: Database | null = null
  globalThis.addEventListener("message", (event: MessageEvent<Ask>) => {
    const ask = event.data
    if (ask.kind === "open") {
      db = openReading(ask.path)
      answer({ kind: "ready", names: readNames() })
      return
    }
    answer(answered(db, ask))
  })
}

interface Pending {
  readonly settle: (done: Done) => void
  readonly reject: (error: Error) => void
  readonly name: string
}

interface Thread {
  worker: Worker
  readonly pending: Map<number, Pending>
}

export interface Readers {
  readonly run: <Args extends readonly unknown[], A>(read: Read<Args, A>, args: Args) => Promise<A>
  /** Resolves once every reader has opened the brain and knows the same reads as this thread. */
  readonly ready: Promise<readonly null[]>
  readonly close: () => void
}

/** Why a reader's reads differ from this thread's, or null when they're the same. */
const mismatch = (expected: readonly string[], names: readonly string[]) => {
  const missing = expected.filter((n) => !names.includes(n))
  const extra = names.filter((n) => !expected.includes(n))
  return missing.length === 0 && extra.length === 0
    ? null
    : `A reader knows other reads than the core: missing ${missing.join(", ") || "none"}; extra ${extra.join(", ") || "none"}`
}

/** The thread with the fewest reads waiting, so one slow read holds only those asked after it. */
const leastBusy = (threads: readonly Thread[]) => {
  let [best] = threads
  for (const t of threads) {
    if (best === undefined || t.pending.size < best.pending.size) {
      best = t
    }
  }
  if (best === undefined) {
    throw new Error("No reader threads")
  }
  return best
}

/** What a reader's answer does to the read waiting on it. */
const deliver = (own: Thread, a: Exclude<Answer, { kind: "ready" }>) => {
  const p = own.pending.get(a.id)
  if (p === undefined) {
    return
  }
  own.pending.delete(a.id)
  if (a.kind === "done") {
    p.settle(a)
    return
  }
  const error = new Error(`${p.name}: ${a.message}`)
  if (a.stack !== undefined) {
    error.stack = a.stack
  }
  p.reject(error)
}

/**
 * `size` reader threads, each from `start` (the caller's Worker on its entry, which loads every
 * read and serves them) and opening `path`. A reader that dies fails its reads in flight and is
 * started again; one that knows other reads than this thread fails `ready`.
 */
export const makeReaders = (path: string, start: () => Worker, size: number): Readers => {
  let next = 0
  let closed = false
  const expected = readNames()
  const threads: Thread[] = []
  const readies: Promise<null>[] = []

  const launch = (thread: Thread | null) => {
    const worker = start()
    const own: Thread = thread ?? { worker, pending: new Map() }
    own.worker = worker
    const ready = Promise.withResolvers<null>()
    worker.addEventListener("message", (event: MessageEvent<Answer>) => {
      const a = event.data
      if (a.kind !== "ready") {
        deliver(own, a)
        return
      }
      const why = mismatch(expected, a.names)
      if (why === null) {
        ready.resolve(null)
      } else {
        ready.reject(new Error(why))
      }
    })
    worker.addEventListener("error", (event: ErrorEvent) => {
      ready.reject(new Error(`A reader failed to start: ${event.message}`))
    })
    worker.addEventListener("close", () => {
      for (const p of own.pending.values()) {
        p.reject(new Error(`${p.name}: its reader stopped`))
      }
      own.pending.clear()
      if (!closed) {
        console.warn("a brain reader stopped; starting it again")
        launch(own)
      }
    })
    worker.postMessage({ kind: "open", path } satisfies Ask)
    return { own, ready: ready.promise }
  }

  for (let i = 0; i < size; i += 1) {
    const { own, ready } = launch(null)
    threads.push(own)
    readies.push(ready)
  }

  const run = async <Args extends readonly unknown[], A>(read: Read<Args, A>, args: Args) => {
    const thread = leastBusy(threads)
    const asked = Promise.withResolvers<A>()
    next += 1
    const id = next
    thread.pending.set(id, {
      settle: (done) => {
        if (isDoneOf(read, done)) {
          asked.resolve(done.value)
        } else {
          asked.reject(new Error(`${read.name}: answered as ${done.name}`))
        }
      },
      reject: asked.reject,
      name: read.name,
    })
    thread.worker.postMessage({ kind: "read", id, name: read.name, args } satisfies Ask)
    return await asked.promise
  }

  return {
    ready: Promise.all(readies),
    run,
    close: () => {
      closed = true
      for (const t of threads) {
        t.worker.terminate()
      }
    },
  }
}
