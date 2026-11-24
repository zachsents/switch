// A session: one tab an agent drives, one op at a time, and what's known of it between ops.
import * as chrome from "./chrome.ts"
import { Log } from "./log.ts"

/** A session: one tab, one op at a time. */
export class Session {
  readonly log = new Log()
  /** The page script's isolated world, and the document generation it belongs to. */
  world: { id: number; generation: number } | null = null
  /** The number the next newly seen element gets, so numbers never repeat across pages. */
  next = 1
  /** What each number was, to find a re-rendered copy, or the same element on a reloaded page. */
  seen = new Map<number, string>()
  pointer: { x: number; y: number } | null = null
  group: string | null = null
  opened = false
  private gate: Promise<unknown> = Promise.resolve()

  readonly name: string

  constructor(name: string) {
    this.name = name
  }

  /** Runs `work` with the session's tab to itself. */
  async locked<A>(work: () => Promise<A>): Promise<A> {
    const before = this.gate
    const turn = Promise.withResolvers<null>()
    this.gate = turn.promise
    await before
    try {
      return await work()
    } finally {
      turn.resolve(null)
    }
  }

  /** Forgets what's kept about the tab, when the session ends or takes over another. */
  forget() {
    this.world = null
    this.next = 1
    this.seen.clear()
    this.pointer = null
    this.opened = false
    Object.assign(this.log, new Log())
  }
}

const sessions = new Map<string, Session>()

export const session = (name: string) => {
  let found = sessions.get(name)
  if (!found) {
    found = new Session(name)
    sessions.set(name, found)
  }
  return found
}

export const dropSession = (name: string) => {
  sessions.delete(name)
}

chrome.onEvent((name, method, params) => {
  session(name).log.apply(method, params)
})

/** The sessions held for the user (an approval, a code, a human check), newest last, with until when. */
const held = new Map<string, number>()

export const noteHeld = (name: string, until: number) => {
  held.delete(name)
  held.set(name, until)
}

/** The newest session still held, if any. */
export const newestHeld = () => {
  const now = Date.now()
  return [...held.entries()].findLast(([, until]) => until > now)?.[0] ?? null
}
