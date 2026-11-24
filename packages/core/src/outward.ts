// Whether a tool call reached outside, so running its turn again can't take it back: an edit then
// goes as a new message. Ported from Switchboard's judgment: an extension's tool changes something
// unless its name says it only looks; a command reaches outside when it pushes, posts or sends.
import { Option, Schema } from "effect"

const decodeTool = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      input: Schema.optionalKey(Schema.Unknown),
    }),
  ),
)

/** Verbs an extension's tool that only looks starts with. */
const LOOKS =
  /^(?:get|list|read|search|find|look|query|fetch|check|state|status|show|screenshot|text|tabs|value|watch|wait|scroll|hover|logs?|stat|describe|inspect|view|peek|preview|count)(?:_|$)/u

/** Commands that reach outside the machine they run on. */
const OUTWARD_COMMANDS = [
  "git push",
  "gh pr create",
  "gh pr merge",
  "gh pr comment",
  "gh issue",
  "gh release",
  "gh api -x",
  "curl -x post",
  "curl -x put",
  "curl -x patch",
  "curl -x delete",
  "--request post",
  "--data",
  "bun run deploy",
  "npm publish",
]

const field = (input: unknown, key: string) => {
  if (typeof input !== "object" || input === null || !(key in input)) {
    return ""
  }
  const v: unknown = Reflect.get(input, key)
  return typeof v === "string" ? v : ""
}

/** An extension's tool, by its own name: after the gateway's `mcp__apps__`, and `call_tool`'s target. */
const extensionTool = (name: string, input: unknown) => {
  const rest = name.slice("mcp__apps__".length)
  return rest === "call_tool" ? field(input, "name") : rest
}

/** Whether a transcript entry, a tool call as JSON, reached outside. */
export const outward = (body: string) =>
  Option.match(decodeTool(body), {
    onNone: () => false,
    onSome: ({ name, input }) => {
      if (name === "Bash") {
        const command = field(input, "command").toLowerCase()
        return OUTWARD_COMMANDS.some((c) => command.includes(c))
      }
      if (name.startsWith("mcp__apps__")) {
        const tool = extensionTool(name, input)
        if (tool === "" || tool === "search_tools") {
          return false
        }
        // `<app>_<tool>`: the app's name may hold underscores, so any segment may start the verb.
        const parts = tool.split("_")
        return !parts.some((_, i) => i > 0 && LOOKS.test(parts.slice(i).join("_")))
      }
      return false
    },
  })
