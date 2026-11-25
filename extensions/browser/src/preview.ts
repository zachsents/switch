// A web page's picture, for the preview widget: the address opened in a headless browser of its
// own (the browser installed here, run apart from the user's: a throwaway profile, no window, no
// keychain), driven over DevTools on a pipe (fd 3 in, fd 4 out, JSON messages ending in NUL) as the
// core's preview.ts does, after T3 Code's html_preview (MIT, Copyright (c) 2026 T3 Tools Inc.).
// Signed in (`signedIn`), it's taken in the user's own browser instead, signed in as they are
// there: a background tab of its own, through the extension's debugger, closed once it's taken.
// Nothing of the session (cookies, tokens) is read or kept: the page is only pictured.
// Each picture is kept in the core's blobs. A page has no change event, so each one asked for is
// taken again on its own timer, `every` apart, for as long as someone keeps asking for it; a new
// picture is said (`onShot`), which the widget refreshes on.
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Readable, Writable } from "node:stream"
import { writeFileAtomic } from "switch-ext-kit"

import * as chrome from "./chrome.ts"
import { headlessProgram, isJson } from "./chrome.ts"
import type { Json } from "./chrome.ts"
import { dropSession } from "./session.ts"
import { withTab } from "./tab.ts"

/** How often a page is taken again, by the widget setting's value. */
export const EVERY = { "5m": 5 * 60_000, "30m": 30 * 60_000, "60m": 60 * 60_000 } as const
export type Every = keyof typeof EVERY
export const DEFAULT_EVERY: Every = "30m"
export const DEFAULT_WIDTH = 1280
const MIN_WIDTH = 320
const MAX_WIDTH = 1920
/** The viewport's width over its height, the widget's own. */
export const RATIO = 16 / 10
const LOAD_MS = 20_000
const SETTLE_MS = 3000
const RUN_MS = 45_000
/** A page is kept up while it was asked for within this many of its intervals. */
const KEPT_FOR = 3
/** A picture nobody asked for in a week is forgotten. */
const FORGOTTEN_MS = 7 * 24 * 60 * 60_000
const FILE = "previews.json"
// Fonts, then two frames, so late layout is in.
const SETTLE =
  "document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))))"

const FLAGS = [
  "--headless=new",
  "--remote-debugging-pipe",
  "--use-mock-keychain",
  "--password-store=basic",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--hide-scrollbars",
  "--mute-audio",
  "--block-new-web-contents",
]

/** A page's picture: the blob's link, the page, its title, and when it was taken (ms). */
export interface Shot {
  readonly image: string
  readonly url: string
  readonly title: string
  readonly takenAt: number
}

interface Kept extends Shot {
  readonly width: number
  /** Taken in the user's own browser, signed in as they are there. */
  readonly signedIn: boolean
  /** Ms between pictures. */
  readonly every: number
  /** When it was last asked for. */
  readonly askedAt: number
  /** When it was last tried, taken or not. */
  readonly triedAt: number
}

const isEvery = (v: string | undefined): v is Every => v !== undefined && Object.hasOwn(EVERY, v)
const str = (v: unknown) => (typeof v === "string" ? v : "")
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
const at = (v: unknown, key: string): unknown => (isJson(v) ? v[key] : undefined)

const read = (): Map<string, Kept> => {
  if (!existsSync(FILE)) {
    return new Map()
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(FILE, "utf-8"))
    const list = Array.isArray(raw) ? raw : []
    return new Map(
      list.flatMap((k: unknown) => {
        const kept: Kept = {
          image: str(at(k, "image")),
          url: str(at(k, "url")),
          title: str(at(k, "title")),
          takenAt: num(at(k, "takenAt")),
          width: num(at(k, "width")),
          signedIn: at(k, "signedIn") === true,
          every: num(at(k, "every")),
          askedAt: num(at(k, "askedAt")),
          triedAt: num(at(k, "triedAt")),
        }
        return kept.url && kept.image && kept.width > 0 && kept.every > 0
          ? [[keyOf(kept.url, kept.width, kept.signedIn), kept] as const]
          : []
      }),
    )
  } catch {
    return new Map()
  }
}

const keyOf = (url: string, width: number, signedIn: boolean) =>
  `${width}${signedIn ? " signed-in" : ""} ${url}`

const kept = read()
const taking = new Map<string, Promise<Kept>>()
let line: Promise<unknown> = Promise.resolve()
let timer: ReturnType<typeof setTimeout> | undefined
let said: (shot: Shot) => void = () => {
  // Nobody listens until the extension's loop does.
}

const save = () => {
  const now = Date.now()
  for (const [key, k] of kept) {
    if (now - k.askedAt > FORGOTTEN_MS) {
      kept.delete(key)
    }
  }
  writeFileAtomic(FILE, JSON.stringify([...kept.values()]))
}

const shotOf = (k: Kept): Shot => ({
  image: k.image,
  url: k.url,
  title: k.title,
  takenAt: k.takenAt,
})

/** The page at `url` in the headless browser, `width` wide at the widget's ratio: its title and a JPEG. */
const captureHeadless = async (url: string, width: number) => {
  const program = headlessProgram()
  if (program === null) {
    throw new Error("No browser on this Mac runs headless")
  }
  const height = Math.round(width / RATIO)
  const dir = mkdtempSync(path.join(tmpdir(), "switch-web-preview-"))
  const child = spawn(
    program,
    [...FLAGS, `--user-data-dir=${dir}`, `--window-size=${width},${height}`, "about:blank"],
    {
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      signal: AbortSignal.timeout(RUN_MS),
      killSignal: "SIGKILL",
    },
  )
  const [toBrowser, fromBrowser] = child.stdio.slice(3)
  const pending = new Map<number, PromiseWithResolvers<unknown>>()
  const loaded = Promise.withResolvers<null>()
  let gone: Error | undefined
  let next = 0
  let partial = ""
  const fail = (e: Error) => {
    gone = e
    for (const p of pending.values()) {
      p.reject(e)
    }
    pending.clear()
  }
  child.on("error", fail)
  child.on("exit", () => {
    fail(new Error("The headless browser quit"))
  })
  try {
    if (!(toBrowser instanceof Writable) || !(fromBrowser instanceof Readable)) {
      throw new TypeError("No pipe to the headless browser")
    }
    fromBrowser.setEncoding("utf-8")
    fromBrowser.on("data", (chunk: string) => {
      const parts = (partial + chunk).split("\0")
      partial = parts.pop() ?? ""
      for (const raw of parts) {
        let m: unknown = null
        try {
          m = JSON.parse(raw)
        } catch {
          continue
        }
        const id = at(m, "id")
        if (typeof id === "number") {
          const waiting = pending.get(id)
          pending.delete(id)
          const error = at(m, "error")
          if (error === undefined) {
            waiting?.resolve(at(m, "result"))
          } else {
            waiting?.reject(new Error(str(at(error, "message")) || "DevTools refused"))
          }
        } else if (at(m, "method") === "Page.loadEventFired") {
          loaded.resolve(null)
        }
      }
    })
    const send = async (method: string, params: Json, sessionId?: string) => {
      if (gone) {
        throw gone
      }
      next += 1
      const id = next
      const answer = Promise.withResolvers<unknown>()
      pending.set(id, answer)
      toBrowser.write(
        `${JSON.stringify({ id, method, params, ...(sessionId !== undefined && { sessionId }) })}\0`,
      )
      return await answer.promise
    }
    const targetId = str(at(await send("Target.createTarget", { url: "about:blank" }), "targetId"))
    const sessionId = str(
      at(await send("Target.attachToTarget", { targetId, flatten: true }), "sessionId"),
    )
    await send("Page.enable", {}, sessionId)
    await send(
      "Emulation.setDeviceMetricsOverride",
      { width, height, deviceScaleFactor: 1, mobile: false },
      sessionId,
    )
    const went = await send("Page.navigate", { url }, sessionId)
    const failed = str(at(went, "errorText"))
    if (failed) {
      throw new Error(`The page didn't open: ${failed}`)
    }
    // A page that never finishes loading (a stream, a stuck script) is pictured as it stands.
    await Promise.race([loaded.promise, Bun.sleep(LOAD_MS)])
    await Promise.race([
      send("Runtime.evaluate", { expression: SETTLE, awaitPromise: true }, sessionId),
      Bun.sleep(SETTLE_MS),
    ])
    const titled = await send(
      "Runtime.evaluate",
      { expression: "document.title", returnByValue: true },
      sessionId,
    )
    const shot = await send(
      "Page.captureScreenshot",
      { format: "jpeg", quality: 80, clip: { x: 0, y: 0, width, height, scale: 1 } },
      sessionId,
    )
    const data = str(at(shot, "data"))
    if (!data) {
      throw new Error("The headless browser took no picture")
    }
    return {
      title: str(at(at(titled, "result"), "value")),
      jpeg: new Blob([Buffer.from(data, "base64")], { type: "image/jpeg" }),
    }
  } finally {
    child.removeAllListeners("exit")
    child.kill("SIGKILL")
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * The page at `url` in the user's own browser, signed in as they are there: a background tab of its
 * own (never brought to the front), `width` wide at the widget's ratio, closed once it's pictured.
 */
const captureSignedIn = async (url: string, width: number) => {
  const height = Math.round(width / RATIO)
  const name = `preview-${crypto.randomUUID().slice(0, 8)}`
  try {
    return await withTab(name, null, async (tab) => {
      await tab.ensure()
      await tab.cdp("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      })
      // Loads it through any sign-in redirects and waits for it to settle.
      await tab.navigate(url)
      await Promise.race([
        tab.cdp("Runtime.evaluate", { expression: SETTLE, awaitPromise: true }),
        Bun.sleep(SETTLE_MS),
      ])
      const titled = await tab.cdp("Runtime.evaluate", {
        expression: "document.title",
        returnByValue: true,
      })
      const shot = await tab.cdp("Page.captureScreenshot", {
        format: "jpeg",
        quality: 80,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      })
      const data = str(shot.data)
      if (!data) {
        throw new Error("The browser took no picture")
      }
      return {
        title: str(at(titled.result, "value")),
        jpeg: new Blob([Buffer.from(data, "base64")], { type: "image/jpeg" }),
      }
    })
  } finally {
    await chrome.call("release", { session: name, keepOpen: false }, 15_000).catch(() => null)
    dropSession(name)
  }
}

const capture = async (url: string, width: number, signedIn: boolean) =>
  signedIn ? await captureSignedIn(url, width) : await captureHeadless(url, width)

/** A JPEG kept in the core's blobs: its link there. */
const keep = async (jpeg: Blob) => {
  const token = process.env.SWITCH_TOKEN
  const res = await fetch(new URL("/blobs", process.env.SWITCH_URL ?? "http://127.0.0.1:4871"), {
    method: "PUT",
    headers: {
      "Content-Type": "image/jpeg",
      ...(token !== undefined && { authorization: `Bearer ${token}` }),
    },
    body: jpeg,
    signal: AbortSignal.timeout(60_000),
  })
  const answer: unknown = await res.json().catch(() => null)
  const hash = str(at(answer, "hash"))
  if (!res.ok || !hash) {
    throw new Error(`The core kept no picture: ${str(at(answer, "error")) || res.status}`)
  }
  return `/blobs/${hash}?type=image%2Fjpeg`
}

/** Takes the page again, one picture at a time on this Mac; one already being taken is that one. */
const take = async (
  url: string,
  width: number,
  signedIn: boolean,
  every: number,
): Promise<Kept> => {
  const key = keyOf(url, width, signedIn)
  const running = taking.get(key)
  if (running) {
    return await running
  }
  const work = async () => {
    const was = kept.get(key)
    const triedAt = Date.now()
    if (was) {
      kept.set(key, { ...was, triedAt })
    }
    const { title, jpeg } = await capture(url, width, signedIn)
    const image = await keep(jpeg)
    const now = kept.get(key)
    const made: Kept = {
      image,
      url,
      title,
      takenAt: Date.now(),
      width,
      signedIn,
      every: now?.every ?? every,
      askedAt: now?.askedAt ?? triedAt,
      triedAt,
    }
    kept.set(key, made)
    save()
    said(shotOf(made))
    return made
  }
  const done = line.then(work)
  line = done.catch(() => null)
  const tracked = done.finally(() => {
    taking.delete(key)
    schedule()
  })
  taking.set(key, tracked)
  return await tracked
}

/** Takes the page again in the background: what goes wrong is said in the extension's log. */
const retake = async (url: string, width: number, signedIn: boolean, every: number) => {
  try {
    await take(url, width, signedIn, every)
  } catch (error) {
    console.error(`preview of ${url}: ${String(error)}`)
  }
}

/** Each page still asked for is taken again once its interval is up, from its last try. */
const schedule = () => {
  clearTimeout(timer)
  const now = Date.now()
  const live = [...kept.values()].filter(
    (k) => now - k.askedAt < KEPT_FOR * k.every && !taking.has(keyOf(k.url, k.width, k.signedIn)),
  )
  if (live.length === 0) {
    return
  }
  const dueAt = Math.min(...live.map((k) => Math.max(k.takenAt, k.triedAt) + k.every))
  timer = setTimeout(
    () => {
      const fired = Date.now()
      for (const k of live) {
        if (Math.max(k.takenAt, k.triedAt) + k.every <= fired) {
          void retake(k.url, k.width, k.signedIn, k.every)
        }
      }
      schedule()
    },
    Math.max(0, dueAt - now),
  )
}

/** Says each new picture to `listener`, and takes up the timers the last run left. */
export const onShot = (listener: (shot: Shot) => void) => {
  said = listener
  schedule()
}

/**
 * The page's latest picture. One older than its interval comes back as it is while a new one is
 * taken; none yet is taken now.
 */
export const preview = async (input: {
  readonly url: string
  readonly every?: string
  readonly width?: number
  readonly signed_in?: boolean
}): Promise<Shot> => {
  let page: URL
  try {
    page = new URL(input.url)
  } catch {
    throw new Error(`Not a web address: ${input.url}`)
  }
  if (page.protocol !== "https:" && page.protocol !== "http:") {
    throw new Error("Only http and https pages")
  }
  const url = page.href
  const ms = EVERY[isEvery(input.every) ? input.every : DEFAULT_EVERY]
  const width = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, input.width ?? DEFAULT_WIDTH)))
  const signedIn = input.signed_in === true
  const key = keyOf(url, width, signedIn)
  const was = kept.get(key)
  const now = Date.now()
  if (!was) {
    return shotOf(await take(url, width, signedIn, ms))
  }
  kept.set(key, { ...was, every: ms, askedAt: now })
  save()
  if (now - was.takenAt >= ms && now - was.triedAt >= ms) {
    void retake(url, width, signedIn, ms)
  }
  schedule()
  return shotOf(was)
}
