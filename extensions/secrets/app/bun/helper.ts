// The native helper (app/helper/main.swift, built into the bundle by scripts/app.sh): the Mac's own
// check (Touch ID, else its password), the clipboard marked concealed, and sleep, screen lock
// and idle. One process for the app's life, started again if it ever stops.
import { existsSync } from "node:fs"
import path from "node:path"
import { Option, Schema } from "effect"

const BINARY = [
  path.resolve(import.meta.dir, "..", "helper", "secrets-helper"),
  path.resolve(process.cwd(), "..", "Resources", "app", "helper", "secrets-helper"),
].find((file) => existsSync(file))

const Said = Schema.Union([
  Schema.Struct({
    id: Schema.Finite,
    ok: Schema.Boolean,
    error: Schema.optionalKey(Schema.String),
    count: Schema.optionalKey(Schema.Finite),
  }),
  Schema.Struct({
    event: Schema.Literals(["ready", "lock", "idle"]),
  }),
])
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Said))

type Answer = Extract<typeof Said.Type, { id: number }>
export type HelperEvent = Extract<typeof Said.Type, { event: string }>

const waiting = new Map<number, (a: Answer) => void>()
const listeners = new Set<(e: HelperEvent) => void>()
let next = 1
let child: Bun.Subprocess<"pipe", "pipe", "inherit"> | null = null

const read = async (stdout: ReadableStream<Uint8Array>) => {
  let buffered = ""
  const text = new TextDecoder()
  for await (const chunk of stdout) {
    buffered += text.decode(chunk, { stream: true })
    const lines = buffered.split("\n")
    buffered = lines.pop() ?? ""
    for (const said of lines.map((l) => decode(l)).filter(Option.isSome)) {
      const v = said.value
      if ("id" in v) {
        waiting.get(v.id)?.(v)
        waiting.delete(v.id)
      } else {
        for (const l of listeners) {
          l(v)
        }
      }
    }
  }
}

/** When it stops, whatever waited on it fails, and it starts again. */
const stopped = async (proc: { readonly exited: Promise<number> }) => {
  await proc.exited
  child = null
  for (const [id, done] of waiting) {
    done({ id, ok: false, error: "The helper stopped" })
  }
  waiting.clear()
  setTimeout(() => {
    start()
  }, 1000)
}

const start = (): Bun.Subprocess<"pipe", "pipe", "inherit"> | null => {
  if (BINARY === undefined) {
    return null
  }
  const proc = Bun.spawn([BINARY], { stdin: "pipe", stdout: "pipe", stderr: "inherit" })
  void read(proc.stdout)
  void stopped(proc)
  child = proc
  return proc
}

/** Asks the helper; its answer, or what went wrong, thrown. */
const ask = async (op: string, args: Record<string, unknown> = {}): Promise<Answer> => {
  const proc = child ?? start()
  if (!proc) {
    throw new Error("No helper in this build")
  }
  const id = next
  next += 1
  const { promise: answered, resolve } = Promise.withResolvers<Answer>()
  waiting.set(id, resolve)
  void proc.stdin.write(`${JSON.stringify({ ...args, id, op })}\n`)
  void proc.stdin.flush()
  const a = await answered
  if (!a.ok) {
    throw new Error(a.error ?? "Didn't go through")
  }
  return a
}

/** Starts the helper and hears its events. */
export const onHelper = (listener: (e: HelperEvent) => void) => {
  listeners.add(listener)
  if (!child) {
    start()
  }
}

/** The Mac's own check: Touch ID, else its password. Throws if the user didn't pass it. */
export const confirm = async (reason: string) => {
  await ask("auth", { reason })
}

/** Puts `text` on the clipboard, marked concealed; the clipboard's count after. */
export const copyConcealed = async (text: string) => {
  const copied = await ask("copy", { text })
  return copied.count ?? -1
}

/** Empties the clipboard if it still holds the copy made at `count`. */
export const clearClipboard = async (count: number) => {
  await ask("clear", { count })
}
