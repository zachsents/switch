// Where the window is: a space's page or a thread's, with back and forward. A move
// renders at once, in the same frame as the click (no transition, no animation); every space's page
// stays mounted (<Activity>, app.tsx).
import type { SpaceId, ThreadId } from "@switch/brain"
import { useEffect, useEffectEvent, useState } from "react"

import { HOME } from "@switch/brain/commands"

import { openSettings } from "./use-menu.ts"

export type Page =
  /** `at`: a line of its chat to bring into view and ring, by seq. */
  | { readonly kind: "space"; readonly id: SpaceId; readonly at?: number }
  | { readonly kind: "thread"; readonly id: ThreadId }

interface Where {
  readonly page: Page
}

let where: Where = { page: { kind: "space", id: HOME } }
const back: Page[] = []
const forward: Page[] = []
const listeners = new Set<() => void>()

const set = (page: Page) => {
  where = { page }
  for (const l of listeners) {
    l()
  }
}

const same = (a: Page, b: Page) => a.kind === b.kind && a.id === b.id

const atOf = (p: Page) => (p.kind === "space" ? p.at : undefined)

export const go = (next: Page) => {
  if (same(next, where.page)) {
    // The same space, at another line: no step in history.
    if (atOf(next) !== atOf(where.page)) {
      set(next)
    }
    return
  }
  back.push(where.page)
  forward.length = 0
  set(next)
}

export const openSpace = (id: SpaceId, at?: number) => {
  go(at === undefined ? { kind: "space", id } : { kind: "space", id, at })
}

export const openThread = (id: ThreadId) => {
  go({ kind: "thread", id })
}

/** Settings' sections, in its window (ui/settings/settings-window.tsx). */
export const openConnections = () => {
  openSettings("connections")
}

export const openExtensions = () => {
  openSettings("extensions")
}

export const openMemory = () => {
  openSettings("memory")
}

export const openSystem = () => {
  openSettings("system")
}

export const goBack = () => {
  const prev = back.pop()
  if (prev) {
    forward.push(where.page)
    set(prev)
  }
}

export const goForward = () => {
  const next = forward.pop()
  if (next) {
    back.push(where.page)
    set(next)
  }
}

/** Where the window is. */
export const useWhere = () => {
  const [now, setNow] = useState(where)
  const moved = useEffectEvent(() => {
    setNow(where)
  })
  useEffect(() => {
    const l = () => {
      moved()
    }
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  return now
}

/** Whether there's a page to go back or forward to. */
export const useHistory = () => {
  const now = useWhere()
  return { back: back.length > 0, forward: forward.length > 0, page: now.page }
}
