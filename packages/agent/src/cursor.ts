import path from "node:path"
import type { Subscription } from "@switch/models"
import { Effect, Schema } from "effect"

import { cursorEvent } from "./cursor-protocol.ts"
import { discardStderr, channel, childEnv, inline, lines, rpc } from "./provider.ts"
import type { Adapter, Runner } from "./provider.ts"

export const cursorAdapter = (provider: Subscription): Adapter => ({
  provider,
  start: (s) =>
    Effect.gen(function* starting() {
      const runtime =
        s.host.machine.env.SWITCH_PROVIDER_RUNTIME ??
        path.join(s.host.machine.home, ".switch", "current", "provider-runtime")
      const worker = path.join(runtime, "cursor-worker.mjs")
      if (!(yield* s.host.machine.exists(worker))) {
        return yield* Effect.die(new Error("Cursor runtime missing"))
      }
      const proc = yield* s.host.machine.spawn(
        [s.host.machine.env.SWITCH_NODE ?? path.join(runtime, "node"), worker],
        {
          cwd: s.cwd,
          env: childEnv(
            s.host.machine,
            /^(?:CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_CONFIG_DIR|AI_GATEWAY_|ANTHROPIC_|VERCEL_OIDC)/u,
            {},
          ),
        },
      )
      return yield* Effect.gen(function* opening() {
        const out = channel()
        const {
          request: rawRequest,
          answer,
          close,
        } = rpc((message) => {
          proc.write(`${JSON.stringify(message)}\n`)
        })
        const request = async (method: string, params: unknown) => {
          const expired = Promise.withResolvers<Record<string, unknown>>()
          const timer = setTimeout(() => {
            proc.kill()
            expired.resolve({ error: { message: "Cursor request timed out" } })
          }, 30_000)
          try {
            const reply = await Promise.race([rawRequest(method, params), expired.promise])
            if (reply.error !== undefined) {
              throw new Error(
                method === "open"
                  ? "Cursor: Not signed in or unavailable"
                  : `Cursor ${method} failed`,
              )
            }
            return reply
          } finally {
            clearTimeout(timer)
          }
        }
        const record = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))
        const runnerProc = discardStderr(proc)
        void lines(proc.stdout, (value) => {
          const m = record(value)
          if (m._tag !== "Some") {
            return
          }
          if (typeof m.value.id === "number") {
            answer(m.value.id, m.value)
            return
          }
          const event = Schema.decodeUnknownOption(cursorEvent)(m.value.event)
          if (event._tag === "Some") {
            out.push(event.value)
          }
        }).finally(() => {
          close({ error: { message: "Cursor exited" } })
          out.end()
        })
        const history = yield* s.history()
        const reply = yield* Effect.promise(
          async () =>
            await request("open", {
              cwd: s.cwd,
              session: s.session,
              model: s.model,
              effort: s.effort,
              system: s.system,
              permissions: s.permissions,
              mcp: s.mcp,
              configDir: s.host.configDir,
              history: history.map((m) => `${m.role}: ${JSON.stringify(m.content)}`).join("\n\n"),
            }),
        )
        const result = record(reply.result)
        if (result._tag !== "Some" || typeof result.value.session !== "string") {
          return yield* Effect.die(new Error("Cursor session missing"))
        }
        return {
          proc: runnerProc,
          session: result.value.session,
          messages: out.messages,
          send: (text, uuid, priority, images = []) =>
            Effect.promise(async () => {
              const data = await Effect.runPromise(inline(images))
              await request("send", {
                text,
                uuid,
                priority,
                images: data.map((image) => ({ data: image.data, mimeType: image.type })),
              })
            }),
          interrupt: Effect.promise(async () => {
            await request("cancel", {})
          }),
          effort: (effort) =>
            Effect.promise(async () => {
              await request("effort", { effort })
            }),
        } satisfies Runner
      }).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            try {
              // A pending SDK open can block the worker's graceful SIGTERM handler.
              proc.kill("SIGKILL")
            } catch {
              // Preserve the startup failure if the process has already exited.
            }
          }),
        ),
      )
    }),
})
