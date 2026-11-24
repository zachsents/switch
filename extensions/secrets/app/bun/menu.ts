// The menu bar: every command the window answers, with its shortcut, sent to the view, which runs
// it as a shortcut would.
import { ApplicationMenu } from "electrobun/main"
import type { ApplicationMenuItemConfig } from "electrobun/main"
import { Schema } from "effect"

import { Command } from "../shared/rpc.ts"

const item = (
  label: string,
  command: Command,
  accelerator?: string,
): ApplicationMenuItemConfig => ({
  label,
  action: "command",
  data: command,
  ...(accelerator !== undefined && { accelerator }),
})

const page = (label: string, p: Extract<Command, { kind: "page" }>["page"], key?: string) =>
  item(label, { kind: "page", page: p }, key)

const divider = { type: "divider" } as const

const MENU: ApplicationMenuItemConfig[] = [
  {
    label: "Secrets",
    submenu: [
      { role: "about" },
      divider,
      item("Lock", { kind: "lock" }, "CommandOrControl+L"),
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
      item("New Item", { kind: "new" }, "CommandOrControl+N"),
      divider,
      page("Import", "import"),
      page("Export", "export"),
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
      { role: "selectAll", accelerator: "CommandOrControl+A" },
    ],
  },
  {
    label: "View",
    submenu: [
      item("Find", { kind: "find" }, "CommandOrControl+F"),
      divider,
      page("Items", "items", "CommandOrControl+1"),
      page("Generator", "generator", "CommandOrControl+2"),
      page("Devices", "devices", "CommandOrControl+3"),
      page("Grants", "grants", "CommandOrControl+4"),
      page("Audit", "audit", "CommandOrControl+5"),
      divider,
      item("Back", { kind: "back" }, "CommandOrControl+["),
      item("Forward", { kind: "forward" }, "CommandOrControl+]"),
      divider,
      { role: "toggleFullScreen", accelerator: "Control+CommandOrControl+F" },
    ],
  },
  {
    label: "Item",
    submenu: [
      item("Next", { kind: "next" }, "CommandOrControl+Down"),
      item("Previous", { kind: "previous" }, "CommandOrControl+Up"),
      divider,
      item("Edit", { kind: "edit" }, "CommandOrControl+E"),
      item("Favorite", { kind: "favorite" }, "CommandOrControl+D"),
      item("Move to Trash", { kind: "delete" }, "CommandOrControl+Backspace"),
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
]

/** A click's event: the item's data is the command. */
const decode = Schema.decodeUnknownOption(Schema.Struct({ data: Schema.Struct({ data: Command }) }))

/** Draws the menu bar; what's chosen goes to `run`. */
export const menuBar = (run: (c: Command) => void) => {
  ApplicationMenu.setApplicationMenu(MENU)
  ApplicationMenu.on("application-menu-clicked", (e) => {
    const chosen = decode(e)
    if (chosen._tag === "Some") {
      run(chosen.value.data.data)
    }
  })
}
