// What the tools share: an op's result, where the tab is now, what's at a point, and the browser
// filling a field from what it has saved.
import type { Decision, Input, Question } from "switch-ext-kit"

import * as autofill from "./autofill.ts"
import * as chrome from "./chrome.ts"
import { redactUrl } from "./guard.ts"
import { noteHeld } from "./session.ts"
import type { Tab } from "./tab.ts"

export type Decide = (
  input: Input,
  questions: Readonly<Record<string, Question>>,
) => Promise<Decision>

/** What an op leaves the agent: words, and any screenshots. */
export interface Done {
  text: string
  images: { data: string; width: number; height: number }[]
}

export const done = (text: string): Done => ({ text, images: [] })

export const str = (v: unknown) => (typeof v === "string" ? v : "")
export const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null)

/** Where the tab is now, and anything about it the agent should know. */
export const nowOn = async (tab: Tab) => {
  const { url, title } = await tab.info().catch(() => ({ url: "", title: "" }))
  let said = `Now on: ${title === "" ? "(untitled)" : title} — ${redactUrl(url)}`
  const { log } = tab
  if (log.dialog !== null) {
    said += `\nA ${str(log.dialog.type) || "JavaScript"} dialog is open: "${str(log.dialog.message)}". Answer it with op dialog.`
  }
  if (log.chooser !== null) {
    said += "\nThe page opened a file picker (held back): attach files with op upload."
  }
  if (log.moved) {
    log.moved = false
    said += "\nThe page opened a new tab, and this session moved to it."
  }
  return said
}

/** What's at a point, the way results name it: `[12] button "Save"`. */
export const whatAt = async (tab: Tab, at: { x: number; y: number }) => {
  const v = await tab.page(`at(${at.x}, ${at.y})`).catch(() => null)
  return typeof v === "string" ? v : `the point (${Math.round(at.x)}, ${Math.round(at.y)})`
}

/**
 * The browser's own suggestions for the field at a point: the tab brought to the front for a
 * moment (the browser shows them only there) and, with `pick`, one filled; then it goes back.
 */
export const browserFills = async (tab: Tab, at: { x: number; y: number }, pick: string | null) => {
  const b = chrome.browser()
  if (typeof b?.pid !== "number") {
    throw new TypeError("The Switch extension's browser didn't say which process it is")
  }
  await chrome.call("show", { session: tab.name }, 10_000)
  try {
    await tab.clickAt(at)
    await Bun.sleep(300)
    return await autofill.fill(b.pid, pick)
  } finally {
    await chrome.call("hide", { session: tab.name }, 10_000).catch(() => null)
  }
}

/** Keeps a session's tab open (no idle close) until a time, for the user: its view shows it. */
export const hold = async (session: string, until: number) => {
  await chrome.call("hold", { session, until }, 10_000)
  noteHeld(session, until)
}
