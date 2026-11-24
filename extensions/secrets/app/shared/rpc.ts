// What the view and the bun process say to each other. The bun process holds the vault key and
// every opened item; the view sees items without their concealed values, and gets one only by
// asking for it (reveal), after the Mac's own check. Shared by both sides.
import { Schema } from "effect"
import type { RPCSchema } from "electrobun/view"

import type { Source } from "../../src/imports.ts"
import type { FieldType, Item, Kind, Url } from "../../src/model.ts"

export const PAGES = [
  "items",
  "generator",
  "devices",
  "grants",
  "audit",
  "import",
  "export",
] as const
export type Page = (typeof PAGES)[number]

/** What the window can be told to do, from a shortcut or the menu bar. */
export const Command = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals([
      "find",
      "new",
      "edit",
      "favorite",
      "delete",
      "back",
      "forward",
      "next",
      "previous",
      "lock",
    ]),
  }),
  Schema.Struct({ kind: Schema.Literal("page"), page: Schema.Literals(PAGES) }),
  /** An item by id or name. */
  Schema.Struct({ kind: Schema.Literal("open"), item: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("search"), query: Schema.String }),
])
export type Command = typeof Command.Type

/** Where this Mac stands with the vault. */
export interface Status {
  /** `pending`: enrolled, its code waiting to be approved; `open`: unlocked. */
  readonly stage: "starting" | "pending" | "revoked" | "failed" | "locked" | "open"
  readonly code: string
  readonly error: string
  /** The core answered the last sync. */
  readonly online: boolean
  readonly device: string
}

/** A field as the view sees it: a concealed one by label and type only. */
export interface ShownField {
  readonly id: string
  readonly label: string
  readonly type: FieldType
  readonly concealed: boolean
  /** A plain field's value; "" for a concealed one. */
  readonly value: string
  readonly set: boolean
}

/** An item as the view sees it. */
export type ShownItem = Omit<Item, "id" | "fields" | "notes"> & {
  readonly id: string
  readonly fields: readonly ShownField[]
  /** Notes are concealed too: whether it has any; revealed as the field "notes". */
  readonly notes: boolean
}

/** The field id notes are revealed and copied by. */
export const NOTES = "notes"

/** A field to save: `value` absent keeps what it holds. */
export interface FieldDraft {
  readonly id: string
  readonly label: string
  readonly type: FieldType
  readonly value?: string
}

export interface ItemDraft {
  /** Absent: a new item. */
  readonly id?: string
  readonly kind: Kind
  readonly title: string
  readonly name: string
  readonly fields: readonly FieldDraft[]
  readonly urls: readonly Url[]
  /** Absent keeps what it holds. */
  readonly notes?: string
  readonly tags: readonly string[]
  readonly folder: string
  readonly spaces: readonly string[]
  readonly favorite: boolean
}

export interface Version {
  readonly at: number
  readonly fields: readonly ShownField[]
}

export interface Code {
  readonly code: string
  readonly period: number
  /** ms until the next code. */
  readonly left: number
}

export interface Generate {
  readonly style: "random" | "apple" | "pin"
  readonly length: number
  readonly digits: boolean
  readonly symbols: boolean
}

export interface DeviceRow {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly key: string
  readonly code: string
  readonly status: string
  readonly created: number
  readonly seen: number
}

export interface ExtensionRow {
  readonly name: string
  readonly key: string
  readonly code: string
  readonly status: string
  readonly created: number
}

export interface GrantRow {
  readonly id: string
  readonly subject: string
  readonly scope: string
  readonly uses: readonly string[]
}

export interface Members {
  readonly devices: readonly DeviceRow[]
  readonly extensions: readonly ExtensionRow[]
  readonly grants: readonly GrantRow[]
}

export interface Entry {
  readonly id: number
  readonly at: number
  readonly item: string
  readonly name: string
  readonly field: string
  readonly use: string
  readonly who: string
  readonly space: string
  readonly why: string
  readonly target: string
  readonly ok: boolean
  readonly reason: string
}

/** What an import would add, before it does. */
export interface Preview {
  readonly file: string
  readonly total: number
  readonly kinds: readonly { readonly kind: string; readonly count: number }[]
  /** Already in the vault by title and username: skipped. */
  readonly skipped: number
}

interface Req<P, R> {
  params: P
  response: R
}
type None = Record<string, never>

/** The view and the bun process, as Electrobun's RPC types them: each side's key is what it answers. */
export interface AppRPC {
  readonly bun: RPCSchema<{
    requests: {
      status: Req<None, Status>
      unlock: Req<None, Status>
      lock: Req<None, Status>
      retry: Req<None, Status>
      items: Req<None, readonly ShownItem[]>
      item: Req<{ id: string }, ShownItem | null>
      reveal: Req<{ id: string; field: string; at?: number }, string>
      copy: Req<{ id: string; field: string; at?: number }, null>
      /** Copies a value the view already shows (a generated password), concealed and cleared. */
      copyText: Req<{ text: string }, null>
      code: Req<{ id: string; field: string }, Code>
      history: Req<{ id: string }, readonly Version[]>
      restore: Req<{ id: string; at: number; field: string }, null>
      save: Req<{ draft: ItemDraft }, string>
      generate: Req<Generate, string>
      trash: Req<{ id: string; restore: boolean }, null>
      purge: Req<{ id: string }, null>
      audit: Req<{ item?: string }, readonly Entry[]>
      members: Req<None, Members>
      approveDevice: Req<{ id: string }, null>
      revokeDevice: Req<{ id: string }, null>
      approveExtension: Req<{ name: string }, null>
      revokeExtension: Req<{ name: string }, null>
      grant: Req<{ op: "add" | "remove"; grant: GrantRow }, null>
      importPick: Req<None, string | null>
      importPreview: Req<{ source: Source; file: string }, Preview>
      importConfirm: Req<None, number>
      export: Req<{ format: "csv" | "json" }, string | null>
      openUrl: Req<{ url: string }, null>
    }
    messages: None
  }>
  readonly webview: RPCSchema<{
    requests: None
    messages: { command: Command; changed: None }
  }>
}
