// How long a window takes to open, in the desktop log: from the ask to open it, to the window seen,
// to its content drawn (the view says when).
import { appendFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const DIR = path.join(homedir(), "Library", "Logs", "switch")
// A test copy beside the live app ($SWITCH_QUIET) keeps its own.
const FILE = path.join(DIR, process.env.SWITCH_QUIET === "1" ? "desktop-test.log" : "desktop.log")

const log = (line: string) => {
  try {
    mkdirSync(DIR, { recursive: true })
    appendFileSync(FILE, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // A log that can't be written changes nothing.
  }
}

/** One open, timed from now; logged once it's both seen and its content drawn. */
export const timeOpen = (kind: string) => {
  const start = performance.now()
  const at: { shown?: number; painted?: number } = {}
  const done = () => {
    if (at.shown !== undefined && at.painted !== undefined) {
      log(`open ${kind}: shown ${at.shown}ms, painted ${at.painted}ms`)
    }
  }
  return {
    shown: () => {
      if (at.shown === undefined) {
        at.shown = Math.round(performance.now() - start)
        done()
      }
    },
    painted: () => {
      if (at.painted === undefined) {
        at.painted = Math.round(performance.now() - start)
        done()
      }
    },
  }
}
