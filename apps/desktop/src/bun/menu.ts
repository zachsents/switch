// The menu bar: every command the window answers, with its shortcut, sent to the view, which runs
// it as a shortcut or the palette would. The spaces it lists come from the view, and so do a
// space's right-click menus, drawn natively here. Dictation shares
// the window's RPC.
import { ApplicationMenu, BrowserView, ContextMenu, Utils } from "electrobun/main"
import type { ApplicationMenuItemConfig } from "electrobun/main"
import { Schema } from "effect"

import { Command } from "../shared/commands.ts"
import type { MenuModel, MenuRPC, Shown, SpaceMenu } from "../shared/commands.ts"
import { dictate } from "./dictation.ts"
import { connectionRelay } from "./oauth-relay.ts"
import { openItem, openReading, openWidget, setZoom, windowAuth } from "./reading.ts"
import { registerWindowState, windowMessages } from "./window-state.ts"
import type { WindowSender } from "./window-state.ts"
import { onFile } from "./files.ts"

const item = (
  label: string,
  command: Command,
  accelerator?: string,
): ApplicationMenuItemConfig => ({
  label,
  action: JSON.stringify(command),
  ...(accelerator !== undefined && { accelerator }),
})

const divider = { type: "divider" } as const

/** What can be done to a space, in its right-click menu and the Space menu. */
const spaceItems = (m: SpaceMenu, keys: boolean): ApplicationMenuItemConfig[] => {
  const key = (accelerator: string) => (keys ? accelerator : undefined)
  const copy = item("Copy Link", { kind: "copyLink", id: m.id })
  const split = item("Split Off", { kind: "split", id: m.id }, key("CommandOrControl+Shift+N"))
  if (m.home) {
    return [split, copy]
  }
  return [
    item("Rename…", { kind: "rename", id: m.id }),
    split,
    {
      label: "Move To",
      submenu: [
        item("Top Level", { kind: "move", id: m.id, to: null }),
        ...(m.moveTo.length > 0 ? [divider] : []),
        ...m.moveTo.map((s) => item(s.name, { kind: "move", id: m.id, to: s.id })),
      ],
    },
    copy,
    divider,
    m.archived
      ? item("Unarchive", { kind: "unarchive", id: m.id })
      : item("Archive", { kind: "archive", id: m.id }),
  ]
}

const build = (model: MenuModel): ApplicationMenuItemConfig[] => [
  {
    label: "Switch",
    submenu: [
      { role: "about" },
      divider,
      item("Settings…", { kind: "settings", section: "general" }, "CommandOrControl+,"),
      divider,
      { role: "hide", accelerator: "CommandOrControl+H" },
      { role: "hideOthers", accelerator: "CommandOrControl+Alt+H" },
      { role: "showAll" },
      divider,
      { role: "quit", accelerator: "CommandOrControl+Q" },
    ],
  },
  {
    label: "File",
    submenu: [
      item("New Message", { kind: "message" }, "CommandOrControl+N"),
      item("Chat", { kind: "message" }, "CommandOrControl+L"),
      divider,
      { role: "close", accelerator: "CommandOrControl+W" },
    ],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo", accelerator: "CommandOrControl+Z" },
      { role: "redo", accelerator: "CommandOrControl+Shift+Z" },
      divider,
      { role: "cut", accelerator: "CommandOrControl+X" },
      { role: "copy", accelerator: "CommandOrControl+C" },
      { role: "paste", accelerator: "CommandOrControl+V" },
      { role: "pasteAndMatchStyle", accelerator: "CommandOrControl+Alt+Shift+V" },
      { role: "delete" },
      { role: "selectAll", accelerator: "CommandOrControl+A" },
      divider,
      item("Dictate", { kind: "dictate" }, "CommandOrControl+D"),
      item("Find in Chat", { kind: "findIn" }, "CommandOrControl+F"),
    ],
  },
  {
    label: "View",
    submenu: [
      item("Find", { kind: "find" }, "CommandOrControl+K"),
      divider,
      { role: "zoom" },
      { role: "toggleFullScreen", accelerator: "Control+CommandOrControl+F" },
    ],
  },
  {
    label: "Go",
    submenu: [
      item("Back", { kind: "back" }, "CommandOrControl+["),
      item("Forward", { kind: "forward" }, "CommandOrControl+]"),
      divider,
      item("Home", { kind: "home" }, "CommandOrControl+Shift+H"),
      item("Enclosing Space", { kind: "up" }),
      item("Previous Space", { kind: "previous" }, "CommandOrControl+Up"),
      item("Next Space", { kind: "next" }, "CommandOrControl+Down"),
      {
        label: "Spaces",
        submenu: model.spaces.map((s) => item(s.name, { kind: "space", id: s.id })),
      },
    ],
  },
  {
    label: "Space",
    submenu: [
      item("Stop", { kind: "stop" }, "CommandOrControl+."),
      divider,
      ...spaceItems(model.here, true),
      divider,
      item("Connections", { kind: "connections" }),
      item("Memory", { kind: "memory" }),
      ...(model.inside.length > 0 ? [divider] : []),
      ...model.inside.map((s) => item(s.name, { kind: "space", id: s.id })),
    ],
  },
  {
    label: "Window",
    submenu: [
      { role: "minimize", accelerator: "CommandOrControl+M" },
      { role: "zoom" },
      divider,
      { role: "bringAllToFront" },
    ],
  },
  {
    label: "Help",
    submenu: [item("Keyboard Shortcuts", { kind: "shortcuts" }, "CommandOrControl+/")],
  },
]

const EMPTY: MenuModel = {
  spaces: [],
  inside: [],
  here: { id: "home", home: true, archived: false, moveTo: [] },
}

/**
 * A click's event: the item's action is the command, as JSON. Not its `data`, which Electrobun
 * sends only on an item's first click.
 */
const decode = Schema.decodeUnknownOption(
  Schema.Struct({ data: Schema.Struct({ action: Schema.fromJsonString(Command) }) }),
)

/** What else the view tells this process: what's on screen, and its reports. */
export interface Told {
  /** The view's first word: what waited on it (a link the app was opened with) can go. */
  readonly ready: () => void
  /** The view has loaded: it wants its credential. */
  readonly hello: () => void
  readonly typed: () => void
  readonly settings: (section: string) => void
  readonly notify: (n: { readonly here: boolean; readonly quietOpen: boolean }) => void
  readonly shown: (s: Shown) => void
  readonly reported: (id: string) => void
  readonly error: (e: { readonly summary: string; readonly report: string }) => void
}

/** Draws the menu bar now, and again whenever the view says its spaces changed. */
export const menuRPC = (told: Told) => {
  const connection = connectionRelay(windowAuth, (url) => {
    Utils.openExternal(url)
  })
  ApplicationMenu.setApplicationMenu(build(EMPTY))
  const rpc = BrowserView.defineRPC<MenuRPC>({
    handlers: {
      requests: { connection: connection.connect, file: onFile },
      messages: {
        connectionCancel: connection.cancel,
        ...windowMessages((): WindowSender => rpc.send, setZoom),
        menu: (model) => {
          ApplicationMenu.setApplicationMenu(build(model))
          told.ready()
        },
        spaceMenu: (m) => {
          ContextMenu.showContextMenu(spaceItems(m, false))
        },
        shown: told.shown,
        hello: told.hello,
        typed: told.typed,
        settings: (s) => {
          told.settings(s.section)
        },
        notify: told.notify,
        reported: (r) => {
          told.reported(r.id)
        },
        error: told.error,
        read: openReading,
        widget: openWidget,
        item: openItem,
        dictate: (d) => {
          dictate(d, (heard) => {
            rpc.send.heard(heard)
          })
        },
      },
    },
  })
  registerWindowState(rpc.send)
  const chosen = (e: unknown) => {
    const c = decode(e)
    if (c._tag === "Some") {
      rpc.send.command(c.value.data.action)
    }
  }
  ApplicationMenu.on("application-menu-clicked", chosen)
  ContextMenu.on("context-menu-clicked", chosen)
  return rpc
}
