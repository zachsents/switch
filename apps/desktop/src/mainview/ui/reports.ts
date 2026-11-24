// What was on screen, for crash and hang reports: the page and its space, and the last steps. The
// bun process hears it on every change and every couple of seconds (a hang is when it stops), and
// keeps each report until it's in the brain as `client.crashed`.
import { useEffect, useEffectEvent } from "react"

import type { Report, Shown } from "../../shared/commands.ts"
import { emit } from "../brain/client.ts"

/** What this module tells the bun process. */
interface Bun {
  readonly shown: (s: Shown) => void
  readonly error: (e: { readonly summary: string; readonly report: string }) => void
}
let bun: Bun | undefined

const TRAIL = 30
const BEAT_MS = 2000

const trail: string[] = []
let screen = ""
let space: string | null = null

/** A step worth knowing after a crash: a page opened, a command run. */
export const step = (what: string) => {
  trail.push(`${Temporal.Now.plainTimeISO().toString({ smallestUnit: "second" })} ${what}`)
  trail.splice(0, Math.max(0, trail.length - TRAIL))
}

const tell = () => {
  bun?.shown({ space, screen, trail: [...trail], visible: document.visibilityState === "visible" })
}

/** WebKit's note that a ResizeObserver's callback resized what it observed: no fault. */
const benign = (message: string) => message.startsWith("ResizeObserver loop")

/** Into the brain, under the report's own id, so a resend is a no-op. */
export const report = async (r: Report) => {
  const { id, ...rest } = r
  await emit("client.crashed", { client: "desktop", ...rest }, id)
}

/** An error the view hit: a section that failed, or one nothing caught. */
export const failed = (error: unknown) => {
  const e = error instanceof Error ? error : new Error(String(error))
  bun?.error({ summary: e.message, report: e.stack ?? e.message })
}

/** In the app: from now on the bun process hears what's on screen and what failed. */
export const tellBun = (to: Bun) => {
  bun = to
  window.addEventListener("error", (e) => {
    if (!benign(e.message)) {
      failed(e.error ?? e.message)
    }
  })
  document.addEventListener("visibilitychange", tell)
  window.addEventListener("unhandledrejection", (e) => {
    failed(e.reason)
  })
  setInterval(tell, BEAT_MS)
}

/** Says what's on screen as it changes. */
export const useShown = (at: { readonly space: string | null; readonly screen: string }) => {
  const changed = useEffectEvent(
    (now: { readonly space: string | null; readonly screen: string }) => {
      ;({ space, screen } = now)
      step(now.screen)
      tell()
    },
  )
  useEffect(() => {
    changed({ space: at.space, screen: at.screen })
  }, [at.space, at.screen])
}
