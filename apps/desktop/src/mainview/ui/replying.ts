// What a space's box replies to: words quoted from its chat, and asks, attached above what the user
// types, each with the user's own reply to it. Each comes off with ✕, and they all go with the next
// message sent there. Kept in the space's draft (outbox.ts), so a relaunch keeps them.
import type { SpaceId } from "@switch/brain"
import { Option, Schema } from "effect"
import { useSyncExternalStore } from "react"

import * as outbox from "../brain/outbox.ts"
import { Replies } from "../brain/store.ts"
import type { Reply } from "../brain/store.ts"

const NONE: readonly Reply[] = []
const held = new Map<SpaceId, readonly Reply[]>()
const listeners = new Set<() => void>()
const decode = Schema.decodeUnknownOption(Replies)

const set = (space: SpaceId, next: readonly Reply[]) => {
  held.set(space, next)
  const place = `space:${space}`
  const { replyTo: _, ...rest } = outbox.draft(place) ?? { text: "" }
  outbox.setDraft(place, next.length > 0 ? { ...rest, replyTo: next } : rest)
  for (const l of listeners) {
    l()
  }
}

const same = (a: Reply, b: Reply) =>
  a.kind === "quote" && b.kind === "quote"
    ? a.seq === b.seq && a.text === b.text
    : a.kind === "ask" && b.kind === "ask" && a.id === b.id

/** What the box in `space` replies to now. */
export const replyingTo = (space: SpaceId) => {
  const had = held.get(space)
  if (had !== undefined) {
    return had
  }
  const kept = Option.getOrNull(decode(outbox.draft(`space:${space}`)?.replyTo)) ?? NONE
  held.set(space, kept)
  return kept
}

/** Attaches one to the box, unless it's there already, and puts the cursor in its reply. */
export const attachReply = (space: SpaceId, r: Reply) => {
  const now = replyingTo(space)
  const at = now.findIndex((x) => same(x, r))
  if (at === -1) {
    set(space, [...now, r])
  }
  const which = at === -1 ? now.length : at
  requestAnimationFrame(() => {
    const fields = document.querySelectorAll<HTMLTextAreaElement>(
      `[data-chat="${space}"] [data-answer]`,
    )
    fields[which]?.focus()
  })
}

export const detachReply = (space: SpaceId, at: number) => {
  set(
    space,
    replyingTo(space).filter((_, i) => i !== at),
  )
}

/** The user's reply to one of them, as it stands. */
export const answer = (space: SpaceId, at: number, reply: string) => {
  set(
    space,
    replyingTo(space).map((r, i) => (i === at ? { ...r, reply } : r)),
  )
}

/** Something of the user's own is in a reply. */
export const answered = (replies: readonly Reply[]) =>
  replies.some((r) => (r.reply ?? "").trim() !== "")

export const clearReplies = (space: SpaceId) => {
  set(space, NONE)
}

export const useReplying = (space: SpaceId) =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => replyingTo(space),
  )
