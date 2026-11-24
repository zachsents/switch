// Other agents' way in: an MCP server at `/peer` that a Claude Code or T3 Code session adds once
// (`{ "type": "http", "url": "<core>/peer" }`, with a credential of the `peer` kind). It lists the
// spaces, reads one's chat and open asks, lists the work under way, and posts into a space as the
// agent it names, never as the user: the space's agent reads those words as a collaborator's (chat.ts)
// and answers with say. `ask` posts and waits for that answer. Nothing here answers, approves or
// closes the user's items, pairs, or changes a setting: the credential reaches this route alone.
import type { Database } from "bun:sqlite"
import { allThreads, getThread } from "@switch/agent"
import { items, placeOf } from "@switch/autonomy"
import { allSpaces, Brain, PEER, PostMessage, saidBy, spaceMessages } from "@switch/brain"
import type { SpaceId } from "@switch/brain"
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server"
import type { CallToolResult, Tool } from "@modelcontextprotocol/server"
import { Effect, Schema } from "effect"

import { threadOf } from "./context.ts"

const READ_MAX = 100
const WAIT_S = 300
const WAIT_MAX_S = 1800

const said = (value: unknown, isError = false): CallToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  ...(isError && { isError: true }),
})

const SPACE = {
  type: "string" as const,
  description: "The space, by id or name (Home is the root).",
}
const FROM = {
  type: "string" as const,
  description:
    "Who you are, shown beside your words: your app and this conversation's title, as `T3 Code · Fix login` or `Claude Code · billing refactor`.",
}
const TEXT = {
  type: "string" as const,
  description: "Your words, as you'd write them to a colleague.",
}

const TOOLS: Tool[] = [
  {
    name: "spaces",
    description:
      "Switch's spaces: one per thing the user deals with, each with its own agent session. Each with whether its agent is working now and how many of the user's asks are open in it.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "read",
    description:
      "A space's latest chat, oldest first (the user's, Switch's and other agents' words), and the user's asks open in it.",
    inputSchema: {
      type: "object",
      properties: {
        space: SPACE,
        limit: { type: "number", description: `Lines, up to ${String(READ_MAX)}; 20 if unset.` },
      },
      required: ["space"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "work",
    description: "What Switch is working on now: each running turn or task, with its space.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "post",
    description:
      "Posts into a space's chat as you: its agent reads it and answers there (read it later, or use ask to wait). Anything that goes out in the user's name, or needs them, still goes to their queue.",
    inputSchema: {
      type: "object",
      properties: { space: SPACE, text: TEXT, from: FROM },
      required: ["space", "text", "from"],
    },
  },
  {
    name: "ask",
    description:
      "Posts into a space's chat as you, then waits for its agent to answer and returns what it said.",
    inputSchema: {
      type: "object",
      properties: {
        space: SPACE,
        text: TEXT,
        from: FROM,
        wait: {
          type: "number",
          description: `Seconds to wait, up to ${String(WAIT_MAX_S)}; ${String(WAIT_S)} if unset. Past it, what it said so far.`,
        },
      },
      required: ["space", "text", "from"],
    },
  },
]

const Posting = Schema.Struct({
  space: Schema.String,
  text: Schema.String.check(Schema.isMinLength(1)),
  from: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  wait: Schema.optionalKey(Schema.Number),
})
const Reading = Schema.Struct({ space: Schema.String, limit: Schema.optionalKey(Schema.Number) })

/** A space by its id or its name, else null. */
const spaceNamed = (db: Database, given: string) => {
  const want = given.trim()
  const spaces = allSpaces(db)
  return (
    spaces.find((s) => s.id === want) ??
    spaces.find((s) => s.name.toLowerCase() === want.toLowerCase()) ??
    null
  )
}

const iso = (ms: number) => new Date(ms).toISOString()

const spacesOf = (db: Database) => {
  const open = items(db, { status: "open" })
  return allSpaces(db)
    .filter((s) => !s.archived)
    .map((s) => ({
      id: s.id,
      name: s.name,
      parent: s.parent,
      working: getThread(db, threadOf(s.id))?.status === "running",
      asks: open.filter((i) => i.space === s.id).length,
    }))
}

const chatOf = (db: Database, space: SpaceId, limit: number) => ({
  lines: spaceMessages(db, space, limit).map((m) => ({
    seq: m.seq,
    time: iso(m.time),
    from: saidBy(m, "Switch", "User"),
    text: m.text,
  })),
  asks: items(db, { space, status: "open" }).map((i) => ({
    id: i.id,
    title: i.title,
    body: i.body,
  })),
})

const workOf = (db: Database) =>
  allThreads(db)
    .filter((t) => t.status === "running")
    .map((t) => ({ title: t.title, space: placeOf(db, t.thread).space }))

/** The turn that took in the words posted at `seq`: the first the space's thread was sent after it. */
const turnAfter = (db: Database, space: SpaceId, seq: number) =>
  db
    .query<{ turn: string }, [string, number]>(
      "SELECT turn FROM thread_items WHERE thread = ? AND seq > ? AND json_extract(body, '$.kind') IN ('user', 'steer') ORDER BY seq LIMIT 1",
    )
    .get(threadOf(space), seq)?.turn ?? null

/** What the agent said in that turn after `seq`. */
const saidIn = (db: Database, space: SpaceId, turn: string, seq: number) =>
  db
    .query<{ text: string }, [string, string, number]>(
      "SELECT text FROM messages WHERE space = ? AND turn = ? AND source = 'agent' AND seq > ? ORDER BY seq",
    )
    .all(space, turn, seq)
    .map((m) => m.text)

const peerServer = (brain: typeof Brain.Service) => {
  const run = async <A>(effect: Effect.Effect<A, unknown, Brain>) =>
    await Effect.runPromise(Effect.provideService(effect, Brain, brain))
  const read = async <A>(f: (db: Database) => A) => await run(brain.read(f))

  const post = async (args: typeof Posting.Type) => {
    const space = await read((db) => spaceNamed(db, args.space))
    if (space === null) {
      return null
    }
    const r = await run(
      brain.dispatch({
        id: crypto.randomUUID(),
        type: PostMessage.type,
        source: PEER,
        payload: { space: space.id, text: args.text, from: args.from.trim() },
      }),
    )
    return { space: space.id, seq: r.seq }
  }

  // The answer to what was posted at `seq`: once the turn that took it in ends, what it said.
  const answer = async (space: SpaceId, seq: number, seconds: number) => {
    const until = Date.now() + seconds * 1000
    const look = async () =>
      await read((db) => {
        const turn = turnAfter(db, space, seq)
        const t = getThread(db, threadOf(space))
        return {
          said: turn === null ? [] : saidIn(db, space, turn, seq),
          done: turn !== null && (t?.status !== "running" || t.turn !== turn),
        }
      })
    const poll = async (): Promise<Awaited<ReturnType<typeof look>>> => {
      const now = await look()
      if (now.done || Date.now() >= until) {
        return now
      }
      await Bun.sleep(1000)
      return await poll()
    }
    return await poll()
  }

  const call = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    if (name === "spaces") {
      return said(await read(spacesOf))
    }
    if (name === "work") {
      return said(await read(workOf))
    }
    if (name === "read") {
      const given = Schema.decodeUnknownOption(Reading)(args)
      if (given._tag === "None") {
        return said("Give a space", true)
      }
      const { limit } = given.value
      const space = await read((db) => spaceNamed(db, given.value.space))
      if (space === null) {
        return said(`No space ${given.value.space}`, true)
      }
      const n = Math.min(Math.max(1, Math.round(limit ?? 20)), READ_MAX)
      return said(await read((db) => ({ space: space.id, ...chatOf(db, space.id, n) })))
    }
    if (name !== "post" && name !== "ask") {
      return said(`No tool ${name}`, true)
    }
    const given = Schema.decodeUnknownOption(Posting)(args)
    if (given._tag === "None") {
      return said("Give a space, your words and who you are (from)", true)
    }
    const posted = await post(given.value)
    if (posted === null) {
      return said(`No space ${given.value.space}`, true)
    }
    if (name === "post") {
      return said(posted)
    }
    const seconds = Math.min(Math.max(1, given.value.wait ?? WAIT_S), WAIT_MAX_S)
    return said({ ...posted, ...(await answer(posted.space, posted.seq, seconds)) })
  }

  const mcp = new McpServer({ name: "switch", version: "1" }, { capabilities: { tools: {} } })
  mcp.server.setRequestHandler("tools/list", () => ({ tools: TOOLS }))
  mcp.server.setRequestHandler("tools/call", async (request) => {
    try {
      return await call(request.params.name, request.params.arguments ?? {})
    } catch (error) {
      return said(String(error), true)
    }
  })
  return mcp
}

/** The route's handler: a stateless MCP server per request, as the agents' `/apps` is. */
export const peerRoute = Brain.pipe(
  Effect.map((brain) => async (request: Request) => {
    const handler = createMcpHandler(() => peerServer(brain), { legacy: "stateless" })
    return await handler.fetch(request)
  }),
)
