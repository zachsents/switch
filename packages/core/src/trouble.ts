// Trouble in Switch itself goes to the agent, never into the user's chat. The user, Nov 23: "it
// should ping the agent who can leave an ask in my queue if he thinks i need to know about it. or
// better yet, he can simply ... figure it out and restore functionality and i'd never even know",
// and "the whole point of switchboard is that i wanna be messaged or shown what i'm actually needed
// for as a human being. anything else is just noise". Each cause is one surprise (Switchboard's
// surprises, core docs.md), counted while it's open; only a newly open one wakes its space.
import { openSurprises, resolveSurprise, troubledWith } from "@switch/autonomy"
import { Sessions } from "@switch/agent"
import { Brain } from "@switch/brain"
import type { SpaceId, ThreadId } from "@switch/brain"
import { Effect } from "effect"

import { threadOf } from "./context.ts"

const PUSH = "push:"

export const troubled = (t: {
  readonly id: string
  readonly space: SpaceId
  /** The work it's about, whose next turn hears it too. */
  readonly thread?: ThreadId
  readonly text: string
}) =>
  Effect.gen(function* raising() {
    const sessions = yield* Sessions
    yield* troubledWith(
      {
        id: t.id,
        space: t.space,
        thread: t.thread ?? null,
        kind: "stopped",
        text: t.text,
        count: true,
      },
      { threadOf, kick: sessions.kick },
    )
  })

/**
 * A push that reached no phone: its line (an item's title, a reply's text) and why, never the key.
 * One surprise per cause.
 */
export const pushFailed = (space: SpaceId, line: string, reason: string) => {
  const why = reason.trim() === "" ? "no reason given" : reason.trim()
  const what = line.replaceAll(/\s+/gu, " ").trim()
  return troubled({
    id: `${PUSH}${why}`,
    space,
    text: `A push didn't reach the iPhone (${why}); the last was "${what}"`,
  }).pipe(Effect.ignore({ log: "Warn", message: "A failed push couldn't be raised" }))
}

/** A push got through: what kept them from it came right. */
export const pushWorks = Effect.gen(function* resolving() {
  const brain = yield* Brain
  const open = yield* brain.read((db) => openSurprises(db).filter((s) => s.id.startsWith(PUSH)))
  for (const s of open) {
    yield* resolveSurprise(s.id)
  }
})
