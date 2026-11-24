// The window's shortcuts. In Electrobun the menu bar owns the same keys and sends the same
// commands; these answer them in a browser, and Escape everywhere: it drops a dictation under way,
// else goes up. SHORTCUTS lists them for ⌘/.
import type { SpaceId } from "@switch/brain"
import { useShortcut } from "@ui-sdk/react/shortcuts"

import type { Command } from "../../shared/commands.ts"
import { cancelDictation, isDictating } from "../dictation/dictation.ts"

const ANYWHERE = { allowInInput: true } as const

/** In the app the menu bar has these keys, and a second answer from the page would run them twice. */
const BROWSER_ONLY = { ...ANYWHERE, when: () => !("__electrobun" in window) } as const

/** Every shortcut, as the ⌘/ sheet lists them. */
export const SHORTCUTS: readonly (readonly [string, string])[] = [
  ["Find", "⌘K"],
  ["Find in Chat", "⌘F"],
  ["New Message", "⌘N"],
  ["Chat", "⌘L"],
  ["To the Message Box", "/"],
  ["Send", "↵"],
  ["New Line", "⇧↵"],
  ["Dictate", "⌘D"],
  ["Go Home", "⇧⌘H"],
  ["Previous Space", "⌘↑"],
  ["Next Space", "⌘↓"],
  ["Enclosing Space", "Esc"],
  ["Back", "⌘["],
  ["Forward", "⌘]"],
  ["Split Off", "⇧⌘N"],
  ["Settings", "⌘,"],
  ["Close Window", "⌘W"],
  ["Keyboard Shortcuts", "⌘/"],
]

const useKey = (run: (c: Command) => void, keys: string, c: Command) => {
  useShortcut(
    keys,
    () => {
      run(c)
    },
    BROWSER_ONLY,
  )
}

export const useShortcuts = (
  run: (c: Command) => void,
  here: SpaceId,
  /** Something of its own (⌘K, ⌘F's bar, a sheet, a rename) takes Escape. */
  busy: boolean,
) => {
  useKey(run, "mod+k", { kind: "find" })
  useKey(run, "mod+f", { kind: "findIn" })
  useKey(run, "mod+[", { kind: "back" })
  useKey(run, "mod+]", { kind: "forward" })
  useKey(run, "mod+shift+h", { kind: "home" })
  useKey(run, "mod+arrowup", { kind: "previous" })
  useKey(run, "mod+arrowdown", { kind: "next" })
  useKey(run, "mod+n", { kind: "message" })
  useKey(run, "mod+l", { kind: "message" })
  useKey(run, "mod+shift+n", { kind: "split", id: here })
  useKey(run, "mod+/", { kind: "shortcuts" })
  useShortcut(
    "mod+.",
    () => {
      run({ kind: "stop" })
    },
    BROWSER_ONLY,
  )
  useShortcut(
    "escape",
    () => {
      if (isDictating()) {
        cancelDictation()
      } else {
        run({ kind: "up" })
      }
    },
    { ...ANYWHERE, when: () => !busy },
  )
}
