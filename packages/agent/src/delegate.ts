// Orchestrator delegation as an MCP route (T3 Code's delegate_task shape), over Streamable
// HTTP with plain JSON replies, for the core's server to mount. Each session gets a token that
// says which thread is calling.
import { BYPASS, emDashRefusal, ThreadId } from "@switch/brain"
import { Effect, FiberSet } from "effect"

import { MODES } from "./events.ts"
import type { Mode } from "./events.ts"

export interface DelegateArgs {
  readonly task: string
  readonly title: string | null
  readonly clientRequestId: string | null
  readonly tools: readonly string[] | null
  readonly mode: Mode | null
  readonly delegate: boolean | null
  readonly cwd: string | null
  /** How it differs from a running task that looks the same: starts it anyway. */
  readonly separate: string | null
  /** The space it's filed in, by name or id: the one its work is about. */
  readonly space: string | null
  /** Why the em dash check on its title is wrong this time, when it was bypassed (brain's bypass.ts). */
  readonly bypassed: string | null
}

export type TaskStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled"

export interface TaskInfo {
  readonly taskId: string
  readonly title: string
  readonly status: TaskStatus
  /** The child's last reply, or what went wrong. */
  readonly summary: string
  readonly costUsd: number
  /** Its page in the apps. */
  readonly link: string
}

export interface DelegationHandlers {
  readonly delegate: (parent: ThreadId, args: DelegateArgs) => Effect.Effect<TaskInfo, string>
  readonly status: (parent: ThreadId, task: ThreadId) => Effect.Effect<TaskInfo, string>
  readonly cancel: (
    parent: ThreadId,
    task: ThreadId,
    why: string,
  ) => Effect.Effect<TaskInfo, string>
  readonly steer: (
    parent: ThreadId,
    task: ThreadId,
    text: string,
  ) => Effect.Effect<TaskInfo, string>
  /** The calling task's stage, on its row. */
  readonly stage: (thread: ThreadId, stage: string) => Effect.Effect<{ stage: string }, string>
}

const str = { type: "string" } as const

const TOOLS = [
  {
    name: "delegate_task",
    description:
      "Hand a task to a child session that works on it in the background. Its result comes back as a <task> message when it ends.",
    inputSchema: {
      type: "object",
      properties: {
        task: { ...str, description: "Everything the child needs to know; it sees nothing else." },
        title: { ...str, description: "A few words." },
        clientRequestId: {
          ...str,
          description: "Retrying with the same id returns the same task instead of a new one.",
        },
        tools: {
          type: "array",
          items: str,
          description: "Built-in tools it may use, out of yours. Default: yours.",
        },
        mode: {
          type: "string",
          enum: MODES,
          description: "Permission mode, no broader than yours.",
        },
        delegate: { type: "boolean", description: "Whether it may delegate in turn." },
        cwd: { ...str, description: "Its folder, inside yours." },
        separate: {
          ...str,
          description:
            "When a running task looks like the same work, how this one differs; it starts anyway.",
        },
        space: {
          ...str,
          description:
            "The space it's filed in: the one its work is about, by the spaces' names and abouts, even when you're talking in another. Home only when nothing narrower fits. Your reply stays where you were asked, with the task's link.",
        },
        bypass: str,
      },
      required: ["task"],
    },
  },
  {
    name: "task_status",
    description:
      "How a delegated task stands, with its result once it's done: completed when nothing of it goes on; waiting when its turn ended while its work goes on (a watch of its own open, a script it set running) or a usage limit holds it.",
    inputSchema: { type: "object", properties: { taskId: str }, required: ["taskId"] },
  },
  {
    name: "task_steer",
    description:
      "Tell a delegated task something: it hears it between tool calls while running, or as a follow-up once done.",
    inputSchema: {
      type: "object",
      properties: { taskId: str, text: str },
      required: ["taskId", "text"],
    },
  },
  {
    name: "task_stage",
    description:
      "As a task, show where your work stands on your row in Running, in a word or two (building, in checks, shipping, live); it updates in place. Progress goes here, never in chat. Empty clears it.",
    inputSchema: {
      type: "object",
      properties: { stage: { ...str, description: "A word or two." } },
      required: ["stage"],
    },
  },
  {
    name: "task_cancel",
    description:
      "Stop a delegated task and everything it delegated. What it set up waiting (expectations) is retired with it.",
    inputSchema: {
      type: "object",
      properties: { taskId: str, why: str },
      required: ["taskId"],
    },
  },
]

interface Rpc {
  readonly id?: string | number
  readonly method: string
  readonly params?: {
    readonly protocolVersion?: string
    readonly name?: string
    readonly arguments?: Readonly<Record<string, unknown>>
  }
}

const parseRpc: (json: string) => Rpc = JSON.parse

const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : null)

const toArgs = (a: Readonly<Record<string, unknown>>): DelegateArgs | string => {
  const task = text(a.task)
  if (task === null) {
    return "task is required"
  }
  const { tools, mode, delegate } = a
  if (tools !== undefined && !(Array.isArray(tools) && tools.every((t) => typeof t === "string"))) {
    return "tools must be a list of names"
  }
  if (mode !== undefined && !MODES.some((m) => m === mode)) {
    return `mode must be one of ${MODES.join(", ")}`
  }
  // Its title is on its row: no em dash in it (brain's dashes.ts).
  const title = text(a.title)
  const dashed = emDashRefusal([title ?? task.slice(0, 60)])
  const bypass = text(a.bypass)
  if (dashed !== null && bypass === null) {
    return `Its title: ${dashed} ${BYPASS}`
  }
  return {
    task,
    title,
    clientRequestId: text(a.clientRequestId),
    tools: Array.isArray(tools) ? tools.filter((t) => typeof t === "string") : null,
    mode: MODES.find((m) => m === mode) ?? null,
    delegate: typeof delegate === "boolean" ? delegate : null,
    cwd: text(a.cwd),
    separate: text(a.separate),
    space: text(a.space),
    bypassed: dashed === null ? null : bypass,
  }
}

export interface Delegation {
  readonly fetch: (request: Request) => Promise<Response>
  /** A token for `thread`'s sessions; calls with it act as that thread. */
  readonly token: (thread: ThreadId) => string
}

export const delegation = Effect.fnUntraced(function* serving(handlers: DelegationHandlers) {
  const run = yield* FiberSet.makeRuntimePromise()
  const threads = new Map<string, ThreadId>()

  const call = (
    thread: ThreadId,
    name: string,
    a: Readonly<Record<string, unknown>>,
  ): Effect.Effect<TaskInfo | { stage: string }, string> => {
    if (name === "delegate_task") {
      const args = toArgs(a)
      return typeof args === "string" ? Effect.fail(args) : handlers.delegate(thread, args)
    }
    if (name === "task_stage") {
      return typeof a.stage === "string"
        ? handlers.stage(thread, a.stage)
        : Effect.fail("stage is required")
    }
    const taskId = text(a.taskId)
    if (taskId === null) {
      return Effect.fail("taskId is required")
    }
    const task = ThreadId.make(taskId)
    if (name === "task_status") {
      return handlers.status(thread, task)
    }
    if (name === "task_cancel") {
      return handlers.cancel(thread, task, text(a.why) ?? "")
    }
    if (name === "task_steer") {
      const said = text(a.text)
      return said === null ? Effect.fail("text is required") : handlers.steer(thread, task, said)
    }
    return Effect.fail(`No tool ${name}`)
  }

  const answer = async (thread: ThreadId, rpc: Rpc): Promise<unknown> => {
    switch (rpc.method) {
      case "initialize": {
        return {
          protocolVersion: rpc.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "switch", version: "1" },
        }
      }
      case "tools/list": {
        return { tools: TOOLS }
      }
      case "tools/call": {
        const out = await run(
          Effect.match(call(thread, rpc.params?.name ?? "", rpc.params?.arguments ?? {}), {
            onFailure: (e) => ({ content: [{ type: "text", text: e }], isError: true }),
            onSuccess: (info) => ({ content: [{ type: "text", text: JSON.stringify(info) }] }),
          }),
        )
        return out
      }
      default: {
        return {}
      }
    }
  }

  const fetch = async (request: Request) => {
    const token = request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? ""
    const thread = threads.get(token)
    if (thread === undefined) {
      return new Response("Unknown token", { status: 401 })
    }
    if (request.method !== "POST") {
      return new Response(null, { status: 405 })
    }
    const rpc = parseRpc(await request.text())
    if (rpc.id === undefined) {
      return new Response(null, { status: 202 })
    }
    const result = await answer(thread, rpc)
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result })
  }

  return {
    fetch,
    token: (thread) => {
      const token = crypto.randomUUID()
      threads.set(token, thread)
      return token
    },
  } satisfies Delegation
})
