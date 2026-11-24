import { existsSync } from "node:fs"
import path from "node:path"
import Electrobun, { Updater, Utils } from "electrobun/main"

import type { Auth } from "../shared/commands.ts"
import { keepPaired, machineName } from "./auth.ts"
import { menuRPC } from "./menu.ts"
import { dialCore } from "./extension.ts"
import { makeWatch } from "./watch.ts"
import { openFramed } from "./frame.ts"
import { authChanged, BUTTONS, openSettings, readFrom, warm, zoomed } from "./reading.ts"
import { still } from "./still.ts"
import { startUpdates, typed } from "./update.ts"

// $SWITCH_VIEW points a dev build at another view server, such as a second worktree's.
const devServer = process.env.SWITCH_VIEW ?? "http://localhost:5173"

/** Where the built view sits in the app bundle: Resources/app/views/mainview. */
const VIEWS = [
  path.resolve(import.meta.dir, "..", "views", "mainview"),
  path.resolve(process.cwd(), "..", "Resources", "app", "views", "mainview"),
].find((dir) => existsSync(path.join(dir, "index.html")))

/** Where notifications go, as the user set it (the brain's pref, told by the view). */
let notifying = { here: true, quietOpen: false }

// A test copy run beside the live app ($SWITCH_QUIET) neither reports nor dials in as the desktop,
// and its view (told with `?quiet=1`) keeps what it reads, sees and sets to itself.
const quiet = process.env.SWITCH_QUIET === "1"
const QUERY = quiet ? "?quiet=1" : ""

/** One port, so the view's origin (and what it keeps there) stays the same between launches; a test
 * copy beside the live app names its own ($SWITCH_VIEW_PORT). */
const PORT = Number(process.env.SWITCH_VIEW_PORT ?? 4879)

/**
 * The built view, over http on this machine only. Under `views://` the page's origin is opaque
 * ("null"), and A2UI's MCP App sandbox, which checks origins both ways, refuses every frame.
 */
const serveViews = (dir: string) => {
  const fetch = (request: Request) => {
    const { pathname } = new URL(request.url)
    const file = path.resolve(
      dir,
      `.${decodeURIComponent(pathname === "/" ? "/index.html" : pathname)}`,
    )
    if (!file.startsWith(dir + path.sep) || !existsSync(file)) {
      return new Response("Not found", { status: 404 })
    }
    return new Response(Bun.file(file))
  }
  try {
    return Bun.serve({ hostname: "127.0.0.1", port: PORT, fetch })
  } catch {
    // Taken (a second copy running): any free port.
    return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })
  }
}

const viewUrl = async () => {
  if ((await Updater.localInfo.channel()) === "dev") {
    const up = await fetch(devServer, { method: "HEAD" })
      .then(() => true)
      .catch(() => false)
    if (up) {
      return `${devServer}/${QUERY}`
    }
  }
  if (VIEWS === undefined) {
    return "views://mainview/index.html"
  }
  const server = serveViews(VIEWS)
  return `http://127.0.0.1:${server.port}/index.html${QUERY}`
}

const machine = machineName()
let auth: Auth | null = null

// `switchboard://` links: each goes to the view once it has said it's up, then as they come.
const links: string[] = []
let viewUp = false
const sendLinks = () => {
  for (const url of links.splice(0)) {
    rpc.send.command({ kind: "link", url })
  }
}

const rpc = menuRPC({
  typed,
  settings: (section) => {
    openSettings(section, mainWindow)
  },
  notify: (n) => {
    notifying = n
  },
  hello: () => {
    if (auth !== null) {
      rpc.send.auth(auth)
    }
  },
  ready: () => {
    viewUp = true
    sendLinks()
    // The main window is up: a window of one thing is made ready behind it.
    warm()
  },
  shown: (s) => {
    watch.shown(s)
    // Again on every word from the view, which may have loaded since; it keeps only a change.
    if (auth !== null) {
      rpc.send.auth(auth)
    }
  },
  reported: (id) => {
    watch.reported(id)
  },
  error: (e) => {
    watch.error(e)
  },
})
const watch = makeWatch(machine, (r) => {
  if (!quiet) {
    rpc.send.report(r)
  }
})

/** The window's first frame: `WxH+X+Y` from $SWITCH_FRAME (a test run's size), else the usual. */
const frameOf = (given: string | undefined) => {
  const m = /^(?<w>\d+)x(?<h>\d+)(?:\+(?<x>\d+)\+(?<y>\d+))?$/u.exec(given ?? "")?.groups
  if (!m) {
    return { width: 1240, height: 800, x: 160, y: 120 }
  }
  return { width: Number(m.w), height: Number(m.h), x: Number(m.x ?? 160), y: Number(m.y ?? 120) }
}

export const mainWindow = openFramed({
  title: "Switchboard",
  url: await viewUrl(),
  frame: frameOf(process.env.SWITCH_FRAME),
  // The band is the titlebar: the window's buttons sit in it.
  titleBarStyle: "hiddenInset",
  transparent: false,
  rpc,
})
// The window's buttons centre on the band; it shows and hides with no animation.
mainWindow.setWindowButtonPosition(BUTTONS.x, BUTTONS.y)
still(mainWindow.ptr)
zoomed(mainWindow)

// Closing the window (⌘W, its red button) hides it: the app keeps running, and the Dock or a
// link brings it back as it was. A reading window still closes. Quitting (⌘Q, the Dock, a script,
// logging out) closes it for real.
let quitting = false
Electrobun.events.on("before-quit", () => {
  quitting = true
})
mainWindow.on("will-close", (e) => {
  if (!quitting && typeof e === "object" && e !== null) {
    // Its `response` is a setter: what it's set to says whether the window closes.
    Object.assign(e, { response: { allow: false } })
    mainWindow.hide()
  }
})
Electrobun.events.on("reopen", () => {
  mainWindow.show()
})
Electrobun.events.on("open-url", (e: { readonly data: { readonly url: string } }) => {
  if (!e.data.url.startsWith("switchboard:")) {
    return
  }
  links.push(e.data.url)
  mainWindow.show()
  if (viewUp) {
    sendLinks()
  }
})

keepPaired("http://127.0.0.1:4871", (a) => {
  auth = a
  rpc.send.auth(a)
  authChanged(a)
})
readFrom(mainWindow.url, () => auth)

const urlOf = (detail: unknown): string => {
  if (typeof detail === "string") {
    return detail
  }
  if (typeof detail === "object" && detail !== null && "url" in detail) {
    return String(detail.url)
  }
  return ""
}

// A link in a message opens in the browser, not in the window.
Electrobun.events.on("new-window-open", (e: { readonly data: { readonly detail: unknown } }) => {
  const url = urlOf(e.data.detail)
  if (/^(?:https?|mailto):/u.test(url)) {
    Utils.openExternal(url)
  }
})
// A notification clicked brings the app forward: soon after one, coming forward opens its space.
const CLICK_MS = 2 * 60_000
let notified: { readonly space: string; readonly at: number } | null = null

// The window as a extension, on the core the view's brain is on.
if (!quiet) {
  dialCore(
    {
      native: () => mainWindow.ptr,
      inFront: () => watch.inFront(),
      // Shown here only if they go to this Mac, and not while the app's in front if they're quiet then.
      wanted: () => notifying.here && !(notifying.quietOpen && watch.focused()),
      notified: (space) => {
        if (!watch.focused()) {
          notified = { space, at: Date.now() }
        }
      },
    },
    machine,
    () => (auth !== null && "token" in auth ? auth : null),
  )
}

// Updates: checked, downloaded, applied while the window is away or when asked; the view is told.
await startUpdates(mainWindow, (u) => {
  rpc.send.update(u)
})

mainWindow.on("focus", () => {
  watch.focus(true)
  if (notified !== null && Date.now() - notified.at < CLICK_MS) {
    rpc.send.command({ kind: "space", id: notified.space })
  }
  notified = null
})
mainWindow.on("blur", () => {
  watch.focus(false)
})
