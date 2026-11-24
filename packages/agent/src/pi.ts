// Native Pi RPC, following T3 Code's provider-pi adapter (MIT, T3 Tools Inc.).
// Pi owns its login, extensions, models and session files; Switch injects only its MCP bridge.
import path from "node:path"
import type { Subscription } from "@switch/models"
import { Effect, Schema } from "effect"

import type { CliBlock, CliModelUsage } from "./claude.ts"
import { PI_EXTENSION } from "./pi-extension.ts"
import { discardStderr, channel, childEnv, inline, lifecycle, lines } from "./provider.ts"
import type { Adapter } from "./provider.ts"

const decode = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))
const obj = (value: unknown): Record<string, unknown> => {
  const decoded = decode(value)
  return decoded._tag === "Some" ? decoded.value : {}
}
const str = (value: unknown) => (typeof value === "string" ? value : "")
const num = (value: unknown) => (typeof value === "number" ? value : 0)
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const textOf = (content: unknown) =>
  array(content)
    .map((part) => str(obj(part).text))
    .join("\n")
const DROP =
  /^(?:CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID|CLAUDE_CONFIG_DIR|AI_AGENT|AI_GATEWAY_|VERCEL_OIDC|SWITCH_PI_)/u
const thinking = (effort: string) => (effort === "max" ? "xhigh" : effort)

/** The routing owner supplies the registered subscription, avoiding another driver registry. */
export const piAdapter = (provider: Subscription): Adapter => ({
  provider,
  start: (s) =>
    Effect.gen(function* starting() {
      const extension = path.join(s.host.machine.home, ".switch", "providers", "pi-mcp.ts")
      yield* s.host.machine.writeFile(extension, PI_EXTENSION)
      const resumed = s.session !== null && (yield* s.host.machine.exists(s.session))
      const history = resumed ? [] : yield* s.history()
      let preface = history
        .map(
          (m) =>
            `[${m.role}]\n${m.content.map((b) => (b.type === "text" ? str(b.text) : JSON.stringify(b))).join("\n")}`,
        )
        .join("\n\n")
      const env = childEnv(s.host.machine, DROP, {
        SWITCH_PI_MCP: JSON.stringify(s.mcp),
        SWITCH_PI_MODE: s.permissions.mode,
        ...(s.host.configDir === undefined ? {} : { PI_CODING_AGENT_DIR: s.host.configDir }),
      })
      const proc = yield* s.host.machine.spawn(
        [
          "pi",
          "--mode",
          "rpc",
          "--extension",
          extension,
          "--append-system-prompt",
          s.system,
          ...(resumed && s.session !== null ? ["--session", s.session] : []),
          ...(s.model === "default" ? [] : ["--model", s.model]),
          ...(s.effort ? ["--thinking", thinking(s.effort)] : []),
        ],
        { cwd: s.cwd, env },
      )
      const out = channel()
      const pending = new Map<string, (reply: Record<string, unknown>) => void>()
      const active = new Set<string>()
      let usage: Record<string, CliModelUsage> = {}
      let lastText = ""
      let failed = false
      let failure = ""
      let ended = false
      const write = (record: object) => {
        proc.write(`${JSON.stringify(record)}\n`)
      }
      const request = async (type: string, params: object = {}) => {
        if (ended) {
          throw new Error("Pi exited")
        }
        const id = crypto.randomUUID()
        const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>()
        pending.set(id, resolve)
        const timer = setTimeout(() => {
          pending.delete(id)
          proc.kill()
          resolve({ success: false, error: `Pi ${type} timed out` })
        }, 30_000)
        try {
          write({ id, type, ...params })
          const reply = await promise
          if (reply.success !== true) {
            throw new Error(str(reply.error) || `Pi ${type} failed`)
          }
          return obj(reply.data)
        } finally {
          clearTimeout(timer)
          pending.delete(id)
        }
      }
      const complete = () => {
        if (active.size === 0) {
          return
        }
        for (const id of active) {
          out.push(lifecycle(id, "completed"))
        }
        active.clear()
        out.push({
          type: "result",
          is_error: failed,
          result: failed ? failure : lastText,
          model_usage_since_last_result: { ...usage },
        })
        usage = {}
      }
      const recordUsage = (message: Record<string, unknown>) => {
        const model = str(message.model) || s.model
        const u = obj(message.usage)
        const previous = usage[model]
        usage[model] = {
          inputTokens: (previous?.inputTokens ?? 0) + num(u.input),
          outputTokens: (previous?.outputTokens ?? 0) + num(u.output),
          cacheReadInputTokens: (previous?.cacheReadInputTokens ?? 0) + num(u.cacheRead),
          cacheCreationInputTokens: (previous?.cacheCreationInputTokens ?? 0) + num(u.cacheWrite),
          costUSD: (previous?.costUSD ?? 0) + num(obj(u.cost).total),
        }
      }
      const event = (value: unknown) => {
        const m = obj(value)
        switch (m.type) {
          case "response": {
            pending.get(str(m.id))?.(m)
            break
          }
          case "message_update": {
            const delta = obj(m.assistantMessageEvent)
            if (delta.type === "text_delta") {
              out.push({
                type: "stream_event",
                event: {
                  type: "content_block_delta",
                  delta: { type: "text_delta", text: str(delta.delta) },
                },
              })
            }
            break
          }
          case "message_end": {
            const message = obj(m.message)
            if (message.role !== "assistant") {
              break
            }
            const text = textOf(message.content)
            if (text) {
              lastText = text
              out.push({ type: "assistant", message: { content: [{ type: "text", text }] } })
            }
            recordUsage(message)
            if (message.stopReason === "error") {
              failed = true
              failure = str(message.errorMessage) || "Pi request failed"
              if (/rate.?limit|usage.?limit|quota|429/iu.test(failure)) {
                out.push({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } })
              }
            }
            break
          }
          case "tool_execution_start": {
            out.push({
              type: "assistant",
              message: {
                content: [
                  { type: "tool_use", id: str(m.toolCallId), name: str(m.toolName), input: m.args },
                ],
              },
            })
            break
          }
          case "tool_execution_end": {
            const block: CliBlock = {
              type: "tool_result",
              tool_use_id: str(m.toolCallId),
              content: textOf(obj(m.result).content),
              is_error: m.isError === true,
            }
            out.push({ type: "user", message: { content: [block] } })
            break
          }
          case "agent_end": {
            complete()
            break
          }
          case "extension_ui_request": {
            if (["confirm", "select", "input", "editor"].includes(str(m.method))) {
              write({ type: "extension_ui_response", id: m.id, cancelled: true })
            }
            break
          }
          default: {
            break
          }
        }
      }
      // Never retain stderr: CLI diagnostics can contain account or request data.
      const runnerProc = discardStderr(proc)
      void lines(proc.stdout, event).finally(() => {
        ended = true
        for (const resolve of pending.values()) {
          resolve({ success: false, error: "Pi exited" })
        }
        pending.clear()
        if (active.size) {
          failed = true
          failure = "Pi exited"
          complete()
        }
        out.end()
      })
      const state = yield* Effect.promise(async () => {
        try {
          return await request("get_state")
        } catch (error) {
          proc.kill()
          throw error
        }
      })
      const session = str(state.sessionFile)
      if (!session) {
        proc.kill()
        return yield* Effect.die(new Error("Pi session file missing"))
      }
      return {
        proc: runnerProc,
        session,
        messages: out.messages,
        send: (input, uuid, priority, images = []) =>
          Effect.promise(async () => {
            const busy = active.size > 0
            const text = preface ? `${preface}\n\n${input}` : input
            preface = ""
            if (!busy) {
              failed = false
              failure = ""
              lastText = ""
            }
            active.add(uuid)
            out.push(lifecycle(uuid, "started"))
            try {
              const read = await Effect.runPromise(inline(images))
              let method = "prompt"
              if (busy) {
                method = priority === "now" ? "steer" : "follow_up"
              }
              await request(method, {
                message: text,
                images: read.map((image) => ({
                  type: "image",
                  mimeType: image.type,
                  data: image.data,
                })),
              })
            } catch (error) {
              failed = true
              failure = error instanceof Error ? error.message : "Pi request failed"
              complete()
            }
          }),
        interrupt: Effect.promise(async () => {
          await request("abort")
        }),
        effort: (effort) =>
          Effect.promise(async () => {
            await request("set_thinking_level", { level: thinking(effort) })
          }),
      }
    }),
})
