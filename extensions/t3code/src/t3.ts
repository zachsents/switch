// A local T3 Code server, through its MCP endpoint. Where it listens is in its runtime file; the
// extension holds a read-only client session minted by T3's own CLI, kept in a file of its own and
// renewed before it expires. Writes go through T3's CLI (`t3 thread`), which signs in as the
// machine's owner for each command: a session the CLI issues can't act on a full-access thread.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { Data, Effect, Option, Schema } from "effect"
import { writeFileAtomic } from "switch-ext-kit"

const T3_HOME = process.env.T3CODE_HOME ?? path.join(homedir(), ".t3")
const RUNTIME_FILE = path.join(T3_HOME, "userdata", "server-runtime.json")
const CLI = path.join(T3_HOME, "bin", "t3")
const PROTOCOL = "2025-06-18"
const SESSION_TTL = "30d"
/** Renewed this long before it runs out. */
const RENEW = Temporal.Duration.from({ hours: 48 })

export class Unreachable extends Data.TaggedError("Unreachable")<{
  readonly reason: string
  /** T3 Code simply isn't running: nothing is wrong. */
  readonly off?: boolean
}> {}

const Runtime = Schema.Struct({ origin: Schema.String, pid: Schema.optionalKey(Schema.Number) })
const SessionJson = Schema.Struct({
  sessionId: Schema.String,
  token: Schema.String,
  expiresAt: Schema.String,
})
type Session = typeof SessionJson.Type
const decodeRuntime = Schema.decodeUnknownOption(Schema.fromJsonString(Runtime))
const decodeSession = Schema.decodeUnknownSync(Schema.fromJsonString(SessionJson))
const readSession = Schema.decodeUnknownOption(Schema.fromJsonString(SessionJson))

const EnvelopeJson = Schema.Struct({
  id: Schema.optionalKey(Schema.Unknown),
  result: Schema.optionalKey(
    Schema.Struct({
      structuredContent: Schema.optionalKey(Schema.Unknown),
      content: Schema.optionalKey(
        Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) })),
      ),
      isError: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.String })),
})
type Envelope = typeof EnvelopeJson.Type
const decodeEnvelope = Schema.decodeUnknownOption(EnvelopeJson)

/** A file's text, or nothing if it can't be read. */
const readText = (file: string) => {
  try {
    return readFileSync(file, "utf-8")
  } catch {
    return ""
  }
}

const fail = (reason: string): never => {
  throw new Unreachable({ reason })
}

const off = (): never => {
  throw new Unreachable({ reason: "T3 Code isn't running", off: true })
}

/** Whether the server its runtime file names is alive; true when the file names none. */
const serverAlive = () =>
  Option.match(decodeRuntime(readText(RUNTIME_FILE)), {
    onNone: () => false,
    onSome: (r) => {
      if (r.pid === undefined) {
        return true
      }
      try {
        process.kill(r.pid, 0)
        return true
      } catch (error) {
        // EPERM: alive, but not ours to signal.
        return error instanceof Error && "code" in error && error.code === "EPERM"
      }
    },
  })

const run = async (args: readonly string[]) => {
  const proc = Bun.spawn([CLI, ...args], { stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) {
    fail(`t3 ${args.slice(0, 3).join(" ")}: ${err.trim().slice(0, 200)}`)
  }
  return out
}

const nearExpiry = (s: Session) =>
  Temporal.Instant.compare(
    Temporal.Instant.from(s.expiresAt).subtract(RENEW),
    Temporal.Now.instant(),
  ) <= 0

/** The envelopes in a response, whether it came as JSON or as an event stream. */
const envelopes = (contentType: string, text: string) => {
  const bodies = contentType.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
    : [text]
  return bodies.flatMap((b) => {
    try {
      const parsed: unknown = JSON.parse(b)
      return Option.toArray(decodeEnvelope(parsed))
    } catch {
      return []
    }
  })
}

export interface T3 {
  /** Calls one of T3's MCP tools and answers with its structured result. */
  readonly call: (name: string, args: object) => Effect.Effect<unknown, Unreachable>
  /** Runs T3's CLI and answers with what it printed. */
  readonly cli: (args: readonly string[]) => Effect.Effect<string, Unreachable>
}

/** A client of the T3 Code server on this machine; `sessionFile` keeps its credential. */
export const makeT3 = (sessionFile: string): T3 => {
  let origin: string | undefined
  let mcpSession: string | undefined
  let session: Session | undefined
  let issuing: Promise<Session> | undefined
  let nextId = 1

  const loadSession = () => Option.getOrUndefined(readSession(readText(sessionFile)))

  // One at a time, so two callers that find it expired share one new session.
  const issue = async () => {
    issuing ??= mint().finally(() => {
      issuing = undefined
    })
    return await issuing
  }

  const mint = async () => {
    const old = session ?? loadSession()
    const out = await run([
      "auth",
      "session",
      "issue",
      "--subject",
      "mcp-client",
      "--scope",
      "orchestration:read",
      "--ttl",
      SESSION_TTL,
      "--label",
      "Switch",
      "--json",
    ])
    const made = decodeSession(out)
    writeFileAtomic(sessionFile, JSON.stringify(made), 0o600)
    session = made
    mcpSession = undefined
    if (old) {
      await run(["auth", "session", "revoke", old.sessionId]).catch(() => "")
    }
    return made
  }

  const credential = async () => {
    session ??= loadSession()
    if (session === undefined || nearExpiry(session)) {
      return await issue()
    }
    return session
  }

  const where = () => {
    origin ??= Option.getOrUndefined(
      Option.map(decodeRuntime(readText(RUNTIME_FILE)), (r) => r.origin),
    )
    return origin ?? off()
  }

  const post = async (message: object) => {
    const { token } = await credential()
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    }
    if (mcpSession !== undefined) {
      headers["mcp-session-id"] = mcpSession
      headers["mcp-protocol-version"] = PROTOCOL
    }
    const url = new URL("/mcp", where())
    let response: Response
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      // It may have restarted on another port, or quit.
      origin = undefined
      mcpSession = undefined
      return serverAlive() ? fail("Can't reach T3 Code") : off()
    }
    mcpSession = response.headers.get("mcp-session-id") ?? mcpSession
    const text = await response.text()
    return {
      status: response.status,
      found: envelopes(response.headers.get("content-type") ?? "", text),
    }
  }

  const initialize = async () => {
    mcpSession = undefined
    const r = await post({
      jsonrpc: "2.0",
      id: nextId,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "switch-t3code", version: "1" },
      },
    })
    nextId += 1
    if (r.status === 401) {
      session = undefined
      await issue()
      return false
    }
    if (r.status !== 200) {
      fail(`T3 Code answered ${r.status}`)
    }
    await post({ jsonrpc: "2.0", method: "notifications/initialized" })
    return true
  }

  const request = async (name: string, args: object): Promise<Envelope | undefined> => {
    if (mcpSession === undefined && !(await initialize()) && !(await initialize())) {
      fail("T3 Code refused the session")
    }
    const id = nextId
    nextId += 1
    const r = await post({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    })
    if (r.status === 401) {
      await issue()
      return undefined
    }
    if (r.status === 404 || r.status === 400) {
      // The server forgot the MCP session, as it does when it restarts.
      mcpSession = undefined
      return undefined
    }
    return r.found.find((e) => e.id === id) ?? fail(`T3 Code answered ${r.status}`)
  }

  const callOnce = async (name: string, args: object) => {
    const envelope = (await request(name, args)) ?? (await request(name, args))
    if (envelope === undefined) {
      return fail(`${name}: no answer`)
    }
    if (envelope.error) {
      return fail(`${name}: ${envelope.error.message}`)
    }
    const { result } = envelope
    if (result?.isError === true || result?.structuredContent === undefined) {
      return fail(`${name}: ${(result?.content?.[0]?.text ?? "failed").slice(0, 300)}`)
    }
    return result.structuredContent
  }

  return {
    call: (name, args) =>
      Effect.tryPromise({
        try: async () => await callOnce(name, args),
        catch: (e) => (e instanceof Unreachable ? e : new Unreachable({ reason: String(e) })),
      }),
    cli: (args) =>
      Effect.tryPromise({
        try: async () => await run(args),
        catch: (e) => (e instanceof Unreachable ? e : new Unreachable({ reason: String(e) })),
      }),
  }
}
