// Consent opens on this client. Only the core holds PKCE/client secrets; callback codes never
// enter the brain, chat, logs, or the webview. This loopback server lives for one consent flow.
import { Schema } from "effect"

import { ConnectionStart } from "../shared/commands.ts"
import type { Auth, ConnectionResult } from "../shared/commands.ts"
import { safeError } from "../shared/safe-error.ts"

const TIMEOUT = 10 * 60_000
const validate = Schema.decodeUnknownOption(ConnectionStart)
const result = Schema.decodeUnknownSync(
  Schema.Struct({
    isError: Schema.optionalKey(Schema.Boolean),
    content: Schema.optionalKey(
      Schema.Array(Schema.Struct({ text: Schema.optionalKey(Schema.String) })),
    ),
    structuredContent: Schema.optionalKey(Schema.Unknown),
  }),
)
const consent = Schema.decodeUnknownOption(
  Schema.Struct({
    structuredContent: Schema.Struct({
      kind: Schema.optionalKey(Schema.String),
      url: Schema.String,
    }),
  }),
)
const finished = Schema.decodeUnknownOption(
  Schema.Struct({
    structuredContent: Schema.Struct({ connected: Schema.Literal(true), id: Schema.String }),
  }),
)

const call = async (
  auth: Extract<Auth, { token: string }>,
  tool: string,
  input: unknown,
  signal: AbortSignal,
) => {
  const response = await fetch(new URL(`/widgets/connections/${tool}`, auth.core), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${auth.token}` },
    body: JSON.stringify(input),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  })
  if (!response.ok) {
    throw new Error(`Connection request failed (${response.status}). Try again.`)
  }
  const raw: unknown = await response.json()
  const checked = result(raw)
  if (checked.isError === true) {
    throw new TypeError(
      checked.content?.find((item) => item.text !== undefined && item.text !== "")?.text ??
        "Connection failed. Try again.",
    )
  }
  return raw
}

const failure = (error: unknown): ConnectionResult => ({
  ok: false,
  error: safeError(error instanceof Error ? error : new Error("Connection failed. Try again.")),
})

const callbackInput = (url: URL, expected: string) => {
  if (
    expected === "" ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.get("state") !== expected
  ) {
    return null
  }
  const code = url.searchParams.get("code")
  const error = url.searchParams.get("error")
  if (
    code !== null &&
    code !== "" &&
    code.length <= 8192 &&
    url.searchParams.getAll("code").length === 1 &&
    error === null
  ) {
    return { state: expected, code }
  }
  if (error !== null && /^[a-z_]{1,80}$/u.test(error) && code === null) {
    return { state: expected, error }
  }
  return null
}

const externalUrl = (value: string) => {
  const url = new URL(value)
  const local = url.protocol === "http:" && url.hostname === "127.0.0.1"
  if ((url.protocol !== "https:" && !local) || url.username !== "" || url.password !== "") {
    throw new Error("Invalid sign-in link. Try connecting again.")
  }
  return url
}

export const connectionRelay = (authNow: () => Auth | null, open: (url: string) => void) => {
  const pending = new Map<string, () => void>()
  const connect = async (raw: ConnectionStart): Promise<ConnectionResult> => {
    const parsed = validate(raw)
    const auth = authNow()
    if (parsed._tag === "None") {
      return failure(new Error("Invalid connection request."))
    }
    if (auth === null || !("token" in auth)) {
      return failure(new Error("Pair with the server before connecting."))
    }
    const input = parsed.value
    pending.get(input.provider)?.()
    const abort = new AbortController()
    const waiting = Promise.withResolvers<ConnectionResult>()
    const cancel = () => {
      abort.abort(new Error("Sign-in cancelled."))
      waiting.resolve(failure(new Error("Sign-in cancelled.")))
    }
    pending.set(input.provider, cancel)
    let expected = ""
    let used = false
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        if (request.method !== "GET" || url.pathname !== "/oauth/callback") {
          return new Response("Not found", { status: 404 })
        }
        const callback = callbackInput(url, expected)
        if (used || callback === null) {
          return new Response("Not connected", { status: 400 })
        }
        used = true
        let answer: ConnectionResult
        try {
          const value = await call(auth, "finish", callback, abort.signal)
          if (finished(value)._tag === "None") {
            throw new Error("Connection not verified. Connect again.")
          }
          answer = { ok: true, value }
        } catch (error) {
          answer = failure(error)
        }
        // Let the fixed response reach the browser before the request's finally closes the listener.
        setTimeout(() => {
          waiting.resolve(answer)
        }, 50)
        return new Response(answer.ok ? "Connected" : "Not connected", {
          headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
        })
      },
    })
    const timer = setTimeout(() => {
      const error = new Error("Sign-in timed out. Connect again.")
      abort.abort(error)
      waiting.resolve(failure(error))
    }, TIMEOUT)
    try {
      const { tool, ...args } = input
      const answer = await call(
        auth,
        tool,
        { ...args, redirectUri: `http://127.0.0.1:${server.port}/oauth/callback` },
        abort.signal,
      )
      const url = consent(answer)
      if (url._tag === "None") {
        return { ok: true, value: answer }
      }
      const target = externalUrl(url.value.structuredContent.url)
      if (url.value.structuredContent.kind !== "oauth") {
        open(target.href)
        return { ok: true, value: { structuredContent: { opened: true } } }
      }
      expected = target.searchParams.get("state") ?? ""
      if (expected === "" || target.searchParams.getAll("state").length !== 1) {
        throw new Error("Invalid consent response. Try connecting again.")
      }
      open(target.href)
      return await waiting.promise
    } catch (error) {
      return failure(error)
    } finally {
      clearTimeout(timer)
      void server.stop(false)
      if (pending.get(input.provider) === cancel) {
        pending.delete(input.provider)
      }
    }
  }
  return {
    connect,
    cancel: ({ provider }: { provider: string }) => {
      pending.get(provider)?.()
    },
    close: () => {
      for (const cancel of pending.values()) {
        cancel()
      }
    },
  }
}
