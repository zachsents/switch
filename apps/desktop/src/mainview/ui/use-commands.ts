// What each command does to the window, however it was asked: a shortcut, the palette, the menu.
import type { Dispatch, SetStateAction } from "react"

import { HOME, SpaceId } from "@switch/brain/commands"

import type { Command } from "../../shared/commands.ts"
import * as derive from "../brain/derive.ts"
import { brainQuery } from "../brain/client.ts"
import type { State } from "../brain/store.ts"
import { toggleDictation } from "../dictation/dictation.ts"
import { queryClient } from "../query.ts"
import { focusBox } from "./box.tsx"
import { focusFind } from "./find-bar.tsx"
import { openLink } from "./links.ts"
import { goBack, goForward, openConnections, openMemory, openSpace, openSystem } from "./nav.ts"
import { openSettings } from "./use-menu.ts"
import type { Page } from "./nav.ts"
import { copyLink, startRename, useSpaceActs } from "./spaces.ts"

/** Every live space as the boards nest them: Home, then each space and the spaces in it. */
const inOrder = (s: State) => {
  const out: SpaceId[] = []
  const walk = (id: SpaceId) => {
    if (out.includes(id)) {
      return
    }
    out.push(id)
    for (const c of derive.children(s, id)) {
      walk(c.id)
    }
  }
  walk(HOME)
  return out
}

const state = () => queryClient.getQueryData(brainQuery.queryKey)

/** Runs once the first snapshot is in: a link the app was opened with names what it holds. */
const whenReady = (f: (s: State) => void) => {
  const now = state()
  if (now?.ready === true) {
    f(now)
    return
  }
  const unsubscribe = queryClient.getQueryCache().subscribe(() => {
    const s = state()
    if (s?.ready === true) {
      unsubscribe()
      f(s)
    }
  })
}

const WINDOW = [
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
] as const

/** What the window does by itself, not to a space. */
type Window = (typeof WINDOW)[number]

const windowKinds = new Set<string>(WINDOW)

const isWindow = (c: Command): c is Extract<Command, { readonly kind: Window }> =>
  windowKinds.has(c.kind)

type SpaceCommand = Exclude<Command, { readonly kind: Window }>

export const useCommands = ({
  page,
  space,
  parent,
  setFinding,
  setShortcuts,
  searching,
  setSearchingIn,
  stop,
}: {
  page: Page
  space: SpaceId
  /** The space above the one open. */
  parent: SpaceId
  setFinding: Dispatch<SetStateAction<boolean>>
  setShortcuts: Dispatch<SetStateAction<boolean>>
  /** ⌘F's bar is open on the space's chat. */
  searching: boolean
  setSearchingIn: Dispatch<SetStateAction<SpaceId | null>>
  /** Stops the running turn: the thread open's, else the space's own. */
  stop: () => void
}) => {
  const onSpace = useSpaceCommand(space)
  /** The space `by` places from the one open, in the boards' order, wrapping round. */
  const step = (by: number) => {
    const s = state()
    if (!s) {
      return
    }
    const order = inOrder(s)
    const at = order.indexOf(space)
    const to = order[(at + by + order.length) % order.length]
    if (to) {
      openSpace(to)
    }
  }
  const window: Record<Window, () => void> = {
    find: () => {
      setFinding((f) => !f)
    },
    findIn: () => {
      if (page.kind !== "space") {
        openSpace(space)
      }
      if (searching) {
        focusFind()
      } else {
        setSearchingIn(space)
      }
    },
    message: () => {
      if (page.kind !== "space") {
        openSpace(space)
      }
      requestAnimationFrame(() => {
        focusBox()
      })
    },
    home: () => {
      openSpace(HOME)
    },
    up: () => {
      if (page.kind !== "space") {
        goBack()
      } else if (space !== HOME) {
        openSpace(parent)
      }
    },
    next: () => {
      step(1)
    },
    previous: () => {
      step(-1)
    },
    back: goBack,
    forward: goForward,
    connections: openConnections,
    shortcuts: () => {
      setShortcuts((o) => !o)
    },
    memory: openMemory,
    system: openSystem,
    dictate: toggleDictation,
    stop,
  }
  return (c: Command) => {
    if (isWindow(c)) {
      window[c.kind]()
    } else {
      onSpace(c)
    }
  }
}

/** The commands done to a space, or that open one. */
const useSpaceCommand = (open: SpaceId) => {
  const acts = useSpaceActs()
  return (c: SpaceCommand) => {
    switch (c.kind) {
      case "space": {
        openSpace(SpaceId.make(c.id))
        break
      }
      case "rename": {
        openSpace(SpaceId.make(c.id))
        startRename(SpaceId.make(c.id))
        break
      }
      case "split": {
        acts.split(SpaceId.make(c.id))
        break
      }
      case "archive": {
        const id = SpaceId.make(c.id)
        acts.archive(id)
        if (id === open) {
          openSpace(state()?.spaces.get(id)?.parent ?? HOME)
        }
        break
      }
      case "unarchive": {
        acts.unarchive(SpaceId.make(c.id))
        break
      }
      case "move": {
        acts.move(SpaceId.make(c.id), c.to === null ? null : SpaceId.make(c.to))
        break
      }
      case "copyLink": {
        copyLink(SpaceId.make(c.id))
        break
      }
      case "settings": {
        openSettings(c.section)
        break
      }
      case "link": {
        whenReady((s) => {
          openLink(s, c.url)
        })
        break
      }
      default: {
        c satisfies never
      }
    }
  }
}
