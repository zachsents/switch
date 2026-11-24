// What the window can be told to do, from a shortcut, the palette or the menu bar: one list, so
// each does the same thing however it's asked. Shared by the view and the bun process.
import { Schema } from "effect"
import type { RPCSchema } from "electrobun/view"

import type { Dictate, Heard } from "./dictation.ts"

export const Command = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals([
      "find",
      "findIn",
      "message",
      "home",
      "up",
      "next",
      "previous",
      "back",
      "forward",
      "connections",
      "shortcuts",
      "memory",
      "system",
      "dictate",
      "stop",
    ]),
  }),
  Schema.Struct({ kind: Schema.Literal("space"), id: Schema.String }),
  /** Done to a space: the one open, or the one right-clicked. */
  Schema.Struct({
    kind: Schema.Literals(["rename", "split", "archive", "unarchive", "copyLink"]),
    id: Schema.String,
  }),
  /** `to` null is the top level. */
  Schema.Struct({
    kind: Schema.Literal("move"),
    id: Schema.String,
    to: Schema.NullOr(Schema.String),
  }),
  /** Settings, open at one of its sections. */
  Schema.Struct({ kind: Schema.Literal("settings"), section: Schema.String }),
  /** A `switchboard://` link opened. */
  Schema.Struct({ kind: Schema.Literal("link"), url: Schema.String }),
])
export type Command = typeof Command.Type

const Listed = Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))

/** A space's menu: what can be done to it, and where it can move. */
export const SpaceMenu = Schema.Struct({
  id: Schema.String,
  home: Schema.Boolean,
  archived: Schema.Boolean,
  /** Spaces it can move into: not itself or one inside it. */
  moveTo: Listed,
})
export type SpaceMenu = typeof SpaceMenu.Type

/** What the menu bar lists that changes: every space, the ones inside the space open, and it. */
export const MenuModel = Schema.Struct({ spaces: Listed, inside: Listed, here: SpaceMenu })
export type MenuModel = typeof MenuModel.Type

/** An action item, opened in a window of its own, with what the main window holds of it (the item
 * and its space's ring and name, read by the view) so it shows at once. */
export interface ItemWindow {
  readonly id: string
  readonly held?: unknown
}

/** The core and this window's credential, or the code the bun process waits on while it pairs. */
export type Auth =
  | { readonly core: string; readonly token: string }
  | { readonly core: string; readonly code: string }

/** What's on screen: sent on every change and every couple of seconds, which is how a hang shows. */
export interface Shown {
  /** The space open, null on a side page. */
  readonly space: string | null
  /** The page, as a line for a report: `space Home`, `thread …`. */
  readonly screen: string
  /** The last steps, oldest first. */
  readonly trail: readonly string[]
  /** Whether the page is on screen: a hidden or occluded one's timers are held back. */
  readonly visible?: boolean
}

/** A crash, hang or error, for the view to send to the brain as `client.crashed`. */
export interface Report {
  readonly id: string
  readonly device: string
  readonly kind: "crash" | "hang" | "error"
  readonly build: string
  readonly at: number
  readonly summary: string
  readonly screen: string
  readonly trail: readonly string[]
  readonly report?: string
}

/** What's this Mac's own. */
export interface Local {
  readonly login: boolean
  readonly autoUpdate: boolean
  readonly error?: string
}

/** A long reply, opened whole in a window of its own. */
export interface Reading {
  readonly title: string
  readonly text: string
}

/** What a window of one thing is told to show. */
export type Shows =
  | { readonly kind: "item"; readonly item: ItemWindow }
  | { readonly kind: "read"; readonly reading: Reading }
  | { readonly kind: "widget"; readonly view: WidgetWindow }
  | { readonly kind: "settings"; readonly section: string }

/** An extension view returned by a connection action. */
export const WidgetWindow = Schema.Struct({
  app: Schema.String,
  name: Schema.String,
  input: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})
export type WidgetWindow = typeof WidgetWindow.Type

export const ConnectionStart = Schema.Struct({
  tool: Schema.Literals(["connect", "oauth"]),
  provider: Schema.String,
  account: Schema.optionalKey(Schema.String),
  scopes: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type ConnectionStart = typeof ConnectionStart.Type
export type ConnectionResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string }

/** The version running, and one downloaded that waits to be applied ("" for none). */
export const Update = Schema.Struct({ current: Schema.String, waiting: Schema.String })
export type Update = typeof Update.Type

/** A file in a chat, to open, look at, show in Finder, save, or choose which from its menu. */
export const FileAsk = Schema.Struct({
  url: Schema.String,
  name: Schema.String,
  do: Schema.Literals(["open", "look", "show", "download", "menu"]),
})
export type FileAsk = typeof FileAsk.Type

/** A gallery's pictures in Quick Look, at the one clicked. */
export const PicturesAsk = Schema.Struct({
  pictures: Schema.Array(Schema.Struct({ url: Schema.String, name: Schema.String })),
  at: Schema.Number,
})
export type PicturesAsk = typeof PicturesAsk.Type

/** The view and the bun process, as Electrobun's RPC types them: the menu bar, windows, updates, dictation, pairing and reports. */
export interface MenuRPC {
  readonly bun: RPCSchema<{
    requests: {
      connection: { params: ConnectionStart; response: ConnectionResult }
      /** A file's ask, answered once it's done (an Open, once the file is fetched and opened). */
      file: { params: FileAsk; response: boolean }
    }
    messages: {
      connectionCancel: { readonly provider: string }
      menu: MenuModel
      read: Reading
      widget: WidgetWindow
      item: ItemWindow
      close: undefined
      /** A view has loaded: it's sent the credential to reach its core. */
      hello: undefined
      /** The user typed into a field: an update holds off a minute (old hold.rs). */
      typed: undefined
      /** Opens Settings (one window), at a section. */
      settings: { readonly section: string }
      /** Text size: every window's zoom. */
      zoom: { readonly factor: number }
      /** What's this Mac's own: launching at login, updating by itself; asking tells the state. */
      local: { readonly login?: boolean; readonly autoUpdate?: boolean }
      /** Where notifications go and whether they're quiet while the app is open (the brain's pref). */
      notify: { readonly here: boolean; readonly quietOpen: boolean }
      /** A window of one thing has drawn what it was told to show: it can come on screen. */
      ready: undefined
      /** A window of one thing's first frames are drawn on screen: it's made seen. */
      seen: undefined
      /** A window's content is on screen: the end of its open's timing. */
      painted: undefined
      /** A window of one thing (an ask) fits its height to this. */
      fit: { readonly height: number }
      update: { readonly apply: boolean }
      pictures: PicturesAsk
      dictate: Dictate
      /** A space's right-click menu, at the pointer. */
      spaceMenu: SpaceMenu
      /** Text onto the clipboard. */
      copy: string
      shown: Shown
      /** A report from the view itself (an error), or one the bun process sent, now in the brain. */
      reported: { readonly id: string }
      error: { readonly summary: string; readonly report: string }
    }
  }>
  readonly webview: RPCSchema<{
    messages: {
      command: Command
      update: Update
      heard: Heard
      auth: Auth
      report: Report
      local: Local
      /** What a window of one thing shows. */
      show: Shows
    }
  }>
}

/** A space's link, as Copy Link gives it and the iPhone opens it. */
export const spaceLink = (id: string) => `switchboard://space/${encodeURIComponent(id)}`
