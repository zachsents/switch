// ACP sessions, following T3 Code's provider-acp and provider-fx adapters (MIT, T3 Tools Inc.).
// One connection per thread; cancellation settles the prompt before another starts.
import type { Subscription } from "@switch/models"
import { Effect } from "effect"

import { acpEnvironment } from "./acp-environment.ts"
import type { CliBlock } from "./claude.ts"
import { channel, inline, lifecycle, lines, rpc } from "./provider.ts"
import type { Adapter, Image, Start } from "./provider.ts"

type Json = Record<string, unknown>
const isJson = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)
const obj = (v: unknown): Json => (isJson(v) ? v : {})
const str = (v: unknown) => (typeof v === "string" ? v : "")
const text = (value: string) => ({ type: "text", text: value })
const contentText = (v: unknown): string =>
  Array.isArray(v)
    ? v
        .map((x) => {
          const c = obj(x)
          return str(obj(c.content).text) || str(c.text)
        })
        .filter(Boolean)
        .join("\n")
    : ""

export interface AcpFlavor {
  readonly effortConfigId?: string
  readonly authMethod?: (s: Start) => string
  readonly configOptions?: (s: Start) => Readonly<Record<string, string>>
  readonly modelSelection?: boolean
  readonly resume?: boolean
  readonly steering?: boolean
  readonly systemPrompt?: boolean
  readonly initializeMeta?: Json
  readonly cancelMeta?: Json
  readonly sessionMeta?: Json
  readonly env?: (s: Start) => Readonly<Record<string, string>>
}

export const acpAdapter = (
  provider: Subscription,
  command: string,
  args: (s: Start) => readonly string[],
  flavor: AcpFlavor = {},
): Adapter => ({
  provider,
  start: (s) =>
    Effect.gen(function* starting() {
      const proc = yield* s.host.machine.spawn([command, ...args(s)], {
        cwd: s.cwd,
        env: acpEnvironment(s.host.machine, flavor.env?.(s)),
      })
      const out = channel()
      const send = (m: object) => {
        try {
          proc.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`)
        } catch {
          // Reader settles exit.
        }
      }
      const { request: rpcRequest, answer, close } = rpc(send)
      const request = async (method: string, params: unknown) => {
        if (method === "session/prompt") {
          return await rpcRequest(method, params)
        }
        const expired = Promise.withResolvers<Json>()
        const timeout = setTimeout(() => {
          proc.kill()
          expired.resolve({ error: { message: `${method} timed out` } })
        }, 30_000)
        timeout.unref()
        try {
          return await Promise.race([rpcRequest(method, params), expired.promise])
        } finally {
          clearTimeout(timeout)
        }
      }
      const checked = async (method: string, params: unknown) => {
        const reply = await request(method, params)
        if (reply.error !== undefined) {
          proc.kill()
          throw new Error(str(obj(reply.error).message))
        }
        return obj(reply.result)
      }
      let session = ""
      let said = ""
      let active: Promise<void> | null = null
      let steering = false
      let instructions = ""
      let first = true
      const block = (role: "assistant" | "user", content: CliBlock) => {
        out.push({ type: role, message: { content: [content] } })
      }
      const update = (raw: Json) => {
        const u = obj(raw.update)
        switch (u.sessionUpdate) {
          case "agent_message_chunk": {
            const delta = str(obj(u.content).text)
            said += delta
            out.push({
              type: "stream_event",
              event: { type: "content_block_delta", delta: { type: "text_delta", text: delta } },
            })
            break
          }
          case "tool_call": {
            if (said !== "") {
              block("assistant", { type: "text", text: said })
              said = ""
            }
            const id = str(u.toolCallId)
            const name = str(u.title) || str(u.kind) || "Tool"
            block("assistant", { type: "tool_use", id, name, input: u.rawInput ?? null })
            if (u.status === "completed" || u.status === "failed") {
              block("user", {
                type: "tool_result",
                tool_use_id: id,
                content: contentText(u.content),
                is_error: u.status === "failed",
              })
            }
            break
          }
          case "tool_call_update": {
            if (u.status === "completed" || u.status === "failed") {
              block("user", {
                type: "tool_result",
                tool_use_id: str(u.toolCallId),
                content: contentText(u.content),
                is_error: u.status === "failed",
              })
            }
            break
          }
          default: {
            break
          }
        }
      }
      void lines(proc.stdout, (raw) => {
        const m = obj(raw)
        if (m.method === undefined) {
          if (typeof m.id === "number") {
            answer(m.id, m)
          }
        } else if (m.method === "session/update") {
          update(obj(m.params))
        } else if (m.id !== undefined) {
          if (m.method === "session/request_permission") {
            const { options } = obj(m.params)
            const allow =
              Array.isArray(options) && s.permissions.mode === "bypassPermissions"
                ? options.map(obj).find((o) => o.kind === "allow_once")
                : undefined
            send({
              id: m.id,
              result: {
                outcome: allow
                  ? { outcome: "selected", optionId: allow.optionId }
                  : { outcome: "cancelled" },
              },
            })
          } else {
            send({
              id: m.id,
              error: { code: -32_601, message: `Switch doesn't answer ${str(m.method)}` },
            })
          }
        }
      }).finally(() => {
        close({ error: { message: `${command} exited` } })
        out.end()
      })
      const configure = async () => {
        const config = flavor.configOptions?.(s) ?? {}
        if (config.model !== undefined) {
          await checked("session/set_config_option", {
            sessionId: session,
            configId: "model",
            value: config.model,
          })
        } else if (flavor.modelSelection === true && s.model !== "default") {
          await checked("session/set_model", { sessionId: session, modelId: s.model })
        }
        await Promise.all(
          Object.entries(config)
            .filter(([id]) => id !== "model")
            .map(
              async ([configId, value]) =>
                await checked("session/set_config_option", { sessionId: session, configId, value }),
            ),
        )
      }
      yield* Effect.promise(async () => {
        const init = await checked("initialize", {
          protocolVersion: 1,
          clientInfo: { name: "switch", version: "0.0.0" },
          clientCapabilities: { session: { notices: true } },
          ...(flavor.initializeMeta && { _meta: flavor.initializeMeta }),
        })
        const caps = obj(init.agentCapabilities)
        steering = flavor.steering === true && obj(obj(caps._meta).fx).steering === true
        const mcpServers = Object.entries(s.mcp).map(([name, m]) => ({
          name,
          type: "http",
          url: m.url,
          headers:
            m.token === undefined ? [] : [{ name: "Authorization", value: `Bearer ${m.token}` }],
        }))
        if (flavor.authMethod) {
          await checked("authenticate", { methodId: flavor.authMethod(s) })
        }
        const canResume =
          flavor.resume === true && obj(caps.sessionCapabilities).resume !== undefined
        const params = {
          cwd: s.cwd,
          mcpServers,
          ...(flavor.sessionMeta && { _meta: flavor.sessionMeta }),
        }
        let reply =
          s.session !== null && (canResume || caps.loadSession === true)
            ? await request(canResume ? "session/resume" : "session/load", {
                ...params,
                sessionId: s.session,
              })
            : null
        if (reply === null || reply.error !== undefined) {
          reply = await request("session/new", {
            ...params,
            ...(flavor.systemPrompt === true && { systemPrompt: [text(s.system)] }),
          })
          if (flavor.systemPrompt !== true) {
            instructions = s.system
          }
          const history = await Effect.runPromise(s.history())
          instructions +=
            history.length === 0
              ? ""
              : `\n\n<conversation>\n${history.map((m) => `${m.role}: ${JSON.stringify(m.content)}`).join("\n")}\n</conversation>`
        }
        session = str(obj(reply.result).sessionId)
        if (session === "") {
          proc.kill()
          throw new Error(str(obj(reply.error).message) || `${command} refused the session`)
        }
        await configure()
      })
      const prompt = async (input: string, uuid: string, images: readonly Image[]) => {
        const joining = active !== null && steering
        if (active !== null && !joining) {
          await active
        }
        if (!joining) {
          said = ""
        }
        const body =
          first && instructions !== ""
            ? `<instructions>\n${instructions}\n</instructions>\n\n${input}`
            : input
        first = false
        out.push(lifecycle(uuid, "started"))
        const inlineImages = await Effect.runPromise(inline(images))
        const run = (async () => {
          const reply = await request("session/prompt", {
            sessionId: session,
            prompt: [
              text(body),
              ...inlineImages.map((i) => ({
                type: "image",
                data: i.data,
                mimeType: i.type,
              })),
            ],
            ...(joining && { _meta: { fx: { steer: true } } }),
          })
          out.push(lifecycle(uuid, "completed"))
          if (joining) {
            return
          }
          if (said !== "") {
            block("assistant", { type: "text", text: said })
          }
          out.push({
            type: "result",
            is_error: reply.error !== undefined || obj(reply.result).stopReason === "refusal",
            result: reply.error === undefined ? said : str(obj(reply.error).message),
          })
        })()
        if (!joining) {
          active = run
          void run.finally(() => {
            if (active === run) {
              active = null
            }
          })
        }
      }
      return {
        proc,
        session,
        messages: out.messages,
        send: (input, uuid, _priority, images = []) =>
          Effect.promise(async () => {
            await prompt(input, uuid, images)
          }),
        interrupt: Effect.sync(() => {
          send({
            method: "session/cancel",
            params: { sessionId: session, ...(flavor.cancelMeta && { _meta: flavor.cancelMeta }) },
          })
        }),
        effort: (value) =>
          Effect.promise(async () => {
            const configId =
              flavor.effortConfigId ??
              (flavor.configOptions?.(s).effortLevel === undefined ? undefined : "effortLevel")
            if (configId !== undefined) {
              const chosen = await request("session/set_config_option", {
                sessionId: session,
                configId,
                value,
              })
              if (chosen.error !== undefined) {
                throw new Error(str(obj(chosen.error).message))
              }
            }
          }),
      }
    }),
})
