// `switch sb`: the parts of Switchboard's `sb` that old appendages still call, over the core's HTTP
// port, printing what `sb` printed so they read it as they did. A host puts it on a shimmed
// extension's PATH as `sb`, with SWITCH_CORE set. Blobs, requests (an extension's tool), the few
// queries they ask, whoami, notify and cp; asks and waits aren't in Switch.
import { cpSync, existsSync, mkdirSync, statSync } from "node:fs"
import path from "node:path"

const core = process.env.SWITCH_CORE ?? "http://127.0.0.1:4871"
const instance = process.env.SB_INSTANCE ?? "sb@local"
const [extension = "sb", here = "local"] = instance.split("@")
const machine = process.env.SWITCH_MACHINE ?? here

class FailedError extends Error {
  override readonly name = "FailedError"
}

// The extension's own credential, which its host gave it.
const at = (pathname: string) => {
  const url = new URL(pathname, core)
  const token = process.env.SWITCH_TOKEN
  if (token !== undefined) {
    url.searchParams.set("token", token)
  }
  return url.toString()
}

const pretty = (v: unknown) => {
  process.stdout.write(`${JSON.stringify(v, null, 2)}\n`)
}
const line = (v: unknown) => {
  process.stdout.write(`${JSON.stringify(v)}\n`)
}

/** `--name value` flags and the words around them. */
const parse = (args: readonly string[]) => {
  const flags = new Map<string, string>()
  const words: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? ""
    if (a.startsWith("-") && a.length > 1) {
      flags.set(a.replace(/^-+/u, ""), args[i + 1] ?? "")
      i += 1
    } else {
      words.push(a)
    }
  }
  return { flags, words }
}

const seconds = (said: string | undefined, fallback: number) => {
  const n = Number((said ?? "").replace(/s$/u, ""))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const hashOf = (ref: string) => ref.replace(/^sha256:/u, "")

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const putBytes = async (body: Blob, type: string) => {
  const res = await fetch(at("/blobs"), {
    method: "PUT",
    headers: { "Content-Type": type || "application/octet-stream" },
    body,
  })
  const said: unknown = await res.json().catch(() => ({}))
  if (!res.ok || !isRecord(said) || typeof said.hash !== "string") {
    throw new FailedError(`blob put: ${isRecord(said) ? String(said.error) : res.status}`)
  }
  return { blob: `sha256:${said.hash}`, bytes: Number(said.bytes) }
}

const blob = async (args: readonly string[]) => {
  const [verb, ...rest] = args
  const { flags, words } = parse(rest)
  if (verb === "put") {
    const file = words[0] ?? ""
    if (!existsSync(file)) {
      throw new FailedError(`blob put: no file ${file}`)
    }
    const type = flags.get("type")
    const stored = await putBytes(Bun.file(file), type ?? "")
    pretty({ blob: stored.blob, ...(type !== undefined && { type }), bytes: stored.bytes })
    return
  }
  if (verb === "get") {
    const res = await fetch(at(`/blobs/${hashOf(words[0] ?? "")}`))
    if (!res.ok) {
      throw new FailedError(`blob get: ${res.status === 404 ? "gone" : res.status}`)
    }
    const out = flags.get("o") ?? flags.get("output")
    if (out === undefined) {
      process.stdout.write(new Uint8Array(await res.arrayBuffer()))
    } else {
      mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
      await Bun.write(out, res)
    }
    return
  }
  throw new FailedError(`blob ${verb ?? ""}: put or get`)
}

/** An appendage's action as an extension's tool: Chrome's on a Mac is the browser extension's `act`. */
const toolOf = (target: string, action: string) => {
  const [name = "", on = "local"] = target.split("@")
  const mac = on === "local" ? machine : on
  if (name === "macos" && action === "browser") {
    return { app: "browser", tool: "act" }
  }
  if (name === "macos") {
    return { app: `macos-${mac}`, tool: action }
  }
  return { app: name, tool: action }
}

interface Content {
  readonly type?: string
  readonly text?: string
  readonly data?: string
  readonly mimeType?: string
}

const contentOf = (v: unknown): Content[] =>
  Array.isArray(v)
    ? v.filter(isRecord).map((c) => ({
        ...(typeof c.type === "string" && { type: c.type }),
        ...(typeof c.text === "string" && { text: c.text }),
        ...(typeof c.data === "string" && { data: c.data }),
        ...(typeof c.mimeType === "string" && { mimeType: c.mimeType }),
      }))
    : []

const call = async (app: string, tool: string, args: unknown, timeout: number) => {
  const res = await fetch(at(`/widgets/${app}/${tool}`), {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify(args ?? {}),
    signal: AbortSignal.timeout(timeout * 1000),
  })
  const said: unknown = await res.json().catch(() => ({}))
  return isRecord(said) ? said : {}
}

const jsonOr = (text: string): unknown => {
  try {
    const v: unknown = JSON.parse(text)
    return typeof v === "object" && v !== null ? v : text
  } catch {
    return text
  }
}

const request = async (args: readonly string[]) => {
  const { flags, words } = parse(args)
  const [target = "", action = ""] = words
  const { app, tool } = toolOf(target, action)
  const started = Date.now()
  const given: unknown = JSON.parse(flags.get("args") ?? "{}")
  const result = await call(app, tool, given, seconds(flags.get("timeout"), 600))
  const content = contentOf(result.content)
  const text = content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n")
  const ok = result.isError !== true
  const images = await Promise.all(
    content
      .filter((x) => x.type === "image" && x.data !== undefined)
      .map(async (c) => {
        const type = c.mimeType ?? "image/png"
        const stored = await putBytes(new Blob([Buffer.from(c.data ?? "", "base64")]), type)
        return { blob: stored.blob, type }
      }),
  )
  const value = result.structuredContent ?? jsonOr(text)
  const output = images.length > 0 ? { text, output: value, images } : value
  pretty({
    ok,
    output: ok ? output : null,
    error: ok ? null : text || `No tool ${app}_${tool}`,
    duration_ms: Date.now() - started,
  })
  if (!ok) {
    process.exitCode = 1
  }
}

const query = async (args: readonly string[]) => {
  const q = args.join(" ")
  const res = await fetch(at("/query"), {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ q, source: extension }),
  })
  const said: unknown = await res.json().catch(() => ({}))
  if (!res.ok || !isRecord(said)) {
    throw new FailedError(`query: ${isRecord(said) ? String(said.error) : res.status}`)
  }
  line(said)
}

const whoami = () => {
  pretty({
    instance,
    source: extension,
    scopes: { read: ["**"], write: ["**"] },
    oauth_callback: null,
  })
}

const notify = async (args: readonly string[]) => {
  const { flags, words } = parse(args)
  const result = await call(
    "iphone",
    "notify",
    { title: flags.get("title") ?? extension, body: words.join(" ") },
    60,
  )
  if (result.isError === true) {
    throw new FailedError("notify: didn't go")
  }
  pretty({ notified: ["iphone"], ids: [] })
}

/** To `<machine>:<path>` or `macos@<machine>:<path>`: here, a copy; another Mac fetches it. */
const cp = async (args: readonly string[]) => {
  const { words } = parse(args)
  const [from = "", to = ""] = words
  const colon = to.indexOf(":")
  const where = colon === -1 ? "local" : (to.slice(0, colon).split("@").at(-1) ?? "local")
  const dest = colon === -1 ? to : to.slice(colon + 1)
  if (!existsSync(from)) {
    throw new FailedError(`cp: no file ${from}`)
  }
  const folder = statSync(from).isDirectory()
  const bytes = folder ? 0 : statSync(from).size
  if (where === "local" || where === machine) {
    mkdirSync(path.dirname(dest), { recursive: true })
    cpSync(from, dest, { recursive: true })
    line({ from, to, kind: folder ? "folder" : "file", bytes })
    return
  }
  if (folder) {
    throw new FailedError("cp: a folder to another machine isn't in Switch")
  }
  const stored = await putBytes(Bun.file(from), "")
  // That Mac fetches it from the core, over the tailnet.
  const result = await call(
    `macos-${where}`,
    "exec",
    {
      command: 'mkdir -p "$(dirname "$DEST")" && curl -fsS -o "$DEST" "$URL"',
      env: { DEST: dest, URL: at(`/blobs/${hashOf(stored.blob)}`) },
      timeout_s: 900,
    },
    900,
  )
  const done = isRecord(result.structuredContent) ? result.structuredContent : {}
  if (result.isError === true || done.code !== 0) {
    throw new FailedError(`cp: ${typeof done.stderr === "string" ? done.stderr : "didn't copy"}`)
  }
  line({ from, to, kind: "file", bytes, blob: stored.blob })
}

const wait = async (args: readonly string[]) => {
  const { flags } = parse(args)
  process.stderr.write("sb wait: asks aren't in Switch; still open\n")
  await Bun.sleep(seconds(flags.get("timeout"), 3600) * 1000)
  process.exitCode = 2
}

const commands: Readonly<Record<string, (args: readonly string[]) => Promise<void> | void>> = {
  blob,
  request,
  query,
  whoami,
  notify,
  cp,
  wait,
}

export const sb = async (args: readonly string[]) => {
  const [name = "", ...rest] = args
  const run = commands[name]
  try {
    if (run === undefined) {
      throw new FailedError(`${name}: not in Switch`)
    }
    await run(rest)
  } catch (error) {
    process.stderr.write(`sb ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
