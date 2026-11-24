// One Claude Code process in stream-json mode: what it's launched with, and what it says.
import { Effect, Stream } from "effect"

import type { Permissions } from "./events.ts"
import { guarded } from "./hosts.ts"
import type { Host, Proc } from "./hosts.ts"

export interface Launch {
  readonly host: Host
  readonly cwd: string
  readonly session: string
  /** Resume `session` from its file; otherwise start a new session with that id. */
  readonly resume: boolean
  readonly model: string
  readonly effort: string
  readonly system: string
  readonly permissions: Permissions
  /** MCP servers by name: delegation, when the thread may delegate, and the apps' tools. */
  readonly mcp: Readonly<Record<string, { readonly url: string; readonly token?: string }>>
  /** Claude Code settings JSON, for hooks. */
  readonly settings?: string
}

/** The fields of Claude Code's stream-json messages that the runner reads. */
export interface CliMessage {
  readonly type: string
  readonly subtype?: string
  readonly session_id?: string
  readonly parent_tool_use_id?: string | null
  readonly uuid?: string
  readonly event?: {
    readonly type: string
    readonly delta?: { readonly type: string; readonly text?: string }
  }
  readonly message?: {
    readonly content: string | readonly CliBlock[]
    readonly usage?: CliUsage
    /** The model that wrote it, as the API resolved it. */
    readonly model?: string
  }
  /** The session's model as resolved, on `system` `init`. */
  readonly model?: string
  /** Claude's currently running background commands and agents. */
  readonly tasks?: readonly unknown[]
  readonly command_uuid?: string
  readonly state?: string
  readonly rate_limit_info?: {
    readonly status: string
    readonly resetsAt?: number
    readonly isUsingOverage?: boolean
    /** Every window by name; `utilization` is 0 to 1, `resetsAt` in seconds. */
    readonly unifiedWindows?: Readonly<
      Record<string, { readonly utilization?: number; readonly resetsAt?: number }>
    >
  }
  readonly response?: { readonly request_id: string }
  // result
  readonly is_error?: boolean
  readonly result?: string
  readonly errors?: readonly string[]
  readonly terminal_reason?: string
  readonly modelUsage?: Readonly<Record<string, CliModelUsage>>
  readonly model_usage_since_last_result?: Readonly<Record<string, CliModelUsage>>
}

export interface CliBlock {
  readonly type: string
  readonly text?: string
  readonly id?: string
  readonly name?: string
  readonly input?: unknown
  readonly tool_use_id?: string
  readonly content?: string | readonly { readonly type: string; readonly text?: string }[]
  readonly is_error?: boolean
}

export interface CliUsage {
  readonly input_tokens?: number
  readonly output_tokens?: number
  readonly cache_read_input_tokens?: number
  readonly cache_creation_input_tokens?: number
}

export interface CliModelUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadInputTokens: number
  readonly cacheCreationInputTokens: number
  readonly costUSD: number
}

// The parent's Claude Code wiring, and anything that would bill an API key instead of the
// subscription, must not reach the child.
export const DROP =
  /^(?:CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CONFIG_DIR|AI_AGENT|ANTHROPIC_|AI_GATEWAY_|VERCEL_OIDC)/u

const env = (host: Host, token: boolean) => {
  const out = guarded(host.machine, DROP)
  // Nobody watches the turn: its "the user hasn't heard from you" nudge reads as the user asking.
  out.CLAUDE_CODE_SILENT_TURN_REMINDER = "0"
  if (host.configDir !== undefined) {
    out.CLAUDE_CONFIG_DIR = host.configDir
  }
  if (token) {
    // Read once from fd 3, as Switchboard did: never in an environment or on a command line.
    out.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR = "3"
  }
  return out
}

const args = (l: Launch) => {
  const out = [
    "claude",
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    l.model,
    "--effort",
    l.effort,
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--tools",
    l.permissions.tools.join(","),
    "--permission-mode",
    l.permissions.mode,
    "--permission-prompts",
    "none",
    "--system-prompt",
    l.system,
    l.resume ? "--resume" : "--session-id",
    l.session,
    ...(l.settings === undefined ? [] : ["--settings", l.settings]),
  ]
  const servers = Object.entries(l.mcp)
  if (servers.length > 0) {
    const mcpServers = Object.fromEntries(
      servers.map(([name, m]) => [
        name,
        {
          type: "http",
          url: m.url,
          ...(m.token === undefined ? {} : { headers: { Authorization: `Bearer ${m.token}` } }),
        },
      ]),
    )
    out.push(
      "--mcp-config",
      JSON.stringify({ mcpServers }),
      "--allowedTools",
      servers.map(([name]) => `mcp__${name}`).join(","),
    )
  }
  return out
}

const parseLine: (line: string) => CliMessage = JSON.parse

export interface Claude {
  readonly proc: Proc
  readonly messages: Stream.Stream<CliMessage>
  readonly send: (message: object) => Effect.Effect<void>
  /** When its token lapses, for one that does. */
  readonly until?: number
}

export const spawn = (l: Launch) =>
  Effect.gen(function* spawning() {
    const credential = l.host.token ? yield* l.host.token : null
    const proc = yield* l.host.machine.spawn(args(l), {
      cwd: l.cwd,
      env: env(l.host, credential !== null),
      ...(credential !== null && { secret: credential.secret }),
    })
    return {
      ...claudeOf(proc),
      ...(credential !== null && Number.isFinite(credential.until) && { until: credential.until }),
    }
  })

const claudeOf = (proc: Proc): Claude => ({
  proc,
  messages: Stream.fromReadableStream({ evaluate: () => proc.stdout, onError: () => null }).pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.filter((line) => line.trim() !== ""),
    Stream.map(parseLine),
    Stream.ignore,
  ),
  send: (message) =>
    Effect.sync(() => {
      try {
        proc.write(`${JSON.stringify(message)}\n`)
      } catch {
        // It exited; the reader ends the turn.
      }
    }),
})

/** A user message. "next" joins between tool calls; "now" ends the turn's current step. */
export const userMessage = (
  text: string,
  uuid: string,
  priority?: "now" | "next",
  images: readonly { readonly type: string; readonly data: string }[] = [],
) => ({
  type: "user",
  message: {
    role: "user",
    content:
      images.length === 0
        ? text
        : [
            ...images.map((i) => ({
              type: "image",
              source: { type: "base64", media_type: i.type, data: i.data },
            })),
            { type: "text", text },
          ],
  },
  parent_tool_use_id: null,
  uuid,
  ...(priority ? { priority } : {}),
})

export const interruptRequest = (id: string) => ({
  type: "control_request",
  request_id: id,
  request: { subtype: "interrupt" },
})

/** Effort for the next message on, without a restart; it's sent in the conversation, so the cache holds. */
export const effortRequest = (id: string, effort: string) => ({
  type: "control_request",
  request_id: id,
  request: { subtype: "apply_flag_settings", settings: { effortLevel: effort } },
})

export const blockText = (content: CliBlock["content"]) =>
  typeof content === "string"
    ? content
    : (content ?? []).map((c) => c.text ?? `[${c.type}]`).join("\n")
