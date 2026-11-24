// What the window shows, and when it stops answering. The view says what's on screen on every change
// and every couple of seconds; a focused window that goes quiet past HANG_MS has hung. Hangs, the
// view's errors and this process's own crash become reports, kept on disk until the view has put
// them in the brain (`client.crashed`), so one survives a crash or a quit.
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { writeFileAtomic } from "@switch/brain/files"
import { Updater } from "electrobun/main"

import type { Report, Shown } from "../shared/commands.ts"

const HANG_MS = 10_000
const FILE = path.join(homedir(), ".switch", "desktop-reports.json")
const CLIP = 20_000

const parse: (json: string) => Report[] = JSON.parse

const load = (): Report[] => {
  try {
    return existsSync(FILE) ? parse(readFileSync(FILE, "utf-8")) : []
  } catch {
    return []
  }
}

export const makeWatch = (device: string, send: (r: Report) => void) => {
  let shown: Shown = { space: null, screen: "", trail: [], visible: true }
  let beat = Date.now()
  let focused = true
  let hungSince: number | null = null
  let build = ""
  const pending = load()

  const keep = () => {
    writeFileAtomic(FILE, JSON.stringify(pending))
  }

  const add = (r: Omit<Report, "id" | "device" | "build">) => {
    pending.push({ ...r, id: crypto.randomUUID(), device, build })
    keep()
  }

  // Again until the view says it's in, but not on every beat.
  const sentAt = new Map<string, number>()
  const flush = () => {
    const now = Date.now()
    for (const r of pending) {
      if (now - (sentAt.get(r.id) ?? 0) > 30_000) {
        sentAt.set(r.id, now)
        send(r)
      }
    }
  }

  void (async () => {
    build = await Updater.localInfo.version()
  })()

  // Only a view on screen can hang: a hidden or occluded one (the screen locked, the window hidden)
  // has its timers held back. And when this check itself runs late, this process or the whole Mac
  // stalled (asleep, busy applying an update), so the view's silence says nothing.
  let ticked = Date.now()
  setInterval(() => {
    const now = Date.now()
    const late = now - ticked > HANG_MS
    ticked = now
    if (late || shown.visible === false) {
      beat = now
      return
    }
    if (focused && hungSince === null && now - beat > HANG_MS) {
      hungSince = beat
    }
  }, 2000)

  // This process's own crash: kept now, sent on the next launch.
  process.on("uncaughtException", (error) => {
    add({
      kind: "crash",
      at: Date.now(),
      summary: error.message.slice(0, 200),
      screen: shown.screen,
      trail: shown.trail,
      report: (error.stack ?? String(error)).slice(0, CLIP),
    })
    process.exit(1)
  })

  return {
    /** The view's word: what's on screen, and that it's answering. */
    shown: (s: Shown) => {
      const was = shown
      shown = s
      beat = Date.now()
      if (hungSince !== null) {
        add({
          kind: "hang",
          at: hungSince,
          summary: `Unresponsive for ${Math.round((beat - hungSince) / 1000)} s`,
          screen: was.screen,
          trail: was.trail,
        })
        hungSince = null
      }
      flush()
    },
    error: (e: { readonly summary: string; readonly report: string }) => {
      add({
        kind: "error",
        at: Date.now(),
        summary: e.summary.slice(0, 200),
        screen: shown.screen,
        trail: shown.trail,
        report: e.report.slice(0, CLIP),
      })
      flush()
    },
    reported: (id: string) => {
      const at = pending.findIndex((r) => r.id === id)
      if (at !== -1) {
        pending.splice(at, 1)
        keep()
      }
    },
    focus: (on: boolean) => {
      focused = on
      beat = Date.now()
    },
    /** The space on screen in a focused window, else null. */
    inFront: () => (focused ? shown.space : null),
    focused: () => focused,
  }
}

export type Watch = ReturnType<typeof makeWatch>
