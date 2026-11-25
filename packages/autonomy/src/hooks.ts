// Claude Code hooks, over HTTP: before a tool call, the memories tied to it (triggered recall). A
// call that changes something, with a memory the turn hasn't been shown yet, is held once: denied,
// the memories its reason, so they're read before it runs rather than beside it; the next call of
// its kind goes through. What changes something is the tools' to say: an extension's tool unless it
// only looks (readOnlyHint) or what it changes stays in Switch (openWorldHint false: the brain, the
// user's own chat), and Claude Code's own that write. A turn's own words reach no one now, so
// its stop has nothing to check: the reply check reads what's said (autonomy app.ts `say`).
import { Brain, defineRead } from "@switch/brain"
import { Gateway } from "@switch/gateway"
import { Models } from "@switch/models"
import type { SpaceId, ThreadId, TurnId } from "@switch/brain"
import { Effect, FiberSet } from "effect"

import { field, text } from "./json.ts"
import { renderMemories, triggered } from "./recall.ts"

/**
 * The `--settings` value that points a Claude Code session's hooks at `url` (served by `hooks`),
 * with any other PreToolUse hooks first. `query` (`?token=…`) goes on each hook's address.
 */
export const hookSettings = (url: string, before: readonly object[] = [], query = "") =>
  JSON.stringify({
    hooks: {
      PreToolUse: [
        ...before,
        { matcher: "*", hooks: [{ type: "http", url: `${url}/pre-tool${query}`, timeout: 10 }] },
      ],
      Stop: [{ hooks: [{ type: "http", url: `${url}/stop${query}`, timeout: 20 }] }],
    },
  })

interface ThreadRow {
  readonly thread: ThreadId
  readonly parent: ThreadId | null
  readonly turn: TurnId | null
}

interface Found {
  readonly thread: ThreadId
  readonly turn: TurnId | null
  readonly task: boolean
  /** It and the threads it works under, each with the space it's filed in (delegate_task). */
  readonly chain: readonly { readonly thread: ThreadId; readonly home: SpaceId | null }[]
}

/** The thread a Claude Code session is, and the threads it works under: `whereIs` reads its space. */
const sessionRead = defineRead("autonomy/hooks/session", (db, session: string): Found | null => {
  const row = db
    .query<ThreadRow, [string]>("SELECT thread, parent, turn FROM threads WHERE session = ?")
    .get(session)
  if (!row) {
    return null
  }
  const parent = db.query<ThreadRow, [string]>(
    "SELECT thread, parent, turn FROM threads WHERE thread = ?",
  )
  const filed = db.query<{ home: SpaceId | null }, [string]>(
    "SELECT home FROM thread_spaces WHERE thread = ?",
  )
  const chain: { thread: ThreadId; home: SpaceId | null }[] = []
  const seen = new Set<string>()
  for (
    let t: ThreadRow | null = row;
    t !== null && !seen.has(t.thread);
    t = t.parent === null ? null : parent.get(t.parent)
  ) {
    seen.add(t.thread)
    chain.push({ thread: t.thread, home: filed.get(t.thread)?.home ?? null })
  }
  return { thread: row.thread, turn: row.turn, task: row.parent !== null, chain }
})

/** The thread a Claude Code session is, and the space whose master thread it is or works under. */
const whereIs = (found: Found | null, spaceOf: (thread: ThreadId) => SpaceId | null) => {
  if (found === null) {
    return null
  }
  // A task filed in a space (delegate_task) is that space's, as placeOf reads it.
  let space: SpaceId | null = null
  for (const t of found.chain) {
    space = spaceOf(t.thread) ?? t.home
    if (space !== null) {
      break
    }
  }
  return { thread: found.thread, turn: found.turn, task: found.task, space }
}

/** How a held call's reason ends: what reflection reads a hold by. */
export const HELD = "Follow these, then call again."

/** Claude Code's own tools that change something; the rest (Read, Grep, Glob, …) only look. */
const WRITES = new Set(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"])
/** The gateway's tools, as an agent session names them. */
const APPS = "mcp__apps__"

/** The kind of call: the tool, and for the gateway's `call_tool` the extension's tool it calls. */
const kindOf = (tool: string, input: unknown) =>
  tool === `${APPS}call_tool` ? `${APPS}${text(field(input, "name"))}` : tool

/** What a thread's turn has been shown before its calls, and the kinds held for it to call again. */
interface Shown {
  readonly turn: string
  readonly seen: Set<string>
  readonly held: Set<string>
}

const toolsSoFarRead = defineRead("autonomy/hooks/tools-so-far", (db, thread: ThreadId) =>
  db
    .query<{ body: string }, [string]>(
      "SELECT body FROM thread_items WHERE thread = ? AND json_extract(body, '$.kind') = 'tool' ORDER BY seq DESC LIMIT 6",
    )
    .all(thread)
    .toReversed()
    .map((r) => {
      const b: unknown = JSON.parse(r.body)
      return `${text(field(b, "name"))}: ${JSON.stringify(field(b, "input")).slice(0, 150)}`
    })
    .join(" | "),
)

// The reply check reads what's said (autonomy app.ts `say`): a turn's own words reach no one, so
// there's nothing to check as it stops; ending on a choice is the session's (agent turn.ts).
const stop = () => Effect.succeed({})

/**
 * `/pre-tool` and `/stop`. `spaceOf` maps a thread to its space, null for one that isn't a space's;
 * `answering` says whether a thread's step under way answers the user's words.
 */
export const hooks = Effect.fnUntraced(function* serving(
  spaceOf: (thread: ThreadId) => SpaceId | null,
) {
  const brain = yield* Brain
  const models = yield* Models
  const gateway = yield* Gateway
  const run = yield* FiberSet.makeRuntimePromise()
  const provide = <A, E>(e: Effect.Effect<A, E, Brain | Models>) =>
    e.pipe(Effect.provideService(Brain, brain), Effect.provideService(Models, models))

  // Whether a kind of call changes something. An extension's tool does unless it says it only
  // looks (readOnlyHint) or keeps to Switch (openWorldHint false): a send isn't destructive, but it
  // still changes the world.
  const changes = (kind: string) => {
    if (!kind.startsWith(APPS)) {
      return WRITES.has(kind)
    }
    const name = kind.slice(APPS.length)
    const listed = gateway.tools().find((l) => `${l.app}_${l.tool.name}` === name)
    const marks = listed?.tool.annotations
    return listed !== undefined && marks?.readOnlyHint !== true && marks?.openWorldHint !== false
  }
  const shown = new Map<string, Shown>()
  const shownIn = (thread: string, turn: string) => {
    const had = shown.get(thread)
    if (had?.turn === turn) {
      return had
    }
    const fresh: Shown = { turn, seen: new Set(), held: new Set() }
    shown.set(thread, fresh)
    return fresh
  }

  const preTool = (body: unknown) =>
    Effect.gen(function* pre() {
      const session = text(field(body, "session_id"))
      const where = whereIs(yield* brain.read(sessionRead, session), spaceOf)
      if (where?.space === null || where === null) {
        return {}
      }
      const tool = text(field(body, "tool_name"))
      const input = JSON.stringify(field(body, "tool_input") ?? {})
      const before = yield* brain.read(toolsSoFarRead, where.thread)
      const kept = yield* triggered(where.space, tool, input, before)
      const kind = kindOf(tool, field(body, "tool_input"))
      const turn = shownIn(where.thread, where.turn ?? "")
      const again = turn.held.delete(kind)
      const unseen = kept.some((m) => !turn.seen.has(m.id))
      for (const m of kept) {
        turn.seen.add(m.id)
      }
      if (kept.length === 0) {
        return {}
      }
      const memories = `Before this call:\n${renderMemories(kept)}`
      if (unseen && !again && changes(kind)) {
        turn.held.add(kind)
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `<memory>\n${memories}\n${HELD}\n</memory>`,
          },
        }
      }
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: `<memory>\n${memories}\n</memory>`,
        },
      }
    })

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return new Response(null, { status: 405 })
    }
    const path = new URL(request.url).pathname
    const body: unknown = await request.json().catch(() => ({}))
    let handled: Effect.Effect<object, unknown, Brain | Models> | null = null
    if (path.endsWith("/pre-tool")) {
      handled = preTool(body)
    } else if (path.endsWith("/stop")) {
      handled = stop()
    }
    if (handled === null) {
      return new Response("Not found", { status: 404 })
    }
    // A hook that fails lets the call or the reply through.
    const out = await run(provide(handled).pipe(Effect.orElseSucceed(() => ({}))))
    return Response.json(out)
  }
})
