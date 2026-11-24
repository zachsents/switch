// Google Antigravity through `agy acp` (Agent Client Protocol, JSON-RPC over stdio), as T3 Code's
// AntigravityAdapterV2 and AcpSessionRuntime (MIT, Copyright (c) 2026 T3 Tools Inc.): a private
// GEMINI_HOME per login, eager `authenticate`, session/new or session/resume, the system prompt
// appended through `_meta.antigravity`, and a prompt sent mid-turn as a steer (agy 1.5.0 on).
// ACP has no way to load history into a new session, so a rebuild goes in its first prompt.
import path from "node:path"
import { listCost } from "@switch/models"
import { Effect } from "effect"

import type { CliBlock } from "./claude.ts"
import type { Host } from "./hosts.ts"
import { channel, childEnv, inline, lifecycle, lines, rpc } from "./provider.ts"
import type { Adapter, Image, Mcp, Runner, Start } from "./provider.ts"
import type { Message } from "./transcript.ts"

type Json = Record<string, unknown>
const isJson = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)
const obj = (v: unknown): Json => (isJson(v) ? v : {})
const str = (v: unknown) => (typeof v === "string" ? v : "")
const num = (v: unknown) => (typeof v === "number" ? v : 0)

/** `AGY_PATH`, else `agy` or `antigravity` on PATH. */
const command = () => process.env.AGY_PATH ?? Bun.which("agy") ?? Bun.which("antigravity") ?? "agy"

const DROP =
  /^(?:CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID|CLAUDE_CONFIG_DIR|AI_AGENT|ANTHROPIC_|AI_GATEWAY_|VERCEL_OIDC|GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_CLOUD_|GEMINI_HOME|BROWSER)/u

const homeOf = (host: Host) => host.configDir ?? path.join(host.machine.home, ".gemini")

// T3's antigravityEnvironment. The fake SSH_CONNECTION keeps each login's Google sign-in in its own
// GEMINI_HOME: without it, agy 1.5 keeps every profile's in one OS keyring entry. BROWSER fails,
// so a session never starts a sign-in; signing in is the user's, with `agy acp --login`.
const env = (host: Host) =>
  childEnv(host.machine, DROP, {
    GEMINI_HOME: homeOf(host),
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    AGY_CLI_DISABLE_AUTO_UPDATE: "1",
    SSH_CONNECTION: process.env.SSH_CONNECTION ?? "127.0.0.1 0 127.0.0.1 0",
    BROWSER: "/usr/bin/false",
    PYTHONUNBUFFERED: "1",
    ELECTRON_RUN_AS_NODE: "1",
  })

const mcpServers = (mcp: Mcp) =>
  Object.entries(mcp).map(([name, m]) => ({
    type: "http",
    name,
    url: m.url,
    headers: m.token === undefined ? [] : [{ name: "Authorization", value: `Bearer ${m.token}` }],
  }))

// T3's handoff rendering: the record as text, ahead of the first message.
const render = (messages: readonly Message[]) =>
  messages
    .map((m) => {
      const body = m.content
        .map((b): string => {
          if (b.type === "text") {
            return str(b.text)
          }
          if (b.type === "tool_use") {
            return `<tool name="${str(b.name)}">${JSON.stringify(b.input)}</tool>`
          }
          if (b.type === "tool_result") {
            return `<tool-result>${str(b.content)}</tool-result>`
          }
          return ""
        })
        .filter((s) => s !== "")
        .join("\n\n")
      return `[${m.role}]\n${body}`
    })
    .join("\n\n")

// AntigravityTurnOutcome.ts: how agy says a quota ran out, and when it resets.
const API_ERROR = /Error (?<status>\d{3}), Message: (?<message>.+?), Status: (?<code>[A-Z_]+)/su
const QUOTA = /\b(?:QUOTA_EXHAUSTED|RESOURCE_EXHAUSTED)\b|\b429\b/u
const RESET_TIMESTAMP = /\bquotaResetTimeStamp:(?<stamp>[^\s\]]+)/u
const RESET_DELAY =
  /\b(?:quotaResetDelay|retryDelay):(?<delay>(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|h|m|s))+)/u
const DURATION_PART = /(?<amount>\d+(?:\.\d+)?)(?<unit>ns|us|µs|ms|h|m|s)/gu
const UNIT_MS: Readonly<Record<string, number>> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
}

/** Seconds, as Claude Code reports a reset; null when the text doesn't say. */
const resetOf = (text: string) => {
  const stamp = RESET_TIMESTAMP.exec(text)?.groups?.stamp
  if (stamp !== undefined && !Number.isNaN(Date.parse(stamp))) {
    return Math.round(Date.parse(stamp) / 1000)
  }
  const delay = RESET_DELAY.exec(text)?.groups?.delay
  if (delay === undefined) {
    return null
  }
  let ms = 0
  for (const part of delay.matchAll(DURATION_PART)) {
    ms += Number(part.groups?.amount) * (UNIT_MS[part.groups?.unit ?? "s"] ?? 0)
  }
  return ms > 0 ? Math.round((Date.now() + ms) / 1000) : null
}

const modelIds = (models: unknown) =>
  (Array.isArray(models) ? models : []).map((m) => str(obj(m).modelId))

/** The model id agy offers for a tier's model at an effort: it names effort in the id. */
const modelFor = (available: readonly string[], model: string, effort: string) =>
  [`${model}-${effort}`, model].find((id) => available.includes(id)) ??
  available.find((id) => id.startsWith(`${model}-`)) ??
  model

const start = (s: Start) =>
  Effect.gen(function* starting() {
    const home = homeOf(s.host)
    const proc = yield* s.host.machine.spawn(
      [command(), "acp", "--gemini-dir", home, "--app-data-dir", "antigravity-acp"],
      { cwd: s.cwd, env: env(s.host) },
    )
    const out = channel()
    const send = (m: object) => {
      try {
        proc.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`)
      } catch {
        // Exited; the reader ends the turn.
      }
    }
    const { request, answer, close } = rpc(send)

    let session = ""
    let { model } = s
    let available: string[] = []
    let preface = ""
    let said = ""
    let latest = ""
    const prompts = new Set<string>()
    const open = new Set<string>()

    const flush = () => {
      if (said.trim() !== "") {
        out.push({ type: "assistant", message: { content: [{ type: "text", text: said }] } })
      }
      said = ""
    }

    const end = (
      uuid: string,
      reply: Json,
      last: { text: string; error: boolean; reset: number | null; limited: boolean },
    ) => {
      out.push(lifecycle(uuid, "completed"))
      prompts.delete(uuid)
      // A steer answers the prompt it replaced with end_turn; the turn goes on under the new one.
      if (uuid !== latest) {
        return
      }
      flush()
      if (last.limited) {
        out.push({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "rejected",
            ...(last.reset === null ? {} : { resetsAt: last.reset }),
          },
        })
      }
      const usage = obj(obj(reply.result).usage)
      const tokens = {
        input: num(usage.inputTokens),
        cacheRead: num(usage.cachedReadTokens),
        cacheWrite: num(usage.cachedWriteTokens),
        output: num(usage.outputTokens) + num(usage.thoughtTokens),
      }
      out.push({
        type: "result",
        is_error: last.error,
        result: last.text,
        model_usage_since_last_result: {
          [model]: {
            inputTokens: tokens.input,
            outputTokens: tokens.output,
            cacheReadInputTokens: tokens.cacheRead,
            cacheCreationInputTokens: tokens.cacheWrite,
            costUSD: listCost(model, tokens),
          },
        },
      })
    }

    let lastText = ""
    const prompt = async (input: string, uuid: string, images: readonly Image[]) => {
      const text = preface === "" ? input : `${preface}\n\n${input}`
      const read = await Effect.runPromise(inline(images))
      preface = ""
      latest = uuid
      prompts.add(uuid)
      out.push(lifecycle(uuid, "started"))
      const reply = await request("session/prompt", {
        sessionId: session,
        prompt: [
          { type: "text", text },
          ...read.map((i) => ({
            type: "image",
            mimeType: i.type,
            data: i.data,
          })),
        ],
      })
      const error = obj(reply.error)
      const message = `${str(error.message)} ${JSON.stringify(error.data ?? "")}`
      const stop = str(obj(reply.result).stopReason)
      // The agent maps only the SDK's QUOTA_EXHAUSTED stop reason to `refusal`.
      const limited = stop === "refusal" || (reply.error !== undefined && QUOTA.test(message))
      const failed = reply.error !== undefined || stop === "refusal"
      const apiError = API_ERROR.exec(message)
      let result = lastText
      if (limited) {
        result = "Usage limit: Antigravity quota reached"
      } else if (failed) {
        result = apiError?.groups?.message?.trim() ?? str(error.message)
      }
      end(uuid, reply, { text: result, error: failed, reset: resetOf(message), limited })
    }

    const notification = (method: string, p: Json) => {
      if (method !== "session/update" || str(p.sessionId) !== session) {
        return
      }
      const u = obj(p.update)
      switch (u.sessionUpdate) {
        case "agent_message_chunk": {
          const t = str(obj(u.content).text)
          said += t
          lastText = said
          out.push({
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: t } },
          })
          break
        }
        case "tool_call": {
          flush()
          const id = str(u.toolCallId)
          open.add(id)
          const block: CliBlock = {
            type: "tool_use",
            id,
            name: str(u.kind) === "" ? str(u.title) : `${str(u.kind)}: ${str(u.title)}`,
            input: u.rawInput ?? null,
          }
          out.push({ type: "assistant", message: { content: [block] } })
          break
        }
        case "tool_call_update": {
          const id = str(u.toolCallId)
          if ((u.status === "completed" || u.status === "failed") && open.has(id)) {
            open.delete(id)
            const content = (Array.isArray(u.content) ? u.content : [])
              .map((c) => str(obj(obj(c).content).text))
              .filter((t) => t !== "")
              .join("\n")
            const output = content === "" ? JSON.stringify(u.rawOutput ?? "") : content
            const block: CliBlock = {
              type: "tool_result",
              tool_use_id: id,
              content: output,
              is_error: u.status === "failed",
            }
            out.push({ type: "user", message: { content: [block] } })
          }
          break
        }
        case "usage_update": {
          out.push({
            type: "assistant",
            message: { content: [], usage: { input_tokens: num(u.used) } },
          })
          break
        }
        default: {
          break
        }
      }
    }

    // T3 answers permission prompts from the runtime policy; agy's own yolo isn't offered to ACP.
    const READS = new Set(["read", "search", "fetch", "think"])
    const serverRequest = (id: unknown, method: string, p: Json) => {
      if (method !== "session/request_permission") {
        send({ id, error: { code: -32_601, message: `Switch doesn't answer ${method}` } })
        return
      }
      const options = (Array.isArray(p.options) ? p.options : []).map(obj)
      const allowed = s.permissions.mode !== "plan" || READS.has(str(obj(p.toolCall).kind))
      const kinds = allowed ? ["allow_always", "allow_once"] : ["reject_once", "reject_always"]
      const choice = kinds.map((k) => options.find((o) => o.kind === k)).find(Boolean)
      send({
        id,
        result: {
          outcome: choice
            ? { outcome: "selected", optionId: choice.optionId }
            : { outcome: "cancelled" },
        },
      })
    }

    void lines(proc.stdout, (v) => {
      const m = obj(v)
      const method = str(m.method)
      if (method === "") {
        answer(num(m.id), m)
      } else if (m.id === undefined) {
        notification(method, obj(m.params))
      } else {
        serverRequest(m.id, method, obj(m.params))
      }
    }).finally(() => {
      close({ error: { message: "Antigravity exited" } })
      out.end()
    })

    const failure = yield* Effect.promise(async () => {
      await request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "switch", title: "Switch", version: "0.0.0" },
      })
      const auth = await request("authenticate", { methodId: "oauth-personal" })
      if (auth.error !== undefined) {
        return `Antigravity isn't signed in: ${str(obj(auth.error).message)}`
      }
      const servers = mcpServers(s.mcp)
      if (s.session !== null) {
        const resumed = await request("session/resume", {
          sessionId: s.session,
          cwd: s.cwd,
          mcpServers: servers,
        })
        if (resumed.error === undefined) {
          ;({ session } = s)
          available = modelIds(obj(obj(resumed.result).models).availableModels)
        }
      }
      if (session === "") {
        const created = await request("session/new", {
          cwd: s.cwd,
          mcpServers: servers,
          _meta: { antigravity: { systemPrompt: { append: s.system } } },
        })
        const r = obj(created.result)
        session = str(r.sessionId)
        if (session === "") {
          return `Antigravity: ${str(obj(created.error).message)}`
        }
        available = modelIds(obj(r.models).availableModels)
        const history = await Effect.runPromise(s.history())
        if (history.length > 0) {
          preface = `<history>\nThis thread so far, from another session:\n\n${render(history)}\n</history>`
        }
      }
      model = modelFor(available, s.model, s.effort)
      await request("session/set_model", { sessionId: session, modelId: model })
      return null
    })

    const fail = (uuid: string) => {
      out.push(lifecycle(uuid, "started"))
      latest = uuid
      end(uuid, {}, { text: failure ?? "", error: true, reset: null, limited: false })
    }

    return {
      proc,
      session: session === "" ? crypto.randomUUID() : session,
      messages: out.messages,
      send: (input, uuid, _priority, images = []) =>
        Effect.sync(() => {
          if (failure === null) {
            void prompt(input, uuid, images)
          } else {
            fail(uuid)
          }
        }),
      interrupt: Effect.sync(() => {
        send({ method: "session/cancel", params: { sessionId: session } })
      }),
      effort: (e) =>
        Effect.sync(() => {
          const id = modelFor(available, s.model, e)
          if (id !== model) {
            model = id
            void request("session/set_model", { sessionId: session, modelId: id })
          }
        }),
    } satisfies Runner
  })

export const antigravityAdapter: Adapter = { provider: "antigravity", start }
