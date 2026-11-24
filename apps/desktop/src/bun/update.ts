// Updates from the deploy's feed, as T3 Code's: checked at launch, whenever the window comes
// forward, and every ten minutes, downloaded in the background. One is applied (a relaunch) when
// it won't interrupt: the window out of focus or hidden, no input for two minutes, or just after
// launch; and never while the user is typing (a key in a field in the last minute) or dictating, as
// old Switchboard's hold.rs held it. Or at once when the user asks from the system page. The view
// is told what's running and what waits.
// It can't loop: each version is put in by itself once (an apply that fails relaunches the old app,
// which mustn't try it again), never one that's already running, and after one that didn't take it
// waits, longer each time, before trying any.
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { writeFileAtomic } from "@switch/brain/files"
import { Updater } from "electrobun/main"
import type { BrowserWindow } from "electrobun/main"
import { Option, Schema } from "effect"

import type { Update } from "../shared/commands.ts"
import { dictating } from "./dictation.ts"
import { ID, local } from "./local.ts"

const CHECK_EVERY_MS = 10 * 60_000
/** No input for this long is away. */
const IDLE_MS = 2 * 60_000
/** An update that lands this soon after launch is applied then: the user has only just opened it. */
const LAUNCH_MS = 30_000
const IDLE_EVERY_MS = 30_000

/** How long after their last keystroke they still count as typing (old hold.rs). */
const TYPING_MS = 60_000

const launched = Date.now()
let typedAt = 0

/** They typed into a field. */
export const typed = () => {
  typedAt = Date.now()
}

/** In the middle of something an update would cut off. */
const held = () => dictating() || Date.now() - typedAt < TYPING_MS
let focused = true
let ready = false
let checking = false
let tell: ((u: Update) => void) | null = null

const label = (info: { readonly version: string; readonly hash: string }) =>
  info.version || info.hash.slice(0, 7)

const state = async (): Promise<Update> => ({
  current: label({
    version: await Updater.localInfo.version(),
    hash: await Updater.localInfo.hash(),
  }),
  waiting: ready ? label(Updater.updateInfo()) : "",
})

const told = async () => {
  tell?.(await state())
}

/** How long since the last keyboard or pointer input on this Mac, ms. */
const idleMs = async () => {
  const proc = Bun.spawn(["ioreg", "-c", "IOHIDSystem", "-d", "4", "-k", "HIDIdleTime"], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const out = await new Response(proc.stdout).text()
  const ns = /"HIDIdleTime" = (?<ns>\d+)/u.exec(out)?.groups?.ns
  return ns === undefined ? 0 : Number(ns) / 1e6
}

/** The last version put in, when, how many in a row haven't taken, and whether this one's outcome
 * is still to be seen (`open`, until the next launch). */
const Tried = Schema.Struct({
  hash: Schema.String,
  at: Schema.Number,
  failed: Schema.Number,
  open: Schema.Boolean,
})
type Tried = typeof Tried.Type
const TRIED = path.join(homedir(), "Library", "Application Support", ID, "update-tried.json")
const decodeTried = Schema.decodeUnknownOption(Schema.fromJsonString(Tried))
const BACKOFF_MS = 10 * 60_000
const BACKOFF_MAX_MS = 6 * 60 * 60_000

const tried = () =>
  existsSync(TRIED) ? Option.getOrNull(decodeTried(readFileSync(TRIED, "utf-8"))) : null

const keepTried = (t: Tried) => {
  writeFileAtomic(TRIED, JSON.stringify(t))
}

/** At launch: the last one tried is running now, or it didn't take. */
const settle = async () => {
  const t = tried()
  if (t === null || !t.open) {
    return
  }
  const have = await Updater.localInfo.hash()
  keepTried({ ...t, open: false, failed: t.hash === have ? 0 : t.failed + 1 })
}
const settled = settle().catch(() => null)

/** Puts the waiting version in (a relaunch), unless it's running already, was tried already, or
 * the last one didn't take and the wait after it isn't over. `asked`: from the system page. */
const putIn = async (asked: boolean) => {
  await settled
  const want = Updater.updateInfo()
  const have = await Updater.localInfo.hash()
  if (
    want.hash === "" ||
    want.hash === have ||
    want.version === (await Updater.localInfo.version())
  ) {
    ready = false
    return
  }
  const t = tried()
  const wait =
    t === null || t.failed === 0 ? 0 : Math.min(BACKOFF_MS * 2 ** (t.failed - 1), BACKOFF_MAX_MS)
  if (!asked && t?.hash === want.hash) {
    // Tried and it didn't take: what's checked next may be newer.
    ready = false
    return
  }
  if (!asked && t !== null && Date.now() < t.at + wait) {
    return
  }
  keepTried({ hash: want.hash, at: Date.now(), failed: t?.failed ?? 0, open: true })
  await Updater.applyUpdate()
}

const apply = async () => {
  if (!ready || held() || !local().autoUpdate) {
    return
  }
  if (!focused || Date.now() - launched < LAUNCH_MS || (await idleMs()) > IDLE_MS) {
    await putIn(false)
  }
}

const check = async () => {
  if (ready) {
    await apply()
    return
  }
  if (checking) {
    return
  }
  checking = true
  try {
    const info = await Updater.checkForUpdate()
    // One tried already isn't fetched again.
    if (!info.updateAvailable || tried()?.hash === info.hash) {
      return
    }
    await Updater.downloadUpdate()
    ready = Updater.updateInfo().updateReady
    await told()
    await apply()
  } finally {
    checking = false
  }
}

const report = (error: unknown) => {
  console.warn("Update check failed", error)
}

const checkQuietly = () => {
  check().catch(report)
}

/** What the view asks: the state, or the waiting update applied now. */
export const answer = (ask: { readonly apply: boolean }, send?: (value: Update) => void) => {
  if (ask.apply && ready) {
    putIn(true).catch(report)
    return
  }
  if (send) {
    state().then(send).catch(report)
  } else {
    told().catch(report)
  }
}

export const startUpdates = async (
  window: BrowserWindow,
  send: (u: Update) => void,
): Promise<void> => {
  tell = send
  if ((await Updater.localInfo.channel()) === "dev") {
    return
  }
  window.on("focus", () => {
    focused = true
    checkQuietly()
  })
  window.on("blur", () => {
    focused = false
    checkQuietly()
  })
  checkQuietly()
  setInterval(checkQuietly, CHECK_EVERY_MS)
  // A waiting update goes in once the Mac has been left alone.
  setInterval(() => {
    if (ready) {
      apply().catch(report)
    }
  }, IDLE_EVERY_MS)
}
