// One app's own MCP server (`<app> mcp`) as a child on stdio: requests to it under ids of its own,
// its answers back as promises, everything else it says to `heard`.
import { isJson } from "switch-ext-kit"
import type { Json } from "switch-ext-kit"

export const parse = (line: string): Json | null => {
  try {
    const m: unknown = JSON.parse(line)
    return isJson(m) ? m : null
  } catch {
    return null
  }
}

export const lines = async (stream: ReadableStream<Uint8Array>, each: (line: string) => void) => {
  const decoder = new TextDecoder()
  let rest = ""
  for await (const chunk of stream) {
    rest += decoder.decode(chunk, { stream: true })
    const all = rest.split("\n")
    rest = all.pop() ?? ""
    for (const line of all) {
      if (line.trim() !== "") {
        each(line)
      }
    }
  }
}

export interface Child {
  /** Its prefix to the extension: `tasks`, so `tick` is `tasks_tick`. */
  readonly prefix: string
  /** Its name to people: `Tasks`. */
  readonly name: string
  /** Sends a request; `sent` hears its id here first. Resolves with the whole response. */
  readonly request: (method: string, params: Json, sent?: (id: number) => void) => Promise<Json>
  /** Writes one message as it is: a notification, or an answer to its own request. */
  readonly send: (m: Json) => void
  readonly kill: () => void
  /** Its process has ended. */
  readonly exited: () => boolean
}

export const spawnChild = (
  app: { readonly prefix: string; readonly name: string },
  binary: string,
  heard: (m: Json, child: Child) => void,
): Child => {
  const { prefix } = app
  const proc = Bun.spawn([binary, "mcp"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" })
  const waiting = new Map<number, PromiseWithResolvers<Json>>()
  let next = 1
  let ended = false
  const write = (m: Json) => {
    void proc.stdin.write(`${JSON.stringify(m)}\n`)
  }
  void lines(proc.stdout, (line) => {
    const m = parse(line)
    if (m === null) {
      return
    }
    const answered = typeof m.id === "number" && m.method === undefined ? m.id : -1
    const asked = waiting.get(answered)
    if (asked) {
      waiting.delete(answered)
      asked.resolve(m)
      return
    }
    heard(m, child)
  })
  // A child that exits answers what it was asked with an error.
  void (async () => {
    await proc.exited
    ended = true
    for (const [id, asked] of waiting) {
      asked.resolve({ jsonrpc: "2.0", id, error: { code: -32_603, message: `${prefix} exited` } })
    }
    waiting.clear()
  })()
  const child: Child = {
    ...app,
    request: async (method, params, sent) => {
      const id = next
      next += 1
      const asked = Promise.withResolvers<Json>()
      waiting.set(id, asked)
      if (sent) {
        sent(id)
      }
      write({ jsonrpc: "2.0", id, method, params })
      return await asked.promise
    },
    send: write,
    kill: () => {
      proc.kill()
    },
    exited: () => ended,
  }
  return child
}
