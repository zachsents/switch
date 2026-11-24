// Process isolation and filesystem SDK loading follow T3 Code's CursorAgentSdkWorker.
// Cursor's computed Webpack chunks and platform helpers stay outside the compiled daemon.
import type * as CursorSdk from "@cursor/sdk"
import { createRequire } from "node:module"
import path from "node:path"
import { createInterface } from "node:readline"
import type {
  AgentOptions,
  InteractionUpdate,
  Run,
  SDKAgent,
  SDKModel,
  ToolName,
} from "@cursor/sdk"
import { Schema } from "effect"

import type { CliMessage } from "./claude.ts"
import { cursorRequest } from "./cursor-protocol.ts"
import type { CursorRequest } from "./cursor-protocol.ts"

const value: unknown = createRequire(import.meta.url)("@cursor/sdk")
const isSdk = (candidate: unknown): candidate is typeof CursorSdk =>
  typeof candidate === "object" &&
  candidate !== null &&
  "Agent" in candidate &&
  "Cursor" in candidate &&
  "FileCredentialStore" in candidate
if (!isSdk(value)) {
  throw new Error("Cursor SDK unavailable")
}
const sdk = value
const emit = (event: CliMessage) => {
  process.stdout.write(`${JSON.stringify({ event })}\n`)
}
let agent: SDKAgent | null = null
let active: { run: Run; done: Promise<void>; steering: Set<Promise<boolean>> } | null = null
let starting: Promise<boolean> | null = null
let model = ""
let effort = ""
let prefix = ""
let said = ""
let apiKey: string | undefined
let catalog: SDKModel[] = []
let queued: Promise<unknown> = Promise.resolve()
const toolMap: Readonly<Record<string, ToolName>> = {
  Bash: "shell",
  Read: "read",
  Edit: "edit",
  Write: "write",
  Glob: "glob",
  Grep: "grep",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
}
const keyFor = async (configDir?: string) => {
  const configured = configDir === undefined ? process.env.CURSOR_API_KEY?.trim() : undefined
  if (configured !== undefined && configured !== "") {
    return configured
  }
  const store = new sdk.FileCredentialStore(
    configDir === undefined ? undefined : path.join(configDir, "sdk", "auth.json"),
  )
  const saved = await store.load()
  if (
    saved === undefined ||
    (saved.apiKeyExpiresAtMs !== undefined && saved.apiKeyExpiresAtMs <= Date.now())
  ) {
    return saved?.apiKey
  }
  return saved.apiKey
}
const delta = (update: InteractionUpdate) => {
  if (update.type === "text-delta") {
    said += update.text
    emit({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: update.text } },
    })
  } else if (update.type === "tool-call-started" || update.type === "tool-call-completed") {
    const tool = update.toolCall
    if (update.type === "tool-call-started") {
      emit({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: update.callId, name: tool.type, input: tool }],
        },
      })
    } else {
      emit({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: update.callId, content: JSON.stringify(tool) },
          ],
        },
      })
    }
  }
}
const setFastDefault = (found: SDKModel | undefined, params: { id: string; value: string }[]) => {
  if (
    found?.parameters?.some((p) => p.id === "fast" && p.values.some((v) => v.value === "false")) ===
    true
  ) {
    const at = params.findIndex((p) => p.id === "fast")
    if (at !== -1) {
      params.splice(at, 1)
    }
    params.push({ id: "fast", value: "false" })
  }
}
const selection = () => {
  const found = catalog.find((m) => m.id === model || m.aliases?.includes(model) === true)
  if (found === undefined && model !== "default") {
    throw new Error("Cursor model unavailable")
  }
  const params = [...(found?.variants?.find((v) => v.isDefault === true)?.params ?? [])]
  const reasoning = found?.parameters?.find((p) => p.id === "effort" || p.id === "reasoning")
  if (reasoning !== undefined && effort !== "") {
    if (!reasoning.values.some((v) => v.value === effort)) {
      throw new Error("Cursor effort unavailable")
    }
    const at = params.findIndex((p) => p.id === reasoning.id)
    if (at !== -1) {
      params.splice(at, 1)
    }
    params.push({ id: reasoning.id, value: effort })
  }
  setFastDefault(found, params)
  const variants = (found?.variants ?? []).filter((v) =>
    params.every((p) => v.params.some((c) => c.id === p.id && c.value === p.value)),
  )
  return {
    id: model,
    params,
    ...(variants.length > 0 && variants.every((v) => v.isMaxMode === true)
      ? { maxMode: true }
      : {}),
  }
}
const openAgent = async (p: CursorRequest["params"], options: AgentOptions, full: boolean) => {
  if (full) {
    try {
      const platform = await sdk.createAgentPlatform(
        p.cwd === undefined ? {} : { workspaceRef: p.cwd },
      )
      const release = await platform.prewarmLocalWorkspace({
        ...(apiKey === undefined ? {} : { apiKey }),
        local: {
          ...(p.cwd === undefined ? {} : { cwd: p.cwd }),
          settingSources: [],
          sandboxOptions: { enabled: true },
        },
      })
      await release()
    } catch {
      // T3 primes optional sandbox support before unrestricted runs; availability is advisory.
    }
  }
  if (p.session !== undefined && p.session !== null && p.session !== "") {
    try {
      agent = await sdk.Agent.resume(p.session, options)
    } catch (error) {
      if (!(error instanceof sdk.AgentNotFoundError)) {
        throw error
      }
      prefix = `${p.system ?? ""}\n\n${p.history ?? ""}`.trim()
      agent = await sdk.Agent.create(options)
    }
  } else {
    agent = await sdk.Agent.create(options)
  }

  if (agent === null) {
    throw new Error("Cursor session unavailable")
  }
  return agent
}
const open = async (p: CursorRequest["params"]) => {
  if (agent !== null) {
    throw new Error("Cursor session already open")
  }
  if (p.cwd === undefined || p.model === undefined || p.permissions === undefined) {
    throw new Error("Cursor configuration missing")
  }
  apiKey = await keyFor(p.configDir)
  if (apiKey === undefined) {
    throw new Error("Cursor: Not signed in")
  }
  catalog = await sdk.Cursor.models.list({ apiKey })
  ;({ model } = p)
  effort = p.effort ?? ""
  // Cursor's systemPrompt override requires a per-account entitlement. T3 sends its runtime
  // guidance as prompt context instead, preserving Cursor's native harness and tool protocol.
  prefix = `${p.system ?? ""}\n\n${p.session === null ? (p.history ?? "") : ""}`.trim()
  const tools = p.permissions.tools.flatMap((name) =>
    toolMap[name] === undefined ? [] : [toolMap[name]],
  )
  if (Object.keys(p.mcp ?? {}).length > 0) {
    tools.push("mcp")
  }
  const full = p.permissions.mode === "bypassPermissions"
  const options: AgentOptions = {
    apiKey,
    model: selection(),
    mode: p.permissions.mode === "plan" ? "plan" : "agent",
    tools,
    local: {
      cwd: p.cwd,
      autoReview: false,
      sandboxOptions: { enabled: !full },
      settingSources: full
        ? ["user", "project", "team", "mdm", "plugins"]
        : ["user", "team", "mdm", "plugins"],
    },
    mcpServers: Object.fromEntries(
      Object.entries(p.mcp ?? {}).map(([name, server]) => [
        name,
        {
          type: "http",
          url: server.url,
          ...(server.token === undefined
            ? {}
            : { headers: { Authorization: `Bearer ${server.token}` } }),
        },
      ]),
    ),
  }
  agent = await openAgent(p, options, full)
  return { session: agent.agentId }
}
const settleSteering = async (pending: Set<Promise<boolean>>): Promise<void> => {
  await Promise.all(pending)
  if (pending.size > 0) {
    await settleSteering(pending)
  }
}
const steer = async (p: CursorRequest["params"]) => {
  if (active === null && starting !== null) {
    await starting
  }
  const current = active
  if (
    current === null ||
    current.run.status !== "running" ||
    current.run.steer === undefined ||
    p.priority !== "now" ||
    p.text === undefined ||
    p.uuid === undefined ||
    (p.images ?? []).length > 0
  ) {
    return false
  }
  const accepted = Promise.withResolvers<boolean>()
  current.steering.add(accepted.promise)
  try {
    const outcome = await current.run.steer(p.text)
    if (outcome === "revert_to_followup") {
      return false
    }
    // This worker creates local agents. The pinned local SDK returns the two string outcomes;
    // queued run handles are the separate cloud transport, which is not opened by this worker.
    if (outcome !== "complete_delivered") {
      throw new Error("Unexpected local Cursor steer outcome")
    }
    emit({ type: "command_lifecycle", command_uuid: p.uuid, state: "started" })
    emit({ type: "command_lifecycle", command_uuid: p.uuid, state: "completed" })
    return true
  } catch (error) {
    emit({ type: "command_lifecycle", command_uuid: p.uuid, state: "completed" })
    throw error
  } finally {
    current.steering.delete(accepted.promise)
    accepted.resolve(true)
  }
}
const send = async (p: CursorRequest["params"]) => {
  if (agent === null || p.uuid === undefined || p.text === undefined) {
    throw new Error("Cursor session missing")
  }
  const { uuid } = p
  if (active !== null) {
    await active.done
  }
  const text = prefix === "" ? p.text : `${prefix}\n\n${p.text}`
  said = ""
  emit({ type: "command_lifecycle", command_uuid: uuid, state: "started" })
  const admitted = Promise.withResolvers<boolean>()
  starting = admitted.promise
  const run = await agent
    .send(
      { text, images: [...(p.images ?? [])] },
      {
        model: selection(),
        onDelta: ({ update }) => {
          delta(update)
        },
      },
    )
    .catch((error: unknown) => {
      starting = null
      admitted.resolve(true)
      throw error
    })
  prefix = ""
  const steering = new Set<Promise<boolean>>()
  const done = (async () => {
    try {
      const result = await run.wait()
      await settleSteering(steering)
      if (said !== "") {
        emit({ type: "assistant", message: { content: [{ type: "text", text: said }] } })
      }
      if (/usage.?limit|rate.?limit|quota|429/iu.test(result.error?.code ?? "")) {
        emit({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } })
      }
      const u = result.usage
      emit({
        type: "result",
        is_error: result.status === "error",
        result: result.error?.message ?? result.result ?? said,
        ...(u === undefined
          ? {}
          : {
              model_usage_since_last_result: {
                [model]: {
                  inputTokens: Math.max(0, u.inputTokens - u.cacheReadTokens - u.cacheWriteTokens),
                  outputTokens: u.outputTokens,
                  cacheReadInputTokens: u.cacheReadTokens,
                  cacheCreationInputTokens: u.cacheWriteTokens,
                  costUSD: 0,
                },
              },
            }),
      })
    } catch {
      await settleSteering(steering)
      emit({ type: "result", is_error: true, result: "Cursor run failed" })
    } finally {
      emit({ type: "command_lifecycle", command_uuid: uuid, state: "completed" })
      active = null
    }
  })()
  active = { run, done, steering }
  starting = null
  admitted.resolve(true)
  await done
  return {}
}
const modelIds = async (key: string) => {
  const models = await sdk.Cursor.models.list({ apiKey: key })
  return models.map((m) => m.id)
}
const dispatch = async (request: CursorRequest) => {
  const p = request.params
  switch (request.method) {
    case "open": {
      return await open(p)
    }
    case "send": {
      if (await steer(p)) {
        return {}
      }
      queued = queued
        .then(async () => await send(p))
        .catch(() => {
          if (p.uuid !== undefined) {
            emit({ type: "command_lifecycle", command_uuid: p.uuid, state: "completed" })
          }
          emit({ type: "result", is_error: true, result: "Cursor send failed" })
        })
      return {}
    }
    case "cancel": {
      await active?.run.cancel()
      return {}
    }
    case "effort": {
      effort = p.effort ?? ""
      return {}
    }
    case "status": {
      const key = await keyFor(p.configDir)
      return {
        available: key !== undefined,
        problem: key === undefined ? "Not signed in" : "",
        models: key === undefined ? [] : await modelIds(key),
      }
    }
    default: {
      return request.method satisfies never
    }
  }
}
const pending = new Set<Promise<unknown>>()
const read = createInterface({ input: process.stdin })
read.on("line", (line) => {
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(cursorRequest))(line)
  if (parsed._tag !== "Some") {
    process.exitCode = 1
    read.close()
    return
  }
  const request = parsed.value
  const work = dispatch(request)
    .then((result) => process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`))
    .catch(() =>
      process.stdout.write(
        `${JSON.stringify({ id: request.id, error: { message: request.method === "open" && apiKey === undefined ? "Cursor: Not signed in" : `Cursor ${request.method} failed` } })}\n`,
      ),
    )
  pending.add(work)
  void work.finally(() => {
    pending.delete(work)
  })
})
read.on("close", () => {
  void Promise.allSettled(pending).then(async () => {
    await active?.run.cancel()
    agent?.close()
    process.exit(0)
  })
})
process.on("SIGTERM", () => {
  read.close()
})
