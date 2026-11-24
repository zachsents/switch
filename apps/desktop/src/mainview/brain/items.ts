// Action items as the UI reads them: autonomy's items.ts, mirrored here in Effect Schema since the
// view can't take the brain's server code. The snapshot's `actions` are the open ones, oldest
// first, and `closedActions` the latest closed, newest first; `item.opened`, `.revised` and
// `.reopened` carry the whole item, `item.closed` and `.answered` close it.
import { ModelTag, recordOf, SpaceId } from "@switch/brain/commands"
import { Schema } from "effect"

const call = Schema.Struct({
  app: Schema.String,
  tool: Schema.String,
  args: Schema.Record(Schema.String, Schema.Unknown),
})

export const Draft = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  text: Schema.String,
})
export type Draft = typeof Draft.Type

export const Attachment = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  size: Schema.optionalKey(Schema.Finite),
  blob: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  option: Schema.optionalKey(Schema.Finite),
})
export type Attachment = typeof Attachment.Type

export const KINDS = ["task", "question", "approval", "sealed"] as const
export type Kind = (typeof KINDS)[number]

const fields = Schema.Struct({
  id: Schema.String,
  space: SpaceId,
  title: Schema.String,
  body: Schema.String,
  action: Schema.optionalKey(Schema.Struct({ label: Schema.String, ...call.fields })),
  kind: Schema.optionalKey(Schema.Literals(KINDS)),
  completion: Schema.optionalKey(Schema.Literal("owner")),
  options: Schema.optionalKey(Schema.Array(Schema.String)),
  drafts: Schema.optionalKey(Schema.Array(Draft)),
  links: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        label: Schema.String,
        url: Schema.String.check(Schema.isPattern(/^https?:\/\//u)),
      }),
    ),
  ),
  attachments: Schema.optionalKey(Schema.Array(Attachment)),
  send: Schema.optionalKey(call),
  app: Schema.optionalKey(Schema.String),
  sealed: Schema.optionalKey(Schema.Struct({ key: Schema.String, use: Schema.String })),
  /** A live view on the card: the Mac's screen, about an app's session (core/portal.ts). */
  portal: Schema.optionalKey(Schema.Struct({ app: Schema.String, session: Schema.String })),
  /** Out of the user's queue while the agent reworks it. */
  revising: Schema.optionalKey(Schema.Struct({ thread: Schema.optionalKey(Schema.String) })),
  /** The user's own version of drafts, by name, saved as he edits (not an approval). */
  edits: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** The model that wrote it. */
  model: Schema.optionalKey(ModelTag),
  /** A closed one's answer: Approve or Decline, the option picked, the words typed, each draft as
   * approved (autonomy's `Answer`). */
  answer: Schema.optionalKey(
    Schema.Struct({
      approved: Schema.optionalKey(Schema.Boolean),
      choice: Schema.optionalKey(Schema.String),
      text: Schema.optionalKey(Schema.String),
      drafts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
  /** Whether what Approve ran went through. */
  ran: Schema.optionalKey(Schema.Struct({ ok: Schema.Boolean })),
  seq: Schema.optionalKey(Schema.Finite),
  status: Schema.optionalKey(Schema.String),
  closedAt: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
})

/** An item's fields, or null (said in the log) when they don't read: the rest still show. */
const read = recordOf("action item", fields)

export type Action = NonNullable<typeof fields.Type.action>

export interface ActionItem extends Omit<
  typeof fields.Type,
  "kind" | "seq" | "status" | "closedAt"
> {
  readonly kind: Kind
  /** When it opened, for order. */
  readonly at: number
  /** How it closed, once it has. */
  readonly status: string
  readonly closedAt: number | null
}

/** An approval's when it has words to send or a call to make, a question's when it has options. */
const kindOf = (f: typeof fields.Type): Kind => {
  if (f.kind) {
    return f.kind
  }
  if (f.send || f.drafts) {
    return "approval"
  }
  return f.options && f.options.length > 0 ? "question" : "task"
}

/** A draft's words as the card shows them: the user's version, else the agent's. */
export const shownText = (item: ActionItem, d: Draft) => item.edits?.[d.name] ?? d.text

/** An item from the snapshot or an event; null when it isn't one. */
export const itemOf = (raw: unknown, at: number): ActionItem | null => {
  const got = read(raw)
  if (!got) {
    return null
  }
  const { seq, status, closedAt, ...f } = got
  return {
    ...f,
    kind: kindOf(f),
    at: seq ?? at,
    status: status ?? "open",
    closedAt: closedAt ?? null,
  }
}
