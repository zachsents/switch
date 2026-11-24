// Probe failures belong to their account. Only OS launch failures are recovered from defects.
import path from "node:path"
import { Cause, Data, Effect, Schema } from "effect"

import { acpEnvironment } from "./acp-environment.ts"
import type { Host } from "./hosts.ts"
import { lines, rpc } from "./provider.ts"

export class ProbeUnavailable extends Data.TaggedError("ProbeUnavailable")<{
  readonly problem: string
}> {}
export const spawnProbe = (host: Host, argv: readonly string[]) =>
  host.machine.spawn(argv, { cwd: host.machine.home, env: host.machine.env }).pipe(
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause)
      const code: unknown =
        typeof error === "object" && error !== null ? Reflect.get(error, "code") : ""
      if (code === "ENOENT" || code === "EACCES" || code === "ENOEXEC") {
        return Effect.fail(
          new ProbeUnavailable({
            problem: code === "ENOENT" ? "Not installed" : "Can't launch provider",
          }),
        )
      }
      return Effect.failCause(cause)
    }),
  )
export const readProbe = (host: Host, argv: readonly string[]) =>
  Effect.gen(function* reading() {
    const proc = yield* spawnProbe(host, argv)
    return yield* Effect.tryPromise({
      try: async () => {
        const stdout = new Response(proc.stdout).text()
        const stderr = new Response(proc.stderr).text()
        const [text, error, code] = await Promise.all([stdout, stderr, proc.exited])
        if (code !== 0) {
          throw new ProbeUnavailable({
            problem: /not logged in|not signed in|unauthenticated/iu.test(error)
              ? "Not signed in"
              : "Not connected",
          })
        }
        return text
      },
      catch: (error) =>
        error instanceof ProbeUnavailable
          ? error
          : new ProbeUnavailable({ problem: "Not connected" }),
    }).pipe(
      Effect.timeout("15 seconds"),
      Effect.ensuring(
        Effect.sync(() => {
          proc.kill()
        }),
      ),
    )
  })
const statusSchema = Schema.Struct({
  result: Schema.Struct({
    available: Schema.Boolean,
    problem: Schema.String,
    models: Schema.Array(Schema.String),
  }),
})
export const cursorProbe = (host: Host) =>
  Effect.gen(function* probing() {
    const runtime =
      host.machine.env.SWITCH_PROVIDER_RUNTIME ??
      path.join(host.machine.home, ".switch", "current", "provider-runtime")
    const proc = yield* spawnProbe(host, [
      path.join(runtime, "node"),
      path.join(runtime, "cursor-worker.mjs"),
    ])
    const got = Promise.withResolvers<typeof statusSchema.Type.result>()
    void lines(proc.stdout, (value) => {
      const parsed = Schema.decodeUnknownOption(statusSchema)(value)
      if (parsed._tag === "Some") {
        got.resolve(parsed.value.result)
      }
    }).finally(() => {
      got.resolve({ available: false, models: [], problem: "Cursor runtime unavailable" })
    })
    void proc.stderr
      .pipeTo(
        new WritableStream({
          write() {
            /* Discard account diagnostics. */
          },
        }),
      )
      .catch(() => {
        /* empty */
      })
    proc.write(
      `${JSON.stringify({ id: 1, method: "status", params: { configDir: host.configDir } })}\n`,
    )
    return yield* Effect.promise(async () => await got.promise).pipe(
      Effect.timeout("15 seconds"),
      Effect.ensuring(
        Effect.sync(() => {
          proc.kill()
        }),
      ),
    )
  })
const json = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))
const object = (value: unknown): Record<string, unknown> => {
  const decoded = json(value)
  return decoded._tag === "Some" ? decoded.value : {}
}
export const acpProbe = (
  host: Host,
  command: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
) =>
  Effect.gen(function* probing() {
    const proc = yield* spawnProbe(
      { ...host, machine: { ...host.machine, env: acpEnvironment(host.machine, environment) } },
      [command, ...args],
    )
    const { request, answer, close } = rpc((message) => {
      proc.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
    })
    void lines(proc.stdout, (value) => {
      const message = object(value)
      if (typeof message.id === "number") {
        answer(message.id, message)
      }
    }).finally(() => {
      close({ error: { message: "Provider exited" } })
    })
    void proc.stderr
      .pipeTo(
        new WritableStream({
          write() {
            /* Discard account diagnostics. */
          },
        }),
      )
      .catch(() => {
        /* empty */
      })
    return yield* Effect.tryPromise({
      try: async () => {
        const reply = await request("initialize", {
          protocolVersion: 1,
          clientInfo: { name: "switch", version: "1" },
          clientCapabilities: {},
        })
        if (reply.error !== undefined) {
          throw new Error("Initialize failed")
        }
        const auth = object(reply.result).authMethods
        // Initialize is deliberately insufficient evidence of a paid sign-in. Do not launch an
        // authentication flow or a session with native hooks as a health-check side effect.
        return {
          available: true,
          models: ["default"],
          problem:
            Array.isArray(auth) && auth.length > 0 ? "Sign-in unchecked" : "Connect provider",
        }
      },
      catch: () => new ProbeUnavailable({ problem: "Not connected" }),
    }).pipe(
      Effect.timeout("15 seconds"),
      Effect.ensuring(
        Effect.sync(() => {
          proc.kill()
        }),
      ),
    )
  })
