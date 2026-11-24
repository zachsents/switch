// MSP lifecycle, session MCP and item projection ported from T3 Code provider-muse (MIT).
// The zero-dependency SDK owns framing, command identities, retries and correlation.
import { Connection, MspError } from "@muse-code/sdk"
import type { Subscription } from "@switch/models"
import { Effect, Schema } from "effect"

import type { Host } from "./hosts.ts"
import { discardStderr, channel, childEnv, inline, lifecycle } from "./provider.ts"
import type { Adapter } from "./provider.ts"

const record = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))
const obj = (value: unknown): Record<string, unknown> => {
  const decoded = record(value)
  return decoded._tag === "Some" ? decoded.value : {}
}
const str = (value: unknown) => (typeof value === "string" ? value : "")
const num = (value: unknown) => (typeof value === "number" ? value : 0)
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const itemSchema = Schema.Struct({
  itemId: Schema.String,
  kind: Schema.String,
  revision: Schema.Number,
  status: Schema.String,
  turnId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  text: Schema.optionalKey(Schema.String),
  tool: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.String),
  visibleOutput: Schema.optionalKey(Schema.String),
  failureReason: Schema.optionalKey(Schema.String),
  retracted: Schema.optionalKey(Schema.Boolean),
})
type Item = typeof itemSchema.Type

/**
 * A Muse account in a home of its own. Muse keeps its login (auth.json) in `$XDG_CONFIG_HOME/muse`,
 * else `~/.config/muse`, as its bundled docs say ("Config root: `$XDG_CONFIG_HOME/muse`, else
 * `$HOME/.config/muse`"); it reads no MUSE_HOME.
 */
export const museEnv = (host: Pick<Host, "configDir">) =>
  host.configDir === undefined ? {} : { XDG_CONFIG_HOME: host.configDir }

export const museAdapter = (provider: Subscription, providerId = "meta"): Adapter => ({
  provider,
  start: (s) =>
    Effect.gen(function* starting() {
      const cwd = yield* s.host.machine.realpath(s.cwd)
      if (cwd === null) {
        return yield* Effect.die(new Error("Muse workspace missing"))
      }
      const full = s.permissions.mode === "bypassPermissions"
      const readOnly = s.permissions.mode === "plan"
      const proc = yield* s.host.machine.spawn(
        [
          "muse",
          "serve",
          "--provider",
          providerId,
          ...(readOnly
            ? ["--disable-shell", "--disable-write"]
            : ["--trust-workspace", ...(full ? ["--disable-sandbox"] : [])]),
        ],
        {
          cwd,
          env: childEnv(
            s.host.machine,
            /^(?:CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_CONFIG_DIR|META_API_KEY|AI_GATEWAY_|ANTHROPIC_|VERCEL_OIDC)/u,
            { MUSE_NO_AUTO_UPDATE: "1", ...museEnv(s.host) },
          ),
        },
      )
      const out = channel()
      const decoder = new TextDecoder()
      const incoming = {
        async *[Symbol.asyncIterator]() {
          for await (const chunk of proc.stdout) {
            yield decoder.decode(chunk, { stream: true })
          }
          const tail = decoder.decode()
          if (tail !== "") {
            yield tail
          }
        },
      }
      const connection = new Connection({
        incoming,
        write: async (frame) => {
          proc.write(frame)
          await Promise.resolve()
        },
        close: () => {
          proc.end()
          proc.kill()
        },
      })
      let session = ""
      let { effort } = s
      let history = ""
      let active: {
        uuid: string
        turn: string
        resolve: () => void
        steering: Set<Promise<boolean>>
      } | null = null
      let queue: Promise<unknown> = Promise.resolve()
      const items = new Map<string, Item>()
      const opened = new Set<string>()
      const closed = new Set<string>()
      const command = async (method: string, params: Record<string, unknown>, id?: string) => {
        const expired = Promise.withResolvers<Record<string, unknown>>()
        const timer = setTimeout(() => {
          proc.kill()
          expired.reject(new Error("Muse request timed out"))
        }, 30_000)
        try {
          return await Promise.race([
            connection.command(
              method,
              { sessionId: session, ...params },
              { maxAttempts: 1, ...(id === undefined ? {} : { commandId: id }) },
            ),
            expired.promise,
          ])
        } finally {
          clearTimeout(timer)
        }
      }
      const finish = (failed: boolean, message: string, usage: Record<string, unknown> = {}) => {
        if (active === null) {
          return
        }
        const said: string[] = []
        for (const item of items.values()) {
          if (
            item.kind === "agentMessage" &&
            item.retracted !== true &&
            item.text !== undefined &&
            item.text !== ""
          ) {
            said.push(item.text)
            out.push({
              type: "assistant",
              message: { content: [{ type: "text", text: item.text }] },
            })
          }
        }
        out.push(lifecycle(active.uuid, "completed"))
        const input = num(usage.inputTokens)
        const read = num(usage.cacheReadTokens ?? usage.cachedTokens)
        const write = num(usage.cacheWriteTokens)
        out.push({
          type: "result",
          is_error: failed,
          result: failed ? message : said.join("\n\n") || message,
          model_usage_since_last_result: {
            [s.model]: {
              inputTokens: Math.max(0, input - read - write),
              outputTokens: num(usage.outputTokens),
              cacheReadInputTokens: read,
              cacheCreationInputTokens: write,
              costUSD: 0,
            },
          },
        })
        active.resolve()
        active = null
      }
      const project = (item: Item) => {
        const previous = items.get(item.itemId)
        if (previous !== undefined && previous.revision >= item.revision) {
          return
        }
        items.set(item.itemId, item)
        if (item.kind !== "toolCall") {
          return
        }
        if (!opened.has(item.itemId)) {
          opened.add(item.itemId)
          out.push({
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: item.itemId,
                  name: item.tool ?? "Tool",
                  input: item.args ?? "",
                },
              ],
            },
          })
        }
        if (item.status !== "inProgress" && !closed.has(item.itemId)) {
          closed.add(item.itemId)
          out.push({
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: item.itemId,
                  content: item.visibleOutput ?? item.failureReason ?? "",
                  is_error: item.status === "failed",
                },
              ],
            },
          })
        }
      }
      const interactive = async (method: string, p: Record<string, unknown>) => {
        if (method === "approval/requested" || method === "approval/updated") {
          const choices = array(p.availableChoices).map(obj)
          // Never persist a workspace-wide grant. Native approval IDs survive unchanged.
          const allowed = full && !readOnly
          const choice = choices.find(
            (c) =>
              c.decision === (allowed ? "approved" : "denied") && (c.scope === "once" || !allowed),
          )
          if (choice === undefined) {
            finish(true, "Muse approval requires attention")
            proc.kill()
            return
          }
          await command("approval/decide", {
            approvalId: p.approvalId,
            requirementId: p.currentRequirementId,
            choiceId: choice.choiceId,
          })
        } else if (method === "userInput/requested") {
          await command("userInput/cancel", {
            userInputId: p.userInputId,
            reason: "Input unavailable",
          })
          finish(true, "Muse requires input")
        }
      }
      const projectDelta = (p: Record<string, unknown>) => {
        if (active === null) {
          return
        }

        const item = items.get(str(p.itemId))
        if (
          item === undefined ||
          item.turnId !== active.turn ||
          item.kind !== "agentMessage" ||
          (p.field !== undefined && p.field !== "text")
        ) {
          return
        }
        const text = str(p.delta)
        items.set(item.itemId, { ...item, text: (item.text ?? "") + text })
        out.push({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text } },
        })
      }
      const settleSteering = async (pending: Set<Promise<boolean>>): Promise<void> => {
        await Promise.all(pending)
        if (pending.size > 0) {
          await settleSteering(pending)
        }
      }
      const completeTurn = async (p: Record<string, unknown>) => {
        const current = active
        if (current === null) {
          return
        }
        await settleSteering(current.steering)
        if (active !== current) {
          return
        }
        const error = obj(p.error)
        if (error.quota !== undefined) {
          const { resetsAtMs } = obj(error.quota)
          out.push({
            type: "rate_limit_event",
            rate_limit_info: {
              status: "rejected",
              ...(typeof resetsAtMs === "number" && Number.isFinite(resetsAtMs) && resetsAtMs > 0
                ? { resetsAt: resetsAtMs / 1000 }
                : {}),
            },
          })
        }
        finish(
          p.terminal !== "completed" && p.terminal !== "cancelled",
          str(error.message) || str(p.reason),
          obj(p.usage),
        )
      }
      const steer = async (uuid: string, input: readonly object[]) => {
        const current = active
        if (current === null) {
          return false
        }
        const accepted = Promise.withResolvers<boolean>()
        current.steering.add(accepted.promise)
        try {
          const reply = await command("turn/steer", { expectedTurnId: current.turn, input })
          if (reply.turnId !== current.turn) {
            throw new Error("Muse steer targeted a different turn")
          }
          for (const state of ["started", "completed"] as const) {
            out.push(lifecycle(uuid, state))
          }
          return true
        } catch (error) {
          out.push(lifecycle(uuid, "completed"))
          throw error
        } finally {
          current.steering.delete(accepted.promise)
          accepted.resolve(true)
        }
      }
      connection.onNotification(({ method, params }) => {
        const p = obj(params)
        if (p.sessionId !== session) {
          return
        }
        if (method === "view/gap") {
          finish(true, "Muse response interrupted")
          proc.kill()
          return
        }
        if (method.startsWith("approval/") || method === "userInput/requested") {
          void interactive(method, p).catch(() => {
            finish(true, "Muse approval failed")
            proc.kill()
          })
          return
        }
        if (active === null) {
          return
        }
        if (method === "item/started" || method === "item/updated" || method === "item/completed") {
          const decoded = Schema.decodeUnknownOption(itemSchema)(p.item)
          if (decoded._tag !== "Some") {
            finish(true, "Invalid Muse item")
            proc.kill()
            return
          }
          if (decoded.value.turnId === active.turn) {
            project(decoded.value)
          }
        } else if (method === "item/delta") {
          projectDelta(p)
        } else if (method === "turn/completed" && p.turnId === active.turn) {
          void completeTurn(p).catch(() => {
            finish(true, "Muse completion failed")
            proc.kill()
          })
        }
      })
      connection.onServerRequest(
        async () => await Promise.reject(new Error("Muse request unsupported")),
      )
      connection.onProtocolError(() => {
        finish(true, "Invalid Muse protocol")
        proc.kill()
      })
      const runnerProc = discardStderr(proc)
      void proc.exited.finally(() => {
        finish(true, "Muse exited")
        out.end()
      })
      const activate = async (config: Record<string, unknown>, permissionProfile: string) => {
        let resumed = s.session !== null
        let result: Record<string, unknown> | null = null
        if (resumed) {
          try {
            result = await command("session/resume", {
              excludeItems: true,
              permissionProfile,
              config,
            })
          } catch (error) {
            if (
              !(error instanceof MspError) ||
              !["sessionNotFound", "notFound"].includes(error.kind)
            ) {
              throw error
            }
            resumed = false
            session = connection.mintCommandId()
          }
        }
        if (!resumed) {
          result = await command("session/start", {
            workspaceRoot: cwd,
            providerId,
            ...(s.model === "default" ? {} : { modelId: s.model }),
            approvalMode: full ? "allowAll" : "denyUnmatched",
            permissionProfile,
            config,
          })
        }
        if (obj(result?.session).sessionId !== session) {
          throw new Error("Muse session identity mismatch")
        }
        if (resumed) {
          await command("session/setApprovalMode", { mode: full ? "allowAll" : "denyUnmatched" })
          if (s.model !== "default") {
            await command("session/setModel", { model: { modelId: s.model, providerId } })
          }
        }
        return resumed
      }
      yield* Effect.promise(async () => {
        const expired = Promise.withResolvers<Record<string, unknown>>()
        const timer = setTimeout(() => {
          proc.kill()
          expired.reject(new Error("Muse initialize timed out"))
        }, 30_000)
        try {
          const initialized = await Promise.race([
            connection.request("initialize", {
              clientInfo: { name: "switch", title: "Switch", version: "1" },
              capabilities: { requestedCapabilities: ["sessionMcp"] },
            }),
            expired.promise,
          ])
          if (typeof obj(initialized.schema).fingerprint !== "string") {
            throw new TypeError("Invalid Muse handshake")
          }
          if (
            Object.keys(s.mcp).length > 0 &&
            !array(initialized.grantedCapabilities).includes("sessionMcp")
          ) {
            throw new Error("Muse session MCP unavailable")
          }
          connection.notify("initialized")
          await connection.flush()
          session = s.session ?? connection.mintCommandId()
          const config = {
            mcpServers: Object.fromEntries(
              Object.entries(s.mcp).map(([name, server]) => [
                name,
                {
                  transport: "streamableHttp",
                  mode: "optional",
                  url: server.url,
                  headers:
                    server.token === undefined ? {} : { Authorization: `Bearer ${server.token}` },
                },
              ]),
            ),
          }
          const permissionProfile = full ? ":unrestricted" : ":ask-me"
          const resumed = await activate(config, permissionProfile)
          const messages = resumed ? [] : await Effect.runPromise(s.history())
          history =
            `${s.system}\n\n${messages.map((m) => `${m.role}: ${JSON.stringify(m.content)}`).join("\n\n")}`.trim()
        } catch (error) {
          proc.kill()
          throw error
        } finally {
          clearTimeout(timer)
        }
      })
      return {
        proc: runnerProc,
        session,
        messages: out.messages,
        send: (input, uuid, priority, images = []) =>
          Effect.promise(async () => {
            const read = await Effect.runPromise(inline(images))
            const parts = [
              { type: "text", text: input },
              ...read.map((image) => ({
                type: "image",
                base64Data: image.data,
                mediaType: image.type,
              })),
            ]
            if (priority === "now" && (await steer(uuid, parts))) {
              return
            }
            queue = queue
              .then(async () => {
                const completion = Promise.withResolvers<boolean>()
                const turn = connection.mintCommandId()
                active = {
                  uuid,
                  turn,
                  steering: new Set<Promise<boolean>>(),
                  resolve: () => {
                    completion.resolve(true)
                  },
                }
                items.clear()
                opened.clear()
                closed.clear()
                const text = history === "" ? input : `${history}\n\n${input}`
                history = ""
                out.push(lifecycle(uuid, "started"))
                const admitted = await command(
                  "turn/start",
                  {
                    input: [
                      { type: "text", text },
                      ...read.map((i) => ({
                        type: "image",
                        base64Data: i.data,
                        mediaType: i.type,
                      })),
                    ],
                    workspaceRoots: [cwd],
                    ifBusy: "queue",
                    ...(effort === "" ? {} : { reasoningEffort: effort }),
                  },
                  turn,
                )
                if (admitted.turnId !== turn) {
                  throw new Error("Muse turn identity mismatch")
                }
                return await completion.promise
              })
              .catch(() => {
                finish(true, "Muse turn failed")
                proc.kill()
              })
          }),
        interrupt: Effect.promise(async () => {
          if (active !== null) {
            await command("turn/interrupt", { turnId: active.turn })
          }
        }),
        effort: (value) =>
          Effect.sync(() => {
            effort = value
          }),
      }
    }),
})
