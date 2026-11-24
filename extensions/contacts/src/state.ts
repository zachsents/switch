// What the extension remembers between runs, beside its log: how far the brain's messages are all
// read and when they last were, how far its log has gone out, and when each address book was first
// taken in (nothing goes out to a book before that).
import { readFileSync } from "node:fs"
import path from "node:path"
import { writeFileAtomic } from "switch-ext-kit"

import { parse, rec } from "./json.ts"
import { DIR } from "./store.ts"

const STATE = path.join(DIR, "contacts-state.json")

export interface State {
  /** The brain's seq through which every message has been read. */
  brain: number
  /** When a look last found every message read, as epoch ms; 0 before the first. */
  caughtUp: number
  forwarded: number
  pushedThrough: number
  /** When each book was imported, as epoch ms. */
  imported: { apple?: number; google?: number }
}

const num = (v: unknown) => (typeof v === "number" ? v : 0)

const importedOf = (v: unknown): State["imported"] => {
  const r = rec(v)
  return {
    ...(typeof r.apple === "number" ? { apple: r.apple } : {}),
    ...(typeof r.google === "number" ? { google: r.google } : {}),
  }
}

export const load = (): State => {
  try {
    const s = rec(parse(readFileSync(STATE, "utf-8")))
    return {
      brain: num(s.brain),
      caughtUp: num(s.caughtUp),
      forwarded: num(s.forwarded),
      pushedThrough: num(s.pushedThrough),
      imported: importedOf(s.imported),
    }
  } catch {
    return { brain: 0, caughtUp: 0, forwarded: 0, pushedThrough: 0, imported: {} }
  }
}
/** Saves the state; when each book was imported only ever gains, whoever saved last. */
export const save = (s: State) => {
  const disk = load().imported
  writeFileAtomic(STATE, JSON.stringify({ ...s, imported: { ...disk, ...s.imported } }))
}

/** Marks a book imported, keeping whatever else changed on disk meanwhile. */
export const markImported = (book: "apple" | "google") => {
  const s = load()
  writeFileAtomic(STATE, JSON.stringify({ ...s, imported: { ...s.imported, [book]: Date.now() } }))
}
