// Windows of one thing: an ask, a long reply's words, a widget, Settings. Each is the same view,
// told what to show. One is kept ready ahead of time, hidden, loaded and on the brain; an open takes
// it, tells it what to show (with what the main window holds of it), and it comes on screen once
// drawn, never blank. WebKit holds a hidden page back, so what it's told waits until it's on screen:
// it goes on screen see-through, draws there, and is seen once drawn. Another is made ready for the
// next. Esc (sent from the view) and ⌘W close one.
import type { BrowserWindow } from "electrobun/main"
import Electrobun, { BrowserView, Utils } from "electrobun/main"

import type {
  Auth,
  Command,
  ItemWindow,
  MenuRPC,
  Reading,
  Shows,
  WidgetWindow,
} from "../shared/commands.ts"
import { currentFrame, openFramed, setFrame } from "./frame.ts"
import { seen, still } from "./still.ts"
import { connectionRelay } from "./oauth-relay.ts"
import { timeOpen } from "./timing.ts"
import { registerWindowState, windowMessages } from "./window-state.ts"
import type { WindowSender } from "./window-state.ts"
import { onFile } from "./files.ts"

let base = ""
let authNow: () => Auth | null = () => null
export const windowAuth = () => authNow()

/** Where the view is served, as the main window loaded it, and the credential each window gets. */
export const readFrom = (url: string | null, auth: () => Auth | null) => {
  base = (url ?? "").split("#")[0] ?? ""
  authNow = auth
}

/** How far each new window sits from the last, so they don't stack exactly. */
const STEP = 24
let opened = 0

/** The window's buttons, centred on the band (the view's 30 px strip). */
export const BUTTONS = { x: 10, y: 8 } as const
const FIT_MOST = 720

/** Every window of one thing's view, for a new credential. */
const views = new Set<{ readonly auth: (a: Auth) => void }>()

/** The bun process paired again: every window reaches the brain with the new credential. */
export const authChanged = (a: Auth) => {
  for (const v of views) {
    v.auth(a)
  }
}

interface Open {
  readonly shows: Shows
  readonly timing: ReturnType<typeof timeOpen>
}

/** A window of the view, hidden until it's told what to show and has drawn it. */
const make = () => {
  const held: {
    window?: BrowserWindow
    loaded: boolean
    open: Open | null
    onScreen: boolean
    seen: boolean
  } = { loaded: false, open: null, onScreen: false, seen: false }
  /** On screen see-through, where its page runs: it's made seen once it has drawn. */
  const wake = () => {
    if (!held.onScreen && held.window) {
      held.onScreen = true
      seen(held.window.ptr, false)
      held.window.show()
    }
  }
  const connection = connectionRelay(windowAuth, (url) => {
    Utils.openExternal(url)
  })
  const rpc = BrowserView.defineRPC<MenuRPC>({
    handlers: {
      requests: { connection: connection.connect, file: onFile },
      messages: {
        connectionCancel: connection.cancel,
        ...windowMessages((): WindowSender => rpc.send, setZoom),
        widget: (view) => {
          openWidget(view)
        },
        close: () => {
          held.window?.close()
        },
        // The view's height once laid out: the window fits it, up to most of the screen.
        fit: ({ height }) => {
          const w = held.window
          const f = w && currentFrame(w)
          if (w && f) {
            const h = Math.min(height, FIT_MOST)
            setFrame(w, { x: f.x, y: f.y + f.height - h, width: f.width, height: h })
          }
        },
        // Once loaded, the window reaches the brain as the main one does, and is told what to show
        // if it's been opened already.
        hello: () => {
          held.loaded = true
          const a = authNow()
          if (a !== null) {
            rpc.send.auth(a)
          }
          if (held.open) {
            rpc.send.show(held.open.shows)
          }
        },
        // It has drawn what it was told: on screen now.
        ready: () => {
          if (held.open) {
            wake()
          }
        },
        // Its first frames are drawn on screen: seen now.
        seen: () => {
          if (held.open && !held.seen && held.window) {
            held.seen = true
            seen(held.window.ptr, true)
            held.open.timing.shown()
          }
        },
        painted: () => {
          held.open?.timing.painted()
          warm()
        },
      },
    },
  })
  const view = { auth: (a: Auth) => rpc.send.auth(a) }
  views.add(view)
  const w = openFramed({
    title: "",
    url: `${base}#window`,
    frame: { width: 640, height: 480, x: 240, y: 140 },
    titleBarStyle: "hiddenInset",
    hidden: true,
    rpc,
  })
  held.window = w
  w.setWindowButtonPosition(BUTTONS.x, BUTTONS.y)
  w.on("close", registerWindowState(rpc.send))
  w.on("close", connection.close)
  w.on("close", () => {
    views.delete(view)
    // Closed before it drew (Esc while it opened): the next one is made ready all the same.
    warm()
  })
  still(w.ptr)
  zoomed(w)
  return {
    window: w,
    send: rpc.send,
    /** Tells it what to show: now if its view has loaded, else once it has. */
    open: (open: Open) => {
      held.open = open
      if (held.loaded) {
        rpc.send.show(open.shows)
        wake()
      }
    },
  }
}

/** The window kept ready for the next open. */
let spare: ReturnType<typeof make> | null = null

/** Once the app is quitting, none is made ready. */
let quitting = false
Electrobun.events.on("before-quit", () => {
  quitting = true
})

/** Makes a window ready for the next open, unless one is. */
export const warm = () => {
  if (spare === null && base !== "" && !quitting) {
    spare = make()
  }
}

/** The ready window (or a new one, if two open at once), placed and told what to show. */
const open = (
  title: string,
  shows: Shows,
  place: (w: BrowserWindow) => void,
  onClose?: () => void,
) => {
  const timing = timeOpen(shows.kind)
  const taken = spare ?? make()
  spare = null
  taken.window.setTitle(title)
  place(taken.window)
  if (onClose) {
    taken.window.on("close", onClose)
  }
  taken.open({ shows, timing })
  return taken
}

/** A window down and right of the last one opened, at this size. */
const staggered = (width: number, height: number) => (w: BrowserWindow) => {
  opened = (opened + 1) % 8
  setFrame(w, { x: 240 + opened * STEP, y: 140 + opened * STEP, width, height })
}

/** A window this size, in the middle of the screen. */
const centred = (width: number, height: number) => (w: BrowserWindow) => {
  opened = (opened + 1) % 8
  setFrame(w, { x: 240, y: 140, width, height })
  w.center()
}

export const openReading = (reading: Reading) => {
  open(reading.title, { kind: "read", reading }, staggered(640, 720))
}

let settings: {
  readonly window: BrowserWindow
  readonly send: { command: (c: Command) => void }
} | null = null

/** Settings: one window, opened at a section; open already, it comes to the front at that section. */
export const openSettings = (section: string, near: BrowserWindow) => {
  if (settings) {
    settings.window.focus()
    settings.send.command({ kind: "settings", section })
    return
  }
  const f = currentFrame(near) ?? { x: 160, y: 120, width: 1240, height: 800 }
  const size = { width: 760, height: 560 }
  opened = (opened + 7) % 8
  const taken = open(
    "Settings",
    { kind: "settings", section },
    (w) => {
      setFrame(w, {
        x: Math.round(f.x + (f.width - size.width) / 2),
        y: f.y + 60,
        width: size.width,
        height: size.height,
      })
    },
    () => {
      settings = null
    },
  )
  settings = { window: taken.window, send: taken.send }
}

/** Every window this opened, for the text size. */
const all = new Set<BrowserWindow>()
let zoom = 1

/** A window takes the text size, now and as it changes. */
export const zoomed = (w: BrowserWindow) => {
  all.add(w)
  w.on("close", () => {
    all.delete(w)
  })
  if (zoom !== 1) {
    w.setPageZoom(zoom)
  }
}

/** The text size, every window. */
export const setZoom = (factor: number) => {
  zoom = factor
  for (const w of all) {
    w.setPageZoom(factor)
  }
}

const items = new Map<string, BrowserWindow>()

/** An action item in a window of its own, one per item: opened again, it comes to the front. It
 * closes itself once the item closes. */
export const openItem = (item: ItemWindow) => {
  const already = items.get(item.id)
  if (already) {
    already.focus()
    return
  }
  const taken = open("Ask", { kind: "item", item }, centred(640, 480), () => {
    items.delete(item.id)
  })
  items.set(item.id, taken.window)
}

export const openWidget = (view: WidgetWindow) => {
  open(view.name, { kind: "widget", view }, centred(1000, 740))
}
