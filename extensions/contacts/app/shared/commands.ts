// What the window can be told to do, from a shortcut, the menu bar or the agent: one list, so each
// does the same thing however it's asked. Shared by the view and the bun process.
import { Schema } from "effect"
import type { RPCSchema } from "electrobun/view"

export const Command = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals([
      "find",
      "new",
      "people",
      "changes",
      "back",
      "forward",
      "next",
      "previous",
      "merge",
      "undo",
      "import",
    ]),
  }),
  /** A person by id, phone, email or exact name. */
  Schema.Struct({ kind: Schema.Literal("open"), person: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("search"), query: Schema.String }),
  /** People picked for a merge, by id. */
  Schema.Struct({ kind: Schema.Literal("pick"), people: Schema.Array(Schema.String) }),
])
export type Command = typeof Command.Type

/** What's on screen, for the agent. */
export const Shown = Schema.Struct({
  page: Schema.Literals(["people", "changes", "merge"]),
  person: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
  query: Schema.String,
  listed: Schema.Finite,
  picked: Schema.Array(Schema.String),
})
export type Shown = typeof Shown.Type

/** Seen by the user: a surface ("contacts/person") and what in it; `ms` once they left it. */
export const Seen = Schema.Struct({
  surface: Schema.String,
  item: Schema.optionalKey(Schema.String),
  ms: Schema.optionalKey(Schema.Finite),
})
export type Seen = typeof Seen.Type

/** The view and the bun process, as Electrobun's RPC types them: each side's key is what it answers. */
export interface AppRPC {
  readonly bun: RPCSchema<{ messages: { seen: Seen; left: Seen } }>
  readonly webview: RPCSchema<{
    requests: { shown: { params: Record<string, never>; response: Shown } }
    messages: { command: Command }
  }>
}
