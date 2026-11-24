import { Schema } from "effect"

const image = Schema.Struct({ data: Schema.String, mimeType: Schema.String })
const permissions = Schema.Struct({
  mode: Schema.String,
  tools: Schema.Array(Schema.String),
  delegate: Schema.Boolean,
})
export const cursorRequest = Schema.Struct({
  id: Schema.Number,
  method: Schema.Literals(["open", "send", "cancel", "effort", "status"]),
  params: Schema.Struct({
    cwd: Schema.optionalKey(Schema.String),
    session: Schema.optionalKey(Schema.NullOr(Schema.String)),
    model: Schema.optionalKey(Schema.String),
    effort: Schema.optionalKey(Schema.String),
    system: Schema.optionalKey(Schema.String),
    history: Schema.optionalKey(Schema.String),
    configDir: Schema.optionalKey(Schema.String),
    permissions: Schema.optionalKey(permissions),
    mcp: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        Schema.Struct({ url: Schema.String, token: Schema.optionalKey(Schema.String) }),
      ),
    ),
    text: Schema.optionalKey(Schema.String),
    uuid: Schema.optionalKey(Schema.String),
    priority: Schema.optionalKey(Schema.String),
    images: Schema.optionalKey(Schema.Array(image)),
  }),
})
export type CursorRequest = typeof cursorRequest.Type

const block = Schema.Struct({
  type: Schema.String,
  text: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.Unknown),
  tool_use_id: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.String),
  is_error: Schema.optionalKey(Schema.Boolean),
})
const usage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadInputTokens: Schema.Number,
  cacheCreationInputTokens: Schema.Number,
  costUSD: Schema.Number,
})
export const cursorEvent = Schema.Struct({
  type: Schema.String,
  message: Schema.optionalKey(Schema.Struct({ content: Schema.Array(block) })),
  event: Schema.optionalKey(
    Schema.Struct({
      type: Schema.String,
      delta: Schema.optionalKey(
        Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) }),
      ),
    }),
  ),
  command_uuid: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.String),
  is_error: Schema.optionalKey(Schema.Boolean),
  result: Schema.optionalKey(Schema.String),
  model_usage_since_last_result: Schema.optionalKey(Schema.Record(Schema.String, usage)),
  rate_limit_info: Schema.optionalKey(Schema.Struct({ status: Schema.String })),
})
