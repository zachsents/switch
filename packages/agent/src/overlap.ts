// Steering first: a new task that's the same work as one already running in the same folder is
// refused, so the parent steers that one instead. The same: the same title, two telling words in
// both titles, or a file the new one names that the running one named or edited.
import type { Database } from "bun:sqlite"
import type { ThreadId } from "@switch/brain"

import { allThreads, items } from "./events.ts"
import type { Thread } from "./events.ts"

const PLAIN = new Set(
  "about after again also back before being both check could does done each find first from have here into just keep last like make more most much need only other over same should some such than that their them then there these they this those through what when where which while will with work would your task fix add update make".split(
    " ",
  ),
)

const words = (title: string) =>
  new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((w) => w.length >= 4 && !PLAIN.has(w)),
  )

const normal = (title: string) =>
  title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, " ")
    .trim()

const PATH = /(?:~|\.{0,2})?\/?(?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]{1,8}\b/giu

const pathsIn = (text: string) => new Set([...text.matchAll(PATH)].map((m) => m[0]))

const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])

/** What a running task has named or touched: its brief and the files it edited. */
const touched = (db: Database, t: Thread) => {
  const out = new Set<string>()
  for (const item of items(db, t.thread)) {
    if (item.kind === "user") {
      for (const p of pathsIn(item.text)) {
        out.add(p)
      }
    } else if (item.kind === "tool" && EDITS.has(item.name)) {
      const { input } = item
      const file =
        typeof input === "object" && input !== null && "file_path" in input
          ? input.file_path
          : undefined
      if (typeof file === "string") {
        out.add(file)
      }
    }
  }
  return out
}

const shares = (named: ReadonlySet<string>, held: ReadonlySet<string>) =>
  [...named].some((p) => [...held].some((h) => h === p || h.endsWith(p) || p.endsWith(h)))

/** The thread `from` and every thread above it. */
const lineage = (threads: readonly Thread[], from: ThreadId) => {
  const byId = new Map(threads.map((t) => [t.thread, t]))
  const out = new Set<ThreadId>()
  let at: ThreadId | null = from
  while (at !== null && !out.has(at)) {
    out.add(at)
    at = byId.get(at)?.parent ?? null
  }
  return out
}

/**
 * A running task in `cwd` that's the same work as `title`/`text`, if any. The delegating thread
 * and those above it are never the same work: a task handing off part of itself isn't a duplicate.
 */
export const sameWork = (
  db: Database,
  cwd: string,
  title: string,
  text: string,
  skip: ThreadId,
  from: ThreadId,
): Thread | null => {
  const mine = words(title)
  const named = pathsIn(text)
  const threads = allThreads(db)
  const own = lineage(threads, from)
  return (
    threads.find((t) => {
      if (t.parent === null || t.thread === skip || own.has(t.thread) || t.cwd !== cwd) {
        return false
      }
      if (t.status !== "running" && t.status !== "limited") {
        return false
      }
      if (normal(t.title) === normal(title)) {
        return true
      }
      const theirs = words(t.title)
      if ([...mine].filter((w) => theirs.has(w)).length >= 2) {
        return true
      }
      return named.size > 0 && shares(named, touched(db, t))
    }) ?? null
  )
}
