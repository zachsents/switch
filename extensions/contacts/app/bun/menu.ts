// The menu bar: every command the window answers, with its shortcut, sent to the view, which runs
// it as a shortcut would.
import { ApplicationMenu } from "electrobun/main"
import type { ApplicationMenuItemConfig } from "electrobun/main"
import { Schema } from "effect"

import { Command } from "../shared/commands.ts"

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

const divider = { type: "divider" } as const

const MENU: ApplicationMenuItemConfig[] = [
  {
    label: "Contacts",
    submenu: [
      { role: "about" },
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
      item("New Person", { kind: "new" }, "CommandOrControl+N"),
      item("Import Address Books", { kind: "import" }),
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
      { role: "delete" },
      { role: "selectAll", accelerator: "CommandOrControl+A" },
      divider,
      item("Undo Last Change", { kind: "undo" }, "CommandOrControl+Alt+Z"),
    ],
  },
  {
    label: "View",
    submenu: [
      item("Find", { kind: "find" }, "CommandOrControl+F"),
      divider,
      item("People", { kind: "people" }, "CommandOrControl+1"),
      item("Changes", { kind: "changes" }, "CommandOrControl+2"),
      divider,
      item("Back", { kind: "back" }, "CommandOrControl+["),
      item("Forward", { kind: "forward" }, "CommandOrControl+]"),
      divider,
      { role: "toggleFullScreen", accelerator: "Control+CommandOrControl+F" },
    ],
  },
  {
    label: "Person",
    submenu: [
      item("Next", { kind: "next" }, "CommandOrControl+Down"),
      item("Previous", { kind: "previous" }, "CommandOrControl+Up"),
      divider,
      item("Merge Picked", { kind: "merge" }, "CommandOrControl+Shift+M"),
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
