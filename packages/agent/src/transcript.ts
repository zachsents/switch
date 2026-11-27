// Compaction and fresh starts: a Claude Code session file written from the brain's record,
// never a summary. The newest exchanges that fit a budget stay verbatim; tool I/O and deltas only
// in the last few, an older wake only why it ran. The rest stays in the brain, found with the
// history tools (core/src/find.ts). Every provider's rebuild reads this.
// The format is Claude Code's own and undocumented; minimal entries are enough (measured).
import type { Item } from "./events.ts"

export interface Block {
  readonly type: string
  readonly [key: string]: unknown
}

export interface Message {
  readonly role: "user" | "assistant"
  readonly content: Block[]
}

/** A tool id as the API takes it, the same for a call and its result: other characters become _. */
const apiId = (id: string) => id.replaceAll(/[^a-zA-Z0-9_-]/gu, "_")

type UserItem = Extract<Item, { kind: "user" }>

// Why a wake ran. A turn recorded before `wake` has it after its delta's "Now:" line, the brain's
// state before it; a delta with no such line is all reason.
export const reasonOf = (r: Pick<UserItem, "delta" | "wake">) => {
  if (r.wake !== undefined) {
    return r.wake
  }
  const inside = r.delta
    .replace(/^<brain-delta[^>]*>\n?/u, "")
    .replace(/\n?<\/brain-delta>\s*$/u, "")
  const lines = inside.split("\n")
  const now = lines.findIndex((l) => l.startsWith("Now: "))
  return (now === -1 ? inside : lines.slice(now + 1).join("\n")).trim()
}

// An old wake with no words of the user's keeps why it ran, not the brain's state then: that was
// most of a long space's record (the busiest one's, Nov 23: 1.16M of 1.64M characters).
const userText = (r: UserItem, full: boolean) => {
  if (full) {
    return r.delta === "" ? r.text : `${r.delta}\n\n${r.text}`.trim()
  }
  if (r.text !== "") {
    return r.text
  }
  const reason = reasonOf(r)
  return reason === "" ? "" : `<brain-delta>\n${reason}\n</brain-delta>`
}

// About this many characters a token, on the low side so a budget isn't overrun.
const CHARS_PER_TOKEN = 3

/** What an item adds to the transcript, in characters. */
const sizeOf = (r: Item, full: boolean) => {
  switch (r.kind) {
    case "user": {
      return userText(r, full).length
    }
    case "steer":
    case "text": {
      return r.text.length
    }
    case "wake": {
      return full ? r.text.length : 0
    }
    case "tool": {
      return full ? JSON.stringify(r.input).length : 0
    }
    case "result": {
      return full ? r.output.length : 0
    }
    default: {
      return r satisfies never
    }
  }
}

/** The newest exchanges that fit `budget` tokens, the latest always. */
const keptTurns = (
  rows: readonly Item[],
  all: readonly string[],
  fullFrom: ReadonlySet<string>,
  budget: number,
) => {
  const sizes = new Map<string, number>()
  for (const r of rows) {
    sizes.set(r.turn, (sizes.get(r.turn) ?? 0) + sizeOf(r, fullFrom.has(r.turn)))
  }
  const kept = new Set<string>()
  let left = budget * CHARS_PER_TOKEN
  for (const turn of all.toReversed()) {
    const size = sizes.get(turn) ?? 0
    if (kept.size > 0 && size > left) {
      break
    }
    kept.add(turn)
    left -= size
  }
  return kept
}

const field = (v: unknown, key: string): unknown =>
  typeof v === "object" && v !== null && key in v ? Reflect.get(v, key) : undefined

const SAY = "autonomy_say"

/**
 * The words of the agent's say (autonomy's), the one call whose words reach the user: called by any
 * provider's name for it, or through the apps' `call_tool`. Empty for any other call.
 */
export const sayWords = (name: string, input: unknown) => {
  const proxied = name.endsWith("call_tool")
  const called = proxied ? field(input, "name") : name
  const args = proxied ? field(input, "arguments") : input
  const text = field(args, "text")
  return typeof called === "string" && called.endsWith(SAY) && typeof text === "string"
    ? text.trim()
    : ""
}

/**
 * One exchange in plain words, as history_search shows it and history_read with `tools` (each call
 * and result cut short): what the experiment's history tools gave the model (.experiments/context).
 */
export const exchangeText = (rows: readonly Item[], tools: boolean) =>
  rows
    .flatMap((r): string[] => {
      switch (r.kind) {
        case "user": {
          if (r.text !== "") {
            return [`User: ${r.text}`]
          }
          const reason = reasonOf(r)
          return reason === "" ? [] : [`Woke: ${reason}`]
        }
        case "steer": {
          return [`User (while working): ${r.text}`]
        }
        case "wake": {
          return tools ? [`Woke (while working): ${r.text}`] : []
        }
        case "text": {
          return [`Switch: ${r.text}`]
        }
        case "tool": {
          const words = sayWords(r.name, r.input)
          if (words !== "" && !tools) {
            return [`Switch said: ${words}`]
          }
          return tools ? [`Switch called ${r.name} ${JSON.stringify(r.input).slice(0, 400)}`] : []
        }
        case "result": {
          return tools ? [`→ ${r.output.slice(0, 800)}`] : []
        }
        default: {
          return r satisfies never
        }
      }
    })
    .join("\n")

/**
 * `full` is how many of the last exchanges keep their tool calls, results and deltas; `budget`,
 * the tokens the exchanges kept may take, newest first, the latest always. Unbounded, a long
 * space's record outgrew the compaction threshold: every turn compacted and wrote it all to the
 * prompt cache again.
 */
export const build = (
  rows: readonly Item[],
  options: { readonly full: number; readonly budget: number },
) => {
  const all = [...new Set(rows.map((r) => r.turn))]
  const fullFrom = new Set(all.slice(-options.full))
  const kept = keptTurns(rows, all, fullFrom, options.budget)
  const tools = new Set<string>()
  const results = new Set<string>()
  for (const r of rows) {
    if (r.kind === "tool") {
      tools.add(r.id)
    }
    if (r.kind === "result") {
      results.add(r.id)
    }
  }

  const messages: Message[] = []
  if (kept.size < all.length) {
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `(${all.length - kept.size} earlier exchanges are in the brain, not here: find them with history_search, read one with history_read.)`,
        },
      ],
    })
  }
  const push = (role: Message["role"], block: Block) => {
    const last = messages.at(-1)
    if (last?.role === role) {
      // Results must lead the message after their calls; a steer that came meanwhile follows.
      const at = last.content.findIndex((b) => b.type !== "tool_result")
      if (block.type === "tool_result" && at !== -1) {
        last.content.splice(at, 0, block)
      } else {
        last.content.push(block)
      }
    } else {
      messages.push({ role, content: [block] })
    }
  }
  for (const r of rows.filter((x) => kept.has(x.turn))) {
    const full = fullFrom.has(r.turn)
    switch (r.kind) {
      case "user": {
        const text = userText(r, full)
        if (text !== "") {
          push("user", { type: "text", text })
        }
        break
      }
      case "steer": {
        push("user", { type: "text", text: r.text })
        break
      }
      case "wake": {
        if (full) {
          push("user", { type: "text", text: r.text })
        }
        break
      }
      case "text": {
        push("assistant", { type: "text", text: r.text })
        break
      }
      case "tool": {
        // A call cut off before its result would be refused on resume.
        if (full && results.has(r.id)) {
          push("assistant", { type: "tool_use", id: apiId(r.id), name: r.name, input: r.input })
        }
        break
      }
      case "result": {
        if (full && tools.has(r.id)) {
          push("user", {
            type: "tool_result",
            tool_use_id: apiId(r.id),
            content: r.output,
            is_error: r.error,
          })
        }
        break
      }
      default: {
        r satisfies never
      }
    }
  }
  while (messages[0]?.role === "assistant") {
    messages.shift()
  }
  return messages
}

export const toJsonl = (
  messages: readonly Message[],
  options: { readonly session: string; readonly cwd: string; readonly model: string },
) => {
  let parent: string | null = null
  let time = Date.now() - messages.length * 1000
  const lines: string[] = []
  for (const m of messages) {
    const uuid = crypto.randomUUID()
    time += 1000
    const message =
      m.role === "user"
        ? m
        : {
            id: `msg_built_${uuid.slice(0, 8)}`,
            type: "message",
            role: "assistant",
            model: options.model,
            content: m.content,
            stop_reason: m.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          }
    lines.push(
      JSON.stringify({
        parentUuid: parent,
        isSidechain: false,
        userType: "external",
        cwd: options.cwd,
        sessionId: options.session,
        type: m.role,
        message,
        uuid,
        timestamp: new Date(time).toISOString(),
      }),
    )
    parent = uuid
  }
  return `${lines.join("\n")}\n`
}
