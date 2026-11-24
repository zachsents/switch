// Provider-owned approval cards keep their draft, sending action and navigation together.
import { hashOf } from "@switch/brain"
import { Schema } from "effect"

import { Draft, DraftCopy } from "./items.ts"

const args = Schema.Record(Schema.String, Schema.Unknown)
export const ItemLink = Schema.Struct({
  label: Schema.String,
  url: Schema.String.check(Schema.isPattern(/^https?:\/\//u)),
})
const assist = Schema.Union([
  ItemLink,
  Schema.Struct({ label: Schema.String, tool: Schema.String, args }),
  Schema.Struct({ label: Schema.String, target: Schema.String, action: Schema.String, args }),
])

/** A draft as a receipt gives it: its copy's tool named like an assist's (`target`, `action`). */
const ReceiptDraft = Schema.Struct({
  ...Draft.fields,
  copy: Schema.optionalKey(
    Schema.Union([
      DraftCopy,
      Schema.Struct({ target: Schema.String, action: Schema.String, args }),
    ]),
  ),
})

/** The existing provider's `ask` receipt, passed intact to action_item. */
export const PreparedAsk = Schema.Struct({
  type: Schema.Literal("approval"),
  title: Schema.String,
  text: Schema.String,
  drafts: Schema.Array(ReceiptDraft),
  assists: Schema.Array(assist),
  blobs: Schema.optionalKey(
    Schema.Array(Schema.Struct({ blob: Schema.String, name: Schema.String, type: Schema.String })),
  ),
  resolve_when: Schema.optionalKey(Schema.String),
})

/** A listed tool, or an explicitly qualified call from an existing item. */
export const itemCall = (given: {
  readonly app?: string
  readonly tool: string
  readonly args: Readonly<Record<string, unknown>>
}) => {
  if (given.app !== undefined && given.app !== "") {
    return { app: given.app, tool: given.tool, args: given.args }
  }
  const [app = "", ...rest] = given.tool.split("_")
  if (!app || rest.length === 0) {
    throw new Error("Use a listed app_tool, or give app and tool separately")
  }
  return { app, tool: rest.join("_"), args: given.args }
}

/** Translate once at the receipt boundary, without recreating the provider's draft. */
export const preparedFields = (ask: typeof PreparedAsk.Type) => {
  const calls = ask.assists.flatMap((a) =>
    "url" in a
      ? []
      : [
          "tool" in a
            ? itemCall(a)
            : { app: a.target.split("@")[0] ?? "", tool: a.action, args: a.args },
        ],
  )
  if (calls.length !== 1) {
    throw new Error("An approval card needs exactly one sending action")
  }
  const attachments = (ask.blobs ?? []).map((a) => {
    const blob = hashOf(a.blob)
    if (!blob) {
      throw new Error(`Invalid attachment blob: ${a.name}`)
    }
    return { ...a, blob }
  })
  return {
    title: ask.title,
    body: ask.text,
    kind: ask.type,
    drafts: ask.drafts.map(({ copy, ...d }): typeof Draft.Type =>
      copy === undefined
        ? d
        : {
            ...d,
            copy:
              "target" in copy
                ? { app: copy.target.split("@")[0] ?? "", tool: copy.action, args: copy.args }
                : copy,
          },
    ),
    links: ask.assists.flatMap((a) => ("url" in a ? [a] : [])),
    attachments,
    send: calls[0],
    ...(ask.resolve_when === undefined ? {} : { resolve_when: ask.resolve_when }),
  }
}
