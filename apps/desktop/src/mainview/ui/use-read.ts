// A space's chat on screen, in the window the user is in, is read to its latest reply: the mark
// clears here and on every device. A hidden <Activity> drops the effect, so only the page open
// reads.
import type { SpaceId } from "@switch/brain"
import { useMutation } from "@tanstack/react-query"
import { useEffect } from "react"

import * as derive from "../brain/derive.ts"
import { readMutation } from "../brain/mutations.ts"
import { useBrain } from "../brain/use-brain.ts"

/** Calls `l` now and whenever the window comes forward, until the cleanup it answers. */
const onForward = (l: () => void) => {
  l()
  window.addEventListener("focus", l)
  document.addEventListener("visibilitychange", l)
  return () => {
    window.removeEventListener("focus", l)
    document.removeEventListener("visibilitychange", l)
  }
}

export const useRead = (space: SpaceId) => {
  const at = useBrain((s) => derive.unreadAt(s, space))
  const { mutate } = useMutation(readMutation)
  useEffect(
    () =>
      onForward(() => {
        if (at !== null && document.visibilityState === "visible" && document.hasFocus()) {
          mutate({ space, seq: at })
        }
      }),
    [at, space, mutate],
  )
}
