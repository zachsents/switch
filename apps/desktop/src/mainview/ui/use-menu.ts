// The menu bar, which the bun process draws: it's told the spaces to list, and tells the window
// what was chosen. Right-click menus and the clipboard go through it too. Outside Electrobun (a
// browser), there's no menu bar, and a right-click gets the browser's menu.
import { Electroview } from "electrobun/view"
import { queryOptions } from "@tanstack/react-query"
import { useEffect, useEffectEvent, useSyncExternalStore } from "react"

import type {
  Command,
  Local,
  FileAsk,
  PicturesAsk,
  MenuModel,
  MenuRPC,
  Shows,
  SpaceMenu,
  Update,
  WidgetWindow,
} from "../../shared/commands.ts"
import type { Heard } from "../../shared/dictation.ts"
import { setAuth } from "../brain/auth.ts"
import { queryClient } from "../query.ts"
import { heldOf } from "./item-held.ts"
import { report, tellBun } from "./reports.ts"

const listeners = new Set<(c: Command) => void>()
/** Told of what the dictation under way hears (dictation/dictation.ts). */
export const heardListeners = new Set<(h: Heard) => void>()

/** The bun process, in the app; undefined in a browser. */
export const rpc =
  "__electrobun" in window
    ? Electroview.defineRPC<MenuRPC>({
        handlers: {
          messages: {
            command: (c) => {
              for (const l of listeners) {
                l(c)
              }
            },
            update: (u) => {
              queryClient.setQueryData(["update"], u)
            },
            local: (l) => {
              queryClient.setQueryData(["local"], l)
            },
            heard: (h) => {
              for (const l of heardListeners) {
                l(h)
              }
            },
            auth: setAuth,
            show: (s) => {
              shows = s
              for (const l of showListeners) {
                l()
              }
            },
            report: (r) => {
              void (async () => {
                await report(r)
                rpc?.send.reported({ id: r.id })
              })()
            },
          },
        },
      })
    : undefined

/** How often typing is told, ms: the hold lasts a minute from the last. */
const TYPED_EVERY_MS = 5000

if (rpc) {
  void new Electroview({ rpc })
  rpc.send.hello()
  // What's running and what waits, held from the start: System shows it on its first frame.
  rpc.send.update({ apply: false })
  // ⌘↑ and ⌘↓ are the menu's (Previous and Next Space), but in a field the web view takes them as
  // caret moves before the menu sees them: there they're the menu's command, run here.
  window.addEventListener(
    "keydown",
    (e) => {
      const t = e.target
      const field =
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      if (
        field &&
        e.metaKey &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === "ArrowUp" || e.key === "ArrowDown")
      ) {
        e.preventDefault()
        const c: Command = { kind: e.key === "ArrowUp" ? "previous" : "next" }
        for (const l of listeners) {
          l(c)
        }
      }
    },
    { capture: true },
  )
  // Typing in a field holds a waiting update off (old Switchboard's hold.rs).
  let told = 0
  window.addEventListener(
    "keydown",
    (e) => {
      const t = e.target
      const field =
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      if (field && Date.now() - told > TYPED_EVERY_MS) {
        told = Date.now()
        rpc.send.typed()
      }
    },
    { capture: true },
  )
  tellBun({
    shown: (s) => {
      void rpc.send.shown(s)
    },
    error: (e) => {
      void rpc.send.error(e)
    },
  })
}

/** Shows a space's menu at the pointer: false where there's no app to draw it. */
export const showSpaceMenu = (m: SpaceMenu) => {
  rpc?.send.spaceMenu(m)
  return rpc !== undefined
}

export const copyText = (text: string) => {
  if (rpc) {
    rpc.send.copy(text)
  } else {
    void navigator.clipboard.writeText(text)
  }
}

const NONE: Update = { current: "", waiting: "" }

/** The version running and the one waiting, as the bun process last said; asking tells it to say. */
export const updateQuery = queryOptions({
  queryKey: ["update"],
  queryFn: () => {
    rpc?.send.update({ apply: false })
    return queryClient.getQueryData<Update>(["update"]) ?? NONE
  },
  staleTime: Infinity,
})

/** Opens Settings at a section: its window (in a browser, a tab). */
export const openSettings = (section: string) => {
  if (rpc) {
    rpc.send.settings({ section })
  } else {
    window.open(`${location.pathname}${location.search}#settings=${section}`, "_blank")
  }
}

export const openWidgetWindow = (view: WidgetWindow) => {
  if (rpc) {
    rpc.send.widget(view)
  } else {
    window.open(
      `${location.pathname}${location.search}#widget=${encodeURIComponent(JSON.stringify(view))}`,
      "_blank",
    )
  }
}

/** Runs what the bun process says, until the cleanup it answers: for a window without useMenu. */
export const onCommand = (l: (c: Command) => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

const OFF: Local = { login: false, autoUpdate: true }

/** What's this Mac's own (launching at login, updating by itself); asking tells the bun process to say. */
export const localQuery = queryOptions({
  queryKey: ["local"],
  queryFn: () => {
    rpc?.send.local({})
    return queryClient.getQueryData<Local>(["local"]) ?? OFF
  },
  staleTime: Infinity,
})

/** Sets what's this Mac's own; the bun process says what it now is. */
export const setLocal = (ask: { readonly login?: boolean; readonly autoUpdate?: boolean }) => {
  rpc?.send.local(ask)
}

/** Opens an action item in a window of its own (in a browser, nothing), handed what this window
 * holds of it. */
export const openItemWindow = (id: string) => {
  const held = heldOf(id)
  rpc?.send.item(held ? { id, held } : { id })
}

let shows: Shows | null = null
const showListeners = new Set<() => void>()

/** What a window of one thing shows, as the bun process told it; null until it has. Read straight
 * from the store: the query cache tells its readers on a timer, which a hidden window holds back. */
export const useShows = () =>
  useSyncExternalStore(
    (l) => {
      showListeners.add(l)
      return () => {
        showListeners.delete(l)
      }
    },
    () => shows,
  )

/** Closes this window (an item's, once its item closes). */
export const closeWindow = () => {
  rpc?.send.close()
}

/** Applies the waiting update: the app relaunches. */
export const updateNow = () => {
  rpc?.send.update({ apply: true })
}

/**
 * A chat's file, opened by the app: Quick Look, Finder, Downloads, or its menu. In a browser, a tab.
 * True once it's done; false when it couldn't be. A fetch may take minutes for a big file.
 */
export const fileAction = async (ask: FileAsk) => {
  if (rpc) {
    return await rpc.request.file(ask, { maxRequestTime: 60 * 60_000 }).catch(() => false)
  }
  window.open(ask.url, "_blank", "noreferrer")
  return true
}

/** A gallery's pictures in Quick Look, at the one clicked; in a browser, that one in a tab. */
export const picturesAction = (ask: PicturesAsk) => {
  const one = ask.pictures[ask.at]
  if (rpc) {
    rpc.send.pictures(ask)
  } else if (one) {
    window.open(one.url, "_blank", "noreferrer")
  }
}

/** Keeps the menu bar's lists up to date, and runs what's chosen from it. */
export const useMenu = (model: MenuModel, run: (c: Command) => void) => {
  const chosen = useEffectEvent(run)
  useEffect(() => {
    const l = (c: Command) => {
      chosen(c)
    }
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  // The model keeps its identity until what it lists changes (the selector's structural sharing).
  useEffect(() => {
    rpc?.send.menu(model)
  }, [model])
}
