// Codex through `codex app-server` (JSON-RPC over stdio), as T3 Code's CodexAdapterV2 (MIT,
// Copyright (c) 2026 T3 Tools Inc.): thread/start or thread/resume, turn/start, turn/steer for
// messages mid-turn (Codex takes them at its next model call), turn/interrupt, and
// thread/inject_items to start a thread from the brain's record. One process per thread, where
// T3 shares one per login: a thread's process then dies with it, and a stuck one stops one thread.
import { readFileSync } from "node:fs"
import path from "node:path"
import { listCost } from "@switch/models"
import { Effect } from "effect"

import type { CliBlock, CliMessage } from "./claude.ts"
import type { Permissions } from "./events.ts"
import type { Host, Proc } from "./hosts.ts"
import { channel, childEnv, lifecycle, lines, rpc } from "./provider.ts"
import type { Adapter, Image, Mcp, Runner, Start } from "./provider.ts"
import type { Message } from "./transcript.ts"

type Json = Record<string, unknown>
const isJson = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)
const obj = (v: unknown): Json => (isJson(v) ? v : {})
const str = (v: unknown) => (typeof v === "string" ? v : "")
const num = (v: unknown) => (typeof v === "number" ? v : 0)

// The user's own Codex setup stays out, as `--setting-sources ""` keeps their Claude settings out:
// no hooks, plugins, apps, memories or project docs, and Switch's MCP servers only.
const ARGS = [
  "app-server",
  "-c",
  "thread_unload_delay_secs=0",
  "-c",
  "project_doc_max_bytes=0",
  "--disable",
  "hooks",
  "--disable",
  "plugins",
  "--disable",
  "apps",
  "--disable",
  "memories",
  "--disable",
  "multi_agent",
  "--disable",
  "browser_use",
  "--disable",
  "computer_use",
]

export const DROP =
  /^(?:CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID|CLAUDE_CONFIG_DIR|AI_AGENT|ANTHROPIC_|AI_GATEWAY_|VERCEL_OIDC|OPENAI_|CODEX_HOME|ACCESS_TOKEN)/u

// A thread's `mcp_servers` adds to the login's, so the thread turns each of the login's off by name
// (`-c` flags don't: measured). Starting none also took a first turn from 9.3 s to 2.7 s.
const ownServers = (host: Host) => {
  const home = host.configDir ?? path.join(host.machine.home, ".codex")
  try {
    const config = obj(Bun.TOML.parse(readFileSync(path.join(home, "config.toml"), "utf-8")))
    return Object.keys(obj(config.mcp_servers))
  } catch {
    return []
  }
}

const env = (host: Host) =>
  childEnv(host.machine, DROP, host.configDir === undefined ? {} : { CODEX_HOME: host.configDir })

// Claude Code's permission modes in Codex's terms. Codex has no per-tool list: the sandbox is the
// whole of what narrows it. These switches suppress specific native surfaces, not every
// possible future tool. Stream-item detection below reports violations after they start.
const policy = (p: Permissions) => {
  if (p.mode === "plan" || p.tools.length === 0) {
    return { approvalPolicy: "never", sandbox: "read-only" }
  }
  if (p.mode === "bypassPermissions") {
    return { approvalPolicy: "never", sandbox: "danger-full-access" }
  }
  return { approvalPolicy: "never", sandbox: "workspace-write" }
}

const mcpConfig = (host: Host, mcp: Mcp) => {
  const servers: Record<string, Json> = {}
  for (const name of ownServers(host)) {
    servers[name] = { enabled: false }
  }
  for (const [name, m] of Object.entries(mcp)) {
    servers[name] = {
      url: m.url,
      ...(m.token === undefined ? {} : { http_headers: { Authorization: `Bearer ${m.token}` } }),
    }
  }
  return { mcp_servers: servers }
}

const text = (t: string) => ({ type: "text", text: t, text_elements: [] })

const inputOf = (input: string, images: readonly Image[]) => [
  text(input),
  ...images.map((i) => ({ type: "localImage", path: i.path })),
]

// The record as Responses API items, as T3's historyResponseItems: messages only. Tool calls and
// results go in the assistant's text, since Codex would refuse calls to tools it doesn't have.
const historyItems = (messages: readonly Message[]) =>
  messages.flatMap((m) => {
    const parts = m.content.map((b): string => {
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
    const body = parts.filter((p) => p !== "").join("\n\n")
    if (body === "") {
      return []
    }
    // A result reaches the model as the assistant's own record of what its call returned.
    const role = m.content.every((b) => b.type === "tool_result") ? "assistant" : m.role
    return [
      {
        type: "message",
        role,
        content: [{ type: role === "user" ? "input_text" : "output_text", text: body }],
      },
    ]
  })

// Executable item variants from the installed app-server v2 ThreadItem schema.
const executableItems = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "webSearch",
  "imageView",
  "imageGeneration",
  "sleep",
])

const toolName = (item: Json) => {
  switch (item.type) {
    case "commandExecution": {
      return "Bash"
    }
    case "fileChange": {
      return "Edit"
    }
    case "webSearch": {
      return "WebSearch"
    }
    case "mcpToolCall": {
      return `mcp__${str(item.server)}__${str(item.tool)}`
    }
    case "dynamicToolCall": {
      return str(item.tool)
    }
    default: {
      return null
    }
  }
}

const toolInput = (item: Json): unknown => {
  switch (item.type) {
    case "commandExecution": {
      return { command: item.command, cwd: item.cwd }
    }
    case "fileChange": {
      return { changes: (Array.isArray(item.changes) ? item.changes : []).map((c) => obj(c).path) }
    }
    case "webSearch": {
      return { query: item.query }
    }
    default: {
      return item.arguments ?? null
    }
  }
}

const toolOutput = (item: Json): { readonly output: string; readonly error: boolean } => {
  switch (item.type) {
    case "commandExecution": {
      const code = item.exitCode
      return {
        output: `${str(item.aggregatedOutput)}${typeof code === "number" ? `\n[exit ${code}]` : ""}`,
        error: item.status === "failed" || (typeof code === "number" && code !== 0),
      }
    }
    case "fileChange": {
      return { output: str(item.status), error: item.status === "failed" }
    }
    case "mcpToolCall": {
      const error = obj(item.error)
      if (item.error !== null && item.error !== undefined) {
        return { output: str(error.message), error: true }
      }
      const { content } = obj(item.result)
      const out = (Array.isArray(content) ? content : []).map((c) => str(obj(c).text)).join("\n")
      return { output: out, error: false }
    }
    default: {
      return { output: str(item.status), error: item.status === "failed" }
    }
  }
}

const windowName = (w: Json, fallback: string) => {
  const mins = num(w.windowDurationMins)
  if (mins === 0) {
    return fallback
  }
  return mins % 1440 === 0 ? `${mins / 1440}d` : `${Math.round(mins / 60)}h`
}

/** A rate-limit snapshot in Claude Code's terms. `resetsAt` is the latest full window's. */
const rateLimitEvent = (snapshot: Json): CliMessage => {
  const windows: Record<string, { utilization: number; resetsAt: number }> = {}
  let full = 0
  for (const key of ["primary", "secondary"]) {
    const w = snapshot[key]
    if (isJson(w)) {
      const used = num(w.usedPercent) / 100
      windows[windowName(w, key)] = { utilization: used, resetsAt: num(w.resetsAt) }
      if (used >= 1) {
        full = Math.max(full, num(w.resetsAt))
      }
    }
  }
  const reached = full > 0 || (snapshot.rateLimitReachedType ?? null) !== null
  return {
    type: "rate_limit_event",
    rate_limit_info: {
      status: reached ? "rejected" : "allowed",
      ...(full > 0 ? { resetsAt: full } : {}),
      unifiedWindows: windows,
    },
  }
}

const LIMIT_CODES = new Set(["usageLimitExceeded", "rateLimitExceeded"])

const limitError = (error: Json) => {
  const info = error.codexErrorInfo
  if (typeof info === "string") {
    return LIMIT_CODES.has(info)
  }
  const status = Object.values(obj(info)).map((v) => obj(v).httpStatusCode)
  return status.includes(429)
}

interface Usage {
  input: number
  cached: number
  output: number
}

const connect = (s: Start, proc: Proc) =>
  Effect.gen(function* connecting() {
    const out = channel()
    const send = (m: object) => {
      try {
        proc.write(`${JSON.stringify(m)}\n`)
      } catch {
        // Exited; the reader ends the turn.
      }
    }
    const { request, answer, close } = rpc(send)

    let thread = ""
    let { effort } = s
    let active: string | null = null
    const uuids = new Map<string, string[]>()
    const started = new Set<string>()
    let said = ""
    let snapshot: Json = {}
    let total: Usage = { input: 0, cached: 0, output: 0 }
    let atTurnStart: Usage = total

    const finish = (turn: Json) => {
      const id = str(turn.id)
      for (const uuid of uuids.get(id) ?? []) {
        out.push(lifecycle(uuid, "completed"))
      }
      uuids.delete(id)
      if (active === id) {
        active = null
      }
      const error = obj(turn.error)
      const limited = turn.status === "failed" && limitError(error)
      if (limited) {
        out.push(rateLimitEvent({ ...snapshot, rateLimitReachedType: "limit" }))
      }
      const used = {
        input: total.input - atTurnStart.input,
        cached: total.cached - atTurnStart.cached,
        output: total.output - atTurnStart.output,
      }
      atTurnStart = total
      const tokens = {
        input: Math.max(0, used.input - used.cached),
        cacheRead: used.cached,
        cacheWrite: 0,
        output: used.output,
      }
      const failed = turn.status === "failed"
      const message = str(error.message)
      out.push({
        type: "result",
        is_error: failed,
        result: failed ? `${limited ? "Usage limit: " : ""}${message}` : said,
        model_usage_since_last_result: {
          [s.model]: {
            inputTokens: tokens.input,
            outputTokens: tokens.output,
            cacheReadInputTokens: tokens.cacheRead,
            cacheCreationInputTokens: 0,
            costUSD: listCost(s.model, tokens),
          },
        },
      })
      said = ""
    }

    const tool = (item: Json) => {
      const name = toolName(item)
      const id = str(item.id)
      if (name === null || started.has(id)) {
        return
      }
      started.add(id)
      const block: CliBlock = { type: "tool_use", id, name, input: toolInput(item) }
      out.push({ type: "assistant", message: { content: [block] } })
    }

    const notification = (method: string, p: Json) => {
      if (str(p.threadId) !== "" && str(p.threadId) !== thread) {
        return
      }
      if (
        (method === "item/started" || method === "item/completed") &&
        s.permissions.tools.length === 0 &&
        executableItems.has(str(obj(p.item).type))
      ) {
        out.push({ type: "result", is_error: true, result: "Tools unavailable for completion" })
        proc.kill()
        return
      }
      switch (method) {
        case "item/agentMessage/delta": {
          out.push({
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: str(p.delta) },
            },
          })
          break
        }
        case "item/started": {
          tool(obj(p.item))
          break
        }
        case "item/completed": {
          const item = obj(p.item)
          if (item.type === "agentMessage") {
            said = str(item.text)
            out.push({
              type: "assistant",
              message: { content: [{ type: "text", text: said }] },
            })
          } else if (toolName(item) !== null) {
            tool(item)
            const r = toolOutput(item)
            const block: CliBlock = {
              type: "tool_result",
              tool_use_id: str(item.id),
              content: r.output,
              is_error: r.error,
            }
            out.push({ type: "user", message: { content: [block] } })
          }
          break
        }
        case "thread/tokenUsage/updated": {
          const usage = obj(p.tokenUsage)
          const t = obj(usage.total)
          const last = obj(usage.last)
          total = {
            input: num(t.inputTokens),
            cached: num(t.cachedInputTokens),
            output: num(t.outputTokens),
          }
          out.push({
            type: "assistant",
            message: {
              content: [],
              usage: {
                input_tokens: num(last.inputTokens) - num(last.cachedInputTokens),
                cache_read_input_tokens: num(last.cachedInputTokens),
                cache_creation_input_tokens: 0,
              },
            },
          })
          break
        }
        case "account/rateLimits/updated": {
          // Sparse: merge into what's known.
          snapshot = { ...snapshot, ...obj(p.rateLimits) }
          out.push(rateLimitEvent(snapshot))
          break
        }
        case "turn/started": {
          active = str(obj(p.turn).id)
          break
        }
        case "turn/completed": {
          finish(obj(p.turn))
          break
        }
        default: {
          break
        }
      }
    }

    // Requests from Codex. With approvals off it asks nothing; anything else is declined.
    const serverRequest = (id: unknown, method: string) => {
      if (method.endsWith("/requestApproval")) {
        send({
          id,
          result: {
            decision:
              s.permissions.mode === "plan" || s.permissions.tools.length === 0
                ? "decline"
                : "accept",
          },
        })
      } else if (method === "mcpServer/elicitation/request") {
        send({ id, result: { action: "decline" } })
      } else {
        send({ id, error: { code: -32_601, message: `Switch doesn't answer ${method}` } })
      }
    }

    void lines(proc.stdout, (v) => {
      const m = obj(v)
      const method = str(m.method)
      if (method === "") {
        answer(num(m.id), m)
      } else if (m.id === undefined) {
        notification(method, obj(m.params))
      } else {
        serverRequest(m.id, method)
      }
    }).finally(() => {
      close({ error: { message: "Codex exited" } })
      out.end()
    })

    const settings = {
      cwd: s.cwd,
      model: s.model,
      ...policy(s.permissions),
      baseInstructions: s.system,
      config: {
        ...mcpConfig(s.host, s.mcp),
        ...(s.permissions.tools.length === 0 && {
          web_search: "disabled",
          tools: {
            update_plan: { enabled: false },
            experimental_request_user_input: { enabled: false },
          },
          features: {
            shell_tool: false,
            browser_use: false,
            in_app_browser: false,
            computer_use: false,
            sleep_tool: false,
            multi_agent_v2: false,
            plugins: false,
            connectors: false,
            apply_patch_freeform: false,
            multi_agent: false,
            apps: false,
            image_generation: false,
            view_image: false,
            code_mode: false,
            tool_suggest: false,
            request_permissions_tool: false,
          },
        }),
      },
    }
    yield* Effect.promise(async () => {
      await request("initialize", {
        clientInfo: { name: "switch", title: "Switch", version: "0.0.0" },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: ["turn/diff/updated"],
        },
      })
      send({ method: "initialized" })
      if (s.session !== null) {
        const resumed = await request("thread/resume", {
          ...settings,
          threadId: s.session,
          excludeTurns: true,
        })
        thread = str(obj(obj(resumed.result).thread).id)
      }
      if (thread === "") {
        const reply = await request("thread/start", settings)
        thread = str(obj(obj(reply.result).thread).id)
        const history = historyItems(await Effect.runPromise(s.history()))
        if (thread !== "" && history.length > 0) {
          await request("thread/inject_items", { threadId: thread, items: history })
        }
      }
    })

    if (thread === "") {
      // Codex refused the thread: the reader ends the turn with what it said on stderr.
      proc.kill()
    }

    const begin = async (input: string, uuid: string, images: readonly Image[]) => {
      const reply = await request("turn/start", {
        threadId: thread,
        input: inputOf(input, images),
        effort,
        clientUserMessageId: uuid,
      })
      const id = str(obj(obj(reply.result).turn).id)
      if (id === "") {
        // Refused: a turn of its own that failed, so the waiting message ends.
        out.push(lifecycle(uuid, "started"))
        finish({ id: "", status: "failed", error: obj(reply.error) })
        return
      }
      active = id
      uuids.set(id, [...(uuids.get(id) ?? []), uuid])
      out.push(lifecycle(uuid, "started"))
    }

    const message = async (input: string, uuid: string, images: readonly Image[]) => {
      const turn = active
      if (turn !== null) {
        const reply = await request("turn/steer", {
          threadId: thread,
          expectedTurnId: turn,
          input: inputOf(input, images),
          clientUserMessageId: uuid,
        })
        if (reply.error === undefined) {
          uuids.set(turn, [...(uuids.get(turn) ?? []), uuid])
          out.push(lifecycle(uuid, "started"))
          return
        }
      }
      // No turn running, or it ended before the steer reached it.
      await begin(input, uuid, images)
    }

    return {
      proc,
      session: thread,
      messages: out.messages,
      // Resolves once Codex has the message: a turn of its own, or in the running one.
      send: (input, uuid, _priority, images = []) =>
        Effect.promise(async () => {
          await message(input, uuid, images)
        }),
      interrupt: Effect.sync(() => {
        if (active !== null) {
          void request("turn/interrupt", { threadId: thread, turnId: active })
        }
      }),
      effort: (e) =>
        Effect.sync(() => {
          effort = e
        }),
    } satisfies Runner
  })

const start = (s: Start) =>
  Effect.acquireUseRelease(
    s.host.machine.spawn(["codex", ...ARGS], { cwd: s.cwd, env: env(s.host) }),
    (proc) => connect(s, proc),
    (proc, exit) =>
      exit._tag === "Failure"
        ? Effect.sync(() => {
            proc.kill("SIGKILL")
          })
        : Effect.void,
  )

export const codexAdapter: Adapter = { provider: "codex", start }
