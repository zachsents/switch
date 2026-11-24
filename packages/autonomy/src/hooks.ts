// Claude Code hooks, over HTTP: before a tool call, the memories tied to it (triggered recall). A
// turn's own words reach no one now, so its stop has nothing to check: the reply check reads what's
// said (autonomy app.ts `say`).
import type { Database } from "bun:sqlite"
import { Brain } from "@switch/brain"
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

/** The thread a Claude Code session is, and the space whose master thread it is or works under. */
const whereIs = (db: Database, session: string, spaceOf: (thread: ThreadId) => SpaceId | null) => {
  const row = db
    .query<ThreadRow, [string]>("SELECT thread, parent, turn FROM threads WHERE session = ?")
    .get(session)
  if (!row) {
    return null
  }
  const parent = db.query<ThreadRow, [string]>(
    "SELECT thread, parent, turn FROM threads WHERE thread = ?",
  )
  // A task filed in a space (delegate_task) is that space's, as placeOf reads it.
  const filed = db.query<{ home: SpaceId | null }, [string]>(
    "SELECT home FROM thread_spaces WHERE thread = ?",
  )
  let space: SpaceId | null = null
  const seen: string[] = []
  for (
    let t: ThreadRow | null = row;
    t !== null && !seen.includes(t.thread);
    t = t.parent === null ? null : parent.get(t.parent)
  ) {
    seen.push(t.thread)
    space = spaceOf(t.thread) ?? filed.get(t.thread)?.home ?? null
    if (space !== null) {
      break
    }
  }
  return { thread: row.thread, turn: row.turn, task: row.parent !== null, space }
}

const toolsSoFar = (db: Database, thread: ThreadId) =>
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
    .join(" | ")

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
  const run = yield* FiberSet.makeRuntimePromise()
  const provide = <A, E>(e: Effect.Effect<A, E, Brain | Models>) =>
    e.pipe(Effect.provideService(Brain, brain), Effect.provideService(Models, models))

  const preTool = (body: unknown) =>
    Effect.gen(function* pre() {
      const session = text(field(body, "session_id"))
      const where = yield* brain.read((db) => whereIs(db, session, spaceOf))
      if (where?.space === null || where === null) {
        return {}
      }
      const tool = text(field(body, "tool_name"))
      const input = JSON.stringify(field(body, "tool_input") ?? {})
      const before = yield* brain.read((db) => toolsSoFar(db, where.thread))
      const kept = yield* triggered(where.space, tool, input, before)
      return kept.length === 0
        ? {}
        : {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              additionalContext: `<memory>\nBefore this call:\n${renderMemories(kept)}\n</memory>`,
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
